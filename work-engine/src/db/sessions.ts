import {
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_SESSIONS } from './setup';
import type { Session } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Session | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as Session;
}

/**
 * Create a new session. Generates a UUID token, sets createdAt.
 */
async function createSession(client: DynamoDBDocumentClient, userId: string): Promise<Session> {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `SESSION#${token}`,
    SK: `SESSION#${token}`,
    token,
    userId,
    createdAt: now,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: item,
    })
  );

  return cleanItem(item) as Session;
}

/**
 * Get a session by token. Returns null if not found.
 */
async function getSession(client: DynamoDBDocumentClient, token: string): Promise<Session | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_SESSIONS,
      Key: { PK: `SESSION#${token}`, SK: `SESSION#${token}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
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
  createSession,
  getSession,
  deleteSession,
};
