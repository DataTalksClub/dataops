import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Card } from '../types';
import { getCardConsistent, updateCard, updateCardAdditive } from '../db/cards';
import { listTasksByCardConsistent, updateTask } from '../db/tasks';
import { scanCrmPrefix } from '../db/sponsorCrm';
import { getCalendarHold, listCalendarHolds, putCalendarHold } from '../db/calendarHolds';
import { taskRequiresCalendarInvite, makeTaskHistoryEvent } from '../routes/taskValidation';
import { confirmedHoldInvite, holdGuestAttendees, HOLD_ATTENDEE_DENY_LIST } from './holds';
import { createHoldGoogleEvents, moveLinkedGoogleInvite, updateHoldGoogleEvents, type HoldGoogleDeps } from './holdGoogleSync';

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

export async function closeCardInviteTasks(client: DynamoDBDocumentClient, card: Card, actorId: string) {
  if (!card.calendarInvites?.length) return;
  for (const task of await listTasksByCardConsistent(client, card.id)) {
    if (!['todo', 'waiting'].includes(task.status) || !taskRequiresCalendarInvite(task as unknown as Record<string, unknown>)) continue;
    const now = new Date().toISOString();
    await updateTask(client, task.id, {
      expectedVersion: task.version, currentTask: task,
      patch: { status: 'done', completedAt: now, completedBy: actorId },
      historyEvents: [makeTaskHistoryEvent('completed', task, { actorId, createdAt: now, note: 'Calendar invitation created by DataOps.' })],
      actorId, triggerKind: 'calendar-invite-created',
    });
  }
}

/** Both Card time and confirm-hold use this path. Reserve the Card before
 * Google writes; stable eventKey recovers partial writes without duplicates. */
export async function syncCardInvite(
  client: DynamoDBDocumentClient, card: Card,
  interval: { startIso: string; endIso: string; timeZone: string; durationMinutes: number },
  guests: string[], deps: HoldGoogleDeps, actorId: string,
  source?: { eventKey: string; eventIds: Record<string, string>; title?: string; documentUrl?: string },
) {
  if (card.eventTime?.sync === 'syncing' && Date.now() - Date.parse(card.eventTime.syncStartedAt) < 180000) {
    throw Object.assign(new Error('This Card invitation is syncing; retry shortly'), { statusCode: 409 });
  }
  let linkedHold = card.eventTime?.eventKey.startsWith('hold_')
    ? await getCalendarHold(client, card.eventTime.eventKey) : null;
  if (!card.eventTime && !source) {
    const active = (await listCalendarHolds(client)).filter(hold => hold.cardId === card.id && ['tentative', 'confirmed'].includes(hold.status));
    if (active.length > 1) throw Object.assign(new Error('Multiple calendar holds are linked to this Card; reconcile them before setting time'), { statusCode: 409 });
    linkedHold = active[0] || null;
    if (linkedHold) source = { eventKey: linkedHold.id, eventIds: linkedHold.googleEventIds, title: linkedHold.title, documentUrl: linkedHold.documentUrl };
  }
  const eventKey = card.eventTime?.eventKey || source?.eventKey || (card.calendarInvites?.length ? `legacy:${card.id}` : `card:${card.id}`);
  const eventIds = card.eventTime?.googleEventIds || source?.eventIds ||
    Object.fromEntries((card.calendarInvites || []).map(invite => [invite.calendar, invite.eventId]));
  const pending: NonNullable<Card['eventTime']> = {
    ...interval, eventKey, googleEventIds: eventIds, sync: 'syncing', syncStartedAt: new Date().toISOString(),
  };
  const document = card.cardLinks?.find(link => /^(Podcast document|Outline document|Episode brief|Guest materials)$/i.test(link.name));
  const invite = {
    ...confirmedHoldInvite({ id: eventKey, title: source?.title || linkedHold?.title || card.title || 'DataTalks.Club event', ...interval, ...((source?.documentUrl || linkedHold?.documentUrl || document?.url) ? { documentUrl: source?.documentUrl || linkedHold?.documentUrl || document?.url } : {}) }),
    timeZone: interval.timeZone,
    attendees: [...new Set(guests.flatMap(guest => holdGuestAttendees(guest)))],
  };
  const reserved = await updateCard(client, card.id, { expectedVersion: card.version, patch: { eventTime: pending, guestEmails: guests } });
  const sync = eventKey.startsWith('legacy:')
    ? await moveLinkedGoogleInvite(eventIds, invite, deps)
    : Object.keys(eventIds).length
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
  if (linkedHold) {
    await putCalendarHold(client, {
      ...linkedHold, ...interval, date: new Intl.DateTimeFormat('en-CA', { timeZone: interval.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(interval.startIso)),
      status: 'confirmed', confirmedAt: linkedHold.confirmedAt || new Date().toISOString(),
      googleEventIds: sync.eventIds, googleSync: { state: sync.state, ...(sync.state === 'deferred' ? { reason: sync.reason } : {}) },
      updatedAt: new Date().toISOString(), version: linkedHold.version + 1,
    });
  }
  if (sync.state === 'synced') await closeCardInviteTasks(client, updated, actorId);
  return { card: (await getCardConsistent(client, updated.id))!, sync };
}
