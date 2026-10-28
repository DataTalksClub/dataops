import { fitsEventBytes } from './size';
/** Declarative event behavior, resolved from a Card's reviewed Template snapshot. */
export const EVENT_TRANSITIONS = ['propose', 'approve', 'reschedule', 'release'] as const;
export type EventTransition = typeof EVENT_TRANSITIONS[number];
export interface EventEmailTemplate {
  to: 'guests' | 'required';
  subject: string;
  body: string;
}
export interface EventPolicy {
  timeZone: string;
  durationMinutes: number;
  windows: Record<string, string>;
  expiresDays: number;
  titles: { proposed: string; approved: string };
  description: string;
  inviteText: string;
  guests: { proposal: boolean; approved: boolean; requiredEmails: string[]; leadMinutes: number };
  zoom: { enabled: boolean; url?: string };
  calendarAcceptance: { enabled: boolean; quorum: 'any' | 'all' };
  notifications: Record<EventTransition, { calendar: 'all' | 'none'; emails: EventEmailTemplate[] }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDERS = new Set(['title', 'topic', 'guestNames', 'date', 'time', 'timeZone', 'documentUrl', 'zoomUrl']);
const dict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Strict and shared by authored YAML, API edits, and runtime resolution. No type defaults. */
export function eventPolicyIssues(raw: unknown): string[] {
  const issues: string[] = [];
  if (!fitsEventBytes(raw, 64 * 1024)) issues.push('eventPolicy exceeds the 64 KiB UTF-8 byte budget');
  const fail = (path: string, message: string) => issues.push(`eventPolicy.${path} ${message}`);
  function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
    if (!dict(value)) { fail(path, 'must be an object'); return {}; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path ? path + '.' : ''}${key}`, 'is not supported');
    return value;
  }
  function text(value: unknown, path: string, required = true, max = 10000): value is string {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      fail(path, `must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`); return false;
    }
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) if (!PLACEHOLDERS.has(match[1])) fail(path, 'uses an unsupported placeholder');
    if (/[{}]/.test(value.replace(/\{[^{}]+\}/g, ''))) fail(path, 'has malformed placeholders');
    return true;
  }
  function integer(value: unknown, path: string, min: number, max: number) {
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail(path, `must be an integer from ${min} to ${max}`);
  }
  function boolean(value: unknown, path: string) { if (typeof value !== 'boolean') fail(path, 'must be a boolean'); }
  const p = object(raw, '', ['timeZone', 'durationMinutes', 'windows', 'expiresDays', 'titles', 'description', 'inviteText', 'guests', 'zoom', 'calendarAcceptance', 'notifications']);
  if (typeof p.timeZone !== 'string' || !p.timeZone.trim()) fail('timeZone', 'must be an IANA time zone');
  else { try { new Intl.DateTimeFormat('en', { timeZone: p.timeZone }); } catch { fail('timeZone', 'must be an IANA time zone'); } }
  integer(p.durationMinutes, 'durationMinutes', 1, 1440);
  integer(p.expiresDays, 'expiresDays', 1, 365);
  if (!dict(p.windows)) fail('windows', 'must be an object');
  else {
    if (Object.keys(p.windows).length > 20) fail('windows', 'must have at most 20 entries');
    for (const [key, value] of Object.entries(p.windows)) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('windows', 'must map slug names to HH:MM times');
    }
  }
  const titles = object(p.titles, 'titles', ['proposed', 'approved']);
  if (text(titles.proposed, 'titles.proposed', true, 500) && !titles.proposed.includes('(Proposal)')) fail('titles.proposed', 'must include (Proposal)');
  text(titles.approved, 'titles.approved', true, 500);
  if (typeof titles.approved === 'string' && titles.approved.includes('(Proposal)')) fail('titles.approved', 'must not include (Proposal)');
  text(p.description, 'description', false);
  text(p.inviteText, 'inviteText', false);
  const guests = object(p.guests, 'guests', ['proposal', 'approved', 'requiredEmails', 'leadMinutes']);
  boolean(guests.proposal, 'guests.proposal'); boolean(guests.approved, 'guests.approved');
  integer(guests.leadMinutes, 'guests.leadMinutes', 0, 120);
  if (!Array.isArray(guests.requiredEmails) || guests.requiredEmails.length > 20 || guests.requiredEmails.some(v => typeof v !== 'string' || !EMAIL.test(v))) fail('guests.requiredEmails', 'must contain at most 20 email addresses');
  const zoom = object(p.zoom, 'zoom', ['enabled', 'url']);
  boolean(zoom.enabled, 'zoom.enabled');
  if (zoom.enabled === true || zoom.url !== undefined) {
    try {
      const url = new URL(String(zoom.url));
      if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us'))) throw new Error();
    } catch { fail('zoom.url', 'must be an HTTPS Zoom URL without user information'); }
  }
  const acceptance = object(p.calendarAcceptance, 'calendarAcceptance', ['enabled', 'quorum']);
  boolean(acceptance.enabled, 'calendarAcceptance.enabled');
  if (acceptance.quorum !== 'any' && acceptance.quorum !== 'all') fail('calendarAcceptance.quorum', 'must be any or all');
  if (acceptance.enabled && !guests.proposal) fail('guests.proposal', 'must be true for calendar acceptance');
  const notifications = object(p.notifications, 'notifications', [...EVENT_TRANSITIONS]);
  for (const transition of EVENT_TRANSITIONS) {
    const n = object(notifications[transition], `notifications.${transition}`, ['calendar', 'emails']);
    if (n.calendar !== 'all' && n.calendar !== 'none') fail(`notifications.${transition}.calendar`, 'must be all or none');
    if (!Array.isArray(n.emails) || n.emails.length > 10) fail(`notifications.${transition}.emails`, 'must be a list of at most 10 templates');
    else n.emails.forEach((value, index) => {
      const path = `notifications.${transition}.emails.${index}`;
      const email = object(value, path, ['to', 'subject', 'body']);
      if (email.to !== 'guests' && email.to !== 'required') fail(`${path}.to`, 'must be guests or required');
      text(email.subject, `${path}.subject`, true, 500); text(email.body, `${path}.body`);
      if (typeof email.subject === 'string' && /[\r\n]/.test(email.subject)) fail(`${path}.subject`, 'must be a single line');
    });
  }
  return issues;
}

export function parseEventPolicy(raw: unknown): EventPolicy {
  const issues = eventPolicyIssues(raw);
  if (issues.length) throw new Error(issues.join('; '));
  return structuredClone(raw) as EventPolicy;
}

export type EventRenderValues = Record<'title' | 'topic' | 'guestNames' | 'date' | 'time' | 'timeZone' | 'documentUrl' | 'zoomUrl', string>;
/** Replacement values are never interpreted as templates. */
export function renderEventText(template: string, values: EventRenderValues): string {
  return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (!PLACEHOLDERS.has(name)) throw new Error('Unsupported event placeholder');
    return values[name as keyof EventRenderValues];
  });
}
