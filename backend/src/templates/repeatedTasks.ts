/**
 * Count-driven repeated Tasks.
 *
 * A Template declares count fields (`countFields`, e.g. "Number of
 * workshops") and marks Task definitions `repeat: { countField }`. A Card
 * stores the number it was given for each field (`Card.counts`), and its
 * Task definitions are the Template's expanded by those numbers: a repeated
 * definition `workshop` with a count of 3 becomes `workshop#1`..`workshop#3`,
 * each an ordinary definition. Card creation and the reviewed Template update
 * both work on the expanded list, so a count change is a Template update
 * whose target holds more or fewer instances.
 *
 * Consecutive repeated definitions with the same count field form one group:
 * their instances interleave (Workshop 1 tasks, then Workshop 2 tasks) and
 * instance n of a group member depends on instance n of the members it names.
 */
import type { CountField, Task, TaskDefinition, Template } from '../types';

/** The highest count a count field may allow. */
export const MAX_COUNT = 50;

const INSTANCE_REF = /^(.+)#(\d+)$/;

/** The ref of instance `index` (1-based) of a repeated definition. */
export function repeatInstanceRef(refId: string, index: number): string {
  return `${refId}#${index}`;
}

/** The definition ref and instance number of a repeated Task's ref, or null. */
export function parseRepeatInstanceRef(ref: string | undefined): { refId: string; index: number } | null {
  const match = INSTANCE_REF.exec(ref || '');
  return match ? { refId: match[1], index: Number(match[2]) } : null;
}

/** A repeated definition's description for one instance: `{n}` is the number, appended when absent. */
export function repeatInstanceDescription(description: string, index: number): string {
  return description.includes('{n}')
    ? description.replaceAll('{n}', String(index))
    : `${description} ${index}`;
}

/** Every count field of the Template with its value: the given one, else the field default. */
export function cardCountValues(template: Template, given?: Record<string, number>): Record<string, number> {
  return Object.fromEntries((template.countFields || []).map((field) => [
    field.id,
    given && Number.isInteger(given[field.id]) ? given[field.id] : field.default,
  ]));
}

function countFieldError(field: CountField, value: unknown): string | null {
  if (!Number.isInteger(value) || (value as number) < field.min || (value as number) > field.max) {
    return `counts.${field.id} must be a whole number from ${field.min} to ${field.max}`;
  }
  return null;
}

/** Why a requested `counts` object is invalid for this Template, or null. */
export function countValuesError(template: Template, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'counts must be an object of numbers';
  const fields = new Map((template.countFields || []).map((field) => [field.id, field]));
  for (const [id, count] of Object.entries(value as Record<string, unknown>)) {
    const field = fields.get(id);
    if (!field) return `Unknown count field: ${id}`;
    const error = countFieldError(field, count);
    if (error) return error;
  }
  return null;
}

/**
 * Instance numbers beyond a lowered count that must stay, by count field: a
 * repeated Task that is done or links a Card keeps its whole group instance,
 * so the group's own dependencies stay intact.
 */
export function retainedRepeatIndexes(
  definitions: readonly TaskDefinition[],
  counts: Record<string, number>,
  tasks: readonly Task[],
): Map<string, Set<number>> {
  const byRef = new Map(definitions.map((definition) => [definition.refId, definition]));
  const retained = new Map<string, Set<number>>();
  for (const task of tasks) {
    const instance = parseRepeatInstanceRef(task.templateTaskRef);
    const field = instance ? byRef.get(instance.refId)?.repeat?.countField : undefined;
    if (!instance || !field || instance.index <= (counts[field] || 0)) continue;
    if (task.status !== 'done' && !task.linkedCardId) continue;
    if (!retained.has(field)) retained.set(field, new Set());
    retained.get(field)!.add(instance.index);
  }
  return retained;
}

/**
 * The concrete definitions a Card holds: repeated definitions replaced by one
 * numbered instance per count unit (plus any `retained` instance numbers),
 * every definition carrying its checklist `order`. An instance's order sits
 * between its group's position and the next definition's, so raising a count
 * never reorders the Tasks already on the Card.
 */
export function expandTaskDefinitions(
  definitions: readonly TaskDefinition[],
  counts: Record<string, number>,
  retained: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): TaskDefinition[] {
  const expanded: TaskDefinition[] = [];
  let start = 0;
  while (start < definitions.length) {
    const first = definitions[start];
    if (!first.repeat) {
      expanded.push({ ...first, order: start });
      start += 1;
      continue;
    }
    const field = first.repeat.countField;
    let end = start + 1;
    while (end < definitions.length && definitions[end].repeat?.countField === field) end += 1;
    const group = definitions.slice(start, end);
    const groupRefs = new Set(group.map(({ refId }) => refId));
    const indexes = new Set<number>(retained.get(field) || []);
    for (let index = 1; index <= (counts[field] || 0); index += 1) indexes.add(index);
    for (const index of [...indexes].sort((left, right) => left - right)) {
      group.forEach((definition, position) => {
        const dependsOn = definition.dependsOn?.map((ref) => (
          groupRefs.has(ref) || definitions.some((other) => other.refId === ref && other.repeat)
            ? repeatInstanceRef(ref, index)
            : ref
        ));
        expanded.push({
          ...definition,
          refId: repeatInstanceRef(definition.refId, index),
          description: repeatInstanceDescription(definition.description, index),
          ...(dependsOn ? { dependsOn } : {}),
          order: start + (index * group.length + position) / 100_000,
        });
      });
    }
    start = end;
  }
  return expanded;
}
