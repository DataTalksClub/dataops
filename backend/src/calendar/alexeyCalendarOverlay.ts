import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CalendarOverlayItem, CalendarOverlayProvider } from './overlays';
import {
  CalendarOverlaySettings,
  DEFAULT_CALENDAR_OVERLAY_SETTINGS,
  getCalendarOverlaySettings,
} from '../db/calendar';

export interface AlexeyCalendarConfig {
  client?: DynamoDBDocumentClient;
  brokerUrl?: string;
  brokerCredential?: string;
  agent?: string;
  connectionId?: string;
  accountId?: string;
  settings?: CalendarOverlaySettings;
  includeAll?: boolean;
}

export interface DapierConnectionOption {
  connectionId: string;
  provider: string;
  title: string;
}

export interface AlexeyCalendarEventContext {
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

export function shouldFilterAlexeyCalendarEvent(
  summary: string | null | undefined,
  settings: Partial<CalendarOverlaySettings> = DEFAULT_CALENDAR_OVERLAY_SETTINGS,
  context?: AlexeyCalendarEventContext
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

let secretClient = new SecretsManagerClient({});
let fetcher: typeof fetch = fetch;

export function setAlexeyCalendarProviderClientsForTests(value: { secrets?: SecretsManagerClient; fetch?: typeof fetch }) {
  if (value.secrets) secretClient = value.secrets;
  fetcher = value.fetch || fetch;
}

export async function fetchDapierConnections(config?: AlexeyCalendarConfig): Promise<DapierConnectionOption[]> {
  const brokerUrl = (config?.brokerUrl || process.env.DAPIER_BASE_URL || 'https://dapier.dtcdev.click').replace(/\/$/, '');
  let credential = config?.brokerCredential || process.env.DAPIER_API_TOKEN;

  if (!credential) {
    const secretName = process.env.DAPIER_API_TOKEN_SECRET_NAME || 'personal-scheduler/dapier-api-token';
    try {
      const res = await secretClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (res.SecretString) {
        const parsed = JSON.parse(res.SecretString);
        credential = parsed.api_token || parsed.token;
      }
    } catch {
      // Secrets manager not configured or inaccessible
    }
  }

  const fallback: DapierConnectionOption[] = [
    { connectionId: 'google-calendar', provider: 'google', title: 'google-calendar' },
  ];

  if (!credential) {
    return fallback;
  }

  try {
    const res = await fetcher(`${brokerUrl}/api/agent/connections`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { connections?: Array<{ connection_id: string; provider: string; account_title?: string; verified_account_id?: string }> };
    if (!data.connections || !Array.isArray(data.connections)) return fallback;
    return data.connections.map((c) => ({
      connectionId: c.connection_id,
      provider: c.provider,
      title: `${c.connection_id}${c.verified_account_id || c.account_title ? ` (${c.verified_account_id || c.account_title})` : ''}`,
    }));
  } catch {
    return fallback;
  }
}

export function alexeyCalendarOverlay(config?: AlexeyCalendarConfig): CalendarOverlayProvider {
  return {
    name: 'alexey-calendar',
    async project(from: string, to: string): Promise<CalendarOverlayItem[]> {
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

      const brokerUrl = (config?.brokerUrl || process.env.DAPIER_BASE_URL || 'https://dapier.dtcdev.click').replace(/\/$/, '');
      const agent = config?.agent || process.env.DAPIER_AGENT || 'personal-scheduler';
      const connectionId = config?.connectionId || activeSettings.connectionId || process.env.DAPIER_CALENDAR_CONNECTION || 'google-calendar';
      let credential = config?.brokerCredential || process.env.DAPIER_API_TOKEN;


      if (!credential) {
        const secretName = process.env.DAPIER_API_TOKEN_SECRET_NAME || 'personal-scheduler/dapier-api-token';
        try {
          const res = await secretClient.send(new GetSecretValueCommand({ SecretId: secretName }));
          if (res.SecretString) {
            const parsed = JSON.parse(res.SecretString);
            credential = parsed.api_token || parsed.token;
          }
        } catch {
          // Secrets manager not configured or inaccessible
        }
      }

      if (!credential) {
        return [];
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
        return [];
      }

      if (!tokenRes.ok) return [];

      const tokenData = (await tokenRes.json()) as { access_token?: string; provider_account_id?: string };
      if (!tokenData.access_token) return [];

      // 2. Query Google Calendar API
      const timeMin = `${from}T00:00:00Z`;
      const timeMax = `${to}T23:59:59Z`;
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=2500`;

      let calRes: Response;
      try {
        calRes = await fetcher(url, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        return [];
      }

      if (!calRes.ok) return [];

      const calData = (await calRes.json()) as { items?: any[] };
      const events = calData.items || [];

      const includeAll = Boolean(config?.includeAll);
      const effectiveSettings: CalendarOverlaySettings = includeAll
        ? { ...activeSettings, filterNonSlotHours: false }
        : activeSettings;

      const result: CalendarOverlayItem[] = [];

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
        const context: AlexeyCalendarEventContext = {
          transparency: event.transparency,
          isAllDay,
          startIso,
          endIso,
        };
        if (shouldFilterAlexeyCalendarEvent(event.summary, effectiveSettings, context)) continue;

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

      // If includeAll (day schedule detail view) or showAvailableSlots is explicitly disabled,
      // return the individual calendar events.
      if (includeAll || effectiveSettings.showAvailableSlots === false) {
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
            provider: 'alexey-calendar',
            id: `alexey-calendar:${item.event.id}`,
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
        return result;
      }

      // Available slots mode (month calendar view):
      // 1. Project all-day blockers (vacations, conferences, flights, etc.)
      const allDayBlockers = validEvents.filter(
        (e) => e.isAllDay || e.slot === 'all-day' || (/vacation|holiday|flight|conference|trip/i.test(e.summary) && e.isSlotEvent),
      );

      for (const item of allDayBlockers) {
        result.push({
          provider: 'alexey-calendar',
          id: `alexey-calendar:${item.event.id}`,
          startDate: item.startDate,
          endDate: item.endDate,
          label: item.summary,
          category: 'Alexey',
          href: item.event.htmlLink || undefined,
          status: item.event.status || 'confirmed',
          startsAt: item.event.start?.dateTime || undefined,
          endsAt: item.event.end?.dateTime || undefined,
          slot: 'all-day',
          isSlotEvent: true,
          isAvailableSlot: false,
        });
      }

      // 2. Project available slots across all weekdays in the range
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

        // Check Midday Slot (12:30, operational window 11:30–14:00 Berlin time)
        const hasMiddayConflict = dayTimedEvents.some((e) => {
          if (!e.startIso || !e.endIso) return false;
          const startTime = formatBerlinTime(e.startIso);
          const endTime = formatBerlinTime(e.endIso);
          return startTime < '14:00' && endTime > '11:30';
        });

        if (!hasMiddayConflict) {
          result.push({
            provider: 'alexey-calendar',
            id: `alexey-slot:${curDate}:midday`,
            startDate: curDate,
            endDate: curDate,
            label: '12:30 Available',
            category: 'Available slot',
            slot: 'midday',
            isSlotEvent: true,
            isAvailableSlot: true,
          });
        }

        // Check Evening Slot (17:00, operational window 16:30–18:30 Berlin time)
        // Per SOP: offered on Monday and Tuesday only (US guests)
        if (dayOfWeek === 1 || dayOfWeek === 2) {
          const hasEveningConflict = dayTimedEvents.some((e) => {
            if (!e.startIso || !e.endIso) return false;
            const startTime = formatBerlinTime(e.startIso);
            const endTime = formatBerlinTime(e.endIso);
            return startTime < '18:30' && endTime > '16:30';
          });

          if (!hasEveningConflict) {
            result.push({
              provider: 'alexey-calendar',
              id: `alexey-slot:${curDate}:evening`,
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

      return result;
    },
  };
}
