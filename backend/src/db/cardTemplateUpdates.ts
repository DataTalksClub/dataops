import { createHash, randomUUID } from 'node:crypto';

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  TABLE_AUDIT_EVENTS,
  TABLE_CARDS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
} from './tableNames';
import type { AuditEventRef, Card, Task, Template } from '../types';
import { usesLocalTransactionEmulation } from './client';
import {
  applyCardAggregateDelta,
  isOpenStatus,
  type CardLifecycleAuditEvent,
} from './taskCardLifecycle';
import { templateTaskProjection } from '../templates/cardTemplateProjection';
import {
  buildCardTemplateUpdatePlan,
  projectedCardLinks,
  TEMPLATE_TASK_DEFINITION_FIELDS,
  type CardTemplateUpdatePlan,
  type CardTemplateUpdatePreview,
  type PlannedTaskUpdate,
} from '../templates/cardTemplateUpdates';

type Dict = Record<string, unknown>;
type TransactionItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

export interface CardTemplateUpdateAuditEvent {
  id: string;
  action: 'card-template-update-applied';
  actorId: string;
  cardId: string;
  templateId: string;
  sourceTemplateVersion: number;
  targetTemplateVersion: number;
  sourceRevision: string | null;
  targetRevision: string | null;
  previewToken: string;
  previewCounts: CardTemplateUpdatePreview['counts'];
  result: 'applied';
  createdAt: string;
}

export interface AppliedCardTemplateUpdate {
  preview: CardTemplateUpdatePreview;
  card: Card;
  tasks: Task[];
  auditEvent: CardTemplateUpdateAuditEvent | null;
  applied: boolean;
  idempotent: boolean;
}

export class CardTemplateUpdateConflictError extends Error {
  constructor() {
    super('Card, Task, or Template changed after preview');
    this.name = 'CardTemplateUpdateConflictError';
  }
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

function auditId(cardId: string, previewToken: string): string {
  return createHash('sha256')
    .update(`card-template-update:${cardId}:${previewToken}`)
    .digest('hex')
    .slice(0, 40);
}

function deterministicTaskId(cardId: string, templateId: string, taskRef: string): string {
  return `template-task-${createHash('sha256')
    .update(`${cardId}:${templateId}:${taskRef}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function entityVersionCondition(version: number) {
  return {
    ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':expectedVersion': version },
  };
}

function taskVersionCondition(version: number) {
  return {
    ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':expectedVersion': version },
  };
}

function auditKey(id: string) {
  return { PK: `AUDIT_EVENT#${id}`, SK: `AUDIT_EVENT#${id}` };
}

async function existingAudit(
  client: DynamoDBDocumentClient,
  cardId: string,
  previewToken: string,
): Promise<CardTemplateUpdateAuditEvent | null> {
  const id = auditId(cardId, previewToken);
  const result = await client.send(new GetCommand({
    TableName: TABLE_AUDIT_EVENTS,
    Key: auditKey(id),
    ConsistentRead: true,
  }));
  if (!result.Item || result.Item.cardId !== cardId || result.Item.previewToken !== previewToken) return null;
  const { PK, SK, ...event } = result.Item;
  return event as unknown as CardTemplateUpdateAuditEvent;
}

function appendAuditRef(refs: AuditEventRef[] | undefined, event: CardTemplateUpdateAuditEvent): AuditEventRef[] {
  const retained = (refs || []).filter(({ auditEventId }) => auditEventId !== event.id);
  return [...retained, {
    auditEventId: event.id,
    action: event.action,
    createdAt: event.createdAt,
  }];
}

function appliedCard(
  card: Card,
  template: Template,
  plan: CardTemplateUpdatePlan,
  event: CardTemplateUpdateAuditEvent,
  now: string,
): Card {
  const next = structuredClone(card) as Card & Dict;
  for (const field of ['emoji', 'tags', 'sourceDocIds', 'references', 'cardLinks']) delete next[field];
  if (plan.targetCardSnapshot.emoji !== undefined) next.emoji = plan.targetCardSnapshot.emoji;
  next.tags = structuredClone(plan.targetCardSnapshot.tags);
  next.sourceDocIds = structuredClone(plan.targetCardSnapshot.sourceDocIds);
  next.references = structuredClone(plan.targetCardSnapshot.references);
  next.cardLinks = projectedCardLinks(
    card.cardLinks,
    card.templateDefinitionSnapshot,
    plan.targetCardSnapshot,
  );
  next.templateVersion = template.version;
  next.templateSourceRevision = template.sourceRevision;
  next.templateDefinitionSnapshot = structuredClone(plan.targetCardSnapshot);
  next.auditEventRefs = appendAuditRef(card.auditEventRefs, event);
  next.version = card.version + 1;
  next.updatedAt = now;
  return compact(next) as Card;
}

function clearDefinitionFields(task: Task & Dict): void {
  for (const field of TEMPLATE_TASK_DEFINITION_FIELDS) delete task[field];
}

function appliedExistingTask(
  update: PlannedTaskUpdate,
  template: Template,
  card: Card,
  actorId: string,
  now: string,
): Task {
  const before = update.before as Task;
  const next = structuredClone(before) as Task & Dict;
  if (update.action === 'archive-removed' || update.action === 'retain-completed') {
    if (update.action === 'archive-removed') next.status = 'archived';
    next.templateRetiredAt = now;
    next.templateRetiredReason = update.target ? 'completed-modified' : 'removed';
    next.taskHistory = [
      ...before.taskHistory,
      {
        id: randomUUID(),
        taskId: before.id,
        cardId: card.id,
        action: 'template-retired',
        actorId,
        createdAt: now,
      },
    ];
  } else {
    if (update.action === 'update') {
      clearDefinitionFields(next);
      Object.assign(next, structuredClone(update.target));
    }
    if (before.templateRetiredReason === 'removed' && before.status === 'archived') {
      next.status = 'todo';
      delete next.waitingFor;
      delete next.followUpAt;
      delete next.followUpChannel;
      next.taskHistory = [
        ...before.taskHistory,
        {
          id: randomUUID(),
          taskId: before.id,
          cardId: card.id,
          action: 'template-restored',
          actorId,
          createdAt: now,
        },
      ];
    }
    delete next.templateRetiredAt;
    delete next.templateRetiredReason;
    next.templateVersion = template.version;
    if (template.sourceRevision) next.templateSourceRevision = template.sourceRevision;
    else delete next.templateSourceRevision;
    next.templateDefinitionSnapshot = structuredClone(update.target!);
  }
  next.version = before.version + 1;
  next.updatedAt = now;
  return compact(next) as Task;
}

function addedTask(
  update: PlannedTaskUpdate,
  template: Template,
  card: Card,
  now: string,
): Task {
  const definitions = template.taskDefinitions || [];
  const order = definitions.findIndex(({ refId }) => refId === update.taskRef);
  const definition = definitions[order];
  if (!definition || order < 0 || !card.anchorDate) {
    throw new CardTemplateUpdateConflictError();
  }
  const id = deterministicTaskId(card.id, template.id, update.taskRef);
  return compact({
    id,
    version: 1,
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
    ...templateTaskProjection(template, definition, order, card.anchorDate, card.id),
  }) as Task;
}

function taskPut(task: Task, expectedVersion?: number) {
  return {
    Put: {
      TableName: TABLE_TASKS,
      Item: compact({ PK: `TASK#${task.id}`, SK: `TASK#${task.id}`, ...task }) as Dict,
      ...(expectedVersion === undefined
        ? { ConditionExpression: 'attribute_not_exists(PK)' }
        : taskVersionCondition(expectedVersion)),
    },
  };
}

function resultTasks(tasks: Task[], replacements: Map<string, Task>): Task[] {
  const existingIds = new Set(tasks.map(({ id }) => id));
  return [
    ...tasks.map((task) => replacements.get(task.id) || task),
    ...[...replacements.values()].filter((task) => !existingIds.has(task.id)),
  ];
}

function replacementAggregateDelta(
  tasks: Task[],
  replacements: Map<string, Task>,
): { taskCount: number; openTaskCount: number } {
  const existing = new Map(tasks.map((task) => [task.id, task]));
  let taskCount = 0;
  let openTaskCount = 0;
  for (const [taskId, after] of replacements) {
    const before = existing.get(taskId);
    if (!before) {
      taskCount += 1;
      if (isOpenStatus(after.status)) openTaskCount += 1;
      continue;
    }
    openTaskCount += Number(isOpenStatus(after.status)) - Number(isOpenStatus(before.status));
  }
  return { taskCount, openTaskCount };
}

function itemKey(item: Dict): Dict {
  return { PK: item.PK, SK: item.SK };
}

async function testTransaction(
  client: DynamoDBDocumentClient,
  transaction: TransactionItems,
): Promise<void> {
  const snapshots: Array<{ tableName: string; key: Dict; item: Dict | null }> = [];
  for (const entry of transaction) {
    let tableName: string;
    let key: Dict;
    let condition: string;
    let expected: unknown;
    if (entry.Put) {
      tableName = entry.Put.TableName!;
      key = itemKey(entry.Put.Item as Dict);
      condition = entry.Put.ConditionExpression || '';
      expected = entry.Put.ExpressionAttributeValues?.[':expectedVersion'];
    } else if (entry.ConditionCheck) {
      tableName = entry.ConditionCheck.TableName!;
      key = entry.ConditionCheck.Key as Dict;
      condition = entry.ConditionCheck.ConditionExpression || '';
      expected = entry.ConditionCheck.ExpressionAttributeValues?.[':expectedVersion'];
    } else {
      throw new Error('Unsupported Card Template test transaction operation');
    }
    const result = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    const current = result.Item as Dict | undefined;
    if (condition.includes('attribute_not_exists(PK)') && current) {
      throw new CardTemplateUpdateConflictError();
    }
    if (expected !== undefined) {
      const versionMatches = current?.version === expected;
      if (!current || !versionMatches) {
        throw new CardTemplateUpdateConflictError();
      }
    }
    if (entry.Put) snapshots.push({ tableName, key, item: current || null });
  }

  let applied = 0;
  try {
    for (const entry of transaction) {
      if (!entry.Put) continue;
      await client.send(new PutCommand({ TableName: entry.Put.TableName, Item: entry.Put.Item as Dict }));
      applied += 1;
      if (Number(process.env.CARD_TEMPLATE_UPDATE_TEST_FAIL_AFTER || 0) === applied) {
        throw new Error('Injected Card Template update transaction failure');
      }
    }
  } catch (error) {
    for (const snapshot of snapshots.slice(0, applied).reverse()) {
      if (snapshot.item) {
        await client.send(new PutCommand({ TableName: snapshot.tableName, Item: snapshot.item }));
      } else {
        await client.send(new DeleteCommand({ TableName: snapshot.tableName, Key: snapshot.key }));
      }
    }
    throw error;
  }
}

async function executeTransaction(
  client: DynamoDBDocumentClient,
  transaction: TransactionItems,
): Promise<void> {
  if (usesLocalTransactionEmulation()) return testTransaction(client, transaction);
  await client.send(new TransactWriteCommand({ TransactItems: transaction }));
}

export async function applyCardTemplateUpdate(
  client: DynamoDBDocumentClient,
  card: Card,
  tasks: Task[],
  template: Template,
  previewToken: string,
  actorId: string,
): Promise<AppliedCardTemplateUpdate> {
  const priorAudit = await existingAudit(client, card.id, previewToken);
  const plan = buildCardTemplateUpdatePlan(card, tasks, template);
  if (priorAudit) {
    return {
      preview: plan.preview,
      card,
      tasks,
      auditEvent: priorAudit,
      applied: false,
      idempotent: true,
    };
  }
  if (plan.preview.previewToken !== previewToken) throw new CardTemplateUpdateConflictError();
  if (plan.preview.state === 'current') {
    return { preview: plan.preview, card, tasks, auditEvent: null, applied: false, idempotent: true };
  }

  const now = new Date().toISOString();
  const id = auditId(card.id, previewToken);
  const auditEvent: CardTemplateUpdateAuditEvent = {
    id,
    action: 'card-template-update-applied',
    actorId,
    cardId: card.id,
    templateId: template.id,
    sourceTemplateVersion: plan.preview.sourceTemplateVersion,
    targetTemplateVersion: plan.preview.targetTemplateVersion,
    sourceRevision: plan.preview.sourceRevision,
    targetRevision: plan.preview.targetRevision,
    previewToken,
    previewCounts: structuredClone(plan.preview.counts),
    result: 'applied',
    createdAt: now,
  };
  const replacements = new Map<string, Task>();
  for (const update of plan.taskUpdates) {
    if (update.action === 'add') {
      const task = addedTask(update, template, card, now);
      replacements.set(task.id, task);
      continue;
    }
    const task = appliedExistingTask(update, template, card, actorId, now);
    replacements.set(task.id, task);
  }

  let nextCard = appliedCard(card, template, plan, auditEvent, now);
  let lifecycleAudit: CardLifecycleAuditEvent | null = null;
  const delta = replacementAggregateDelta(tasks, replacements);
  if (delta.taskCount !== 0 || delta.openTaskCount !== 0) {
    const firstTaskId = replacements.keys().next().value as string | undefined;
    const lifecycle = applyCardAggregateDelta(
      { ...nextCard, version: card.version },
      delta,
      {
        actorId,
        triggerTaskId: firstTaskId || `template:${template.id}`,
        triggerKind: 'card-template-update',
      },
      now,
    );
    nextCard = lifecycle.card;
    lifecycleAudit = lifecycle.auditEvent;
  }

  const transaction: TransactionItems = [
    {
      Put: {
        TableName: TABLE_CARDS,
        Item: compact({ PK: `CARD#${card.id}`, SK: `CARD#${card.id}`, ...nextCard }) as Dict,
        ...entityVersionCondition(card.version),
      },
    },
    {
      ConditionCheck: {
        TableName: TABLE_TEMPLATES,
        Key: { PK: `TEMPLATE#${template.id}`, SK: `TEMPLATE#${template.id}` },
        ...entityVersionCondition(template.version),
      },
    },
  ];
  for (const update of plan.taskUpdates) {
    const taskId = update.action === 'add'
      ? deterministicTaskId(card.id, template.id, update.taskRef)
      : update.before!.id;
    const task = replacements.get(taskId);
    if (!task) throw new CardTemplateUpdateConflictError();
    transaction.push(taskPut(task, update.action === 'add' ? undefined : update.before!.version));
  }

  transaction.push({
    Put: {
      TableName: TABLE_AUDIT_EVENTS,
      Item: compact({ ...auditKey(id), ...auditEvent }) as Dict,
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });
  if (lifecycleAudit) {
    transaction.push({
      Put: {
        TableName: TABLE_AUDIT_EVENTS,
        Item: compact({ ...auditKey(lifecycleAudit.id), ...lifecycleAudit }) as Dict,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  }
  if (transaction.length > 100) {
    throw new Error(`Card Template update requires ${transaction.length} transaction items; maximum is 100`);
  }

  try {
    await executeTransaction(client, transaction);
  } catch (error) {
    if (error instanceof CardTemplateUpdateConflictError) throw error;
    if ((error as Error).name === 'TransactionCanceledException') {
      const racedAudit = await existingAudit(client, card.id, previewToken);
      if (racedAudit) {
        return {
          preview: plan.preview,
          card,
          tasks,
          auditEvent: racedAudit,
          applied: false,
          idempotent: true,
        };
      }
      throw new CardTemplateUpdateConflictError();
    }
    throw error;
  }

  return {
    preview: plan.preview,
    card: nextCard,
    tasks: resultTasks(tasks, replacements),
    auditEvent,
    applied: true,
    idempotent: false,
  };
}
