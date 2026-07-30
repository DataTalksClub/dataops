import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/setup';
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
  type PluginDraft,
  type ProposalPresentation,
  type ProposalVersion,
  type SkillLoadReceipt,
  type StoredContextReceipt,
  type SummaryCheckpoint,
} from './types';

type Key = Record<string, unknown>;
interface Page<T> { items: T[]; cursor?: Key }
interface AppendEventResult { event: ConversationEvent; duplicate: boolean }

const EVENT_WIDTH = 16;
const VERSION_WIDTH = 12;

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

async function getIdentityBinding(
  client: DynamoDBDocumentClient,
  channel: string,
  channelUserId: string
): Promise<IdentityBinding | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDENTITY#${channel}#${channelUserId}`, SK: 'META' },
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

async function getChannelBinding(
  client: DynamoDBDocumentClient,
  channel: string,
  channelConversationKey: string,
  now = new Date()
): Promise<ChannelBinding | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CHANNEL#${channel}#${channelConversationKey}`, SK: 'BINDING' },
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
  cleanupDeletedConversation,
  compareAndSetExecutionAttempt,
  compareAndSetPresentation,
  compareAndSetProposalStatus,
  consumeSkillLoadReceipt,
  createChannelBinding,
  createConversation,
  createExecutionAttempt,
  createIdentityBinding,
  createPresentation,
  createSkillLoadReceipt,
  getChannelBinding,
  getConversation,
  getExecutionAttempt,
  getIdentityBinding,
  getCheckpoint,
  getPluginDraft,
  getPresentationByTokenHash,
  getSkillLoadReceipt,
  insertProposalVersion,
  listConversationEvents,
  listIdentityBindings,
  listOwnerConversations,
  listProposalRelationships,
  listProposalVersions,
  listRecoveryCandidates,
  markConversationDeleted,
  putConversationalPrivatePayload,
  revokeIdentityBinding,
  saveCheckpoint,
  saveContextReceipt,
  savePluginDraft,
  storeSkillLoadResult,
  updateConversation,
};
export type { AppendEventResult, Page };
