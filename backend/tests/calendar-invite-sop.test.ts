import { after, before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CARDS } from '../src/db/tableNames';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { getCalendarHold, putCalendarHold } from '../src/db/calendarHolds';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { setDapierBrokerClientsForTests, DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { HOLD_REQUIRED_ATTENDEES, HOLD_ZOOM_LOCATION, confirmedTitle } from '../src/calendar/holds';
import { templateLink } from './helpers/cardTemplate';
import { holdGoogleProvider } from './helpers/hold-google';

async function invoke(method: string, path: string, body?: unknown) {
  const response = await handler({ httpMethod: method, path, body: body ? JSON.stringify(body) : null, headers: {} });
  return { status: response.statusCode, ...JSON.parse(response.body) };
}
const input = {
  date: '2026-11-03', window: 'midday', title: 'Guest at DataTalks.Club Podcast',
  topic: 'Topic', guestRef: 'guest@example.com', documentUrl: 'https://example.com/podcast',
};
const offline = () => setDapierBrokerClientsForTests({ secrets: { send: async () => {
  throw Object.assign(new Error('offline'), { name: 'CredentialsProviderError' });
} } as any });

describe('calendar invite SOP contract', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'orin-selected' }, 'test');
    offline();
  });
  afterEach(() => { setCalendarHoldGoogleDepsForTests({}); offline(); });
  after(stopLocal);

  it('propose → confirm → release: Orin organizer, two calendar blocks, one normal invitation', async () => {
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const created = await invoke('POST', '/api/calendar-holds', { ...input, title: `Proposed - ${input.title}` });
    assert.equal(created.status, 201);
    const hold = created.hold;
    assert.equal(hold.title, input.title);
    assert.equal(hold.googleTitle, `(Proposal) ${input.title}`);
    assert.equal(hold.googleSync.state, 'synced', hold.googleSync.reason);
    assert.deepEqual(Object.keys(hold.googleEventIds).sort(), [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS].sort());
    const proposals = [...google.events.values()].flatMap((store) => [...store.values()]);
    assert.equal(proposals.length, 3, 'organizer source plus two target blocks');
    assert.equal(new Set(proposals.map((e) => e.iCalUID)).size, 1);
    for (const event of proposals) {
      assert.equal(event.summary, hold.googleTitle);
      assert.equal(event.description, '');
      assert.equal(event.organizer.email, HOLD_ORGANIZER);
      assert.deepEqual(event.attendees, []);
      assert.ok(!JSON.stringify(event).includes(hold.id));
      assert.ok(!('conferenceData' in event));
    }
    const confirmed = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.hold.title, input.title);
    assert.equal(confirmed.hold.googleTitle, input.title);
    assert.equal(confirmed.hold.googleSync.state, 'synced');
    const invites = google.calls.filter((c) => c.method === 'PATCH' && c.url.searchParams.get('sendUpdates') === 'all');
    assert.equal(invites.length, 1);
    assert.ok(decodeURIComponent(invites[0].url.pathname).includes(HOLD_ORGANIZER));
    assert.deepEqual(invites[0].body.attendees, [input.guestRef, ...HOLD_REQUIRED_ATTENDEES].map((email) => ({ email })));
    assert.equal(invites[0].body.guestsCanModify, true);
    for (const store of google.events.values()) for (const event of store.values()) {
      assert.equal(event.summary, input.title);
      assert.equal(event.description, `Zoom link: ${HOLD_ZOOM_LOCATION}\n\nPodcast document: ${input.documentUrl}`);
      assert.doesNotMatch(event.description, /DataOps|hold_|tentative|confirmed/);
      assert.equal(event.location, HOLD_ZOOM_LOCATION);
      assert.equal(event.start.dateTime, '2026-11-03T11:25:00.000Z');
      assert.equal(event.end.dateTime, hold.endIso);
      assert.equal(event.start.timeZone, 'Europe/Berlin');
    }
    const count = google.calls.length;
    assert.equal((await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`)).status, 409);
    assert.equal(google.calls.length, count);
    await invoke('POST', `/api/calendar-holds/${hold.id}/release`);
    assert.ok([...google.events.values()].every((store) => store.size === 0));
    assert.equal(google.calls.filter((c) => c.method === 'DELETE' && c.url.searchParams.get('sendUpdates') === 'all').length, 1);
    assert.ok(google.calls.filter((c) => c.url.pathname === '/api/agent/token').every((c) =>
      c.body.connection_id === 'orin-selected' && c.body.agent === 'personal-scheduler'));
  });

  it('rejects the personal Gmail identity before event writes', async () => {
    const google = holdGoogleProvider();
    google.state.account = 'alexey.s.grigoriev@gmail.com';
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const result = await invoke('POST', '/api/calendar-holds', input);
    assert.equal(result.hold.googleSync.state, 'deferred');
    assert.match(result.hold.googleSync.reason, /Orin/);
    assert.equal(google.events.size, 0);
  });

  it('recovers partial copies and a lost invitation response without duplicates', async () => {
    const google = holdGoogleProvider();
    google.state.failCalendar = DEFAULT_HOLD_GOOGLE_CALENDARS[1];
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const { hold } = await invoke('POST', '/api/calendar-holds', {
      ...input, title: 'Guest at DataTalks.Club Workshop', duration: 90,
    });
    assert.equal(hold.googleSync.state, 'deferred');
    assert.equal(Object.keys(hold.googleEventIds).length, 2);
    google.state.failCalendar = '';
    google.state.loseInviteResponse = true;
    const first = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`);
    assert.equal(first.hold.googleSync.state, 'deferred');
    const retried = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`);
    assert.equal(retried.hold.googleSync.state, 'synced', retried.hold.googleSync.reason);
    assert.equal(google.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/import')).length, 3);
    assert.equal(google.calls.filter((c) => c.method === 'PATCH' && c.url.searchParams.get('sendUpdates') === 'all').length, 1);
    const organizer = [...google.events.get(HOLD_ORGANIZER)!.values()][0];
    assert.match(organizer.description, /Outline document:/);
    assert.equal(Date.parse(organizer.end.dateTime) - Date.parse(organizer.start.dateTime), 95 * 60000);
  });

  it('uses Secrets Manager and the stored connection when propose was deferred', async () => {
    const { hold } = await invoke('POST', '/api/calendar-holds', input);
    assert.equal(hold.googleSync.state, 'deferred');
    const google = holdGoogleProvider();
    let reads = 0;
    setDapierBrokerClientsForTests({ secrets: { send: async (command: any) => {
      assert.equal(command.input.SecretId, 'personal-scheduler/dapier-api-token');
      reads++; return { SecretString: JSON.stringify({ api_token: 'test-machine' }) };
    } } as any });
    setCalendarHoldGoogleDepsForTests({ fetchImpl: google.fetchImpl });
    const result = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`);
    assert.equal(result.hold.googleSync.state, 'synced');
    assert.equal(reads, 1);
    assert.equal(google.calls[0].body.connection_id, 'orin-selected');
    assert.deepEqual(await getCalendarHold(client, hold.id), result.hold);
  });

  it('cannot confirm without a permitted guest or send independent personal-owned events', async () => {
    for (const guestRef of [undefined, 'guest-slug', 'valeriia@datatalks.club']) {
      const { hold } = await invoke('POST', '/api/calendar-holds', { ...input, guestRef });
      assert.equal((await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`)).status, 422);
      assert.equal((await getCalendarHold(client, hold.id))?.status, 'tentative');
    }
    const { hold } = await invoke('POST', '/api/calendar-holds', input);
    await putCalendarHold(client, { ...hold, googleEventIds: { 'alexey.s.grigoriev@gmail.com': 'independent-event' } });
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const result = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`);
    assert.equal(result.hold.googleSync.state, 'deferred');
    assert.match(result.hold.googleSync.reason, /organizer reconciliation/);
    assert.equal(google.calls.length, 0);
  });

  it('confirmation accepts the guest later and includes only the named guest document from its Card', async () => {
    await client.send(new PutCommand({ TableName: TABLE_CARDS, Item: {
      PK: 'CARD#invite-document', SK: 'CARD#invite-document', id: 'invite-document',
      ...templateLink(), version: 1, status: 'active', stage: 'preparation', taskCount: 0, openTaskCount: 0, cardLinks: [
        { name: 'Guest research', url: 'https://example.com/internal-research' },
        { name: 'Guest materials', url: 'https://example.com/guest-document' },
      ],
    } }));
    const { hold } = await invoke('POST', '/api/calendar-holds', { ...input, cardId: 'invite-document', documentUrl: undefined, guestRef: undefined });
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ credential: 'test-machine', fetchImpl: google.fetchImpl });
    const result = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`, { guestRef: input.guestRef });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.hold.googleSync.state, 'synced');
    const organizer = [...google.events.get(HOLD_ORGANIZER)!.values()][0];
    assert.match(organizer.description, /Podcast document: https:\/\/example.com\/guest-document/);
    assert.doesNotMatch(organizer.description, /research/);
    assert.equal(result.hold.guestRef, input.guestRef);
  });

  it('normalizes both SOP proposal spellings and validates document links', async () => {
    for (const prefix of ['(Proposal) ', 'Proposed - ', 'Proposed ']) assert.equal(confirmedTitle(prefix + input.title), input.title);
    const result = await invoke('POST', '/api/calendar-holds', { ...input, documentUrl: 'javascript:alert(1)' });
    assert.equal(result.status, 400);
  });
});
