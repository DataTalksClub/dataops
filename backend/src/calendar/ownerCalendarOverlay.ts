import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CalendarOverlayConnection, CalendarOverlayItem, CalendarOverlayProjection, CalendarOverlayProvider } from './overlays';
import {
  CalendarOverlaySettings,
  DEFAULT_CALENDAR_OVERLAY_SETTINGS,
  getCalendarOverlaySettings,
} from '../db/calendar';
import {
  DAPIER_AGENT,
  DAPIER_BASE_URL,
  CONNECTION_OPERATOR_HINT,
  dapierTokenProblem,
  readDapierCredential,
  setDapierBrokerClientsForTests,
} from './dapierBroker';

export interface OwnerCalendarConfig {
  client?: DynamoDBDocumentClient;
  brokerUrl?: string;
  brokerCredential?: string;
  agent?: string;
  connectionId?: string;
  accountId?: string;
  settings?: CalendarOverlaySettings;
  includeAll?: boolean;
  /** Berlin date the overlay counts as today; defaults to the current one. */
  today?: string;
  /** Free contiguous block length in minutes. Default 60; workshops use 90. */
  durationMinutes?: number;
  /** Clock for call slots (tests); defaults to the current time. */
  now?: Date;
  /** Which operational window(s) to project. Default 'any'. */
  window?: SlotWindow;
}

export type SlotWindow = 'midday' | 'evening' | 'any' | 'call';

export const DEFAULT_SLOT_DURATION_MINUTES = 60;
export const DEFAULT_SLOT_WINDOW: SlotWindow = 'any';

/** Operational windows in Europe/Berlin, with preferred start for bookings. */
/**
 * Midday operational band. Preferred start depends on duration via preferStartFor:
 * 60-min podcast/webinar → 12:30 (block 12:30–13:30); 90-min workshop → 12:00.
 */
export const MIDDAY_WINDOW = { start: '11:30', end: '14:00', preferStart: '12:30' } as const;
/** Workshop-only midday anchor when guest asks for daytime (12:00 + 90). */
export const WORKSHOP_MIDDAY_WINDOW = { start: '11:30', end: '14:00', preferStart: '12:00' } as const;
/**
 * Evening band 16:30–18:30. Preferred start is 17:00 for podcasts/recordings
 * (and 60-min webinars → block 17:00–18:00); 16:30 is workshop-only.
 */
export const EVENING_WINDOW = { start: '16:30', end: '18:30', preferStart: '17:00' } as const;
/** Workshop-only evening anchor: 16:30 start + 90 min. Never the podcast default. */
export const WORKSHOP_WINDOW = { start: '16:30', end: '18:30', preferStart: '16:30' } as const;
/** Workshop duration (minutes). 90 = workshop only; 60 = webinar AND podcast. */
export const WORKSHOP_DURATION_MINUTES = 90;

/**
 * Call hours (Europe/Berlin): the window Alexey's public Calendly 30-minute
 * event offers, weekdays only. Call slots sit on a 30-minute grid and are
 * separate from the event windows above: Lunch and Busy blocks only mark time
 * for event slots, so they (like every other non-free event) block calls.
 */
export const CALL_WINDOW = { start: '11:00', end: '16:30' } as const;
export const CALL_GRID_MINUTES = 30;
export const DEFAULT_CALL_DURATION_MINUTES = 30;

export function parseDurationMinutes(raw: unknown, def = DEFAULT_SLOT_DURATION_MINUTES): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid duration: must be a positive integer number of minutes.');
  }
  return n;
}

export function parseSlotWindow(raw: unknown, def: SlotWindow = DEFAULT_SLOT_WINDOW): SlotWindow {
  if (raw === undefined || raw === null || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (v === 'midday' || v === 'evening' || v === 'any' || v === 'call') return v;
  throw new Error("Invalid window: must be one of 'evening', 'midday', 'any', 'call'.");
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

function windowDef(window: 'midday' | 'evening') {
  return window === 'midday' ? MIDDAY_WINDOW : EVENING_WINDOW;
}

/**
 * Preferred start for a booking: the evening 90-min shape is the workshop
 * (16:30 start); everything else anchors at the window preferStart
 * (evening podcast/recording 17:00, midday podcast/webinar 12:30).
 */
export function preferStartFor(window: 'midday' | 'evening', durationMinutes: number): string {
  if (window === 'evening' && durationMinutes === WORKSHOP_DURATION_MINUTES) {
    return WORKSHOP_WINDOW.preferStart;
  }
  if (window === 'midday' && durationMinutes === WORKSHOP_DURATION_MINUTES) {
    return WORKSHOP_MIDDAY_WINDOW.preferStart;
  }
  return windowDef(window).preferStart;
}

export function windowFitsDuration(window: 'midday' | 'evening', durationMinutes: number): boolean {
  const def = windowDef(window);
  return durationMinutes <= timeToMinutes(def.end) - timeToMinutes(def.start);
}

/**
 * Availability = a contiguous free block of at least `durationMinutes`
 * inside the chosen window. The preferred block starts at the window's
 * preferred start (midday podcast/webinar 12:30, evening 17:00), so a
 * 60-min evening booking needs 17:00–18:00 free. The 90-min evening shape
 * is the workshop and anchors at 16:30 (needs 16:30–18:00 free).
 */
export function isWindowFreeForDuration(
  window: 'midday' | 'evening',
  busy: Array<{ start: string; end: string }>,
  durationMinutes: number = DEFAULT_SLOT_DURATION_MINUTES,
): boolean {
  if (!windowFitsDuration(window, durationMinutes)) return false;
  const def = windowDef(window);
  const preferMinutes = timeToMinutes(preferStartFor(window, durationMinutes));
  const blockStart = minutesToTime(preferMinutes);
  const blockEnd = minutesToTime(preferMinutes + durationMinutes);
  // The preferred block must itself sit inside the operational band.
  if (blockStart < def.start || blockEnd > def.end) return false;
  for (const b of busy) {
    if (b.start < blockEnd && b.end > blockStart) return false;
  }
  return true;
}

/**
 * Open call start times (Berlin HH:MM) for one day: every grid start in the
 * call hours whose `durationMinutes` block overlaps no busy interval.
 */
export function openCallStarts(
  busy: Array<{ start: string; end: string }>,
  durationMinutes: number = DEFAULT_CALL_DURATION_MINUTES,
): string[] {
  const out: string[] = [];
  const first = timeToMinutes(CALL_WINDOW.start);
  const last = timeToMinutes(CALL_WINDOW.end);
  for (let m = first; m + durationMinutes <= last; m += CALL_GRID_MINUTES) {
    const start = minutesToTime(m);
    const end = minutesToTime(m + durationMinutes);
    if (!busy.some((b) => b.start < end && b.end > start)) out.push(start);
  }
  return out;
}

/** Busy Berlin HH:MM intervals clipped to a window, for duration checks. */
export function busyIntervalsInWindow(
  window: 'midday' | 'evening',
  events: Array<{ startIso?: string; endIso?: string }>,
): Array<{ start: string; end: string }> {
  const def = windowDef(window);
  const out: Array<{ start: string; end: string }> = [];
  for (const e of events) {
    if (!e.startIso || !e.endIso) continue;
    try {
      const s = formatBerlinTime(e.startIso);
      const t = formatBerlinTime(e.endIso);
      if (s < def.end && t > def.start) {
        out.push({ start: s < def.start ? def.start : s, end: t > def.end ? def.end : t });
      }
    } catch {
      // Unparseable times count as blocking elsewhere; ignore here.
    }
  }
  return out;
}

export interface DapierConnectionOption {
  connectionId: string;
  provider: string;
  title: string;
}

export interface OwnerCalendarEventContext {
  transparency?: string;
  isAllDay?: boolean;
  startIso?: string;
  endIso?: string;
}

export function formatBerlinTime(isoString: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoString));
}

export function formatBerlinDate(isoString: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoString));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function berlinToday(): string {
  return formatBerlinDate(new Date().toISOString());
}

/**
 * The part of a range the owner's calendar is read for: today onward, in
 * Berlin time. Past days need no open slots, so the calendar is not read for
 * them; a range wholly in the past gives null.
 */
export function ownerCalendarRange(from: string, to: string, today = berlinToday()): { from: string; to: string } | null {
  const start = from < today ? today : from;
  return start > to ? null : { from: start, to };
}

export function eachDayOfInterval(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function overlapsOperationalSlotWindow(startIso: string, endIso: string): boolean {
  try {
    const startTime = formatBerlinTime(startIso);
    const endTime = formatBerlinTime(endIso);
    // Midday window: 11:30 to 14:00 Berlin time (centering on 12:30 lunch slot)
    const overlapsMidday = startTime < '14:00' && endTime > '11:30';
    // Evening window: 16:30 to 18:30 Berlin time (centering on 17:00 evening slot)
    const overlapsEvening = startTime < '18:30' && endTime > '16:30';
    return overlapsMidday || overlapsEvening;
  } catch {
    return true;
  }
}

export function determineSlotType(
  startIso?: string,
  endIso?: string,
  isAllDay?: boolean,
): 'all-day' | 'midday' | 'evening' | 'outside' {
  if (isAllDay) return 'all-day';
  if (!startIso || !endIso) return 'outside';
  try {
    const startTime = formatBerlinTime(startIso);
    const endTime = formatBerlinTime(endIso);
    if (startTime < '14:00' && endTime > '11:30') return 'midday';
    if (startTime < '18:30' && endTime > '16:30') return 'evening';
    return 'outside';
  } catch {
    return 'outside';
  }
}

export function shouldFilterOwnerCalendarEvent(
  summary: string | null | undefined,
  settings: Partial<CalendarOverlaySettings> = DEFAULT_CALENDAR_OVERLAY_SETTINGS,
  context?: OwnerCalendarEventContext
): boolean {
  const s = (summary || '').trim();

  const filterLunch = settings.filterLunch ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterLunch;
  const filterRoutines = settings.filterRoutines ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterRoutines;
  const filterFitness = settings.filterFitness ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterFitness;
  const filterCampaigns = settings.filterCampaigns ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterCampaigns;
  const filterBusy = settings.filterBusy ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterBusy;
  const filterNonSlotHours = settings.filterNonSlotHours ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterNonSlotHours;
  const filterDtcPlaceholders = settings.filterDtcPlaceholders ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterDtcPlaceholders;
  const filterTransparent = settings.filterTransparent ?? DEFAULT_CALENDAR_OVERLAY_SETTINGS.filterTransparent;
  const customKeywords = settings.customKeywords || [];

  // Standalone DTC event placeholders in Google Calendar (e.g. "DTC event block")
  if (filterDtcPlaceholders && /^(dtc event block|datatalks\.club event|dtc event)$/i.test(s)) {
    return true;
  }

  // Standalone lunch and lunch-break blocks
  if (filterLunch && /^(lunch|lunchtime|lunch break|обед|обед на осткройце|нина обед)$/i.test(s)) {
    return true;
  }

  // Personal routines, household, chores, school, birthdays
  if (filterRoutines) {
    const routinePatterns = [
      /^morning\s*no$/i,
      /^домашка/i,
      /^меню$/i,
      /^ручки$/i,
      /^аркаша/i,
      /заплатить за квартиру/i,
      /brazilian nut/i,
      /restart claude/i,
      /^password$/i,
      /birthday|др$/i,
    ];
    if (routinePatterns.some((pattern) => pattern.test(s))) return true;
  }

  // Fitness / health
  if (filterFitness) {
    const fitnessPatterns = [
      /beat81/i,
      /^физио$/i,
      /zahnreinigung/i,
    ];
    if (fitnessPatterns.some((pattern) => pattern.test(s))) return true;
  }

  // Marketing campaign windows
  if (filterCampaigns && /campaign window/i.test(s)) {
    return true;
  }

  // Busy blocks
  if (filterBusy && /^(busy|занято|busy block|focus|focus time)$/i.test(s)) {
    return true;
  }

  // Custom keywords / phrases (case-insensitive substring match)
  if (customKeywords.length > 0 && s) {
    const lower = s.toLowerCase();
    for (const kw of customKeywords) {
      const trimmed = kw.trim().toLowerCase();
      if (trimmed && lower.includes(trimmed)) {
        return true;
      }
    }
  }

  // Transparent (free/non-blocking) events (unless flights/conferences/vacations)
  if (filterTransparent && context?.transparency === 'transparent') {
    if (!/(flight|conference|vacation|trip)/i.test(s)) {
      return true;
    }
  }

  // Filter out events outside operational event windows (Midday 11:30–14:00 and Evening 16:30–18:30)
  // All-day blockers (Vacation, Conference, Travel) are always kept.
  if (filterNonSlotHours && context && !context.isAllDay) {
    if (context.startIso && context.endIso && !overlapsOperationalSlotWindow(context.startIso, context.endIso)) {
      return true;
    }
  }

  return false;
}

function adjustAllDayEndDate(start: string, end?: string): string {
  if (!end || end <= start) return start;
  // Google all-day end date is exclusive, so subtract 1 day
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const adjusted = d.toISOString().slice(0, 10);
  return adjusted < start ? start : adjusted;
}

let fetcher: typeof fetch = fetch;

export function setOwnerCalendarProviderClientsForTests(value: {
  readSecret?: Parameters<typeof setDapierBrokerClientsForTests>[0]['readSecret'];
  fetch?: typeof fetch;
}) {
  if (value.readSecret) setDapierBrokerClientsForTests({ readSecret: value.readSecret });
  fetcher = value.fetch || fetch;
}

export async function fetchDapierConnections(config?: OwnerCalendarConfig): Promise<{ connections: DapierConnectionOption[]; connectionProblem?: string }> {
  const brokerUrl = (config?.brokerUrl || DAPIER_BASE_URL).replace(/\/$/, '');
  const { credential, problem } = await readDapierCredential(config?.brokerCredential);

  if (!credential) {
    return { connections: [], connectionProblem: problem };
  }

  try {
    const res = await fetcher(`${brokerUrl}/api/agent/connections`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { connections: [], connectionProblem: dapierTokenProblem(res.status, 'calendar discovery', config?.agent) };
    const data = (await res.json()) as { connections?: Array<{ connection_id: string; provider: string; agent: string; operations: string[]; status: string; scopes?: string[]; granted_scopes?: string[]; account_title?: string; verified_account_id?: string }> };
    if (!Array.isArray(data.connections)) return { connections: [], connectionProblem: 'Dapier returned an invalid calendar connection list.' };
    const writableScopes = new Set(['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.owned']);
    const connections = data.connections.filter((c) =>
      c.provider === 'google' && c.status === 'connected' &&
      c.agent === (config?.agent || DAPIER_AGENT) && c.operations?.includes('use') &&
      (c.granted_scopes?.length ? c.granted_scopes : c.scopes || []).some((scope) => writableScopes.has(scope)),
    ).map((c) => ({
      connectionId: c.connection_id,
      provider: c.provider,
      title: `${c.connection_id}${c.verified_account_id || c.account_title ? ` (${c.verified_account_id || c.account_title})` : ''}`,
    }));
    return { connections, ...(!connections.length ? { connectionProblem: `No writable Google Calendar connections are available to agent "${config?.agent || DAPIER_AGENT}". A Dapier operator must connect Google Calendar and grant this machine identity and agent the \`use\` operation.` } : {}) };
  } catch {
    return { connections: [], connectionProblem: 'The calendar broker could not be reached to list Google Calendar connections.' };
  }
}

export function ownerCalendarOverlay(config?: OwnerCalendarConfig): CalendarOverlayProvider {
  return {
    name: 'owner-calendar',
    async project(requestedFrom: string, requestedTo: string): Promise<CalendarOverlayProjection> {
      const blank = (connection: CalendarOverlayConnection): CalendarOverlayProjection => ({ items: [], connection });
      const connected = (items: CalendarOverlayItem[]): CalendarOverlayProjection => ({ items, connection: { state: 'connected' } });
      const range = ownerCalendarRange(requestedFrom, requestedTo, config?.today);
      // Callers leave this source out for a past range; if one asks anyway,
      // there is nothing to read rather than a broker call.
      if (!range) return connected([]);
      const { from, to } = range;
      let activeSettings = config?.settings;
      if (!activeSettings && config?.client) {
        try {
          activeSettings = await getCalendarOverlaySettings(config.client);
        } catch {
          // fallback to defaults if table query fails
        }
      }
      if (!activeSettings) {
        activeSettings = DEFAULT_CALENDAR_OVERLAY_SETTINGS;
      }

      const brokerUrl = (config?.brokerUrl || DAPIER_BASE_URL).replace(/\/$/, '');
      const agent = config?.agent || DAPIER_AGENT;
      const connectionId = (config?.connectionId ?? activeSettings.connectionId).trim();
      if (!connectionId) return blank({ state: 'not-configured', reason: `No Dapier calendar connection selected. ${CONNECTION_OPERATOR_HINT}` });
      const { credential, problem } = await readDapierCredential(config?.brokerCredential);

      if (!credential) {
        return blank({ state: 'not-configured', reason: problem });
      }

      // 1. Obtain Google access token from Dapier
      let tokenRes: Response;
      try {
        tokenRes = await fetcher(`${brokerUrl}/api/agent/token`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ connection_id: connectionId, agent }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        return blank({ state: 'unavailable', reason: 'The calendar broker could not be reached.' });
      }

      if (!tokenRes.ok) {
        return blank({ state: 'unavailable', reason: dapierTokenProblem(tokenRes.status, connectionId, agent) });
      }

      const tokenData = (await tokenRes.json()) as { access_token?: string; provider_account_id?: string };
      if (!tokenData.access_token) {
        return blank({ state: 'unavailable', reason: `Calendar connection "${connectionId}" returned no access token.` });
      }

      // 2. Query Google Calendar API
      const timeMin = `${from}T00:00:00Z`;
      const timeMax = `${to}T23:59:59Z`;
      const ownerCalendar = 'alexey.s.grigoriev@gmail.com';
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ownerCalendar)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=2500`;

      let calRes: Response;
      try {
        calRes = await fetcher(url, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        return blank({ state: 'unavailable', reason: 'Google Calendar could not be reached.' });
      }

      if (!calRes.ok) {
        return blank({ state: 'unavailable', reason: `Google Calendar returned HTTP ${calRes.status}.` });
      }

      const calData = (await calRes.json()) as { items?: any[] };
      const events = calData.items || [];

      const includeAll = Boolean(config?.includeAll);
      const effectiveSettings: CalendarOverlaySettings = includeAll
        ? { ...activeSettings, filterNonSlotHours: false }
        : activeSettings;

      const result: CalendarOverlayItem[] = [];

      if (config?.window === 'call') {
        const callDuration = config.durationMinutes ?? DEFAULT_CALL_DURATION_MINUTES;
        const nowIso = (config.now ?? new Date()).toISOString();
        const nowDate = formatBerlinDate(nowIso);
        const nowTime = formatBerlinTime(nowIso);
        for (const curDate of eachDayOfInterval(from, to)) {
          const dow = new Date(`${curDate}T12:00:00Z`).getUTCDay();
          if (dow === 0 || dow === 6) continue;
          // Calls ignore the Lunch/Busy/routine filters: every event that is
          // not marked free (transparent) and not cancelled blocks the call.
          const busy: Array<{ start: string; end: string }> = [];
          let dayBlocked = false;
          for (const e of events) {
            if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
            if (e.start?.date) {
              const endDate = adjustAllDayEndDate(e.start.date, e.end?.date);
              if (e.start.date <= curDate && curDate <= endDate) dayBlocked = true;
              continue;
            }
            if (!e.start?.dateTime) continue;
            const sDate = formatBerlinDate(e.start.dateTime);
            const eDate = formatBerlinDate(e.end?.dateTime || e.start.dateTime);
            if (curDate < sDate || curDate > eDate) continue;
            busy.push({
              start: sDate < curDate ? '00:00' : formatBerlinTime(e.start.dateTime),
              end: eDate > curDate || !e.end?.dateTime ? '24:00' : formatBerlinTime(e.end.dateTime),
            });
          }
          if (dayBlocked) continue;
          for (const start of openCallStarts(busy, callDuration)) {
            if (curDate < nowDate || (curDate === nowDate && start <= nowTime)) continue;
            result.push({
              provider: 'owner-calendar',
              id: `owner-slot:${curDate}:call:${start}`,
              startDate: curDate,
              endDate: curDate,
              label: `${start} Available`,
              category: 'Available slot',
              slot: 'call',
              isSlotEvent: true,
              isAvailableSlot: true,
            });
          }
        }
        return connected(result);
      }

      interface ProcessedEvent {
        event: any;
        isAllDay: boolean;
        startDate: string;
        endDate: string;
        summary: string;
        slot: 'midday' | 'evening' | 'all-day' | 'outside';
        isSlotEvent: boolean;
        startIso?: string;
        endIso?: string;
      }

      const validEvents: ProcessedEvent[] = [];

      for (const event of events) {
        if (event.status === 'cancelled') continue;
        const isAllDay = !!event.start?.date;
        const startIso = event.start?.dateTime || event.start?.date;
        const endIso = event.end?.dateTime || event.end?.date;
        const context: OwnerCalendarEventContext = {
          transparency: event.transparency,
          isAllDay,
          startIso,
          endIso,
        };
        if (shouldFilterOwnerCalendarEvent(event.summary, effectiveSettings, context)) continue;

        const summary = (event.summary || '').trim() || '(No title)';
        let startDate: string;
        let endDate: string;

        if (event.start?.date) {
          // All-day event
          startDate = event.start.date;
          endDate = adjustAllDayEndDate(startDate, event.end?.date);
        } else if (event.start?.dateTime) {
          // Timed event
          startDate = formatBerlinDate(event.start.dateTime);
          endDate = formatBerlinDate(event.end?.dateTime || event.start.dateTime);
        } else {
          continue;
        }

        const slot = determineSlotType(startIso, endIso, isAllDay);
        const isSlotEvent = slot !== 'outside';

        validEvents.push({
          event,
          isAllDay,
          startDate,
          endDate,
          summary,
          slot,
          isSlotEvent,
          startIso,
          endIso,
        });
      }

      // The day schedule (includeAll) lists the individual events so a planner
      // can see why a slot is taken. The calendar grid never shows them.
      if (includeAll) {
        for (const item of validEvents) {
          let label: string;
          if (item.isAllDay) {
            label = item.summary;
          } else {
            const startTime = formatBerlinTime(item.startIso!);
            const endTime = item.endIso ? formatBerlinTime(item.endIso) : '';
            label = endTime && endTime !== startTime ? `${startTime}–${endTime} ${item.summary}` : `${startTime} ${item.summary}`;
          }

          result.push({
            provider: 'owner-calendar',
            id: `owner-calendar:${item.event.id}`,
            startDate: item.startDate,
            endDate: item.endDate,
            label,
            category: 'Alexey',
            href: item.event.htmlLink || undefined,
            status: item.event.status || 'confirmed',
            startsAt: item.event.start?.dateTime || undefined,
            endsAt: item.event.end?.dateTime || undefined,
            slot: item.slot,
            isSlotEvent: item.isSlotEvent,
            isAvailableSlot: false,
          });
        }
        return connected(result);
      }

      // Calendar grid: Alexey's personal events (vacations, flights, meetings)
      // are never projected as items. They only decide which slots are open.
      // All-day blockers (vacations, conferences, flights, etc.) close the whole day.
      const allDayBlockers = validEvents.filter(
        (e) => e.isAllDay || e.slot === 'all-day' || (/vacation|holiday|flight|conference|trip/i.test(e.summary) && e.isSlotEvent),
      );

      // Project available slots across all weekdays in the range.
      // Availability = a contiguous free block of at least `durationMinutes`
      // inside the chosen window(s), anchored at the preferred start
      // (midday podcast/webinar 12:30, evening 17:00). The 90-min evening
      // workshop shape anchors at 16:30 (needs 16:30–18:00 free).
      const durationMinutes = config?.durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES;
      const window = config?.window ?? DEFAULT_SLOT_WINDOW;
      const wantMidday = window === 'any' || window === 'midday';
      const wantEvening = window === 'any' || window === 'evening';
      const timedEvents = validEvents.filter((e) => !allDayBlockers.includes(e));
      const dates = eachDayOfInterval(from, to);

      for (const curDate of dates) {
        const d = new Date(`${curDate}T12:00:00Z`);
        const dayOfWeek = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat

        // Per SOP: "Never schedule anything on weekend"
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        // If covered by an all-day blocker, no slots available on this day
        const isBlockedAllDay = allDayBlockers.some((b) => b.startDate <= curDate && curDate <= b.endDate);
        if (isBlockedAllDay) continue;

        // Timed events on this day
        const dayTimedEvents = timedEvents.filter((e) => e.startDate <= curDate && curDate <= e.endDate);

        // Check Midday Slot (operational window 11:30–14:00, preferred start 12:30 Berlin time)
        if (wantMidday) {
          const busy = busyIntervalsInWindow('midday', dayTimedEvents);
          if (isWindowFreeForDuration('midday', busy, durationMinutes)) {
            result.push({
              provider: 'owner-calendar',
              id: `owner-slot:${curDate}:midday`,
              startDate: curDate,
              endDate: curDate,
              label: '12:30 Available',
              category: 'Available slot',
              slot: 'midday',
              isSlotEvent: true,
              isAvailableSlot: true,
            });
          }
        }

        // Check Evening Slot (operational band 16:30–18:30, podcast/recording
        // preferred start 17:00; 90-min workshop shape anchors at 16:30)
        // Per SOP: offered on Monday and Tuesday only (US guests)
        if (wantEvening && (dayOfWeek === 1 || dayOfWeek === 2)) {
          const busy = busyIntervalsInWindow('evening', dayTimedEvents);
          if (isWindowFreeForDuration('evening', busy, durationMinutes)) {
            result.push({
              provider: 'owner-calendar',
              id: `owner-slot:${curDate}:evening`,
              startDate: curDate,
              endDate: curDate,
              label: '17:00 Available',
              category: 'Available slot',
              slot: 'evening',
              isSlotEvent: true,
              isAvailableSlot: true,
            });
          }
        }
      }

      return connected(result);
    },
  };
}
