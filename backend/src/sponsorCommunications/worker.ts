import { randomUUID } from 'crypto';
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { TABLE_SPONSOR_CRM, TABLE_USERS } from '../db/tableNames';
import { getCrmRecord } from '../db/sponsorCrm';
import { derivedStatus, normalizeEmail, payloadDeleteAt, suppressionKey, validateSendConfig } from './core';
import {
  assertSuppressionCoverage,
  getCurrentConfig,
  getPrivatePayload,
  getSponsorItem,
  reconcileAbandonedSponsorPayloads,
  sponsorItemKey,
} from './repository';
import { loadHmacKeyring } from './secrets';
import { drainPendingSponsorEventSet, reconcilePendingSponsorEvents } from './sesEvents';
import type { SponsorSendAttempt } from './types';

export type ImmutableSesBinding = {
  account: string;
  region: string;
  identityArn: string;
  from: string;
  replyTo?: string;
  configurationSet: string;
  configurationSetGeneration: string;
  configGeneration: number;
  configDigest: string;
};
export type SesSender = (
  input: SendEmailCommandInput,
  signal: AbortSignal,
  binding: Readonly<ImmutableSesBinding>,
) => Promise<{ MessageId?: string }>;
const nowIso = () => new Date().toISOString();

function cleanAttempt(item?: Record<string, unknown>): SponsorSendAttempt | null {
  if (!item) return null;
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, GSI4PK, GSI4SK, correlationToken, ...attempt } = item;
  return attempt as SponsorSendAttempt;
}

export async function leaseAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  owner = randomUUID(),
  now = new Date(),
): Promise<{ attempt: SponsorSendAttempt; owner: string } | null> {
  const current = await getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId);
  if (!current || current.recoveryBlocked || current.status !== 'queued' || current.dispatchStartedAt) return null;
  const leaseGeneration = (current.leaseGeneration || 0) + 1;
  const expires = new Date(now.getTime() + 60_000).toISOString();
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_SPONSOR_CRM,
      Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attemptId),
      UpdateExpression: 'SET #status = :executing, derivedStatus = :executing, leaseOwner = :owner, leaseGeneration = :generation, leaseExpiresAt = :expires, updatedAt = :now REMOVE GSI2PK, GSI2SK',
      ConditionExpression: '#status = :queued AND revision = :revision AND recoveryBlocked = :false AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':executing': 'executing', ':queued': 'queued', ':owner': owner, ':generation': leaseGeneration,
        ':expires': expires, ':now': now.toISOString(), ':revision': current.revision, ':false': false,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return { attempt: cleanAttempt(result.Attributes as Record<string, unknown>)!, owner };
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function failBeforeMarker(
  client: DynamoDBDocumentClient,
  attempt: SponsorSendAttempt,
  owner: string,
  reasonCode: string,
  now: string,
) {
  const ttl = payloadDeleteAt(now);
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
          UpdateExpression: 'SET #status = :failed, derivedStatus = :failed, safeReasonCode = :reason, payloadDeleteAt = if_not_exists(payloadDeleteAt, :ttl), updatedAt = :now, revision = revision + :one REMOVE leaseOwner, leaseExpiresAt',
          ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :generation AND attribute_not_exists(dispatchStartedAt)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':failed': 'failed_safe', ':reason': reasonCode, ':ttl': ttl, ':now': now, ':one': 1,
            ':executing': 'executing', ':owner': owner, ':generation': attempt.leaseGeneration,
          },
        },
      },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: sponsorItemKey('COMMUNICATION_PAYLOAD', attempt.payloadRef),
          UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': now, ':ttl': ttl },
        },
      },
    ],
  }));
}

async function writeDispatchMarker(
  client: DynamoDBDocumentClient,
  attempt: SponsorSendAttempt,
  owner: string,
): Promise<{ attempt: SponsorSendAttempt; correlationToken: string } | null> {
  const now = nowIso();
  const [payload, config, rawAttempt] = await Promise.all([
    getPrivatePayload(client, attempt.payloadRef),
    getCurrentConfig(client),
    client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attempt.id), ConsistentRead: true })),
  ]);
  if (!payload || !config) {
    await failBeforeMarker(client, attempt, owner, 'private-state-unavailable', now);
    return null;
  }
  const exactBooking = await getCrmRecord(client, 'booking', payload.payload.bookingId);
  const exactOrganization = await getCrmRecord(client, 'organization', payload.payload.organizationId);
  const exactContact = await getCrmRecord(client, 'contact', payload.payload.contactId);
  const exactSuggestion = await getSponsorItem<Record<string, unknown>>(client, 'COMMUNICATION_SUGGESTION', payload.payload.suggestionId);
  const currentAddress = exactContact && Array.isArray(exactContact.emails)
    ? exactContact.emails.map((item) => { try { return normalizeEmail(item); } catch { return ''; } })
    : [];
  if (
    process.env.SPONSOR_COMMUNICATION_SEND_ENABLED !== 'true'
    || !config.enabled
    || config.digest !== attempt.configDigest
    || config.generation !== attempt.configGeneration
    || config.sesAccount !== attempt.sesAccount
    || config.sesRegion !== attempt.sesRegion
    || config.sesIdentityArn !== attempt.sesIdentityArn
    || config.from !== attempt.from
    || config.replyTo !== attempt.replyTo
    || config.configurationSet !== attempt.configurationSet
    || config.configurationSetGeneration !== attempt.configurationSetGeneration
    || payload.payload.sesAccount !== attempt.sesAccount
    || payload.payload.sesRegion !== attempt.sesRegion
    || payload.payload.sesIdentityArn !== attempt.sesIdentityArn
    || payload.payload.from !== attempt.from
    || payload.payload.replyTo !== attempt.replyTo
    || payload.payload.configurationSet !== attempt.configurationSet
    || payload.payload.configurationSetGeneration !== attempt.configurationSetGeneration
    || payload.payload.sendConfigGeneration !== attempt.configGeneration
    || payload.payload.sendConfigDigest !== attempt.configDigest
    || !exactBooking || !exactOrganization || !exactContact || !exactSuggestion
    || exactBooking.version !== payload.payload.bookingVersion
    || exactOrganization.version !== payload.payload.organizationVersion
    || exactContact.version !== payload.payload.contactVersion
    || Number(exactSuggestion.version) !== payload.payload.suggestionVersion
    || exactBooking.organizationId !== exactOrganization.id
    || exactContact.organizationId !== exactOrganization.id
    || exactContact.active === false || exactContact.archivedAt
    || !currentAddress.includes(payload.payload.to)
  ) {
    await failBeforeMarker(client, attempt, owner, config.enabled && process.env.SPONSOR_COMMUNICATION_SEND_ENABLED === 'true' ? 'source-or-config-drift' : 'send-disabled', now);
    return null;
  }
  const { keyring } = await loadHmacKeyring();
  try {
    validateSendConfig(config, keyring);
    await assertSuppressionCoverage(client, config.hmacAcceptedVersions);
  } catch {
    await failBeforeMarker(client, attempt, owner, 'keyring-mismatch', now);
    return null;
  }
  const dispatchGeneration = (attempt.dispatchGeneration || 0) + 1;
  const suppressionChecks = config.hmacAcceptedVersions.map((version) => ({
    ConditionCheck: {
      TableName: TABLE_SPONSOR_CRM,
      Key: sponsorItemKey('EMAIL_SUPPRESSION', suppressionKey(version, payload.payload.to, keyring)),
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  }));
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_USERS,
            Key: { PK: `USER#${attempt.approverId}`, SK: `USER#${attempt.approverId}` },
            ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('BOOKING', payload.payload.bookingId),
            ConditionExpression: '#version = :version AND organizationId = :organization AND #status <> :cancelled AND #status <> :complete',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: { ':version': payload.payload.bookingVersion, ':organization': payload.payload.organizationId, ':cancelled': 'cancelled', ':complete': 'complete' },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('ORGANIZATION', payload.payload.organizationId),
            ConditionExpression: '#version = :version AND attribute_not_exists(archivedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': payload.payload.organizationVersion },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('CONTACT', payload.payload.contactId),
            ConditionExpression: '#version = :version AND organizationId = :organization AND active = :true AND attribute_not_exists(archivedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': payload.payload.contactVersion, ':organization': payload.payload.organizationId, ':true': true },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('COMMUNICATION_SUGGESTION', payload.payload.suggestionId),
            ConditionExpression: '#version = :version AND eligible = :true AND #status = :open',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: { ':version': payload.payload.suggestionVersion, ':true': true, ':open': 'open' },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('SPONSOR_SEND_CONFIG', 'CURRENT'),
            ConditionExpression: 'enabled = :true AND generation = :generation AND digest = :digest',
            ExpressionAttributeValues: { ':true': true, ':generation': config.generation, ':digest': config.digest },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('COMMUNICATION_PAYLOAD', attempt.payloadRef),
            ConditionExpression: 'communicationId = :communication AND #version = :version AND payloadHash = :payloadHash',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':communication': attempt.communicationId,
              ':version': attempt.draftVersion,
              ':payloadHash': attempt.payloadHash,
            },
          },
        },
        ...suppressionChecks,
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
            UpdateExpression: 'SET dispatchStartedAt = :now, dispatchGeneration = :dispatch, updatedAt = :now, revision = revision + :one',
            ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :lease AND leaseExpiresAt > :now AND attribute_not_exists(dispatchStartedAt) AND recoveryBlocked = :false AND payloadHash = :payloadHash AND configDigest = :configDigest',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':now': now, ':dispatch': dispatchGeneration, ':one': 1, ':executing': 'executing',
              ':owner': owner, ':lease': attempt.leaseGeneration, ':false': false,
              ':payloadHash': attempt.payloadHash, ':configDigest': attempt.configDigest,
            },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...sponsorItemKey('SPONSOR_COMM_AUDIT', `dispatch#${attempt.id}#${dispatchGeneration}`),
              recordType: 'sponsor-communication-audit',
              action: 'dispatch-started',
              communicationId: attempt.communicationId,
              attemptId: attempt.id,
              dispatchGeneration,
              actorId: attempt.approverId,
              roleSnapshot: 'admin',
              at: now,
              ttl: attempt.ttl,
              GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
              GSI1SK: `AUDIT#${now}#dispatch`,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
  } catch (error) {
    if ((error as Error).name.includes('Transaction') || (error as Error).name.includes('Conditional')) {
      await failBeforeMarker(client, attempt, owner, 'dispatch-precondition-failed', now).catch(() => undefined);
      return null;
    }
    throw error;
  }
  const raw = rawAttempt.Item as Record<string, unknown> | undefined;
  const correlationToken = typeof raw?.correlationToken === 'string' ? raw.correlationToken : '';
  if (!correlationToken) throw new Error('Missing opaque correlation reference');
  return { attempt: { ...attempt, dispatchStartedAt: now, dispatchGeneration, revision: attempt.revision + 1 }, correlationToken };
}

function classifySesFailure(error: unknown): { status: 'failed_safe' | 'outcome_unknown'; reasonCode: string } {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = candidate.$metadata?.httpStatusCode;
  if (
    status && status >= 400 && status < 500 && status !== 408 && status !== 429
    && ['MessageRejected', 'MailFromDomainNotVerifiedException', 'NotFoundException', 'BadRequestException'].includes(candidate.name || '')
  ) return { status: 'failed_safe', reasonCode: 'ses-definitive-rejection' };
  return { status: 'outcome_unknown', reasonCode: 'ses-ambiguous-outcome' };
}

async function finalize(
  client: DynamoDBDocumentClient,
  attempt: SponsorSendAttempt,
  owner: string,
  result: { status: 'accepted' | 'failed_safe' | 'outcome_unknown'; reasonCode?: string; messageId?: string },
) {
  const now = nowIso();
  const values: Record<string, unknown> = {
    ':status': result.status, ':derived': derivedStatus(attempt.providerFacts || {}, result.status),
    ':now': now, ':one': 1, ':executing': 'executing', ':owner': owner,
    ':lease': attempt.leaseGeneration, ':dispatch': attempt.dispatchGeneration, ':ttl': payloadDeleteAt(now),
  };
  let update = 'SET #status = :status, derivedStatus = :derived, updatedAt = :now, revision = revision + :one, payloadDeleteAt = if_not_exists(payloadDeleteAt, :ttl)';
  if (result.reasonCode) { update += ', safeReasonCode = :reason'; values[':reason'] = result.reasonCode; }
  if (result.messageId) { update += ', providerMessageId = :messageId, GSI3PK = :messageKey, GSI3SK = :attemptId'; values[':messageId'] = result.messageId; values[':messageKey'] = `MESSAGE#${result.messageId}`; values[':attemptId'] = attempt.id; }
  update += ' REMOVE leaseOwner, leaseExpiresAt, correlationToken';
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
            UpdateExpression: update,
            ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :lease AND dispatchGeneration = :dispatch',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: values,
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: sponsorItemKey('COMMUNICATION_PAYLOAD', attempt.payloadRef),
            UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':now': now, ':ttl': values[':ttl'] },
          },
        },
      ],
    }));
  } catch (error) {
    if (!(error as Error).name.includes('Transaction') && !(error as Error).name.includes('Conditional')) throw error;
    const current = await getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attempt.id);
    if (!current || !['accepted', 'provider_observed', 'failed_safe', 'outcome_unknown', 'resolved'].includes(current.status)) throw error;
    // A trusted SES event or admin reconciliation won the race. Its immutable
    // fact is authoritative; the late SDK response must never overwrite it.
    if (current.providerMessageId) await drainPendingSponsorEventSet(client, attempt.id);
  }
}

export async function executeAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  sender?: SesSender,
): Promise<'skipped' | 'accepted' | 'failed_safe' | 'outcome_unknown'> {
  const leased = await leaseAttempt(client, attemptId);
  if (!leased) {
    const existing = await getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId);
    if (existing?.status === 'executing' && existing.dispatchStartedAt) {
      const now = nowIso();
      const ttl = payloadDeleteAt(now);
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: sponsorItemKey('SPONSOR_SEND_ATTEMPT', attemptId),
              UpdateExpression: 'SET #status = :unknown, derivedStatus = :unknown, safeReasonCode = :reason, payloadDeleteAt = if_not_exists(payloadDeleteAt, :ttl), recoveryBlocked = :true, updatedAt = :now, revision = revision + :one REMOVE leaseOwner, leaseExpiresAt, correlationToken',
              ConditionExpression: '#status = :executing AND attribute_exists(dispatchStartedAt)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':unknown': 'outcome_unknown', ':reason': 'worker-recovered-after-dispatch-marker', ':ttl': ttl, ':now': now },
            },
          },
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: sponsorItemKey('COMMUNICATION_PAYLOAD', existing.payloadRef),
              UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':now': now, ':ttl': ttl },
            },
          },
        ],
      })).catch(() => undefined);
      return 'outcome_unknown';
    }
    return 'skipped';
  }
  const marked = await writeDispatchMarker(client, leased.attempt, leased.owner);
  if (!marked) return 'failed_safe';
  const payload = await getPrivatePayload(client, marked.attempt.payloadRef);
  if (
    !payload
    || payload.payload.sesAccount !== marked.attempt.sesAccount
    || payload.payload.sesRegion !== marked.attempt.sesRegion
    || payload.payload.sesIdentityArn !== marked.attempt.sesIdentityArn
    || payload.payload.from !== marked.attempt.from
    || payload.payload.replyTo !== marked.attempt.replyTo
    || payload.payload.configurationSet !== marked.attempt.configurationSet
    || payload.payload.configurationSetGeneration !== marked.attempt.configurationSetGeneration
    || payload.payload.sendConfigGeneration !== marked.attempt.configGeneration
    || payload.payload.sendConfigDigest !== marked.attempt.configDigest
  ) {
    await finalize(client, marked.attempt, leased.owner, { status: 'outcome_unknown', reasonCode: 'private-state-lost-after-marker' });
    return 'outcome_unknown';
  }
  const binding: ImmutableSesBinding = Object.freeze({
    account: marked.attempt.sesAccount,
    region: marked.attempt.sesRegion,
    identityArn: marked.attempt.sesIdentityArn,
    from: marked.attempt.from,
    ...(marked.attempt.replyTo ? { replyTo: marked.attempt.replyTo } : {}),
    configurationSet: marked.attempt.configurationSet,
    configurationSetGeneration: marked.attempt.configurationSetGeneration,
    configGeneration: marked.attempt.configGeneration,
    configDigest: marked.attempt.configDigest,
  });
  const input: SendEmailCommandInput = {
    FromEmailAddress: binding.from,
    FromEmailAddressIdentityArn: binding.identityArn,
    Destination: { ToAddresses: [payload.payload.to] },
    ...(binding.replyTo ? { ReplyToAddresses: [binding.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Charset: 'UTF-8', Data: payload.payload.subject },
        Body: { Text: { Charset: 'UTF-8', Data: payload.payload.body } },
      },
    },
    ConfigurationSetName: binding.configurationSet,
    EmailTags: [
      { Name: 'attempt', Value: marked.correlationToken },
      { Name: 'communication', Value: payload.payload.communicationId },
      { Name: 'config-generation', Value: String(binding.configGeneration) },
      { Name: 'configuration-set-generation', Value: binding.configurationSetGeneration },
    ],
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Number(process.env.SPONSOR_SEND_TIMEOUT_MS || 8_000));
  try {
    const actualSender = sender || (async (request, signal, immutableBinding) => {
      const ses = new SESv2Client({ region: immutableBinding.region, maxAttempts: 1 });
      return ses.send(new SendEmailCommand(request), { abortSignal: signal });
    });
    const result = await actualSender(input, abort.signal, binding);
    if (!result.MessageId || result.MessageId.length > 256) {
      await finalize(client, marked.attempt, leased.owner, { status: 'outcome_unknown', reasonCode: 'ses-malformed-success' });
      return 'outcome_unknown';
    }
    await finalize(client, marked.attempt, leased.owner, { status: 'accepted', messageId: result.MessageId });
    return 'accepted';
  } catch (error) {
    const classification = classifySesFailure(error);
    await finalize(client, marked.attempt, leased.owner, classification);
    return classification.status;
  } finally {
    clearTimeout(timer);
  }
}

export async function processDueSponsorSends(client: DynamoDBDocumentClient, limit = 10): Promise<{ processed: number }> {
  await Promise.all([
    reconcilePendingSponsorEvents(client, limit),
    reconcileAbandonedSponsorPayloads(client, nowIso(), limit),
  ]);
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    IndexName: 'GSI-SponsorSendDue',
    KeyConditionExpression: 'GSI2PK = :due AND GSI2SK <= :now',
    ExpressionAttributeValues: { ':due': 'SPONSOR_SEND_DUE', ':now': `${nowIso()}#\uffff` },
    Limit: Math.min(Math.max(limit, 1), 25),
  }));
  let processed = 0;
  for (const item of result.Items || []) {
    const attempt = cleanAttempt(item as Record<string, unknown>);
    if (attempt) { await executeAttempt(client, attempt.id); processed++; }
  }
  return { processed };
}

export async function sponsorSendWorkerHandler(event: { Records?: Array<{ dynamodb?: { NewImage?: Record<string, unknown> } }> }) {
  const client = await getClient();
  const ids = new Set<string>();
  for (const record of event.Records || []) {
    const raw = record.dynamodb?.NewImage as Record<string, { S?: string }> | undefined;
    const id = raw?.id?.S;
    if (id) ids.add(id);
  }
  if (!ids.size) return processDueSponsorSends(client);
  for (const id of ids) await executeAttempt(client, id);
  return { processed: ids.size };
}
