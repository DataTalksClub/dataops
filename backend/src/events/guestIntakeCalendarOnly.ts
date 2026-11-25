/**
 * Calendar-only first invitation for a guest Card created with --skip-email.
 *
 * --skip-email leaves a silent proposed hold (no attendees, calendar=none) so
 * the operator can make first contact in an existing Gmail thread. This sends
 * only the `[Proposed]` Google Calendar invitation on that same private Zoom
 * event (guest + policy required attendees, sendUpdates=all). It never sends
 * the first-contact email, and once used it permanently blocks the
 * first-contact email for that invitation so the guest cannot get a duplicate.
 */
import { createHash } from 'node:crypto';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import { getTaskConsistent, updateTask } from '../db/tasks';
import { parseCardGuests } from '../calendar/cardInvite';
import { HOLD_ORGANIZER } from '../calendar/holdGoogleSync';
import { getEventRecord } from './store';
import { rescheduleEvent, resolveCardEventPolicy } from './service';
import { getTemplate } from '../db/templates';
import { isPodcastTemplateType } from '../calendar/guestInvite';
import { holdGuestAttendees } from '../calendar/holds';
import { getGuestIntakeJob, guestIntakeKey } from './guestIntakeStore';

export class CalendarOnlyInviteError extends Error {
  constructor(public readonly status: 404 | 409 | 502, message: string) { super(message); }
}

export interface CalendarOnlyInviteResult {
  dryRun: boolean;
  /** True when Google Calendar was asked to notify attendees in this call. */
  sent: boolean;
  /** Always false: this path never sends the first-contact email. */
  emailSent: false;
  alreadyNotified: boolean;
  cardId: string;
  invitationId: string;
  holdId: string;
  eventId?: string;
  calendar: string;
  startIso: string;
  guests: string[];
  requiredAttendees: string[];
  attendees: string[];
  summary?: string;
  location?: string;
}

const lower = (emails: string[]) => [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))];

export async function sendCalendarOnlyInvitation(
  db: DynamoDBDocumentClient,
  cardId: string,
  input: { actor: string; extraGuests?: string[]; dryRun?: boolean },
): Promise<CalendarOnlyInviteResult> {
  const card = await getCardConsistent(db, cardId);
  if (!card) throw new CalendarOnlyInviteError(404, 'Card not found');
  const job = card.guestIntake ? await getGuestIntakeJob(db, card.guestIntake.jobId) : null;
  if (!job) throw new CalendarOnlyInviteError(404, 'This Card has no creation invitation; a calendar-only invitation applies to guest Cards created with --skip-email');
  if (job.status !== 'skipped' || !job.skipEmail) {
    throw new CalendarOnlyInviteError(409, `A calendar-only invitation applies only to an invitation created with --skip-email that has not been sent (current status: ${job.status}${job.skipEmail ? '' : ', email not skipped'})`);
  }
  if (!job.guestEmail) throw new CalendarOnlyInviteError(409, 'The invitation has no guest email; add the guest contact first');
  if (!job.holdId) throw new CalendarOnlyInviteError(409, 'The skipped invitation has no linked event yet; wait for its preparation to finish');
  const event = await getEventRecord(db, job.holdId);
  if (!event || event.status !== 'proposed') {
    throw new CalendarOnlyInviteError(409, `The linked event is ${event?.status || 'missing'}; a calendar-only invitation needs the proposed event created by the Card`);
  }
  let guests: string[];
  try { guests = lower(parseCardGuests([job.guestEmail, ...(input.extraGuests || [])])); }
  catch (error) { throw new CalendarOnlyInviteError(409, (error as Error).message); }
  const operationKey = `guest-intake-calendar-${job.id.slice(0, 32)}-${createHash('sha256').update(guests.join(',')).digest('hex').slice(0, 10)}`;
  const pending = event.operations.at(-1);
  if (pending && pending.state !== 'complete' && pending.key !== operationKey) {
    throw new CalendarOnlyInviteError(409, `The event has an unfinished calendar operation (${pending.key}, ${pending.state}); reconcile it before sending the invitation`);
  }
  // Mirror the attendee set the reschedule will write: podcast-family invites use the
  // shared hold builder; other types use the Card's current event policy.
  const template = await getTemplate(db, card.templateId);
  const planned = template && isPodcastTemplateType(String(template.type || ''))
    ? lower(guests.flatMap(g => holdGuestAttendees(g)))
    : lower([...guests, ...((await resolveCardEventPolicy(db, card)).policy.guests.requiredEmails || [])]);
  const requiredAttendees = planned.filter(e => !guests.includes(e));
  const invited = new Set(lower(event.guestEmails || []));
  const alreadyNotified = event.policy.guests.proposal === true && guests.every(g => invited.has(g))
    && (!pending || pending.state === 'complete');
  const base = {
    emailSent: false as const, alreadyNotified, cardId: card.id, invitationId: job.id, holdId: event.id,
    eventId: event.googleEventIds?.[HOLD_ORGANIZER], calendar: HOLD_ORGANIZER, guests, requiredAttendees,
  };
  if (input.dryRun || alreadyNotified) {
    const attendees = alreadyNotified ? lower(event.operations.at(-1)?.desired.attendees || planned) : planned;
    if (!input.dryRun) await recordCalendarOnly(db, job.id, operationKey, guests, input.actor);
    return { ...base, dryRun: Boolean(input.dryRun), sent: false, startIso: event.startIso, attendees };
  }
  // Same transition the explicit first-send uses to restore guest notifications,
  // minus the first-contact email: same event, same Zoom, same questionnaire link.
  const result = await rescheduleEvent(db, card.id, { date: event.date, time: event.time, guestEmails: guests, operationKey, actor: input.actor });
  if (result.sync.state !== 'synced') {
    throw new CalendarOnlyInviteError(502, `Google Calendar did not confirm the invitation: ${result.sync.reason || result.sync.state}. Retry the same command; it reuses the same operation.`);
  }
  const desired = result.event.operations.find(op => op.key === operationKey)?.desired;
  await recordCalendarOnly(db, job.id, operationKey, guests, input.actor);
  return {
    ...base, dryRun: false, sent: true, eventId: result.event.googleEventIds?.[HOLD_ORGANIZER] || base.eventId,
    startIso: result.event.startIso, attendees: lower(desired?.attendees || planned),
    summary: desired?.summary, location: desired?.location,
  };
}

/** Durably mark that first contact happened outside DataOps; later --send is refused. */
async function recordCalendarOnly(db: DynamoDBDocumentClient, jobId: string, operationKey: string, guests: string[], actor: string) {
  const job = await getGuestIntakeJob(db, jobId);
  if (!job || job.calendarOnly) return;
  const sentAt = new Date().toISOString();
  const updatedAt = sentAt;
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...guestIntakeKey(job.id), ...job, calendarOnly: { sentAt, operationKey, guests, actor }, updatedAt },
    ConditionExpression: '#s = :skipped AND updatedAt = :prior', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':skipped': 'skipped', ':prior': job.updatedAt } }));
  const card = await getCardConsistent(db, job.cardId);
  if (card?.guestIntake) await updateCardAdditive(db, card, c => ({ guestIntake: { ...c.guestIntake!, calendarOnlySentAt: sentAt } }));
  const task = await getTaskConsistent(db, job.taskId);
  if (task) {
    await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version,
      patch: { comment: `[Proposed] calendar invitation sent to ${guests.join(', ')} without the first-contact email (first contact handled outside DataOps). The first-contact email is now blocked for this invitation.` },
      actorId: actor, triggerKind: 'guest-intake-calendar-only' });
  }
}
