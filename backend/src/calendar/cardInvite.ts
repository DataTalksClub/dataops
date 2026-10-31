import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Card, CardCalendarInvite, TaskStatus } from '../types';
import { getCardConsistent, updateCard, updateCardAdditive } from '../db/cards';
import {
  CardLifecycleConflictError,
  listTasksByCardConsistent,
  TaskVersionConflictError,
  updateTask,
} from '../db/tasks';
import { TaskDependencyError, type TaskReference } from '../db/taskDependencies';
import { scanCrmPrefix } from '../db/sponsorCrm';
import { getTemplate } from '../db/templates';
import { getCalendarHold, listCalendarHolds, putCalendarHold } from '../db/calendarHolds';
import { calendarsMissingInvite, taskRequiresCalendarInvite, makeTaskHistoryEvent } from '../routes/taskValidation';
import { dateFromTemplateOffset } from '../templates/cardTemplateProjection';
import { confirmedHoldInvite, confirmedTitle, holdGuestAttendees, parseHoldDocumentUrl, HOLD_ATTENDEE_DENY_LIST, type CalendarHold } from './holds';
import { createHoldGoogleEvents, deleteHoldGoogleEvents, findGoneGoogleEvents, updateHoldGoogleEvents, type HoldGoogleDeps, type HoldGoogleResult } from './holdGoogleSync';

/** AISHL workshops are scheduled by the AISHL site event, which sends its own invite and Zoom. */
export const AISHL_TEMPLATE_ID = 'aishl-workshop';
export const isSiteScheduledCard = (card: Card) => card.templateId === AISHL_TEMPLATE_ID;

export class CardInviteConflictError extends Error {}
export class CardInviteInputError extends Error {}

export interface InviteTaskClosureItem {
  taskId: string;
  description: string;
  outcome: 'closed' | 'already_closed' | 'blocked';
  status: TaskStatus;
  reason?: string;
  code?: string;
  unmetPrerequisites?: TaskReference[];
}

export interface InviteTaskClosureOutcome {
  outcome: 'closed' | 'already_closed' | 'blocked' | 'no_invite_tasks' | 'not_attempted';
  message: string;
  tasks: InviteTaskClosureItem[];
}

export interface CardInviteSyncResult {
  outcome: 'sent' | 'deferred';
  state: 'synced' | 'deferred';
  eventKey: string;
  googleEventIds: Record<string, string>;
  calendarInvites: CardCalendarInvite[];
  reason?: string;
}

/** A portal-hosted guest document page (what `sponsorDocPathForTemplate` links). */
const DATAOPS_GUEST_DOC = /^https:\/\/[^/]+\/(webinar-docs|workshop-docs|podcast-docs|guest-docs)\/[^/?#]+\/?$/;

/** The Card's own DataOps guest document wins over any named external link. */
export function cardGuestDocument(card: Card): string | undefined {
  const links = (card.cardLinks || []).filter(link => Boolean(link.url?.trim()));
  const document = links.find(link => DATAOPS_GUEST_DOC.test(link.url.trim()))
    || links.find(link => /^(Podcast document|Workshop document|Webinar document|Event document|Episode brief)$/i.test(link.name))
    || links.find(link => /^Guest materials$/i.test(link.name));
  try { return parseHoldDocumentUrl(document?.url); }
  catch { throw new CardInviteInputError('The Card guest document must be an HTTPS URL.'); }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseCardGuests(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new Error('guestEmails must contain 1 to 20 guest email addresses');
  const emails = [...new Set(raw.map(email => String(email).trim().toLowerCase()))];
  if (emails.some(email => !EMAIL.test(email) || HOLD_ATTENDEE_DENY_LIST.includes(email))) throw new Error('Every guest needs a permitted email address');
  return emails;
}

/** Names are resolved only when the CRM has one unambiguous contact/email.
 * Explicit Card guest addresses win; never guess from free-form descriptions. */
export async function cardGuests(client: DynamoDBDocumentClient, card: Card): Promise<string[]> {
  if (card.guestEmails?.length) return parseCardGuests(card.guestEmails);
  const holds = (await listCalendarHolds(client)).filter(hold => hold.cardId === card.id && ['tentative', 'confirmed'].includes(hold.status));
  const refs = [...new Set(holds.map(hold => hold.guestRef).filter(Boolean))];
  if (refs.length === 1) return parseCardGuests(refs);
  const people = card.people || [];
  if (!people.length) throw new Error('Set the Card guest email addresses before sending an invite');
  const contacts = people.some(person => !EMAIL.test(person)) ? await scanCrmPrefix(client, 'CONTACT#') : [];
  return parseCardGuests(people.map(person => {
    if (EMAIL.test(person)) return person;
    const matches = contacts.filter(contact => !contact.archivedAt && contact.active !== false && String(contact.name).toLowerCase() === person.toLowerCase());
    if (matches.length !== 1 || !Array.isArray(matches[0].emails) || matches[0].emails.length !== 1) {
      throw new Error(`Set an explicit guest email on the Card for ${person}`);
    }
    return matches[0].emails[0];
  }));
}

export const calendarInviteUrl = (calendar: string, id: string) =>
  `https://calendar.google.com/calendar/event?eid=${Buffer.from(`${id} ${calendar}`).toString('base64url')}`;

export async function closeCardInviteTasks(
  client: DynamoDBDocumentClient,
  card: Card,
  actorId: string,
): Promise<InviteTaskClosureOutcome> {
  const missing = calendarsMissingInvite(card);
  if (missing.length) {
    return {
      outcome: 'not_attempted',
      message: `No live calendar invite on ${missing.join(' and ')} yet; invite task closure was not attempted.`,
      tasks: [],
    };
  }
  const allTasks = await listTasksByCardConsistent(client, card.id);
  const inviteTasks = allTasks.filter(task => taskRequiresCalendarInvite(task as unknown as Record<string, unknown>));
  if (inviteTasks.length === 0) {
    return {
      outcome: 'no_invite_tasks',
      message: 'No calendar invite tasks on this card.',
      tasks: [],
    };
  }
  const items: InviteTaskClosureItem[] = [];
  for (const task of inviteTasks) {
    if (!['todo', 'waiting'].includes(task.status)) {
      items.push({
        taskId: task.id,
        description: task.description,
        outcome: 'already_closed',
        status: task.status,
      });
      continue;
    }
    const now = new Date().toISOString();
    try {
      await updateTask(client, task.id, {
        expectedVersion: task.version, currentTask: task,
        patch: { status: 'done', completedAt: now, completedBy: actorId },
        historyEvents: [makeTaskHistoryEvent('completed', task, { actorId, createdAt: now, note: 'Calendar invitation created by DataOps.' })],
        actorId, triggerKind: 'calendar-invite-created',
      });
      items.push({
        taskId: task.id,
        description: task.description,
        outcome: 'closed',
        status: 'done',
      });
    } catch (error) {
      if (error instanceof TaskDependencyError) {
        items.push({
          taskId: task.id,
          description: task.description,
          outcome: 'blocked',
          status: task.status,
          reason: error.message,
          code: error.code,
          ...(error.tasks.length > 0 ? { unmetPrerequisites: error.tasks } : {}),
        });
        continue;
      }
      if (error instanceof TaskVersionConflictError || error instanceof CardLifecycleConflictError) {
        items.push({
          taskId: task.id,
          description: task.description,
          outcome: 'blocked',
          status: task.status,
          reason: error.message,
          code: 'task-conflict',
        });
        continue;
      }
      throw error;
    }
  }
  const blocked = items.filter(item => item.outcome === 'blocked');
  if (blocked.length > 0) {
    return {
      outcome: 'blocked',
      message: blocked
        .map(item => `Invite task "${item.description}" (${item.taskId}) remains ${item.status}: ${item.reason}`)
        .join('; '),
      tasks: items,
    };
  }
  const closed = items.filter(item => item.outcome === 'closed');
  if (closed.length > 0) {
    return {
      outcome: 'closed',
      message: closed.map(item => `Closed invite task "${item.description}" (${item.taskId}).`).join(' '),
      tasks: items,
    };
  }
  return {
    outcome: 'already_closed',
    message: items
      .map(item => `Invite task "${item.description}" (${item.taskId}) was already ${item.status}.`)
      .join(' '),
    tasks: items,
  };
}

/** Both Card time and confirm-hold use this path. Reserve the Card before
 * Google writes; stable eventKey recovers partial writes without duplicates. */
export async function syncCardInvite(
  client: DynamoDBDocumentClient, card: Card,
  interval: { startIso: string; endIso: string; timeZone: string; durationMinutes: number },
  guests: string[], deps: HoldGoogleDeps, actorId: string,
  source?: CalendarHold,
) {
  if (isSiteScheduledCard(card)) return setSiteScheduledTime(client, card, interval, guests);
  if (card.eventTime?.sync === 'syncing' && Date.now() - Date.parse(card.eventTime.syncStartedAt) < 180000) {
    throw new CardInviteConflictError('This Card invitation is syncing; retry shortly');
  }
  if (source && card.eventTime && source.id !== card.eventTime.eventKey) {
    throw new CardInviteConflictError('This Card already owns a different invitation; change its time on the Card.');
  }
  if (source && !card.eventTime && card.calendarInvites?.some(invite => source.googleEventIds[invite.calendar] !== invite.eventId)) {
    throw new CardInviteConflictError('This Card already links a different invitation.');
  }
  let linkedHold = source || (card.eventTime?.eventKey.startsWith('hold_')
    ? await getCalendarHold(client, card.eventTime.eventKey) : null);
  if (!card.eventTime && !linkedHold) {
    const active = (await listCalendarHolds(client)).filter(hold => hold.cardId === card.id && ['tentative', 'confirmed'].includes(hold.status));
    if (active.length > 1) throw new CardInviteConflictError('Multiple calendar holds are linked to this Card; reconcile them before setting time');
    linkedHold = active[0] || null;
  }
  const eventKey = card.eventTime?.eventKey || linkedHold?.id || `card:${card.id}`;
  const eventIds = card.eventTime?.googleEventIds || linkedHold?.googleEventIds || {};
  const pending: NonNullable<Card['eventTime']> = {
    ...interval, eventKey, googleEventIds: eventIds, sync: 'syncing', syncStartedAt: new Date().toISOString(),
  };
  let documentUrl: string | undefined;
  try {
    const cardDocument = cardGuestDocument(card);
    documentUrl = (cardDocument && DATAOPS_GUEST_DOC.test(cardDocument) ? cardDocument : undefined)
      || parseHoldDocumentUrl(linkedHold?.documentUrl) || cardDocument;
  } catch { throw new CardInviteInputError('The guest document must be an HTTPS URL.'); }
  const template = await getTemplate(client, card.templateId);
  const invite = {
    ...confirmedHoldInvite({ id: eventKey, title: linkedHold?.title || card.title || 'DataTalks.Club event', ...interval, documentUrl }, template?.type),
    timeZone: interval.timeZone,
    attendees: [...new Set(guests.flatMap(guest => holdGuestAttendees(guest)))],
  };
  const reserved = await updateCard(client, card.id, { expectedVersion: card.version, patch: { eventTime: pending, guestEmails: guests } });
  const sync = Object.keys(eventIds).length
    ? await updateHoldGoogleEvents(eventIds, invite, deps)
    : await createHoldGoogleEvents(invite, deps);
  const updated = await updateCardAdditive(client, reserved, current => {
    const invites = [...(current.calendarInvites || [])];
    if (sync.state === 'synced') {
      for (const [calendar, eventId] of Object.entries(sync.eventIds)) {
        const index = invites.findIndex(entry => entry.calendar === calendar && entry.eventId === eventId);
        const entry = { calendar, eventId, url: calendarInviteUrl(calendar, eventId), createdAt: new Date().toISOString(), createdBy: actorId };
        if (index < 0) invites.push(entry); else invites[index] = { ...invites[index], url: entry.url };
      }
    }
    return {
      calendarInvites: invites,
      eventTime: { ...pending, googleEventIds: sync.eventIds, sync: sync.state, ...(sync.state === 'deferred' ? { reason: sync.reason } : {}) },
    };
  });
  let storedHold: CalendarHold | undefined;
  if (linkedHold) {
    storedHold = {
      ...linkedHold, ...interval, date: new Intl.DateTimeFormat('en-CA', { timeZone: interval.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(interval.startIso)),
      googleTitle: confirmedTitle(linkedHold.title), guestRef: guests[0], ...(documentUrl ? { documentUrl } : {}),
      status: 'confirmed', confirmedAt: linkedHold.confirmedAt || new Date().toISOString(),
      googleEventIds: sync.eventIds, googleSync: { state: sync.state, ...(sync.state === 'deferred' ? { reason: sync.reason } : {}) },
      updatedAt: new Date().toISOString(), version: linkedHold.version + 1,
    };
    await putCalendarHold(client, storedHold);
  }
  const taskClosure: InviteTaskClosureOutcome = sync.state === 'synced'
    ? await closeCardInviteTasks(client, updated, actorId)
    : {
        outcome: 'not_attempted',
        message: 'Calendar invite sync was deferred; invite task closure was not attempted.',
        tasks: [],
      };
  const finalCard = (await getCardConsistent(client, updated.id))!;
  const inviteResult: CardInviteSyncResult = {
    outcome: sync.state === 'synced' ? 'sent' : 'deferred',
    state: sync.state,
    eventKey,
    googleEventIds: sync.eventIds,
    calendarInvites: finalCard.calendarInvites || [],
    ...(sync.state === 'deferred' ? { reason: sync.reason } : {}),
  };
  return {
    card: finalCard,
    sync,
    invite: inviteResult,
    taskClosure,
    ...(storedHold ? { hold: storedHold } : {}),
  };
}

/** Date-only `cards time` for site-scheduled cards: no Google event, no Zoom, no guest email. */
async function setSiteScheduledTime(
  client: DynamoDBDocumentClient, card: Card,
  interval: { startIso: string; endIso: string; timeZone: string; durationMinutes: number }, guests: string[],
): Promise<{ card: Card; sync: HoldGoogleResult; invite: CardInviteSyncResult; taskClosure: InviteTaskClosureOutcome; hold?: CalendarHold }> {
  const eventKey = card.eventTime?.eventKey || `card:${card.id}`;
  const updated = await updateCard(client, card.id, {
    expectedVersion: card.version,
    patch: { eventTime: { ...interval, eventKey, googleEventIds: {}, sync: 'synced', syncStartedAt: new Date().toISOString() }, guestEmails: guests },
  });
  const reason = 'AISHL cards are scheduled by the AISHL site event; no calendar invite or Zoom was created.';
  const sync: HoldGoogleResult = { state: 'synced', eventIds: {} };
  return {
    card: updated, sync,
    invite: { outcome: 'sent', state: 'synced', eventKey, googleEventIds: {}, calendarInvites: updated.calendarInvites || [], reason } as CardInviteSyncResult,
    taskClosure: { outcome: 'not_attempted', message: reason, tasks: [] } as InviteTaskClosureOutcome,
  };
}

export interface CardInviteCheck {
  state: 'verified' | 'deferred';
  /** Linked invites Google no longer has (marked `staleAt`). */
  stale: CardCalendarInvite[];
  reason?: string;
}

/**
 * Ask Google whether each linked invite still exists and mark the ones it
 * reports gone as stale. A stale invite stays listed until it is unlinked;
 * no Google event is ever deleted.
 */
export async function verifyCardInvites(
  client: DynamoDBDocumentClient, card: Card, deps: HoldGoogleDeps,
): Promise<{ card: Card; check: CardInviteCheck }> {
  const live = (card.calendarInvites || []).filter(invite => !invite.staleAt);
  const result = await findGoneGoogleEvents(live.map(({ calendar, eventId }) => ({ calendar, eventId })), deps);
  const staleOf = (current: Card) => (current.calendarInvites || []).filter(invite => invite.staleAt);
  if (result.state === 'deferred') return { card, check: { state: 'deferred', stale: staleOf(card), reason: result.reason } };
  if (!result.gone.length) return { card, check: { state: 'verified', stale: staleOf(card) } };
  const gone = new Set(result.gone.map(({ calendar, eventId }) => `${calendar} ${eventId}`));
  const staleAt = new Date().toISOString();
  const updated = await updateCardAdditive(client, card, current => ({
    calendarInvites: (current.calendarInvites || []).map(invite =>
      !invite.staleAt && gone.has(`${invite.calendar} ${invite.eventId}`) ? { ...invite, staleAt } : invite),
  }));
  return { card: updated, check: { state: 'verified', stale: staleOf(updated) } };
}

/**
 * Unlink an invite reference (every calendar copy of `eventId`, or only the
 * one on `calendar`) from the Card. Without `deleteEvent` the Google event is
 * never touched. With it, the event is deleted first (organizer copy with
 * sendUpdates=none, so nobody is notified; the invite uses the shared fixed
 * Zoom room, so no meeting exists to clean up) and the reference is dropped
 * only once Google confirms. The invitation `cards time` owns can be removed
 * only when it is stale (gone in Google) or being deleted; a live one is moved
 * with `cards time`. Removing an owned invite also clears it from `eventTime`.
 */
export async function unlinkCardInvite(
  client: DynamoDBDocumentClient, card: Card, eventId: string, calendar?: string,
  options: { deleteEvent?: boolean; deps?: HoldGoogleDeps } = {},
): Promise<{ card: Card; removed: CardCalendarInvite[] }> {
  const matches = (invite: CardCalendarInvite) => invite.eventId === eventId && (!calendar || invite.calendar === calendar);
  const removed = (card.calendarInvites || []).filter(matches);
  if (!removed.length) throw new CardInviteInputError(`Card ${card.id} links no invite ${eventId}${calendar ? ` on ${calendar}` : ''}`);
  const owned = (invite: CardCalendarInvite) => card.eventTime?.googleEventIds?.[invite.calendar] === invite.eventId;
  if (!options.deleteEvent && removed.some(invite => owned(invite) && !invite.staleAt)) {
    throw new CardInviteConflictError(`Invite ${eventId} is this Card's own invitation from cards time; move it with: dataops cards time ${card.id} --at "YYYY-MM-DD HH:MM" (or delete it with: dataops cards invite remove ${card.id} ${eventId} --delete-event)`);
  }
  if (options.deleteEvent) {
    if (!options.deps) throw new Error('deleteEvent needs calendar dependencies');
    const result = await deleteHoldGoogleEvents(
      Object.fromEntries(removed.map(invite => [invite.calendar, invite.eventId])),
      { ...options.deps, sendUpdates: 'none' },
    );
    if (result.state === 'deferred') throw new CardInviteConflictError(`Google event not deleted, invite kept: ${result.reason}`);
  }
  const updated = await updateCardAdditive(client, card, current => {
    const ownedCalendars = removed.filter(owned).map(invite => invite.calendar);
    const eventIds = { ...(current.eventTime?.googleEventIds || {}) };
    for (const cal of ownedCalendars) delete eventIds[cal];
    return {
      calendarInvites: (current.calendarInvites || []).filter(invite => !matches(invite)),
      ...(current.eventTime && ownedCalendars.length ? { eventTime: { ...current.eventTime, googleEventIds: eventIds } } : {}),
    };
  });
  return { card: updated, removed };
}

/** The event's local calendar date in its own time zone. */
function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * `cards time` dates an undated ("date TBD") event Card, and keeps a Card
 * whose date followed its invitation on the invitation's day: the Card date
 * becomes the event day and its open Template Tasks are re-dated from their
 * offsets. A Card dated independently of its invitation keeps its date.
 */
export async function adoptEventDate(
  client: DynamoDBDocumentClient, card: Card, previous: Card['eventTime'],
): Promise<{ card: Card; movedTasks: number }> {
  if (!card.eventTime || card.eventTime.sync !== 'synced') return { card, movedTasks: 0 };
  const date = localDate(card.eventTime.startIso, card.eventTime.timeZone);
  const followed = !card.anchorDate || (previous && card.anchorDate === localDate(previous.startIso, previous.timeZone));
  if (!followed || card.anchorDate === date) return { card, movedTasks: 0 };
  const updated = await updateCardAdditive(client, card, () => ({ anchorDate: date }));
  let movedTasks = 0;
  for (const task of await listTasksByCardConsistent(client, card.id)) {
    if (!['todo', 'waiting'].includes(task.status) || typeof task.templateOffsetDays !== 'number') continue;
    if ((task as { templateAnchor?: string }).templateAnchor === 'end') continue;
    const taskDate = dateFromTemplateOffset(date, task.templateOffsetDays);
    if (task.date === taskDate) continue;
    await updateTask(client, task.id, {
      expectedVersion: task.version, currentTask: task,
      patch: {
        date: taskDate,
        ...(task.templateDefinitionSnapshot ? { templateDefinitionSnapshot: { ...task.templateDefinitionSnapshot, date: taskDate } } : {}),
      },
    });
    movedTasks += 1;
  }
  return { card: (await getCardConsistent(client, updated.id))!, movedTasks };
}
