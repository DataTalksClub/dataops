import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import type { GuestIntakePolicy } from './guestIntakePolicy';
export type GuestIntakeStatus = 'queued' | 'preparing' | 'sent' | 'skipped' | 'failed' | 'contact-pending';
export interface GuestIntakeJob {
  id: string; cardId: string; taskId: string; actorId: string; type: string;
  creationKey: string; fingerprint: string; status: GuestIntakeStatus;
  guestEmail?: string; guestName?: string; topic?: string; skipEmail: boolean;
  requestedDate?: string; requestedTime?: string; timeZone?: string; guestTimezone?: string; requestedWindow?: string; policy?: GuestIntakePolicy;
  holdId?: string; docId?: string; selectedDate?: string; selectedTime?: string; selectedWindow?: string;
  messageId?: string; sentAt?: string; startIso?: string; error?: string; retryable?: boolean; leaseUntil?: number;
  createdAt: string; updatedAt: string;
}
export const guestIntakeKey = (id: string) => ({ PK: `GUESTINTAKE#${id}`, SK: `GUESTINTAKE#${id}` });
export async function getGuestIntakeJob(db: DynamoDBDocumentClient, id: string): Promise<GuestIntakeJob | null> {
  const r = await db.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(id), ConsistentRead: true }));
  if (!r.Item) return null;
  const { PK, SK, ...job } = r.Item;
  return job as GuestIntakeJob;
}
export async function saveGuestIntakeJob(db: DynamoDBDocumentClient, job: GuestIntakeJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...guestIntakeKey(job.id), ...job }, ...(job.leaseUntil ? { ConditionExpression: 'leaseUntil = :lease', ExpressionAttributeValues: { ':lease': job.leaseUntil } } : {}) }));
}
export async function claimGuestIntakeJob(db: DynamoDBDocumentClient, job: GuestIntakeJob): Promise<boolean> {
  const now = Date.now();
  try {
    await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(job.id),
      UpdateExpression: 'SET leaseUntil = :lease', ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND #s <> :sent AND #s <> :skipped', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':lease': now + 150000, ':now': now, ':sent': 'sent', ':skipped': 'skipped' } }));
    job.leaseUntil = now + 150000;
    return true;
  } catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return false; throw e; }
}

export async function listResumableGuestIntakes(db: DynamoDBDocumentClient): Promise<GuestIntakeJob[]> {
  const jobs: GuestIntakeJob[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new ScanCommand({ TableName: TABLE_ARTIFACTS, ConsistentRead: true,
      FilterExpression: 'begins_with(PK, :prefix)', ExpressionAttributeValues: { ':prefix': 'GUESTINTAKE#' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    for (const item of page.Items || []) if (['queued', 'preparing', 'failed'].includes(item.status) && item.retryable !== false && (!item.leaseUntil || item.leaseUntil < Date.now())) {
      const { PK, SK, ...job } = item; jobs.push(job as GuestIntakeJob);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return jobs;
}
export async function releaseGuestIntakeLease(db: DynamoDBDocumentClient, job: GuestIntakeJob) {
  if (!job.leaseUntil) return;
  await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(job.id), UpdateExpression: 'SET leaseUntil = :zero',
    ConditionExpression: 'leaseUntil = :lease', ExpressionAttributeValues: { ':lease': job.leaseUntil, ':zero': 0 } }));
  job.leaseUntil = 0;
}
