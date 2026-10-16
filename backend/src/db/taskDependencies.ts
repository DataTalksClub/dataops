import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { ProjectedTask } from '../identity/projections';
import type { Task, TaskStatus } from '../types';
import { getCardConsistent } from './cards';
import { getTaskConsistent, listTasksByCardConsistent } from './tasks';

/**
 * Task dependencies: `Task.dependsOn` lists prerequisite Task ids on the same
 * Card. A prerequisite is resolved, and satisfies its dependents, when it is
 * `done` or `skipped`.
 *
 * Every rule is evaluated here, below the routes, so each way of changing a
 * Task (PUT, the resolve-done action, create-as-done, Template sync) meets the
 * same checks. The checks also yield `TaskGuard`s, which the Task write turns
 * into DynamoDB ConditionChecks inside its own transaction: a prerequisite
 * reopened, or an edge added, between the read and the write cancels the write
 * instead of leaving a completed Task behind an open prerequisite or a cycle.
 */

/** Condition on another Task that must still hold when the write commits. */
interface TaskGuard {
  taskId: string;
  /** The Task must have exactly this version. */
  version?: number;
  /** The Task must be resolved (`done` or `skipped`). */
  resolved?: true;
}

/** A resolved prerequisite (done or skipped) no longer holds its dependents back. */
function isResolvedStatus(status: TaskStatus | 'missing'): boolean {
  return status === 'done' || status === 'skipped';
}

/**
 * What a Task write must carry besides its own change.
 *
 * Every mutation that can alter a Card's dependency graph or the statuses the
 * rules read (membership, open/resolved transitions, edge edits) writes the Card,
 * so the Card version is the graph's revision. The checks below read the Card
 * *first* and the graph after it from the base table with consistent reads;
 * the write then commits only if the Card is still at the pinned version, so
 * nothing the checks depended on can have changed in between, including a
 * dependent inserted after an earlier read.
 */
interface TaskDependencyPlan {
  guards: TaskGuard[];
  /** Card versions read before the graph; the write requires them unchanged. */
  cardPins: Record<string, number>;
  /** Card to bump for an edge edit that changes no open/resolved count. */
  touchCardId: string | null;
}

type TaskDependencyErrorCode =
  | 'self-dependency'
  | 'missing-dependency'
  | 'cross-card-dependency'
  | 'cyclic-dependency'
  | 'duplicate-dependency'
  | 'invalid-dependency'
  | 'dependencies-require-card'
  | 'dependencies-locked'
  | 'prerequisites-incomplete'
  | 'prerequisite-of-completed-task'
  | 'has-dependents';

interface TaskReference {
  id: string;
  description: string;
  status: TaskStatus | 'missing';
}

class TaskDependencyError extends Error {
  readonly code: TaskDependencyErrorCode;
  /** Structural problems are the caller's input (400); state conflicts are 409. */
  readonly statusCode: 400 | 409;
  readonly tasks: TaskReference[];

  constructor(
    code: TaskDependencyErrorCode,
    message: string,
    statusCode: 400 | 409,
    tasks: TaskReference[] = [],
  ) {
    super(message);
    this.name = 'TaskDependencyError';
    this.code = code;
    this.statusCode = statusCode;
    this.tasks = tasks;
  }
}

function reference(task: Pick<Task, 'id' | 'description' | 'status'>): TaskReference {
  return { id: task.id, description: task.description, status: task.status };
}

function names(tasks: TaskReference[]): string {
  return tasks.map((task) => `"${task.description}"`).join(', ');
}

function cardIdOf(task: Task | null): string | null {
  return task && typeof task.cardId === 'string' && task.cardId.length > 0 ? task.cardId : null;
}

/**
 * Validate the shape of a supplied `dependsOn` value. An empty list means no
 * dependencies and is returned as `null`, the removal marker for the field.
 */
function normalizeDependsOn(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new TaskDependencyError('invalid-dependency', 'dependsOn must be an array of Task ids', 400);
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new TaskDependencyError('invalid-dependency', 'dependsOn must contain non-empty Task ids', 400);
    }
    const id = entry.trim();
    if (ids.includes(id)) {
      throw new TaskDependencyError('duplicate-dependency', `dependsOn lists Task ${id} more than once`, 400);
    }
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

function sameIds(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left || [];
  const b = right || [];
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Walk the prerequisite closure of `starts` with strongly-consistent reads,
 * collecting every Task visited. Stops early with `true` when `target` is reached.
 */
async function walkPrerequisites(
  client: DynamoDBDocumentClient,
  starts: string[],
  target: string,
  seed: Map<string, Task | null>,
): Promise<{ reachesTarget: boolean; visited: Map<string, Task | null> }> {
  const visited = new Map<string, Task | null>();
  let frontier = [...new Set(starts)];
  while (frontier.length > 0) {
    const pending = frontier.filter((id) => !visited.has(id));
    const loaded = await Promise.all(pending.map(async (id) => (
      [id, seed.has(id) ? seed.get(id)! : await getTaskConsistent(client, id)] as const
    )));
    frontier = [];
    for (const [id, task] of loaded) {
      visited.set(id, task);
      if (id === target) return { reachesTarget: true, visited };
      for (const next of task?.dependsOn || []) frontier.push(next);
    }
  }
  return { reachesTarget: false, visited };
}

/**
 * Check one Task mutation against the dependency rules and return the guards
 * its write must carry. `before` is null for a create, `after` is null for a
 * delete.
 */
async function planTaskDependencyChecks(
  client: DynamoDBDocumentClient,
  before: Task | null,
  after: Task | null,
): Promise<TaskDependencyPlan> {
  const guards: TaskGuard[] = [];
  const cardId = cardIdOf(after);
  const dependsOn = after?.dependsOn || [];
  const edgesChanged = after !== null && !sameIds(before?.dependsOn, dependsOn);
  const enteringDone = after !== null && after.status === 'done' && before?.status !== 'done';
  const reopening = before !== null && isResolvedStatus(before.status)
    && after !== null && !isResolvedStatus(after.status);
  const deleting = before !== null && after === null;
  const movingCard = before !== null && after !== null && cardIdOf(before) !== cardIdOf(after);
  const priorCardId = cardIdOf(before);

  if (after && dependsOn.length > 0) {
    if (!cardId) {
      throw new TaskDependencyError(
        'dependencies-require-card',
        'Only a Task on a Card can depend on other Tasks',
        400,
      );
    }
    if (dependsOn.includes(after.id)) {
      throw new TaskDependencyError('self-dependency', 'A Task cannot depend on itself', 400);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new TaskDependencyError('duplicate-dependency', 'dependsOn lists a Task more than once', 400);
    }
  }

  if (edgesChanged && before?.status === 'done') {
    throw new TaskDependencyError(
      'dependencies-locked',
      'A completed Task keeps its prerequisites; reopen it before changing them',
      409,
    );
  }

  // Pin the graph revision before reading any of the graph.
  const cardPins: Record<string, number> = {};
  const graphRelevant = edgesChanged || (enteringDone && dependsOn.length > 0)
    || reopening || deleting || movingCard;
  if (graphRelevant) {
    for (const id of new Set([cardId, priorCardId])) {
      if (!id) continue;
      const card = await getCardConsistent(client, id);
      if (card) cardPins[id] = card.version;
    }
  }

  // Edges are read strongly consistent: a prerequisite that is not there, or
  // lives on another Card, is rejected rather than trusted.
  const seed = new Map<string, Task | null>();
  if (after && cardId && dependsOn.length > 0 && (edgesChanged || enteringDone)) {
    const direct = await Promise.all(dependsOn.map((id) => getTaskConsistent(client, id)));
    const missing = dependsOn.filter((_, index) => direct[index] === null);
    const present = direct.filter((task): task is Task => task !== null);
    dependsOn.forEach((id, index) => seed.set(id, direct[index]));

    if (edgesChanged) {
      if (missing.length > 0) {
        throw new TaskDependencyError(
          'missing-dependency',
          `Prerequisite Task not found: ${missing.join(', ')}`,
          400,
        );
      }
      const foreign = present.filter((task) => cardIdOf(task) !== cardId);
      if (foreign.length > 0) {
        throw new TaskDependencyError(
          'cross-card-dependency',
          `Prerequisites must be on the same Card: ${names(foreign.map(reference))}`,
          400,
          foreign.map(reference),
        );
      }
      // A cycle exists exactly when the Task is reachable from its own
      // prerequisites. Every Task read is version-guarded, so a concurrent
      // edge edit anywhere in the closure cancels this write.
      const walk = await walkPrerequisites(client, dependsOn, after.id, seed);
      if (walk.reachesTarget) {
        throw new TaskDependencyError(
          'cyclic-dependency',
          'These prerequisites would make the Task depend on itself through a cycle',
          400,
        );
      }
      for (const [id, task] of walk.visited) {
        if (task) guards.push({ taskId: id, version: task.version });
        else guards.push({ taskId: id });
      }
    }

    if (enteringDone) {
      // Completion needs every prerequisite resolved (done or skipped). A
      // prerequisite deleted behind the edge's back blocks until the edge is
      // removed.
      const unmet = [
        ...missing.map((id): TaskReference => ({ id, description: id, status: 'missing' })),
        ...present.filter((task) => !isResolvedStatus(task.status)).map(reference),
      ];
      if (unmet.length > 0) {
        throw new TaskDependencyError(
          'prerequisites-incomplete',
          `Cannot mark task as done: complete or skip ${names(unmet)} first`,
          409,
          unmet,
        );
      }
      for (const id of dependsOn) guards.push({ taskId: id, resolved: true });
    }
  }

  // A prerequisite leaves its dependents behind when it is reopened, deleted,
  // or moved to another Card.
  if (priorCardId && (reopening || deleting || movingCard)) {
    const siblings = await listTasksByCardConsistent(client, priorCardId);
    const dependents = siblings.filter((task) => task.id !== before!.id && task.dependsOn?.includes(before!.id));
    const completed = dependents.filter((task) => task.status === 'done');
    if (completed.length > 0 && (reopening || deleting)) {
      throw new TaskDependencyError(
        'prerequisite-of-completed-task',
        `${reopening ? 'Cannot reopen' : 'Cannot delete'} "${before!.description}": `
          + `completed ${names(completed.map(reference))} depends on it`,
        409,
        completed.map(reference),
      );
    }
    if (dependents.length > 0 && deleting) {
      throw new TaskDependencyError(
        'has-dependents',
        `Cannot delete "${before!.description}": ${names(dependents.map(reference))} depends on it. `
          + 'Remove the dependency first',
        409,
        dependents.map(reference),
      );
    }
    if (dependents.length > 0 && movingCard) {
      throw new TaskDependencyError(
        'dependencies-locked',
        `Cannot move "${before!.description}" to another Card while ${names(dependents.map(reference))} depends on it`,
        409,
        dependents.map(reference),
      );
    }
    for (const dependent of dependents) guards.push({ taskId: dependent.id, version: dependent.version });
  }
  if (movingCard && (before!.dependsOn?.length || 0) > 0) {
    throw new TaskDependencyError(
      'dependencies-locked',
      'Remove the Task\'s prerequisites before moving it to another Card',
      409,
    );
  }

  return { guards: mergeGuards(guards), cardPins, touchCardId: edgesChanged ? cardId : null };
}

/** A transaction may touch an item once, so conditions on one Task are combined. */
function mergeGuards(guards: TaskGuard[]): TaskGuard[] {
  const merged = new Map<string, TaskGuard>();
  for (const guard of guards) {
    merged.set(guard.taskId, { ...merged.get(guard.taskId), ...guard });
  }
  return [...merged.values()];
}

/**
 * Attach each Task's resolved prerequisites and whether it is blocked.
 * Prerequisites are looked up once per distinct id, so a list response pays
 * only for the Tasks that actually have edges.
 */
async function attachPrerequisites<T extends Task>(
  client: DynamoDBDocumentClient,
  tasks: T[],
): Promise<Array<T & Pick<ProjectedTask, 'prerequisites' | 'blocked'>>> {
  const known = new Map(tasks.map((task) => [task.id, task as Task | null]));
  const wanted = [...new Set(tasks.flatMap((task) => task.dependsOn || []))].filter((id) => !known.has(id));
  const loaded = await Promise.all(wanted.map(async (id) => [id, await getTaskConsistent(client, id)] as const));
  for (const [id, task] of loaded) known.set(id, task);
  return tasks.map((task) => {
    if (!task.dependsOn?.length) return task;
    const prerequisites = task.dependsOn.map((id): TaskReference => {
      const found = known.get(id);
      return found ? reference(found) : { id, description: id, status: 'missing' };
    });
    return {
      ...task,
      prerequisites,
      blocked: (task.status === 'todo' || task.status === 'waiting')
        && prerequisites.some((entry) => !isResolvedStatus(entry.status)),
    };
  });
}

export {
  TaskDependencyError,
  attachPrerequisites,
  isResolvedStatus,
  normalizeDependsOn,
  planTaskDependencyChecks,
};
export type { TaskDependencyErrorCode, TaskDependencyPlan, TaskGuard, TaskReference };
