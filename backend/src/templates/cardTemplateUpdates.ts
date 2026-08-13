import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  Card,
  CardLink,
  Task,
  Template,
  TemplateCardDefinitionSnapshot,
  TemplateTaskDefinitionSnapshot,
} from '../types';
import {
  templateCardDefinitionSnapshot,
  templateTaskDefinitionSnapshot,
} from './cardTemplateProjection';

type Dict = Record<string, unknown>;

const CARD_FIELDS = [
  'emoji',
  'tags',
  'sourceDocIds',
  'references',
  'cardLinkDefinitions',
] as const;

const TASK_FIELDS = [
  'description',
  'date',
  'templateOffsetDays',
  'templateTaskOrder',
  'isMilestone',
  'stageOnComplete',
  'assigneeId',
  'instructionsUrl',
  'instructionDocId',
  'instructionStepId',
  'phase',
  'systems',
  'validation',
  'requiredLinkName',
  'requiresFile',
  'proofRequirement',
  'tags',
  'sourceDocIds',
] as const;

export type CardTemplateUpdateState = 'current' | 'update-available' | 'baseline-required';
export type TemplateTaskUpdateAction =
  | 'add'
  | 'update'
  | 'archive-removed'
  | 'retain-completed'
  | 'refresh-provenance';

export interface TemplateFieldChange {
  field: string;
  before: unknown;
  after: unknown;
  operatorOverride: boolean;
}

export interface TemplateTaskUpdatePreview {
  action: TemplateTaskUpdateAction;
  taskId?: string;
  taskRef: string;
  currentLabel?: string;
  targetLabel?: string;
  changes: TemplateFieldChange[];
  operatorOverrideFields: string[];
}

export interface CardTemplateUpdatePreview {
  cardId: string;
  cardVersion: number;
  templateId: string;
  state: CardTemplateUpdateState;
  sourceTemplateVersion: number | null;
  targetTemplateVersion: number;
  sourceRevision: string | null;
  targetRevision: string | null;
  previewToken: string;
  cardChanges: TemplateFieldChange[];
  taskChanges: TemplateTaskUpdatePreview[];
  counts: {
    cardFields: number;
    added: number;
    updated: number;
    archived: number;
    retainedCompleted: number;
    reordered: number;
    operatorOverrides: number;
  };
}

export interface PlannedTaskUpdate {
  action: TemplateTaskUpdateAction;
  taskRef: string;
  before: Task | null;
  target: TemplateTaskDefinitionSnapshot | null;
  changedFields: string[];
}

export interface CardTemplateUpdatePlan {
  preview: CardTemplateUpdatePreview;
  targetCardSnapshot: TemplateCardDefinitionSnapshot;
  taskUpdates: PlannedTaskUpdate[];
}

export class CardTemplateUpdateInvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardTemplateUpdateInvalidStateError';
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function normalized(value: unknown): unknown {
  return value === undefined ? null : value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Dict)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [key, canonical(field)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function taskVersion(task: Task): number {
  return typeof task.version === 'number' ? task.version : 1;
}

function cardDefinitionValue(card: Card, field: typeof CARD_FIELDS[number]): unknown {
  if (field === 'cardLinkDefinitions') {
    return (card.cardLinks || []).map(({ name }) => ({ name }));
  }
  return card[field as keyof Card];
}

function fieldChanges(
  fields: readonly string[],
  current: Dict,
  source: Dict | null,
  target: Dict,
): TemplateFieldChange[] {
  const changes: TemplateFieldChange[] = [];
  for (const field of fields) {
    const currentValue = normalized(current[field]);
    const sourceValue = normalized(source?.[field]);
    const targetValue = normalized(target[field]);
    const definitionChanged = source === null
      ? !isDeepStrictEqual(currentValue, targetValue)
      : !isDeepStrictEqual(sourceValue, targetValue);
    if (!definitionChanged) continue;
    changes.push({
      field,
      before: copy(currentValue),
      after: copy(targetValue),
      operatorOverride: source === null
        ? !isDeepStrictEqual(currentValue, targetValue)
        : !isDeepStrictEqual(currentValue, sourceValue),
    });
  }
  return changes;
}

function currentCardDefinition(card: Card): Dict {
  return Object.fromEntries(CARD_FIELDS.map((field) => [field, cardDefinitionValue(card, field)]));
}

function templateTasksForCard(tasks: Task[], templateId: string): Task[] {
  return tasks.filter((task) => (
    typeof task.templateTaskRef === 'string'
    && task.templateTaskRef.length > 0
    && (!task.templateId || task.templateId === templateId)
  ));
}

function tokenFor(card: Card, tasks: Task[], template: Template): string {
  return digest({
    card: { id: card.id, version: card.version || 1 },
    template: {
      id: template.id,
      version: template.version,
      sourceRevision: template.sourceRevision || null,
    },
    tasks: [...tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((task) => ({ id: task.id, version: taskVersion(task) })),
  });
}

function alreadyRetainedForCurrentTemplate(card: Card, template: Template, task: Task): boolean {
  return card.templateVersion === template.version
    && (card.templateSourceRevision || null) === (template.sourceRevision || null)
    && Boolean(task.templateRetiredReason);
}

export function buildCardTemplateUpdatePlan(
  card: Card,
  tasks: Task[],
  template: Template,
): CardTemplateUpdatePlan {
  if (!card.templateId || card.templateId !== template.id) {
    throw new CardTemplateUpdateInvalidStateError('Card does not use this Template');
  }
  if (!card.anchorDate) {
    throw new CardTemplateUpdateInvalidStateError('Template Card has no anchor date');
  }

  const relevantTasks = templateTasksForCard(tasks, template.id);
  const byRef = new Map<string, Task>();
  for (const task of relevantTasks) {
    const ref = task.templateTaskRef as string;
    if (byRef.has(ref)) {
      throw new CardTemplateUpdateInvalidStateError(`Card has duplicate Template task ref: ${ref}`);
    }
    byRef.set(ref, task);
  }

  const targetCardSnapshot = templateCardDefinitionSnapshot(template);
  const sourceCardSnapshot = card.templateDefinitionSnapshot || null;
  const cardChanges = fieldChanges(
    CARD_FIELDS,
    currentCardDefinition(card),
    sourceCardSnapshot as unknown as Dict | null,
    targetCardSnapshot as unknown as Dict,
  );

  const taskUpdates: PlannedTaskUpdate[] = [];
  const taskChanges: TemplateTaskUpdatePreview[] = [];
  const targetRefs = new Set<string>();

  for (const [order, definition] of (template.taskDefinitions || []).entries()) {
    const ref = definition.refId;
    targetRefs.add(ref);
    const current = byRef.get(ref) || null;
    const target = templateTaskDefinitionSnapshot(template, definition, order, card.anchorDate);
    if (!current) {
      taskUpdates.push({ action: 'add', taskRef: ref, before: null, target, changedFields: [...TASK_FIELDS] });
      taskChanges.push({
        action: 'add',
        taskRef: ref,
        targetLabel: target.description,
        changes: [],
        operatorOverrideFields: [],
      });
      continue;
    }

    if (alreadyRetainedForCurrentTemplate(card, template, current)) continue;
    const source = current.templateDefinitionSnapshot || null;
    const changes = fieldChanges(
      TASK_FIELDS,
      current as unknown as Dict,
      source as unknown as Dict | null,
      target as unknown as Dict,
    );
    const provenanceBehind = current.templateVersion !== template.version
      || (current.templateSourceRevision || null) !== (template.sourceRevision || null)
      || source === null;
    if (changes.length === 0 && !provenanceBehind && !current.templateRetiredReason) continue;

    const action: TemplateTaskUpdateAction = changes.length === 0
      ? 'refresh-provenance'
      : current.status === 'done'
        ? 'retain-completed'
        : 'update';
    taskUpdates.push({
      action,
      taskRef: ref,
      before: current,
      target,
      changedFields: changes.map(({ field }) => field),
    });
    taskChanges.push({
      action,
      taskId: current.id,
      taskRef: ref,
      currentLabel: current.description,
      targetLabel: target.description,
      changes,
      operatorOverrideFields: changes.filter(({ operatorOverride }) => operatorOverride).map(({ field }) => field),
    });
  }

  for (const current of relevantTasks) {
    const ref = current.templateTaskRef as string;
    if (targetRefs.has(ref) || alreadyRetainedForCurrentTemplate(card, template, current)) continue;
    const action: TemplateTaskUpdateAction = current.status === 'done'
      ? 'retain-completed'
      : 'archive-removed';
    taskUpdates.push({ action, taskRef: ref, before: current, target: null, changedFields: [] });
    taskChanges.push({
      action,
      taskId: current.id,
      taskRef: ref,
      currentLabel: current.description,
      changes: [],
      operatorOverrideFields: [],
    });
  }

  const baselineRequired = sourceCardSnapshot === null
    || card.templateVersion === undefined
    || relevantTasks.some((task) => !task.templateDefinitionSnapshot || task.templateVersion === undefined);
  const templateBehind = card.templateVersion !== template.version
    || (card.templateSourceRevision || null) !== (template.sourceRevision || null);
  const hasEffectiveChanges = cardChanges.length > 0 || taskUpdates.length > 0;
  const state: CardTemplateUpdateState = baselineRequired
    ? 'baseline-required'
    : templateBehind || hasEffectiveChanges
      ? 'update-available'
      : 'current';
  const operatorOverrides = cardChanges.filter(({ operatorOverride }) => operatorOverride).length
    + taskChanges.reduce((total, change) => total + change.operatorOverrideFields.length, 0);

  return {
    preview: {
      cardId: card.id,
      cardVersion: card.version || 1,
      templateId: template.id,
      state,
      sourceTemplateVersion: card.templateVersion ?? null,
      targetTemplateVersion: template.version,
      sourceRevision: card.templateSourceRevision || null,
      targetRevision: template.sourceRevision || null,
      previewToken: tokenFor(card, tasks, template),
      cardChanges,
      taskChanges,
      counts: {
        cardFields: cardChanges.length,
        added: taskChanges.filter(({ action }) => action === 'add').length,
        updated: taskChanges.filter(({ action }) => action === 'update').length,
        archived: taskChanges.filter(({ action }) => action === 'archive-removed').length,
        retainedCompleted: taskChanges.filter(({ action }) => action === 'retain-completed').length,
        reordered: taskChanges.filter(({ changes }) => changes.some(({ field }) => field === 'templateTaskOrder')).length,
        operatorOverrides,
      },
    },
    targetCardSnapshot,
    taskUpdates,
  };
}

function sameLinkName(link: CardLink, name: string): boolean {
  return String(link.name || '').trim() === name;
}

/** Keep live URLs and operator-added link rows while applying definition names/order. */
export function projectedCardLinks(
  current: CardLink[] | undefined,
  source: TemplateCardDefinitionSnapshot | undefined,
  target: TemplateCardDefinitionSnapshot,
): CardLink[] {
  const existing = copy(current || []);
  const sourceNames = new Set((source?.cardLinkDefinitions || []).map(({ name }) => name));
  const targetNames = new Set(target.cardLinkDefinitions.map(({ name }) => name));
  const projected = target.cardLinkDefinitions.map(({ name }) => {
    const match = existing.find((link) => sameLinkName(link, name));
    return { name, url: match?.url || '' };
  });
  for (const link of existing) {
    const name = String(link.name || '').trim();
    if (!name || targetNames.has(name)) continue;
    const operatorAdded = !sourceNames.has(name);
    if (operatorAdded || Boolean(link.url)) projected.push(link);
  }
  return projected;
}

export const TEMPLATE_TASK_DEFINITION_FIELDS = TASK_FIELDS;
