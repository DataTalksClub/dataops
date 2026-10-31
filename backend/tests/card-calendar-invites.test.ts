import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTask } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { EMPTY_TEMPLATE_ID, putEmptyTemplate } from './helpers/cardTemplate';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
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
  const [PERSONAL, DTC] = DEFAULT_HOLD_GOOGLE_CALENDARS;

  describe('list, unlink and stale check', () => {
    it('lists the linked invites and refuses hand-linking a new one', async () => {
      const card = await createCard();
      await linkInvites(card.id, [{ eventId: 'evt-a', calendar: DTC }]);
      const list = await invoke('GET', `/api/cards/${card.id}/calendar-invites`);
      assert.strictEqual(list.statusCode, 200, list.body);
      assert.deepStrictEqual(parse(list).invites.map((i: any) => i.eventId), ['evt-a']);
      const add = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, { eventId: 'evt-b', calendar: DTC });
      assert.strictEqual(add.statusCode, 405, add.body);
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

    it('keeps the invite when Google refuses the deletion', async () => {
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
      const card = await createCard('AISHL workshop');
      const current = (await getCardConsistent(client, card.id))!;
      await updateCard(client, card.id, { expectedVersion: current.version, patch: { templateId: 'aishl-workshop' } });
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

    it('needs live invites on both the DTC events and the personal calendar', async () => {
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
  });
});
