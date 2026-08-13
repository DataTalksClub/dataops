import { randomUUID } from 'crypto';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM, TABLE_USERS } from '../db/tableNames';
import { getCrmRecord } from '../db/sponsorCrm';
import { normalizeEmail, payloadDeleteAt, sha256, suppressionKey, type HmacKeyring, type SendConfig } from './core';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
  CommunicationSuggestion,
  SponsorSendAttempt,
} from './types';

const itemKey = (kind: string, id: string) => ({ PK: `${kind}#${id}`, SK: `${kind}#${id}` });
const clean = <T>(item?: Record<string, unknown>): T | null => {
  if (!item) return null;
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, GSI4PK, GSI4SK, ...value } = item;
  return value as T;
};
const nowIso = () => new Date().toISOString();

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

export async function cancelQueuedAttempt(
  client: DynamoDBDocumentClient,
  attempt: SponsorSendAttempt,
  actorId: string,
): Promise<void> {
  const now = nowIso();
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: TABLE_USERS,
          Key: { PK: `USER#${actorId}`, SK: `USER#${actorId}` },
          ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
        },
      },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
          UpdateExpression: 'SET #status = :cancelled, derivedStatus = :cancelled, recoveryBlocked = :true, payloadDeleteAt = if_not_exists(payloadDeleteAt, :ttl), updatedAt = :now, revision = revision + :one REMOVE GSI2PK, GSI2SK, correlationToken',
          ConditionExpression: '#status = :queued AND revision = :revision AND attribute_not_exists(dispatchStartedAt)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':cancelled': 'cancelled', ':true': true, ':ttl': payloadDeleteAt(now), ':now': now, ':one': 1,
            ':queued': 'queued', ':revision': attempt.revision,
          },
        },
      },
    ],
  }));
  await anchorPayloadRetention(client, attempt.payloadRef, now);
}

export async function reconcileAttempt(
  client: DynamoDBDocumentClient,
  attempt: SponsorSendAttempt,
  actorId: string,
  resolution: 'effect_applied' | 'no_effect',
  reason: string,
): Promise<void> {
  const now = nowIso();
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: TABLE_USERS,
          Key: { PK: `USER#${actorId}`, SK: `USER#${actorId}` },
          ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
        },
      },
      {
        Update: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('SPONSOR_SEND_ATTEMPT', attempt.id),
          UpdateExpression: 'SET #status = :resolved, derivedStatus = :derived, resolution = :resolution, resolutionReason = :reason, resolvedBy = :actor, resolvedAt = :now, recoveryBlocked = :true, updatedAt = :now, revision = revision + :one REMOVE correlationToken, leaseOwner, leaseExpiresAt, GSI2PK, GSI2SK',
          ConditionExpression: '#status = :unknown AND revision = :revision',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':resolved': 'resolved', ':derived': resolution, ':resolution': resolution, ':reason': reason.slice(0, 240),
            ':actor': actorId, ':now': now, ':true': true, ':one': 1, ':unknown': 'outcome_unknown', ':revision': attempt.revision,
          },
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${now}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: 'uncertainty-reconciled',
            attemptId: attempt.id,
            communicationId: attempt.communicationId,
            actorId,
            resolution,
            safeReason: reason.slice(0, 240),
            at: now,
            ttl: attempt.ttl,
          },
        },
      },
    ],
  }));
}

export type ApprovalInput = {
  actorId: string;
  presentation: CommunicationPresentation;
  draft: CommunicationDraftVersion;
  payload: CommunicationPrivatePayload;
  config: SendConfig;
  keyring: HmacKeyring;
  token: string;
};

export async function approveDraft(client: DynamoDBDocumentClient, input: ApprovalInput): Promise<SponsorSendAttempt> {
  if (input.presentation.createdBy !== input.actorId) {
    throw new Error('Approval requires a fresh actor-bound presentation');
  }
  const attemptId = sha256(`sponsor-send-attempt:v1\0${input.draft.communicationId}\0${input.draft.version}\0${input.draft.payloadHash}`);
  const existing = await getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId);
  if (existing) {
    if (
      input.presentation.state === 'consumed'
      && input.draft.claimedAttemptId === attemptId
      && existing.communicationId === input.draft.communicationId
      && existing.draftVersion === input.draft.version
      && existing.payloadHash === input.draft.payloadHash
      && existing.previewHash === input.draft.previewHash
      && existing.configDigest === input.config.digest
      && existing.approverId === input.actorId
    ) return existing;
    throw new Error('Existing attempt does not match this exact approval');
  }
  const now = nowIso();
  const correlation = randomUUID() + randomUUID();
  const attempt: SponsorSendAttempt = {
    id: attemptId,
    recordType: 'sponsor-send-attempt',
    communicationId: input.draft.communicationId,
    bookingId: input.draft.bookingId,
    draftVersion: input.draft.version,
    payloadRef: input.draft.payloadRef,
    payloadHash: input.draft.payloadHash,
    previewHash: input.draft.previewHash,
    approverId: input.actorId,
    roleSnapshot: 'admin',
    status: 'queued',
    derivedStatus: 'queued',
    configDigest: input.config.digest,
    configGeneration: input.config.generation,
    sesAccount: input.config.sesAccount,
    sesRegion: input.config.sesRegion,
    sesIdentityArn: input.config.sesIdentityArn,
    from: input.config.from,
    ...(input.config.replyTo ? { replyTo: input.config.replyTo } : {}),
    configurationSet: input.config.configurationSet,
    configurationSetGeneration: input.config.configurationSetGeneration,
    correlationHash: sha256(correlation),
    revision: 1,
    dueKey: 'SPONSOR_SEND_DUE',
    dueAt: now,
    recoveryBlocked: false,
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
  };
  const siblings = (await listPresentations(client, input.draft.communicationId))
    .filter((item) => item.id !== input.presentation.id && item.state === 'active').slice(0, 8);
  const suppressionChecks = input.config.hmacAcceptedVersions.map((version) => ({
    ConditionCheck: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('EMAIL_SUPPRESSION', suppressionKey(version, input.payload.payload.to, input.keyring)),
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  }));
  await client.send(new PutCommand({
    TableName: TABLE_SPONSOR_CRM,
    Item: {
      ...itemKey('SPONSOR_SEND_CONFIG_VERSION', `${input.config.generation}#${input.config.digest}`),
      ...input.config,
      id: `${input.config.generation}#${input.config.digest}`,
      recordType: 'sponsor-send-config',
      enabled: false,
      archivedSnapshot: true,
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  })).catch(async (error) => {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
  });
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_USERS,
            Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
            ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('COMMUNICATION_PRESENTATION', input.presentation.id),
            UpdateExpression: 'SET #state = :consumed, revision = revision + :one REMOVE tokenHash, GSI2PK, GSI2SK',
            ConditionExpression: '#state = :active AND revision = :revision AND createdBy = :actor AND tokenHash = :tokenHash AND expiresAt > :now AND payloadHash = :payloadHash AND previewHash = :previewHash',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':consumed': 'consumed', ':active': 'active', ':one': 1, ':revision': input.presentation.revision,
              ':actor': input.actorId, ':tokenHash': sha256(input.token), ':now': now, ':payloadHash': input.draft.payloadHash, ':previewHash': input.draft.previewHash,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('COMMUNICATION_DRAFT', `${input.draft.communicationId}#${input.draft.version}`),
            UpdateExpression: 'SET claimedAttemptId = :attempt REMOVE GSI2PK, GSI2SK',
            ConditionExpression: 'attribute_not_exists(claimedAttemptId) AND payloadHash = :payloadHash AND previewHash = :previewHash AND configDigest = :configDigest',
            ExpressionAttributeValues: {
              ':attempt': attemptId, ':payloadHash': input.draft.payloadHash, ':previewHash': input.draft.previewHash, ':configDigest': input.config.digest,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('SPONSOR_SEND_CONFIG', 'CURRENT'),
            ConditionExpression: 'enabled = :true AND generation = :generation AND digest = :digest',
            ExpressionAttributeValues: { ':true': true, ':generation': input.config.generation, ':digest': input.config.digest },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('COMMUNICATION_PAYLOAD', input.payload.id),
            ConditionExpression: 'communicationId = :communication AND #version = :version AND payloadHash = :payloadHash',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':communication': input.draft.communicationId,
              ':version': input.draft.version,
              ':payloadHash': input.draft.payloadHash,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('COMMUNICATION_DRAFT', `${input.draft.communicationId}#${input.draft.version + 1}`),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('BOOKING', input.payload.payload.bookingId),
            ConditionExpression: '#version = :version AND organizationId = :organization AND #status <> :cancelled AND #status <> :complete',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: {
              ':version': input.payload.payload.bookingVersion,
              ':organization': input.payload.payload.organizationId,
              ':cancelled': 'cancelled',
              ':complete': 'complete',
            },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('ORGANIZATION', input.payload.payload.organizationId),
            ConditionExpression: '#version = :version AND attribute_not_exists(archivedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': input.payload.payload.organizationVersion },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('CONTACT', input.payload.payload.contactId),
            ConditionExpression: '#version = :version AND organizationId = :organization AND active = :true AND attribute_not_exists(archivedAt)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':version': input.payload.payload.contactVersion,
              ':organization': input.payload.payload.organizationId,
              ':true': true,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('COMMUNICATION_SUGGESTION', input.payload.payload.suggestionId),
            ConditionExpression: '#version = :version AND eligible = :true AND #status = :open',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: { ':version': input.payload.payload.suggestionVersion, ':true': true, ':open': 'open' },
          },
        },
        ...suppressionChecks,
        ...siblings.map((item) => ({
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
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('SPONSOR_SEND_ATTEMPT', attemptId),
              ...attempt,
              correlationToken: correlation,
              GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
              GSI1SK: `ATTEMPT#${attempt.createdAt}#${attempt.id}`,
              GSI2PK: attempt.dueKey,
              GSI2SK: `${attempt.dueAt}#${attempt.id}`,
              GSI3PK: `CORRELATION#${attempt.correlationHash}`,
              GSI3SK: attempt.id,
              GSI4PK: `BOOKING_COMMUNICATION#${attempt.bookingId}`,
              GSI4SK: `ATTEMPT#${attempt.createdAt}#${attempt.id}`,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('SPONSOR_SEND_CORRELATION', attempt.correlationHash),
              id: attempt.correlationHash,
              recordType: 'sponsor-send-correlation',
              attemptId,
              communicationId: attempt.communicationId,
              configGeneration: attempt.configGeneration,
              correlationHash: attempt.correlationHash,
              GSI3PK: `CORRELATION#${attempt.correlationHash}`,
              GSI3SK: attempt.id,
              createdAt: now,
              ttl: attempt.ttl,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('SPONSOR_COMM_AUDIT', `${now}#${randomUUID()}`),
              recordType: 'sponsor-communication-audit',
              action: 'approved',
              communicationId: attempt.communicationId,
              attemptId,
              actorId: input.actorId,
              roleSnapshot: 'admin',
              at: now,
              ttl: attempt.ttl,
              GSI1PK: `COMMUNICATION#${attempt.communicationId}`,
              GSI1SK: `AUDIT#${now}`,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
      ClientRequestToken: randomUUID(),
    }));
    return attempt;
  } catch (error) {
    const duplicate = await getSponsorItem<SponsorSendAttempt>(client, 'SPONSOR_SEND_ATTEMPT', attemptId);
    if (
      duplicate?.payloadHash === input.draft.payloadHash
      && duplicate.previewHash === input.draft.previewHash
      && duplicate.communicationId === input.draft.communicationId
      && duplicate.draftVersion === input.draft.version
      && duplicate.configDigest === input.config.digest
      && duplicate.approverId === input.actorId
    ) return duplicate;
    throw error;
  }
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

export async function reconcileAbandonedSponsorPayloads(
  client: DynamoDBDocumentClient,
  now = nowIso(),
  limit = 10,
): Promise<{ drafts: number; presentations: number }> {
  const bounded = Math.min(Math.max(limit, 1), 25);
  const [drafts, presentations] = await Promise.all([
    client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      IndexName: 'GSI-SponsorSendDue',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': 'SPONSOR_DRAFT_ABANDONMENT', ':now': `${now}#\uffff` },
      Limit: bounded,
    })),
    client.send(new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      IndexName: 'GSI-SponsorSendDue',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': 'SPONSOR_PRESENTATION_EXPIRY', ':now': `${now}#\uffff` },
      Limit: bounded,
    })),
  ]);
  let anchoredDrafts = 0;
  let anchoredPresentations = 0;
  for (const raw of drafts.Items || []) {
    const draft = clean<CommunicationDraftVersion>(raw as Record<string, unknown>);
    const dueKey = raw.GSI2SK;
    if (!draft || typeof dueKey !== 'string') continue;
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_DRAFT', `${draft.communicationId}#${draft.version}`),
              UpdateExpression: 'SET abandonedAt = :now, revision = if_not_exists(revision, :zero) + :one REMOVE GSI2PK, GSI2SK',
              ConditionExpression: 'attribute_not_exists(claimedAttemptId) AND attribute_not_exists(abandonedAt) AND GSI2SK = :due',
              ExpressionAttributeValues: { ':now': now, ':zero': 0, ':one': 1, ':due': dueKey },
            },
          },
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PAYLOAD', draft.payloadRef),
              UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':now': now, ':ttl': payloadDeleteAt(now) },
            },
          },
          {
            Put: {
              TableName: TABLE_SPONSOR_CRM,
              Item: {
                ...itemKey('SPONSOR_COMM_AUDIT', `draft-abandoned#${draft.id}`),
                recordType: 'sponsor-communication-audit',
                action: 'draft-abandoned',
                communicationId: draft.communicationId,
                bookingId: draft.bookingId,
                draftVersion: draft.version,
                at: now,
                ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
      anchoredDrafts++;
    } catch (error) {
      if (!(error as Error).name.includes('Transaction') && !(error as Error).name.includes('Conditional')) throw error;
    }
  }
  for (const raw of presentations.Items || []) {
    const presentation = clean<CommunicationPresentation>(raw as Record<string, unknown>);
    const dueKey = raw.GSI2SK;
    if (!presentation || typeof dueKey !== 'string') continue;
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PRESENTATION', presentation.id),
              UpdateExpression: 'SET #state = :expired, expiredAt = :now, revision = revision + :one REMOVE tokenHash, GSI2PK, GSI2SK',
              ConditionExpression: '#state = :active AND expiresAt <= :now AND GSI2SK = :due',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: { ':expired': 'expired', ':active': 'active', ':now': now, ':one': 1, ':due': dueKey },
            },
          },
          {
            Update: {
              TableName: TABLE_SPONSOR_CRM,
              Key: itemKey('COMMUNICATION_PAYLOAD', presentation.payloadRef),
              UpdateExpression: 'SET retentionAnchoredAt = if_not_exists(retentionAnchoredAt, :now), #ttl = if_not_exists(#ttl, :ttl)',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':now': now, ':ttl': payloadDeleteAt(now) },
            },
          },
          {
            Put: {
              TableName: TABLE_SPONSOR_CRM,
              Item: {
                ...itemKey('SPONSOR_COMM_AUDIT', `presentation-expired#${presentation.id}`),
                recordType: 'sponsor-communication-audit',
                action: 'presentation-expired',
                communicationId: presentation.communicationId,
                bookingId: presentation.bookingId,
                presentationId: presentation.id,
                at: now,
                ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
      anchoredPresentations++;
    } catch (error) {
      if (!(error as Error).name.includes('Transaction') && !(error as Error).name.includes('Conditional')) throw error;
    }
  }
  return { drafts: anchoredDrafts, presentations: anchoredPresentations };
}

export async function getCurrentConfig(client: DynamoDBDocumentClient): Promise<SendConfig | null> {
  const item = await getSponsorItem<Record<string, unknown>>(client, 'SPONSOR_SEND_CONFIG', 'CURRENT');
  if (!item) return null;
  return {
    enabled: item.enabled === true,
    generation: Number(item.generation),
    templateSetGeneration: String(item.templateSetGeneration),
    templateSetDigest: String(item.templateSetDigest),
    hmacSecretVersionId: String(item.hmacSecretVersionId),
    hmacActiveVersion: String(item.hmacActiveVersion),
    hmacAcceptedVersions: Array.isArray(item.hmacAcceptedVersions) ? item.hmacAcceptedVersions.map(String) : [],
    hmacKeyringDigest: String(item.hmacKeyringDigest),
    sesAccount: String(item.sesAccount),
    sesRegion: String(item.sesRegion),
    sesIdentityArn: String(item.sesIdentityArn),
    from: String(item.from),
    ...(typeof item.replyTo === 'string' ? { replyTo: item.replyTo } : {}),
    configurationSet: String(item.configurationSet),
    configurationSetGeneration: String(item.configurationSetGeneration),
    approverPolicyVersion: String(item.approverPolicyVersion),
    digest: String(item.digest),
  };
}

export async function putConfig(client: DynamoDBDocumentClient, config: SendConfig, actorId: string): Promise<void> {
  const existing = await getCurrentConfig(client);
  if (config.enabled) await assertSuppressionCoverage(client, config.hmacAcceptedVersions, config.hmacActiveVersion);
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: { ...itemKey('SPONSOR_SEND_CONFIG', 'CURRENT'), ...config, recordType: 'sponsor-send-config', updatedAt: nowIso(), updatedBy: actorId },
          ConditionExpression: existing ? 'generation = :previous' : 'attribute_not_exists(PK)',
          ...(existing ? { ExpressionAttributeValues: { ':previous': existing.generation } } : {}),
        },
      },
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${nowIso()}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: config.enabled ? 'config-enabled' : 'config-disabled',
            actorId,
            configGeneration: config.generation,
            at: nowIso(),
            ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
          },
        },
      },
    ],
  }));
}

export async function assertSuppressionCoverage(
  client: DynamoDBDocumentClient,
  acceptedVersions: string[],
  requiredOnlyVersion?: string,
): Promise<void> {
  const coverage = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_COVERAGE', 'CURRENT');
  const liveVersions = coverage?.liveVersions instanceof Set
    ? [...coverage.liveVersions].map(String)
    : Array.isArray(coverage?.liveVersions) ? coverage.liveVersions.map(String) : [];
  if (liveVersions.some((version) => !acceptedVersions.includes(version))) {
    throw new Error('Live suppression key version is not covered by the configured keyring');
  }
  if (requiredOnlyVersion && liveVersions.some((version) => version !== requiredOnlyVersion)) {
    throw new Error('Suppression rotation must finish before sending is enabled');
  }
  for (const version of liveVersions) {
    const count = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_VERSION_COUNT', version);
    if (!count || Number(count.liveCount) < 1) throw new Error('Suppression coverage count is inconsistent');
  }
}

export async function removeSuppression(
  client: DynamoDBDocumentClient,
  input: { id: string; revision: number; actorId: string; reason: string; allowProtected: boolean },
): Promise<void> {
  const suppression = await getSponsorItem<Record<string, unknown>>(client, 'EMAIL_SUPPRESSION', input.id);
  if (!suppression || suppression.status !== 'active') throw new Error('Suppression not found');
  const category = String(suppression.category);
  if (category !== 'manual' && !input.allowProtected) throw new Error('Provider suppression requires protected reconciliation');
  const version = String(suppression.keyVersion);
  const count = await getSponsorItem<Record<string, unknown>>(client, 'SUPPRESSION_VERSION_COUNT', version);
  if (!count || Number(count.liveCount) < 1) throw new Error('Suppression count is inconsistent');
  const now = nowIso();
  const countOperation = Number(count.liveCount) === 1 ? {
    Delete: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
      ConditionExpression: 'liveCount = :one',
      ExpressionAttributeValues: { ':one': 1 },
    },
  } : {
    Update: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
      UpdateExpression: 'ADD liveCount :minusOne SET updatedAt = :now',
      ConditionExpression: 'liveCount > :one',
      ExpressionAttributeValues: { ':minusOne': -1, ':one': 1, ':now': now },
    },
  };
  const coverageOperation = Number(count.liveCount) === 1 ? [{
    Update: {
      TableName: TABLE_SPONSOR_CRM,
      Key: itemKey('SUPPRESSION_COVERAGE', 'CURRENT'),
      UpdateExpression: 'DELETE liveVersions :versions SET updatedAt = :now',
      ExpressionAttributeValues: { ':versions': new Set([version]), ':now': now },
    },
  }] : [];
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: TABLE_USERS,
          Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
          ConditionExpression: 'attribute_exists(PK) AND #role = :admin AND (attribute_not_exists(disabled) OR disabled = :false)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':admin': 'admin', ':false': false },
        },
      },
      {
        Delete: {
          TableName: TABLE_SPONSOR_CRM,
          Key: itemKey('EMAIL_SUPPRESSION', input.id),
          ConditionExpression: 'revision = :revision AND #status = :active AND category = :category',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':revision': input.revision, ':active': 'active', ':category': category },
        },
      },
      countOperation,
      ...coverageOperation,
      {
        Put: {
          TableName: TABLE_SPONSOR_CRM,
          Item: {
            ...itemKey('SPONSOR_COMM_AUDIT', `${now}#${randomUUID()}`),
            recordType: 'sponsor-communication-audit',
            action: category === 'manual' ? 'manual-suppression-removed' : 'provider-suppression-reconciled',
            actorId: input.actorId,
            suppressionId: input.id,
            safeReason: input.reason.slice(0, 240),
            at: now,
            ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
          },
        },
      },
    ],
  }));
}

export async function addSuppression(
  client: DynamoDBDocumentClient,
  input: { canonicalAddress: string; contactId: string; organizationId: string; category: 'manual' | 'bounce' | 'complaint'; actorId: string; safeReason: string },
  config: SendConfig,
  keyring: HmacKeyring,
): Promise<{ id: string; version: number }> {
  const version = config.hmacActiveVersion;
  const id = suppressionKey(version, input.canonicalAddress, keyring);
  const now = nowIso();
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_USERS,
            Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
            ConditionExpression: 'attribute_exists(PK) AND (#role = :operator OR #role = :admin) AND (attribute_not_exists(disabled) OR disabled = :false)',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':operator': 'operator', ':admin': 'admin', ':false': false },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('EMAIL_SUPPRESSION', id),
              id,
              recordType: 'email-suppression',
              keyVersion: version,
              contactId: input.contactId,
              organizationId: input.organizationId,
              category: input.category,
              status: 'active',
              safeReason: input.safeReason.slice(0, 120),
              revision: 1,
              createdAt: now,
              updatedAt: now,
              GSI1PK: `SUPPRESSION_VERSION#${version}`,
              GSI1SK: id,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('SUPPRESSION_VERSION_COUNT', version),
            UpdateExpression: 'ADD liveCount :one SET keyVersion = :version, recordType = :recordType, updatedAt = :now',
            ExpressionAttributeValues: { ':one': 1, ':version': version, ':recordType': 'suppression-version-count', ':now': now },
          },
        },
        {
          Update: {
            TableName: TABLE_SPONSOR_CRM,
            Key: itemKey('SUPPRESSION_COVERAGE', 'CURRENT'),
            UpdateExpression: 'ADD liveVersions :versions SET recordType = :recordType, updatedAt = :now',
            ExpressionAttributeValues: { ':versions': new Set([version]), ':recordType': 'suppression-coverage', ':now': now },
          },
        },
        {
          Put: {
            TableName: TABLE_SPONSOR_CRM,
            Item: {
              ...itemKey('SPONSOR_COMM_AUDIT', `suppression-add#${id}`),
              recordType: 'sponsor-communication-audit',
              action: input.category === 'manual' ? 'manual-suppression-added' : 'provider-suppression-added',
              actorId: input.actorId,
              suppressionId: id,
              contactId: input.contactId,
              organizationId: input.organizationId,
              category: input.category,
              safeReason: input.safeReason.slice(0, 120),
              at: now,
              ttl: Math.floor(Date.parse(now) / 1000) + 365 * 24 * 60 * 60,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
    return { id, version: 1 };
  } catch (error) {
    const existing = await getSponsorItem<Record<string, unknown>>(client, 'EMAIL_SUPPRESSION', id);
    if (existing?.status === 'active') return { id, version: Number(existing.revision) };
    throw error;
  }
}

export const sponsorItemKey = itemKey;
