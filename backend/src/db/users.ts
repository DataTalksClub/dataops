import {
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './setup';
import type { User } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) and passwordHash from an item.
 * Passwords must never be exposed via API.
 */
function cleanItem(item: Record<string, unknown> | undefined): User | null {
  if (!item) return null;
  const { PK, SK, passwordHash, ...rest } = item;
  return rest as unknown as User;
}

/**
 * Get raw user item including passwordHash. Used only for authentication.
 */
function rawItem(item: Record<string, unknown> | undefined): (User & { passwordHash?: string }) | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as User & { passwordHash?: string };
}

/**
 * Mutable user attributes accepted by {@link updateUser}. PK/SK/id/createdAt
 * are identity and never written here.
 */
const UPDATEABLE_USER_FIELDS = new Set(['name', 'email', 'role', 'disabled', 'passwordHash']);

/**
 * Patch a user's mutable attributes. Returns the clean updated user or null if
 * the user does not exist (ConditionExpression fails when the item is absent).
 * Only fields in {@link UPDATEABLE_USER_FIELDS} are applied.
 */
async function updateUser(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<User | null> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (UPDATEABLE_USER_FIELDS.has(key)) fields[key] = value;
  }
  if (Object.keys(fields).length === 0) {
    return getUser(client, id);
  }

  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};
  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
    i++;
  }

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: TABLE_USERS,
        Key: { PK: `USER#${id}`, SK: `USER#${id}` },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttrNames,
        ExpressionAttributeValues: expressionAttrValues,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      })
    );
    return cleanItem(result.Attributes as Record<string, unknown>);
  } catch (err: unknown) {
    // ConditionalCheckFailedException => user does not exist.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/**
 * Create a new user. Generates a UUID, sets createdAt, and writes to DynamoDB.
 * Returns the clean user object (without PK/SK).
 */
async function createUser(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<User> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `USER#${id}`,
    SK: `USER#${id}`,
    id,
    createdAt: now,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_USERS,
      Item: item,
    })
  );

  return cleanItem(item) as User;
}

/**
 * Create a user with a specific ID. Used by the seed script for stable UUIDs.
 * Returns the clean user object (without PK/SK).
 */
async function createUserWithId(client: DynamoDBDocumentClient, id: string, data: Record<string, unknown>): Promise<User> {
  const now = new Date().toISOString();

  const item = {
    PK: `USER#${id}`,
    SK: `USER#${id}`,
    id,
    createdAt: now,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_USERS,
      Item: item,
    })
  );

  return cleanItem(item) as User;
}

/**
 * Get a user by id. Returns the clean object or null if not found.
 */
async function getUser(client: DynamoDBDocumentClient, id: string): Promise<User | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_USERS,
      Key: { PK: `USER#${id}`, SK: `USER#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * List all users by scanning for items where PK begins with "USER#".
 */
async function listUsers(client: DynamoDBDocumentClient): Promise<User[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'USER#' },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as User);
}

/**
 * Get a user by email (for authentication). Returns raw item including passwordHash.
 */
async function getUserByEmail(client: DynamoDBDocumentClient, email: string): Promise<(User & { passwordHash?: string }) | null> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix) AND email = :email',
      ExpressionAttributeValues: { ':prefix': 'USER#', ':email': email },
    })
  );

  const items = result.Items || [];
  if (items.length === 0) return null;

  return rawItem(items[0] as Record<string, unknown>);
}

/** Return all users whose normalized email exactly matches the supplied identity. */
async function getUsersByNormalizedEmail(client: DynamoDBDocumentClient, email: string): Promise<User[]> {
  const normalized = email.trim().toLowerCase();
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'USER#' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...(result.Items || []) as Record<string, unknown>[]);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items
    .map((item) => cleanItem(item as Record<string, unknown>) as User)
    .filter((user) => user.email.trim().toLowerCase() === normalized);
}

export {
  createUser,
  createUserWithId,
  getUser,
  listUsers,
  getUserByEmail,
  getUsersByNormalizedEmail,
  updateUser,
};
