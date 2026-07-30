import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { TABLE_SPONSOR_CRM } from '../db/setup';
import {
  derivedStatus,
  mergeProviderFact,
  normalizeEmail,
  SES_EVENT_TYPES,
  sha256,
  suppressionKey,
} from './core';
import { getCurrentConfig, getPrivatePayload, getSponsorItem, sponsorItemKey } from './repository';
import { loadHmacKeyring } from './secrets';
import type { SanitizedSesEvent, SponsorSendAttempt } from './types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const exactKeys = new Set([
  'schemaVersion', 'eventId', 'eventTime', 'eventType', 'messageId', 'awsAccount', 'awsRegion',
  'configurationSet', 'configurationSetGeneration', 'attemptCorrelation', 'communicationId', 'configGeneration',
]);

class RetryableSanitizedSesEventError extends Error {
  constructor() {
    super('Retryable sanitized SES event state conflict');
    this.name = 'RetryableSanitizedSesEventError';
  }
}

export function validateSanitizedSesEvent(value: unknown): SanitizedSesEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid event envelope');
  const event = value as Record<string, unknown>;
  if (Object.keys(event).length !== exactKeys.size || Object.keys(event).some((key) => !exactKeys.has(key))) {
    throw new Error('Event envelope contains undeclared fields');
  }
  const normalizedTypes: Record<string, SanitizedSesEvent['eventType']> = {
    SEND: 'SEND', Send: 'SEND', 'Email Sent': 'SEND',
    DELIVERY: 'DELIVERY', Delivery: 'DELIVERY', 'Email Delivered': 'DELIVERY',
    DELIVERY_DELAY: 'DELIVERY_DELAY', DeliveryDelay: 'DELIVERY_DELAY', 'Email Delivery Delayed': 'DELIVERY_DELAY',
    REJECT: 'REJECT', Reject: 'REJECT', 'Email Rejected': 'REJECT',
    RENDERING_FAILURE: 'RENDERING_FAILURE', RenderingFailure: 'RENDERING_FAILURE', 'Rendering Failure': 'RENDERING_FAILURE', 'Email Rendering Failed': 'RENDERING_FAILURE',
    BOUNCE: 'BOUNCE', Bounce: 'BOUNCE', 'Email Bounced': 'BOUNCE',
    COMPLAINT: 'COMPLAINT', Complaint: 'COMPLAINT', 'Email Complaint Received': 'COMPLAINT',
  };
  const normalizedType = typeof event.eventType === 'string' ? normalizedTypes[event.eventType] : undefined;
  if (
    event.schemaVersion !== '1'
    || !normalizedType
    || typeof event.eventTime !== 'string' || !Number.isFinite(Date.parse(event.eventTime))
    || typeof event.attemptCorrelation !== 'string' || event.attemptCorrelation.length < 32 || event.attemptCorrelation.length > 256
    || ['eventId', 'messageId', 'awsAccount', 'awsRegion', 'configurationSet', 'configurationSetGeneration', 'communicationId', 'configGeneration']
      .some((key) => typeof event[key] !== 'string' || !ID.test(String(event[key])))
  ) throw new Error('Invalid event envelope');
  return { ...event, eventType: normalizedType } as SanitizedSesEvent;
}

async function attemptForCorrelation(client: DynamoDBDocumentClient, correlation: string): Promise<SponsorSendAttempt | null> {
  const digest = sha256(correlation);
  const link = await getSponsorItem<Record<string, unknown>>(client, 'SPONSOR_SEND_CORRELATION', digest);
  if (!link || link.correlationHash !== digest || typeof link.attemptId !== 'string') return null;
  const attemptId = link.attemptId;
  return getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId);
}

export async function ingestSanitizedSesEvent(
  client: DynamoDBDocumentClient,
  value: unknown,
  retry = 0,
): Promise<{ accepted: boolean; reasonCode: string }> {
  const event = validateSanitizedSesEvent(value);
  const attempt = await attemptForCorrelation(client, event.attemptCorrelation);
  if (
    !attempt
    || event.communicationId !== attempt.communicationId
    || event.configGeneration !== String(attempt.configGeneration)
    || event.awsAccount !== attempt.sesAccount
    || event.awsRegion !== attempt.sesRegion
    || event.configurationSet !== attempt.configurationSet
    || event.configurationSetGeneration !== attempt.configurationSetGeneration
  ) return { accepted: false, reasonCode: 'untrusted-correlation' };
  if (attempt.providerMessageId && attempt.providerMessageId !== event.messageId) return { accepted: false, reasonCode: 'message-mismatch' };
  const eventMarker = await getSponsorItem<Record<string, unknown>>(client, 'SPONSOR_SEND_EVENT', event.eventId);
  if (eventMarker) return { accepted: true, reasonCode: 'duplicate' };
  const now = new Date().toISOString();
  const retentionTtl = Math.floor(Date.parse(now) / 1000) + 30 * 24 * 60 * 60;
  const facts = mergeProviderFact(attempt.providerFacts || {}, event.eventType, event.eventId, event.eventTime);
  const status = ['executing', 'outcome_unknown'].includes(attempt.status) ? 'provider_observed' : attempt.status;
  const transaction: Parameters<DynamoDBDocumentClient['send']>[0] extends never ? never[] : any[] = [
    {
      Put: {
        TableName: TABLE_SPONSOR_CRM,
        Item: {
          ...sponsorItemKey('SPONSOR_SEND_EVENT', event.eventId),
          id: event.eventId,
          recordType: 'sponsor-send-event-fact',
          attemptId: attempt.id,
          communicationId: attempt.communicationId,
          bookingId: attempt.bookingId,
          eventType: event.eventType,
          eventTime: event.eventTime,
          messageId: event.messageId,
          configurationSetGeneration: event.configurationSetGeneration,
          createdAt: now,
          ttl: attempt.ttl,
          GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
          GSI1SK: `EVENT#${event.eventTime}#${event.eventId}`,
          GSI4PK: `BOOKING_COMMUNICATION#${attempt.bookingId}`,
          GSI4SK: `EVENT#${event.eventTime}#${event.eventId}`,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: TABLE_SPONSOR_CRM,
        Item: {
          ...sponsorItemKey('PENDING_SPONSOR_SEND_EVENTS', attempt.id),
          id: attempt.id,
          recordType: 'pending-sponsor-send-event-set',
          attemptId: attempt.id,
          candidateMessageId: event.messageId,
          facts,
          revision: Number(attempt.revision) + 1,
          updatedAt: now,
          ttl: attempt.ttl,
          GSI2PK: 'SPONSOR_EVENT_PENDING',
          GSI2SK: `${now}#${attempt.id}`,
        },
      },
    },
    {
      Put: {
        TableName: TABLE_SPONSOR_CRM,
        Item: {
          ...sponsorItemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
          ...attempt,
          status,
          derivedStatus: derivedStatus(facts, status),
          providerMessageId: attempt.providerMessageId || event.messageId,
          providerFacts: facts,
          recoveryBlocked: true,
          payloadDeleteAt: attempt.payloadDeleteAt || retentionTtl,
          revision: attempt.revision + 1,
          updatedAt: now,
          GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
          GSI1SK: `ATTEMPT#${attempt.createdAt}#${attempt.id}`,
          GSI3PK: `MESSAGE#${attempt.providerMessageId || event.messageId}`,
          GSI3SK: attempt.id,
          GSI4PK: `BOOKING_COMMUNICATION#${attempt.bookingId}`,
          GSI4SK: `ATTEMPT#${attempt.createdAt}#${attempt.id}`,
        },
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': attempt.revision },
      },
    },
    {
      Update: {
        TableName: TABLE_SPONSOR_CRM,
        Key: sponsorItemKey('COMMUNICATION_PAYLOAD', attempt.payloadRef),
        UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': now, ':ttl': retentionTtl },
      },
    },
  ];
  if (event.eventType === 'BOUNCE' || event.eventType === 'COMPLAINT') {
    const config = await getCurrentConfig(client);
    if (!config) return { accepted: false, reasonCode: 'suppression-config-unavailable' };
    const payload = await getPrivatePayload(client, attempt.payloadRef);
    if (!payload) return { accepted: false, reasonCode: 'private-source-expired' };
    const address = normalizeEmail(payload.payload.to);
    const { keyring } = await loadHmacKeyring();
    const id = suppressionKey(config.hmacActiveVersion, address, keyring);
    const existing = await getSponsorItem<Record<string, unknown>>(client, 'EMAIL_SUPPRESSION', id);
    if (!existing) {
      transaction.push({
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...sponsorItemKey('EMAIL_SUPPRESSION', id),
            id,
            recordType: 'email-suppression',
            keyVersion: config.hmacActiveVersion,
            contactId: payload.payload.contactId,
            organizationId: payload.payload.organizationId,
            category: event.eventType === 'BOUNCE' ? 'bounce' : 'complaint',
            status: 'active',
            safeReason: `provider-${event.eventType.toLowerCase()}`,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            GSI1PK: `SUPPRESSION_VERSION#${config.hmacActiveVersion}`,
            GSI1SK: id,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
      transaction.push({
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: sponsorItemKey('SUPPRESSION_VERSION_COUNT', config.hmacActiveVersion),
          UpdateExpression: 'ADD liveCount :one SET keyVersion = :version, recordType = :recordType, updatedAt = :now',
          ExpressionAttributeValues: { ':one': 1, ':version': config.hmacActiveVersion, ':recordType': 'suppression-version-count', ':now': now },
        },
      });
      transaction.push({
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: sponsorItemKey('SUPPRESSION_COVERAGE', 'CURRENT'),
          UpdateExpression: 'ADD liveVersions :versions SET recordType = :recordType, updatedAt = :now',
          ExpressionAttributeValues: { ':versions': new Set([config.hmacActiveVersion]), ':recordType': 'suppression-coverage', ':now': now },
        },
      });
      transaction.push({
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...sponsorItemKey('SPONSOR_COMM_AUDIT', `provider-suppression#${event.eventId}`),
            recordType: 'sponsor-communication-audit',
            action: 'provider-suppression-added',
            communicationId: attempt.communicationId,
            attemptId: attempt.id,
            suppressionId: id,
            category: event.eventType,
            at: now,
            ttl: attempt.ttl,
            GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
            GSI1SK: `AUDIT#${now}#provider-suppression`,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    }
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: transaction }));
    return { accepted: true, reasonCode: 'fact-recorded' };
  } catch (error) {
    if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) {
      const duplicate = await getSponsorItem<Record<string, unknown>>(client, 'SPONSOR_SEND_EVENT', event.eventId);
      if (duplicate) return { accepted: true, reasonCode: 'duplicate' };
      if (retry < 7) return ingestSanitizedSesEvent(client, value, retry + 1);
      throw new RetryableSanitizedSesEventError();
    }
    throw error;
  }
}

export async function drainPendingSponsorEventSet(
  client: DynamoDBDocumentClient,
  attemptId: string,
): Promise<boolean> {
  const [pending, attempt] = await Promise.all([
    getSponsorItem<Record<string, unknown>>(client, 'PENDING_SPONSOR_SEND_EVENTS', attemptId),
    getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId),
  ]);
  if (
    !pending || !attempt
    || pending.candidateMessageId !== attempt.providerMessageId
    || typeof pending.revision !== 'number'
  ) return false;
  const now = new Date().toISOString();
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('PENDING_SPONSOR_SEND_EVENTS', attemptId),
            ConditionExpression: 'revision = :revision AND candidateMessageId = :messageId',
            ExpressionAttributeValues: { ':revision': pending.revision, ':messageId': attempt.providerMessageId },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attemptId),
            ConditionExpression: 'revision = :revision AND providerMessageId = :messageId AND recoveryBlocked = :true',
            ExpressionAttributeValues: { ':revision': attempt.revision, ':messageId': attempt.providerMessageId, ':true': true },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...sponsorItemKey('SPONSOR_COMM_AUDIT', `event-drain#${attemptId}#${pending.revision}`),
              recordType: 'sponsor-communication-audit',
              action: 'event-facts-reconciled',
              communicationId: attempt.communicationId,
              attemptId,
              pendingRevision: pending.revision,
              at: now,
              ttl: attempt.ttl,
              GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
              GSI1SK: `AUDIT#${now}#event-drain`,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
    return true;
  } catch (error) {
    if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) return false;
    throw error;
  }
}

export async function reconcilePendingSponsorEvents(
  client: DynamoDBDocumentClient,
  limit = 10,
): Promise<number> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    IndexName: 'GSI-SponsorSendDue',
    KeyConditionExpression: 'GSI2PK = :pending',
    ExpressionAttributeValues: { ':pending': 'SPONSOR_EVENT_PENDING' },
    Limit: Math.min(Math.max(limit, 1), 25),
  }));
  let drained = 0;
  for (const item of result.Items || []) {
    const attemptId = typeof item.attemptId === 'string' ? item.attemptId : '';
    if (attemptId && await drainPendingSponsorEventSet(client, attemptId)) drained++;
  }
  return drained;
}

export async function sponsorSesEventHandler(event: unknown) {
  const client = await getClient();
  try {
    return await ingestSanitizedSesEvent(client, event);
  } catch (error) {
    if ((error as Error).name === 'RetryableSanitizedSesEventError') throw error;
    // Never log raw input: EventBridge should already have removed private fields.
    return { accepted: false, reasonCode: 'invalid-sanitized-envelope' };
  }
}
