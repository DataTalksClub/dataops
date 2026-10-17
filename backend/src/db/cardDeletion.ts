import { randomUUID } from 'node:crypto';

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { Card, Task } from '../types';
import { usesLocalTransactionEmulation } from './client';
import {
  CardNotFoundError,
  CardVersionConflictError,
  cardKey,
  getCardConsistent,
} from './cards';
import { listNewsletterIssuesByCardId } from './newsletterIssues';
import type { PlannedWrite } from './plannedWrite';
import {
  TABLE_ARTIFACTS,
  TABLE_AUDIT_EVENTS,
  TABLE_CARDS,
  TABLE_FILES,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SPONSOR_CRM,
  TABLE_TASKS,
} from './tableNames';
import { listTasksByCard } from './tasks';

/**
 * Admin Card deletion: one transaction deletes the Card and every Task it
 * contains, clears the soft links other rows hold to them, deletes the derived
 * notifications about them, and records an audit event.
 *
 * Rows that carry evidence of their own (uploaded files, sponsor
 * deliverables) are not silently rewritten: while any of them points
 * at the Card or its Tasks the deletion is refused and names them, so the
 * operator unlinks them deliberately first.
 *
 * A newsletter issue owns its Card: the Card exists only to execute that
 * issue, so it is deleted only together with the issue's own write (the issue
 * deleted, cancelled, or its Card removed), passed as `ownerWrite`. Deleting
 * it on its own is refused.
 */

type Dict = Record<string, unknown>;

interface CardDeletionUnlinked {
  artifacts: string[];
  intakeItems: string[];
  notifications: string[];
}

interface CardDeletionAuditEvent {
  id: string;
  action: 'card-deleted';
  actorId: string;
  cardId: string;
  title: string | null;
  cardVersion: number;
  taskCount: number;
  deletedTaskIds: string[];
  unlinked: CardDeletionUnlinked;
  createdAt: string;
}

interface CardDeletionResult {
  cardId: string;
  title: string | null;
  deletedTaskIds: string[];
  unlinked: CardDeletionUnlinked;
  auditEventId: string;
}

interface CardBlockingReferences {
  files: string[];
  sponsorDeliverables: string[];
  newsletterIssues: string[];
}

/** The owning record's write that rides in the Card deletion transaction. */
interface CardOwnerWrite {
  newsletterIssueId: string;
  write: PlannedWrite;
}

class CardDeletionBlockedError extends Error {
  constructor(readonly cardId: string, readonly references: CardBlockingReferences) {
    super(references.newsletterIssues.length
      ? 'Card belongs to a newsletter issue; delete or cancel the issue instead'
      : 'Card is still referenced by files or sponsor deliverables; unlink them first');
    this.name = 'CardDeletionBlockedError';
  }
}

class CardDeletionTooLargeError extends Error {
  constructor(readonly cardId: string, readonly itemCount: number) {
    super(`Deleting this Card needs ${itemCount} transaction items; the maximum is 100`);
    this.name = 'CardDeletionTooLargeError';
  }
}

class CardDeletionConflictError extends Error {
  constructor(readonly cardId: string) {
    super('Card Tasks or their linked rows changed during deletion; review and retry');
    this.name = 'CardDeletionConflictError';
  }
}

const MAX_SCAN_PAGES = 200;

async function scanAll(
  client: DynamoDBDocumentClient,
  tableName: string,
  prefix: string,
): Promise<Dict[]> {
  const items: Dict[] = [];
  let exclusiveStartKey: Dict | undefined;
  let pages = 0;
  do {
    const page = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': prefix },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...((page.Items || []) as Dict[]));
    exclusiveStartKey = page.LastEvaluatedKey as Dict | undefined;
    pages += 1;
    if (pages >= MAX_SCAN_PAGES && exclusiveStartKey) {
      throw new Error(`${tableName} scan exceeded its bounded page limit`);
    }
  } while (exclusiveStartKey);
  return items;
}

function rowKey(item: Dict): Dict {
  return { PK: item.PK, SK: item.SK };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A row whose `cardId`/`taskId` soft links point into the deleted Card. */
function linkClearWrite(tableName: string, row: Dict, cardId: string, taskIds: Set<string>): PlannedWrite {
  const clearCard = row.cardId === cardId;
  const clearTask = typeof row.taskId === 'string' && taskIds.has(row.taskId);
  const removed = [clearCard ? 'cardId' : null, clearTask ? 'taskId' : null].filter(Boolean) as string[];
  const names: Record<string, string> = {};
  const values: Dict = {};
  const conditions = ['attribute_exists(PK)'];
  removed.forEach((field, index) => {
    names[`#r${index}`] = field;
    values[`:r${index}`] = row[field];
    conditions.push(`#r${index} = :r${index}`);
  });
  return {
    tableName,
    key: rowKey(row),
    item: {
      Update: {
        TableName: tableName,
        Key: rowKey(row),
        UpdateExpression: `REMOVE ${removed.map((_, index) => `#r${index}`).join(', ')}`,
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
    holds: (current) => Boolean(current) && removed.every((field) => current![field] === row[field]),
    after: (current) => {
      const next = { ...current };
      for (const field of removed) delete next[field];
      return next;
    },
  };
}

/** Records that keep a Card from being deleted, other than its owner. */
async function cardBlockingReferences(
  client: DynamoDBDocumentClient,
  card: Card,
  tasks: Task[],
  owner?: Pick<CardOwnerWrite, 'newsletterIssueId'>,
): Promise<CardBlockingReferences> {
  const taskIds = new Set(tasks.map(({ id }) => id));
  const pointsHere = (row: Dict) => row.cardId === card.id
    || (typeof row.taskId === 'string' && taskIds.has(row.taskId));
  const [files, sponsorCrm, issues] = await Promise.all([
    scanAll(client, TABLE_FILES, 'FILE#'),
    scanAll(client, TABLE_SPONSOR_CRM, 'DELIVERABLE#'),
    listNewsletterIssuesByCardId(client, card.id),
  ]);
  return {
    files: files.filter(pointsHere).map((row) => String(row.id)),
    sponsorDeliverables: sponsorCrm.filter((row) => row.cardId === card.id).map((row) => String(row.id)),
    newsletterIssues: issues.map((issue) => issue.id).filter((id) => id !== owner?.newsletterIssueId),
  };
}

/** Artifacts linked to the Card or one of its Tasks. */
async function listCardArtifacts(client: DynamoDBDocumentClient, card: Card, tasks: Task[]): Promise<Dict[]> {
  const taskIds = new Set(tasks.map(({ id }) => id));
  return (await scanAll(client, TABLE_ARTIFACTS, 'ARTIFACT#'))
    .filter((row) => row.cardId === card.id || (typeof row.taskId === 'string' && taskIds.has(row.taskId)));
}

async function loadDeletionPlan(
  client: DynamoDBDocumentClient,
  card: Card,
  actorId: string,
  owner?: CardOwnerWrite,
) {
  const tasks: Task[] = await listTasksByCard(client, card.id);
  const taskIds = new Set(tasks.map(({ id }) => id));
  const pointsHere = (row: Dict) => row.cardId === card.id
    || (typeof row.taskId === 'string' && taskIds.has(row.taskId));

  const [blocking, artifacts, intake, notifications] = await Promise.all([
    cardBlockingReferences(client, card, tasks, owner),
    scanAll(client, TABLE_ARTIFACTS, 'ARTIFACT#'),
    scanAll(client, TABLE_INTAKE, 'INTAKE#'),
    scanAll(client, TABLE_NOTIFICATIONS, 'NOTIFICATION#'),
  ]);
  if (Object.values(blocking).some((ids) => ids.length > 0)) {
    throw new CardDeletionBlockedError(card.id, blocking);
  }

  const now = new Date().toISOString();
  const writes: PlannedWrite[] = [];
  const unlinked: CardDeletionUnlinked = {
    artifacts: [],
    intakeItems: [],
    notifications: [],
  };

  writes.push({
    tableName: TABLE_CARDS,
    key: cardKey(card.id),
    item: {
      Delete: {
        TableName: TABLE_CARDS,
        Key: cardKey(card.id),
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': card.version },
      },
    },
    holds: (current) => Boolean(current) && current!.version === card.version,
    after: () => null,
  });

  for (const task of tasks) {
    const key = { PK: `TASK#${task.id}`, SK: `TASK#${task.id}` };
    writes.push({
      tableName: TABLE_TASKS,
      key,
      item: {
        Delete: {
          TableName: TABLE_TASKS,
          Key: key,
          ConditionExpression: 'attribute_exists(PK) AND #version = :version AND cardId = :cardId',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': task.version, ':cardId': card.id },
        },
      },
      holds: (current) => Boolean(current) && current!.version === task.version && current!.cardId === card.id,
      after: () => null,
    });
  }

  if (owner) writes.push(owner.write);

  for (const row of artifacts.filter(pointsHere)) {
    unlinked.artifacts.push(String(row.id));
    writes.push(linkClearWrite(TABLE_ARTIFACTS, row, card.id, taskIds));
  }

  const sponsorDocs = await scanAll(client, TABLE_ARTIFACTS, `CARD_SPONSOR_DOCS#${card.id}`);
  for (const indexRow of sponsorDocs) {
    const docId = str(indexRow.id);
    if (docId) {
      const primaryKey = { PK: `SPONSOR_DOC#${docId}`, SK: `SPONSOR_DOC#${docId}` };
      writes.push({
        tableName: TABLE_ARTIFACTS,
        key: primaryKey,
        item: { Delete: { TableName: TABLE_ARTIFACTS, Key: primaryKey } },
        holds: () => true,
        after: () => null,
      });
    }
    writes.push({
      tableName: TABLE_ARTIFACTS,
      key: rowKey(indexRow),
      item: { Delete: { TableName: TABLE_ARTIFACTS, Key: rowKey(indexRow) } },
      holds: () => true,
      after: () => null,
    });
  }

  for (const row of intake) {
    const cardIds = Array.isArray(row.cardIds) ? row.cardIds as string[] : [];
    const intakeTaskIds = Array.isArray(row.taskIds) ? row.taskIds as string[] : [];
    const nextCardIds = cardIds.filter((id) => id !== card.id);
    const nextTaskIds = intakeTaskIds.filter((id) => !taskIds.has(id));
    if (nextCardIds.length === cardIds.length && nextTaskIds.length === intakeTaskIds.length) continue;
    unlinked.intakeItems.push(String(row.id));
    const seenUpdatedAt = str(row.updatedAt);
    writes.push({
      tableName: TABLE_INTAKE,
      key: rowKey(row),
      item: {
        Update: {
          TableName: TABLE_INTAKE,
          Key: rowKey(row),
          UpdateExpression: 'SET cardIds = :cardIds, taskIds = :taskIds, updatedAt = :now',
          ConditionExpression: seenUpdatedAt
            ? 'updatedAt = :seenUpdatedAt'
            : 'attribute_exists(PK) AND attribute_not_exists(updatedAt)',
          ExpressionAttributeValues: {
            ':cardIds': nextCardIds,
            ':taskIds': nextTaskIds,
            ':now': now,
            ...(seenUpdatedAt ? { ':seenUpdatedAt': seenUpdatedAt } : {}),
          },
        },
      },
      holds: (current) => Boolean(current) && (str(current!.updatedAt) === seenUpdatedAt),
      after: (current) => ({ ...current, cardIds: nextCardIds, taskIds: nextTaskIds, updatedAt: now }),
    });
  }

  for (const row of notifications.filter(pointsHere)) {
    unlinked.notifications.push(String(row.id));
    writes.push({
      tableName: TABLE_NOTIFICATIONS,
      key: rowKey(row),
      item: {
        Delete: {
          TableName: TABLE_NOTIFICATIONS,
          Key: rowKey(row),
        },
      },
      holds: () => true,
      after: () => null,
    });
  }

  const auditEvent: CardDeletionAuditEvent = {
    id: randomUUID(),
    action: 'card-deleted',
    actorId,
    cardId: card.id,
    title: str(card.title),
    cardVersion: card.version,
    taskCount: tasks.length,
    deletedTaskIds: tasks.map(({ id }) => id),
    unlinked,
    createdAt: now,
  };
  const auditKey = { PK: `AUDIT_EVENT#${auditEvent.id}`, SK: `AUDIT_EVENT#${auditEvent.id}` };
  writes.push({
    tableName: TABLE_AUDIT_EVENTS,
    key: auditKey,
    item: {
      Put: {
        TableName: TABLE_AUDIT_EVENTS,
        Item: { ...auditKey, ...auditEvent },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    holds: (current) => !current,
    after: () => ({ ...auditKey, ...auditEvent }),
  });

  return { writes, auditEvent, unlinked };
}

let testTransactionTail: Promise<void> = Promise.resolve();

/**
 * Dynalite has no TransactWriteItems. Apply the planned writes in order with
 * the same conditions, restoring every touched row if any condition or write
 * fails, serialized like the other local transaction emulators.
 */
async function emulateTransaction(client: DynamoDBDocumentClient, writes: PlannedWrite[]): Promise<void> {
  const previous = testTransactionTail;
  let release!: () => void;
  testTransactionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const snapshots: Array<{ write: PlannedWrite; current: Dict | undefined }> = [];
    for (const write of writes) {
      const current = (await client.send(new GetCommand({
        TableName: write.tableName,
        Key: write.key,
        ConsistentRead: true,
      }))).Item as Dict | undefined;
      if (!write.holds(current)) {
        const error = new Error('Emulated transaction condition failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      snapshots.push({ write, current });
    }
    let applied = 0;
    try {
      for (const { write, current } of snapshots) {
        const next = write.after(current || {});
        if (next) {
          await client.send(new PutCommand({ TableName: write.tableName, Item: next }));
        } else {
          await client.send(new DeleteCommand({ TableName: write.tableName, Key: write.key }));
        }
        applied += 1;
        if (Number(process.env.CARD_DELETION_TEST_FAIL_AFTER || 0) === applied) {
          throw new Error('Injected Card deletion transaction failure');
        }
      }
    } catch (error) {
      for (const { write, current } of snapshots.slice(0, applied).reverse()) {
        if (current) {
          await client.send(new PutCommand({ TableName: write.tableName, Item: current }));
        } else {
          await client.send(new DeleteCommand({ TableName: write.tableName, Key: write.key }));
        }
      }
      throw error;
    }
  } finally {
    release();
  }
}

async function deleteCardCascade(
  client: DynamoDBDocumentClient,
  cardId: string,
  expectedVersion: number,
  actorId: string,
  owner?: CardOwnerWrite,
): Promise<CardDeletionResult> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('expectedVersion must be an integer greater than or equal to 1');
  }
  const card = await getCardConsistent(client, cardId);
  if (!card) throw new CardNotFoundError(cardId);
  if (card.version !== expectedVersion) throw new CardVersionConflictError(cardId, expectedVersion);

  const { writes, auditEvent, unlinked } = await loadDeletionPlan(client, card, actorId, owner);
  if (writes.length > 100) throw new CardDeletionTooLargeError(cardId, writes.length);

  try {
    if (usesLocalTransactionEmulation()) {
      await emulateTransaction(client, writes);
    } else {
      await client.send(new TransactWriteCommand({ TransactItems: writes.map(({ item }) => item) }));
    }
  } catch (error) {
    if ((error as { name?: string })?.name !== 'TransactionCanceledException') throw error;
    const current = await getCardConsistent(client, cardId);
    if (!current) throw new CardNotFoundError(cardId);
    if (current.version !== expectedVersion) throw new CardVersionConflictError(cardId, expectedVersion);
    throw new CardDeletionConflictError(cardId);
  }

  return {
    cardId,
    title: auditEvent.title,
    deletedTaskIds: auditEvent.deletedTaskIds,
    unlinked,
    auditEventId: auditEvent.id,
  };
}

export {
  CardDeletionBlockedError,
  CardDeletionConflictError,
  CardDeletionTooLargeError,
  cardBlockingReferences,
  deleteCardCascade,
  listCardArtifacts,
};
export type {
  CardBlockingReferences,
  CardDeletionAuditEvent,
  CardDeletionResult,
  CardDeletionUnlinked,
  CardOwnerWrite,
};
