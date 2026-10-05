import { randomUUID } from 'crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { payloadDeleteAt, suppressionKey, type HmacKeyring, type SendConfig } from './core';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
  CommunicationSuggestion,
} from './types';

export const itemKey = (kind: string, id: string) => ({ PK: `${kind}#${id}`, SK: `${kind}#${id}` });
export const clean = <T>(item?: Record<string, unknown>): T | null => {
  if (!item) return null;
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, GSI4PK, GSI4SK, ...value } = item;
  return value as T;
};
export const nowIso = () => new Date().toISOString();

export async function getSponsorItem<T>(client: DynamoDBDocumentClient, kind: string, id: string): Promise<T | null> {
  return clean<T>((await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: itemKey(kind, id), ConsistentRead: true }))).Item as Record<string, unknown>);
}

export async function putSuggestion(client: DynamoDBDocumentClient, suggestion: CommunicationSuggestion): Promise<CommunicationSuggestion> {
  const stored = {
    ...itemKey('COMMUNICATION_SUGGESTION', suggestion.id),
    ...suggestion,
    GSI1PK: `BOOKING_COMMUNICATION#${suggestion.bookingId}`,
    GSI1SK: `SUGGESTION#${suggestion.createdAt}#${suggestion.id}`,
    GSI4PK: `BOOKING_COMMUNICATION#${suggestion.bookingId}`,
    GSI4SK: `SUGGESTION#${suggestion.createdAt}#${suggestion.id}`,
  };
  try {
    await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: stored, ConditionExpression: 'attribute_not_exists(PK)' }));
    return suggestion;
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    return (await getSponsorItem<CommunicationSuggestion>(client, 'COMMUNICATION_SUGGESTION', suggestion.id))!;
  }
}

export async function listBookingCommunications(
  client: DynamoDBDocumentClient,
  bookingId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit || 50, 1), 100);
  const bookingPartition = `BOOKING_COMMUNICATION#${bookingId}`;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (options.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (
        typeof decoded.PK !== 'string'
        || typeof decoded.SK !== 'string'
        || decoded.GSI4PK !== bookingPartition
        || typeof decoded.GSI4SK !== 'string'
      ) throw new Error();
      exclusiveStartKey = decoded;
    } catch {
      throw new Error('Invalid communication history cursor');
    }
  }
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    IndexName: 'GSI-SponsorBookingCommunication',
    KeyConditionExpression: 'GSI4PK = :pk',
    ExpressionAttributeValues: { ':pk': bookingPartition },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
  }));
  const safeFields: Record<string, readonly string[]> = {
    'communication-suggestion': ['id', 'recordType', 'communicationType', 'status', 'safeReason', 'eligible', 'version', 'createdAt', 'updatedAt'],
    'communication-draft-version': ['id', 'recordType', 'communicationId', 'bookingId', 'version', 'suggestionId', 'createdAt', 'abandonedAt'],
    'communication-presentation': ['id', 'recordType', 'communicationId', 'bookingId', 'draftVersion', 'state', 'expiresAt', 'createdAt'],
    'sponsor-send-attempt': ['id', 'recordType', 'communicationId', 'bookingId', 'draftVersion', 'status', 'derivedStatus', 'safeReasonCode', 'createdAt', 'updatedAt'],
    'sponsor-send-event-fact': ['recordType', 'communicationId', 'bookingId', 'attemptId', 'eventType', 'eventTime', 'createdAt'],
  };
  const items = (result.Items || []).flatMap((raw) => {
    const fields = safeFields[String(raw.recordType)];
    if (!fields) return [];
    const safe = Object.fromEntries(fields.flatMap((field) => raw[field] === undefined ? [] : [[field, raw[field]]]));
    if (raw.recordType === 'communication-draft-version') {
      safe.reviewState = raw.claimedAttemptId
        ? 'claimed'
        : raw.abandonedAt
          ? 'abandoned'
          : 'awaiting_review';
      safe.reviewable = !raw.claimedAttemptId && !raw.abandonedAt;
    }
    return [safe];
  });
  return {
    items,
    nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null,
  };
}

export async function nextDraftVersion(client: DynamoDBDocumentClient, communicationId: string): Promise<number> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    IndexName: 'GSI-Communication',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `COMMUNICATION#${communicationId}`, ':prefix': 'DRAFT#' },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return Number(result.Items?.[0]?.version || 0) + 1;
}

export async function storeDraft(
  client: DynamoDBDocumentClient,
  draft: CommunicationDraftVersion,
  payload: CommunicationPrivatePayload,
): Promise<void> {
  const [presentations, previousDraftResult] = await Promise.all([
    listPresentations(client, draft.communicationId),
    client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      IndexName: 'GSI-Communication',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `COMMUNICATION#${draft.communicationId}`, ':prefix': 'DRAFT#' },
      ScanIndexForward: false,
      Limit: 1,
    })),
  ]);
  const active = presentations.filter((item) => item.state === 'active').slice(0, 8);
  const previousDraft = clean<CommunicationDraftVersion>(previousDraftResult.Items?.[0] as Record<string, unknown> | undefined);
  const abandonmentAt = new Date(Date.parse(draft.createdAt) + 24 * 60 * 60_000).toISOString();
  await client.send(new TransactWriteCommand({
    TransactItems: [
      ...active.map((item) => ({
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_PRESENTATION', item.id),
          UpdateExpression: 'SET #state = :revoked, supersededAt = :now, revision = revision + :one REMOVE tokenHash, GSI2PK, GSI2SK',
          ConditionExpression: '#state = :active AND revision = :revision',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':now': draft.createdAt, ':one': 1, ':revision': item.revision },
        },
      })),
      ...(previousDraft ? [{
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_PAYLOAD', previousDraft.payloadRef),
          UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :anchor), #ttl = if_not_exists(#ttl, :ttl)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':anchor': draft.createdAt, ':ttl': payloadDeleteAt(draft.createdAt) },
        },
      }] : []),
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('COMMUNICATION_DRAFT', `${draft.communicationId}#${draft.version}`),
            ...draft,
            GSI1PK: `COMMUNICATION#${draft.communicationId}`,
            GSI1SK: `DRAFT#${String(draft.version).padStart(10, '0')}`,
            GSI2PK: 'SPONSOR_DRAFT_ABANDONMENT',
            GSI2SK: `${abandonmentAt}#${draft.id}`,
            GSI4PK: `BOOKING_COMMUNICATION#${draft.bookingId}`,
            GSI4SK: `DRAFT#${draft.createdAt}#${draft.id}`,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: { ...itemKey('COMMUNICATION_PAYLOAD', payload.id), ...payload },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
    ClientRequestToken: randomUUID(),
  }));
}

export async function getDraft(client: DynamoDBDocumentClient, communicationId: string, version: number) {
  return getSponsorItem<CommunicationDraftVersion>(client, 'COMMUNICATION_DRAFT', `${communicationId}#${version}`);
}
export async function getPrivatePayload(client: DynamoDBDocumentClient, id: string) {
  return getSponsorItem<CommunicationPrivatePayload>(client, 'COMMUNICATION_PAYLOAD', id);
}

export async function listPresentations(client: DynamoDBDocumentClient, communicationId: string): Promise<CommunicationPresentation[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_SPONSOR_CRM,
    IndexName: 'GSI-Communication',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `COMMUNICATION#${communicationId}`, ':prefix': 'PRESENTATION#' },
  }));
  return (result.Items || []).map((item) => clean<CommunicationPresentation>(item as Record<string, unknown>)!);
}

export type PresentationGuard = {
  config: SendConfig;
  keyring: HmacKeyring;
  payload: CommunicationPrivatePayload;
  verifiedStoredRecipient: string;
};

export async function storePresentation(
  client: DynamoDBDocumentClient,
  presentation: CommunicationPresentation,
  guard: PresentationGuard,
): Promise<void> {
  const active = (await listPresentations(client, presentation.communicationId)).filter((item) => item.state === 'active');
  if (active.length > 8) throw new Error('Too many active review presentations');
  const source = guard.payload.payload;
  const suppressionChecks = guard.config.hmacAcceptedVersions.map((version) => ({
    ConditionCheck: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('EMAIL_SUPPRESSION', suppressionKey(version, source.to, guard.keyring)),
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  }));
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('SPONSOR_SEND_CONFIG', 'CURRENT'),
          ConditionExpression: 'enabled = :true AND generation = :generation AND digest = :digest',
          ExpressionAttributeValues: { ':true': true, ':generation': guard.config.generation, ':digest': guard.config.digest },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_PAYLOAD', guard.payload.id),
          ConditionExpression: 'communicationId = :communication AND #version = :version AND payloadHash = :payloadHash',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':communication': presentation.communicationId,
            ':version': presentation.draftVersion,
            ':payloadHash': presentation.payloadHash,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('BOOKING', source.bookingId),
          ConditionExpression: '#version = :version AND organizationId = :organization AND #status <> :cancelled AND #status <> :complete',
          ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
          ExpressionAttributeValues: {
            ':version': source.bookingVersion,
            ':organization': source.organizationId,
            ':cancelled': 'cancelled',
            ':complete': 'complete',
          },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('ORGANIZATION', source.organizationId),
          ConditionExpression: '#version = :version AND attribute_not_exists(archivedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': source.organizationVersion },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('CONTACT', source.contactId),
          ConditionExpression: '#version = :version AND organizationId = :organization AND active = :true AND contains(emails, :recipient) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':version': source.contactVersion,
            ':organization': source.organizationId,
            ':recipient': guard.verifiedStoredRecipient,
            ':true': true,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_SUGGESTION', source.suggestionId),
          ConditionExpression: '#version = :version AND eligible = :true AND #status = :open',
          ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
          ExpressionAttributeValues: { ':version': source.suggestionVersion, ':true': true, ':open': 'open' },
        },
      },
      {
        ConditionCheck: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_DRAFT', `${presentation.communicationId}#${presentation.draftVersion + 1}`),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      ...suppressionChecks,
      ...active.map((item) => ({
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_PRESENTATION', item.id),
          UpdateExpression: 'SET #state = :revoked, revision = revision + :one REMOVE tokenHash, GSI2PK, GSI2SK',
          ConditionExpression: '#state = :active AND revision = :revision',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':one': 1, ':revision': item.revision },
        },
      })),
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_DRAFT', `${presentation.communicationId}#${presentation.draftVersion}`),
          UpdateExpression: 'REMOVE GSI2PK, GSI2SK',
          ConditionExpression: 'attribute_not_exists(abandonedAt) AND attribute_not_exists(claimedAttemptId) AND payloadRef = :payloadRef',
          ExpressionAttributeValues: { ':payloadRef': presentation.payloadRef },
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('COMMUNICATION_PRESENTATION', presentation.id),
            ...presentation,
            GSI1PK: `COMMUNICATION#${presentation.communicationId}`,
            GSI1SK: `PRESENTATION#${presentation.createdAt}#${presentation.id}`,
            GSI2PK: 'SPONSOR_PRESENTATION_EXPIRY',
            GSI2SK: `${presentation.expiresAt}#${presentation.id}`,
            GSI4PK: `BOOKING_COMMUNICATION#${presentation.bookingId}`,
            GSI4SK: `PRESENTATION#${presentation.createdAt}#${presentation.id}`,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
    ClientRequestToken: randomUUID(),
  }));
}

export async function revokePresentation(
  client: DynamoDBDocumentClient,
  presentation: CommunicationPresentation,
  actorId: string,
): Promise<void> {
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('COMMUNICATION_PRESENTATION', presentation.id),
          UpdateExpression: 'SET #state = :revoked, revision = revision + :one, revokedBy = :actor, revokedAt = :now REMOVE tokenHash, GSI2PK, GSI2SK',
          ConditionExpression: '#state = :active AND revision = :revision AND createdBy = :actor',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':one': 1, ':revision': presentation.revision, ':actor': actorId, ':now': nowIso() },
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${nowIso()}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: 'presentation-rejected',
            actorId,
            communicationId: presentation.communicationId,
            at: nowIso(),
            ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
          },
        },
      },
    ],
  }));
}

export async function anchorPayloadRetention(
  client: DynamoDBDocumentClient,
  payloadId: string,
  anchor: string,
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: TABLE_SPONSOR_CRM,
    Key: itemKey('COMMUNICATION_PAYLOAD', payloadId),
    UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :anchor), #ttl = if_not_exists(#ttl, :ttl)',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':anchor': anchor, ':ttl': payloadDeleteAt(anchor) },
  }));
}

export const sponsorItemKey = itemKey;
