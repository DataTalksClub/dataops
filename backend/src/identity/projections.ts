/**
 * Safe Task, Card, and identity projections for the work APIs.
 *
 * Canonical ids stay on the record (`assigneeId`, `ownerId`, history
 * `actorId`) because they are the persisted contract. The projections added
 * here are what routine UI renders, so a raw identifier never has to be shown
 * and a peer's email never has to be loaded to resolve a name.
 */

import type { Card, Task, User } from '../types';
import type { SafeUserProjection, TeamDirectory } from './directory';
import { hydrateStructuredCardFields } from '../cards/cardTitleStructure';

export interface ProjectedTask extends Task {
  /** Safe projection of `assigneeId`; omitted when the Task is unassigned. */
  assignee?: SafeUserProjection;
  /** Safe projections of every actor referenced by this Task's history. */
  historyActors?: SafeUserProjection[];
  /** Resolved `dependsOn`: each prerequisite's name and current status. */
  prerequisites?: Array<{ id: string; description: string; status: Task['status'] | 'missing' }>;
  /** True while an open Task still has a prerequisite that is not `done`. */
  blocked?: boolean;
}

export interface ProjectedCard extends Card {
  /** Safe projection of the administrative `ownerId`. */
  owner?: SafeUserProjection;
  /** Deduplicated safe projections of the assignees of this Card's Tasks. */
  taskAssignees?: SafeUserProjection[];
}

/** The authenticated identity shape returned by `/api/me`. */
export interface IdentityProjection {
  id: string;
  name: string;
  email: string;
  role?: User['role'];
  disabled: boolean;
  createdAt: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function taskActorIds(task: Task): string[] {
  const ids: string[] = [];
  for (const event of task.taskHistory || []) {
    const actorId = nonEmpty(event.actorId);
    if (actorId) ids.push(actorId);
  }
  const createdBy = nonEmpty(task.createdBy);
  if (createdBy) ids.push(createdBy);
  const completedBy = nonEmpty(task.completedBy);
  if (completedBy) ids.push(completedBy);
  for (const note of task.notesLog || []) {
    const authorId = nonEmpty(note.authorId);
    if (authorId) ids.push(authorId);
  }
  return ids;
}

export async function projectTask(directory: TeamDirectory, task: Task): Promise<ProjectedTask> {
  const projected: ProjectedTask = { ...task };
  const assigneeId = nonEmpty(task.assigneeId);
  if (assigneeId) projected.assignee = await directory.project(assigneeId);
  const actorIds = taskActorIds(task);
  if (actorIds.length > 0) projected.historyActors = await directory.projectMany(actorIds);
  return projected;
}

export async function projectTasks(directory: TeamDirectory, tasks: Task[]): Promise<ProjectedTask[]> {
  const projected: ProjectedTask[] = [];
  for (const task of tasks) projected.push(await projectTask(directory, task));
  return projected;
}

/**
 * Project a Card. `tasks` is supplied only where the Card's Tasks are already
 * loaded; the `taskAssignees` summary is never worth an extra fan-out query
 * per Card in a list response.
 */
export async function projectCard(
  directory: TeamDirectory,
  card: Card,
  tasks?: Task[],
  templateIdByType?: Map<string, string> | Record<string, string>,
): Promise<ProjectedCard> {
  const projected: ProjectedCard = { ...card };
  hydrateStructuredCardFields(projected, templateIdByType);
  const ownerId = nonEmpty(card.ownerId);
  if (ownerId) projected.owner = await directory.project(ownerId);
  if (tasks) {
    projected.taskAssignees = await directory.projectMany(
      tasks.map((task) => nonEmpty(task.assigneeId)).filter((id): id is string => id !== null),
    );
  }
  return projected;
}

export async function projectCards(
  directory: TeamDirectory,
  cards: Card[],
  tasksByCardId: ReadonlyMap<string, Task[]>,
  templateIdByType?: Map<string, string> | Record<string, string>,
): Promise<ProjectedCard[]> {
  const projected: ProjectedCard[] = [];
  for (const card of cards) {
    projected.push(await projectCard(directory, card, tasksByCardId.get(card.id) ?? [], templateIdByType));
  }
  return projected;
}

/**
 * The signed-in identity. `disabled` is always explicit so the shell never has
 * to infer availability, and no session material is included.
 */
export function identityProjection(user: User): IdentityProjection {
  return { ...user, disabled: user.disabled === true };
}
