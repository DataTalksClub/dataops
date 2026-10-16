import { createHash } from 'node:crypto';
import {
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';
import type { FormerUser, User } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): User | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as User;
}

/**
 * Mutable user attributes accepted by {@link updateUser}. PK/SK/id/createdAt
 * are identity and never written here.
 */
const UPDATEABLE_USER_FIELDS = new Set(['name', 'role', 'disabled']);

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
      ConsistentRead: true,
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

/** Return all users whose normalized email exactly matches the supplied identity. */
async function getUsersByNormalizedEmail(client: DynamoDBDocumentClient, email: string): Promise<User[]> {
  const normalized = normalizeEmail(email);
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'USER#' },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    items.push(...(result.Items || []) as Record<string, unknown>[]);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items
    .map((item) => cleanItem(item as Record<string, unknown>) as User)
    .filter((user) => normalizeEmail(user.email) === normalized);
}

/** The sign-in identity form: emails compare trimmed and lowercased. */
function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

/**
 * The display record a deleted account leaves behind: its id and name, so
 * history that names the person (who completed a Task, who published a
 * revision) still reads as a name. It lives under its own `FORMER#` key, so
 * no account lookup or USER# scan can ever find it.
 *
 * It also keeps a hash of the email, never the email itself, so sign-in can
 * tell a deleted person "your account was deleted" rather than "you were
 * never added". The hash is not returned by any API.
 */
function formerUserEmailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function formerUserKey(id: string) {
  return { PK: `FORMER#${id}`, SK: `FORMER#${id}` };
}

function cleanFormerUser(item: Record<string, unknown> | undefined): FormerUser | null {
  if (!item) return null;
  return {
    id: String(item.id),
    name: String(item.name || ''),
    deletedAt: String(item.deletedAt || ''),
  };
}

async function getFormerUser(client: DynamoDBDocumentClient, id: string): Promise<FormerUser | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_USERS, Key: formerUserKey(id) }));
  return cleanFormerUser(result.Item as Record<string, unknown> | undefined);
}

/** The former-user record a deleted account with this email left behind. */
async function getFormerUserByEmail(client: DynamoDBDocumentClient, email: string): Promise<FormerUser | null> {
  const emailHash = formerUserEmailHash(email);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix) AND emailHash = :emailHash',
      ExpressionAttributeValues: { ':prefix': 'FORMER#', ':emailHash': emailHash },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    const item = (result.Items || [])[0] as Record<string, unknown> | undefined;
    if (item) return cleanFormerUser(item);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}

async function listFormerUsers(client: DynamoDBDocumentClient): Promise<FormerUser[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_USERS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'FORMER#' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...(result.Items || []) as Record<string, unknown>[]);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.map((item) => cleanFormerUser(item) as FormerUser);
}

/**
 * Profile photo URLs come from the signed ID token, and only Google's photo
 * host is accepted: the URL ends up as an <img src> for every teammate.
 */
function profilePictureUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googleusercontent.com') ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Refresh the user's profile photo on every SSO sign-in, so it follows the
 * Google account. A sign-in without a usable picture clears the old one.
 */
async function recordSignInPicture(client: DynamoDBDocumentClient, id: string, picture: unknown): Promise<User | null> {
  const url = profilePictureUrl(picture);
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_USERS,
      Key: { PK: `USER#${id}`, SK: `USER#${id}` },
      UpdateExpression: url ? 'SET #picture = :picture' : 'REMOVE #picture',
      ExpressionAttributeNames: { '#picture': 'picture' },
      ...(url ? { ExpressionAttributeValues: { ':picture': url } } : {}),
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }));
    return cleanItem(result.Attributes as Record<string, unknown>);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

export {
  formerUserKey,
  getFormerUser,
  listFormerUsers,
  createUser,
  createUserWithId,
  getUser,
  listUsers,
  getUsersByNormalizedEmail,
  formerUserEmailHash,
  getFormerUserByEmail,
  normalizeEmail,
  recordSignInPicture,
  updateUser,
};
