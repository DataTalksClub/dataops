import { createHash, randomBytes, randomUUID } from 'crypto';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SESSIONS, TABLE_SPONSOR_CRM } from './tableNames';
import { transact, scanCrmPrefix } from './sponsorCrm';

const key = (kind: string, id: string) => kind.toUpperCase() + '#' + id;
const compact = (record: Record<string, any>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
const clean = (item?: Record<string, any>): Record<string, any> | null => {
  if (!item) return null;
  const copy = { ...item };
  delete copy.PK; delete copy.SK;
  return copy;
};

export const contractStored = (record: Record<string, unknown>) => ({ PK: key('contract', String(record.id)), SK: key('contract', String(record.id)), ...compact(record) });
export const contractHistoryPut = (contractId: string, event: Record<string, unknown>) => {
  const createdAt = new Date().toISOString();
  const id = createdAt + '#' + randomUUID();
  return { Put: { TableName: TABLE_SPONSOR_CRM, Item: compact(Object.assign({ PK: key('contract-history', contractId), SK: id }, event, { id, createdAt })), ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' } };
};

export async function createContract(client: DynamoDBDocumentClient, value: Record<string, unknown>, actorId: string) {
  const now = new Date().toISOString();
  const item = Object.assign({}, compact(value), { id: randomUUID(), version: 1, createdAt: now, updatedAt: now });
  await transact(client, [
    { Put: { TableName: TABLE_SPONSOR_CRM, Item: contractStored(item), ConditionExpression: 'attribute_not_exists(PK)' } },
    contractHistoryPut(item.id, { actorId, entityKind: 'contract', entityId: item.id, action: 'created', detail: 'Contract created from deal ' + item.dealId }),
  ]);
  return item;
}

export async function getContract(client: DynamoDBDocumentClient, id: string) {
  const result = await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: key('contract', id), SK: key('contract', id) } }));
  return clean(result.Item);
}

export async function listContracts(client: DynamoDBDocumentClient, dealId?: string) {
  const items = (await scanCrmPrefix(client, 'CONTRACT#')).map((item) => clean(item)).filter((item): item is Record<string, any> => Boolean(item));
  const filtered = dealId ? items.filter((item) => item.dealId === dealId) : items;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}

export async function updateContract(client: DynamoDBDocumentClient, existing: Record<string, any>, changes: Record<string, unknown>, audit?: Record<string, unknown>) {
  const now = new Date().toISOString();
  const next = Object.assign({}, existing, changes, { id: existing.id, createdAt: existing.createdAt, updatedAt: now, version: existing.version + 1 });
  const items: any[] = [{ Put: { TableName: TABLE_SPONSOR_CRM, Item: contractStored(next), ConditionExpression: 'version = :version', ExpressionAttributeValues: { ':version': existing.version } } }];
  if (audit) items.push(contractHistoryPut(existing.id, audit));
  await transact(client, items);
  return next;
}

export async function appendContractAudit(client: DynamoDBDocumentClient, contractId: string, event: Record<string, unknown>): Promise<void> {
  await client.send(new PutCommand(contractHistoryPut(contractId, event).Put));
}

export async function listContractAudit(client: DynamoDBDocumentClient, contractId: string) {
  const result = await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM, FilterExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': key('contract-history', contractId) } }));
  return (result.Items || []).map(({ PK, SK, ...item }: any) => item).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** A deal has a signed contract only when one of its contracts reached status signed. */
export async function dealHasSignedContract(client: DynamoDBDocumentClient, dealId: string) {
  const contracts = await listContracts(client, dealId);
  return contracts.some((contract) => contract.status === 'signed');
}

const EMAIL_HASH_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validContractEmail = (value: unknown): value is string => typeof value === 'string' && EMAIL_HASH_PATTERN.test(value.trim());

export function newSigningToken(): string {
  return randomBytes(32).toString('base64url');
}

export function contractTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function ipHash(ip: string): string {
  return createHash('sha256').update(String(ip || 'unknown'), 'utf8').digest('hex').slice(0, 32);
}

const CONTRACT_RATE_MAX_FAILED = 10;
const CONTRACT_RATE_WINDOW_MS = 15 * 60000;

function contractRateKey(contractId: string, hashedIp: string) {
  const keyText = 'CONTRACT_RATE#' + contractId + '#' + hashedIp;
  return { PK: keyText, SK: keyText };
}

export interface ContractRateStatus { allowed: boolean; attempts: number; retryAfterSeconds: number }

export async function checkContractRateLimit(client: DynamoDBDocumentClient, contractId: string, hashedIp: string, now = new Date()): Promise<ContractRateStatus> {
  const result = await client.send(new GetCommand({ TableName: TABLE_SESSIONS, Key: contractRateKey(contractId, hashedIp), ConsistentRead: true }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) return { allowed: true, attempts: 0, retryAfterSeconds: 0 };
  const expiresMs = Date.parse(String(item.windowExpiresAt || ''));
  const attempts = Number(item.attempts || 0);
  if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) return { allowed: true, attempts: 0, retryAfterSeconds: 0 };
  if (attempts >= CONTRACT_RATE_MAX_FAILED) return { allowed: false, attempts, retryAfterSeconds: Math.max(1, Math.ceil((expiresMs - now.getTime()) / 1000)) };
  return { allowed: true, attempts, retryAfterSeconds: 0 };
}

export async function recordContractFailedAttempt(client: DynamoDBDocumentClient, contractId: string, hashedIp: string, now = new Date()): Promise<void> {
  const existing = await checkContractRateLimit(client, contractId, hashedIp, now);
  const windowExpiresAt = new Date(now.getTime() + CONTRACT_RATE_WINDOW_MS).toISOString();
  await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: Object.assign({}, contractRateKey(contractId, hashedIp), { attempts: existing.attempts + 1, windowExpiresAt }) }));
}
