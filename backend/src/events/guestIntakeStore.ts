import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import type { GuestIntakePolicy } from './guestIntakePolicy';
export type GuestIntakeStatus = 'queued' | 'preparing' | 'sent' | 'skipped' | 'failed' | 'contact-pending' | 'paused' | 'cancelled';
export interface GuestIntakeJob {
  id: string; cardId: string; taskId: string; actorId: string; type: string;
  creationKey: string; fingerprint: string; status: GuestIntakeStatus;
  guestEmail?: string; guestName?: string; topic?: string; skipEmail: boolean;
  agreedFrom?: string; agreedTo?: string;
  requestedDate?: string; requestedTime?: string; timeZone?: string; guestTimezone?: string; requestedWindow?: string; policy?: GuestIntakePolicy;
  holdId?: string; docId?: string; selectedDate?: string; selectedTime?: string; selectedWindow?: string;
  messageId?: string; sentAt?: string; startIso?: string; error?: string; lastReportedError?: string; retryable?: boolean; leaseUntil?: number;
  /** Set when only the [Proposed] calendar invitation was sent after --skip-email; blocks the first-contact email. */
  calendarOnly?: { sentAt: string; operationKey: string; guests: string[]; actor: string };
  createdAt: string; updatedAt: string;
}
export const guestIntakeKey = (id: string) => ({ PK: `GUESTINTAKE#${id}`, SK: `GUESTINTAKE#${id}` });
/**
 * Sparse GSI on the artifacts table. A row carries `pendingKind` only while a
 * scheduled backstop may still have work for it, so the backstops Query a
 * handful of pending rows instead of scanning every artifact (documents are
 * stored inline and make a full Scan expensive).
 */
export const PENDING_INDEX = 'GSI-Pending';
export type PendingKind = 'guest-intake' | 'guest-choice';
const RESUMABLE_STATUSES: readonly string[] = ['queued', 'preparing', 'failed', 'paused'];
export const isGuestIntakePending = (job: Pick<GuestIntakeJob, 'status' | 'retryable'>) =>
  RESUMABLE_STATUSES.includes(job.status) && job.retryable !== false;
/** The stored row for a job: every writer goes through this so `pendingKind` always matches the status. */
export function guestIntakeItem(job: GuestIntakeJob): Record<string, unknown> {
  const { pendingKind: _stale, PK: _pk, SK: _sk, ...rest } = job as GuestIntakeJob & { pendingKind?: string; PK?: string; SK?: string };
  return { ...guestIntakeKey(job.id), ...rest, ...(isGuestIntakePending(job) ? { pendingKind: 'guest-intake' satisfies PendingKind } : {}) };
}
/** All rows currently in the sparse pending index for one kind. Eventually consistent: every caller re-claims the row with a conditional write before acting. */
export async function listPendingArtifacts(db: DynamoDBDocumentClient, kind: PendingKind): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new QueryCommand({ TableName: TABLE_ARTIFACTS, IndexName: PENDING_INDEX,
      KeyConditionExpression: 'pendingKind = :kind', ExpressionAttributeValues: { ':kind': kind },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    items.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}
export async function getGuestIntakeJob(db: DynamoDBDocumentClient, id: string): Promise<GuestIntakeJob | null> {
  const r = await db.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(id), ConsistentRead: true }));
  if (!r.Item) return null;
  const { PK, SK, pendingKind, ...job } = r.Item;
  return job as GuestIntakeJob;
}
export async function saveGuestIntakeJob(db: DynamoDBDocumentClient, job: GuestIntakeJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: guestIntakeItem(job), ...(job.leaseUntil ? { ConditionExpression: 'leaseUntil = :lease', ExpressionAttributeValues: { ':lease': job.leaseUntil } } : {}) }));
}
export async function claimGuestIntakeJob(db: DynamoDBDocumentClient, job: GuestIntakeJob): Promise<boolean> {
  const now = Date.now();
  try {
    await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(job.id),
      UpdateExpression: 'SET leaseUntil = :lease', ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND (#s = :queued OR #s = :preparing OR #s = :failed OR #s = :paused)', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':lease': now + 150000, ':now': now, ':queued': 'queued', ':preparing': 'preparing', ':failed': 'failed', ':paused': 'paused' } }));
    job.leaseUntil = now + 150000;
    return true;
  } catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return false; throw e; }
}

export async function listResumableGuestIntakes(db: DynamoDBDocumentClient): Promise<GuestIntakeJob[]> {
  const now = Date.now();
  return (await listPendingArtifacts(db, 'guest-intake'))
    // The index can lag a write by a moment; re-check status and lease. processGuestIntake re-reads consistently and claims conditionally.
    .filter(item => isGuestIntakePending(item as GuestIntakeJob) && (!item.leaseUntil || item.leaseUntil < now))
    .map(({ PK, SK, pendingKind, ...job }) => job as GuestIntakeJob);
}
export async function releaseGuestIntakeLease(db: DynamoDBDocumentClient, job: GuestIntakeJob) {
  if (!job.leaseUntil) return;
  await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: guestIntakeKey(job.id), UpdateExpression: 'SET leaseUntil = :zero',
    ConditionExpression: 'leaseUntil = :lease', ExpressionAttributeValues: { ':lease': job.leaseUntil, ':zero': 0 } }));
  job.leaseUntil = 0;
}
