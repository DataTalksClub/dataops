import { installOwnerAvailabilityFixture } from './helpers/owner-availability';
installOwnerAvailabilityFixture();
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, PUBLIC_DTC_EVENTS_CALENDAR } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { HOLD_ZOOM_LOCATION } from '../src/calendar/holds';
import { lumaEventSubtitle } from '../src/calendar/lumaEvents';
import { cardEventInterval } from '../src/calendar/cardEventTime';
import { getClient } from '../src/db/client';
import { getCalendarHold, putCalendarHold } from '../src/db/calendarHolds';
import { getCardConsistent, updateCard } from '../src/db/cards';
import { createTemplate } from '../src/db/templates';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { invokeHistoricalHoldFixture as handler } from './helpers/historical-card-hold';
import { LUMA_SUBTITLE, holdGoogleProvider } from './helpers/hold-google';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';

const LUMA = 'https://luma.com/public-entry-podcast';
const STREAM = 'https://www.youtube.com/datatalksclub';
const PUBLIC_DESCRIPTION = `${LUMA_SUBTITLE}\nStream: ${STREAM}\nLuma: ${LUMA}`;
/** The scheduling notes a podcast Card's description holds; never public. */
const INTERNAL_NOTES = 'Date confirmed: guest agreed by email (Gmail 1a1bd4f6d74ebe79); guest thread 1a1b1fdaaab1a625; Amazon email gurramk@amazon.com';

async function invoke(method: string, path: string, body?: unknown, queryStringParameters = {}) {
  const res = await handler({ httpMethod: method, path, body: body ? JSON.stringify(body) : null, queryStringParameters }, {});
  return { code: res.statusCode, data: JSON.parse(res.body), raw: res.body };
}

describe('public DTC events entry beside a guest invitation', () => {
  let db: DynamoDBDocumentClient;
  let checklistFixture: ReturnType<typeof createTaskChecklistFixture>;
  before(async () => {
    checklistFixture = createTaskChecklistFixture();
    configureTaskChecklistStore(checklistFixture.store);
    db = await getClient(await startLocal());
    await createTables(db);
  });
  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    configureTaskChecklistStore(null);
    checklistFixture.cleanup();
    await stopLocal();
  });

  function google() {
    const provider = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ fetchImpl: provider.fetchImpl, credential: 'test', connectionId: 'orin' });
    return provider;
  }
  /** A podcast Card with a Luma link, a proposed hold and an internal description, as Orin schedules one. */
  async function podcastCard(label: string) {
    const template = await createTemplate(db, { name: label, type: 'podcast', origin: 'git', triggerType: 'manual', taskDefinitions: [
      { refId: 'create-calendar-invite', description: 'Create a calendar invite for the guests', offsetDays: 0 },
    ] });
    const created = await invoke('POST', '/api/cards', { templateId: template.id, title: `${label} at DataTalks.Club`, anchorDate: '2026-12-01' });
    assert.equal(created.code, 201, created.raw);
    const { card } = created.data;
    await updateCard(db, card.id, {
      expectedVersion: card.version,
      patch: { description: INTERNAL_NOTES, cardLinks: [{ name: 'Luma', url: LUMA }] },
    });
    const proposed = await invoke('POST', '/api/calendar-holds', { date: '2026-12-01', title: label, topic: 'Test', cardId: card.id, guestRef: 'guest@example.test' });
    assert.equal(proposed.code, 201, proposed.raw);
    return { card: (await getCardConsistent(db, card.id))!, hold: proposed.data.hold };
  }
  const time = (cardId: string, at: string, body: Record<string, unknown> = {}) =>
    invoke('POST', `/api/cards/${cardId}/time`, { at, duration: 60, tz: 'Europe/Berlin', guestEmails: ['guest@example.test'], ...body });
  const publicEvents = (provider: ReturnType<typeof holdGoogleProvider>) => [...(provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)?.values() || [])];
  const publicRows = (card: { calendarInvites?: Array<{ calendar: string }> }) =>
    (card.calendarInvites || []).filter((invite) => invite.calendar === PUBLIC_DTC_EVENTS_CALENDAR);
  const inviteTasks = async (cardId: string) => (await invoke('GET', '/api/tasks', undefined, { cardId })).data.tasks;
  /** Organizer PATCHes that notify guests: one per real invitation or move, never per rerun. */
  const guestNotifications = (provider: ReturnType<typeof holdGoogleProvider>) => provider.calls.filter((call) =>
    call.method === 'PATCH' && call.url.searchParams.get('sendUpdates') === 'all'
    && decodeURIComponent(call.url.pathname).includes(HOLD_ORGANIZER)).length;

  it('cards time adds exactly one SOP-format public entry beside the private invitation and links it as the DTC events row', async () => {
    const provider = google();
    const { card } = await podcastCard('Public entry');
    const timed = await time(card.id, '2026-12-01 17:00');
    assert.equal(timed.code, 200, timed.raw);
    assert.equal(timed.data.invite.outcome, 'sent');

    assert.equal(publicEvents(provider).length, 1, 'exactly one public entry');
    const [entry] = publicEvents(provider);
    assert.equal(entry.summary, card.title, 'the public entry carries the event title, not the guest invitation title');
    assert.equal(entry.start.dateTime, '2026-12-01T16:00:00.000Z', 'real event time: 17:00 Berlin, not the T-5 invitation window');
    assert.equal(entry.end.dateTime, '2026-12-01T17:00:00.000Z');
    assert.equal(entry.start.timeZone, 'Europe/Berlin');
    assert.equal(entry.location, STREAM);
    assert.equal(entry.description, PUBLIC_DESCRIPTION);
    assert.deepEqual(entry.attendees || [], [], 'a public entry has no guests');
    assert.ok(!('conferenceData' in entry), 'a public entry has no meeting');
    assert.ok(!JSON.stringify(entry).includes('amazon.com'), 'the Card description is internal and never published');
    assert.equal(provider.calls.find((call) => call.method === 'POST' && decodeURIComponent(call.url.pathname).includes(PUBLIC_DTC_EVENTS_CALENDAR)
      && !call.url.pathname.endsWith('/import'))!.url.searchParams.get('sendUpdates'), 'none');

    // Separate from the invitation: that keeps Zoom and the guest, and never invites the public calendar.
    const ids = timed.data.card.eventTime.googleEventIds;
    assert.equal(entry.id, ids[PUBLIC_DTC_EVENTS_CALENDAR]);
    assert.notEqual(ids[PUBLIC_DTC_EVENTS_CALENDAR], ids[HOLD_ORGANIZER]);
    const organizer = provider.events.get(HOLD_ORGANIZER)!.get(ids[HOLD_ORGANIZER]);
    assert.equal(organizer.location, HOLD_ZOOM_LOCATION);
    assert.ok(organizer.attendees.some((attendee: { email: string }) => attendee.email === 'guest@example.test'));
    assert.ok(!organizer.attendees.some((attendee: { email: string }) => attendee.email === PUBLIC_DTC_EVENTS_CALENDAR));
    assert.deepEqual(Object.keys(ids), [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
    assert.equal(timed.data.invite.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], entry.id);

    // Linked on the Card as its single DTC events row, and listed live by cards invite list.
    assert.equal(publicRows(timed.data.card).length, 1);
    assert.equal(publicRows(timed.data.card)[0].eventId, entry.id);
    assert.equal(publicRows(timed.data.card)[0].label, card.title);
    assert.deepEqual(timed.data.card.calendarInvites.map((invite) => invite.calendar),
      [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
    const listed = await invoke('GET', `/api/cards/${card.id}/calendar-invites`, undefined, { verify: '1' });
    assert.equal(listed.data.check.state, 'verified');
    assert.equal(listed.data.invites.find((invite: { calendar: string }) => invite.calendar === PUBLIC_DTC_EVENTS_CALENDAR).staleAt, undefined);
    assert.equal(timed.data.taskClosure.outcome, 'closed');
    assert.equal((await inviteTasks(card.id))[0].status, 'done');
  });

  it('a rerun reuses the same entries and a move updates the public entry in place', async () => {
    const provider = google();
    const { card } = await podcastCard('Moved entry');
    const first = (await time(card.id, '2026-12-01 17:00')).data;
    const [publicId, organizerId] = [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER].map((calendar) => first.card.eventTime.googleEventIds[calendar]);
    assert.equal(guestNotifications(provider), 1);

    const again = (await time(card.id, '2026-12-01 17:00')).data;
    assert.equal(again.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], publicId);
    assert.equal(publicRows(again.card).length, 1, 'one DTC events row after a rerun');
    assert.equal(publicEvents(provider).length, 1, 'a rerun adds no second public entry');
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    assert.equal(guestNotifications(provider), 1, 'a rerun notifies nobody');

    const moved = (await time(card.id, '2026-12-08 18:00', { duration: 90 })).data;
    assert.equal(moved.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], publicId, 'the public entry moves; none is left behind at the old time');
    assert.equal(moved.card.eventTime.googleEventIds[HOLD_ORGANIZER], organizerId);
    assert.equal(publicEvents(provider).length, 1);
    const entry = provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.get(publicId);
    assert.equal(entry.start.dateTime, '2026-12-08T17:00:00.000Z');
    assert.equal(entry.end.dateTime, '2026-12-08T18:30:00.000Z');
    assert.equal(entry.location, STREAM);
    assert.equal(entry.description, PUBLIC_DESCRIPTION);
    assert.deepEqual(publicRows(moved.card).map((row) => row.eventId), [publicId]);
    assert.equal(guestNotifications(provider), 2, 'only the move notifies the guest');
    // The public calendar is only ever written silently.
    for (const call of provider.calls.filter((item) => ['POST', 'PATCH'].includes(item.method)
      && decodeURIComponent(item.url.pathname).includes(PUBLIC_DTC_EVENTS_CALENDAR) && !item.url.pathname.endsWith('/import'))) {
      assert.equal(call.url.searchParams.get('sendUpdates'), 'none');
    }
  });

  it('a deferred public leg leaves the Card deferred and the invite Task open; the rerun completes it without re-inviting', async () => {
    const provider = google();
    provider.state.failCalendar = PUBLIC_DTC_EVENTS_CALENDAR;
    const { card } = await podcastCard('Deferred entry');
    const first = await time(card.id, '2026-12-01 17:00');
    assert.equal(first.code, 502, first.raw);
    assert.equal(first.data.invite.outcome, 'deferred');
    assert.match(first.data.error, /public event sync could not complete/);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1, 'the invitation itself was written');
    assert.equal(publicEvents(provider).length, 0);
    // What is live is linked, so the missing DTC events row is visible.
    assert.deepEqual(first.data.card.calendarInvites.map((invite) => invite.calendar), [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
    assert.equal(first.data.taskClosure.outcome, 'not_attempted');
    assert.equal((await inviteTasks(card.id))[0].status, 'todo', 'the Task cannot close while the public entry is missing');
    assert.equal(guestNotifications(provider), 1);

    provider.state.failCalendar = '';
    const retried = await time(card.id, '2026-12-01 17:00');
    assert.equal(retried.code, 200, retried.raw);
    assert.equal(retried.data.invite.outcome, 'sent');
    assert.equal(retried.data.taskClosure.outcome, 'closed');
    assert.equal(publicEvents(provider).length, 1);
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 1);
    assert.equal(publicRows(retried.data.card).length, 1);
    assert.equal(retried.data.card.calendarInvites.length, 3);
    assert.equal((await inviteTasks(card.id))[0].status, 'done');
    assert.equal(guestNotifications(provider), 1, 'the retry notifies nobody');
  });

  it('a hold that still carries a pre-Orin invitation blocks only the invitation: the public entry is created and listed', async () => {
    const provider = google();
    const { card, hold } = await podcastCard('Legacy hold');
    // Before invitations had an Orin organizer, a hold recorded its Google events under other calendars.
    await putCalendarHold(db, { ...hold, googleEventIds: { primary: 'legacy-invite', [PUBLIC_DTC_EVENTS_CALENDAR]: 'gone-public-copy' } });
    const timed = await time(card.id, '2026-12-01 17:00');
    assert.equal(timed.code, 502, timed.raw);
    assert.match(timed.data.error, /organizer reconciliation before sending an Orin invite/);
    assert.equal(timed.data.invite.outcome, 'deferred');
    assert.equal(guestNotifications(provider), 0, 'a pre-Orin invitation is never re-issued or impersonated');

    const [entry] = publicEvents(provider);
    assert.equal(publicEvents(provider).length, 1, 'the gone public copy is neither reused nor duplicated');
    assert.equal(entry.summary, card.title);
    assert.equal(entry.description, PUBLIC_DESCRIPTION);
    assert.deepEqual(timed.data.card.calendarInvites.map((invite) => [invite.calendar, invite.eventId]), [[PUBLIC_DTC_EVENTS_CALENDAR, entry.id]]);
    assert.equal(timed.data.card.eventTime.sync, 'deferred');
    assert.equal(timed.data.card.eventTime.googleEventIds.primary, 'legacy-invite');
    assert.equal((await inviteTasks(card.id))[0].status, 'todo');
    const listed = await invoke('GET', `/api/cards/${card.id}/calendar-invites`, undefined, { verify: '1' });
    assert.equal(listed.data.check.state, 'verified');
    assert.equal(listed.data.invites.length, 1);
    assert.equal(listed.data.invites[0].staleAt, undefined);
    assert.equal(timed.data.hold.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined);

    // A rerun moves nothing and adds nothing.
    const again = await time(card.id, '2026-12-01 17:00');
    assert.equal(again.code, 502, again.raw);
    assert.equal(again.data.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], entry.id);
    assert.equal(publicEvents(provider).length, 1);
    assert.equal(guestNotifications(provider), 0);
  });

  it('waits for the Luma subtitle rather than publish the Card description or an entry without one', async () => {
    const provider = google();
    provider.state.lumaStatus = 404;
    const { card } = await podcastCard('No Luma subtitle');
    const first = await time(card.id, '2026-12-01 17:00');
    assert.equal(first.code, 502, first.raw);
    assert.match(first.data.error, /Luma page did not provide one/);
    assert.equal(publicEvents(provider).length, 0, 'nothing is published without the Luma subtitle');

    provider.state.lumaStatus = 200;
    const retried = await time(card.id, '2026-12-01 17:00');
    assert.equal(retried.code, 200, retried.raw);
    assert.equal(publicEvents(provider)[0].description, PUBLIC_DESCRIPTION);
    assert.ok(!JSON.stringify(publicEvents(provider)).includes('amazon.com'), 'the Card description is internal and never published');
  });

  it('confirm-hold creates the public entry too, and the hold itself carries the invitation only', async () => {
    const provider = google();
    const { card, hold } = await podcastCard('Confirmed hold');
    const confirmed = await invoke('POST', `/api/calendar-holds/${hold.id}/confirm`, {});
    assert.equal(confirmed.code, 200, confirmed.raw);
    assert.equal(confirmed.data.hold.googleSync.state, 'synced');

    const storedHold = (await getCalendarHold(db, hold.id))!;
    assert.ok(storedHold.googleEventIds[HOLD_ORGANIZER]);
    assert.equal(storedHold.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined, 'releasing the hold never has to touch the public calendar');
    const stored = (await getCardConsistent(db, card.id))!;
    assert.equal(publicRows(stored).length, 1);
    const [entry] = publicEvents(provider);
    assert.equal(entry.id, stored.eventTime!.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR]);
    assert.equal(entry.summary, card.title);
    assert.equal(entry.description, PUBLIC_DESCRIPTION);
    assert.deepEqual(entry.attendees || [], []);

    // Re-timing the Card keeps the hold free of the public entry and moves the entry in place.
    const moved = await time(card.id, '2026-12-02 17:00');
    assert.equal(moved.code, 200, moved.raw);
    assert.equal(moved.data.hold.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined);
    assert.equal(moved.data.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], entry.id);
    assert.equal(publicEvents(provider).length, 1);
  });

  it('never reuses a legacy public attendee copy, and leaves a matching hand-made entry with guests untouched', async () => {
    const provider = google();
    // Before public entries stood alone, the public calendar held an attendee copy of the invitation.
    const legacy = {
      id: 'legacy-copy', status: 'confirmed', summary: 'Legacy episode', location: HOLD_ZOOM_LOCATION,
      description: 'Zoom link: https://zoom.us/j/1', attendees: [{ email: 'guest@example.test' }],
      start: { dateTime: '2026-12-01T16:00:00.000Z', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-12-01T17:00:00.000Z', timeZone: 'Europe/Berlin' },
    };
    provider.events.set(PUBLIC_DTC_EVENTS_CALENDAR, new Map([['legacy-copy', legacy]]));
    const { card, hold } = await podcastCard('Legacy copy');
    const interval = cardEventInterval('2026-12-01 17:00');
    const seeded = await updateCard(db, card.id, {
      expectedVersion: card.version,
      patch: {
        eventTime: { ...interval, eventKey: hold.id, googleEventIds: { ...hold.googleEventIds, [PUBLIC_DTC_EVENTS_CALENDAR]: 'legacy-copy' }, sync: 'synced', syncStartedAt: new Date().toISOString() },
        calendarInvites: [{ eventId: 'legacy-copy', calendar: PUBLIC_DTC_EVENTS_CALENDAR, createdAt: new Date().toISOString(), createdBy: 'test' }],
      },
    });
    const timed = await time(card.id, '2026-12-01 17:00');
    assert.equal(timed.code, 200, timed.raw);
    assert.deepEqual(provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.get('legacy-copy'), legacy, 'the legacy copy is neither edited nor deleted');
    assert.equal(publicEvents(provider).length, 2);
    assert.deepEqual(publicRows(timed.data.card).map((row) => row.eventId), [timed.data.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR]]);
    assert.notEqual(timed.data.card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], 'legacy-copy');
    assert.equal(timed.data.hold.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined);
    assert.equal(seeded.version, card.version + 1);

    // A hand-made entry that matches this event but has guests is reported, never edited or duplicated.
    const { card: other } = await podcastCard('Handmade entry');
    const handmade = {
      id: 'handmade', status: 'confirmed', summary: other.title, location: STREAM,
      description: `A hand-made subtitle\nStream: ${STREAM}\nLuma: ${LUMA}`, attendees: [{ email: 'someone@example.test' }],
      start: { dateTime: '2026-12-03T16:00:00.000Z', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-12-03T17:00:00.000Z', timeZone: 'Europe/Berlin' },
    };
    provider.events.set(PUBLIC_DTC_EVENTS_CALENDAR, new Map([['handmade', handmade]]));
    const refused = await time(other.id, '2026-12-03 17:00');
    assert.equal(refused.code, 502, refused.raw);
    assert.match(refused.data.error, /attendees or private meeting details; it was left untouched/);
    assert.deepEqual([...provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.values()], [handmade]);
  });
});

describe('Luma event subtitle', () => {
  const page = (content: string) => (async () => new Response(
    `<meta property="og:title" content="Event · Luma"><meta content="${content}" property="og:description">`, { status: 200 })) as typeof fetch;

  it('is the first line of the public og:description, entities decoded and bounded; a missing page gives none', async () => {
    assert.equal(await lumaEventSubtitle(LUMA, page('Agents &quot;answering questions&quot; - Ann &amp; Bob&#x27;s team&#10;Long description &hellip;')),
      'Agents "answering questions" - Ann & Bob\'s team');
    assert.equal((await lumaEventSubtitle(LUMA, page(`${'s'.repeat(400)}&#10;next`)))!.length, 300);
    assert.equal(await lumaEventSubtitle(LUMA, (async () => new Response('<meta name="description" content="not the public one">')) as typeof fetch), undefined);
    assert.equal(await lumaEventSubtitle(LUMA, (async () => new Response('gone', { status: 404 })) as typeof fetch), undefined);
    assert.equal(await lumaEventSubtitle(LUMA, (async () => { throw new Error('offline'); }) as typeof fetch), undefined);
  });
});
