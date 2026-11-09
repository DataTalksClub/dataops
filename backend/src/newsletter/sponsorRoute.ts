/**
 * The sponsor email route of a newsletter slot booking: who the sponsor emails
 * go to and which Gmail thread they continue. Sending `email-sponsor` records
 * it on the slot and copies it onto the slot's later send Tasks; a missing
 * route is an error, never a guess.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  listNewsletterIssuesByCardId,
  updateNewsletterIssue,
  type NewsletterSlotPosition,
  type SponsorEmailRoute,
} from '../db/newsletterIssues';
import { getTaskConsistent, listTasksByCardConsistent, TaskVersionConflictError, updateTask } from '../db/tasks';
import type { SponsorDocEmailDelivery } from '../sponsorDocs/emailDelivery';
import type { Task } from '../types';

/** The Task whose send fixes a slot's route. */
export const ROUTE_SOURCE_TASK_REFS: Record<string, NewsletterSlotPosition> = {
  'email-sponsor': 'primary',
  'secondary-email-sponsor': 'secondary',
};

/** The send Tasks of a slot that reuse its route. */
export const ROUTE_SEND_TASK_REFS: Record<NewsletterSlotPosition, string[]> = {
  primary: ['send-performance-to-sponsor', 'send-email-sponsor-publication-live'],
  secondary: ['secondary-send-performance-to-sponsor', 'secondary-send-email-sponsor-publication-live'],
};

export class SponsorRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsorRouteError';
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sponsorRouteFromDelivery(delivery: SponsorDocEmailDelivery): SponsorEmailRoute {
  if (delivery.state !== 'sent') throw new SponsorRouteError('The email was not sent; there is no route to record');
  if (!delivery.to || !EMAIL.test(delivery.to)) throw new SponsorRouteError('The sent email has no recipient address');
  if (!delivery.threadId) throw new SponsorRouteError('Gmail returned no thread id for the sent email');
  return { to: delivery.to, cc: delivery.cc || [], sender: delivery.from, threadRef: delivery.threadId };
}

/** The route as stored, or a loud error naming what is missing. */
export function requireSponsorRoute(value: unknown, where: string): SponsorEmailRoute {
  const route = value as Partial<SponsorEmailRoute> | null | undefined;
  if (!route || typeof route !== 'object') throw new SponsorRouteError(`${where} has no sponsor email route (to, cc, sender, threadRef); send email-sponsor first or backfill it`);
  const missing = ['to', 'sender', 'threadRef'].filter((name) => typeof route[name as 'to'] !== 'string' || !route[name as 'to']);
  if (missing.length || !Array.isArray(route.cc)) {
    throw new SponsorRouteError(`${where} has an incomplete sponsor email route (missing ${[...missing, ...(Array.isArray(route.cc) ? [] : ['cc'])].join(', ')})`);
  }
  return route as SponsorEmailRoute;
}

async function setTaskRoute(client: DynamoDBDocumentClient, task: Task, route: SponsorEmailRoute): Promise<void> {
  let current: Task | null = task;
  for (let attempt = 0; attempt < 3 && current; attempt += 1) {
    if (JSON.stringify(current.sponsorRoute) === JSON.stringify(route)) return;
    try {
      await updateTask(client, current.id, {
        currentTask: current,
        expectedVersion: current.version,
        patch: { sponsorRoute: route },
        actorId: 'system:sponsor-route',
        triggerKind: 'sponsor-route-set',
      });
      return;
    } catch (error) {
      if (!(error instanceof TaskVersionConflictError) || attempt === 2) throw error;
      current = await getTaskConsistent(client, task.id);
    }
  }
}

/** Set the slot's route and copy it onto the slot's send Tasks. Returns the Task ids it wrote. */
export async function applySponsorRoute(
  client: DynamoDBDocumentClient,
  cardId: string,
  position: NewsletterSlotPosition,
  route: SponsorEmailRoute,
): Promise<string[]> {
  const issues = await listNewsletterIssuesByCardId(client, cardId);
  if (issues.length !== 1) throw new SponsorRouteError(`Card ${cardId} is linked to ${issues.length} newsletter issues; expected one`);
  const issue = issues[0];
  const slot = issue.slots?.[position];
  if (!slot?.sponsor) throw new SponsorRouteError(`The ${position} slot of ${issue.id} has no booked sponsor`);
  if (JSON.stringify(slot.route) !== JSON.stringify(route)) {
    await updateNewsletterIssue(client, issue, { slots: { ...issue.slots, [position]: { ...slot, route } } });
  }
  const refs = new Set(ROUTE_SEND_TASK_REFS[position]);
  const written: string[] = [];
  for (const task of await listTasksByCardConsistent(client, cardId)) {
    if (!task.templateTaskRef || !refs.has(task.templateTaskRef)) continue;
    await setTaskRoute(client, task, route);
    written.push(task.id);
  }
  return written;
}

/**
 * After `email-sponsor` (or its secondary twin) sent, record the route it
 * established. Other Tasks are ignored. Throws SponsorRouteError when the send
 * cannot be recorded as a route, after logging a server-side ERROR.
 */
export async function recordSponsorRouteAfterSend(
  client: DynamoDBDocumentClient,
  taskId: string,
  delivery: SponsorDocEmailDelivery,
): Promise<void> {
  if (delivery.state !== 'sent') return;
  const task = await getTaskConsistent(client, taskId);
  const position = task?.templateTaskRef ? ROUTE_SOURCE_TASK_REFS[task.templateTaskRef] : undefined;
  if (!task || !position) return;
  try {
    if (!task.cardId) throw new SponsorRouteError(`Task ${taskId} has no Card`);
    await applySponsorRoute(client, task.cardId, position, sponsorRouteFromDelivery(delivery));
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      message: 'sponsor email route not recorded after email-sponsor send',
      taskId,
      gmailMessageId: delivery.messageId,
      reason: (error as Error).message,
    }));
    throw new SponsorRouteError(
      `The sponsor email was sent (Gmail message ${delivery.messageId}) but its route was not recorded: ${(error as Error).message}`,
    );
  }
}
