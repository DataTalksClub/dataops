import { createHash, randomBytes } from 'node:crypto';

import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_SESSIONS } from './setup';
import type { ApiToken, DeviceGrant } from '../types';

/**
 * CLI credentials live beside sessions: same table, same TTL attribute,
 * distinct key prefixes. Secrets (device code, user code, token) are stored as
 * SHA-256 hashes so a table dump never yields a usable credential.
 */
const DEVICE_TTL_SECONDS = 10 * 60;
const DEVICE_MAX_ATTEMPTS = 5;
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

// Confusable characters and vowels are excluded: codes are read aloud and
// retyped by hand, and must never spell a word.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export function hashSecret(value: string): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('hex');
}

export function generateApiToken(): string {
  return `dops_${randomBytes(32).toString('hex')}`;
}

export function normalizeUserCode(value: string): string {
  const compact = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 8) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function cleanItem<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as T;
}

/**
 * Start a device login. Returns the two secrets in clear exactly once; only
 * their hashes are persisted.
 */
export async function createDeviceGrant(
  client: DynamoDBDocumentClient,
  options: { label: string; requestIp: string; now?: Date },
): Promise<{ grant: DeviceGrant; deviceCode: string; userCode: string }> {
  const now = options.now || new Date();
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_SECONDS * 1000).toISOString();
  const grant: DeviceGrant = {
    id: hashSecret(deviceCode),
    userCodeHash: hashSecret(userCode),
    status: 'pending',
    label: options.label,
    requestIp: options.requestIp,
    createdAt: now.toISOString(),
    expiresAt,
    attempts: 0,
    ttl: epochSeconds(expiresAt),
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: { PK: `DEVICE#${grant.id}`, SK: `DEVICE#${grant.id}`, ...grant },
    }),
  );
  // Confirmation happens by user code, so the short code needs its own lookup
  // pointing at the grant.
  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: {
        PK: `DEVICECODE#${grant.userCodeHash}`,
        SK: `DEVICECODE#${grant.userCodeHash}`,
        grantId: grant.id,
        expiresAt,
        ttl: grant.ttl,
      },
    }),
  );

  return { grant, deviceCode, userCode };
}

async function readGrant(
  client: DynamoDBDocumentClient,
  grantId: string,
  now: Date,
): Promise<DeviceGrant | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `DEVICE#${grantId}`, SK: `DEVICE#${grantId}` },
    }),
  );
  const grant = cleanItem<DeviceGrant>(result.Item as Record<string, unknown> | undefined);
  if (!grant) return null;
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    await deleteDeviceGrant(client, grant);
    return null;
  }
  return grant;
}

export async function getDeviceGrantByDeviceCode(
  client: DynamoDBDocumentClient,
  deviceCode: string,
  now = new Date(),
): Promise<DeviceGrant | null> {
  return readGrant(client, hashSecret(deviceCode), now);
}

export async function getDeviceGrantByUserCode(
  client: DynamoDBDocumentClient,
  userCode: string,
  now = new Date(),
): Promise<DeviceGrant | null> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  const pointer = await client.send(
    new GetCommand({
      TableName: TABLE_SESSIONS,
      Key: {
        PK: `DEVICECODE#${hashSecret(normalized)}`,
        SK: `DEVICECODE#${hashSecret(normalized)}`,
      },
    }),
  );
  const grantId = pointer.Item?.grantId;
  if (!grantId || typeof grantId !== 'string') return null;
  return readGrant(client, grantId, now);
}

/**
 * Record a confirmation decision. Attempts are counted so a guessed user code
 * runs out of tries long before the code space is meaningfully explored.
 */
export async function resolveDeviceGrant(
  client: DynamoDBDocumentClient,
  grant: DeviceGrant,
  decision: { status: 'approved' | 'denied'; userId?: string; now?: Date },
): Promise<DeviceGrant> {
  const now = decision.now || new Date();
  const updated: DeviceGrant = {
    ...grant,
    status: decision.status,
    userId: decision.status === 'approved' ? decision.userId : undefined,
    approvedAt: now.toISOString(),
    attempts: grant.attempts + 1,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: { PK: `DEVICE#${grant.id}`, SK: `DEVICE#${grant.id}`, ...updated },
    }),
  );
  return updated;
}

export async function countDeviceGrantAttempt(
  client: DynamoDBDocumentClient,
  grant: DeviceGrant,
): Promise<number> {
  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `DEVICE#${grant.id}`, SK: `DEVICE#${grant.id}` },
      UpdateExpression: 'SET attempts = if_not_exists(attempts, :zero) + :one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Number(result.Attributes?.attempts || 0);
}

export function deviceGrantExhausted(grant: DeviceGrant): boolean {
  return grant.attempts >= DEVICE_MAX_ATTEMPTS;
}

export async function deleteDeviceGrant(
  client: DynamoDBDocumentClient,
  grant: DeviceGrant,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `DEVICE#${grant.id}`, SK: `DEVICE#${grant.id}` },
    }),
  );
  await client.send(
    new DeleteCommand({
      TableName: TABLE_SESSIONS,
      Key: {
        PK: `DEVICECODE#${grant.userCodeHash}`,
        SK: `DEVICECODE#${grant.userCodeHash}`,
      },
    }),
  );
}

/**
 * Mint a bearer credential. The clear token is returned once; lookups go
 * through its hash, and a per-user index item makes tokens listable and
 * revocable without a secondary index.
 */
export async function createApiToken(
  client: DynamoDBDocumentClient,
  options: { userId: string; label: string; source: 'device' | 'manual'; now?: Date },
): Promise<{ apiToken: ApiToken; token: string }> {
  const now = options.now || new Date();
  const token = generateApiToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString();
  const apiToken: ApiToken = {
    id: hashSecret(token),
    userId: options.userId,
    label: options.label,
    createdAt: now.toISOString(),
    expiresAt,
    source: options.source,
    ttl: epochSeconds(expiresAt),
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: { PK: `APITOKEN#${apiToken.id}`, SK: `APITOKEN#${apiToken.id}`, ...apiToken },
    }),
  );
  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: {
        PK: `USERTOKENS#${options.userId}`,
        SK: `APITOKEN#${apiToken.id}`,
        ...apiToken,
      },
    }),
  );

  return { apiToken, token };
}

export async function getApiToken(
  client: DynamoDBDocumentClient,
  token: string,
  now = new Date(),
): Promise<ApiToken | null> {
  if (!String(token || '').startsWith('dops_')) return null;
  const id = hashSecret(token);
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `APITOKEN#${id}`, SK: `APITOKEN#${id}` },
    }),
  );
  const apiToken = cleanItem<ApiToken>(result.Item as Record<string, unknown> | undefined);
  if (!apiToken) return null;
  if (Date.parse(apiToken.expiresAt) <= now.getTime()) {
    await deleteApiToken(client, apiToken.userId, apiToken.id);
    return null;
  }
  return apiToken;
}

/**
 * Record use for the token list. Written at most once a minute so routine API
 * traffic does not turn into a write per request.
 */
export async function touchApiToken(
  client: DynamoDBDocumentClient,
  apiToken: ApiToken,
  now = new Date(),
): Promise<void> {
  const last = apiToken.lastUsedAt ? Date.parse(apiToken.lastUsedAt) : 0;
  if (now.getTime() - last < 60_000) return;
  const lastUsedAt = now.toISOString();
  for (const key of [
    { PK: `APITOKEN#${apiToken.id}`, SK: `APITOKEN#${apiToken.id}` },
    { PK: `USERTOKENS#${apiToken.userId}`, SK: `APITOKEN#${apiToken.id}` },
  ]) {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_SESSIONS,
        Key: key,
        UpdateExpression: 'SET lastUsedAt = :lastUsedAt',
        ExpressionAttributeValues: { ':lastUsedAt': lastUsedAt },
      }),
    );
  }
}

export async function listApiTokens(
  client: DynamoDBDocumentClient,
  userId: string,
  now = new Date(),
): Promise<ApiToken[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_SESSIONS,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USERTOKENS#${userId}` },
    }),
  );
  return (result.Items || [])
    .map((item) => cleanItem<ApiToken>(item as Record<string, unknown>))
    .filter((item): item is ApiToken => Boolean(item))
    .filter((item) => Date.parse(item.expiresAt) > now.getTime())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function deleteApiToken(
  client: DynamoDBDocumentClient,
  userId: string,
  id: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `APITOKEN#${id}`, SK: `APITOKEN#${id}` },
    }),
  );
  await client.send(
    new DeleteCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `USERTOKENS#${userId}`, SK: `APITOKEN#${id}` },
    }),
  );
}

export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export { DEVICE_TTL_SECONDS, DEVICE_MAX_ATTEMPTS, TOKEN_TTL_SECONDS };
