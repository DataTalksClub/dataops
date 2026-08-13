import { createHash } from 'node:crypto';

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
  sourceTemplateVersion: number | null;
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
    ConditionExpression: '#version = :expectedVersion OR (attribute_not_exists(#version) AND :expectedVersion = :versionOne)',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':expectedVersion': version, ':versionOne': 1 },
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
  next.version = (card.version || 1) + 1;
  next.updatedAt = now;
  return compact(next) as Card;
}

function clearDefinitionFields(task: Task & Dict): void {
  for (const field of TEMPLATE_TASK_DEFINITION_FIELDS) delete task[field];
}

function appliedExistingTask(
  update: PlannedTaskUpdate,
  template: Template,
  now: string,
): Task {
  const before = update.before as Task;
  const next = structuredClone(before) as Task & Dict;
  if (update.action === 'archive-removed' || update.action === 'retain-completed') {
    if (update.action === 'archive-removed') next.status = 'archived';
    next.templateRetiredAt = now;
    next.templateRetiredReason = update.target ? 'completed-modified' : 'removed';
  } else {
    if (update.action === 'update') {
      clearDefinitionFields(next);
      Object.assign(next, structuredClone(update.target));
    }
    if (before.templateRetiredReason === 'removed' && before.status === 'archived') next.status = 'todo';
    delete next.templateRetiredAt;
    delete next.templateRetiredReason;
    next.templateVersion = template.version;
    if (template.sourceRevision) next.templateSourceRevision = template.sourceRevision;
    else delete next.templateSourceRevision;
    next.templateDefinitionSnapshot = structuredClone(update.target!);
  }
  next.version = (before.version || 1) + 1;
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
        : entityVersionCondition(expectedVersion)),
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
    if (expected !== undefined && (!current || Number(current.version || 1) !== Number(expected))) {
      throw new CardTemplateUpdateConflictError();
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
  if (process.env.NODE_ENV === 'test') return testTransaction(client, transaction);
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
  const nextCard = appliedCard(card, template, plan, auditEvent, now);
  const replacements = new Map<string, Task>();
  const transaction: TransactionItems = [
    {
      Put: {
        TableName: TABLE_CARDS,
        Item: compact({ PK: `CARD#${card.id}`, SK: `CARD#${card.id}`, ...nextCard }) as Dict,
        ...entityVersionCondition(card.version || 1),
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
    if (update.action === 'add') {
      const task = addedTask(update, template, card, now);
      replacements.set(task.id, task);
      transaction.push(taskPut(task));
      continue;
    }
    const task = appliedExistingTask(update, template, now);
    replacements.set(task.id, task);
    transaction.push(taskPut(task, update.before!.version || 1));
  }

  transaction.push({
    Put: {
      TableName: TABLE_AUDIT_EVENTS,
      Item: compact({ ...auditKey(id), ...auditEvent }) as Dict,
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });
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
