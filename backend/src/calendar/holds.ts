import { randomUUID } from 'crypto';

/**
 * Calendar holds: tentative event reservations (DataOps + Google) with a 7d
 * TTL. A hold occupies its operational window as hard occupancy while
 * tentative or confirmed; expiry releases it and surfaces follow-up for Orin
 * (never an automatic guest email).
 *
 * Domain vocabulary (locked by intake AC):
 * - status: tentative | confirmed | released | expired
 * - releaseReason: confirmed | expired | manual
 * - Google titles carry a `(Proposal)` prefix until confirmed.
 */

export const HOLD_TIME_ZONE = 'Europe/Berlin';

export type CalendarHoldStatus = 'tentative' | 'confirmed' | 'released' | 'expired';
export type CalendarHoldReleaseReason = 'confirmed' | 'expired' | 'manual';
export type CalendarHoldWindow = 'midday' | 'evening';

export const HOLD_PROPOSAL_PREFIX = '(Proposal) ';
export const HOLD_DEFAULT_DURATION_MINUTES = 60;
export const HOLD_DEFAULT_WINDOW: CalendarHoldWindow = 'evening';
export const HOLD_DEFAULT_TTL_DAYS = 7;

export const HOLD_WINDOW_START: Record<CalendarHoldWindow, string> = {
  midday: '12:00',
  evening: '16:30',
};

export interface CalendarHold {
  id: string;
  title: string;
  date: string;
  window: CalendarHoldWindow;
  durationMinutes: number;
  startIso: string;
  endIso: string;
  timeZone: typeof HOLD_TIME_ZONE;
  status: CalendarHoldStatus;
  googleTitle: string;
  googleEventIds: Record<string, string>;
  googleSync: { state: 'synced' | 'deferred'; reason?: string };
  cardId?: string;
  guestRef?: string;
  organizationId?: string;
  proposedAt: string;
  proposedBy: string;
  expiresAt: string;
  expiresDays: number;
  confirmedAt?: string;
  releasedAt?: string;
  releaseReason?: CalendarHoldReleaseReason;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarHoldInput {
  date: string;
  window?: unknown;
  duration?: unknown;
  durationMinutes?: unknown;
  title: string;
  cardId?: string;
  guestRef?: string;
  organizationId?: string;
  expiresDays?: unknown;
  googleCalendars?: unknown;
}

function lastSunday(year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const dow = last.getUTCDay();
  return last.getUTCDate() - dow;
}

/** Berlin UTC offset (+01:00 CET / +02:00 CEST) for a Berlin calendar date. */
export function berlinOffsetMinutes(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 3 || month > 10) return 60;
  if (month > 3 && month < 10) return 120;
  const boundary = lastSunday(year, month === 3 ? 2 : 9);
  if (month === 3) return day >= boundary ? 120 : 60;
  return day < boundary ? 120 : 60;
}

export function berlinOffsetSuffix(date: string): string {
  return berlinOffsetMinutes(date) === 120 ? '+02:00' : '+01:00';
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Berlin wall-clock interval for a hold, plus UTC instants. */
export function holdInterval(date: string, window: CalendarHoldWindow, durationMinutes: number): {
  startLocal: string;
  endLocal: string;
  startIso: string;
  endIso: string;
} {
  const startLocal = HOLD_WINDOW_START[window];
  const endLocal = addMinutes(startLocal, durationMinutes);
  const suffix = berlinOffsetSuffix(date);
  const startIso = new Date(`${date}T${startLocal}:00${suffix}`).toISOString();
  const endIso = new Date(`${date}T${endLocal}:00${suffix}`).toISOString();
  return { startLocal, endLocal, startIso, endIso };
}

export function proposalTitle(title: string): string {
  return title.startsWith(HOLD_PROPOSAL_PREFIX) ? title : `${HOLD_PROPOSAL_PREFIX}${title}`;
}

export function confirmedTitle(title: string): string {
  return title.startsWith(HOLD_PROPOSAL_PREFIX) ? title.slice(HOLD_PROPOSAL_PREFIX.length) : title;
}

export function parseHoldWindow(raw: unknown): CalendarHoldWindow {
  const v = String(raw ?? 'evening').trim().toLowerCase();
  if (v === 'midday' || v === 'evening') return v;
  throw new Error("Invalid window: propose supports only 'midday' or 'evening' (a hold reserves one operational window).");
}

export function parseHoldDurationMinutes(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return HOLD_DEFAULT_DURATION_MINUTES;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid duration: must be a positive integer number of minutes (usual values: 60, 90).');
  }
  return n;
}

export function parseHoldExpiresDays(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return HOLD_DEFAULT_TTL_DAYS;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid --expires-days: must be a positive integer number of days.');
  }
  return n;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseHoldDate(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!DATE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new Error('Invalid --date: must be formatted as YYYY-MM-DD.');
  }
  return v;
}

export function parseHoldTitle(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('A hold needs --title.');
  if (v.length > 200) throw new Error('Invalid --title: keep it under 200 characters.');
  return v;
}

export function parseHoldCalendars(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const ids = list.map((c) => String(c).trim()).filter(Boolean);
  if (!ids.length) return undefined;
  if (ids.length > 5) throw new Error('Too many Google calendars: at most 5.');
  return ids;
}

export function buildHold(input: CalendarHoldInput, actor: string, nowIso?: string): CalendarHold {
  const date = parseHoldDate(input.date);
  const window = parseHoldWindow(input.window);
  const durationMinutes = parseHoldDurationMinutes(input.duration ?? input.durationMinutes);
  const title = parseHoldTitle(input.title);
  const expiresDays = parseHoldExpiresDays(input.expiresDays);
  const { startIso, endIso } = holdInterval(date, window, durationMinutes);
  const now = nowIso || new Date().toISOString();
  const id = `hold_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return {
    id,
    title,
    date,
    window,
    durationMinutes,
    startIso,
    endIso,
    timeZone: HOLD_TIME_ZONE,
    status: 'tentative',
    googleTitle: proposalTitle(title),
    googleEventIds: {},
    googleSync: { state: 'deferred', reason: 'not-synced-yet' },
    ...(typeof input.cardId === 'string' && input.cardId.trim() ? { cardId: input.cardId.trim() } : {}),
    ...(typeof input.guestRef === 'string' && input.guestRef.trim() ? { guestRef: input.guestRef.trim() } : {}),
    ...(typeof input.organizationId === 'string' && input.organizationId.trim()
      ? { organizationId: input.organizationId.trim() }
      : {}),
    proposedAt: now,
    proposedBy: actor,
    expiresAt: new Date(Date.parse(now) + expiresDays * 86400000).toISOString(),
    expiresDays,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** A hold occupies its window while tentative or confirmed. */
export function isHoldActive(hold: { status: CalendarHoldStatus }): boolean {
  return hold.status === 'tentative' || hold.status === 'confirmed';
}

export function confirmHoldRecord(hold: CalendarHold, nowIso?: string): CalendarHold {
  if (hold.status !== 'tentative') throw Object.assign(new Error(`Only a tentative hold can be confirmed (now ${hold.status}).`), { code: 'hold_state' });
  const now = nowIso || new Date().toISOString();
  return {
    ...hold,
    status: 'confirmed',
    googleTitle: confirmedTitle(hold.title),
    confirmedAt: now,
    updatedAt: now,
    version: hold.version + 1,
  };
}

export function releaseHoldRecord(
  hold: CalendarHold,
  reason: CalendarHoldReleaseReason,
  nowIso?: string,
): CalendarHold {
  if (hold.status !== 'tentative' && hold.status !== 'confirmed') {
    throw Object.assign(new Error(`Only an active hold can be released (now ${hold.status}).`), { code: 'hold_state' });
  }
  const now = nowIso || new Date().toISOString();
  return {
    ...hold,
    status: reason === 'expired' ? 'expired' : 'released',
    releasedAt: now,
    releaseReason: reason,
    updatedAt: now,
    version: hold.version + 1,
  };
}

/** Tentative holds whose TTL has passed. Expiry never emails the guest. */
export function isHoldExpired(hold: CalendarHold, nowIso: string): boolean {
  return hold.status === 'tentative' && hold.expiresAt < nowIso;
}
