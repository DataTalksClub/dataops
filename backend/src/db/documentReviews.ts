import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from './tableNames';
import { collectBoundedPages } from './boundedPagination';

export class DocumentReviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface ReviewAuthor { id: string; name: string; kind: 'staff' | 'reviewer' }
export interface ReviewPost { id: string; body: string; author: ReviewAuthor; createdAt: string }
export interface ReviewThread {
  id: string; documentId: string; quote: string; posts: ReviewPost[];
  resolved: boolean; resolvedBy: ReviewAuthor | null; updatedAt: string; version: number;
}
export interface DocumentReviewer { id: string; name: string; createdAt: string; expiresAt: string }
const partition = (id: string) => `DOCUMENT_REVIEW#${id}`;
const hash = (token: string) => createHash('sha256').update(token).digest();
const clean = <T>(item: Record<string, unknown>): T => {
  const { PK, SK, tokenHash, ...value } = item;
  return value as T;
};
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new DocumentReviewError(`${label} must contain 1–${max} characters`);
  }
  return value.trim();
}
async function list<T>(client: DynamoDBDocumentClient, documentId: string, prefix: string): Promise<T[]> {
  const rows = await collectBoundedPages<Record<string, unknown>>({
    loadPage: async (ExclusiveStartKey) => client.send(new QueryCommand({
      TableName: TABLE_ARTIFACTS, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': partition(documentId), ':prefix': prefix },
      ConsistentRead: true, ExclusiveStartKey,
    })),
  });
  return rows.map(row => clean<T>(row));
}
export async function createDocumentReviewer(client: DynamoDBDocumentClient, documentId: string, name: unknown) {
  const reviewer: DocumentReviewer = {
    id: randomUUID(), name: text(name, 'Reviewer name', 120), createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const token = `${reviewer.id}.${randomBytes(32).toString('base64url')}`;
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: {
    PK: partition(documentId), SK: `REVIEWER#${reviewer.id}`, ...reviewer, tokenHash: hash(token).toString('hex'),
  }, ConditionExpression: 'attribute_not_exists(PK)' }));
  return { reviewer, token };
}
export const listDocumentReviewers = (client: DynamoDBDocumentClient, id: string) => list<DocumentReviewer>(client, id, 'REVIEWER#');
export async function revokeDocumentReviewer(client: DynamoDBDocumentClient, documentId: string, reviewerId: string) {
  await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS, Key: { PK: partition(documentId), SK: `REVIEWER#${reviewerId}` } }));
}
export async function verifyDocumentReviewer(client: DynamoDBDocumentClient, documentId: string, token: string): Promise<ReviewAuthor | null> {
  if (!/^[\da-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { Item } = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS,
    Key: { PK: partition(documentId), SK: `REVIEWER#${token.split('.')[0]}` }, ConsistentRead: true }));
  if (!Item || typeof Item.tokenHash !== 'string' || Item.tokenHash.length !== 64) return null;
  const expires = Date.parse(Item.expiresAt);
  if (!timingSafeEqual(hash(token), Buffer.from(Item.tokenHash, 'hex')) || !Number.isFinite(expires) || expires <= Date.now()) return null;
  return { id: Item.id, name: Item.name, kind: 'reviewer' };
}
export const listDocumentThreads = (client: DynamoDBDocumentClient, id: string) => list<ReviewThread>(client, id, 'THREAD#');
export async function createDocumentThread(client: DynamoDBDocumentClient, documentId: string, author: ReviewAuthor, body: unknown, quote: unknown = '') {
  if (typeof quote !== 'string' || quote.length > 1000) throw new DocumentReviewError('Quote must be at most 1000 characters');
  const now = new Date().toISOString();
  const thread: ReviewThread = { id: randomUUID(), documentId, quote, posts: [{ id: randomUUID(), body: text(body, 'Comment', 2000), author, createdAt: now }], resolved: false, resolvedBy: null, updatedAt: now, version: 1 };
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: partition(documentId), SK: `THREAD#${thread.id}`, ...thread }, ConditionExpression: 'attribute_not_exists(PK)' }));
  return thread;
}
export async function changeDocumentThread(client: DynamoDBDocumentClient, documentId: string, threadId: string, author: ReviewAuthor, change: { body?: unknown; resolved?: boolean; version: unknown }) {
  if (!Number.isSafeInteger(change.version) || Number(change.version) < 1) throw new DocumentReviewError('Thread version is required');
  const Key = { PK: partition(documentId), SK: `THREAD#${threadId}` };
  const { Item } = await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key, ConsistentRead: true }));
  if (!Item) throw new DocumentReviewError('Thread not found', 404);
  const thread = clean<ReviewThread>(Item);
  if (thread.version !== change.version) throw new DocumentReviewError('Thread changed; refresh and retry', 409);
  if (change.body !== undefined) {
    if (thread.resolved) throw new DocumentReviewError('Reopen the thread before replying', 409);
    if (thread.posts.length >= 100) throw new DocumentReviewError('Thread has reached 100 posts; start a new thread');
    thread.posts.push({ id: randomUUID(), body: text(change.body, 'Reply', 2000), author, createdAt: new Date().toISOString() });
  } else if (typeof change.resolved === 'boolean') {
    thread.resolved = change.resolved;
    thread.resolvedBy = change.resolved ? author : null;
  } else throw new DocumentReviewError('Reply body or resolved status is required');
  thread.updatedAt = new Date().toISOString();
  thread.version += 1;
  if (Buffer.byteLength(JSON.stringify(thread), 'utf8') > 300000) throw new DocumentReviewError('Thread is full; start a new thread');
  try {
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...Key, ...thread }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': change.version } }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new DocumentReviewError('Thread changed; refresh and retry', 409);
    throw error;
  }
  return thread;
}

/** Staff cleanup uses a version condition so a new reply cannot be silently removed. */
export async function deleteDocumentThread(client: DynamoDBDocumentClient, documentId: string, threadId: string, version: unknown): Promise<void> {
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new DocumentReviewError('Thread version is required');
  try {
    await client.send(new DeleteCommand({ TableName: TABLE_ARTIFACTS,
      Key: { PK: partition(documentId), SK: `THREAD#${threadId}` },
      ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': version },
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new DocumentReviewError('Thread changed or is missing; refresh and retry', 409);
    throw error;
  }
}
