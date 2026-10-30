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
import { resolveTemplateConditionalValidation } from '../cards/conditionalRequired';
import { usesLocalTransactionEmulation } from './client';
import {
  applyCardAggregateDelta,
  isOpenStatus,
  type CardLifecycleAuditEvent,
} from './taskCardLifecycle';
import { resolveDependencyIds, templateTaskProjection } from '../templates/cardTemplateProjection';
import { loadAssignmentPolicy, type AssignmentPolicy } from './workspaceSettings';
import { compact } from './plannedWrite';

import {
  buildCardTemplateUpdatePlan,
  projectedCardLinks,
  TEMPLATE_TASK_DEFINITION_FIELDS,
  type CardTemplateUpdatePlan,
  type CardTemplateUpdatePreview,
  type PlannedTaskUpdate,
} from '../templates/cardTemplateUpdates';

/** The skip reason a reviewed Template update records for a Task it removed. */
export const TEMPLATE_REMOVED_SKIP_REASON = 'Removed from the Card Template';

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
  selectedOptionalGroups: string[];
  targetOptionalGroups: string[];
  currentCounts: Record<string, number>;
  targetCounts: Record<string, number>;
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
  constructor(message = 'Card, Task, or Template changed after preview') {
    super(message);
    this.name = 'CardTemplateUpdateConflictError';
  }
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

function stripLegacyTemplateDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s*Migration provenance:[\s\S]*$/, '')
    .replace(/(?:^|\n)\s*Overview docs:\s*[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*Links:\s*(?:[-*]\s*[^\n]*:\s*TODO\b[\s\S]*)$/i, '')
    .trim();
}

function appliedCard(
  card: Card,
  template: Template,
  plan: CardTemplateUpdatePlan,
  event: CardTemplateUpdateAuditEvent,
  now: string,
): Card {
  const next = structuredClone(card) as Card & Dict;
  for (const field of ['tags', 'sourceDocIds', 'references', 'cardLinks']) delete next[field];
  if (typeof next.description === 'string') {
    const cleaned = stripLegacyTemplateDescription(next.description);
    if (cleaned) next.description = cleaned;
    else delete next.description;
  }
  next.tags = structuredClone(plan.targetCardSnapshot.tags);
  next.sourceDocIds = structuredClone(plan.targetCardSnapshot.sourceDocIds);
  next.references = structuredClone(plan.targetCardSnapshot.references);
  next.cardLinks = projectedCardLinks(
    card.cardLinks,
    card.templateDefinitionSnapshot,
    plan.targetCardSnapshot,
  );
  next.selectedOptionalGroups = [...plan.preview.targetOptionalGroups];
  if (Object.keys(plan.preview.targetCounts).length > 0) next.counts = { ...plan.preview.targetCounts };
  else delete next.counts;
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
  idsByRef: ReadonlyMap<string, string>,
): Task {
  const before = update.before as Task;
  const next = structuredClone(before) as Task & Dict;
  if (update.action === 'skip-removed' || update.action === 'retain-completed') {
    if (update.action === 'skip-removed') {
      next.status = 'skipped';
      next.skipReason = TEMPLATE_REMOVED_SKIP_REASON;
      next.skippedAt = now;
      next.skippedBy = actorId;
      delete next.waitingFor;
      delete next.followUpAt;
      delete next.followUpChannel;
    }
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
    if (update.action === 'update' || update.action === 'restore') {
      const assigneeId = next.assigneeId;
      clearDefinitionFields(next);
      const { dependsOnRefs, ...definition } = structuredClone(update.target!);
      Object.assign(next, definition);
      // Edges are rewritten only when the Template changed them, so an update
      // to other fields keeps the dependencies an operator added.
      if (update.changedFields.includes('dependsOnRefs')) {
        const dependsOn = resolveDependencyIds(update.taskRef, dependsOnRefs, idsByRef);
        if (dependsOn.length > 0) next.dependsOn = dependsOn;
        else delete next.dependsOn;
      }
      // A Template that names no one keeps the Task's current assignee.
      if (!update.target?.assigneeId && assigneeId) next.assigneeId = assigneeId;
    }
    // Only the skip the Template update itself made is undone; an operator's
    // own skip stays.
    if (
      before.templateRetiredReason === 'removed'
      && before.status === 'skipped'
      && before.skippedAt === before.templateRetiredAt
    ) {
      next.status = 'todo';
      delete next.skipReason;
      delete next.skippedAt;
      delete next.skippedBy;
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
    if (update.action === 'adopt') {
      next.templateId = template.id;
      next.templateTaskRef = update.taskRef;
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
  plan: CardTemplateUpdatePlan,
  template: Template,
  card: Card,
  now: string,
  assignment: AssignmentPolicy,
  idsByRef: ReadonlyMap<string, string>,
): Task {
  const definition = plan.targetDefinitions.get(update.taskRef);
  const order = update.target?.templateTaskOrder;
  if (!definition || order === undefined || order < 0 || !card.anchorDate) {
    throw new CardTemplateUpdateConflictError();
  }
  const id = deterministicTaskId(card.id, template.id, update.taskRef);
  return compact({
    id,
    version: 1,
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
    ...templateTaskProjection(template, definition, order, card.anchorDate, card.id, assignment, idsByRef, card.endDate),
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

function resultTasks(tasks: Task[], replacements: Map<string, Task>, removed: ReadonlySet<string> = new Set()): Task[] {
  const existingIds = new Set(tasks.map(({ id }) => id));
  return [
    ...tasks.filter((task) => !removed.has(task.id)).map((task) => replacements.get(task.id) || task),
    ...[...replacements.values()].filter((task) => !existingIds.has(task.id)),
  ];
}

function taskVersion(task: Task): number {
  return task.version;
}

/** Tasks outside the rewrite that take part in a dependency edge after it. */
function unrewrittenGraphTasks(tasks: Task[], replacements: Map<string, Task>, removed: ReadonlySet<string>): Task[] {
  const after = resultTasks(tasks, replacements, removed);
  const inGraph = new Set<string>();
  for (const task of after) {
    if (!task.dependsOn?.length) continue;
    inGraph.add(task.id);
    for (const id of task.dependsOn) inGraph.add(id);
  }
  return tasks.filter((task) => inGraph.has(task.id) && !replacements.has(task.id) && !removed.has(task.id));
}

function replacementAggregateDelta(
  tasks: Task[],
  replacements: Map<string, Task>,
  removed: ReadonlySet<string>,
): { taskCount: number; openTaskCount: number } {
  const existing = new Map(tasks.map((task) => [task.id, task]));
  let taskCount = 0;
  let openTaskCount = 0;
  for (const taskId of removed) {
    taskCount -= 1;
    if (isOpenStatus(existing.get(taskId)!.status)) openTaskCount -= 1;
  }
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
    } else if (entry.Delete) {
      tableName = entry.Delete.TableName!;
      key = entry.Delete.Key as Dict;
      condition = entry.Delete.ConditionExpression || '';
      expected = entry.Delete.ExpressionAttributeValues?.[':expectedVersion'];
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
    if (entry.Put || entry.Delete) snapshots.push({ tableName, key, item: current || null });
  }

  let applied = 0;
  try {
    for (const entry of transaction) {
      if (entry.Delete) {
        await client.send(new DeleteCommand({ TableName: entry.Delete.TableName, Key: entry.Delete.Key as Dict }));
      } else if (entry.Put) {
        await client.send(new PutCommand({ TableName: entry.Put.TableName, Item: entry.Put.Item as Dict }));
      } else {
        continue;
      }
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
  requestedGroups?: unknown,
  requestedCounts?: unknown,
): Promise<AppliedCardTemplateUpdate> {
  // Conditional requiredness (`validation.requiredWhen`) resolves against the
  // Card's anchor date before the plan is built, so the preview an operator
  // confirms and the applied Tasks carry the same required/optional outcome.
  if (card.anchorDate) {
    template = await resolveTemplateConditionalValidation(client, template, card.anchorDate);
  }
  const priorAudit = await existingAudit(client, card.id, previewToken);
  const plan = buildCardTemplateUpdatePlan(card, tasks, template, requestedGroups, requestedCounts);
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
  if (plan.taskUpdates.some(({ action }) => action === 'conflict')) {
    throw new CardTemplateUpdateConflictError('Matching manual work is resolved or ambiguous; resolve the preview conflicts before applying');
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
    selectedOptionalGroups: [...plan.preview.selectedOptionalGroups],
    targetOptionalGroups: [...plan.preview.targetOptionalGroups],
    currentCounts: { ...plan.preview.currentCounts },
    targetCounts: { ...plan.preview.targetCounts },
    result: 'applied',
    createdAt: now,
  };
  // Every Task the Card will hold after the update, by Template ref, so edges
  // can name Tasks the same update adds.
  const idsByRef = new Map<string, string>();
  for (const task of tasks) if (task.templateTaskRef && task.templateId === template.id) idsByRef.set(task.templateTaskRef, task.id);
  for (const update of plan.taskUpdates) {
    if (update.action === 'adopt') idsByRef.set(update.taskRef, update.before!.id);
    if (update.action === 'add') idsByRef.set(update.taskRef, deterministicTaskId(card.id, template.id, update.taskRef));
  }
  const replacements = new Map<string, Task>();
  const removed = new Set(plan.taskUpdates.filter(({ action }) => action === 'remove').map(({ before }) => before!.id));
  const assignment = plan.taskUpdates.some(({ action }) => action === 'add')
    ? await loadAssignmentPolicy(client, (template.taskDefinitions || []).map(({ assigneeId }) => assigneeId))
    : null;
  for (const update of plan.taskUpdates) {
    if (update.action === 'remove') continue;
    if (update.action === 'add') {
      const task = addedTask(update, plan, template, card, now, assignment!, idsByRef);
      replacements.set(task.id, task);
      continue;
    }
    const task = appliedExistingTask(update, template, card, actorId, now, idsByRef);
    replacements.set(task.id, task);
  }

  let nextCard = appliedCard(card, template, plan, auditEvent, now);
  let lifecycleAudit: CardLifecycleAuditEvent | null = null;
  const delta = replacementAggregateDelta(tasks, replacements, removed);
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
    if (update.action === 'remove') {
      transaction.push({
        Delete: {
          TableName: TABLE_TASKS,
          Key: { PK: `TASK#${update.before!.id}`, SK: `TASK#${update.before!.id}` },
          ...taskVersionCondition(update.before!.version),
        },
      });
      continue;
    }
    const taskId = update.action === 'add'
      ? deterministicTaskId(card.id, template.id, update.taskRef)
      : update.before!.id;
    const task = replacements.get(taskId);
    if (!task) throw new CardTemplateUpdateConflictError();
    transaction.push(taskPut(task, update.action === 'add' ? undefined : update.before!.version));
  }

  // The Card version guards every graph-affecting write; the version of each
  // Task on an edge that this update does not rewrite is checked as well, so
  // the whole affected graph is conditioned, not only the rewritten Tasks.
  for (const task of unrewrittenGraphTasks(tasks, replacements, removed)) {
    transaction.push({
      ConditionCheck: {
        TableName: TABLE_TASKS,
        Key: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}` },
        ...taskVersionCondition(taskVersion(task)),
      },
    });
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
    tasks: resultTasks(tasks, replacements, removed),
    auditEvent,
    applied: true,
    idempotent: false,
  };
}
