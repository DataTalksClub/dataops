import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  alexeyCalendarOverlay,
  setAlexeyCalendarProviderClientsForTests,
  shouldFilterAlexeyCalendarEvent,
} from '../src/calendar/alexeyCalendarOverlay';
import { resetCalendarOverlayProvidersForTests } from '../src/calendar/overlays';

describe('Alexey calendar overlay and filtering', () => {
  beforeEach(() => {
    resetCalendarOverlayProvidersForTests();
  });

  describe('shouldFilterAlexeyCalendarEvent', () => {
    it('filters out lunch placeholders and routine personal tasks per SOP and guidelines', () => {
      const filtered = [
        'Lunch',
        'lunch',
        'LUNCH',
        'Lunchtime',
        'Lunch break',
        'Обед',
        'Обед на осткройце',
        'Нина обед',
        'Morning no',
        'morning  no',
        'Домашка и дневник',
        'Меню',
        'Ручки',
        'Аркаша Лара',
        'Аркаша Я',
        'Заплатить за квартиру и электричество',
        'Brazilian nut',
        'Restart Claude',
        'Password',
        'HYBRID: Power (Dynamic Power) 🇬🇧 - BEAT81 - BEAT81 - Kulturbrauerei CIRCUIT',
        'BEAT81 - workout',
        'GLM-5.3-Flash campaign window',
        'Физио',
        'Zahnreinigung',
      ];

      for (const title of filtered) {
        assert.equal(
          shouldFilterAlexeyCalendarEvent(title),
          true,
          `Expected "${title}" to be filtered out`,
        );
      }
    });

    it('keeps real meetings, operational events, travel, and availability blocks', () => {
      const kept = [
        'Tejas at DataTalks.Club Podcast',
        'Building AI Evaluations You Can Actually Trust',
        'Alexey Grigorev<>Daniel Kravtsov',
        'Alexey / Elias',
        'Amit + Alexey lunch',
        'Busy',
        'No',
        'Vacation',
        'Flight to Helsinki (AY 1438)',
        'Train to Berlin Potsdamer Platz',
        'AI R&D Lab Meetup - AI-Native Development: Specifications, Loop and Graph Engineering',
        'ML Zoomcamp 2026 Pre-Course Live Q&A',
        null,
        undefined,
        '',
        '   ',
      ];

      for (const title of kept) {
        assert.equal(
          shouldFilterAlexeyCalendarEvent(title),
          false,
          `Expected "${title}" to be kept`,
        );
      }
    });
  });

  describe('alexeyCalendarOverlay provider', () => {
    it('returns empty list gracefully if no token or credentials are available', async () => {
      delete process.env.DAPIER_API_TOKEN;
      delete process.env.DAPIER_API_TOKEN_SECRET_NAME;
      setAlexeyCalendarProviderClientsForTests({
        secrets: {
          send: async () => {
            throw new Error('Secret not found');
          },
        } as any,
      });

      const provider = alexeyCalendarOverlay({ brokerCredential: '' });
      const items = await provider.project('2026-10-01', '2026-10-31');
      assert.deepEqual(items, []);
    });

    it('fetches Google access token via Dapier and projects filtered events in Berlin time', async () => {
      const calls: { url: string; headers: any }[] = [];
      const mockFetch: typeof fetch = async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, headers: init.headers });

        if (url.endsWith('/api/agent/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'synthetic-google-token-123',
              provider_account_id: 'alexey.s.grigoriev@gmail.com',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('googleapis.com/calendar/v3/calendars/primary/events')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'evt-1',
                  summary: 'Tejas at DataTalks.Club Podcast',
                  status: 'confirmed',
                  htmlLink: 'https://calendar.google.com/event?eid=evt1',
                  start: { dateTime: '2026-10-13T12:25:00+02:00' },
                  end: { dateTime: '2026-10-13T13:30:00+02:00' },
                },
                {
                  id: 'evt-2',
                  summary: 'Lunch',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T12:00:00+02:00' },
                  end: { dateTime: '2026-10-13T14:00:00+02:00' },
                },
                {
                  id: 'evt-3',
                  summary: 'No',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T14:00:00+02:00' },
                  end: { dateTime: '2026-10-13T18:00:00+02:00' },
                },
                {
                  id: 'evt-4',
                  summary: 'Домашка и дневник',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T17:00:00+02:00' },
                  end: { dateTime: '2026-10-13T18:00:00+02:00' },
                },
                {
                  id: 'evt-5',
                  summary: 'Flight to Helsinki',
                  status: 'confirmed',
                  start: { date: '2026-10-17' },
                  end: { date: '2026-10-18' },
                },
                {
                  id: 'evt-6',
                  summary: 'Cancelled meeting',
                  status: 'cancelled',
                  start: { dateTime: '2026-10-13T10:00:00+02:00' },
                  end: { dateTime: '2026-10-13T11:00:00+02:00' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response('Not found', { status: 404 });
      };

      setAlexeyCalendarProviderClientsForTests({ fetch: mockFetch });

      const provider = alexeyCalendarOverlay({
        brokerUrl: 'https://dapier.dtcdev.click',
        brokerCredential: 'dap_synthetic_token',
        agent: 'personal-scheduler',
        connectionId: 'google-calendar',
      });

      const items = await provider.project('2026-10-01', '2026-10-31');

      assert.equal(items.length, 3);

      // Event 1: Podcast (timed)
      assert.equal(items[0].id, 'alexey-calendar:evt-1');
      assert.equal(items[0].startDate, '2026-10-13');
      assert.equal(items[0].endDate, '2026-10-13');
      assert.equal(items[0].label, '12:25–13:30 Tejas at DataTalks.Club Podcast');
      assert.equal(items[0].category, 'Alexey');
      assert.equal(items[0].provider, 'alexey-calendar');
      assert.equal(items[0].href, 'https://calendar.google.com/event?eid=evt1');

      // Event 2: "No" (unavailability block, kept!)
      assert.equal(items[1].id, 'alexey-calendar:evt-3');
      assert.equal(items[1].startDate, '2026-10-13');
      assert.equal(items[1].label, '14:00–18:00 No');
      assert.equal(items[1].category, 'Alexey');

      // Event 3: Flight (all-day adjusted end date)
      assert.equal(items[2].id, 'alexey-calendar:evt-5');
      assert.equal(items[2].startDate, '2026-10-17');
      assert.equal(items[2].endDate, '2026-10-17');
      assert.equal(items[2].label, 'Flight to Helsinki');
      assert.equal(items[2].category, 'Alexey');
    });
  });
});
