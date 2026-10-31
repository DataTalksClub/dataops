/**
 * Event slots: a Template Task whose `link_card` names a `slot` is carried out
 * by its own event Card (a course's Pre-Course Live Q&A, launch stream or
 * workshop). The slot Card is created undated ("date TBD") and linked to the
 * Task together with the Card that owns the Task, so a missing event is a
 * visible open Card rather than a line of text on a closed Task.
 *
 * The event Card's date is set once, with `dataops cards time`, which also
 * creates its calendar invitations. Creating slots is additive: an existing
 * link is never replaced and a Task that was closed without one is reported,
 * not reopened.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCard } from '../db/cards';
import { listTasksByCardConsistent } from '../db/tasks';
import { setTaskLinkedCard } from '../db/taskCardLinks';
import { getTemplate } from '../db/templates';
import type { VerifiedActor } from '../identity/actor';
import type { Card, Task } from '../types';
import { createCardFromInput, getTemplateIdByType } from './createCard';
import { slotName, taskLinkCardDefinition } from './taskLinkCard';

export interface EventSlotItem {
  taskId: string;
  taskDescription: string;
  taskStatus: Task['status'];
  templateType: string;
  slot: string;
  outcome: 'linked' | 'created' | 'closed-without-card' | 'planned';
  cardId?: string;
  cardTitle?: string;
}

/**
 * Every slot Task on `card`, creating (when `apply`) and linking an undated
 * event Card for each open slot Task without one. Its Tasks are dated from the
 * slot Task's own date until `cards time` sets the event date.
 */
export async function ensureEventSlotCards(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  card: Card,
  options: { apply: boolean },
): Promise<EventSlotItem[]> {
  const template = await getTemplate(client, card.templateId);
  if (!template) return [];
  const tasks = (await listTasksByCardConsistent(client, card.id))
    .filter((task) => task.templateId === template.id)
    .sort((a, b) => (a.templateTaskOrder ?? 0) - (b.templateTaskOrder ?? 0));
  const items: EventSlotItem[] = [];
  let templateIdByType: Map<string, string> | null = null;
  for (const task of tasks) {
    const linkCard = taskLinkCardDefinition(template, task);
    const slot = linkCard && slotName(linkCard, task);
    if (!linkCard || !slot) continue;
    const base = {
      taskId: task.id, taskDescription: task.description, taskStatus: task.status,
      templateType: linkCard.templateType, slot,
    };
    if (task.linkedCardId) {
      const linked = await getCard(client, task.linkedCardId);
      items.push({ ...base, outcome: 'linked', cardId: task.linkedCardId, ...(linked?.title ? { cardTitle: linked.title } : {}) });
      continue;
    }
    if (task.status === 'done' || task.status === 'skipped') {
      if (task.status === 'done') items.push({ ...base, outcome: 'closed-without-card' });
      continue;
    }
    const title = `${card.title || template.name}: ${slot}`;
    if (!options.apply) {
      items.push({ ...base, outcome: 'planned', cardTitle: title });
      continue;
    }
    templateIdByType ??= await getTemplateIdByType(client);
    const templateId = templateIdByType.get(linkCard.templateType);
    if (!templateId) throw new Error(`No ${linkCard.templateType} Template exists for the ${slot} event Card`);
    const created = await createCardFromInput(client, actor, {
      templateId,
      title,
      // The course owner owns its events, where the actor may assign them.
      ...(card.ownerId && (actor.isAdmin || actor.id === card.ownerId) ? { ownerId: card.ownerId } : {}),
    }, { provisionalAnchorDate: task.date });
    if (!created.ok) throw new Error(`Could not create the ${slot} event Card: ${created.response.body}`);
    await setTaskLinkedCard(client, task, created.card.id);
    items.push({ ...base, outcome: 'created', cardId: created.card.id, cardTitle: created.card.title });
  }
  return items;
}
