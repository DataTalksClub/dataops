import { randomUUID } from 'node:crypto';

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { AuditEventRef, Card, Task, TaskStatus } from '../types';
import { usesLocalTransactionEmulation } from './client';
import {
  CardNotFoundError,
  cardKey,
  getCardConsistent,
  isActiveCardStage,
} from './cards';
import { TABLE_AUDIT_EVENTS, TABLE_CARDS, TABLE_TASKS } from './tableNames';

type Dict = Record<string, unknown>;
type TransactionItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

type TaskCardMutation =
  | {
      kind: 'create';
      afterTask: Task;
      actorId?: string;
      triggerKind?: string;
    }
  | {
      kind: 'update';
      beforeTask: Task;
      afterTask: Task;
      expectedVersion: number;
      patch: Dict;
      historyEvents: Task['taskHistory'];
      actorId?: string;
      triggerKind?: string;
    }
  | {
      kind: 'delete';
      beforeTask: Task;
      expectedVersion: number;
      actorId?: string;
      triggerKind?: string;
    };

interface CardLifecycleAuditEvent {
  id: string;
  action: 'card-completed' | 'card-reactivated';
  actorId: string;
  cardId: string;
  triggerTaskId: string;
  triggerKind: string;
  before: {
    stage: Card['stage'];
    status: Card['status'];
    taskCount: number;
    openTaskCount: number;
  };
  after: {
    stage: Card['stage'];
    status: Card['status'];
    taskCount: number;
    openTaskCount: number;
  };
  createdAt: string;
}

interface CardAggregateTrigger {
  actorId?: string;
  triggerTaskId: string;
  triggerKind: string;
  stageHint?: Card['stage'] | null;
}

class TaskCardTransactionConflictError extends Error {
  readonly reason: 'task' | 'card';
  readonly taskId: string;
  readonly expectedTaskVersion?: number;
  readonly cardIds: string[];

  constructor(
    reason: 'task' | 'card',
    taskId: string,
    cardIds: string[],
    expectedTaskVersion?: number,
  ) {
    super(`${reason === 'task' ? 'Task' : 'Card lifecycle'} changed during Task mutation`);
    this.name = 'TaskCardTransactionConflictError';
    this.reason = reason;
    this.taskId = taskId;
    this.expectedTaskVersion = expectedTaskVersion;
    this.cardIds = cardIds;
  }
}

class CardLifecycleConflictError extends Error {
  readonly taskId: string;
  readonly cardIds: string[];
  readonly taskMayBeMissing: boolean;

  constructor(taskId: string, cardIds: string[], taskMayBeMissing = false) {
    super('Card or its Task aggregate changed; review current work and retry');
    this.name = 'CardLifecycleConflictError';
    this.taskId = taskId;
    this.cardIds = cardIds;
    this.taskMayBeMissing = taskMayBeMissing;
  }
}

function isOpenStatus(status: TaskStatus): boolean {
  return status === 'todo' || status === 'waiting';
}

function taskKey(id: string) {
  return { PK: `TASK#${id}`, SK: `TASK#${id}` };
}

function auditKey(id: string) {
  return { PK: `AUDIT_EVENT#${id}`, SK: `AUDIT_EVENT#${id}` };
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Dict)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, compact(field)]),
    );
  }
  return value;
}

function taskCardId(task: Task | undefined): string | null {
  return task && typeof task.cardId === 'string' && task.cardId.length > 0
    ? task.cardId
    : null;
}

function appendAuditRef(refs: AuditEventRef[] | undefined, event: CardLifecycleAuditEvent): AuditEventRef[] {
  return [
    ...(refs || []),
    { auditEventId: event.id, action: event.action, createdAt: event.createdAt },
  ];
}

function cardDeltas(mutation: TaskCardMutation): Map<string, { taskCount: number; openTaskCount: number }> {
  const deltas = new Map<string, { taskCount: number; openTaskCount: number }>();
  const apply = (cardId: string | null, taskDelta: number, openDelta: number) => {
    if (!cardId) return;
    const current = deltas.get(cardId) || { taskCount: 0, openTaskCount: 0 };
    current.taskCount += taskDelta;
    current.openTaskCount += openDelta;
    deltas.set(cardId, current);
  };

  if (mutation.kind !== 'create') {
    apply(
      taskCardId(mutation.beforeTask),
      -1,
      isOpenStatus(mutation.beforeTask.status) ? -1 : 0,
    );
  }
  if (mutation.kind !== 'delete') {
    apply(
      taskCardId(mutation.afterTask),
      1,
      isOpenStatus(mutation.afterTask.status) ? 1 : 0,
    );
  }

  for (const [cardId, delta] of deltas) {
    if (delta.taskCount === 0 && delta.openTaskCount === 0) deltas.delete(cardId);
  }
  return deltas;
}

function stageHint(mutation: TaskCardMutation, cardId: string): Card['stage'] | null {
  if (mutation.kind !== 'update') return null;
  const { beforeTask, afterTask } = mutation;
  if (
    taskCardId(beforeTask) !== cardId
    || taskCardId(afterTask) !== cardId
    || isOpenStatus(beforeTask.status) === false
    || afterTask.status !== 'done'
    || afterTask.source !== 'template'
    || !isActiveCardStage(afterTask.stageOnComplete)
  ) return null;
  return afterTask.stageOnComplete;
}

function applyCardAggregateDelta(
  card: Card,
  delta: { taskCount: number; openTaskCount: number },
  trigger: CardAggregateTrigger,
  now: string,
): { card: Card; auditEvent: CardLifecycleAuditEvent | null } {
  const taskCount = card.taskCount + delta.taskCount;
  const openTaskCount = card.openTaskCount + delta.openTaskCount;
  if (
    !Number.isInteger(taskCount)
    || !Number.isInteger(openTaskCount)
    || taskCount < 0
    || openTaskCount < 0
    || openTaskCount > taskCount
  ) {
    throw new Error(`Task aggregate delta would make Card ${card.id} invalid`);
  }

  const next = structuredClone(card) as Card;
  next.taskCount = taskCount;
  next.openTaskCount = openTaskCount;
  next.version = card.version + 1;
  next.updatedAt = now;

  const actorId = trigger.actorId || 'system:task-lifecycle';
  const shouldComplete = taskCount > 0 && openTaskCount === 0;
  let action: CardLifecycleAuditEvent['action'] | null = null;

  if (card.status === 'active' && shouldComplete) {
    next.activeStageBeforeCompletion = isActiveCardStage(card.stage) ? card.stage : 'preparation';
    next.stage = 'done';
    next.status = 'archived';
    next.completedAt = now;
    next.completedBy = actorId;
    action = 'card-completed';
  } else if (card.status === 'archived' && !shouldComplete) {
    next.stage = isActiveCardStage(card.activeStageBeforeCompletion)
      ? card.activeStageBeforeCompletion
      : 'preparation';
    next.status = 'active';
    delete next.completedAt;
    delete next.completedBy;
    delete next.activeStageBeforeCompletion;
    action = 'card-reactivated';
  } else if (card.status === 'active') {
    const hint = trigger.stageHint;
    const stageOrder: Record<'preparation' | 'announced' | 'after-event', number> = {
      preparation: 0,
      announced: 1,
      'after-event': 2,
    };
    if (
      isActiveCardStage(hint)
      && isActiveCardStage(card.stage)
      && stageOrder[hint] > stageOrder[card.stage]
    ) next.stage = hint;
  }

  if (!action) return { card: next, auditEvent: null };

  const event: CardLifecycleAuditEvent = {
    id: randomUUID(),
    action,
    actorId,
    cardId: card.id,
    triggerTaskId: trigger.triggerTaskId,
    triggerKind: trigger.triggerKind,
    before: {
      stage: card.stage,
      status: card.status,
      taskCount: card.taskCount,
      openTaskCount: card.openTaskCount,
    },
    after: {
      stage: next.stage,
      status: next.status,
      taskCount,
      openTaskCount,
    },
    createdAt: now,
  };
  next.auditEventRefs = appendAuditRef(card.auditEventRefs, event);
  return { card: next, auditEvent: event };
}

function taskTransactionItem(mutation: TaskCardMutation): TransactionItems[number] {
  if (mutation.kind === 'create') {
    return {
      Put: {
        TableName: TABLE_TASKS,
        Item: compact({ ...taskKey(mutation.afterTask.id), ...mutation.afterTask }) as Dict,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }
  if (mutation.kind === 'delete') {
    return {
      Delete: {
        TableName: TABLE_TASKS,
        Key: taskKey(mutation.beforeTask.id),
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': mutation.expectedVersion },
      },
    };
  }

  const fields: Dict = { ...mutation.patch, updatedAt: mutation.afterTask.updatedAt };
  const setParts: string[] = [];
  const removeParts: string[] = [];
  const names: Record<string, string> = { '#version': 'version' };
  const values: Dict = {
    ':expectedVersion': mutation.expectedVersion,
    ':nextVersion': mutation.expectedVersion + 1,
  };
  let index = 0;
  for (const [key, value] of Object.entries(fields)) {
    const name = `#field${index}`;
    names[name] = key;
    if (['cardId', 'completedAt', 'completedBy'].includes(key) && value === null) {
      removeParts.push(name);
    } else {
      const token = `:value${index}`;
      values[token] = value;
      setParts.push(`${name} = ${token}`);
    }
    index += 1;
  }
  setParts.push('#version = :nextVersion');
  if (mutation.historyEvents.length > 0) {
    names['#taskHistory'] = 'taskHistory';
    values[':historyEvents'] = mutation.historyEvents;
    setParts.push('#taskHistory = list_append(#taskHistory, :historyEvents)');
  }
  const updateExpression = [
    `SET ${setParts.join(', ')}`,
    ...(removeParts.length > 0 ? [`REMOVE ${removeParts.join(', ')}`] : []),
  ].join(' ');
  return {
    Update: {
      TableName: TABLE_TASKS,
      Key: taskKey(mutation.beforeTask.id),
      UpdateExpression: updateExpression,
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

async function rawItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: Dict,
): Promise<Dict | null> {
  const result = await client.send(new GetCommand({
    TableName: tableName,
    Key: key,
    ConsistentRead: true,
  }));
  return result.Item ? result.Item as Dict : null;
}

let testTransactionTail: Promise<void> = Promise.resolve();

async function withTestTransactionLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = testTransactionTail;
  let release!: () => void;
  testTransactionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function executeTestTransaction(
  client: DynamoDBDocumentClient,
  mutation: TaskCardMutation,
  cardsBefore: Map<string, Card>,
  cardsAfter: Map<string, Card>,
  auditEvents: CardLifecycleAuditEvent[],
): Promise<void> {
  const task = mutation.kind === 'delete' ? mutation.beforeTask : mutation.afterTask;
  const currentTask = await rawItem(client, TABLE_TASKS, taskKey(task.id));
  if (mutation.kind === 'create') {
    if (currentTask) {
      throw new TaskCardTransactionConflictError('task', task.id, [...cardsBefore.keys()]);
    }
  } else if (!currentTask || currentTask.version !== mutation.expectedVersion) {
    throw new TaskCardTransactionConflictError(
      'task', task.id, [...cardsBefore.keys()], mutation.expectedVersion,
    );
  }
  for (const [cardId, before] of cardsBefore) {
    const current = await rawItem(client, TABLE_CARDS, cardKey(cardId));
    if (!current) throw new CardNotFoundError(cardId);
    if (current.version !== before.version) {
      throw new TaskCardTransactionConflictError('card', task.id, [...cardsBefore.keys()]);
    }
  }
  for (const event of auditEvents) {
    if (await rawItem(client, TABLE_AUDIT_EVENTS, auditKey(event.id))) {
      throw new TaskCardTransactionConflictError('card', task.id, [...cardsBefore.keys()]);
    }
  }

  const snapshots: Array<{ tableName: string; key: Dict; item: Dict | null }> = [
    { tableName: TABLE_TASKS, key: taskKey(task.id), item: currentTask },
    ...[...cardsBefore.keys()].map((cardId) => ({
      tableName: TABLE_CARDS,
      key: cardKey(cardId),
      item: { ...cardKey(cardId), ...cardsBefore.get(cardId)! } as Dict,
    })),
    ...auditEvents.map((event) => ({
      tableName: TABLE_AUDIT_EVENTS,
      key: auditKey(event.id),
      item: null,
    })),
  ];
  let writes = 0;
  try {
    if (mutation.kind === 'delete') {
      await client.send(new DeleteCommand({ TableName: TABLE_TASKS, Key: taskKey(task.id) }));
    } else {
      await client.send(new PutCommand({
        TableName: TABLE_TASKS,
        Item: compact({ ...taskKey(task.id), ...mutation.afterTask }) as Dict,
      }));
    }
    writes += 1;
    for (const [cardId, card] of cardsAfter) {
      await client.send(new PutCommand({
        TableName: TABLE_CARDS,
        Item: compact({ ...cardKey(cardId), ...card }) as Dict,
      }));
      writes += 1;
      if (Number(process.env.TASK_CARD_LIFECYCLE_TEST_FAIL_AFTER || 0) === writes) {
        throw new Error('Injected Task/Card lifecycle transaction failure');
      }
    }
    for (const event of auditEvents) {
      await client.send(new PutCommand({
        TableName: TABLE_AUDIT_EVENTS,
        Item: compact({ ...auditKey(event.id), ...event }) as Dict,
      }));
      writes += 1;
    }
  } catch (error) {
    for (const snapshot of snapshots.reverse()) {
      if (snapshot.item) {
        await client.send(new PutCommand({ TableName: snapshot.tableName, Item: snapshot.item }));
      } else {
        await client.send(new DeleteCommand({ TableName: snapshot.tableName, Key: snapshot.key }));
      }
    }
    throw error;
  }
}

async function executeTaskCardTransaction(
  client: DynamoDBDocumentClient,
  mutation: TaskCardMutation,
): Promise<{ task: Task | null; cards: Card[]; auditEvents: CardLifecycleAuditEvent[] }> {
  const deltas = cardDeltas(mutation);
  if (deltas.size === 0) {
    throw new TypeError('Task/Card transaction requires a membership or lifecycle delta');
  }
  const now = mutation.kind === 'update'
    ? mutation.afterTask.updatedAt
    : mutation.kind === 'create'
      ? mutation.afterTask.updatedAt
      : new Date().toISOString();
  const cardsBefore = new Map<string, Card>();
  const cardsAfter = new Map<string, Card>();
  const auditEvents: CardLifecycleAuditEvent[] = [];
  for (const [cardId, delta] of deltas) {
    const current = await getCardConsistent(client, cardId);
    if (!current) throw new CardNotFoundError(cardId);
    cardsBefore.set(cardId, current);
    const triggerTask = mutation.kind === 'delete' ? mutation.beforeTask : mutation.afterTask;
    const next = applyCardAggregateDelta(current, delta, {
      actorId: mutation.actorId,
      triggerTaskId: triggerTask.id,
      triggerKind: mutation.triggerKind || `task-${mutation.kind}`,
      stageHint: stageHint(mutation, cardId),
    }, now);
    cardsAfter.set(cardId, next.card);
    if (next.auditEvent) auditEvents.push(next.auditEvent);
  }

  const transaction: TransactionItems = [taskTransactionItem(mutation)];
  for (const [cardId, card] of cardsAfter) {
    const before = cardsBefore.get(cardId)!;
    transaction.push({
      Put: {
        TableName: TABLE_CARDS,
        Item: compact({ ...cardKey(cardId), ...card }) as Dict,
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': before.version },
      },
    });
  }
  for (const event of auditEvents) {
    transaction.push({
      Put: {
        TableName: TABLE_AUDIT_EVENTS,
        Item: compact({ ...auditKey(event.id), ...event }) as Dict,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  }
  if (transaction.length > 100) {
    throw new Error(`Task/Card lifecycle mutation requires ${transaction.length} transaction items; maximum is 100`);
  }

  try {
    if (usesLocalTransactionEmulation()) {
      await withTestTransactionLock(() => (
        executeTestTransaction(client, mutation, cardsBefore, cardsAfter, auditEvents)
      ));
    } else {
      await client.send(new TransactWriteCommand({ TransactItems: transaction }));
    }
  } catch (error) {
    if (error instanceof CardNotFoundError || error instanceof TaskCardTransactionConflictError) throw error;
    if ((error as { name?: string })?.name !== 'TransactionCanceledException') throw error;

    const task = mutation.kind === 'delete' ? mutation.beforeTask : mutation.afterTask;
    const currentTask = await rawItem(client, TABLE_TASKS, taskKey(task.id));
    if (mutation.kind === 'create') {
      if (currentTask) {
        throw new TaskCardTransactionConflictError('task', task.id, [...deltas.keys()]);
      }
    } else if (!currentTask || currentTask.version !== mutation.expectedVersion) {
      throw new TaskCardTransactionConflictError(
        'task', task.id, [...deltas.keys()], mutation.expectedVersion,
      );
    }
    for (const [cardId, before] of cardsBefore) {
      const current = await getCardConsistent(client, cardId);
      if (!current) throw new CardNotFoundError(cardId);
      if (current.version !== before.version) {
        throw new TaskCardTransactionConflictError('card', task.id, [...deltas.keys()]);
      }
    }
    throw new CardLifecycleConflictError(task.id, [...deltas.keys()]);
  }

  return {
    task: mutation.kind === 'delete' ? null : mutation.afterTask,
    cards: [...cardsAfter.values()],
    auditEvents,
  };
}

export {
  CardLifecycleConflictError,
  TaskCardTransactionConflictError,
  executeTaskCardTransaction,
  isOpenStatus,
  applyCardAggregateDelta,
};
export type { CardAggregateTrigger, CardLifecycleAuditEvent, TaskCardMutation };
