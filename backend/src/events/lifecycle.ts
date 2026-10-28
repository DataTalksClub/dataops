import { createHash } from 'node:crypto';
import { cardEventInterval } from '../calendar/cardEventTime';
import { EVENT_TRANSITIONS, parseEventPolicy, renderEventText, type EventPolicy, type EventRenderValues, type EventTransition } from './policy';

export type EventStatus = 'proposed' | 'approved' | 'released';
export interface EventHistoryEntry {
  transition: EventTransition;
  generation: number;
  operationKey: string;
  at: string;
  actor: string;
  note?: string;
  attendeeEmail?: string;
}
export interface EventOperation {
  key: string;
  fingerprint: string;
  transition: EventTransition;
  state: 'pending' | 'complete' | 'outcome-unknown';
  /** Fully resolved desired payload: a retry must never reread mutable Card values. */
  desired: {
    summary: string;
    description: string;
    location: string;
    attendees: string[];
    startIso: string;
    endIso: string;
    timeZone: string;
    sendUpdates: 'all' | 'none';
    emails: Array<{ to: string[]; subject: string; body: string }>;
  };
}
export interface EventRecord {
  id: string;
  cardId: string;
  templateId: string;
  templateVersion: number;
  version: number;
  generation: number;
  /** Changes after release; ordinary reschedules retain Google identity. */
  identityGeneration: number;
  status: EventStatus;
  date: string;
  time: string;
  timeZone: string;
  startIso: string;
  endIso: string;
  durationMinutes: number;
  expiresAt: string;
  policy: EventPolicy;
  renderValues: EventRenderValues;
  guestEmails: string[];
  googleEventIds: Record<string, string>;
  previousGoogleEventIds: Array<Record<string, string>>;
  history: EventHistoryEntry[];
  operations: EventOperation[];
}
export interface EventCommand {
  transition: EventTransition;
  operationKey: string;
  expectedVersion: number;
  actor: string;
  now: string;
  date?: string;
  time?: string;
  window?: string;
  /** Resolved from the reviewed Card snapshot on propose/reschedule only. */
  proposal?: {
    templateId: string;
    templateVersion: number;
    policy: EventPolicy;
    title: string;
    topic: string;
    guestNames: string;
    documentUrl: string;
    guestEmails: string[];
  };
  approval?: { via: 'calendar-accept'; attendeeEmail: string; acceptedEmails: string[]; generation: number };
}
export class EventConflictError extends Error {}
const emails = (values: string[]) => [...new Set(values.map(v => v.trim().toLowerCase()))].sort();

function fingerprint(command: EventCommand): string {
  // Actor, clock and expectedVersion are retry metadata, not operation intent.
  const { actor, now, expectedVersion, ...intent } = command;
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(canonical(intent))).digest('hex');
}

/** Pure transition planner. The persistence layer commits its result with a CAS transaction. */
export function planEventTransition(id: string, cardId: string, current: EventRecord | null, command: EventCommand): EventRecord {
  if (!EVENT_TRANSITIONS.includes(command.transition)) throw new Error('Unknown event transition');
  if (current && (current.id !== id || current.cardId !== cardId)) throw new EventConflictError('Event ownership does not match the Card');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(command.operationKey)) throw new Error('A valid operation key is required');
  if (!Number.isFinite(Date.parse(command.now))) throw new Error('A valid operation timestamp is required');
  const hash = fingerprint(command);
  const previous = current?.operations.find(o => o.key === command.operationKey);
  if (previous) {
    if (previous.fingerprint !== hash) throw new EventConflictError('Operation key was already used with different input');
    return structuredClone(current!);
  }
  if ((current?.version ?? 0) !== command.expectedVersion) throw new EventConflictError('Event changed; reload before retrying');
  if (current?.operations.some(o => o.state !== 'complete')) throw new EventConflictError('Finish or reconcile the pending event operation first');
  const transition = command.transition;
  if (!current && transition !== 'propose') throw new EventConflictError('Propose an event before changing it');
  if (current && transition === 'propose' && current.status !== 'released') throw new EventConflictError('An active event already exists; use reschedule');
  if (current?.status === 'released' && transition !== 'propose' && transition !== 'release') throw new EventConflictError('Released events must be proposed again');
  if (current && ((transition === 'approve' && current.status === 'approved') || (transition === 'release' && current.status === 'released'))) return structuredClone(current);
  if (command.approval && transition !== 'approve') throw new Error('Calendar acceptance can only approve');
  const isProposal = transition === 'propose' || transition === 'reschedule';
  if (!isProposal && (command.date !== undefined || command.time !== undefined || command.window !== undefined || command.proposal !== undefined)) throw new Error('Only propose or reschedule can change event time or policy');
  let next = structuredClone(current) as EventRecord;
  if (isProposal) {
    if (!command.proposal) throw new Error('The Card Template must supply event policy and render inputs');
    const proposal = command.proposal;
    const policy = parseEventPolicy(proposal.policy);
    if (command.time !== undefined && command.window !== undefined) throw new Error('Choose time or window, not both');
    const time = command.time ?? (command.window === undefined ? undefined : policy.windows[command.window]);
    if (!time) throw new Error('Choose a time or a Template-defined window');
    const interval = cardEventInterval(`${command.date} ${time}`, policy.durationMinutes, policy.timeZone);
    const guestEmails = emails(proposal.guestEmails);
    if (guestEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Guest email addresses must be explicit and valid');
    if (policy.calendarAcceptance.enabled && !guestEmails.length) throw new Error('Calendar acceptance requires at least one guest');
    const generation = (current?.generation ?? 0) + 1;
    const freshIdentity = !current || current.status === 'released';
    next = {
      id, cardId, templateId: proposal.templateId, templateVersion: proposal.templateVersion,
      version: (current?.version ?? 0) + 1, generation,
      identityGeneration: freshIdentity ? generation : current.identityGeneration,
      status: 'proposed', date: command.date!, time, ...interval,
      expiresAt: new Date(Date.parse(command.now) + policy.expiresDays * 86400000).toISOString(),
      policy, guestEmails,
      renderValues: {
        title: proposal.title, topic: proposal.topic, guestNames: proposal.guestNames,
        date: command.date!, time, timeZone: policy.timeZone, documentUrl: proposal.documentUrl,
        zoomUrl: policy.zoom.enabled ? policy.zoom.url! : '',
      },
      googleEventIds: freshIdentity ? {} : structuredClone(current.googleEventIds),
      previousGoogleEventIds: [ ...structuredClone(current?.previousGoogleEventIds || []), ...(current?.status === 'released' ? [structuredClone(current.googleEventIds)] : []) ],
      history: structuredClone(current?.history || []), operations: structuredClone(current?.operations || []),
    };
  } else {
    next.version++;
    next.status = transition === 'approve' ? 'approved' : 'released';
  }
  if (command.approval) {
    const email = command.approval.attendeeEmail.toLowerCase();
    const accepted = emails(command.approval.acceptedEmails);
    const quorumMet = next.policy.calendarAcceptance.quorum === 'all'
      ? next.guestEmails.length > 0 && next.guestEmails.every(guest => accepted.includes(guest))
      : next.guestEmails.some(guest => accepted.includes(guest));
    if (!quorumMet || !accepted.includes(email) || !next.policy.calendarAcceptance.enabled || next.generation !== command.approval.generation || !next.guestEmails.includes(email)) throw new EventConflictError('Calendar acceptance does not match the current proposal');
  }
  const { policy, renderValues } = next;
  const approved = next.status === 'approved';
  const inviteGuests = approved ? policy.guests.approved : policy.guests.proposal;
  const attendees = inviteGuests ? emails([...next.guestEmails, ...policy.guests.requiredEmails]) : [];
  const render = (text: string) => renderEventText(text, { ...renderValues, zoomUrl: approved ? renderValues.zoomUrl : '' });
  next.operations.push({
    key: command.operationKey, fingerprint: hash, transition, state: 'pending',
    desired: {
      summary: render(approved ? policy.titles.approved : policy.titles.proposed),
      description: [render(policy.description), render(policy.inviteText)].filter(Boolean).join('\n\n'),
      location: approved && policy.zoom.enabled ? policy.zoom.url! : '', attendees,
      startIso: new Date(Date.parse(next.startIso) - (approved ? policy.guests.leadMinutes : 0) * 60000).toISOString(),
      endIso: next.endIso, timeZone: next.timeZone,
      sendUpdates: policy.notifications[transition].calendar,
      emails: policy.notifications[transition].emails.map(email => ({
        to: email.to === 'guests' ? [...next.guestEmails] : emails(policy.guests.requiredEmails),
        subject: render(email.subject), body: render(email.body),
      })),
    },
  });
  next.history.push({
    transition, generation: next.generation, operationKey: command.operationKey, at: command.now, actor: command.actor,
    ...(command.approval ? { note: 'approved via calendar accept', attendeeEmail: command.approval.attendeeEmail.toLowerCase() } : {}),
  });
  return next;
}
