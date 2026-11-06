import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTask } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { EMPTY_TEMPLATE_ID, putEmptyTemplate } from './helpers/cardTemplate';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, PUBLIC_DTC_EVENTS_CALENDAR, setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
import { getCardConsistent, updateCard } from '../src/db/cards';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { holdGoogleProvider } from './helpers/hold-google';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, pathName: string, body?: unknown, query: Record<string, string> = {}): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path: pathName,
    body: body !== undefined ? JSON.stringify(body) : null,
    queryStringParameters: query,
  };
  return handler(event, {});
}

const parse = (r: LambdaResponse): any => JSON.parse(r.body);

async function createCard(title = 'Webinar card'): Promise<any> {
  const res = await invoke('POST', '/api/cards', {
    title,
    anchorDate: '2026-11-09',
    templateId: EMPTY_TEMPLATE_ID,
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  return parse(res).card;
}

let client: DynamoDBDocumentClient;

describe('Card calendar invites (unlink + stale check + invite-task done-gate + confirm-hold auto-link)', () => {
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await putEmptyTemplate(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'google-calendar' }, 'test-operator');
    // Keep unit tests offline: the broker secret is unreadable unless a test injects a credential.
    setDapierBrokerClientsForTests({
      readSecret: async () => {
        throw Object.assign(new Error('no aws in unit test'), { name: 'CredentialsProviderError' });
      },
    });
  });

  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    await stopLocal();
  });

  /** Invites as `cards time` leaves them on a Card (written straight to the store). */
  async function linkInvites(cardId: string, invites: Array<Record<string, unknown>>, eventTime?: Record<string, unknown>) {
    const current = (await getCardConsistent(client, cardId))!;
    return updateCard(client, cardId, {
      expectedVersion: current.version,
      patch: { calendarInvites: invites as any, ...(eventTime ? { eventTime: eventTime as any } : {}) },
    });
  }
  const [PERSONAL] = DEFAULT_HOLD_GOOGLE_CALENDARS;
  const DTC = PUBLIC_DTC_EVENTS_CALENDAR;

  it('adds guests only to an owned private organizer invitation, keeping public copies untouched', async () => {
    const card = await createCard('Private speaker invitation');
    const eventKey = `card:${card.id}`;
    const organizer = 'orin@datatalks.club';
    await linkInvites(card.id, [{ eventId: 'private-event', calendar: organizer }], {
      eventKey, googleEventIds: { [organizer]: 'private-event' }, sync: 'synced',
      startIso: '2026-11-09T16:00:00Z', endIso: '2026-11-09T17:00:00Z',
      timeZone: 'Europe/Berlin', durationMinutes: 60, syncStartedAt: '2026-11-01T00:00:00Z',
    });
    const google = holdGoogleProvider();
    google.events.set(organizer, new Map([['private-event', {
      id: 'private-event', etag: '"one"', status: 'confirmed', organizer: { email: organizer },
      iCalUID: `${createHash('sha256').update(eventKey).digest('hex')}@google.com`,
      location: 'https://zoom.us/j/123456789', attendees: [{ email: 'original@example.test', responseStatus: 'accepted' }],
    }]]));
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    try {
      const result = await invoke('PATCH', `/api/cards/${card.id}/calendar-invites`, { guestEmails: ['speaker@example.test'] });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(parse(result).added, ['speaker@example.test']);
      assert.deepEqual((await getCardConsistent(client, card.id))!.guestEmails, ['speaker@example.test']);
      assert.ok(google.calls.filter(call => call.method === 'PATCH').every(call => decodeURIComponent(call.url.pathname).includes(`/calendars/${organizer}/`)));
      assert.equal((await invoke('PATCH', `/api/cards/${card.id}/calendar-invites`, { guestEmails: [DTC] })).statusCode, 400);
    } finally { setCalendarHoldGoogleDepsForTests({}); }
  });

  describe('list, unlink and stale check', () => {
    it('lists existing invites and adopts a live Google event idempotently', async () => {
      const card = await createCard();
      await linkInvites(card.id, [{ eventId: 'evt-a', calendar: DTC }]);
      const list = await invoke('GET', `/api/cards/${card.id}/calendar-invites`);
      assert.strictEqual(list.statusCode, 200, list.body);
      assert.deepStrictEqual(parse(list).invites.map((i: any) => i.eventId), ['evt-a']);
      const google = holdGoogleProvider();
      google.events.set(DTC, new Map([['manual-event', { id: 'manual-event', status: 'confirmed' }]]));
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const add = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
          eventId: 'manual-event', calendar: DTC, label: 'Pre-Course Q&A',
        });
        assert.strictEqual(add.statusCode, 200, add.body);
        assert.equal(parse(add).invite.eventId, 'manual-event');
        assert.equal(parse(add).invite.label, 'Pre-Course Q&A');
        assert.equal(parse(add).invite.url, `https://calendar.google.com/calendar/event?eid=${Buffer.from(`manual-event ${DTC}`).toString('base64url')}`);
        const again = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
          eventId: 'manual-event', calendar: DTC, label: 'Pre-Course Q&A',
        });
        assert.strictEqual(again.statusCode, 200, again.body);
        assert.equal(parse(again).invites.filter((invite: any) => invite.eventId === 'manual-event').length, 1);
        assert.equal(google.calls.filter(call => call.method === 'GET' && call.url.pathname.includes('/manual-event')).length, 2,
          'repeat adoption returns the linked event without another Google read');
        const missing = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, { eventId: 'missing-event', calendar: DTC });
        assert.strictEqual(missing.statusCode, 400, missing.body);
        assert.match(parse(missing).error, /does not exist/);
        const wrongCalendar = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
          eventId: 'manual-event', calendar: 'other-calendar@example.test',
        });
        assert.strictEqual(wrongCalendar.statusCode, 400, wrongCalendar.body);
        assert.ok(google.calls.every(call => call.method === 'GET' || call.url.pathname === '/api/agent/token'),
          'adoption only verifies the existing Google event; it never writes or sends updates');
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
      assert.strictEqual((await invoke('GET', '/api/cards/nope/calendar-invites')).statusCode, 404);
    });

    it('unlinks an invite reference without calling Google', async () => {
      const card = await createCard('Unlink card');
      await linkInvites(card.id, [
        { eventId: 'gone-dtc', calendar: DTC },
        { eventId: 'gone-personal', calendar: PERSONAL },
        { eventId: 'kept', calendar: DTC },
      ]);
      const google = holdGoogleProvider();
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const removed = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'gone-dtc' });
        assert.strictEqual(removed.statusCode, 200, removed.body);
        assert.deepStrictEqual(parse(removed).removed.map((i: any) => i.eventId), ['gone-dtc']);
        assert.deepStrictEqual(parse(removed).invites.map((i: any) => i.eventId), ['gone-personal', 'kept']);
        assert.strictEqual(google.calls.length, 0, 'unlinking never touches Google');
        const again = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'gone-dtc' });
        assert.strictEqual(again.statusCode, 404, again.body);
        const wrongCalendar = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'kept', calendar: PERSONAL });
        assert.strictEqual(wrongCalendar.statusCode, 404, wrongCalendar.body);
        assert.strictEqual((await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, {})).statusCode, 400);
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('refuses to unlink the invitation cards time owns', async () => {
      const card = await createCard('Owned card');
      await linkInvites(card.id, [{ eventId: 'owned', calendar: DTC }], {
        startIso: '2026-11-09T16:00:00.000Z', endIso: '2026-11-09T17:00:00.000Z', timeZone: 'Europe/Berlin', durationMinutes: 60,
        eventKey: `card:${card.id}`, googleEventIds: { [DTC]: 'owned' }, sync: 'synced', syncStartedAt: '2026-10-31T00:00:00.000Z',
      });
      const refused = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'owned' });
      assert.strictEqual(refused.statusCode, 409, refused.body);
      assert.match(parse(refused).error, /dataops cards time/);
    });

    const ownedTime = (cardId: string, ids: Record<string, string>) => ({
      startIso: '2026-11-09T16:00:00.000Z', endIso: '2026-11-09T17:00:00.000Z', timeZone: 'Europe/Berlin', durationMinutes: 60,
      eventKey: `card:${cardId}`, googleEventIds: ids, sync: 'synced', syncStartedAt: '2026-10-31T00:00:00.000Z',
    });

    it('unlinks a stale cards-time invite and clears it from the event time', async () => {
      const card = await createCard('Stale owned card');
      await linkInvites(card.id, [{ eventId: 'owned-gone', calendar: DTC, staleAt: '2026-10-31T00:00:00.000Z' }], ownedTime(card.id, { [DTC]: 'owned-gone' }));
      const removed = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'owned-gone' });
      assert.strictEqual(removed.statusCode, 200, removed.body);
      const after = (await getCardConsistent(client, card.id))!;
      assert.deepStrictEqual(after.calendarInvites, []);
      assert.deepStrictEqual(after.eventTime?.googleEventIds, {});
    });

    it('--delete-event deletes the Google event silently, then unlinks it', async () => {
      const card = await createCard('Delete event card');
      const google = holdGoogleProvider();
      google.events.set(DTC, new Map([['live-dtc', { id: 'live-dtc' }]]));
      google.events.set('orin@datatalks.club', new Map([['live-org', { id: 'live-org' }]]));
      await linkInvites(card.id, [{ eventId: 'live-org', calendar: 'orin@datatalks.club' }], ownedTime(card.id, { 'orin@datatalks.club': 'live-org' }));
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const refused = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'live-org' });
        assert.strictEqual(refused.statusCode, 409, refused.body);
        const removed = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'live-org', deleteEvent: true });
        assert.strictEqual(removed.statusCode, 200, removed.body);
        const deletes = google.calls.filter(call => call.method === 'DELETE');
        assert.strictEqual(deletes.length, 1);
        assert.strictEqual(deletes[0].url.searchParams.get('sendUpdates'), 'none');
        assert.ok(!google.events.get('orin@datatalks.club')!.has('live-org'));
        assert.deepStrictEqual((await getCardConsistent(client, card.id))!.calendarInvites, []);
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('refuses to delete a public standalone event through the guest invite path', async () => {
      const card = await createCard('Selected calendar copy');
      const google = holdGoogleProvider();
      for (const calendar of [DTC, PERSONAL]) google.events.set(calendar, new Map([['same-id', { id: 'same-id' }]]));
      await linkInvites(card.id, [DTC, PERSONAL].map(calendar => ({ calendar, eventId: 'same-id' })),
        ownedTime(card.id, { [DTC]: 'same-id', [PERSONAL]: 'same-id' }));
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const res = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, {
          eventId: 'same-id', calendar: DTC, deleteEvent: true,
        });
        assert.strictEqual(res.statusCode, 409, res.body);
        assert.ok(google.events.get(DTC)!.has('same-id'));
        assert.ok(google.events.get(PERSONAL)!.has('same-id'));
        const deletes = google.calls.filter(call => call.method === 'DELETE');
        assert.strictEqual(deletes.length, 0);
        const stored = (await getCardConsistent(client, card.id))!;
        assert.deepStrictEqual(stored.eventTime?.googleEventIds, { [DTC]: 'same-id', [PERSONAL]: 'same-id' });
        assert.deepStrictEqual(stored.calendarInvites?.map(invite => invite.calendar), [DTC, PERSONAL]);
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('keeps a public invite link when guest invite deletion is refused', async () => {
      const card = await createCard('Delete fails card');
      const google = holdGoogleProvider();
      google.state.failCalendar = DTC;
      await linkInvites(card.id, [{ eventId: 'x', calendar: DTC }]);
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const res = await invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: 'x', deleteEvent: true });
        assert.strictEqual(res.statusCode, 409, res.body);
        assert.strictEqual((await getCardConsistent(client, card.id))!.calendarInvites?.length, 1);
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('cards time on an AISHL card sets the time but never calls Google', async () => {
      const template = await createTemplate(client, {
        name: 'AISHL workshop', type: 'aishl-workshop', triggerType: 'manual', taskDefinitions: [],
      });
      assert.notStrictEqual(template.id, template.type, 'stored template IDs are UUIDs, not types');
      const card = await createCard('AISHL workshop');
      const current = (await getCardConsistent(client, card.id))!;
      await updateCard(client, card.id, { expectedVersion: current.version, patch: { templateId: template.id } });
      const google = holdGoogleProvider();
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const res = await invoke('POST', `/api/cards/${card.id}/time`, { at: '2026-11-09 14:30', guestEmails: ['guest@example.test'] });
        assert.strictEqual(res.statusCode, 200, res.body);
        assert.strictEqual(google.calls.length, 0, 'no Google or Zoom call for AISHL cards');
        const after = (await getCardConsistent(client, card.id))!;
        assert.strictEqual(after.anchorDate, '2026-11-09');
        assert.deepStrictEqual(after.calendarInvites || [], []);
        assert.strictEqual(after.eventTime?.startIso, '2026-11-09T13:30:00.000Z');
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('verify marks invites Google no longer has as stale and deletes nothing', async () => {
      const card = await createCard('Stale card');
      const google = holdGoogleProvider();
      google.events.set(DTC, new Map([['alive', { id: 'alive', status: 'confirmed' }], ['cancelled', { id: 'cancelled', status: 'cancelled' }]]));
      await linkInvites(card.id, [
        { eventId: 'alive', calendar: DTC },
        { eventId: 'cancelled', calendar: DTC },
        { eventId: 'deleted', calendar: PERSONAL },
      ]);
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const verified = await invoke('GET', `/api/cards/${card.id}/calendar-invites`, undefined, { verify: '1' });
        assert.strictEqual(verified.statusCode, 200, verified.body);
        const byId = Object.fromEntries(parse(verified).invites.map((i: any) => [i.eventId, i]));
        assert.strictEqual(byId.alive.staleAt, undefined);
        assert.ok(byId.cancelled.staleAt);
        assert.ok(byId.deleted.staleAt);
        assert.strictEqual(parse(verified).check.state, 'verified');
        assert.ok(google.calls.every((call) => call.method === 'GET' || call.url.pathname === '/api/agent/token'));
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });
  });

  describe('invite-task done-gate', () => {
    async function createWebinarStyleCard(title: string): Promise<{ card: any; inviteTask: any }> {
      const template = await createTemplate(client, {
        name: title,
        type: `synthetic-webinar-${Math.random().toString(36).slice(2, 8)}`,
        triggerType: 'manual',
        taskDefinitions: [{
          refId: 'create-calendar-invite',
          description: 'Create a calendar invite for the guests',
          offsetDays: -26,
        }],
      });
      const res = await invoke('POST', '/api/cards', {
        title,
        anchorDate: '2026-11-09',
        templateId: template.id,
      });
      assert.strictEqual(res.statusCode, 201, res.body);
      const tasks = parse(await invoke('GET', '/api/tasks', undefined, { cardId: parse(res).card.id })).tasks;
      const inviteTask = tasks.find((t: any) => t.templateTaskRef === 'create-calendar-invite');
      assert.ok(inviteTask, 'card instantiates the invite task');
      return { card: parse(res).card, inviteTask };
    }

    it('refuses done on the invite task while the card has no linked invite', async () => {
      const { inviteTask, card } = await createWebinarStyleCard('Gated card');
      const done = await invoke('PUT', `/api/tasks/${inviteTask.id}`, { expectedVersion: inviteTask.version, status: 'done' });
      assert.strictEqual(done.statusCode, 400, done.body);
      assert.match(parse(done).error, /no live calendar invite/);
      assert.match(parse(done).error, new RegExp(`dataops cards time ${card.id}`));
    });

    it('requires a live invite on the personal calendar', async () => {
      const { inviteTask, card } = await createWebinarStyleCard('Both-calendars card');
      await linkInvites(card.id, [{ eventId: 'only-dtc', calendar: DTC }, { eventId: 'gone', calendar: PERSONAL, staleAt: '2026-10-31T00:00:00.000Z' }]);
      const oneCalendar = await invoke('PUT', `/api/tasks/${inviteTask.id}`, { expectedVersion: inviteTask.version, status: 'done' });
      assert.strictEqual(oneCalendar.statusCode, 400, oneCalendar.body);
      assert.match(parse(oneCalendar).error, new RegExp(`no live calendar invite on ${PERSONAL.replace(/[.]/g, '\\.')}`));
      await linkInvites(card.id, [{ eventId: 'only-dtc', calendar: DTC }, { eventId: 'live', calendar: PERSONAL }]);
      const both = await invoke('PUT', `/api/tasks/${inviteTask.id}`, { expectedVersion: inviteTask.version, status: 'done' });
      assert.strictEqual(both.statusCode, 200, both.body);
    });

    it('refuses create-as-done without a linked invite', async () => {
      const card = await createCard('Create-as-done card');
      const created = await invoke('POST', '/api/tasks', {
        description: 'Custom invite step',
        date: '2026-11-09',
        cardId: card.id,
        requiresCalendarInvite: true,
        source: 'manual',
        status: 'done',
      });
      assert.strictEqual(created.statusCode, 400, created.body);
      assert.match(parse(created).error, /no live calendar invite/);
    });

    it('honours an explicit requiresCalendarInvite flag on any task', async () => {
      const card = await createCard('Explicit-flag card');
      const task = await createTask(client, {
        description: 'Custom invite step',
        date: '2026-11-09',
        cardId: card.id,
        requiresCalendarInvite: true,
        source: 'manual',
      } as any);
      const done = await invoke('PUT', `/api/tasks/${task.id}`, { expectedVersion: task.version, status: 'done' });
      assert.strictEqual(done.statusCode, 400, done.body);
      assert.match(parse(done).error, /no live calendar invite/);
    });

    it('does not break already-done invite tasks', async () => {
      const card = await createCard('Already-done card');
      // Done before the gate existed (written straight to the store, no invite linked).
      const task = await createTask(client, {
        description: 'Create a calendar invite for the guests',
        date: '2026-11-09',
        cardId: card.id,
        templateTaskRef: 'create-calendar-invite',
        source: 'template',
        status: 'done',
      } as any);
      const read = await invoke('GET', `/api/tasks/${task.id}`);
      assert.strictEqual(read.statusCode, 200, read.body);
      const noted = await invoke('PUT', `/api/tasks/${task.id}`, {
        expectedVersion: task.version, comment: 'still fine',
      });
      assert.strictEqual(noted.statusCode, 200, noted.body);
      const redone = await invoke('PUT', `/api/tasks/${task.id}`, {
        expectedVersion: parse(noted).version, status: 'done',
      });
      assert.strictEqual(redone.statusCode, 200, redone.body);
      // But reopening re-arms the gate: closing again needs a linked invite.
      const reopened = await invoke('PUT', `/api/tasks/${task.id}`, {
        expectedVersion: parse(redone).version, status: 'todo',
      });
      assert.strictEqual(reopened.statusCode, 200, reopened.body);
      const closed = await invoke('PUT', `/api/tasks/${task.id}`, {
        expectedVersion: parse(reopened).version, status: 'done',
      });
      assert.strictEqual(closed.statusCode, 400, closed.body);
      assert.match(parse(closed).error, /no live calendar invite/);
    });
  });

  describe('confirm-hold auto-link', () => {
    it('links the confirmed Google invite to the card automatically', async () => {
      const card = await createCard('Auto-link card');
      const google = holdGoogleProvider();
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const created = parse(await invoke('POST', '/api/calendar-holds', {
          date: '2026-11-09',
          title: 'Guest webinar',
          topic: 'Guest webinar topic',
          cardId: card.id,
          guestRef: 'guest@example.com',
        }));
        const confirmed = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        assert.strictEqual(confirmed.statusCode, 200, confirmed.body);
        assert.strictEqual(parse(confirmed).hold.googleSync.state, 'synced', confirmed.body);
        const list = await invoke('GET', `/api/cards/${card.id}/calendar-invites`);
        const invites = parse(list).invites;
        assert.ok(invites.length >= 2, JSON.stringify(invites));
        assert.ok(invites.every((i: any) => i.eventId && i.calendar));
        // Confirming again links nothing new.
        await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        const again = parse(await invoke('GET', `/api/cards/${card.id}/calendar-invites`)).invites;
        assert.strictEqual(again.length, invites.length);
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('leaves the card alone when the Google leg stays deferred', async () => {
      const card = await createCard('Deferred card');
      setCalendarHoldGoogleDepsForTests({});
      const created = parse(await invoke('POST', '/api/calendar-holds', {
        date: '2026-11-10',
        title: 'Deferred webinar',
        topic: 'Deferred webinar topic',
        cardId: card.id,
        guestRef: 'guest@example.com',
      }));
      assert.strictEqual(created.hold.googleSync.state, 'deferred');
      const confirmed = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
      assert.strictEqual(confirmed.statusCode, 200, confirmed.body);
      const list = parse(await invoke('GET', `/api/cards/${card.id}/calendar-invites`));
      assert.deepStrictEqual(list.invites, []);
    });

    it('confirm-hold on a podcast hold renames to the guest convention and links the card invite in place', async () => {
      const { createTemplate } = await import('../src/db/templates');
      const podcastTemplate = await createTemplate(client, {
        name: 'Podcast',
        type: 'podcast',
        triggerType: 'manual',
        taskDefinitions: [],
      });
      const podcastCard = parse(await invoke('POST', '/api/cards', {
        title: 'Database CI/CD',
        anchorDate: '2026-12-07',
        templateId: podcastTemplate.id,
      })).card;
      const createdEpisode = await invoke('POST', '/api/podcast-episodes', {
        title: 'Database CI/CD',
        guests: [{ name: 'Harish Shenoy' }],
        recordingDate: '2026-12-07',
        status: 'booked',
        cardId: podcastCard.id,
      });
      assert.strictEqual(createdEpisode.statusCode, 201, createdEpisode.body);
      const google = holdGoogleProvider();
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const created = parse(await invoke('POST', '/api/calendar-holds', {
          date: '2026-12-07',
          window: 'midday',
          title: 'Database CI/CD',
          topic: 'Database CI/CD',
          cardId: podcastCard.id,
          guestRef: 'harishshenoy552@gmail.com',
        }));
        const proposedIds = created.hold.googleEventIds;
        assert.ok(Object.keys(proposedIds).length > 0, 'proposal mirrors Google event ids');
        const confirmed = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        assert.strictEqual(confirmed.statusCode, 200, confirmed.body);
        const hold = parse(confirmed).hold;
        assert.strictEqual(hold.title, 'Harish Shenoy at DataTalks.Club Podcast');
        assert.strictEqual(hold.googleTitle, 'Harish Shenoy at DataTalks.Club Podcast');
        assert.deepStrictEqual(hold.googleEventIds, proposedIds, 'confirm fixes the event in place (same event ids)');
        assert.strictEqual(hold.googleSync.state, 'synced');
        const list = parse(await invoke('GET', `/api/cards/${podcastCard.id}/calendar-invites`));
        assert.ok(list.invites.length >= 1, JSON.stringify(list.invites));
        const inviteEventIds = new Set(list.invites.map((i: any) => i.eventId));
        for (const eventId of Object.values(proposedIds)) assert.ok(inviteEventIds.has(eventId), `invite list links ${eventId}`);
        const organizer = [...google.events.values()].flatMap(store => [...store.values()]);
        assert.ok(organizer.length > 0);
        assert.ok(organizer.every(e => e.summary === 'Harish Shenoy at DataTalks.Club Podcast'), JSON.stringify(organizer.map(e => e.summary)));
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });

    it('uses the podcast guest title and links an already-confirmed hold through its episode in place', async () => {
      const template = await createTemplate(client, { name: 'Podcast', type: 'podcast', taskDefinitions: [] });
      const cardResponse = await invoke('POST', '/api/cards', {
        templateId: template.id,
        title: 'Database CI/CD',
        anchorDate: '2026-12-08',
      });
      assert.strictEqual(cardResponse.statusCode, 201, cardResponse.body);
      const card = parse(cardResponse).card;

      const google = holdGoogleProvider();
      setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
      try {
        const created = parse(await invoke('POST', '/api/calendar-holds', {
          date: '2026-12-08',
          window: 'midday',
          title: 'Database CI/CD',
          topic: 'Database CI/CD',
          guestRef: 'harishshenoy552@gmail.com',
        }));
        const firstConfirmation = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        assert.strictEqual(firstConfirmation.statusCode, 200, firstConfirmation.body);
        const originalHold = parse(firstConfirmation).hold;
        const originalEventIds = originalHold.googleEventIds;

        await createPodcastEpisode(client, {
          title: 'Database CI/CD',
          guests: [{ name: 'Harish Shenoy', email: 'harishshenoy552@gmail.com' }],
          status: 'booked',
          recordingDate: '2026-12-08',
          cardId: card.id,
          recordingHoldId: created.hold.id,
        });
        const currentCard = (await getCardConsistent(client, card.id))!;
        await updateCard(client, card.id, {
          expectedVersion: currentCard.version,
          patch: {
            eventTime: {
              startIso: originalHold.startIso,
              endIso: originalHold.endIso,
              timeZone: originalHold.timeZone,
              durationMinutes: originalHold.durationMinutes,
              eventKey: created.hold.id,
              googleEventIds: {},
              sync: 'deferred',
              syncStartedAt: new Date().toISOString(),
            },
          },
        });

        const previousCallCount = google.calls.length;
        const confirmedAgain = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        assert.strictEqual(confirmedAgain.statusCode, 200, confirmedAgain.body);
        const confirmedHold = parse(confirmedAgain).hold;
        const expectedTitle = 'Harish Shenoy at DataTalks.Club Podcast';
        assert.strictEqual(confirmedHold.id, originalHold.id);
        assert.strictEqual(confirmedHold.cardId, card.id);
        assert.strictEqual(confirmedHold.title, expectedTitle);
        assert.strictEqual(confirmedHold.googleTitle, expectedTitle);
        assert.strictEqual(confirmedHold.topic, 'Database CI/CD');
        assert.deepStrictEqual(confirmedHold.googleEventIds, originalEventIds);

        const followUpCalls = google.calls.slice(previousCallCount);
        assert.ok(followUpCalls.some((call) => call.method === 'PATCH' && call.body?.summary === expectedTitle));
        assert.strictEqual(
          followUpCalls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/import')).length,
          0,
          'reconfirm updates the original Google event ids instead of creating new events',
        );
        assert.ok([...google.events.values()].flatMap((events) => [...events.values()])
          .every((event) => event.summary === expectedTitle));

        const invites = parse(await invoke('GET', `/api/cards/${card.id}/calendar-invites`)).invites;
        assert.deepStrictEqual(new Set(invites.map((item: any) => item.eventId)), new Set(Object.values(originalEventIds)));
        assert.strictEqual((await getCardConsistent(client, card.id))?.eventTime?.eventKey, created.hold.id);

        const syncedCallCount = google.calls.length;
        const idempotent = await invoke('POST', `/api/calendar-holds/${created.hold.id}/confirm`, {});
        assert.strictEqual(idempotent.statusCode, 200, idempotent.body);
        assert.strictEqual(google.calls.length, syncedCallCount, 'a fully linked, confirmed invite does not notify guests again');
      } finally {
        setCalendarHoldGoogleDepsForTests({});
      }
    });
  });
});
