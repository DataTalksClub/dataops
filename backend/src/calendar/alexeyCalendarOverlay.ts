import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { CalendarOverlayItem, CalendarOverlayProvider } from './overlays';

export interface AlexeyCalendarConfig {
  brokerUrl?: string;
  brokerCredential?: string;
  agent?: string;
  connectionId?: string;
  accountId?: string;
}

export function shouldFilterAlexeyCalendarEvent(summary: string | null | undefined): boolean {
  if (!summary) return false;
  const s = summary.trim();
  if (!s) return false;

  // Standalone lunch and lunch-break blocks
  if (/^(lunch|lunchtime|lunch break|обед|обед на осткройце|нина обед)$/i.test(s)) return true;

  // Personal routines, household, chores, fitness, school, marketing campaign windows
  const routinePatterns = [
    /^morning\s*no$/i,
    /campaign window/i,
    /^домашка/i,
    /^меню$/i,
    /^ручки$/i,
    /^аркаша/i,
    /заплатить за квартиру/i,
    /brazilian nut/i,
    /restart claude/i,
    /^password$/i,
    /beat81/i,
    /^физио$/i,
    /zahnreinigung/i,
  ];

  return routinePatterns.some((pattern) => pattern.test(s));
}

function formatBerlinTime(isoString: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoString));
}

function formatBerlinDate(isoString: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoString));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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

export function alexeyCalendarOverlay(config?: AlexeyCalendarConfig): CalendarOverlayProvider {
  return {
    name: 'alexey-calendar',
    async project(from: string, to: string): Promise<CalendarOverlayItem[]> {
      const brokerUrl = (config?.brokerUrl || process.env.DAPIER_BASE_URL || 'https://dapier.dtcdev.click').replace(/\/$/, '');
      const agent = config?.agent || process.env.DAPIER_AGENT || 'personal-scheduler';
      const connectionId = config?.connectionId || process.env.DAPIER_CALENDAR_CONNECTION || 'google-calendar';
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

      const result: CalendarOverlayItem[] = [];

      for (const event of events) {
        if (event.status === 'cancelled') continue;
        if (shouldFilterAlexeyCalendarEvent(event.summary)) continue;

        const summary = (event.summary || '').trim() || 'Unavailable';
        let startDate: string;
        let endDate: string;
        let label: string;

        if (event.start?.date) {
          // All-day event
          startDate = event.start.date;
          endDate = adjustAllDayEndDate(startDate, event.end?.date);
          label = summary;
        } else if (event.start?.dateTime) {
          // Timed event
          startDate = formatBerlinDate(event.start.dateTime);
          endDate = formatBerlinDate(event.end?.dateTime || event.start.dateTime);
          const startTime = formatBerlinTime(event.start.dateTime);
          const endTime = event.end?.dateTime ? formatBerlinTime(event.end.dateTime) : '';
          label = endTime && endTime !== startTime ? `${startTime}–${endTime} ${summary}` : `${startTime} ${summary}`;
        } else {
          continue;
        }

        result.push({
          provider: 'alexey-calendar',
          id: `alexey-calendar:${event.id}`,
          startDate,
          endDate,
          label,
          category: 'Alexey',
          href: event.htmlLink || undefined,
          status: event.status || 'confirmed',
          startsAt: event.start?.dateTime || undefined,
          endsAt: event.end?.dateTime || undefined,
        });
      }

      return result;
    },
  };
}
