import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  expiryFrom,
  isExpired,
  validateConversationalRecord,
  type ChannelBinding,
  type Conversation,
  type ConversationAuditEvent,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type ConversationalRecord,
  type ExecutionAttempt,
  type IdentityBinding,
  type IdentityBindingAudit,
  type JsonValue,
  type PluginDraft,
  type ProposalPresentation,
  type ProposalVersion,
  type ResultNotification,
  type SkillLoadReceipt,
  type StoredContextReceipt,
  type SummaryCheckpoint,
} from './types';

type Key = Record<string, unknown>;
interface Page<T> { items: T[]; cursor?: Key }
interface AppendEventResult { event: ConversationEvent; duplicate: boolean }
interface AppendOutboundResult extends AppendEventResult {
  payload: ConversationalPrivatePayload;
}
interface StagedMediaControlLink {
  payloadId: string;
  expectedPayloadRevision: number;
  actionIds: string[];
}
interface ConsumeActionInput {
  actionId: string;
  siblingActionIds?: string[];
  conversationId: string;
  ownerUserId: string;
  actorId: string;
  identityBindingId: string;
  channelBindingId: string;
  channelConversationKey: string;
  expectedConversationRevision: number;
  consumedAt: string;
}
interface TransitionStagedMediaInput extends ConsumeActionInput {
  mediaPayloadId: string;
  expectedMediaRevision: number;
  terminalStatus: 'used' | 'discarded' | 'corrected';
  correctionPayload?: ConversationalPrivatePayload;
}

const EVENT_WIDTH = 16;
const VERSION_WIDTH = 12;
const testActionLocks = new Map<string, Promise<void>>();

function eventSk(sequence: number, eventId: string): string {
  return `EVENT#${String(sequence).padStart(EVENT_WIDTH, '0')}#${eventId}`;
}

function versionSk(version: number): string {
  return `VERSION#${String(version).padStart(VERSION_WIDTH, '0')}`;
}

function recoverySortKey(attempt: ExecutionAttempt): string {
  return `READY#${attempt.readyAt}#LEASE#${attempt.leaseExpiresAt || '-'}#${attempt.id}`;
}

function storageItem(record: ConversationalRecord): Record<string, unknown> {
  validateConversationalRecord(record);
  switch (record.recordType) {
    case 'identity_binding':
      return {
        ...record,
        PK: `IDENTITY#${record.channel}#${record.channelUserId}`,
        SK: 'META',
        GSI1PK: `USER#${record.userId}`,
        GSI1SK: `IDENTITY#${record.channel}#${record.channelUserId}`,
        GSI2PK: `IDENTITY_CHANNEL#${record.channel}`,
        GSI2SK: record.channelUserId,
      };
    case 'identity_binding_audit':
      return {
        ...record,
        PK: `IDENTITY_AUDIT#${record.channel}#${record.channelUserId}`,
        SK: `${record.createdAt}#${record.id}`,
        GSI1PK: `USER#${record.userId}`,
        GSI1SK: `IDENTITY_AUDIT#${record.createdAt}#${record.id}`,
      };
    case 'conversation':
      return {
        ...record,
        PK: `CONVERSATION#${record.id}`,
        SK: 'META',
        GSI1PK: `USER#${record.ownerUserId}`,
        GSI1SK: `CONVERSATION#${record.updatedAt}#${record.id}`,
      };
    case 'channel_binding':
      return {
        ...record,
        PK: `CHANNEL#${record.channel}#${record.channelConversationKey}`,
        SK: 'BINDING',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `CHANNEL_BINDING#${record.channel}#${record.channelConversationKey}`,
      };
    case 'conversation_event':
      return related(record, `CONVERSATION#${record.conversationId}`, eventSk(record.sequence, record.id), `EVENT#${String(record.sequence).padStart(EVENT_WIDTH, '0')}#${record.id}`);
    case 'summary_checkpoint':
      return related(record, `CONVERSATION#${record.conversationId}`, 'SUMMARY#CURRENT', 'SUMMARY#CURRENT');
    case 'plugin_draft':
      return related(record, `CONVERSATION#${record.conversationId}`, `DRAFT#${record.id}`, `DRAFT#${record.id}`);
    case 'proposal_version':
      return {
        ...record,
        PK: `PROPOSAL#${record.proposalId}`,
        SK: versionSk(record.version),
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `PROPOSAL#${record.proposalId}#${versionSk(record.version)}`,
      };
    case 'proposal_presentation':
      return {
        ...record,
        PK: `PRESENTATION#${record.actionTokenHash}`,
        SK: 'META',
        GSI1PK: `PROPOSAL#${record.proposalId}#${record.proposalVersion}`,
        GSI1SK: `PRESENTATION#${record.createdAt}#${record.id}`,
        conversationRelationshipPK: `CONVERSATION#${record.conversationId}`,
      };
    case 'execution_attempt':
      return {
        ...record,
        PK: `ATTEMPT#${record.id}`,
        SK: 'META',
        GSI1PK: `PROPOSAL#${record.proposalId}#${record.proposalVersion}`,
        GSI1SK: `ATTEMPT#${String(record.attemptNumber).padStart(8, '0')}#${record.id}`,
        GSI2PK: `ATTEMPT_STATE#${record.status}`,
        GSI2SK: recoverySortKey(record),
        conversationRelationshipPK: `CONVERSATION#${record.conversationId}`,
      };
    case 'conversation_audit_event':
      return {
        ...record,
        PK: `AUDIT#${record.subjectType}#${record.subjectId}`,
        SK: `${record.createdAt}#${record.id}`,
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `AUDIT#${record.createdAt}#${record.id}`,
      };
    case 'result_notification':
      return {
        ...record,
        PK: `RESULT_NOTIFICATION#${record.id}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${record.createdAt}#${record.id}`,
        GSI2PK: `RESULT_NOTIFICATION_STATE#${record.status}`,
        GSI2SK: `READY#${record.readyAt}#${record.id}`,
      };
    case 'conversational_private_payload':
      return {
        ...record,
        PK: `PRIVATE_PAYLOAD#${record.id}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${record.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${record.id}`,
      };
    case 'skill_load_receipt':
      return related(record, `CONVERSATION#${record.conversationId}`, `SKILL_LOAD#${record.loadNonceHash}`, `SKILL_LOAD#${record.createdAt}#${record.id}`);
    case 'context_receipt':
      return related(record, `CONVERSATION#${record.conversationId}`, `CONTEXT#${record.id}`, `CONTEXT#${record.createdAt}#${record.id}`);
  }
}

function related(record: ConversationalRecord, PK: string, SK: string, GSI1SK: string): Record<string, unknown> {
  const conversationId = (record as { conversationId: string }).conversationId;
  return { ...record, PK, SK, GSI1PK: `CONVERSATION#${conversationId}`, GSI1SK };
}

function clean<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const {
    PK: _pk, SK: _sk, GSI1PK: _gsi1pk, GSI1SK: _gsi1sk,
    GSI2PK: _gsi2pk, GSI2SK: _gsi2sk, conversationRelationshipPK: _relationship,
    ...record
  } = item;
  return record as T;
}

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ConditionalCheckFailedException'
    || error.name === 'TransactionCanceledException'
  );
}

async function putAbsent(client: DynamoDBDocumentClient, record: ConversationalRecord): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(record),
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

async function createSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  receipt: SkillLoadReceipt
): Promise<void> {
  await putAbsent(client, receipt);
}

async function getSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string
): Promise<SkillLoadReceipt | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` },
  }));
  return clean<SkillLoadReceipt>(result.Item as Record<string, unknown> | undefined);
}

async function consumeSkillLoadReceipt(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string,
  expectedRevision: number,
  consumedAt: string
): Promise<{ claimed: boolean; result?: unknown }> {
  const Key = { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` };
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${conversationId}`, SK: 'META' },
            ConditionExpression: 'revision = :revision AND #status <> :deleted AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revision': expectedRevision,
              ':deleted': 'deleted',
              ':now': consumedAt,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key,
            UpdateExpression: 'SET #status = :consumed, updatedAt = :now',
            ConditionExpression: '#status = :active AND conversationRevision = :revision AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':consumed': 'consumed',
              ':active': 'active',
              ':revision': expectedRevision,
              ':now': consumedAt,
            },
          },
        },
      ],
    }));
    return { claimed: true };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const existing = await getSkillLoadReceipt(client, conversationId, loadNonceHash);
    if (
      existing?.status === 'consumed'
      && existing.conversationRevision === expectedRevision
      && existing.consumedResult !== undefined
    ) return { claimed: false, result: existing.consumedResult };
    return { claimed: false };
  }
}

async function storeSkillLoadResult(
  client: DynamoDBDocumentClient,
  conversationId: string,
  loadNonceHash: string,
  result: unknown,
  updatedAt: string
): Promise<void> {
  const receipt = await getSkillLoadReceipt(client, conversationId, loadNonceHash);
  if (!receipt) throw new Error('skill load receipt is unavailable');
  const updated: SkillLoadReceipt = {
    ...receipt,
    consumedResult: result as SkillLoadReceipt['consumedResult'],
    updatedAt,
  };
  validateConversationalRecord(updated);
  await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `SKILL_LOAD#${loadNonceHash}` },
    UpdateExpression: 'SET consumedResult = :result, updatedAt = :now',
    ConditionExpression: '#status = :consumed AND attribute_not_exists(consumedResult)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':result': result, ':now': updatedAt, ':consumed': 'consumed' },
  }));
}

async function saveContextReceipt(
  client: DynamoDBDocumentClient,
  receipt: StoredContextReceipt
): Promise<void> {
  await putAbsent(client, receipt);
}

async function createIdentityBinding(client: DynamoDBDocumentClient, binding: IdentityBinding): Promise<void> {
  await putAbsent(client, binding);
}

async function listIdentityBindingsByChannel(
  client: DynamoDBDocumentClient,
  channel: string,
  limit = 50
): Promise<IdentityBinding[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `IDENTITY_CHANNEL#${channel}` },
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return ((result.Items || []) as Record<string, unknown>[])
    .map((item) => clean<IdentityBinding>(item)!);
}

async function putIdentityBindingAudit(
  client: DynamoDBDocumentClient,
  audit: IdentityBindingAudit
): Promise<void> {
  validateConversationalRecord(audit);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(audit),
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

async function transitionIdentityBindingWithAudit(
  client: DynamoDBDocumentClient,
  binding: IdentityBinding,
  audit: IdentityBindingAudit,
  expected: { status: IdentityBinding['status']; revision: number } | null
): Promise<IdentityBinding> {
  validateConversationalRecord(binding);
  validateConversationalRecord(audit);
  const key = { PK: `IDENTITY#${binding.channel}#${binding.channelUserId}`, SK: 'META' };
  const bindingPut = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(binding),
    ConditionExpression: expected === null
      ? 'attribute_not_exists(PK)'
      : '#status = :expectedStatus AND revision = :expectedRevision AND userId = :userId',
    ...(expected === null ? {} : {
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':expectedStatus': expected.status,
        ':expectedRevision': expected.revision,
        ':userId': binding.userId,
      },
    }),
  };
  const auditPut = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(audit),
    ConditionExpression: 'attribute_not_exists(PK)',
  };
  if (process.env.NODE_ENV !== 'test') {
    await client.send(new TransactWriteCommand({
      TransactItems: [{ Put: bindingPut }, { Put: auditPut }],
    }));
    return binding;
  }

  // Dynalite does not implement transactions. Keep the test fallback
  // recoverable so injected audit failures prove authorization never changes
  // without its audit evidence.
  const previousResult = expected === null
    ? null
    : await client.send(new GetCommand({ TableName: TABLE_CONVERSATIONAL_STATE, Key: key }));
  const previous = previousResult?.Item as Record<string, unknown> | undefined;
  await client.send(new PutCommand(bindingPut));
  try {
    await client.send(new PutCommand(auditPut));
  } catch (error) {
    if (previous) {
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: previous,
        ConditionExpression: 'revision = :writtenRevision',
        ExpressionAttributeValues: { ':writtenRevision': binding.revision },
      }));
    } else {
      await client.send(new DeleteCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: key,
        ConditionExpression: 'revision = :writtenRevision',
        ExpressionAttributeValues: { ':writtenRevision': binding.revision },
      }));
    }
    throw error;
  }
  return binding;
}

async function reactivateIdentityBinding(
  client: DynamoDBDocumentClient,
  binding: IdentityBinding,
  expectedRevision: number
): Promise<IdentityBinding> {
  validateConversationalRecord(binding);
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDENTITY#${binding.channel}#${binding.channelUserId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :active, provisionedBy = :actor, provisionedAt = :now, updatedAt = :now, revision = revision + :one REMOVE revokedBy, revokedAt',
    ConditionExpression: '#status = :revoked AND revision = :revision AND userId = :userId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':active': 'active', ':revoked': 'revoked', ':revision': expectedRevision,
      ':userId': binding.userId, ':actor': binding.provisionedBy,
      ':now': binding.provisionedAt, ':one': 1,
    },
    ReturnValues: 'ALL_NEW',
  }));
  return clean<IdentityBinding>(result.Attributes as Record<string, unknown>)!;
}

async function getIdentityBinding(
  client: DynamoDBDocumentClient,
  channel: string,
  channelUserId: string
): Promise<IdentityBinding | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDENTITY#${channel}#${channelUserId}`, SK: 'META' },
    ConsistentRead: true,
  }));
  return clean<IdentityBinding>(result.Item as Record<string, unknown> | undefined);
}

async function listIdentityBindings(
  client: DynamoDBDocumentClient,
  userId: string,
  cursor?: Key,
  limit = 50
): Promise<Page<IdentityBinding>> {
  return queryPage(client, {
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'IDENTITY#' },
  }, cursor, limit);
}

async function revokeIdentityBinding(
  client: DynamoDBDocumentClient,
  channel: string,
  channelUserId: string,
  expectedRevision: number,
  revokedBy: string,
  revokedAt: string
): Promise<IdentityBinding> {
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDENTITY#${channel}#${channelUserId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :revoked, revokedBy = :actor, revokedAt = :now, updatedAt = :now, revision = revision + :one',
    ConditionExpression: 'revision = :expected AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':revoked': 'revoked', ':active': 'active', ':actor': revokedBy,
      ':now': revokedAt, ':expected': expectedRevision, ':one': 1,
    },
    ReturnValues: 'ALL_NEW',
  }));
  return clean<IdentityBinding>(result.Attributes as Record<string, unknown>)!;
}

async function createConversation(client: DynamoDBDocumentClient, conversation: Conversation): Promise<void> {
  await putAbsent(client, conversation);
}

async function getConversation(
  client: DynamoDBDocumentClient,
  conversationId: string,
  now = new Date()
): Promise<Conversation | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: 'META' },
    ConsistentRead: true,
  }));
  const conversation = clean<Conversation>(result.Item as Record<string, unknown> | undefined);
  return !conversation || conversation.status === 'deleted' || isExpired(conversation, now) ? null : conversation;
}

async function updateConversation(
  client: DynamoDBDocumentClient,
  conversation: Conversation,
  expectedRevision: number
): Promise<void> {
  validateConversationalRecord(conversation);
  if (conversation.revision !== expectedRevision + 1) {
    throw new Error('conversation revision must advance exactly once');
  }
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(conversation),
    ConditionExpression: 'revision = :expected AND #status <> :deleted',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':expected': expectedRevision, ':deleted': 'deleted' },
  }));
}

async function listOwnerConversations(
  client: DynamoDBDocumentClient,
  userId: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<Conversation>> {
  const page = await queryPage<Conversation>(client, {
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'CONVERSATION#' },
    ScanIndexForward: false,
  }, cursor, limit);
  page.items = page.items.filter((item) => item.status !== 'deleted' && !isExpired(item, now));
  return page;
}

async function createChannelBinding(client: DynamoDBDocumentClient, binding: ChannelBinding): Promise<void> {
  validateConversationalRecord(binding);
  const owner = await getConversation(client, binding.conversationId);
  if (!owner || owner.ownerUserId !== binding.ownerUserId) throw new Error('conversation unavailable');
  await putAbsent(client, binding);
}

async function replaceChannelBinding(
  client: DynamoDBDocumentClient,
  binding: ChannelBinding,
  expectedConversationId: string
): Promise<void> {
  validateConversationalRecord(binding);
  const owner = await getConversation(client, binding.conversationId);
  if (!owner || owner.ownerUserId !== binding.ownerUserId) throw new Error('conversation unavailable');
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(binding),
    ConditionExpression: 'conversationId = :expected AND ownerUserId = :owner',
    ExpressionAttributeValues: {
      ':expected': expectedConversationId,
      ':owner': binding.ownerUserId,
    },
  }));
}

async function getChannelBinding(
  client: DynamoDBDocumentClient,
  channel: string,
  channelConversationKey: string,
  now = new Date()
): Promise<ChannelBinding | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CHANNEL#${channel}#${channelConversationKey}`, SK: 'BINDING' },
    ConsistentRead: true,
  }));
  const binding = clean<ChannelBinding>(result.Item as Record<string, unknown> | undefined);
  if (!binding || isExpired(binding, now)) return null;
  const owner = await getConversation(client, binding.conversationId, now);
  return owner && owner.ownerUserId === binding.ownerUserId ? binding : null;
}

async function appendConversationEvent(
  client: DynamoDBDocumentClient,
  event: ConversationEvent,
  expectedConversationRevision: number
): Promise<AppendEventResult> {
  validateConversationalRecord(event);
  const markerKey = {
    PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
    SK: 'MARKER',
  };
  const eventItem = storageItem(event);
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  if (process.env.NODE_ENV === 'test') {
    const existingMarker = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    if (existingMarker.Item) {
      const existing = await client.send(new GetCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: (existingMarker.Item as Record<string, unknown>).eventPK,
          SK: (existingMarker.Item as Record<string, unknown>).eventSK,
        },
      }));
      return { event: clean<ConversationEvent>(existing.Item as Record<string, unknown>)!, duplicate: true };
    }
    const owner = await getRawConversation(client, event.conversationId);
    if (
      !owner
      || owner.status === 'deleted'
      || isExpired(owner, new Date(event.createdAt))
      || owner.revision !== expectedConversationRevision
      || owner.nextEventSequence !== event.sequence
    ) {
      throw namedError('TransactionCanceledException', 'conversation revision or sequence changed');
    }
    let markerWritten = false;
    let eventWritten = false;
    try {
      const conversationExpiry = expiryFrom(event.createdAt, 30);
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: marker,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      markerWritten = true;
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: eventItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      eventWritten = true;
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
        UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
        ConditionExpression: 'revision = :revision AND nextEventSequence = :sequence',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':next': event.sequence + 1,
          ':one': 1,
          ':now': event.createdAt,
          ':revision': expectedConversationRevision,
          ':sequence': event.sequence,
          ':expiresAt': conversationExpiry.expiresAt,
          ':ttl': conversationExpiry.ttl,
          ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
        },
      }));
      return { event, duplicate: false };
    } catch (error) {
      if (markerWritten) {
        await client.send(new DeleteCommand({ TableName: TABLE_CONVERSATIONAL_STATE, Key: markerKey }));
      }
      if (eventWritten) {
        await client.send(new DeleteCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: eventItem.PK, SK: eventItem.SK },
        }));
      }
      if (conditionalFailure(error)) {
        if (!markerWritten) {
          const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
          if (duplicate) return { event: duplicate, duplicate: true };
        }
        throw namedError('TransactionCanceledException', 'event append condition changed');
      }
      throw error;
    }
  }
  try {
    const conversationExpiry = expiryFrom(event.createdAt, 30);
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
            ConditionExpression: 'revision = :revision AND nextEventSequence = :sequence AND #status <> :deleted AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revision': expectedConversationRevision,
              ':sequence': event.sequence,
              ':deleted': 'deleted',
              ':now': event.createdAt,
            },
          },
        },
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: marker,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: eventItem,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
            UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':next': event.sequence + 1,
              ':one': 1,
              ':now': event.createdAt,
              ':expiresAt': conversationExpiry.expiresAt,
              ':ttl': conversationExpiry.ttl,
              ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
            },
          },
        },
      ],
    }));
    return { event, duplicate: false };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const existingMarker = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    const markerItem = existingMarker.Item as Record<string, unknown> | undefined;
    if (!markerItem || markerItem.conversationId !== event.conversationId) throw error;
    const existing = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: markerItem.eventPK, SK: markerItem.eventSK },
    }));
    const existingEvent = clean<ConversationEvent>(existing.Item as Record<string, unknown> | undefined);
    if (!existingEvent) throw error;
    return { event: existingEvent, duplicate: true };
  }
}

async function appendConversationOutbound(
  client: DynamoDBDocumentClient,
  event: ConversationEvent,
  expectedConversationRevision: number,
  ownerUserId: string,
  payload: ConversationalPrivatePayload,
  actions: ConversationalPrivatePayload[],
  stagedMediaControlLink?: StagedMediaControlLink
): Promise<AppendOutboundResult> {
  validateConversationalRecord(event);
  validateConversationalRecord(payload);
  actions.forEach((action) => validateConversationalRecord(action));
  if (
    event.direction !== 'outbound'
    || event.payloadRef !== payload.id
    || payload.conversationId !== event.conversationId
    || actions.length > 8
    || actions.some((action) => action.conversationId !== event.conversationId)
    || new Set([payload.id, ...actions.map((action) => action.id)]).size !== actions.length + 1
    || (
      stagedMediaControlLink !== undefined
      && (
        stagedMediaControlLink.actionIds.length !== actions.length
        || stagedMediaControlLink.actionIds.some((id, index) => id !== actions[index]?.id)
        || stagedMediaControlLink.payloadId === payload.id
        || stagedMediaControlLink.expectedPayloadRevision < 1
      )
    )
  ) throw new Error('outbound transaction records are not consistently bound');

  const markerKey = {
    PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
    SK: 'MARKER',
  };
  const eventItem = storageItem(event);
  const payloadItem = storageItem(payload);
  const actionItems = actions.map(storageItem);
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  const conversationExpiry = expiryFrom(event.createdAt, 30);
  if (process.env.NODE_ENV !== 'test') {
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: marker,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: eventItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: payloadItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...actionItems.map((item) => ({
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
          ...(stagedMediaControlLink ? [{
            Update: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
                SK: 'META',
              },
              UpdateExpression: 'SET #content.controlActionIds = :actionIds, updatedAt = :now',
              ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :payloadRevision',
              ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
              ExpressionAttributeValues: {
                ':conversationId': event.conversationId,
                ':staged': 'staged',
                ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
                ':actionIds': stagedMediaControlLink.actionIds,
                ':now': event.createdAt,
              },
            },
          }] : []),
          {
            Update: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
              UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
              ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
              ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
              ExpressionAttributeValues: {
                ':owner': ownerUserId,
                ':revision': expectedConversationRevision,
                ':sequence': event.sequence,
                ':active': 'active',
                ':next': event.sequence + 1,
                ':one': 1,
                ':now': event.createdAt,
                ':expiresAt': conversationExpiry.expiresAt,
                ':ttl': conversationExpiry.ttl,
                ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
              },
            },
          },
        ],
      }));
      return { event, payload, duplicate: false };
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
      if (!duplicate?.payloadRef) throw error;
      const existingPayload = await getConversationalPrivatePayload(
        client, event.conversationId, duplicate.payloadRef, ownerUserId
      );
      if (!existingPayload) throw error;
      return { event: duplicate, payload: existingPayload, duplicate: true };
    }
  }

  const written: Key[] = [];
  let linkedMediaUpdated = false;
  try {
    for (const item of [payloadItem, ...actionItems]) {
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      written.push({ PK: item.PK, SK: item.SK });
    }
    if (stagedMediaControlLink) {
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
          SK: 'META',
        },
        UpdateExpression: 'SET #content.controlActionIds = :actionIds, updatedAt = :now',
        ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :payloadRevision',
        ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
        ExpressionAttributeValues: {
          ':conversationId': event.conversationId,
          ':staged': 'staged',
          ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
          ':actionIds': stagedMediaControlLink.actionIds,
          ':now': event.createdAt,
        },
      }));
      linkedMediaUpdated = true;
    }
    const appended = await appendConversationEvent(client, event, expectedConversationRevision);
    return { event: appended.event, payload, duplicate: appended.duplicate };
  } catch (error) {
    const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
    if (duplicate?.payloadRef) {
      const existingPayload = await getConversationalPrivatePayload(
        client, event.conversationId, duplicate.payloadRef, ownerUserId
      );
      if (existingPayload) return { event: duplicate, payload: existingPayload, duplicate: true };
    }
    for (const key of written.reverse()) {
      await client.send(new DeleteCommand({ TableName: TABLE_CONVERSATIONAL_STATE, Key: key }))
        .catch(() => undefined);
    }
    if (stagedMediaControlLink && linkedMediaUpdated) {
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
          SK: 'META',
        },
        UpdateExpression: 'REMOVE #content.controlActionIds',
        ConditionExpression: '#content.#status = :staged AND #content.revision = :payloadRevision AND updatedAt = :now',
        ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
        ExpressionAttributeValues: {
          ':staged': 'staged',
          ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
          ':now': event.createdAt,
        },
      })).catch(() => undefined);
    }
    throw error;
  }
}

async function resolveDuplicateEvent(
  client: DynamoDBDocumentClient,
  markerKey: Key,
  conversationId: string
): Promise<ConversationEvent | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const markerResult = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    const marker = markerResult.Item as Record<string, unknown> | undefined;
    if (!marker || marker.conversationId !== conversationId) return null;
    const result = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: marker.eventPK, SK: marker.eventSK },
    }));
    const event = clean<ConversationEvent>(result.Item as Record<string, unknown> | undefined);
    if (event) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

async function listConversationEvents(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ConversationEvent>> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const page = await queryPage<ConversationEvent>(client, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CONVERSATION#${conversationId}`, ':prefix': 'EVENT#' },
  }, cursor, limit);
  page.items = page.items.filter((item) => !isExpired(item, now));
  return page;
}

async function saveCheckpoint(
  client: DynamoDBDocumentClient,
  checkpoint: SummaryCheckpoint,
  expectedRevision: number | null
): Promise<void> {
  validateConversationalRecord(checkpoint);
  await requireConversation(client, checkpoint.conversationId);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(checkpoint),
    ConditionExpression: expectedRevision === null ? 'attribute_not_exists(PK)' : 'revision = :expected',
    ...(expectedRevision === null ? {} : { ExpressionAttributeValues: { ':expected': expectedRevision } }),
  }));
}

async function getCheckpoint(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  now = new Date()
): Promise<SummaryCheckpoint | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: 'SUMMARY#CURRENT' },
  }));
  const checkpoint = clean<SummaryCheckpoint>(result.Item as Record<string, unknown> | undefined);
  return !checkpoint || isExpired(checkpoint, now) ? null : checkpoint;
}

async function savePluginDraft(
  client: DynamoDBDocumentClient,
  draft: PluginDraft,
  expectedRevision: number | null
): Promise<void> {
  validateConversationalRecord(draft);
  await requireConversation(client, draft.conversationId);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(draft),
    ConditionExpression: expectedRevision === null ? 'attribute_not_exists(PK)' : 'revision = :expected',
    ...(expectedRevision === null ? {} : { ExpressionAttributeValues: { ':expected': expectedRevision } }),
  }));
}

async function getPluginDraft(
  client: DynamoDBDocumentClient,
  conversationId: string,
  draftId: string,
  ownerUserId: string,
  now = new Date()
): Promise<PluginDraft | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `DRAFT#${draftId}` },
  }));
  const draft = clean<PluginDraft>(result.Item as Record<string, unknown> | undefined);
  return !draft || isExpired(draft, now) ? null : draft;
}

async function insertProposalVersion(client: DynamoDBDocumentClient, proposal: ProposalVersion): Promise<void> {
  validateConversationalRecord(proposal);
  await requireConversation(client, proposal.conversationId);
  await putAbsent(client, proposal);
}

async function listProposalVersions(
  client: DynamoDBDocumentClient,
  proposalId: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ProposalVersion>> {
  const page = await queryPage<ProposalVersion>(client, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `PROPOSAL#${proposalId}`, ':prefix': 'VERSION#' },
  }, cursor, limit);
  page.items = await filterLiveOwners(client, page.items, now);
  return page;
}

async function compareAndSetProposalStatus(
  client: DynamoDBDocumentClient,
  proposalId: string,
  version: number,
  expectedStatus: ProposalVersion['status'],
  status: ProposalVersion['status'],
  updatedAt: string
): Promise<ProposalVersion> {
  return updateState<ProposalVersion>(
    client,
    { PK: `PROPOSAL#${proposalId}`, SK: versionSk(version) },
    expectedStatus,
    status,
    undefined,
    updatedAt
  );
}

async function createPresentation(client: DynamoDBDocumentClient, presentation: ProposalPresentation): Promise<void> {
  validateConversationalRecord(presentation);
  await requireConversation(client, presentation.conversationId);
  const item = storageItem(presentation);
  const link = relationshipLink(presentation.conversationId, presentation.id, item, presentation.expiresAt, presentation.ttl);
  if (process.env.NODE_ENV === 'test') {
    await putTargetAndLinkForLocalTest(client, item, link);
    return;
  }
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: link,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  }));
}

async function getPresentationByTokenHash(
  client: DynamoDBDocumentClient,
  actionTokenHash: string,
  now = new Date()
): Promise<ProposalPresentation | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRESENTATION#${actionTokenHash}`, SK: 'META' },
  }));
  const presentation = clean<ProposalPresentation>(result.Item as Record<string, unknown> | undefined);
  if (!presentation || isExpired(presentation, now)) return null;
  return (await getConversation(client, presentation.conversationId, now)) ? presentation : null;
}

async function compareAndSetPresentation(
  client: DynamoDBDocumentClient,
  actionTokenHash: string,
  expectedStatus: ProposalPresentation['status'],
  status: ProposalPresentation['status'],
  expectedRevision: number,
  updatedAt: string
): Promise<ProposalPresentation> {
  return updateState<ProposalPresentation>(
    client, { PK: `PRESENTATION#${actionTokenHash}`, SK: 'META' },
    expectedStatus, status, expectedRevision, updatedAt
  );
}

async function createExecutionAttempt(client: DynamoDBDocumentClient, attempt: ExecutionAttempt): Promise<void> {
  validateConversationalRecord(attempt);
  await requireConversation(client, attempt.conversationId);
  const item = storageItem(attempt);
  const link = relationshipLink(attempt.conversationId, attempt.id, item, attempt.expiresAt, attempt.ttl);
  if (process.env.NODE_ENV === 'test') {
    await putTargetAndLinkForLocalTest(client, item, link);
    return;
  }
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: link,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ],
  }));
}

async function getExecutionAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  now = new Date()
): Promise<ExecutionAttempt | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
  }));
  const attempt = clean<ExecutionAttempt>(result.Item as Record<string, unknown> | undefined);
  if (!attempt || isExpired(attempt, now)) return null;
  return (await getConversation(client, attempt.conversationId, now)) ? attempt : null;
}

async function compareAndSetExecutionAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedStatus: ExecutionAttempt['status'],
  status: ExecutionAttempt['status'],
  expectedRevision: number,
  updatedAt: string
): Promise<ExecutionAttempt> {
  const existing = await getExecutionAttempt(client, attemptId);
  if (!existing) throw new Error('execution attempt unavailable');
  const next = {
    ...existing,
    status,
    revision: expectedRevision + 1,
    updatedAt,
    ...expiryFrom(updatedAt, 365),
  };
  validateConversationalRecord(next);
  const item = storageItem(next);
  const result = await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: item,
    ConditionExpression: '#status = :expectedStatus AND revision = :expectedRevision',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':expectedStatus': expectedStatus, ':expectedRevision': expectedRevision },
    ReturnValues: 'ALL_OLD',
  }));
  if (!result.Attributes) throw new Error('execution attempt unavailable');
  return next;
}

async function listProposalRelationships(
  client: DynamoDBDocumentClient,
  proposalId: string,
  version: number,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ProposalPresentation | ExecutionAttempt>> {
  const page = await queryPage<ProposalPresentation | ExecutionAttempt>(client, {
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `PROPOSAL#${proposalId}#${version}` },
  }, cursor, limit);
  page.items = await filterLiveOwners(client, page.items, now);
  return page;
}

async function listRecoveryCandidates(
  client: DynamoDBDocumentClient,
  status: ExecutionAttempt['status'],
  readyThrough: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ExecutionAttempt>> {
  const page = await queryPage<ExecutionAttempt>(client, {
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':pk': `ATTEMPT_STATE#${status}`,
      ':through': `READY#${readyThrough}#\uffff`,
    },
  }, cursor, limit);
  page.items = (await filterLiveOwners(client, page.items, now)).filter((item) => (
    !item.recoveryBlocked
    && (item.status !== 'executing' || !item.leaseExpiresAt || item.leaseExpiresAt <= readyThrough)
  ));
  return page;
}

async function appendConversationAuditEvent(
  client: DynamoDBDocumentClient,
  auditEvent: ConversationAuditEvent
): Promise<void> {
  validateConversationalRecord(auditEvent);
  await requireConversation(client, auditEvent.conversationId);
  await putAbsent(client, auditEvent);
}

async function putConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload
): Promise<void> {
  validateConversationalRecord(payload);
  await requireConversation(client, payload.conversationId);
  await putAbsent(client, payload);
}

async function getConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  conversationId: string,
  payloadId: string,
  ownerUserId: string,
  now = new Date()
): Promise<ConversationalPrivatePayload | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${payloadId}`, SK: 'META' },
  }));
  const payload = clean<ConversationalPrivatePayload>(result.Item as Record<string, unknown> | undefined);
  return !payload || payload.conversationId !== conversationId || isExpired(payload, now) ? null : payload;
}

async function replaceConversationalPrivatePayload(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload
): Promise<void> {
  validateConversationalRecord(payload);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(payload),
    ConditionExpression: 'attribute_exists(PK) AND conversationId = :conversationId',
    ExpressionAttributeValues: { ':conversationId': payload.conversationId },
  }));
}

async function replaceConversationalPrivatePayloadConditionally(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload,
  expectedStatus: string,
  expectedRevision: number
): Promise<void> {
  validateConversationalRecord(payload);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(payload),
    ConditionExpression: 'attribute_exists(PK) AND conversationId = :conversationId AND #content.#status = :status AND #content.revision = :revision',
    ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
    ExpressionAttributeValues: {
      ':conversationId': payload.conversationId,
      ':status': expectedStatus,
      ':revision': expectedRevision,
    },
  }));
}

async function transitionStagedMediaAndAppend(
  client: DynamoDBDocumentClient,
  input: TransitionStagedMediaInput,
  event: ConversationEvent
): Promise<{
  media: ConversationalPrivatePayload;
  event: ConversationEvent;
  duplicate: boolean;
} | null> {
  validateConversationalRecord(event);
  if (input.correctionPayload) validateConversationalRecord(input.correctionPayload);
  const actionIds = [input.actionId, ...(input.siblingActionIds || [])];
  if (
    event.conversationId !== input.conversationId
    || event.sequence < 1
    || event.direction !== 'inbound'
    || actionIds.length < 1
    || actionIds.length > 8
    || new Set(actionIds).size !== actionIds.length
    || (input.terminalStatus === 'corrected') !== Boolean(input.correctionPayload)
    || (
      input.correctionPayload
      && (
        input.correctionPayload.conversationId !== input.conversationId
        || event.payloadRef !== input.correctionPayload.id
      )
    )
  ) throw new Error('staged media transition binding is invalid');

  const [mediaResult, actionResults] = await Promise.all([
    client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${input.mediaPayloadId}`, SK: 'META' },
    })),
    Promise.all(actionIds.map((id) => client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    })))),
  ]);
  const media = clean<ConversationalPrivatePayload>(
    mediaResult.Item as Record<string, unknown> | undefined
  );
  const mediaContent = media?.content && typeof media.content === 'object' && !Array.isArray(media.content)
    ? media.content as Record<string, JsonValue>
    : null;
  const actions = actionResults.map((result) => clean<ConversationalPrivatePayload>(
    result.Item as Record<string, unknown> | undefined
  ));
  const actionContents = actions.map((action) => (
    action?.content && typeof action.content === 'object' && !Array.isArray(action.content)
      ? action.content as Record<string, JsonValue>
      : null
  ));
  const mediaControlActionIds = Array.isArray(mediaContent?.controlActionIds)
    ? mediaContent.controlActionIds.filter((value): value is string => typeof value === 'string')
    : [];
  const baseActionBindingMatches = actionContents.every((content, index) => (
    actions[index]?.conversationId === input.conversationId
    && content?.kind === 'telegram_action'
    && content.actorId === input.actorId
    && content.identityBindingId === input.identityBindingId
    && content.channelBindingId === input.channelBindingId
    && content.channelConversationKey === input.channelConversationKey
    && content.expectedConversationRevision === input.expectedConversationRevision
    && (
      content.action && typeof content.action === 'object' && !Array.isArray(content.action)
      && (content.action as Record<string, JsonValue>).payloadRef === input.mediaPayloadId
    )
  ));
  const mediaBindingMatches = Boolean(
    media
    && media.conversationId === input.conversationId
    && (
      mediaContent?.revision === input.expectedMediaRevision
      || mediaContent?.revision === input.expectedMediaRevision + 1
    )
    && mediaControlActionIds.length === actionIds.length
    && actionIds.every((id) => mediaControlActionIds.includes(id))
  );
  if (!media || !baseActionBindingMatches || !mediaBindingMatches) return null;

  const duplicate = await getConversationEventByIdempotency(
    client, event.channel, event.idempotencyKey, event.conversationId
  );
  if (duplicate && mediaContent?.status === input.terminalStatus) {
    return { media, event: duplicate, duplicate: true };
  }
  if (
    duplicate
    || mediaContent?.status !== 'staged'
    || actionContents.some((content) => content?.status !== 'active')
    || isExpired(media, new Date(input.consumedAt))
    || actions.some((action) => !action || isExpired(action, new Date(input.consumedAt)))
  ) return null;

  const retention = expiryFrom(input.consumedAt, 30);
  const mediaKey = { PK: `PRIVATE_PAYLOAD#${input.mediaPayloadId}`, SK: 'META' };
  const actionBindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
    ':mediaPayloadId': input.mediaPayloadId,
  };
  const actionUpdate = (id: string, status: 'consumed' | 'revoked') => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    UpdateExpression: status === 'consumed'
      ? 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now'
      : 'SET #content.#status = :revoked, #content.revokedAt = :now, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision AND #content.#action.payloadRef = :mediaPayloadId',
    ExpressionAttributeNames: { '#content': 'content', '#status': 'status', '#action': 'action' },
    ExpressionAttributeValues: {
      ...actionBindingValues,
      ...(status === 'consumed' ? { ':consumed': 'consumed' } : { ':revoked': 'revoked' }),
    },
  });
  const mediaUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: mediaKey,
    UpdateExpression: input.terminalStatus === 'used'
      ? 'SET #content.#status = :terminal, #content.terminalAt = :now, #content.revision = :nextMediaRevision, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl'
      : 'SET #content.#status = :terminal, #content.terminalAt = :now, #content.revision = :nextMediaRevision, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl REMOVE #content.#text, #content.caption',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :mediaRevision AND expiresAt > :now',
    ExpressionAttributeNames: {
      '#content': 'content',
      '#status': 'status',
      '#ttl': 'ttl',
      ...(input.terminalStatus === 'used' ? {} : { '#text': 'text' }),
    },
    ExpressionAttributeValues: {
      ':conversationId': input.conversationId,
      ':staged': 'staged',
      ':terminal': input.terminalStatus,
      ':mediaRevision': input.expectedMediaRevision,
      ':nextMediaRevision': input.expectedMediaRevision + 1,
      ':now': input.consumedAt,
      ':expiresAt': retention.expiresAt,
      ':ttl': retention.ttl,
    },
  };
  const eventItem = storageItem(event);
  const markerKey = { PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`, SK: 'MARKER' };
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  const conversationExpiry = expiryFrom(event.createdAt, 30);
  const conversationUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
    UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
    ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':owner': input.ownerUserId,
      ':revision': input.expectedConversationRevision,
      ':sequence': event.sequence,
      ':active': 'active',
      ':next': event.sequence + 1,
      ':one': 1,
      ':now': event.createdAt,
      ':expiresAt': conversationExpiry.expiresAt,
      ':ttl': conversationExpiry.ttl,
      ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
    },
  };
  const chosenStatus = input.terminalStatus === 'corrected' ? 'revoked' : 'consumed';

  if (process.env.NODE_ENV !== 'test') {
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Update: mediaUpdate },
          ...actionIds.map((id, index) => ({
            Update: actionUpdate(id, index === 0 ? chosenStatus : 'revoked'),
          })),
          ...(input.correctionPayload ? [{
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: storageItem(input.correctionPayload),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          }] : []),
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: marker,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: eventItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Update: conversationUpdate },
        ],
      }));
      const terminalContent: Record<string, JsonValue> = {
        ...mediaContent,
        status: input.terminalStatus,
        terminalAt: input.consumedAt,
        revision: input.expectedMediaRevision + 1,
      };
      if (input.terminalStatus !== 'used') {
        delete terminalContent.text;
        delete terminalContent.caption;
      }
      return {
        media: {
          ...media,
          updatedAt: input.consumedAt,
          ...retention,
          content: terminalContent,
        },
        event,
        duplicate: false,
      };
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const resolved = await getConversationEventByIdempotency(
        client, event.channel, event.idempotencyKey, event.conversationId
      );
      if (!resolved) return null;
      const currentMedia = await getConversationalPrivatePayload(
        client, input.conversationId, input.mediaPayloadId, input.ownerUserId,
        new Date(input.consumedAt)
      );
      return currentMedia && objectContentStatus(currentMedia) === input.terminalStatus
        ? { media: currentMedia, event: resolved, duplicate: true }
        : null;
    }
  }

  const lockKey = [input.mediaPayloadId, ...actionIds].sort().join('|');
  const prior = testActionLocks.get(lockKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = prior.then(() => current);
  testActionLocks.set(lockKey, chain);
  await prior;
  try {
    const currentMediaResult = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: mediaKey,
    }));
    const currentMedia = clean<ConversationalPrivatePayload>(
      currentMediaResult.Item as Record<string, unknown> | undefined
    );
    if (objectContentStatus(currentMedia) !== 'staged') return null;
    const currentConversation = await getRawConversation(client, input.conversationId);
    if (
      !currentConversation
      || currentConversation.ownerUserId !== input.ownerUserId
      || currentConversation.revision !== input.expectedConversationRevision
      || currentConversation.nextEventSequence !== event.sequence
      || currentConversation.status !== 'active'
    ) return null;
    const currentActionResults = await Promise.all(actionIds.map((id) => client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    }))));
    if (currentActionResults.some((result) => (
      objectContentStatus(clean<ConversationalPrivatePayload>(
        result.Item as Record<string, unknown> | undefined
      )) !== 'active'
    ))) return null;

    const updatedMedia: ConversationalPrivatePayload = {
      ...currentMedia!,
      updatedAt: input.consumedAt,
      ...retention,
      content: {
        ...(currentMedia!.content as Record<string, JsonValue>),
        status: input.terminalStatus,
        terminalAt: input.consumedAt,
        revision: input.expectedMediaRevision + 1,
      },
    };
    if (input.terminalStatus !== 'used') {
      delete (updatedMedia.content as Record<string, JsonValue>).text;
      delete (updatedMedia.content as Record<string, JsonValue>).caption;
    }
    await client.send(new UpdateCommand(mediaUpdate));
    const updatedActionIds: string[] = [];
    try {
      for (const [index, id] of actionIds.entries()) {
        await client.send(new UpdateCommand(actionUpdate(
          id, index === 0 ? chosenStatus : 'revoked'
        )));
        updatedActionIds.push(id);
      }
      if (input.correctionPayload) {
        await client.send(new PutCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: storageItem(input.correctionPayload),
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      }
      const appended = await appendConversationEvent(
        client, event, input.expectedConversationRevision
      );
      return { media: updatedMedia, event: appended.event, duplicate: appended.duplicate };
    } catch (error) {
      if (input.correctionPayload) {
        await client.send(new DeleteCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRIVATE_PAYLOAD#${input.correctionPayload.id}`, SK: 'META' },
        })).catch(() => undefined);
      }
      for (const id of updatedActionIds) {
        const original = actions[actionIds.indexOf(id)];
        if (original) {
          await client.send(new PutCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: storageItem(original),
          })).catch(() => undefined);
        }
      }
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: storageItem(currentMedia!),
      })).catch(() => undefined);
      throw error;
    }
  } finally {
    release();
    if (testActionLocks.get(lockKey) === chain) testActionLocks.delete(lockKey);
  }
}

function objectContentStatus(payload: ConversationalPrivatePayload | null): JsonValue | undefined {
  return payload?.content && typeof payload.content === 'object' && !Array.isArray(payload.content)
    ? (payload.content as Record<string, JsonValue>).status
    : undefined;
}

async function consumeConversationalAction(
  client: DynamoDBDocumentClient,
  input: ConsumeActionInput
): Promise<ConversationalPrivatePayload | null> {
  await requireOwner(client, input.conversationId, input.ownerUserId, new Date(input.consumedAt));
  const key = { PK: `PRIVATE_PAYLOAD#${input.actionId}`, SK: 'META' };
  const existingResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: key,
  }));
  const existing = clean<ConversationalPrivatePayload>(
    existingResult.Item as Record<string, unknown> | undefined
  );
  const content = existing?.content && typeof existing.content === 'object' && !Array.isArray(existing.content)
    ? existing.content as Record<string, JsonValue>
    : null;
  if (
    !existing
    || existing.conversationId !== input.conversationId
    || isExpired(existing, new Date(input.consumedAt))
    || content?.kind !== 'telegram_action'
    || content.status !== 'active'
    || content.actorId !== input.actorId
    || content.identityBindingId !== input.identityBindingId
    || content.channelBindingId !== input.channelBindingId
    || content.channelConversationKey !== input.channelConversationKey
    || content.expectedConversationRevision !== input.expectedConversationRevision
  ) return null;

  const names = { '#content': 'content', '#status': 'status' };
  const bindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
  };
  const actionUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: key,
    UpdateExpression: 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...bindingValues, ':consumed': 'consumed' },
  };
  const siblingUpdates = (input.siblingActionIds || []).map((siblingActionId) => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${siblingActionId}`, SK: 'META' },
    UpdateExpression: 'SET #content.#status = :revoked, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...bindingValues, ':revoked': 'revoked' },
  }));
  const conversationCheck = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
    ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':owner': input.ownerUserId,
      ':revision': input.expectedConversationRevision,
      ':active': 'active',
    },
  };
  try {
    if (process.env.NODE_ENV !== 'test') {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: conversationCheck },
          { Update: actionUpdate },
          ...siblingUpdates.map((update) => ({ Update: update })),
        ],
      }));
    } else {
      const conversation = await getRawConversation(client, input.conversationId);
      if (
        !conversation
        || conversation.ownerUserId !== input.ownerUserId
        || conversation.status !== 'active'
        || conversation.revision !== input.expectedConversationRevision
      ) return null;
      await client.send(new UpdateCommand(actionUpdate));
      const revokedSiblingKeys: Key[] = [];
      for (const siblingUpdate of siblingUpdates) {
        try {
          await client.send(new UpdateCommand(siblingUpdate));
          revokedSiblingKeys.push(siblingUpdate.Key);
        } catch (error) {
          await client.send(new UpdateCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: key,
            UpdateExpression: 'SET #content.#status = :active REMOVE #content.consumedAt',
            ConditionExpression: '#content.#status = :consumed AND #content.consumedAt = :now',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: {
              ':active': 'active', ':consumed': 'consumed', ':now': input.consumedAt,
            },
          }));
          for (const siblingKey of revokedSiblingKeys) {
            await client.send(new UpdateCommand({
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: siblingKey,
              UpdateExpression: 'SET #content.#status = :active',
              ConditionExpression: '#content.#status = :revoked AND updatedAt = :now',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: {
                ':active': 'active', ':revoked': 'revoked', ':now': input.consumedAt,
              },
            })).catch(() => undefined);
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (conditionalFailure(error)) return null;
    throw error;
  }
  return {
    ...existing,
    updatedAt: input.consumedAt,
    content: { ...content, status: 'consumed', consumedAt: input.consumedAt },
  };
}

async function consumeConversationalActionAndAppend(
  client: DynamoDBDocumentClient,
  input: ConsumeActionInput,
  event: ConversationEvent
): Promise<{ action: ConversationalPrivatePayload; event: ConversationEvent; duplicate: boolean } | null> {
  validateConversationalRecord(event);
  if (
    event.conversationId !== input.conversationId
    || event.sequence < 1
    || event.direction !== 'inbound'
  ) throw new Error('action event binding is invalid');
  const duplicate = await getConversationEventByIdempotency(
    client, event.channel, event.idempotencyKey, event.conversationId
  );
  const actionResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${input.actionId}`, SK: 'META' },
  }));
  const action = clean<ConversationalPrivatePayload>(
    actionResult.Item as Record<string, unknown> | undefined
  );
  const content = action?.content && typeof action.content === 'object' && !Array.isArray(action.content)
    ? action.content as Record<string, JsonValue>
    : null;
  const bindingMatches = Boolean(
    action
    && action.conversationId === input.conversationId
    && !isExpired(action, new Date(input.consumedAt))
    && content?.kind === 'telegram_action'
    && content.actorId === input.actorId
    && content.identityBindingId === input.identityBindingId
    && content.channelBindingId === input.channelBindingId
    && content.channelConversationKey === input.channelConversationKey
    && content.expectedConversationRevision === input.expectedConversationRevision
  );
  if (!bindingMatches || !action) return null;
  if (duplicate) return { action, event: duplicate, duplicate: true };
  if (content?.status !== 'active') return null;

  if (process.env.NODE_ENV === 'test') {
    const lockKey = [input.actionId, ...(input.siblingActionIds || [])].sort().join('|');
    const prior = testActionLocks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = prior.then(() => current);
    testActionLocks.set(lockKey, chain);
    await prior;
    try {
      const consumed = await consumeConversationalAction(client, input);
      if (!consumed) return null;
      try {
        const appended = await appendConversationEvent(client, event, input.expectedConversationRevision);
        return { action: consumed, event: appended.event, duplicate: appended.duplicate };
      } catch (error) {
        const actionIds = [input.actionId, ...(input.siblingActionIds || [])];
        for (const actionId of actionIds) {
          await client.send(new UpdateCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `PRIVATE_PAYLOAD#${actionId}`, SK: 'META' },
            UpdateExpression: 'SET #content.#status = :active REMOVE #content.consumedAt',
            ConditionExpression: '#content.#status IN (:consumed, :revoked) AND updatedAt = :now',
            ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active', ':consumed': 'consumed', ':revoked': 'revoked', ':now': input.consumedAt,
            },
          })).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      release();
      if (testActionLocks.get(lockKey) === chain) testActionLocks.delete(lockKey);
    }
  }

  const eventItem = storageItem(event);
  const markerKey = { PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`, SK: 'MARKER' };
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  const names = { '#content': 'content', '#status': 'status' };
  const bindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
  };
  const actionUpdate = (actionId: string, status: 'consumed' | 'revoked') => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${actionId}`, SK: 'META' },
    UpdateExpression: status === 'consumed'
      ? 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now'
      : 'SET #content.#status = :revoked, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: {
      ...bindingValues,
      ...(status === 'consumed' ? { ':consumed': 'consumed' } : { ':revoked': 'revoked' }),
    },
  });
  const conversationExpiry = expiryFrom(event.createdAt, 30);
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Update: actionUpdate(input.actionId, 'consumed') },
        ...(input.siblingActionIds || []).map((id) => ({ Update: actionUpdate(id, 'revoked') })),
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: marker,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: eventItem,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
            UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
            ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active',
            ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':owner': input.ownerUserId,
              ':revision': input.expectedConversationRevision,
              ':sequence': event.sequence,
              ':active': 'active',
              ':next': event.sequence + 1,
              ':one': 1,
              ':now': event.createdAt,
              ':expiresAt': conversationExpiry.expiresAt,
              ':ttl': conversationExpiry.ttl,
              ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
            },
          },
        },
      ],
    }));
    return {
      action: {
        ...action,
        updatedAt: input.consumedAt,
        content: { ...content, status: 'consumed', consumedAt: input.consumedAt },
      },
      event,
      duplicate: false,
    };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const resolved = await getConversationEventByIdempotency(
      client, event.channel, event.idempotencyKey, event.conversationId
    );
    return resolved ? { action, event: resolved, duplicate: true } : null;
  }
}

async function getConversationEventByIdempotency(
  client: DynamoDBDocumentClient,
  channel: string,
  idempotencyKey: string,
  conversationId: string
): Promise<ConversationEvent | null> {
  const markerResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDEMPOTENCY#${channel}#${idempotencyKey}`, SK: 'MARKER' },
  }));
  const marker = markerResult.Item as Record<string, unknown> | undefined;
  if (!marker || marker.conversationId !== conversationId) return null;
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: marker.eventPK, SK: marker.eventSK },
  }));
  return clean<ConversationEvent>(result.Item as Record<string, unknown> | undefined);
}

async function markConversationDeleted(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  expectedRevision: number,
  deletedAt: string
): Promise<void> {
  const retention = expiryFrom(deletedAt, 30);
  await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :deleted, deletedAt = :now, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, revision = revision + :one, GSI1SK = :ownerSort REMOVE objective, currentReference, activeDraftId, activeProposalId',
    ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND #status <> :deleted',
    ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':deleted': 'deleted', ':now': deletedAt, ':one': 1,
      ':owner': ownerUserId, ':revision': expectedRevision,
      ':ownerSort': `CONVERSATION#${deletedAt}#${conversationId}`,
      ':expiresAt': retention.expiresAt,
      ':ttl': retention.ttl,
    },
  }));
}

async function cleanupDeletedConversation(
  client: DynamoDBDocumentClient,
  conversationId: string,
  cursor?: Key,
  limit = 25
): Promise<{ deleted: number; cursor?: Key }> {
  const tombstone = await getRawConversation(client, conversationId);
  if (!tombstone || tombstone.status !== 'deleted') throw new Error('conversation must be tombstoned first');
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `CONVERSATION#${conversationId}` },
    ExclusiveStartKey: cursor,
    Limit: limit,
  }));
  const items = (result.Items || []) as Record<string, unknown>[];
  for (const item of items) {
    if (item.recordType === 'conversation_relationship_link' && item.targetPK && item.targetSK) {
      await client.send(new DeleteCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: item.targetPK, SK: item.targetSK },
      }));
    }
    await client.send(new DeleteCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: item.PK, SK: item.SK },
    }));
  }
  return {
    deleted: items.length,
    ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey as Key } : {}),
  };
}

function relationshipLink(
  conversationId: string,
  id: string,
  target: Record<string, unknown>,
  expiresAt?: string,
  ttl?: number
): Record<string, unknown> {
  return {
    PK: `CONVERSATION#${conversationId}`,
    SK: `RELATIONSHIP#${target.recordType}#${id}`,
    GSI1PK: `CONVERSATION#${conversationId}`,
    GSI1SK: `RELATIONSHIP#${target.recordType}#${id}`,
    recordType: 'conversation_relationship_link',
    conversationId,
    targetPK: target.PK,
    targetSK: target.SK,
    expiresAt,
    ttl,
  };
}

async function putTargetAndLinkForLocalTest(
  client: DynamoDBDocumentClient,
  target: Record<string, unknown>,
  link: Record<string, unknown>
): Promise<void> {
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: target,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  try {
    await client.send(new PutCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Item: link,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    await client.send(new DeleteCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: target.PK, SK: target.SK },
    }));
    throw error;
  }
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

async function requireConversation(
  client: DynamoDBDocumentClient,
  conversationId: string,
  now = new Date()
): Promise<Conversation> {
  const conversation = await getConversation(client, conversationId, now);
  if (!conversation) throw new Error('conversation unavailable');
  return conversation;
}

async function requireOwner(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  now = new Date()
): Promise<Conversation> {
  const conversation = await requireConversation(client, conversationId, now);
  if (conversation.ownerUserId !== ownerUserId) throw new Error('conversation unavailable');
  return conversation;
}

async function getRawConversation(
  client: DynamoDBDocumentClient,
  conversationId: string
): Promise<Conversation | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: 'META' },
  }));
  return clean<Conversation>(result.Item as Record<string, unknown> | undefined);
}

async function queryPage<T>(
  client: DynamoDBDocumentClient,
  query: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName' | 'ExclusiveStartKey' | 'Limit'>,
  cursor?: Key,
  limit = 50
): Promise<Page<T>> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    ...query,
    ExclusiveStartKey: cursor,
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return {
    items: ((result.Items || []) as Record<string, unknown>[]).map((item) => clean<T>(item)!),
    ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey as Key } : {}),
  };
}

async function filterLiveOwners<T extends { conversationId: string; expiresAt?: string }>(
  client: DynamoDBDocumentClient,
  items: T[],
  now: Date
): Promise<T[]> {
  const result: T[] = [];
  const ownerCache = new Map<string, boolean>();
  for (const item of items) {
    if (isExpired(item, now)) continue;
    let live = ownerCache.get(item.conversationId);
    if (live === undefined) {
      live = Boolean(await getConversation(client, item.conversationId, now));
      ownerCache.set(item.conversationId, live);
    }
    if (live) result.push(item);
  }
  return result;
}

async function getResultNotification(
  client: DynamoDBDocumentClient,
  id: string,
  now = new Date()
): Promise<ResultNotification | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `RESULT_NOTIFICATION#${id}`, SK: 'META' },
    ConsistentRead: true,
  }));
  const notification = clean<ResultNotification>(result.Item as Record<string, unknown> | undefined);
  return !notification || isExpired(notification, now) ? null : notification;
}

async function listResultNotifications(
  client: DynamoDBDocumentClient,
  status: 'pending' | 'dispatching',
  through: string,
  limit = 50
): Promise<ResultNotification[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :state AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':state': `RESULT_NOTIFICATION_STATE#${status}`,
      ':through': `READY#${through}#\uffff`,
    },
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return ((result.Items || []) as Record<string, unknown>[])
    .map((item) => clean<ResultNotification>(item)!)
    .filter(Boolean);
}

async function claimResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  now: string,
  leaseExpiresAt: string
): Promise<ResultNotification | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :dispatching, leaseExpiresAt = :lease, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort',
      ConditionExpression: '#status = :pending AND revision = :revision AND readyAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pending': 'pending', ':dispatching': 'dispatching',
        ':revision': notification.revision, ':lease': leaseExpiresAt,
        ':now': now, ':one': 1, ':state': 'RESULT_NOTIFICATION_STATE#dispatching',
        ':sort': `READY#${leaseExpiresAt}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function finishResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  status: 'delivered' | 'outcome_unknown',
  now: string
): Promise<ResultNotification | null> {
  try {
    const deliveredSet = status === 'delivered' ? ', deliveredAt = :now' : '';
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: `SET #status = :status, updatedAt = :now${deliveredSet}, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort REMOVE leaseExpiresAt`,
      ConditionExpression: '#status = :dispatching AND revision = :revision AND leaseExpiresAt > :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':dispatching': 'dispatching', ':status': status,
        ':revision': notification.revision, ':now': now, ':one': 1,
        ':state': `RESULT_NOTIFICATION_STATE#${status}`,
        ':sort': `READY#${now}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function expireDispatchingResultNotification(
  client: DynamoDBDocumentClient,
  notification: ResultNotification,
  now: string
): Promise<ResultNotification | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `RESULT_NOTIFICATION#${notification.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :unknown, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :sort REMOVE leaseExpiresAt',
      ConditionExpression: '#status = :dispatching AND revision = :revision AND leaseExpiresAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':dispatching': 'dispatching', ':unknown': 'outcome_unknown',
        ':revision': notification.revision, ':now': now, ':one': 1,
        ':state': 'RESULT_NOTIFICATION_STATE#outcome_unknown',
        ':sort': `READY#${now}#${notification.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ResultNotification>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function updateState<T extends { status: string; revision: number }>(
  client: DynamoDBDocumentClient,
  Key: Key,
  expectedStatus: string,
  status: string,
  expectedRevision: number | undefined,
  updatedAt: string
): Promise<T> {
  const condition = expectedRevision === undefined
    ? '#status = :expectedStatus'
    : '#status = :expectedStatus AND revision = :expectedRevision';
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key,
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, revision = revision + :one',
    ConditionExpression: condition,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':expectedStatus': expectedStatus,
      ':updatedAt': updatedAt,
      ':one': 1,
      ...(expectedRevision === undefined ? {} : { ':expectedRevision': expectedRevision }),
    },
    ReturnValues: 'ALL_NEW',
  }));
  return clean<T>(result.Attributes as Record<string, unknown>)!;
}

export {
  appendConversationAuditEvent,
  appendConversationEvent,
  appendConversationOutbound,
  cleanupDeletedConversation,
  compareAndSetExecutionAttempt,
  compareAndSetPresentation,
  compareAndSetProposalStatus,
  claimResultNotification,
  consumeConversationalAction,
  consumeConversationalActionAndAppend,
  consumeSkillLoadReceipt,
  createChannelBinding,
  createConversation,
  createExecutionAttempt,
  createIdentityBinding,
  createPresentation,
  createSkillLoadReceipt,
  getChannelBinding,
  getConversation,
  getConversationEventByIdempotency,
  getConversationalPrivatePayload,
  getExecutionAttempt,
  getIdentityBinding,
  getCheckpoint,
  getPluginDraft,
  getPresentationByTokenHash,
  getResultNotification,
  getSkillLoadReceipt,
  insertProposalVersion,
  listConversationEvents,
  listIdentityBindings,
  listIdentityBindingsByChannel,
  listOwnerConversations,
  listProposalRelationships,
  listProposalVersions,
  listResultNotifications,
  listRecoveryCandidates,
  markConversationDeleted,
  putConversationalPrivatePayload,
  putIdentityBindingAudit,
  reactivateIdentityBinding,
  replaceChannelBinding,
  replaceConversationalPrivatePayload,
  replaceConversationalPrivatePayloadConditionally,
  revokeIdentityBinding,
  saveCheckpoint,
  saveContextReceipt,
  savePluginDraft,
  finishResultNotification,
  expireDispatchingResultNotification,
  storeSkillLoadResult,
  transitionStagedMediaAndAppend,
  transitionIdentityBindingWithAudit,
  updateConversation,
};
export type { AppendEventResult, Page, StagedMediaControlLink, TransitionStagedMediaInput };
