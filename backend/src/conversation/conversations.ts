import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
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
} from './types';
import {
  clean,
  putAbsent,
  queryPage,
  storageItem,
  type Key,
  type Page,
} from './conversationStorage';

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

export type { Key, Page };
export {
  cleanupDeletedConversation,
  createChannelBinding,
  createConversation,
  filterLiveOwners,
  getChannelBinding,
  getConversation,
  getRawConversation,
  listOwnerConversations,
  markConversationDeleted,
  replaceChannelBinding,
  requireConversation,
  requireOwner,
  updateConversation,
};
