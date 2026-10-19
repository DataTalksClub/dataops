/**
 * Persistence for VIES check results, one record per normalized VAT ID in
 * the sponsor CRM table. A record answers "what did VIES last say about
 * this exact VAT ID, and when"; callers decide freshness by comparing the
 * checked `vatId` with the value they are about to use.
 */

import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { normalizeVatId } from './format';

export const VIES_CHECK_KIND = 'vies-check';
const PREFIX = 'VIES-CHECK#';

export type ViesCheckStatus = 'valid' | 'invalid' | 'not-found' | 'unavailable';

/** One recorded VIES outcome. Format-level failures never persist. */
export type ViesCheckDraft = Omit<ViesCheck, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type ViesCheck = {
  id: string;
  recordType: 'vies-check';
  vatId: string;
  country: string;
  number: string;
  status: ViesCheckStatus;
  source: 'vies';
  name?: string;
  address?: string;
  responseDate?: string;
  error?: string;
  checkedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const key = (vatId: string) => ({ PK: `${PREFIX}${vatId}`, SK: `${PREFIX}${vatId}` });
const clean = (item?: Record<string, unknown>): ViesCheck | null => {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...record } = item;
  return record as unknown as ViesCheck;
};

export async function getViesCheck(client: DynamoDBDocumentClient, vatId: string): Promise<ViesCheck | null> {
  return clean((await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: key(normalizeVatId(vatId)) }))).Item);
}

export async function putViesCheck(client: DynamoDBDocumentClient, draft: ViesCheckDraft): Promise<ViesCheck> {
  const check = draft as ViesCheck;
  const existing = await getViesCheck(client, check.vatId);
  const now = new Date().toISOString();
  const stored: ViesCheck = {
    ...check,
    id: normalizeVatId(check.vatId),
    version: (existing?.version || 0) + 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { ...stored, ...key(stored.id) } }));
  return stored;
}

export async function listViesChecks(client: DynamoDBDocumentClient): Promise<ViesCheck[]> {
  const items: ViesCheck[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': PREFIX },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) {
      const record = clean(item);
      if (record) items.push(record);
    }
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return items;
}
