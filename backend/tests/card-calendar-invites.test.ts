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
import { setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
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

describe('Card calendar invites (link-by-hand + invite-task done-gate + confirm-hold auto-link)', () => {
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await putEmptyTemplate(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'google-calendar' }, 'test-operator');
    // Keep unit tests offline: the broker secret is unreadable unless a test injects a credential.
    setDapierBrokerClientsForTests({
      secrets: {
        send: async () => {
          throw Object.assign(new Error('no aws in unit test'), { name: 'CredentialsProviderError' });
        },
      } as any,
    });
  });

  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    await stopLocal();
  });

  describe('link and list', () => {
    it('links an invite created outside DataOps and lists it', async () => {
      const card = await createCard();
      const add = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
        eventId: '71m4nplkn0s9g7pg800r1t009p',
        calendar: 'alexey@datatalks.club',
        url: 'https://www.google.com/calendar/event?eid=abc123',
        label: 'original',
      });
      assert.strictEqual(add.statusCode, 201, add.body);
      assert.strictEqual(parse(add).invites.length, 1);

      const list = await invoke('GET', `/api/cards/${card.id}/calendar-invites`);
      assert.strictEqual(list.statusCode, 200, list.body);
      const invites = parse(list).invites;
      assert.strictEqual(invites.length, 1);
      assert.strictEqual(invites[0].eventId, '71m4nplkn0s9g7pg800r1t009p');
      assert.strictEqual(invites[0].calendar, 'alexey@datatalks.club');
      assert.strictEqual(invites[0].url, 'https://www.google.com/calendar/event?eid=abc123');
      assert.strictEqual(invites[0].label, 'original');
      assert.ok(invites[0].createdAt);
    });

    it('supports several invites per card on any calendar, without a url', async () => {
      const card = await createCard('Multi-invite card');
      for (const invite of [
        { eventId: 'aaa', calendar: 'alexey@datatalks.club', label: 'original' },
        { eventId: 'bbb', calendar: 'alexey.s.grigoriev@gmail.com' },
      ]) {
        const add = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, invite);
        assert.strictEqual(add.statusCode, 201, add.body);
      }
      const list = await invoke('GET', `/api/cards/${card.id}/calendar-invites`);
      assert.strictEqual(parse(list).invites.length, 2);
      assert.ok(parse(list).invites.some((i: any) => i.calendar === 'alexey.s.grigoriev@gmail.com' && i.url === undefined));
    });

    it('re-linking the same event updates it instead of duplicating', async () => {
      const card = await createCard('Resent card');
      assert.strictEqual((await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
        eventId: 'evt1', calendar: 'alexey@datatalks.club', label: 'original',
      })).statusCode, 201);
      const resent = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
        eventId: 'evt1', calendar: 'alexey@datatalks.club', label: 'resent',
        url: 'https://www.google.com/calendar/event?eid=evt1',
      });
      assert.strictEqual(resent.statusCode, 201, resent.body);
      const invites = parse(resent).invites;
      assert.strictEqual(invites.length, 1);
      assert.strictEqual(invites[0].label, 'resent');
      assert.strictEqual(invites[0].url, 'https://www.google.com/calendar/event?eid=evt1');
    });

    it('validates invite input', async () => {
      const card = await createCard('Validation card');
      const missingEvent = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, { calendar: 'c' });
      assert.strictEqual(missingEvent.statusCode, 400);
      assert.match(parse(missingEvent).error, /eventId/);
      const missingCalendar = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, { eventId: 'e' });
      assert.strictEqual(missingCalendar.statusCode, 400);
      assert.match(parse(missingCalendar).error, /calendar/);
      const badUrl = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
        eventId: 'e', calendar: 'c', url: 'http://insecure.example/x',
      });
      assert.strictEqual(badUrl.statusCode, 400);
      assert.match(parse(badUrl).error, /HTTPS/);
      const missing = await invoke('GET', '/api/cards/nope/calendar-invites');
      assert.strictEqual(missing.statusCode, 404);
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
      assert.match(parse(done).error, /no calendar invite is linked/);
      assert.match(parse(done).error, new RegExp(`dataops cards time ${card.id}`));
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
      assert.match(parse(created).error, /no calendar invite is linked/);
    });

    it('automatically closes the invite Task when a legacy invite is adopted', async () => {
      const { inviteTask, card } = await createWebinarStyleCard('Linked card');
      const add = await invoke('POST', `/api/cards/${card.id}/calendar-invites`, {
        eventId: 'evt9', calendar: 'alexey@datatalks.club',
      });
      assert.strictEqual(add.statusCode, 201, add.body);
      const done = await invoke('GET', `/api/tasks/${inviteTask.id}`);
      assert.strictEqual(done.statusCode, 200, done.body);
      assert.strictEqual(parse(done).status, 'done');
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
      assert.match(parse(done).error, /no calendar invite is linked/);
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
      assert.match(parse(closed).error, /no calendar invite is linked/);
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
