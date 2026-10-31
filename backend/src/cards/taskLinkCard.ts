import { parseRepeatInstanceRef, repeatInstanceDescription } from '../templates/repeatedTasks';
import type { Task, TaskLinkCard, Template } from '../types';

/** The `link_card` definition behind a Task, read from its source Template. */
export function taskLinkCardDefinition(template: Template | null, task: Pick<Task, 'templateTaskRef'>): TaskLinkCard | null {
  if (!template || !task.templateTaskRef) return null;
  const ref = parseRepeatInstanceRef(task.templateTaskRef)?.refId ?? task.templateTaskRef;
  return template.taskDefinitions?.find(({ refId }) => refId === ref)?.linkCard || null;
}

/** The slot's display name for this Task: `{n}` is its repeat instance number. */
export function slotName(linkCard: TaskLinkCard, task: Pick<Task, 'templateTaskRef'>): string | null {
  if (!linkCard.slot) return null;
  const index = parseRepeatInstanceRef(task.templateTaskRef)?.index;
  return index === undefined ? linkCard.slot.replaceAll('{n}', '').trim() : repeatInstanceDescription(linkCard.slot, index);
}
