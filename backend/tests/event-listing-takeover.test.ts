import { installOwnerAvailabilityFixture } from './helpers/owner-availability';
installOwnerAvailabilityFixture();
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, PUBLIC_DTC_EVENTS_CALENDAR } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { holdGuestAttendees } from '../src/calendar/holds';
import { getClient } from '../src/db/client';
import { createCard, getCardConsistent, updateCard } from '../src/db/cards';
import { createTemplate } from '../src/db/templates';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { type EventPolicy } from '../src/events/policy';
import { commitEventTransition, getEventRecord } from '../src/events/store';
import { EventConflictError, planEventTransition } from '../src/events/lifecycle';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { templateLink } from './helpers/cardTemplate';
import { holdGoogleProvider } from './helpers/hold-google';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import { handler } from '../src/handler';

/**
 * A webinar Card can get its private Zoom speaker invitation after
 * `cards time` already made its silent Luma entries (public DTC events entry
 * plus silent personal copies). The invitation takes the Card's eventTime and
 * leaves those entries live, untouched and separately linked.
 */

const LUMA = 'https://luma.com/listing-takeover-webinar';
const STREAM = 'https://www.youtube.com/datatalksclub';
const ZOOM = 'https://zoom.us/j/975318642';
const [ALEXEY_PERSONAL] = DEFAULT_HOLD_GOOGLE_CALENDARS;
const ALEXEY_OPS = 'alexey-ops@example.invalid';
const SPEAKER = 'speaker@example.invalid';

const POLICY: EventPolicy = {
  timeZone: 'Europe/Berlin', durationMinutes: 60, windows: { evening: '17:00' }, expiresDays: 7,
  titles: { proposed: '[Proposed] {title}', approved: '{title}' },
  description: '{topic}\n\nEvent page: {documentUrl}', inviteText: 'Zoom: {zoomUrl}',
  guests: { proposal: true, approved: true, requiredEmails: [ALEXEY_PERSONAL, ALEXEY_OPS], leadMinutes: 5 },
  zoom: { enabled: true, url: ZOOM },
  calendarAcceptance: { enabled: true, quorum: 'any' },
  notifications: {
    propose: { calendar: 'all', emails: [] }, approve: { calendar: 'all', emails: [] },
    reschedule: { calendar: 'all', emails: [] }, release: { calendar: 'all', emails: [] },
  },
};

async function invoke(method: string, path: string, body?: unknown, queryStringParameters = {}) {
  const res = await handler({ httpMethod: method, path, body: body === undefined ? null : JSON.stringify(body), queryStringParameters }, {});
  return { code: res.statusCode, data: JSON.parse(res.body), raw: res.body };
}

describe('private invitation beside a silent Luma listing', () => {
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

  /** The fake Google Calendar; every call to it is recorded. */
  function google() {
    const provider = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ fetchImpl: provider.fetchImpl, credential: 'test', connectionId: 'orin' });
    return provider;
  }
  type Provider = ReturnType<typeof holdGoogleProvider>;
  const event = (provider: Provider, calendar: string, id: string) => provider.events.get(calendar)!.get(id);
  /** A webinar Card with a Luma link, as an operator dates one by hand. */
  async function webinarCard(label: string) {
    const template = await createTemplate(db, { name: label, type: 'webinar', eventPolicy: POLICY, taskDefinitions: [] });
    return (await createCard(db, {
      ...templateLink(template as any), title: label, anchorDate: '2026-12-01', people: ['Speaker Name'],
      cardLinks: [{ name: 'Luma', url: LUMA }],
    }))!;
  }
  /** `cards time` without guests: the Card's own public entry and silent personal copies. */
  const silentTime = async (cardId: string, at: string) => {
    const res = await invoke('POST', `/api/cards/${cardId}/time`, { at, duration: 60, tz: 'Europe/Berlin' });
    assert.equal(res.code, 200, res.raw);
    assert.equal(res.data.sync.state, 'synced', JSON.stringify(res.data.sync));
    return res.data;
  };
  const propose = (cardId: string, body: Record<string, unknown> = {}) =>
    invoke('POST', `/api/events/${cardId}/propose`, { date: '2026-12-01', time: '17:00', timeZone: 'Europe/Berlin', guestEmails: [SPEAKER], ...body });
  const rows = (card: { calendarInvites?: Array<{ calendar: string; eventId: string; staleAt?: string }> }, ids: Record<string, string>) =>
    (card.calendarInvites || []).filter((invite) => Object.values(ids).includes(invite.eventId));
  const withoutOrganizerAttendee = (attendees: Array<{ email: string }>, calendar: string) =>
    attendees.map((attendee) => attendee.email.toLowerCase()).filter((email) => email !== calendar.toLowerCase());

  /** Assert a listing entry is still the attendee-free, Zoom-free public copy it was made as. */
  function assertListingEntry(entry: any, calendar: string) {
    assert.ok(entry, `${calendar}: the listing entry is live`);
    assert.equal(entry.location, STREAM);
    assert.ok(!('conferenceData' in entry), 'a listing entry has no meeting');
    assert.deepEqual(withoutOrganizerAttendee(entry.attendees || [], calendar), [], 'no speaker or Alexey address was added');
    assert.ok(!JSON.stringify(entry).includes(ZOOM), 'the Zoom room never reaches a listing entry');
  }

  it('a Card with only a silent listing answers event show with its listing and the propose command, not a 404', async () => {
    google();
    const card = await webinarCard('Listing only');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds = silent.card.eventTime.googleEventIds;

    const shown = await invoke('GET', `/api/events/${card.id}`);
    assert.equal(shown.code, 200, shown.raw);
    assert.equal(shown.data.event, null);
    assert.deepEqual(shown.data.listing, { eventKey: `card:${card.id}`, googleEventIds: listingIds });
    assert.match(shown.data.nextStep, /No private invitation exists for Card/);
    assert.match(shown.data.nextStep, new RegExp(`dataops event propose ${card.id} --date`));

    assert.equal((await invoke('GET', '/api/events/missing-card-id')).code, 404, 'an unknown target is still not found');
  });

  it('dry-run propose plans the invitation beside the listing and writes nothing', async () => {
    const provider = google();
    const card = await webinarCard('Dry run');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds = silent.card.eventTime.googleEventIds;
    const before = (await getCardConsistent(db, card.id))!;
    const googleCalls = provider.calls.length;

    const run = await propose(card.id, { dryRun: true, title: 'Dry run', documentUrl: LUMA });
    assert.equal(run.code, 200, run.raw);
    assert.equal(run.data.dryRun, true);
    assert.equal(run.data.event.id, `hold_${card.id}`);
    assert.equal(run.data.event.status, 'proposed');
    assert.deepEqual(run.data.listing, { eventKey: `card:${card.id}`, googleEventIds: listingIds });
    const planned = run.data.event.operations.at(-1).desired;
    assert.equal(planned.summary, '[Proposed] Dry run');
    assert.equal(planned.location, ZOOM, 'the template Zoom room');
    assert.deepEqual([...planned.attendees].sort(), [SPEAKER, ALEXEY_OPS, ALEXEY_PERSONAL].sort());
    assert.ok(!planned.attendees.includes(PUBLIC_DTC_EVENTS_CALENDAR), 'the public calendar is never a guest');
    assert.equal(planned.startIso, '2026-12-01T15:55:00.000Z', 'the 5-minute join lead before 17:00 Berlin');
    assert.equal(planned.endIso, '2026-12-01T17:00:00.000Z', 'the invitation runs to the end of the event');
    assert.equal(planned.timeZone, 'Europe/Berlin');
    assert.equal(planned.sendUpdates, 'all');
    assert.deepEqual(planned.emails, []);

    // Nothing was written: not the Card, not the event, not Google.
    assert.deepEqual((await getCardConsistent(db, card.id))!, before);
    assert.equal(await getEventRecord(db, `hold_${card.id}`), null);
    assert.equal(provider.calls.length, googleCalls);
  });

  it('propose creates the private invitation and keeps the silent listing live, untouched and separately linked', async () => {
    const provider = google();
    const card = await webinarCard('Takeover');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds: Record<string, string> = silent.card.eventTime.googleEventIds;
    assert.equal(silent.card.eventTime.eventKey, `card:${card.id}`);
    const listingBefore = Object.fromEntries(Object.entries(listingIds).map(([calendar, id]) => [calendar, structuredClone(event(provider, calendar, id))]));
    const { [PUBLIC_DTC_EVENTS_CALENDAR]: publicId, ...silentCopyIds } = listingIds;

    const proposed = await propose(card.id, { title: 'Takeover', documentUrl: LUMA });
    assert.equal(proposed.code, 201, proposed.raw);
    assert.equal(proposed.data.sync.state, 'synced', JSON.stringify(proposed.data.sync));

    // The invitation is its own event with its own Google events.
    const holdId = `hold_${card.id}`;
    assert.equal(proposed.data.event.id, holdId);
    assert.equal(proposed.data.event.status, 'proposed');
    const inviteIds = proposed.data.event.googleEventIds;
    assert.deepEqual(Object.keys(inviteIds).sort(), [HOLD_ORGANIZER, ALEXEY_PERSONAL].sort());
    assert.ok(!Object.values(inviteIds).some((id) => Object.values(listingIds).includes(id)), 'the invitation never takes a listing entry over');

    const organizer = event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]);
    assert.equal(organizer.organizer.email, HOLD_ORGANIZER, 'organized by Orin');
    assert.equal(organizer.summary, '[Proposed] Takeover');
    assert.equal(organizer.location, ZOOM);
    assert.ok(!('conferenceData' in organizer), 'never Google Meet');
    assert.deepEqual([...organizer.attendees.map((a: { email: string }) => a.email.toLowerCase())].sort(), [SPEAKER, ALEXEY_OPS, ALEXEY_PERSONAL].sort());
    assert.ok(!JSON.stringify(organizer).includes(PUBLIC_DTC_EVENTS_CALENDAR), 'the public calendar is not a guest');
    assert.equal(organizer.start.dateTime, '2026-12-01T15:55:00.000Z', 'the 5-minute join lead');
    assert.equal(organizer.end.dateTime, '2026-12-01T17:00:00.000Z');

    // The listing is exactly what it was: live, attendee-free, Zoom-free, not converted.
    for (const [calendar, id] of Object.entries(listingIds)) {
      assert.deepEqual(event(provider, calendar, id), listingBefore[calendar], `${calendar}: the listing entry was not edited`);
      assertListingEntry(event(provider, calendar, id), calendar);
    }
    assert.equal(provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 1, 'no second public entry');
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 2, 'the silent organizer copy and the invitation are separate events');
    assert.equal(provider.events.get(ALEXEY_PERSONAL)!.size, 2);
    // Nobody was told about the listing: only the organizer invitation notifies.
    for (const call of provider.calls.filter((item) => ['PATCH', 'POST'].includes(item.method)
      && !decodeURIComponent(item.url.pathname).includes(inviteIds[HOLD_ORGANIZER]))) {
      assert.notEqual(call.url.searchParams.get('sendUpdates'), 'all', 'only the invitation can notify');
    }

    // The Card links both, separately: the invitation owns eventTime, the listing keeps its own ids.
    const stored = (await getCardConsistent(db, card.id))!;
    assert.equal(stored.eventTime!.eventKey, holdId);
    assert.deepEqual(stored.eventTime!.googleEventIds, inviteIds);
    assert.deepEqual(stored.eventTime!.listing, { eventKey: `card:${card.id}`, googleEventIds: listingIds });
    assert.equal((await getEventRecord(db, holdId))!.googleEventIds[HOLD_ORGANIZER], inviteIds[HOLD_ORGANIZER]);
    assert.equal((await getEventRecord(db, holdId))!.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined);

    // cards invite list still shows the silent copies, verified, beside the invitation.
    assert.equal(rows(stored, listingIds).length, 3);
    assert.ok(rows(stored, listingIds).every((row) => !row.staleAt));
    assert.equal(rows(stored, inviteIds).length, 2);
    const listed = await invoke('GET', `/api/cards/${card.id}/calendar-invites`, undefined, { verify: '1' });
    assert.equal(listed.data.check.state, 'verified');
    assert.equal(listed.data.invites.length, 5);
    assert.ok(listed.data.invites.every((invite: { staleAt?: string }) => !invite.staleAt));

    // event show resolves the Card to its private event.
    const shown = await invoke('GET', `/api/events/${card.id}`);
    assert.equal(shown.code, 200, shown.raw);
    assert.equal(shown.data.event.id, holdId);
    assert.equal(shown.data.hold.lifecycleStatus, 'proposed');
    assert.deepEqual(shown.data.card.eventTime.listing.googleEventIds, listingIds);

    // Approving confirms the invitation only.
    const approved = await invoke('POST', `/api/events/${card.id}/approve`, {});
    assert.equal(approved.code, 200, approved.raw);
    assert.equal(approved.data.event.status, 'approved');
    assert.equal(event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]).summary, 'Takeover');
    for (const [calendar, id] of Object.entries({ [PUBLIC_DTC_EVENTS_CALENDAR]: publicId, ...silentCopyIds })) {
      assert.deepEqual(event(provider, calendar, id), listingBefore[calendar], `${calendar}: approval did not touch the listing`);
    }
    const approvedCard = (await getCardConsistent(db, card.id))!;
    assert.deepEqual(approvedCard.eventTime!.listing, { eventKey: `card:${card.id}`, googleEventIds: listingIds }, 'completing the operation keeps the listing');
    assert.deepEqual(approvedCard.eventTime!.googleEventIds, inviteIds);

    // Repeating propose is a real conflict and says which event is active.
    const again = await propose(card.id, { title: 'Takeover', documentUrl: LUMA });
    assert.equal(again.code, 409, again.raw);
    assert.equal(again.data.code, 'event_conflict');
    assert.match(again.data.error, new RegExp(`already has an active event \\(${holdId}, status=approved\\)`));
    assert.equal((await getCardConsistent(db, card.id))!.version, approvedCard.version, 'the refusal wrote nothing');

    // Releasing the invitation cancels its events only; the listing stays live and linked.
    const released = await invoke('POST', `/api/events/${card.id}/release`, {});
    assert.equal(released.code, 200, released.raw);
    assert.equal(released.data.sync.state, 'synced', JSON.stringify(released.data.sync));
    assert.equal(event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]), undefined);
    assert.equal(event(provider, ALEXEY_PERSONAL, inviteIds[ALEXEY_PERSONAL]), undefined);
    for (const [calendar, id] of Object.entries(listingIds)) {
      assert.deepEqual(event(provider, calendar, id), listingBefore[calendar], `${calendar}: the release left the listing alone`);
    }
    const releasedCard = (await getCardConsistent(db, card.id))!;
    assert.deepEqual(releasedCard.eventTime!.listing, { eventKey: `card:${card.id}`, googleEventIds: listingIds });
    assert.deepEqual(releasedCard.calendarInvites!.map((invite) => [invite.calendar, invite.eventId]).sort(),
      Object.entries(listingIds).sort());
  });

  it('cards time moves the listing and the invitation in place; neither duplicates nor takes the other over', async () => {
    const provider = google();
    const card = await webinarCard('Move');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds: Record<string, string> = silent.card.eventTime.googleEventIds;
    const proposed = await propose(card.id, { title: 'Move', documentUrl: LUMA });
    assert.equal(proposed.code, 201, proposed.raw);
    const inviteIds = proposed.data.event.googleEventIds;
    const { [PUBLIC_DTC_EVENTS_CALENDAR]: publicId, ...copyIds } = listingIds;

    const moved = await silentTime(card.id, '2026-12-02 18:00');
    const stored = (await getCardConsistent(db, card.id))!;
    assert.equal(stored.eventTime!.eventKey, `hold_${card.id}`);
    assert.deepEqual(stored.eventTime!.googleEventIds, inviteIds, 'eventTime still holds the invitation only');
    assert.equal(stored.eventTime!.listing!.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], publicId, 'the public entry moved; none was left behind');
    for (const [calendar, id] of Object.entries(copyIds)) assert.equal(stored.eventTime!.listing!.googleEventIds[calendar], id);
    assert.equal(provider.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 1, 'no second public entry');
    assert.equal(provider.events.get(HOLD_ORGANIZER)!.size, 2);
    assert.equal(provider.events.get(ALEXEY_PERSONAL)!.size, 2);
    for (const [calendar, id] of Object.entries(listingIds)) {
      const entry = event(provider, calendar, id);
      assert.equal(entry.start.dateTime, '2026-12-02T17:00:00.000Z', `${calendar}: the listing moved to the new time`);
      assert.equal(entry.end.dateTime, '2026-12-02T18:00:00.000Z');
      assertListingEntry(entry, calendar);
    }
    const organizer = event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]);
    assert.equal(organizer.start.dateTime, '2026-12-02T16:55:00.000Z', 'the invitation moved with its join lead');
    assert.match(organizer.location, /^https:\/\/zoom\.us\/j\//, 'the invitation keeps a Zoom room');
    assert.ok(!('conferenceData' in organizer));
    // cards time renders the invitation with the shared guest-invite builder (the canonical Alexey addresses).
    assert.deepEqual([...organizer.attendees.map((a: { email: string }) => a.email.toLowerCase())].sort(), [...new Set([SPEAKER, ...holdGuestAttendees(SPEAKER)])].sort());
    assert.equal(moved.hold.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], undefined, 'the hold carries the invitation only');
    for (const id of Object.values(copyIds)) assert.ok(!Object.values(moved.hold.googleEventIds).includes(id));
    assert.equal(rows(stored, listingIds).length, 3);
    assert.equal(rows(stored, inviteIds).length, 2);

    // The lifecycle continues after the re-timing: approving confirms the invitation and leaves the listing as moved.
    const listingAfterMove = Object.fromEntries(Object.entries(listingIds).map(([calendar, id]) => [calendar, structuredClone(event(provider, calendar, id))]));
    const approved = await invoke('POST', `/api/events/${card.id}/approve`, {});
    assert.equal(approved.code, 200, approved.raw);
    assert.equal(approved.data.event.status, 'approved');
    assert.equal(event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]).summary, 'Move', 'the invitation takes its confirmed title');
    for (const [calendar, id] of Object.entries(listingIds)) {
      assert.deepEqual(event(provider, calendar, id), listingAfterMove[calendar], `${calendar}: the approval did not touch the listing`);
    }
    assert.deepEqual((await getCardConsistent(db, card.id))!.eventTime!.listing!.googleEventIds, listingIds);
  });

  it('a listing entry stays the Card\'s own: it cannot be unlinked while live, before or after the invitation takes over', async () => {
    google();
    const card = await webinarCard('Kept link');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds: Record<string, string> = silent.card.eventTime.googleEventIds;
    const copyId = listingIds[ALEXEY_PERSONAL];
    const unlink = () => invoke('DELETE', `/api/cards/${card.id}/calendar-invites`, { eventId: copyId, calendar: ALEXEY_PERSONAL });
    const links = (stored: { calendarInvites?: Array<{ calendar: string; eventId: string }> }) =>
      (stored.calendarInvites || []).map((invite) => [invite.calendar, invite.eventId]).sort();

    const before = await unlink();
    assert.equal(before.code, 409, before.raw);
    assert.equal(before.data.code, 'invite_conflict');
    assert.match(before.data.error, /this Card's own invitation from cards time; move it with: dataops cards time/);

    assert.equal((await propose(card.id, { title: 'Kept link', documentUrl: LUMA })).code, 201);
    const taken = (await getCardConsistent(db, card.id))!;
    assert.notEqual(taken.eventTime!.googleEventIds[ALEXEY_PERSONAL], copyId, 'the copy is not part of the invitation');

    const after = await unlink();
    assert.equal(after.code, 409, after.raw);
    assert.equal(after.data.code, 'invite_conflict');
    assert.match(after.data.error, /this Card's own invitation from cards time; move it with: dataops cards time/);
    const stored = (await getCardConsistent(db, card.id))!;
    assert.deepEqual(links(stored), links(taken), 'the refusal unlinked nothing');
    assert.deepEqual(stored.eventTime!.listing!.googleEventIds, listingIds);
  });

  it('cards time on a listing Card that lost its Luma link moves the invitation and leaves the listing linked as it was', async () => {
    const provider = google();
    const card = await webinarCard('No Luma link');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const listingIds: Record<string, string> = silent.card.eventTime.googleEventIds;
    const proposed = await propose(card.id, { title: 'No Luma link', documentUrl: LUMA });
    assert.equal(proposed.code, 201, proposed.raw);
    const inviteIds = proposed.data.event.googleEventIds;
    const listingBefore = Object.fromEntries(Object.entries(listingIds).map(([calendar, id]) => [calendar, structuredClone(event(provider, calendar, id))]));
    await updateCard(db, card.id, {
      expectedVersion: (await getCardConsistent(db, card.id))!.version,
      patch: { cardLinks: [] },
    });

    await silentTime(card.id, '2026-12-03 18:00');
    const stored = (await getCardConsistent(db, card.id))!;
    assert.deepEqual(stored.eventTime!.listing!.googleEventIds, listingIds, 'the listing keeps the ids recorded on the Card');
    for (const [calendar, id] of Object.entries(listingIds)) {
      assert.deepEqual(event(provider, calendar, id), listingBefore[calendar], `${calendar}: untouched while the Card has no Luma link`);
    }
    assert.equal(event(provider, HOLD_ORGANIZER, inviteIds[HOLD_ORGANIZER]).start.dateTime, '2026-12-03T16:55:00.000Z', 'the invitation still moved');
    assert.equal(rows(stored, listingIds).length, 3, 'the listing stays linked');
  });

  it('a listing whose copies are gone in Google still lets the invitation through', async () => {
    const provider = google();
    const card = await webinarCard('Gone copies');
    const silent = await silentTime(card.id, '2026-12-01 17:00');
    const copyId = silent.card.eventTime.googleEventIds[ALEXEY_PERSONAL];
    provider.events.get(ALEXEY_PERSONAL)!.delete(copyId);
    const proposed = await propose(card.id, { title: 'Gone copies', documentUrl: LUMA });
    assert.equal(proposed.code, 201, proposed.raw);
    const stored = (await getCardConsistent(db, card.id))!;
    assert.equal(stored.eventTime!.listing!.googleEventIds[ALEXEY_PERSONAL], copyId, 'the link is kept; a later cards time recreates the copy');
    assert.equal(event(provider, ALEXEY_PERSONAL, proposed.data.event.googleEventIds[ALEXEY_PERSONAL]).location, ZOOM);
  });

  it('real conflicts stay refusals with a message that names the cause', async () => {
    google();
    // Another event's slot: the Card links a hold that is not the one this Card proposes.
    const linked = await webinarCard('Linked elsewhere');
    const foreign = await webinarCard('Foreign');
    const foreignEvent = await propose(foreign.id, { title: 'Foreign', documentUrl: LUMA });
    assert.equal(foreignEvent.code, 201, foreignEvent.raw);
    const held = (await getCardConsistent(db, foreign.id))!;
    await updateCard(db, linked.id, {
      expectedVersion: (await getCardConsistent(db, linked.id))!.version,
      patch: { eventTime: { ...held.eventTime! } },
    });
    const refused = await propose(linked.id, { title: 'Linked elsewhere', documentUrl: LUMA, dryRun: true });
    assert.equal(refused.code, 409, refused.raw);
    assert.equal(refused.data.code, 'event_conflict');
    assert.match(refused.data.error, /already has an active event \(hold_/);
    assert.equal(await getEventRecord(db, `hold_${linked.id}`), null);

    // A listing that is syncing right now is not taken over from under the sync.
    const syncing = await webinarCard('Syncing');
    await silentTime(syncing.id, '2026-12-01 17:00');
    const syncingCard = (await getCardConsistent(db, syncing.id))!;
    await updateCard(db, syncing.id, {
      expectedVersion: syncingCard.version,
      patch: { eventTime: { ...syncingCard.eventTime!, sync: 'syncing', syncStartedAt: new Date().toISOString() } },
    });
    const busy = await propose(syncing.id, { title: 'Syncing', documentUrl: LUMA });
    assert.equal(busy.code, 409, busy.raw);
    assert.equal(busy.data.code, 'event_conflict');
    assert.match(busy.data.error, /calendar entries of Card '.*' are syncing; retry shortly/);

    // A Card edited between planning and committing is reported as that, not as a stale listing.
    const raced = await webinarCard('Raced');
    await silentTime(raced.id, '2026-12-01 17:00');
    const planned = planEventTransition(`hold_${raced.id}`, raced.id, null, {
      transition: 'propose', operationKey: 'propose-raced', expectedVersion: 0, actor: 'test', now: new Date().toISOString(),
      date: '2026-12-01', time: '17:00',
      proposal: { templateId: raced.templateId, templateVersion: 1, policy: POLICY, title: 'Raced', topic: 'Raced', guestNames: '', documentUrl: LUMA, guestEmails: [SPEAKER] },
    });
    const fresh = (await getCardConsistent(db, raced.id))!;
    await updateCard(db, raced.id, { expectedVersion: fresh.version, patch: { description: 'edited meanwhile' } });
    await assert.rejects(
      commitEventTransition(db, fresh, 0, planned),
      (error: unknown) => error instanceof EventConflictError
        && /Card '.*' or event 'hold_.*' changed while the propose was prepared; reload and retry/.test(error.message),
    );
    assert.equal(await getEventRecord(db, `hold_${raced.id}`), null, 'a refused commit leaves no event behind');
  });
});
