import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  alexeyCalendarOverlay,
  determineSlotType,
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

    it('respects configurable filter toggles and custom keywords', () => {
      // With filterLunch disabled, lunch is kept
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Lunch', { filterLunch: false }),
        false,
      );

      // With filterRoutines disabled, morning no is kept
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Morning no', { filterRoutines: false }),
        false,
      );

      // With filterFitness disabled, Beat81 is kept
      assert.equal(
        shouldFilterAlexeyCalendarEvent('BEAT81 workout', { filterFitness: false }),
        false,
      );

      // With filterCampaigns disabled, campaign window is kept
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Campaign window', { filterCampaigns: false }),
        false,
      );

      // With filterBusy enabled, busy is filtered out
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Busy', { filterBusy: true }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Занято', { filterBusy: true }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Busy', { filterBusy: false }),
        false,
      );

      // Custom keywords
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Visit dentist for checkup', {
          customKeywords: ['dentist', 'haircut'],
        }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Quick Haircut appointment', {
          customKeywords: ['dentist', 'haircut'],
        }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Team planning session', {
          customKeywords: ['dentist', 'haircut'],
        }),
        false,
      );

      // DTC event placeholder blocks
      assert.equal(
        shouldFilterAlexeyCalendarEvent('DTC event block', { filterDtcPlaceholders: true }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('DataTalks.Club event', { filterDtcPlaceholders: true }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('DTC event', { filterDtcPlaceholders: true }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('DTC event block', { filterDtcPlaceholders: false }),
        false,
      );

      // Transparent events (free/non-blocking)
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Stay at #402 Prenzlauer Berg', { filterTransparent: true }, { transparency: 'transparent' }),
        true,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Flight to Helsinki', { filterTransparent: true }, { transparency: 'transparent' }),
        false,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('AI Conference Berlin', { filterTransparent: true }, { transparency: 'transparent' }),
        false,
      );
      assert.equal(
        shouldFilterAlexeyCalendarEvent('Stay at #402 Prenzlauer Berg', { filterTransparent: false }, { transparency: 'transparent' }),
        false,
      );

      // Operational event slot filtering (Midday 11:30–14:00, Evening 16:30–18:30)
      // Morning event (10:00–11:00 Berlin time) outside operational event slots:
      assert.equal(
        shouldFilterAlexeyCalendarEvent(
          'Internal standup',
          { filterNonSlotHours: true },
          { startIso: '2026-10-13T10:00:00+02:00', endIso: '2026-10-13T11:00:00+02:00' },
        ),
        true,
      );
      // When filterNonSlotHours is false, morning event is kept:
      assert.equal(
        shouldFilterAlexeyCalendarEvent(
          'Internal standup',
          { filterNonSlotHours: false },
          { startIso: '2026-10-13T10:00:00+02:00', endIso: '2026-10-13T11:00:00+02:00' },
        ),
        false,
      );
      // Midday event (12:30–13:30 Berlin time) is kept:
      assert.equal(
        shouldFilterAlexeyCalendarEvent(
          'Lunch discussion',
          { filterNonSlotHours: true, filterLunch: false },
          { startIso: '2026-10-13T12:30:00+02:00', endIso: '2026-10-13T13:30:00+02:00' },
        ),
        false,
      );
      // Evening event (17:00–18:00 Berlin time) is kept:
      assert.equal(
        shouldFilterAlexeyCalendarEvent(
          'Evening podcast recording',
          { filterNonSlotHours: true },
          { startIso: '2026-10-13T17:00:00+02:00', endIso: '2026-10-13T18:00:00+02:00' },
        ),
        false,
      );
      // All-day blockers bypass slot window filtering:
      assert.equal(
        shouldFilterAlexeyCalendarEvent(
          'Vacation',
          { filterNonSlotHours: true },
          { isAllDay: true },
        ),
        false,
      );
    });
  });

  describe('determineSlotType', () => {
    it('accurately categorizes operational slots, all-day events, and outside-slot events', () => {
      // All day
      assert.equal(determineSlotType(undefined, undefined, true), 'all-day');

      // Midday operational window: 11:30–14:00 Berlin time
      assert.equal(
        determineSlotType('2026-10-13T12:00:00+02:00', '2026-10-13T13:00:00+02:00'),
        'midday',
      );
      assert.equal(
        determineSlotType('2026-10-13T11:30:00+02:00', '2026-10-13T12:30:00+02:00'),
        'midday',
      );

      // Evening operational window: 16:30–18:30 Berlin time
      assert.equal(
        determineSlotType('2026-10-13T17:00:00+02:00', '2026-10-13T18:00:00+02:00'),
        'evening',
      );

      // Outside operational event slots
      assert.equal(
        determineSlotType('2026-10-13T09:00:00+02:00', '2026-10-13T10:00:00+02:00'),
        'outside',
      );
      assert.equal(
        determineSlotType('2026-10-13T14:30:00+02:00', '2026-10-13T15:30:00+02:00'),
        'outside',
      );
    });
  });

  describe('fetchDapierConnections and configurable provider', () => {
    it('discovers Dapier calendar connections using token', async () => {
      const { fetchDapierConnections } = await import('../src/calendar/alexeyCalendarOverlay');
      const mockFetch: typeof fetch = async (input) => {
        if (String(input).endsWith('/api/agent/connections')) {
          return new Response(
            JSON.stringify({
              connections: [
                {
                  connection_id: 'google-calendar',
                  provider: 'google',
                  account_title: 'alexey.s.grigoriev@gmail.com',
                },
                {
                  connection_id: 'work-calendar',
                  provider: 'google',
                  account_title: 'alexey@datatalks.club',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      setAlexeyCalendarProviderClientsForTests({ fetch: mockFetch });
      const conns = await fetchDapierConnections({ brokerCredential: 'token' });
      assert.equal(conns.length, 2);
      assert.equal(conns[0].connectionId, 'google-calendar');
      assert.equal(conns[1].connectionId, 'work-calendar');
    });

    it('applies custom settings passed in provider config to filter and connection', async () => {
      let requestedConnectionId: string | undefined;
      const mockFetch: typeof fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/api/agent/token')) {
          const body = JSON.parse(String(init.body));
          requestedConnectionId = body.connection_id;
          return new Response(
            JSON.stringify({ access_token: 'custom-token' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('googleapis.com')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'evt-custom-1',
                  summary: 'Lunch',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T12:00:00+02:00' },
                  end: { dateTime: '2026-10-13T13:00:00+02:00' },
                },
                {
                  id: 'evt-custom-2',
                  summary: 'Secret Project meeting',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T14:00:00+02:00' },
                  end: { dateTime: '2026-10-13T15:00:00+02:00' },
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
        brokerCredential: 'test-token',
        settings: {
          connectionId: 'work-calendar',
          showAvailableSlots: false,
          filterLunch: false, // Lunch should now be kept!
          filterRoutines: true,
          filterFitness: true,
          filterCampaigns: true,
          filterBusy: false,
          customKeywords: ['Secret Project'], // This meeting should now be filtered out!
        },
      });

      const items = await provider.project('2026-10-01', '2026-10-31');
      assert.equal(requestedConnectionId, 'work-calendar');
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'alexey-calendar:evt-custom-1');
      assert.equal(items[0].label, '12:00–13:00 Lunch');
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

    it('fetches Google access token via Dapier and projects filtered raw events when showAvailableSlots is false', async () => {
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
        settings: {
          showAvailableSlots: false,
          connectionId: 'google-calendar',
          filterLunch: true,
          filterRoutines: true,
          filterFitness: true,
          filterCampaigns: true,
          filterBusy: false,
          filterNonSlotHours: true,
          filterDtcPlaceholders: true,
          filterTransparent: true,
        },
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
      assert.equal(items[2].slot, 'all-day');
      assert.equal(items[2].isSlotEvent, true);
    });

    it('projects available event slots and preserves all-day blockers by default', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/api/agent/token')) {
          return new Response(
            JSON.stringify({ access_token: 'synthetic-google-token' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('googleapis.com/calendar/v3/calendars/primary/events')) {
          return new Response(
            JSON.stringify({
              items: [
                // Oct 12 (Monday): Meeting during midday 12:00–13:00, evening free
                {
                  id: 'evt-mon-midday',
                  summary: 'Partner sync',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-12T12:00:00+02:00' },
                  end: { dateTime: '2026-10-12T13:00:00+02:00' },
                },
                // Oct 13 (Tuesday): Midday free (only personal lunch), evening busy
                {
                  id: 'evt-tue-lunch',
                  summary: 'Lunch',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T12:00:00+02:00' },
                  end: { dateTime: '2026-10-13T13:00:00+02:00' },
                },
                {
                  id: 'evt-tue-evening',
                  summary: 'Evening webinar recording',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T17:00:00+02:00' },
                  end: { dateTime: '2026-10-13T18:00:00+02:00' },
                },
                // Oct 14 (Wednesday): completely free
                // Oct 15–16 (Thu–Fri): all-day vacation blocker
                {
                  id: 'evt-vacation',
                  summary: 'Autumn Vacation',
                  status: 'confirmed',
                  start: { date: '2026-10-15' },
                  end: { date: '2026-10-17' }, // Exclusive end date in Google Calendar (covers 15 and 16)
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
        brokerCredential: 'synthetic-token',
      });

      // Project Oct 12 to Oct 18 (one full week Mon–Sun)
      const items = await provider.project('2026-10-12', '2026-10-18');

      // 1. All-day blocker is projected:
      const vacation = items.find((i) => i.id === 'alexey-calendar:evt-vacation');
      assert.ok(vacation, 'Vacation blocker should be projected');
      assert.equal(vacation.startDate, '2026-10-15');
      assert.equal(vacation.endDate, '2026-10-16');
      assert.equal(vacation.label, 'Autumn Vacation');
      assert.equal(vacation.slot, 'all-day');

      // 2. Monday Oct 12: midday has partner sync (busy) -> evening is free -> 17:00 Available projected
      const monMidday = items.find((i) => i.id === 'alexey-slot:2026-10-12:midday');
      assert.equal(monMidday, undefined, 'Monday midday slot is busy');
      const monEvening = items.find((i) => i.id === 'alexey-slot:2026-10-12:evening');
      assert.ok(monEvening, 'Monday evening slot should be available');
      assert.equal(monEvening.label, '17:00 Available');
      assert.equal(monEvening.isAvailableSlot, true);

      // 3. Tuesday Oct 13: personal lunch filtered -> midday is free -> 12:30 Available projected; evening is busy
      const tueMidday = items.find((i) => i.id === 'alexey-slot:2026-10-13:midday');
      assert.ok(tueMidday, 'Tuesday midday slot should be available');
      assert.equal(tueMidday.label, '12:30 Available');
      assert.equal(tueMidday.isAvailableSlot, true);
      const tueEvening = items.find((i) => i.id === 'alexey-slot:2026-10-13:evening');
      assert.equal(tueEvening, undefined, 'Tuesday evening slot is busy');

      // 4. Wednesday Oct 14: midday free -> 12:30 Available; evening is NOT offered on Wed per SOP
      const wedMidday = items.find((i) => i.id === 'alexey-slot:2026-10-14:midday');
      assert.ok(wedMidday, 'Wednesday midday slot should be available');
      assert.equal(wedMidday.label, '12:30 Available');
      const wedEvening = items.find((i) => i.id === 'alexey-slot:2026-10-14:evening');
      assert.equal(wedEvening, undefined, 'Evening slots are only offered Mon/Tue per SOP');

      // 5. Thursday Oct 15 & Friday Oct 16: Vacation blocker -> NO slots available
      const thuMidday = items.find((i) => i.id === 'alexey-slot:2026-10-15:midday');
      assert.equal(thuMidday, undefined, 'Thursday is blocked by vacation');
      const friMidday = items.find((i) => i.id === 'alexey-slot:2026-10-16:midday');
      assert.equal(friMidday, undefined, 'Friday is blocked by vacation');

      // 6. Saturday Oct 17 & Sunday Oct 18: Weekend -> NO slots available per SOP
      const satSlots = items.filter((i) => i.startDate === '2026-10-17' && i.isAvailableSlot);
      assert.equal(satSlots.length, 0, 'No slots offered on weekends');
    });

    it('returns all events including those outside slots when includeAll is true', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
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
                  id: 'evt-morning',
                  summary: 'Morning team standup',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T10:00:00+02:00' },
                  end: { dateTime: '2026-10-13T10:30:00+02:00' },
                },
                {
                  id: 'evt-midday',
                  summary: 'Podcast recording',
                  status: 'confirmed',
                  start: { dateTime: '2026-10-13T12:30:00+02:00' },
                  end: { dateTime: '2026-10-13T13:30:00+02:00' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      };

      setAlexeyCalendarProviderClientsForTests({ fetch: mockFetch });

      // Without includeAll and showAvailableSlots: false: morning meeting is filtered out
      const defaultProvider = alexeyCalendarOverlay({
        brokerCredential: 'token',
        includeAll: false,
        settings: {
          showAvailableSlots: false,
          connectionId: 'google-calendar',
          filterLunch: true,
          filterRoutines: true,
          filterFitness: true,
          filterCampaigns: true,
          filterBusy: false,
          filterNonSlotHours: true,
          filterDtcPlaceholders: true,
          filterTransparent: true,
        },
      });
      const defaultItems = await defaultProvider.project('2026-10-13', '2026-10-13');
      assert.equal(defaultItems.length, 1);
      assert.equal(defaultItems[0].id, 'alexey-calendar:evt-midday');
      assert.equal(defaultItems[0].slot, 'midday');
      assert.equal(defaultItems[0].isSlotEvent, true);

      // With includeAll: morning meeting is kept and tagged with slot: outside
      const allProvider = alexeyCalendarOverlay({
        brokerCredential: 'token',
        includeAll: true,
      });
      const allItems = await allProvider.project('2026-10-13', '2026-10-13');
      assert.equal(allItems.length, 2);
      assert.equal(allItems[0].id, 'alexey-calendar:evt-morning');
      assert.equal(allItems[0].slot, 'outside');
      assert.equal(allItems[0].isSlotEvent, false);
      assert.equal(allItems[1].id, 'alexey-calendar:evt-midday');
      assert.equal(allItems[1].slot, 'midday');
      assert.equal(allItems[1].isSlotEvent, true);
    });
  });
});
