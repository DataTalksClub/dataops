import { requireEventBytes } from './size';
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { transactWrite } from '../db/transactWrite';
import { TABLE_CALENDAR, TABLE_CARDS } from '../db/tableNames';
import type { Card } from '../types';
import { EventConflictError, type EventRecord, type EventOperation, type EventHistoryEntry } from './lifecycle';

const eventKey = (id: string) => ({ PK: `CALHOLD#${id}`, SK: `CALHOLD#${id}` });
const logKey = (id: string, key: string) => ({ PK: `CALEVENTLOG#${id}`, SK: `OP#${key}` });
const cardKey = (id: string) => ({ PK: `CARD#${id}`, SK: `CARD#${id}` });
type TransactionItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

/** Journals have separate rows: repeated rescheduling cannot fill the authority's 400KB item. */
export async function getEventRecord(client: DynamoDBDocumentClient, id: string, retryKey?: string): Promise<EventRecord | null> {
  const response = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: eventKey(id), ConsistentRead: true }));
  if (!response.Item) return null;
  const { PK, SK, latestOperationKey, ...record } = response.Item;
  if (!Number.isInteger(record.generation) || !Number.isInteger(record.identityGeneration) || !record.policy || !record.cardId || !latestOperationKey) {
    throw new EventConflictError('Event authority must be migrated offline before lifecycle writes');
  }
  const operations: EventOperation[] = [];
  for (const key of new Set([String(latestOperationKey), ...(retryKey ? [retryKey] : [])])) {
    const op = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: logKey(id, key), ConsistentRead: true }));
    if (!op.Item) {
      if (key === latestOperationKey) throw new Error('Event operation journal is missing');
      continue;
    }
    operations.push(op.Item.operation as EventOperation);
  }
  return { ...record, operations, history: [], previousGoogleEventIds: [] } as unknown as EventRecord;
}

/** The Card's own attendee-free Luma entries (`card:<cardId>`): the public DTC events entry and its silent personal copies. */
export interface EventListing {
  eventKey: string;
  googleEventIds: Record<string, string>;
}

/**
 * The listing an event leaves beside its invitation when it takes the Card's
 * `eventTime`. A Card that only holds its own `card:<cardId>` entries — a
 * silent Luma listing, or a plain time with no Google event — hands the slot
 * to the event; those entries stay live and keep their ids in
 * `eventTime.listing`, never in the event's `googleEventIds` (that would put
 * Zoom and guests on the public calendar).
 */
export function listingBesideEvent(card: Card, eventId: string): EventListing | undefined {
  const time = card.eventTime;
  if (!time) return undefined;
  if (time.eventKey === eventId) return time.listing;
  if (time.eventKey !== `card:${card.id}`) {
    throw new EventConflictError(`Card '${card.id}' is linked to calendar event '${time.eventKey}'. Run this event command on '${time.eventKey}' instead.`);
  }
  if (time.sync === 'syncing' && Date.now() - Date.parse(time.syncStartedAt) < 180000) {
    throw new EventConflictError(`The calendar entries of Card '${card.id}' are syncing; retry shortly.`);
  }
  const listing = time.listing || { eventKey: time.eventKey, googleEventIds: time.googleEventIds };
  return Object.keys(listing.googleEventIds).length ? listing : undefined;
}

function projectedTime(event: EventRecord, sync: 'syncing' | 'synced', at: string, listing?: EventListing) {
  return {
    eventKey: event.id, generation: event.generation, status: event.status,
    startIso: event.startIso, endIso: event.endIso, timeZone: event.timeZone,
    durationMinutes: event.durationMinutes, googleEventIds: event.googleEventIds,
    sync, syncStartedAt: at,
    ...(listing ? { listing } : {}),
  };
}

function isConditionalConflict(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionCanceledException'
    && Boolean(e.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed'));
}

/** One transaction creates the authority, operation/history and Card datetime projection.
 * Related record projections join this same transaction; callers supply only server-authored writes.
 */
export async function commitEventTransition(
  client: DynamoDBDocumentClient, card: Card, expectedVersion: number, next: EventRecord,
  relatedWrites: TransactionItems = [],
): Promise<void> {
  const operation = next.operations.at(-1);
  const history = next.history.at(-1);
  if (next.cardId !== card.id || next.version !== expectedVersion + 1 || !operation || !history
    || operation.state !== 'pending' || operation.key !== history.operationKey) throw new Error('Invalid event transition commit');
  const { operations, history: entries, previousGoogleEventIds, ...authority } = next;
  const listing = listingBesideEvent(card, next.id);
  const transaction: TransactionItems = [
    { Put: {
      TableName: TABLE_CALENDAR, Item: { ...eventKey(next.id), ...authority, latestOperationKey: operation.key },
      ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#version = :expected',
      ...(expectedVersion ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expectedVersion } } : {}),
    } },
    { Update: {
      TableName: TABLE_CARDS, Key: cardKey(card.id),
      UpdateExpression: operation.transition === 'update'
        ? 'SET #title = :title, anchorDate = :date, eventTime = :time, updatedAt = :at ADD #version :one'
        : 'SET anchorDate = :date, eventTime = :time, updatedAt = :at ADD #version :one',
      // The slot is free, already this event's, or the Card's own `card:<id>` entries (kept as the listing).
      ConditionExpression: '#version = :expected AND (attribute_not_exists(eventTime.eventKey) OR eventTime.eventKey IN (:event, :listing))',
      ExpressionAttributeNames: {
        '#version': 'version',
        ...(operation.transition === 'update' ? { '#title': 'title' } : {}),
      },
      ExpressionAttributeValues: {
        ...(operation.transition === 'update' ? { ':title': next.renderValues.title } : {}),
        ':date': next.date,
        ':time': projectedTime(next, 'syncing', history.at, listing),
        ':at': history.at,
        ':one': 1,
        ':expected': card.version,
        ':event': next.id,
        ':listing': `card:${card.id}`,
      },
    } },
    { Put: { TableName: TABLE_CALENDAR, Item: { ...logKey(next.id, operation.key), operation, generation: next.generation, previousGoogleEventIds }, ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { TableName: TABLE_CALENDAR, Item: {
      PK: `CALEVENTLOG#${next.id}`, SK: `HISTORY#${String(next.version).padStart(16, '0')}`, entry: history,
    }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ...relatedWrites,
  ];
  for (const item of transaction) {
    if (item.Put) requireEventBytes(item.Put.Item, 300 * 1024, 'Event journal or authority item');
  }
  requireEventBytes(transaction, 1024 * 1024, 'Event transaction');
  try {
    await transactWrite(
      client,
      transaction,
      createHash('sha256').update(JSON.stringify(transaction)).digest('hex').slice(0, 36),
    );
  } catch (error) {
    if (isConditionalConflict(error)) throw new EventConflictError(`Card '${card.id}' or event '${next.id}' changed while the ${operation.transition} was prepared; reload and retry`);
    throw error;
  }
}

/** Exclusive, expiring worker claim. Outcome-unknown effects require explicit reconciliation. */
export async function claimEventOperation(client: DynamoDBDocumentClient, id: string, key: string, now: string, leaseSeconds = 120): Promise<string | null> {
  if (!Number.isFinite(Date.parse(now)) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) throw new Error('Invalid event worker lease');
  const token = randomUUID();
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_CALENDAR, Key: logKey(id, key),
      UpdateExpression: 'SET leaseToken = :token, leaseUntil = :until',
      ConditionExpression: 'operation.#state = :pending AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':pending': 'pending', ':token': token, ':until': new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(), ':now': new Date(now).toISOString() },
    }));
    return token;
  } catch (error) { if (isConditionalConflict(error)) return null; throw error; }
}

/** Commit reconciled external IDs and unlock the generation without overwriting unrelated Card edits. */
export async function completeEventOperation(
  client: DynamoDBDocumentClient, current: EventRecord, operationKey: string, leaseToken: string,
  googleEventIds: Record<string, string>, now: string,
): Promise<void> {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error('A canonical operation timestamp is required');
  const op = current.operations.find(entry => entry.key === operationKey);
  async function alreadyComplete(): Promise<boolean> {
    const saved = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: logKey(current.id, operationKey), ConsistentRead: true }));
    const operation = saved.Item?.operation as EventOperation | undefined;
    const sorted = (ids: Record<string, string>) => JSON.stringify(Object.entries(ids).sort(([a], [b]) => a.localeCompare(b)));
    return operation?.state === 'complete' && operation.fingerprint === op?.fingerprint
      && Boolean(operation.result) && sorted(operation.result!.googleEventIds) === sorted(googleEventIds);
  }
  if (!op || op.state !== 'pending') {
    if (op && await alreadyComplete()) return;
    throw new EventConflictError('Event operation is not pending');
  }
  requireEventBytes(googleEventIds, 16 * 1024, 'Google event identities');
  try {
    await transactWrite(client, [
      { Update: {
        TableName: TABLE_CALENDAR, Key: eventKey(current.id),
        UpdateExpression: 'SET googleEventIds = :ids ADD #version :one',
        ConditionExpression: '#version = :expected AND latestOperationKey = :key',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':ids': googleEventIds, ':one': 1, ':expected': current.version, ':key': operationKey },
      } },
      { Update: {
        TableName: TABLE_CALENDAR, Key: logKey(current.id, operationKey),
        UpdateExpression: 'SET operation.#state = :complete, operation.#result = :result, completedAt = :now REMOVE leaseToken, leaseUntil',
        ConditionExpression: 'leaseToken = :token AND leaseUntil > :now AND operation.#state = :pending',
        ExpressionAttributeNames: { '#state': 'state', '#result': 'result' },
        ExpressionAttributeValues: { ':result': { googleEventIds }, ':complete': 'complete', ':pending': 'pending', ':token': leaseToken, ':now': now },
      } },
      { Update: {
        TableName: TABLE_CARDS, Key: cardKey(current.cardId),
        // Only the synced fields change, so the rest of eventTime — the listing beside the invitation — is left as written.
        UpdateExpression: 'SET eventTime.googleEventIds = :ids, eventTime.#sync = :synced, eventTime.syncStartedAt = :now, updatedAt = :now REMOVE eventTime.reason ADD #version :one',
        ConditionExpression: 'eventTime.eventKey = :event AND eventTime.generation = :generation',
        ExpressionAttributeNames: { '#version': 'version', '#sync': 'sync' },
        ExpressionAttributeValues: { ':ids': googleEventIds, ':synced': 'synced', ':now': now, ':one': 1, ':event': current.id, ':generation': current.generation },
      } },
    ]);
  } catch (error) {
    if (isConditionalConflict(error)) {
      if (await alreadyComplete()) return;
      throw new EventConflictError('Event worker lease or generation changed');
    }
    throw error;
  }
}

export async function getEventHistory(client: DynamoDBDocumentClient, id: string): Promise<EventHistoryEntry[]> {
  const history: EventHistoryEntry[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({
      TableName: TABLE_CALENDAR, ConsistentRead: true,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `CALEVENTLOG#${id}`, ':prefix': 'HISTORY#' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    history.push(...(page.Items || []).map(item => item.entry as EventHistoryEntry));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return history;
}
