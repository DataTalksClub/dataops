import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { transactWrite } from './transactWrite';
import { cleanItem as cleanDbItem } from './cleanItem';
import { TABLE_SESSIONS } from './tableNames';
import type { ApiToken, ApiTokenSummary } from '../types';

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const TOKEN_PREFIX = 'dops_';
const INDEX_PK = 'APITOKENS';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenKey(id: string) {
  return { PK: `APITOKEN#${id}`, SK: `APITOKEN#${id}` };
}

function hashKey(tokenHash: string) {
  return { PK: `APITOKENHASH#${tokenHash}`, SK: `APITOKENHASH#${tokenHash}` };
}

function listKey(id: string) {
  return { PK: INDEX_PK, SK: `APITOKEN#${id}` };
}

function isExpired(token: Pick<ApiToken, 'expiresAt'>, now: Date): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function isMissingTable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { name?: string }).name === 'ResourceNotFoundException');
}

async function readApiTokenById(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<ApiToken | null> {
  try {
    const result = await client.send(new GetCommand({ TableName: TABLE_SESSIONS, Key: tokenKey(id) }));
    return cleanDbItem<ApiToken>(result.Item as Record<string, unknown> | undefined);
  } catch (error: unknown) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** Mint once, storing only a one-way hash of the secret in the sessions table. */
export async function createApiToken(
  client: DynamoDBDocumentClient,
  options: { userId: string; issuedBy: string; label: string; scopes: readonly string[]; now?: Date },
): Promise<{ apiToken: ApiToken; token: string }> {
  const now = options.now || new Date();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString();
  const ttl = Math.floor(Date.parse(expiresAt) / 1000);
  const apiToken: ApiToken = {
    id: randomUUID(),
    tokenHash,
    userId: options.userId,
    issuedBy: options.issuedBy,
    label: options.label,
    scopes: [...options.scopes],
    createdAt: now.toISOString(),
    expiresAt,
    ttl,
  };
  const summary = projectApiToken(apiToken);

  await transactWrite(client, [
      { Put: { TableName: TABLE_SESSIONS, Item: { ...tokenKey(apiToken.id), ...apiToken } } },
      { Put: { TableName: TABLE_SESSIONS, Item: { ...hashKey(tokenHash), id: apiToken.id, expiresAt, ttl } } },
      { Put: { TableName: TABLE_SESSIONS, Item: { ...listKey(apiToken.id), ...summary, ttl } } },
  ]);

  return { apiToken, token };
}

/** Resolve a presented token through its digest lookup; fail closed on expiry. */
export async function getApiToken(
  client: DynamoDBDocumentClient,
  token: string,
  now = new Date(),
): Promise<ApiToken | null> {
  if (!String(token || '').startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  let lookup;
  try {
    lookup = await client.send(new GetCommand({ TableName: TABLE_SESSIONS, Key: hashKey(tokenHash) }));
  } catch (error: unknown) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const id = lookup.Item?.id;
  if (typeof id !== 'string' || !id) return null;
  const apiToken = await readApiTokenById(client, id);
  if (!apiToken || apiToken.tokenHash !== tokenHash) return null;
  if (isExpired(apiToken, now)) {
    await deleteApiToken(client, apiToken.id);
    return null;
  }
  try {
    await touchApiToken(client, apiToken, now);
  } catch (error: unknown) {
    if (error && typeof error === 'object'
      && (error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
  return { ...apiToken, lastUsedAt: now.toISOString() };
}

export async function getApiTokenById(
  client: DynamoDBDocumentClient,
  id: string,
  now = new Date(),
): Promise<ApiToken | null> {
  if (!id) return null;
  const apiToken = await readApiTokenById(client, id);
  if (!apiToken) return null;
  if (isExpired(apiToken, now)) {
    await deleteApiToken(client, apiToken.id);
    return null;
  }
  return apiToken;
}

/** Update the admin list at most once per minute for normal CLI traffic. */
async function touchApiToken(
  client: DynamoDBDocumentClient,
  apiToken: ApiToken,
  now: Date,
): Promise<void> {
  const lastUsedAt = apiToken.lastUsedAt ? Date.parse(apiToken.lastUsedAt) : 0;
  if (now.getTime() - lastUsedAt < 60_000) return;
  const value = now.toISOString();
  await Promise.all([
    client.send(new UpdateCommand({
      TableName: TABLE_SESSIONS,
      Key: tokenKey(apiToken.id),
      UpdateExpression: 'SET lastUsedAt = :lastUsedAt',
      ExpressionAttributeValues: { ':lastUsedAt': value },
      ConditionExpression: 'attribute_exists(PK)',
    })),
    client.send(new UpdateCommand({
      TableName: TABLE_SESSIONS,
      Key: listKey(apiToken.id),
      UpdateExpression: 'SET lastUsedAt = :lastUsedAt',
      ExpressionAttributeValues: { ':lastUsedAt': value },
      ConditionExpression: 'attribute_exists(PK)',
    })),
  ]);
}

/** Admin inventory only; rows contain metadata but never a bearer token. */
export async function listApiTokens(
  client: DynamoDBDocumentClient,
  now = new Date(),
): Promise<ApiTokenSummary[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const result = await client.send(new QueryCommand({
        TableName: TABLE_SESSIONS,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': INDEX_PK },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      items.push(...(result.Items || []) as Record<string, unknown>[]);
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  } catch (error: unknown) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return items
    .map((item) => cleanDbItem<ApiTokenSummary>(item))
    .filter((item): item is ApiTokenSummary => Boolean(item))
    .filter((item) => Date.parse(item.expiresAt) > now.getTime())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Remove all lookup and listing rows together so revocation is immediate. */
export async function deleteApiToken(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<boolean> {
  const apiToken = await readApiTokenById(client, id);
  if (!apiToken) return false;
  await transactWrite(client, [
      { Delete: { TableName: TABLE_SESSIONS, Key: tokenKey(apiToken.id) } },
      { Delete: { TableName: TABLE_SESSIONS, Key: hashKey(apiToken.tokenHash) } },
      { Delete: { TableName: TABLE_SESSIONS, Key: listKey(apiToken.id) } },
  ]);
  return true;
}

export function projectApiToken(apiToken: ApiToken): ApiTokenSummary {
  return {
    id: apiToken.id,
    userId: apiToken.userId,
    issuedBy: apiToken.issuedBy,
    label: apiToken.label,
    scopes: [...apiToken.scopes],
    createdAt: apiToken.createdAt,
    expiresAt: apiToken.expiresAt,
    lastUsedAt: apiToken.lastUsedAt || null,
  };
}
