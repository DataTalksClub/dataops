import { randomUUID } from 'crypto';
import { PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM, TABLE_USERS } from '../db/tableNames';
import { payloadDeleteAt, sha256, suppressionKey, type HmacKeyring, type SendConfig } from './core';
import { anchorPayloadRetention, getSponsorItem, itemKey, listPresentations, nowIso } from './repository';
import type {
  CommunicationDraftVersion,
  CommunicationPresentation,
  CommunicationPrivatePayload,
  SponsorSendAttempt,
} from './types';

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
