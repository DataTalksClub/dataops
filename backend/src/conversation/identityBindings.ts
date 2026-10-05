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
  validateConversationalRecord,
  type IdentityBinding,
  type IdentityBindingAudit,
} from './types';
import {
  clean,
  putAbsent,
  queryPage,
  storageItem,
  type Key,
  type Page,
} from './conversationStorage';

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

export type { Key, Page };
export {
  createIdentityBinding,
  getIdentityBinding,
  listIdentityBindings,
  listIdentityBindingsByChannel,
  putIdentityBindingAudit,
  reactivateIdentityBinding,
  revokeIdentityBinding,
  transitionIdentityBindingWithAudit,
};
