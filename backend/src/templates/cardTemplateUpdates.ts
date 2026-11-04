import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  Card,
  CardLink,
  Task,
  TaskDefinition,
  Template,
  TemplateCardDefinitionSnapshot,
  TemplateTaskDefinitionSnapshot,
} from '../types';
import {
  selectedTaskDefinitions,
  templateCardDefinitionSnapshot,
  templateTaskDefinitionSnapshot,
} from './cardTemplateProjection';
import {
  cardCountValues,
  countValuesError,
  parseRepeatInstanceRef,
  retainedRepeatIndexes,
} from './repeatedTasks';

type Dict = Record<string, unknown>;

const CARD_FIELDS = [
  'tags',
  'sourceDocIds',
  'references',
  'cardLinkDefinitions',
  'eventPolicy',
] as const;

const TASK_FIELDS = [
  'description',
  'date',
  'templateOffsetDays',
  'templateAnchor',
  'templateTaskOrder',
  'isMilestone',
  'stageOnComplete',
  'assigneeId',
  'instructionsUrl',
  'instructionDocId',
  'instructionStepId',
  'phase',
  'requires',
  'browserRequirement',
  'validation',
  'requiredLinkName',
  'requiresFile',
  'requiresCalendarInvite',
  'proofRequirement',
  'tags',
  'sourceDocIds',
] as const;

/** Compared with the definition, but stored on the Task as resolved ids in `dependsOn`. */
const DEPENDENCY_FIELD = 'dependsOnRefs';

export type CardTemplateUpdateState = 'current' | 'update-available';
export type TemplateTaskUpdateAction =
  | 'add'
  | 'adopt'
  | 'conflict'
  | 'update'
  | 'restore'
  | 'skip-removed'
  | 'remove'
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
  reason?: string;
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
  /** Count field values before and after; `remove` Tasks are repeated instances beyond a lowered count. */
  countFields: Array<{ id: string; label: string; min: number; max: number }>;
  currentCounts: Record<string, number>;
  targetCounts: Record<string, number>;
  cardChanges: TemplateFieldChange[];
  taskChanges: TemplateTaskUpdatePreview[];
  counts: {
    cardFields: number;
    added: number;
    updated: number;
    skipped: number;
    removed: number;
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
  /** The update rewrites `before`'s Template ref to `taskRef` (renamed definition). */
  adoptedRef?: boolean;
}

export interface CardTemplateUpdatePlan {
  preview: CardTemplateUpdatePreview;
  targetCardSnapshot: TemplateCardDefinitionSnapshot;
  /** The concrete (expanded) definitions the Card holds after the update, by ref. */
  targetDefinitions: Map<string, TaskDefinition>;
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
  if (field === 'eventPolicy') return card.templateDefinitionSnapshot.eventPolicy;
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

/**
 * A Task's edges expressed as Template refs, so they compare with the
 * definition. An edge to a Task the Template does not own is the operator's
 * and appears as `task:<id>`.
 */
function dependencyRefsOf(task: Task, refByTaskId: Map<string, string | undefined>): Dict {
  const refs = (task.dependsOn || []).map((id) => refByTaskId.get(id) || `task:${id}`);
  return refs.length > 0 ? { [DEPENDENCY_FIELD]: refs } : {};
}

/** Tasks instantiated from this Template; any other Task is the Card's own. */
function templateTasksForCard(tasks: Task[], templateId: string): Task[] {
  return tasks.filter((task) => (
    typeof task.templateTaskRef === 'string'
    && task.templateTaskRef.length > 0
    && task.templateId === templateId
  ));
}

function tokenFor(
  card: Card,
  tasks: Task[],
  template: Template,
  selectedGroups: string[],
  counts: Record<string, number>,
): string {
  return digest({
    card: { id: card.id, version: card.version },
    selectedGroups,
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
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
  requestedCounts?: unknown,
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
  if (requestedCounts !== undefined) {
    const error = countValuesError(template, requestedCounts);
    if (error) throw new CardTemplateUpdateInvalidStateError(error);
  }
  const currentCounts = cardCountValues(template, card.counts);
  const targetCounts = cardCountValues(template, {
    ...currentCounts,
    ...(requestedCounts as Record<string, number> | undefined),
  });
  const countsChanged = !isDeepStrictEqual(card.counts || {}, targetCounts);
  const relevantTasks = templateTasksForCard(tasks, template.id);
  if (
    !card.templateDefinitionSnapshot
    || !Array.isArray(card.templateDefinitionSnapshot.taskRefs)
    || !Number.isInteger(card.templateVersion)
    || Number(card.templateVersion) < 1
  ) {
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

  const taskUpdates: PlannedTaskUpdate[] = [];
  const taskChanges: TemplateTaskUpdatePreview[] = [];
  const refByTaskId = new Map(tasks.map((task) => [task.id, task.templateTaskRef]));

  // A Card created without an optional group never receives that group's
  // tasks from later Template versions either. Repeated definitions expand
  // to the target counts; an instance beyond a lowered count stays while any
  // of its group's Tasks is done or links a Card.
  const retained = retainedRepeatIndexes(template.taskDefinitions || [], targetCounts, relevantTasks);
  const definitions = selectedTaskDefinitions(template, selected, targetCounts, retained);
  const targetCardSnapshot = templateCardDefinitionSnapshot(template, definitions.map(({ refId }) => refId));
  const sourceCardSnapshot = card.templateDefinitionSnapshot || null;
  const cardChanges = fieldChanges(
    CARD_FIELDS,
    currentCardDefinition(card),
    sourceCardSnapshot as unknown as Dict | null,
    targetCardSnapshot as unknown as Dict,
  );

  const descriptionCounts = new Map<string, number>();
  definitions.forEach((definition, order) => {
    const label = templateTaskDefinitionSnapshot(template, definition, order, card.anchorDate!, card.endDate).description.trim().toLowerCase();
    descriptionCounts.set(label, (descriptionCounts.get(label) || 0) + 1);
  });
  const accountedRefs = new Set(card.templateDefinitionSnapshot.taskRefs);
  const repeatedRefs = new Set((template.taskDefinitions || [])
    .filter(({ repeat }) => repeat).map(({ refId }) => refId));
  const targetRefs = new Set(definitions.map(({ refId }) => refId));
  // Tasks this update would retire: their ref names no target definition, they
  // are not repeated instances beyond a count, and they are not already
  // retained for the current Template. A definition the Template renamed
  // adopts such a Task by description instead of adding a copy next to it.
  const retiringTasks = relevantTasks.filter((task) => {
    const ref = task.templateTaskRef as string;
    if (targetRefs.has(ref) || alreadyRetainedForCurrentTemplate(card, template, task)) return false;
    const instance = parseRepeatInstanceRef(ref);
    return !instance || !repeatedRefs.has(instance.refId);
  });
  const adoptedRetiring = new Set<string>();
  for (const [order, definition] of definitions.entries()) {
    const ref = definition.refId;
    const current = byRef.get(ref) || null;
    const target = templateTaskDefinitionSnapshot(template, definition, order, card.anchorDate, card.endDate);
    // A definition the Card already accounts for but holds no Task for was
    // left out on purpose (or its work predates the Template); only a
    // definition new to this Card adds a Task.
    if (!current && accountedRefs.has(ref)) continue;
    if (!current) {
      const matches = tasks.filter((task) => !(task.templateId && task.templateTaskRef)
        && task.description.trim().toLowerCase() === target.description.trim().toLowerCase());
      if (matches.length > 0) {
        const match = matches[0];
        const safe = matches.length === 1 && (match.status === 'todo' || match.status === 'waiting')
          && descriptionCounts.get(target.description.trim().toLowerCase()) === 1;
        const action = safe ? 'adopt' : 'conflict';
        taskUpdates.push({ action, taskRef: ref, before: match, target, changedFields: [] });
        taskChanges.push({
          action, taskId: match.id, taskRef: ref,
          currentLabel: match.description, targetLabel: target.description,
          ...(safe ? {} : { reason: 'Matching manual work is resolved or ambiguous; resolve it before applying' }),
          changes: [], operatorOverrideFields: [],
        });
        continue;
      }
      // A definition the Template renamed under its Task adopts the Task it
      // previously named, so the Card keeps one Task for the work instead of
      // gaining a copy while this update retires the original. The same
      // normalized description the manual adoption matches on is the key, and
      // it must name exactly one definition and one retiring Task. A Task an
      // earlier update already retired only comes back when no live Task
      // carries the work; a live one is adopted in its place.
      const label = target.description.trim().toLowerCase();
      if (descriptionCounts.get(label) === 1) {
        const previous = retiringTasks.filter((task) => !adoptedRetiring.has(task.id)
          && task.description.trim().toLowerCase() === label);
        const live = previous.filter((task) => !task.templateRetiredReason);
        const match = live.length === 1
          ? live[0]
          : live.length === 0 && previous.length === 1
            ? previous[0]
            : null;
        if (match) {
          adoptedRetiring.add(match.id);
          const changes = fieldChanges(
            [...TASK_FIELDS, DEPENDENCY_FIELD],
            { ...match, ...dependencyRefsOf(match, refByTaskId) } as unknown as Dict,
            match.templateDefinitionSnapshot as unknown as Dict,
            target as unknown as Dict,
          );
          // A Task this machinery skipped for the removed ref comes back; a
          // resolved one keeps its resolution; an open Task takes the renamed
          // definition's fields. All keep their id under the new ref.
          const restored = match.templateRetiredReason === 'removed'
            && match.status === 'skipped'
            && match.skippedAt === match.templateRetiredAt;
          const action: TemplateTaskUpdateAction = restored
            ? 'restore'
            : changes.length === 0 || match.status === 'done' || match.status === 'skipped'
              ? 'adopt'
              : 'update';
          taskUpdates.push({
            action,
            taskRef: ref,
            before: match,
            target,
            changedFields: action === 'adopt' ? [] : changes.map(({ field }) => field),
            ...(action === 'adopt' ? {} : { adoptedRef: true }),
          });
          taskChanges.push({
            action,
            taskId: match.id,
            taskRef: ref,
            currentLabel: match.description,
            targetLabel: target.description,
            ...(action === 'adopt'
              ? { reason: `The Template renamed ${match.templateTaskRef} to ${ref}; the Task keeps its state` }
              : {}),
            changes: action === 'adopt' ? [] : changes,
            operatorOverrideFields: action === 'adopt'
              ? []
              : changes.filter(({ operatorOverride }) => operatorOverride).map(({ field }) => field),
          });
          continue;
        }
      }
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
      [...TASK_FIELDS, DEPENDENCY_FIELD],
      { ...current, ...dependencyRefsOf(current, refByTaskId) } as unknown as Dict,
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
    if (targetRefs.has(ref) || adoptedRetiring.has(current.id) || alreadyRetainedForCurrentTemplate(card, template, current)) continue;
    // A repeated instance beyond a lowered count that nothing retained (it is
    // not done and links no Card) is removed. Otherwise a resolved Task keeps
    // its resolution and an open one is skipped.
    const instance = parseRepeatInstanceRef(ref);
    const action: TemplateTaskUpdateAction = instance && repeatedRefs.has(instance.refId)
      ? 'remove'
      : current.status === 'done' || current.status === 'skipped'
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

  assertAcyclicAfterUpdate(tasks, taskUpdates);
  assertNoDependentsOfRemoved(tasks, taskUpdates);

  const templateBehind = card.templateVersion !== template.version
    || (card.templateSourceRevision || null) !== (template.sourceRevision || null);
  const hasEffectiveChanges = selectionChanged || countsChanged || cardChanges.length > 0 || taskUpdates.length > 0;
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
      previewToken: tokenFor(card, tasks, template, selected, targetCounts),
      availableOptionalGroups: availableGroups,
      selectedOptionalGroups: currentGroups,
      targetOptionalGroups: selected,
      countFields: (template.countFields || []).map(({ id, label, min, max }) => ({ id, label, min, max })),
      currentCounts,
      targetCounts,
      cardChanges,
      taskChanges,
      counts: {
        cardFields: cardChanges.length,
        added: taskChanges.filter(({ action }) => action === 'add').length,
        updated: taskChanges.filter(({ action }) => action === 'update' || action === 'restore').length,
        skipped: taskChanges.filter(({ action }) => action === 'skip-removed').length,
        removed: taskChanges.filter(({ action }) => action === 'remove').length,
        retainedCompleted: taskChanges.filter(({ action }) => action === 'retain-completed').length,
        reordered: taskChanges.filter(({ changes }) => changes.some(({ field }) => field === 'templateTaskOrder')).length,
        operatorOverrides,
      },
    },
    targetCardSnapshot,
    targetDefinitions: new Map(definitions.map((definition) => [definition.refId, definition])),
    taskUpdates,
  };
}

/** A Task the update removes must not be a prerequisite of a Task that stays. */
function assertNoDependentsOfRemoved(tasks: Task[], updates: PlannedTaskUpdate[]): void {
  const removed = new Set(updates.filter(({ action }) => action === 'remove').map(({ before }) => before!.id));
  if (removed.size === 0) return;
  const dependent = tasks.find((task) => !removed.has(task.id)
    && (task.dependsOn || []).some((id) => removed.has(id)));
  if (dependent) {
    throw new CardTemplateUpdateInvalidStateError(
      `Task "${dependent.description}" depends on a Task the lower count would remove; remove that dependency first`,
    );
  }
}

/**
 * Edges the Template adds can meet edges an operator added; the combined graph
 * must still be acyclic or the Card would hold Tasks that can never complete.
 */
function assertAcyclicAfterUpdate(tasks: Task[], updates: PlannedTaskUpdate[]): void {
  const idByRef = new Map<string, string>();
  for (const task of tasks) if (task.templateTaskRef) idByRef.set(task.templateTaskRef, task.id);
  for (const update of updates) {
    if (update.action === 'adopt' || update.adoptedRef) idByRef.set(update.taskRef, update.before!.id);
    if (update.action === 'add') idByRef.set(update.taskRef, `added:${update.taskRef}`);
  }
  const edges = new Map<string, string[]>(tasks.map((task) => [task.id, task.dependsOn || []]));
  for (const update of updates) {
    if (update.action === 'add' || update.changedFields.includes(DEPENDENCY_FIELD)) {
      const id = update.before?.id || idByRef.get(update.taskRef)!;
      edges.set(id, (update.target?.dependsOnRefs || []).flatMap((ref) => idByRef.get(ref) || []));
    }
  }
  const state = new Map<string, boolean>();
  const visit = (id: string): boolean => {
    if (state.has(id)) return state.get(id)!;
    state.set(id, true);
    for (const next of edges.get(id) || []) if (visit(next)) return true;
    state.set(id, false);
    return false;
  };
  for (const id of edges.keys()) {
    if (visit(id)) {
      throw new CardTemplateUpdateInvalidStateError(
        'Template dependencies combined with this Card\'s own dependencies would form a cycle',
      );
    }
  }
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
