import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { buildHold, confirmHoldRecord } from '../src/calendar/holds';
import { putCalendarHold } from '../src/db/calendarHolds';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
import { createCard, getCardConsistent } from '../src/db/cards';
import { createTask, getTask } from '../src/db/tasks';
import { listUndismissedNotifications } from '../src/db/notifications';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { setCalendarHoldGoogleDepsForTests } from '../src/db/calendarHolds';
import { getEventRecord } from '../src/events/store';
import { approveEvent, proposeEvent, rescheduleEvent, retryEventOperation, updateEvent } from '../src/events/service';
import { syncCardInvite } from '../src/calendar/cardInvite';
import { buildGuestInvite, GuestInviteValidationError } from '../src/calendar/guestInvite';
import { HOLD_ORGANIZER, type HoldGoogleDeps } from '../src/calendar/holdGoogleSync';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';
import { HOLD_ZOOM_LOCATION } from '../src/calendar/holds';
import { OWNER_PERSONAL_CALENDAR, OWNER_WORK_EMAIL } from '../src/identity/operatingIdentities';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import { holdGoogleProvider } from './helpers/hold-google';
import { policy } from './helpers/eventPolicy';
import { templateLink } from './helpers/cardTemplate';

// Hard rule: no real guests. Dev-only addresses; Google is a local fake.
const GUEST = 'dev+invite-guest@dtcdev.click';
const GUEST_NAME = 'Julien Khaleghy';
const DOC = 'https://dataops.example/podcast-docs/abc123';
const [PERSONAL] = DEFAULT_HOLD_GOOGLE_CALENDARS;

let client: DynamoDBDocumentClient;
let google: ReturnType<typeof holdGoogleProvider>;
let templateId: string;
let checklist: ReturnType<typeof createTaskChecklistFixture>;
let n = 0;

const deps = (): HoldGoogleDeps => ({ credential: 'test-machine', connectionId: 'orin-calendar', fetchImpl: google.fetchImpl });

/** Everything a guest or Alexey can see on the invite, from the fake Google store. */
function liveInvite(eventIds: Record<string, string>) {
  const organizer = google.events.get(HOLD_ORGANIZER)!.get(eventIds[HOLD_ORGANIZER])!;
  const personal = google.events.get(PERSONAL)!.get(eventIds[PERSONAL])!;
  return {
    summary: organizer.summary,
    description: organizer.description,
    location: organizer.location,
    attendees: (organizer.attendees || []).map((a: any) => a.email.toLowerCase()).sort(),
    calendars: Object.keys(eventIds).sort(),
    personal: { summary: personal.summary, description: personal.description },
  };
}

async function podcastCard(title = 'Podcast conversation with Julien Khaleghy') {
  n++;
  return createCard(client, {
    ...templateLink({ id: templateId, version: 1 } as any),
    title, anchorDate: `2026-12-${String(10 + n).padStart(2, '0')}`, people: [GUEST_NAME], guestEmails: [GUEST],
    cardLinks: [{ name: 'Podcast document', url: DOC }],
  });
}

describe('shared podcast guest-invite builder (Hub intake 0d56721e)', () => {
  before(async () => {
    checklist = createTaskChecklistFixture();
    configureTaskChecklistStore(checklist.store);
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'orin-calendar' }, 'test-operator');
    // The Template policy is deliberately NOT canonical: free-text description,
    // a placeholder title and a different Zoom room. The builder must win.
    const eventPolicy = policy('podcast');
    eventPolicy.description = 'Event: {title}\nGuest: {guestNames}\nTopic: {topic}\nGuest form: {documentUrl}';
    for (const notification of Object.values(eventPolicy.notifications)) notification.emails = [];
    templateId = (await createTemplate(client, { name: 'Podcast', type: 'podcast', eventPolicy, taskDefinitions: [] })).id;
  });
  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    configureTaskChecklistStore(null);
    checklist.cleanup();
    await stopLocal();
  });

  it('builder: guest-named title, Zoom description, Alexey twice (canonical), personal calendar', () => {
    const invite = buildGuestInvite({
      eventKey: 'hold_x', eventType: 'podcast', title: 'Podcast conversation with Julien Khaleghy',
      guestTitle: `${GUEST_NAME} at DataTalks.Club Podcast`, documentUrl: DOC, guests: [GUEST],
      startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z',
    });
    assert.equal(invite.summary, 'Julien Khaleghy at DataTalks.Club Podcast');
    assert.equal(invite.description, `Zoom link: ${HOLD_ZOOM_LOCATION}\n\nPodcast document: ${DOC}`);
    assert.equal(invite.location, HOLD_ZOOM_LOCATION);
    assert.deepEqual([...invite.attendees].sort(), [GUEST, OWNER_PERSONAL_CALENDAR, OWNER_WORK_EMAIL].sort());
    assert.deepEqual(invite.calendars, [OWNER_PERSONAL_CALENDAR]);
    assert.equal(invite.startIso, '2026-12-15T16:55:00.000Z');
  });

  it('every path that creates or updates a guest invite produces the same title, description, calendars and guests', async () => {
    google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ ...deps() });
    const expected = (proposed: boolean) => {
      const invite = buildGuestInvite({
        eventKey: 'k', eventType: 'podcast', title: 'x', guestTitle: `${GUEST_NAME} at DataTalks.Club Podcast`, documentUrl: DOC,
        guests: [GUEST], startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z', proposed,
      });
      return { summary: invite.summary, description: invite.description, location: invite.location, attendees: [...invite.attendees].sort() };
    };
    const shape = (live: ReturnType<typeof liveInvite>) => ({
      summary: live.summary, description: live.description, location: live.location, attendees: live.attendees,
    });

    // 1. confirm-hold / `cards time` path
    const timed = await podcastCard();
    const sync = await syncCardInvite(client, timed, {
      startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z', timeZone: 'Europe/Berlin', durationMinutes: 60,
    }, [GUEST], deps(), 'test-operator');
    const confirmHold = liveInvite(sync.sync.eventIds);

    // 2. event approve (propose, then approve) — and every later path on that event
    const approvedCard = await podcastCard();
    await proposeEvent(client, approvedCard.id, { date: '2026-12-15', time: '18:00', guestEmails: [GUEST], deps: deps(), actor: 'test-operator' });
    const approved = await approveEvent(client, approvedCard.id, { deps: deps(), actor: 'test-operator' });
    assert.equal(approved.event.status, 'approved');
    const approve = liveInvite(approved.event.googleEventIds);

    // 3. resend (retry of the same operation) and recovery (metadata update)
    const resent = await retryEventOperation(client, approvedCard.id, { deps: deps(), actor: 'test-operator' });
    const resend = liveInvite(resent.event.googleEventIds);
    const updated = await updateEvent(client, approvedCard.id, { deps: deps(), actor: 'test-operator' });
    const recovery = liveInvite(updated.event.googleEventIds);

    // 4. reschedule (back to a proposal: the same builder, with the proposal prefix)
    const rescheduledCard = await podcastCard();
    await proposeEvent(client, rescheduledCard.id, { date: '2026-12-15', time: '18:00', guestEmails: [GUEST], deps: deps(), actor: 'test-operator' });
    const moved = await rescheduleEvent(client, rescheduledCard.id, { date: '2026-12-16', time: '18:00', guestEmails: [GUEST], deps: deps(), actor: 'test-operator' });
    const reschedule = liveInvite(moved.event.googleEventIds);

    for (const [path, live] of Object.entries({ confirmHold, approve, resend, recovery })) {
      assert.deepEqual(shape(live), expected(false), `${path} differs from the canonical invite`);
      assert.deepEqual(live.calendars, [HOLD_ORGANIZER, PERSONAL].sort(), `${path} calendars`);
      assert.equal(live.personal.summary, live.summary, `${path}: the personal copy carries the same title`);
      assert.equal(live.personal.description, live.description, `${path}: the personal copy carries the same description`);
    }
    assert.deepEqual(shape(reschedule), expected(true), 'reschedule differs from the canonical proposed invite');
    // Spot-check the bug from the intake: no placeholder title, no raw internal description.
    assert.equal(approve.summary, 'Julien Khaleghy at DataTalks.Club Podcast');
    assert.ok(!/Event:|Topic:|Guest form:/.test(approve.description));
    assert.ok(approve.attendees.includes(OWNER_PERSONAL_CALENDAR) && approve.attendees.includes(OWNER_WORK_EMAIL));
  });

  it('approve fails loudly when the Google read-back is not canonical: Task failed, Orin notified, no success', async () => {
    google = holdGoogleProvider();
    // Google "normalises" the organizer event to the old placeholder format on read.
    const inner = google.fetchImpl;
    let tamper = false;
    const tampering: typeof fetch = async (input, init) => {
      const response = await inner(input, init);
      const url = new URL(String(input));
      if (tamper && (init?.method || 'GET') === 'GET' && url.pathname.includes(`/calendars/${encodeURIComponent(HOLD_ORGANIZER)}/events/`) && response.ok) {
        const event = await response.json();
        return Response.json({ ...event, summary: 'Podcast conversation with Julien Khaleghy', description: 'Event: x\nGuest: y' });
      }
      return response;
    };
    const failing = { ...deps(), fetchImpl: tampering };
    const card = await podcastCard();
    const task = await createTask(client, {
      cardId: card.id, description: 'Send the calendar invite', status: 'todo', requiresCalendarInvite: true,
    } as any);
    await proposeEvent(client, card.id, { date: '2026-12-15', time: '18:00', guestEmails: [GUEST], deps: failing, actor: 'test-operator' });
    tamper = true;
    const before = (await listUndismissedNotifications(client)).length;
    await assert.rejects(
      approveEvent(client, card.id, { deps: failing, actor: 'test-operator' }),
      (error: unknown) => error instanceof GuestInviteValidationError && error.problems.some(p => /title is/.test(p)) && error.problems.some(p => /description differs/.test(p)),
    );
    const notifications = (await listUndismissedNotifications(client)).filter(x => x.metadata?.guard === 'guest-invite-readback');
    assert.ok(notifications.length >= 1 && (await listUndismissedNotifications(client)).length > before);
    assert.equal(notifications.at(-1)!.type, 'automation-failure');
    assert.match(notifications.at(-1)!.message, /FAILED validation/);
    const failedTask = (await getTask(client, task.id))!;
    assert.equal(failedTask.status, 'todo', 'the invite Task is not completed');
    assert.ok(JSON.stringify(failedTask).includes('FAILED: the Google Calendar invite does not match'));
    const stored = (await getEventRecord(client, (await getCardConsistent(client, card.id))!.eventTime!.eventKey))!;
    assert.notEqual(stored.operations.at(-1)!.state, 'complete', 'the operation is never reported complete');
  });

  it('confirm-hold fails loudly on a mismatching read-back and an unreadable read-back is a failure, not a pass', async () => {
    google = holdGoogleProvider();
    const inner = google.fetchImpl;
    const unreadable: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method || 'GET') === 'GET' && /\/events\/[^/]+$/.test(url.pathname) && !url.searchParams.has('iCalUID')
        && url.pathname.includes(encodeURIComponent(PERSONAL))) return Response.json({}, { status: 503 });
      return inner(input, init);
    };
    const card = await podcastCard();
    await assert.rejects(
      syncCardInvite(client, card, {
        startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z', timeZone: 'Europe/Berlin', durationMinutes: 60,
      }, [GUEST], { ...deps(), fetchImpl: unreadable }, 'test-operator'),
      (error: unknown) => error instanceof GuestInviteValidationError && error.problems.some(p => p.includes(PERSONAL) && /could not read the event back/.test(p)),
    );
  });
  it('verify-invite is a read-only dry-run read-back of a confirmed hold', async () => {
    google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ ...deps() });
    const card = await podcastCard();
    const sync = await syncCardInvite(client, card, {
      startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z', timeZone: 'Europe/Berlin', durationMinutes: 60,
    }, [GUEST], deps(), 'test-operator');
    const hold = confirmHoldRecord(buildHold({
      date: '2026-12-15', title: `${GUEST_NAME} at DataTalks.Club Podcast`, topic: 'Topic', guestRef: GUEST, documentUrl: DOC, cardId: card.id,
    }, 'test-operator'));
    await putCalendarHold(client, { ...hold, startIso: '2026-12-15T17:00:00.000Z', endIso: '2026-12-15T18:00:00.000Z', googleEventIds: sync.sync.eventIds, googleSync: { state: 'synced' } });
    const verify = () => handler({ httpMethod: 'GET', path: `/api/calendar-holds/${hold.id}/verify-invite`, body: null, headers: { 'x-user-id': 'test-operator' }, queryStringParameters: {} });
    const writesBefore = google.calls.filter(c => c.method !== 'GET' && c.url.pathname.includes('/events')).length;
    const ok = JSON.parse((await verify()).body);
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    google.events.get(HOLD_ORGANIZER)!.get(sync.sync.eventIds[HOLD_ORGANIZER])!.summary = 'Podcast conversation with Julien Khaleghy';
    const bad = JSON.parse((await verify()).body);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p: string) => /title is/.test(p)));
    assert.equal(google.calls.filter(c => c.method !== 'GET' && c.url.pathname.includes('/events')).length, writesBefore, 'no Google writes');
  });
});
