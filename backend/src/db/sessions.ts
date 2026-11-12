import {
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { cleanItem as cleanDbItem } from './cleanItem';
import { TABLE_SESSIONS } from './tableNames';
import type { Session } from '../types';

export interface BrowserSessionOptions {
  now?: Date;
  lifetimeSeconds: number;
}

const cleanItem = cleanDbItem<Session>;

/** Create a bounded opaque browser session. */
async function createBrowserSession(
  client: DynamoDBDocumentClient,
  userId: string,
  options: BrowserSessionOptions,
): Promise<Session> {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '');
  const now = options.now || new Date();
  const expiresAt = new Date(now.getTime() + options.lifetimeSeconds * 1000).toISOString();
  const item = {
    PK: `SESSION#${token}`,
    SK: `SESSION#${token}`,
    token,
    userId,
    createdAt: now.toISOString(),
    expiresAt,
    ttl: Math.floor(Date.parse(expiresAt) / 1000),
    sessionType: 'browser',
  };
  await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: item }));
  return cleanItem(item) as Session;
}

/**
 * Get a session by token. Returns null if not found.
 */
async function getSession(client: DynamoDBDocumentClient, token: string, now = new Date()): Promise<Session | null> {
  let result;
  try {
    result = await client.send(
      new GetCommand({
        TableName: TABLE_SESSIONS,
        Key: { PK: `SESSION#${token}`, SK: `SESSION#${token}` },
      })
    );
  } catch (err: unknown) {
    // A missing credential table means no credential exists: fail closed to
    // unauthenticated instead of turning every bearer lookup into a 500.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ResourceNotFoundException') return null;
    throw err;
  }

  const session = result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
  if (!session) return null;
  // A session without a parseable expiry is never valid.
  if (!(Date.parse(session.expiresAt) > now.getTime())) {
    await deleteSession(client, token);
    return null;
  }
  return session;
}

/**
 * Delete a session by token (logout).
 */
async function deleteSession(client: DynamoDBDocumentClient, token: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `SESSION#${token}`, SK: `SESSION#${token}` },
    })
  );
}

export {
  createBrowserSession,
  getSession,
  deleteSession,
};
