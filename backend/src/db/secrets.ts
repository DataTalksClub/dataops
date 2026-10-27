import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { decodeFields, encodeFields } from '../secrets/cipher';
import type { SecretCipher } from '../secrets/cipher';
import { TABLE_AUDIT_EVENTS, TABLE_SECRETS } from './tableNames';

/**
 * The team secrets store. One dedicated table; a single partition holds every
 * named secret, so listing is a Query rather than a Scan. The item keeps the
 * encrypted field payload (`data`) plus plain metadata: the field NAMES stay
 * readable so a list never has to decrypt anything, and values exist only
 * inside the ciphertext.
 */

const PARTITION = 'SECRETS';

/** How long an access-audit event is retained before TTL removal. */
const AUDIT_TTL_DAYS = 365;

export interface SecretMeta {
  name: string;
  /** Field names only — never values. */
  fields: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type SecretRecord = Omit<SecretMeta, 'fields'> & { fields: Record<string, string> };

export type SecretAccessAction = 'list' | 'read' | 'write' | 'delete';

function secretKey(name: string): { PK: string; SK: string } {
  return { PK: PARTITION, SK: `SECRET#${name}` };
}

function toMeta(item: Record<string, unknown>): SecretMeta {
  return {
    name: item.name as string,
    fields: (item.fieldNames as string[]) || [],
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string,
    updatedAt: item.updatedAt as string,
    updatedBy: item.updatedBy as string,
  };
}

/**
 * Create or replace a secret. Replacement is whole-secret: `set` writes the
 * complete field set, so removing a field is a set without it.
 */
export async function putSecret(
  client: DynamoDBDocumentClient,
  cipher: SecretCipher,
  input: { name: string; fields: Record<string, string>; actorId: string },
): Promise<SecretMeta> {
  const now = new Date().toISOString();
  const existing = await client.send(new GetCommand({
    TableName: TABLE_SECRETS,
    Key: secretKey(input.name),
    ProjectionExpression: 'createdAt, createdBy',
  }));
  const createdAt = (existing.Item?.createdAt as string) || now;
  const createdBy = (existing.Item?.createdBy as string) || input.actorId;
  const data = await cipher.encrypt(input.name, encodeFields(input.fields));
  const meta: SecretMeta = {
    name: input.name,
    fields: Object.keys(input.fields).sort(),
    createdAt,
    createdBy,
    updatedAt: now,
    updatedBy: input.actorId,
  };
  await client.send(new PutCommand({
    TableName: TABLE_SECRETS,
    Item: { ...secretKey(input.name), ...meta, fieldNames: meta.fields, data },
  }));
  await recordSecretAccess(client, { action: 'write', actorId: input.actorId, secretName: input.name, fields: meta.fields });
  return meta;
}

/** Read and decrypt one secret, or null when the name is unknown. */
export async function getSecret(
  client: DynamoDBDocumentClient,
  cipher: SecretCipher,
  name: string,
  actorId: string,
): Promise<SecretRecord | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_SECRETS,
    Key: secretKey(name),
  }));
  if (!result.Item) return null;
  const fields = decodeFields(await cipher.decrypt(name, result.Item.data as string));
  await recordSecretAccess(client, { action: 'read', actorId, secretName: name });
  return { ...toMeta(result.Item), fields };
}

/** Every stored secret's metadata, by name. Values are never involved. */
export async function listSecrets(client: DynamoDBDocumentClient): Promise<SecretMeta[]> {
  const metas: SecretMeta[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: TABLE_SECRETS,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': PARTITION },
      ExclusiveStartKey: startKey,
    }));
    for (const item of page.Items || []) metas.push(toMeta(item));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  metas.sort((left, right) => left.name.localeCompare(right.name));
  return metas;
}

/** Remove a secret; true when it existed. */
export async function deleteSecret(
  client: DynamoDBDocumentClient,
  name: string,
  actorId: string,
): Promise<boolean> {
  const existing = await client.send(new GetCommand({
    TableName: TABLE_SECRETS,
    Key: secretKey(name),
    ProjectionExpression: 'PK',
  }));
  if (!existing.Item) return false;
  await client.send(new DeleteCommand({ TableName: TABLE_SECRETS, Key: secretKey(name) }));
  await recordSecretAccess(client, { action: 'delete', actorId, secretName: name });
  return true;
}

/**
 * One audit row per store access in the shared audit-events table: who, when,
 * which secret, which action, and — for writes — which field names. Values
 * are never passed here and never leave the ciphertext.
 */
export async function recordSecretAccess(
  client: DynamoDBDocumentClient,
  event: { action: SecretAccessAction; actorId: string; secretName?: string; fields?: string[] },
): Promise<void> {
  const at = new Date().toISOString();
  const partition = event.secretName ? `AUDIT#SECRET#${event.secretName}` : 'AUDIT#SECRETS';
  await client.send(new PutCommand({
    TableName: TABLE_AUDIT_EVENTS,
    Item: {
      PK: partition,
      SK: `${at}#${randomUUID()}`,
      action: event.action,
      actorId: event.actorId,
      ...(event.secretName ? { secretName: event.secretName } : {}),
      ...(event.fields ? { fields: event.fields } : {}),
      createdAt: at,
      expiresAt: Math.floor(Date.now() / 1000) + AUDIT_TTL_DAYS * 86400,
    },
  }));
}

/** Access history for one secret, newest first. */
export async function listSecretAccess(
  client: DynamoDBDocumentClient,
  name: string,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: TABLE_AUDIT_EVENTS,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': `AUDIT#SECRET#${name}` },
      ScanIndexForward: false,
      ExclusiveStartKey: startKey,
    }));
    for (const item of page.Items || []) {
      events.push({
        action: item.action,
        actorId: item.actorId,
        secretName: item.secretName,
        ...(item.fields ? { fields: item.fields } : {}),
        at: item.createdAt,
      });
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return events;
}

