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
  'requires',
  'validation',
  'requiredLinkName',
  'requiresFile',
  'proofRequirement',
  'tags',
  'sourceDocIds',
] as const;

export type CardTemplateUpdateState = 'current' | 'update-available';
export type TemplateTaskUpdateAction =
  | 'add'
  | 'update'
  | 'restore'
  | 'skip-removed'
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
  sourceTemplateVersion: number;
  targetTemplateVersion: number;
  sourceRevision: string | null;
  targetRevision: string | null;
  previewToken: string;
  availableOptionalGroups: string[];
  selectedOptionalGroups: string[];
  targetOptionalGroups: string[];
  cardChanges: TemplateFieldChange[];
  taskChanges: TemplateTaskUpdatePreview[];
  counts: {
    cardFields: number;
    added: number;
    updated: number;
    skipped: number;
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
  if (!Number.isInteger(task.version) || task.version < 1) {
    throw new CardTemplateUpdateInvalidStateError(
      `Task ${task.id} has an invalid optimistic-concurrency version`,
    );
  }
  return task.version;
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
    // A Template that names no one for a Task leaves its assignee alone: the
    // person came from the workspace default or an admin, not the definition.
    if (field === 'assigneeId' && targetValue === null) continue;
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

function tokenFor(card: Card, tasks: Task[], template: Template, selectedGroups: string[]): string {
  return digest({
    card: { id: card.id, version: card.version },
    selectedGroups,
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
  requestedGroups?: unknown,
): CardTemplateUpdatePlan {
  if (!card.templateId || card.templateId !== template.id) {
    throw new CardTemplateUpdateInvalidStateError('Card does not use this Template');
  }
  if (!card.anchorDate) {
    throw new CardTemplateUpdateInvalidStateError('Template Card has no anchor date');
  }

  const availableGroups = [...new Set((template.taskDefinitions || [])
    .flatMap((definition) => definition.optionalGroup ? [definition.optionalGroup] : []))].sort();
  const currentGroups = [...new Set(card.selectedOptionalGroups || [])].sort();
  const groups = requestedGroups === undefined ? currentGroups : requestedGroups;
  if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string')) {
    throw new CardTemplateUpdateInvalidStateError('optionalGroups must be an array of strings');
  }
  const selected = [...new Set(groups as string[])].sort();
  if (requestedGroups !== undefined && selected.some((group) => !availableGroups.includes(group))) {
    throw new CardTemplateUpdateInvalidStateError('optionalGroups contains an unknown Template option');
  }
  // Options removed from a newer Template no longer remain selected.
  if (requestedGroups === undefined) {
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (!availableGroups.includes(selected[index])) selected.splice(index, 1);
    }
  }
  const selectionChanged = !isDeepStrictEqual(currentGroups, selected);
  const relevantTasks = templateTasksForCard(tasks, template.id);
  if (!card.templateDefinitionSnapshot || !Number.isInteger(card.templateVersion) || Number(card.templateVersion) < 1) {
    throw new CardTemplateUpdateInvalidStateError(
      `Card ${card.id} has no canonical Template provenance`,
    );
  }
  const invalidTask = relevantTasks.find((task) => (
    !task.templateDefinitionSnapshot
    || !Number.isInteger(task.templateVersion)
    || Number(task.templateVersion) < 1
  ));
  if (invalidTask) {
    throw new CardTemplateUpdateInvalidStateError(
      `Task ${invalidTask.id} has no canonical Template provenance`,
    );
  }
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

  // A Card created without an optional group never receives that group's
  // tasks from later Template versions either.
  const definitions = (template.taskDefinitions || []).filter((definition) => (
    !definition.optionalGroup || selected.includes(definition.optionalGroup)
  ));
  for (const [order, definition] of definitions.entries()) {
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

    if (alreadyRetainedForCurrentTemplate(card, template, current) && !(selectionChanged && definition.optionalGroup)) continue;
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

    const restore = current.templateRetiredReason === 'removed'
      && current.status === 'skipped'
      && current.skippedAt === current.templateRetiredAt;
    const action: TemplateTaskUpdateAction = restore ? 'restore' : changes.length === 0
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
    // A resolved Task keeps its resolution; an open one is skipped.
    const action: TemplateTaskUpdateAction = current.status === 'done' || current.status === 'skipped'
      ? 'retain-completed'
      : 'skip-removed';
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

  const templateBehind = card.templateVersion !== template.version
    || (card.templateSourceRevision || null) !== (template.sourceRevision || null);
  const hasEffectiveChanges = selectionChanged || cardChanges.length > 0 || taskUpdates.length > 0;
  const state: CardTemplateUpdateState = templateBehind || hasEffectiveChanges
      ? 'update-available'
      : 'current';
  const operatorOverrides = cardChanges.filter(({ operatorOverride }) => operatorOverride).length
    + taskChanges.reduce((total, change) => total + change.operatorOverrideFields.length, 0);

  return {
    preview: {
      cardId: card.id,
      cardVersion: card.version,
      templateId: template.id,
      state,
      sourceTemplateVersion: card.templateVersion!,
      targetTemplateVersion: template.version,
      sourceRevision: card.templateSourceRevision || null,
      targetRevision: template.sourceRevision || null,
      previewToken: tokenFor(card, tasks, template, selected),
      availableOptionalGroups: availableGroups,
      selectedOptionalGroups: currentGroups,
      targetOptionalGroups: selected,
      cardChanges,
      taskChanges,
      counts: {
        cardFields: cardChanges.length,
        added: taskChanges.filter(({ action }) => action === 'add').length,
        updated: taskChanges.filter(({ action }) => action === 'update' || action === 'restore').length,
        skipped: taskChanges.filter(({ action }) => action === 'skip-removed').length,
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
