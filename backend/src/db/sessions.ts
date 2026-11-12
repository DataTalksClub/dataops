import { createHash } from 'node:crypto';
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

/**
 * Session rows are keyed by a one-way digest of the token, matching how API
 * tokens are stored in the same table: a dump of the table must not hold
 * usable credentials. The raw token is returned to the caller exactly once
 * (as the browser session cookie) and never persisted.
 */
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionKey(token: string) {
  const digest = hashSessionToken(token);
  return { PK: `SESSION#${digest}`, SK: `SESSION#${digest}` };
}

/** Create a bounded opaque browser session. */
async function createBrowserSession(
  client: DynamoDBDocumentClient,
  userId: string,
  options: BrowserSessionOptions,
): Promise<Session & { token: string }> {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '');
  const now = options.now || new Date();
  const expiresAt = new Date(now.getTime() + options.lifetimeSeconds * 1000).toISOString();
  const item = {
    ...sessionKey(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt,
    ttl: Math.floor(Date.parse(expiresAt) / 1000),
  };
  await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: item }));
  return { ...cleanItem(item) as Session, token };
}

/**
 * Look up a session by its raw token (hashed before the read). Returns null
 * when no row exists, the table is missing, or the session has expired; an
 * expired row is deleted on the way out.
 */
async function getSession(client: DynamoDBDocumentClient, token: string, now = new Date()): Promise<Session | null> {
  let result;
  try {
    result = await client.send(
      new GetCommand({
        TableName: TABLE_SESSIONS,
        Key: sessionKey(token),
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
      Key: sessionKey(token),
    })
  );
}

export {
  createBrowserSession,
  getSession,
  deleteSession,
};
