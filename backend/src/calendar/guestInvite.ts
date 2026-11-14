import { OPERATIONS_SENDER } from '../identity/operatingIdentities';
import { recordTemplateTypes } from '../cards/cardTitlePattern';
import { resolveHoldGoogleCalendars } from './dapierBroker';
import {
  HOLD_INVITE_LEAD_MINUTES,
  HOLD_PROPOSAL_PREFIX,
  HOLD_TIME_ZONE,
  HOLD_ZOOM_LOCATION,
  confirmedHoldDescription,
  confirmedTitle,
  holdGuestAttendees,
} from './holds';
import { fetchGoogleEvents, HOLD_ORGANIZER, type HoldGoogleDeps, type LiveGoogleEvent } from './holdGoogleSync';

/**
 * THE shared guest-invite builder (Hub intake 0d56721e).
 *
 * Every path that creates or updates a guest calendar invite — confirm-hold,
 * `event approve`, reschedule, resend (`event retry`) and recovery — gets its
 * title, description (with the Zoom link), location, guest set and target
 * calendars from `buildGuestInvite` and from nowhere else. Both Alexey
 * addresses are attendees on purpose (canonical, not a bug).
 */
export interface GuestInviteInput {
  eventKey: string;
  /** Template type of the Card the invite belongs to (podcast, webinar, workshop …). */
  eventType?: string;
  /** Fallback title (hold or Card title) when no guest-named title applies. */
  title: string;
  /** Resolved "<Guest> at DataTalks.Club Podcast" title; wins over `title`. */
  guestTitle?: string;
  documentUrl?: string;
  /** Guest email addresses. The required Alexey addresses are always added. */
  guests: string[];
  /** Slot start/end (the invite window start is derived from it). */
  startIso: string;
  endIso: string;
  timeZone?: string;
  /** Proposal blocks keep the `[Proposed]` prefix until confirmed. */
  proposed?: boolean;
  /** False builds a guest-free block (private proposal): no attendees. */
  withGuests?: boolean;
  /** Minutes before the slot that the invite starts; default HOLD_INVITE_LEAD_MINUTES. */
  leadMinutes?: number;
}

export interface GuestInvite {
  eventKey: string;
  summary: string;
  description: string;
  location: string;
  attendees: string[];
  /** Personal calendars that must hold a copy of the invite. */
  calendars: string[];
  startIso: string;
  endIso: string;
  timeZone: string;
}

export function isPodcastTemplateType(type?: string | null): boolean {
  return Boolean(type) && (recordTemplateTypes('podcast-episode') as string[]).includes(String(type));
}

export function buildGuestInvite(input: GuestInviteInput, calendarIds?: string[]): GuestInvite {
  const title = confirmedTitle(input.guestTitle || input.title);
  const lead = input.leadMinutes ?? HOLD_INVITE_LEAD_MINUTES;
  return {
    eventKey: input.eventKey,
    summary: input.proposed ? `${HOLD_PROPOSAL_PREFIX}${title}` : title,
    description: confirmedHoldDescription(input.documentUrl, title, input.eventType),
    location: HOLD_ZOOM_LOCATION,
    attendees: input.withGuests === false
      ? []
      : [...new Set(input.guests.flatMap(guest => holdGuestAttendees(guest)))],
    calendars: resolveHoldGoogleCalendars(calendarIds),
    startIso: new Date(Date.parse(input.startIso) - lead * 60000).toISOString(),
    endIso: input.endIso,
    timeZone: input.timeZone || HOLD_TIME_ZONE,
  };
}

const norm = (text?: string) => (text || '').replace(/\r\n/g, '\n').trim();
const emailSet = (emails: string[]) => [...new Set(emails.map(email => email.trim().toLowerCase()))].sort();

/** Differences between a live Google event and the canonical invite. Empty = valid. */
export function diffLiveInvite(expected: GuestInvite, live: LiveGoogleEvent, where: string, checkGuests: boolean): string[] {
  const problems: string[] = [];
  if (norm(live.summary) !== norm(expected.summary)) problems.push(`${where}: title is "${live.summary || ''}", expected "${expected.summary}"`);
  if (norm(live.description) !== norm(expected.description)) problems.push(`${where}: description differs from the template (expected the Zoom link description)`);
  if (norm(live.location) !== norm(expected.location)) problems.push(`${where}: location is "${live.location || ''}", expected "${expected.location}"`);
  if (Date.parse(live.start?.dateTime || '') !== Date.parse(expected.startIso)) problems.push(`${where}: start is ${live.start?.dateTime || 'missing'}, expected ${expected.startIso}`);
  if (Date.parse(live.end?.dateTime || '') !== Date.parse(expected.endIso)) problems.push(`${where}: end is ${live.end?.dateTime || 'missing'}, expected ${expected.endIso}`);
  if (checkGuests) {
    // Google lists the organizer as an attendee of its own invite; that is not a guest.
    const organizer = (live.organizer?.email || HOLD_ORGANIZER).toLowerCase();
    const liveGuests = emailSet((live.attendees || [])
      .map(a => String(a.email || ''))
      .filter(email => email && email.toLowerCase() !== organizer && email.toLowerCase() !== OPERATIONS_SENDER));
    const wanted = emailSet(expected.attendees.filter(email => email.toLowerCase() !== OPERATIONS_SENDER));
    if (JSON.stringify(liveGuests) !== JSON.stringify(wanted)) problems.push(`${where}: guests are [${liveGuests.join(', ')}], expected [${wanted.join(', ')}]`);
  }
  return problems;
}

/**
 * Read the invite back from Google Calendar (organizer event + one copy per
 * personal calendar) and validate it against the canonical invite. Returns the
 * list of problems; an unreadable event is a problem, never a pass.
 */
export async function validateGuestInviteReadback(
  expected: GuestInvite,
  eventIds: Record<string, string>,
  deps: HoldGoogleDeps,
): Promise<string[]> {
  const problems: string[] = [];
  const targets: Array<{ calendar: string; isOrganizer: boolean }> = [
    { calendar: HOLD_ORGANIZER, isOrganizer: true },
    ...expected.calendars.map(calendar => ({ calendar, isOrganizer: false })),
  ];
  const present = targets.filter(({ calendar }) => {
    if (eventIds[calendar]) return true;
    problems.push(`${calendar}: no Google event was recorded for this calendar`);
    return false;
  });
  const reads = await fetchGoogleEvents(present.map(({ calendar }) => ({ calendar, eventId: eventIds[calendar] })), deps);
  present.forEach(({ calendar, isOrganizer }, index) => {
    const fetched = reads[index];
    if (fetched.state === 'gone') problems.push(`${calendar}: the Google event is missing or cancelled`);
    else if (fetched.state === 'deferred') problems.push(`${calendar}: could not read the event back (${fetched.reason})`);
    else problems.push(...diffLiveInvite(expected, fetched.event, calendar, isOrganizer));
  });
  return problems;
}

export class GuestInviteValidationError extends Error {
  constructor(public readonly eventKey: string, public readonly problems: string[]) {
    super(`Google Calendar read-back does not match the canonical invite for ${eventKey}: ${problems.join('; ')}`);
  }
}
