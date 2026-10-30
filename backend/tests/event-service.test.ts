import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createTemplate } from '../src/db/templates';
import { createCard, getCardConsistent } from '../src/db/cards';
import { createTask, getTask } from '../src/db/tasks';
import { createPodcastEpisode, getPodcastEpisode } from '../src/db/podcastEpisodes';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { setEventEmailSenderForTests, type EventEmailMessage } from '../src/events/service';
import type { EventPolicy } from '../src/events/policy';
import { templateLink } from './helpers/cardTemplate';

const invoke = (
  method: string,
  pathName: string,
  body?: unknown,
  query: Record<string, string> = {},
) =>
  handler({
    httpMethod: method,
    path: pathName,
    body: body === undefined ? null : JSON.stringify(body),
    headers: { 'x-user-id': 'test-operator' },
    queryStringParameters: query,
  });

const parse = (r: { body: string }) => JSON.parse(r.body);

function buildTemplatePolicy(kind: 'podcast' | 'webinar' | 'workshop'): EventPolicy {
  if (kind === 'podcast') {
    return {
      timeZone: 'Europe/Berlin',
      durationMinutes: 60,
      windows: { midday: '12:30', evening: '17:00' },
      expiresDays: 7,
      titles: {
        proposed: '(Proposal) Podcast: {title}',
        approved: 'Podcast: {title}',
      },
      description: 'Topic: {topic}\nGuest: {guestNames}\nMaterials: {documentUrl}',
      inviteText: 'Zoom: {zoomUrl}',
      guests: {
        proposal: true,
        approved: true,
        requiredEmails: ['host@example.invalid'],
        leadMinutes: 5,
      },
      zoom: { enabled: true, url: 'https://zoom.us/j/999111222' },
      calendarAcceptance: { enabled: true, quorum: 'any' },
      notifications: {
        propose: {
          calendar: 'all',
          emails: [
            {
              to: 'guests',
              subject: 'Proposed podcast slot: {title} ({date} {time})',
              body: 'Hi {guestNames}, proposed slot on {date} at {time} {timeZone}. Doc: {documentUrl}',
            },
          ],
        },
        approve: {
          calendar: 'all',
          emails: [
            {
              to: 'guests',
              subject: 'Confirmed podcast: {title} on {date} {time}',
              body: 'Confirmed for {date} {time} {timeZone}. Join via {zoomUrl}',
            },
          ],
        },
        reschedule: {
          calendar: 'all',
          emails: [
            {
              to: 'guests',
              subject: 'Updated proposal: {title} ({date} {time})',
              body: 'New proposed slot: {date} {time} {timeZone}',
            },
          ],
        },
        release: {
          calendar: 'all',
          emails: [],
        },
      },
    };
  }
  if (kind === 'webinar') {
    return {
      timeZone: 'Europe/Berlin',
      durationMinutes: 60,
      windows: { midday: '13:00', evening: '17:00' },
      expiresDays: 10,
      titles: {
        proposed: '(Proposal) Webinar: {title}',
        approved: 'Webinar: {title}',
      },
      description: 'Webinar topic: {topic}\nSpeaker: {guestNames}',
      inviteText: 'Room: {zoomUrl}',
      guests: {
        proposal: true,
        approved: true,
        requiredEmails: ['events@example.invalid'],
        leadMinutes: 10,
      },
      zoom: { enabled: true, url: 'https://zoom.us/j/888333444' },
      calendarAcceptance: { enabled: true, quorum: 'all' },
      notifications: {
        propose: { calendar: 'all', emails: [] },
        approve: {
          calendar: 'all',
          emails: [
            {
              to: 'guests',
              subject: 'Webinar confirmed: {title}',
              body: 'Speaker session on {date} {time} {timeZone} at {zoomUrl}',
            },
          ],
        },
        reschedule: { calendar: 'all', emails: [] },
        release: { calendar: 'all', emails: [] },
      },
    };
  }
  return {
    timeZone: 'Europe/Berlin',
    durationMinutes: 90,
    windows: { midday: '12:00', evening: '16:30' },
    expiresDays: 14,
    titles: {
      proposed: '(Proposal) Workshop: {title}',
      approved: 'Workshop: {title}',
    },
    description: 'Hands-on workshop: {topic}',
    inviteText: '',
    guests: {
      proposal: true,
      approved: true,
      requiredEmails: ['workshops@example.invalid'],
      leadMinutes: 0,
    },
    zoom: { enabled: false },
    calendarAcceptance: { enabled: false, quorum: 'any' },
    notifications: {
      propose: { calendar: 'all', emails: [] },
      approve: { calendar: 'all', emails: [] },
      reschedule: { calendar: 'all', emails: [] },
      release: { calendar: 'all', emails: [] },
    },
  };
}

/** In-memory Google Calendar mock tracking organizer + both target calendars. */
function createMockGoogleCalendar() {
  const calendars = new Map<string, Map<string, any>>();
  const ensureCal = (calId: string) => {
    if (!calendars.has(calId)) calendars.set(calId, new Map());
    return calendars.get(calId)!;
  };
  ensureCal(HOLD_ORGANIZER);
  for (const cal of DEFAULT_HOLD_GOOGLE_CALENDARS) ensureCal(cal);

  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let seq = 1;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: urlStr, body });

    if (urlStr.endsWith('/api/agent/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-google-token' }), { status: 200 });
    }
    if (urlStr.endsWith('/calendars/primary')) {
      return new Response(JSON.stringify({ id: HOLD_ORGANIZER }), { status: 200 });
    }

    const parsed = new URL(urlStr);
    const calMatch = parsed.pathname.match(/\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!calMatch) {
      return new Response(JSON.stringify({ error: { message: `Unhandled URL ${urlStr}` } }), { status: 404 });
    }
    const calendarId = decodeURIComponent(calMatch[1]);
    const secondSeg = calMatch[2] ? decodeURIComponent(calMatch[2]) : undefined;
    const calStore = ensureCal(calendarId);

    // GET list by iCalUID
    if (method === 'GET' && !secondSeg) {
      const uid = parsed.searchParams.get('iCalUID');
      const items = [...calStore.values()].filter((e) => !uid || e.iCalUID === uid);
      return new Response(JSON.stringify({ items }), { status: 200 });
    }

    // POST /import
    if (method === 'POST' && secondSeg === 'import') {
      const id = `gev_${calendarId.split('@')[0]}_${seq++}`;
      const record = {
        id,
        status: 'confirmed',
        organizer: { email: HOLD_ORGANIZER },
        ...body,
      };
      calStore.set(id, record);
      return new Response(JSON.stringify(record), { status: 200 });
    }

    if (!secondSeg) {
      return new Response(JSON.stringify({ error: { message: 'Missing event id' } }), { status: 400 });
    }

    const existing = calStore.get(secondSeg);
    if (method === 'GET') {
      if (!existing) return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      return new Response(JSON.stringify(existing), { status: 200 });
    }

    if (method === 'PATCH') {
      if (!existing) return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      const mergedAttendees = body.attendees
        ? body.attendees.map((a: any) => {
            const prev = (existing.attendees || []).find(
              (p: any) => p.email?.toLowerCase() === a.email?.toLowerCase(),
            );
            return {
              email: a.email,
              responseStatus: a.responseStatus || prev?.responseStatus || 'needsAction',
            };
          })
        : existing.attendees;
      const updated = {
        ...existing,
        ...body,
        ...(mergedAttendees ? { attendees: mergedAttendees } : {}),
        ...(body.extendedProperties
          ? {
              extendedProperties: {
                private: {
                  ...(existing.extendedProperties?.private || {}),
                  ...(body.extendedProperties.private || {}),
                },
              },
            }
          : {}),
      };
      calStore.set(secondSeg, updated);
      return new Response(JSON.stringify(updated), { status: 200 });
    }

    if (method === 'DELETE') {
      calStore.delete(secondSeg);
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: { message: 'Unsupported method' } }), { status: 405 });
  }) as typeof fetch;

  return {
    calendars,
    calls,
    fetchImpl,
    getOrganizerEvent(eventId: string) {
      return ensureCal(HOLD_ORGANIZER).get(eventId);
    },
    setAttendeeResponse(eventId: string, attendeeEmail: string, responseStatus: string) {
      const ev = ensureCal(HOLD_ORGANIZER).get(eventId);
      assert.ok(ev, `Organizer event ${eventId} must exist`);
      ev.attendees = (ev.attendees || []).map((a: any) =>
        a.email?.toLowerCase() === attendeeEmail.toLowerCase() ? { ...a, responseStatus } : a,
      );
      if (!ev.attendees.some((a: any) => a.email?.toLowerCase() === attendeeEmail.toLowerCase())) {
        ev.attendees.push({ email: attendeeEmail, responseStatus });
      }
    },
  };
}

describe('Unified Event Lifecycle Service & API (AC3, AC4, AC5, AC7, AC8, AC9)', () => {
  let client: DynamoDBDocumentClient;
  let podcastTemplateId: string;
  let webinarTemplateId: string;
  let workshopTemplateId: string;
  let sentEmails: EventEmailMessage[] = [];
  let googleMock = createMockGoogleCalendar();

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await saveCalendarOverlaySettings(client, { connectionId: 'orin-calendar' }, 'test-operator');

    const podcastTemplate = await createTemplate(client, {
      name: 'Podcast Episode',
      type: 'podcast-record',
      eventPolicy: buildTemplatePolicy('podcast'),
      taskDefinitions: [],
    });
    podcastTemplateId = podcastTemplate.id;

    const webinarTemplate = await createTemplate(client, {
      name: 'Webinar',
      type: 'webinar',
      eventPolicy: buildTemplatePolicy('webinar'),
      taskDefinitions: [],
    });
    webinarTemplateId = webinarTemplate.id;

    const workshopTemplate = await createTemplate(client, {
      name: 'Workshop',
      type: 'workshop',
      eventPolicy: buildTemplatePolicy('workshop'),
      taskDefinitions: [],
    });
    workshopTemplateId = workshopTemplate.id;

    setEventEmailSenderForTests(async (msg) => {
      sentEmails.push(msg);
      return { messageId: `mock-email-${sentEmails.length}` };
    });
  });

  after(async () => {
    setEventEmailSenderForTests(null);
    setCalendarHoldGoogleDepsForTests({});
    await stopLocal();
  });

  it('AC3 + AC4 + AC5 + AC7 + AC9: podcast full lifecycle (propose -> approve -> reschedule -> approve -> release) syncs Card, Episode, Google calendars, emails, tasks, and linked docs atomically', async () => {
    sentEmails = [];
    googleMock = createMockGoogleCalendar();
    setCalendarHoldGoogleDepsForTests({
      credential: 'test-machine',
      connectionId: 'orin-calendar',
      fetchImpl: googleMock.fetchImpl,
    });

    const podcastTemplate = {
      id: podcastTemplateId,
      name: 'Podcast Episode',
      type: 'podcast-record',
      version: 1,
      eventPolicy: buildTemplatePolicy('podcast'),
      taskDefinitions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    const card = await createCard(client, {
      ...templateLink(podcastTemplate),
      title: 'Ian Whitestone - Agentic Data Stack',
      anchorDate: '2026-10-29',
      people: ['Ian Whitestone'],
      guestEmails: ['ian@example.invalid'],
    });

    const inviteTask = await createTask(client, {
      description: 'Send calendar invitation',
      date: '2026-10-29',
      status: 'todo',
      cardId: card.id,
      requiresCalendarInvite: true,
    });

    const episode = await createPodcastEpisode(client, {
      title: 'Ian Whitestone - Agentic Data Stack',
      guests: [{ name: 'Ian Whitestone', email: 'ian@example.invalid' }],
      status: 'booked',
      recordingDate: '2026-10-29',
      cardId: card.id,
    });

    // Create linked guest materials doc and episode brief doc
    const guestDocRes = await invoke('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'podcast',
    });
    assert.equal(guestDocRes.statusCode, 201, guestDocRes.body);
    const guestDoc = parse(guestDocRes).doc;

    const briefDocRes = await invoke('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'podcast-episode-brief',
    });
    assert.equal(briefDocRes.statusCode, 201, briefDocRes.body);
    const briefDoc = parse(briefDocRes).doc;

    // 1. PROPOSE on 2026-11-05 midday (12:30 Berlin)
    const proposeRes = await invoke('POST', `/api/events/${card.id}/propose`, {
      date: '2026-11-05',
      window: 'midday',
    });
    assert.equal(proposeRes.statusCode, 201, proposeRes.body);
    const proposed = parse(proposeRes);
    assert.equal(proposed.event.status, 'proposed');
    assert.equal(proposed.event.date, '2026-11-05');
    assert.equal(proposed.event.time, '12:30');
    assert.equal(proposed.event.generation, 1);
    assert.equal(proposed.sync.state, 'synced');

    // Verify Google Calendar events on organizer + both target calendars have (Proposal) title and no Zoom link yet
    const orgEventId = proposed.event.googleEventIds[HOLD_ORGANIZER];
    assert.ok(orgEventId);
    for (const cal of [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
      const evId = proposed.event.googleEventIds[cal];
      assert.ok(evId, `Google event created on ${cal}`);
      const gEv = googleMock.calendars.get(cal)!.get(evId);
      assert.equal(gEv.summary, '(Proposal) Podcast: Ian Whitestone - Agentic Data Stack');
      assert.equal(gEv.location, '');
    }
    // Proposal transition email sent to guest
    assert.equal(sentEmails.length, 1);
    assert.deepEqual(sentEmails[0].to, ['ian@example.invalid']);
    assert.match(sentEmails[0].subject, /Proposed podcast slot.*2026-11-05 12:30/);

    // Verify Card and Episode single source of truth
    const cardAfterPropose = (await getCardConsistent(client, card.id))!;
    assert.equal(cardAfterPropose.anchorDate, '2026-11-05');
    assert.equal(cardAfterPropose.eventTime?.status, 'proposed');
    const epAfterPropose = parse(await invoke('GET', `/api/podcast-episodes/${episode.id}`));
    assert.equal(epAfterPropose.recordingDate, '2026-11-05');
    assert.equal(epAfterPropose.recordingTime, '12:30');
    assert.equal(epAfterPropose.recordingTimeZone, 'Europe/Berlin');
    assert.equal(epAfterPropose.recordingEventStatus, 'proposed');

    // AC4: Direct episode recordingDate update or Card anchorDate update while hold is active is refused with pointer to reschedule
    const driftEpisodeRes = await invoke('PUT', `/api/podcast-episodes/${episode.id}`, {
      recordingDate: '2026-11-19',
      version: epAfterPropose.version,
    });
    assert.equal(driftEpisodeRes.statusCode, 409, driftEpisodeRes.body);
    assert.equal(parse(driftEpisodeRes).code, 'event_hold_owns_date');
    assert.match(parse(driftEpisodeRes).error, /reschedule/);

    const driftCardRes = await invoke('PUT', `/api/cards/${card.id}`, {
      expectedVersion: cardAfterPropose.version,
      anchorDate: '2026-11-19',
    });
    assert.equal(driftCardRes.statusCode, 409, driftCardRes.body);
    assert.equal(parse(driftCardRes).code, 'event_hold_owns_date');

    // AC9: Linked docs reflect 2026-11-05 12:30 tentative live
    for (const docId of [guestDoc.id, briefDoc.id]) {
      const liveDoc = parse(await invoke('GET', `/api/sponsor-docs/${docId}`)).doc;
      assert.equal(liveDoc.eventMetadata.date, '2026-11-05');
      assert.equal(liveDoc.eventMetadata.time, '12:30');
      assert.equal(liveDoc.eventMetadata.state, 'tentative');
      assert.match(liveDoc.eventMetadata.label, /5 Nov 2026 12:30 Europe\/Berlin \(tentative\)/);
    }

    // 2. APPROVE
    const approveRes = await invoke('POST', `/api/events/${card.id}/approve`, {});
    assert.equal(approveRes.statusCode, 200, approveRes.body);
    const approved = parse(approveRes);
    assert.equal(approved.event.status, 'approved');
    assert.equal(approved.sync.state, 'synced');

    // Google events now drop (Proposal), include Zoom URL, and start 5 min early (leadMinutes=5)
    for (const cal of [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
      const evId = approved.event.googleEventIds[cal];
      const gEv = googleMock.calendars.get(cal)!.get(evId);
      assert.equal(gEv.summary, 'Podcast: Ian Whitestone - Agentic Data Stack');
      assert.equal(gEv.location, 'https://zoom.us/j/999111222');
      assert.match(gEv.description, /https:\/\/zoom\.us\/j\/999111222/);
    }
    // Approve transition email sent
    assert.equal(sentEmails.length, 2);
    assert.match(sentEmails[1].subject, /Confirmed podcast/);
    // Invite task automatically completed on approve
    assert.equal((await getTask(client, inviteTask.id))?.status, 'done');
    // Linked docs now show confirmed
    for (const docId of [guestDoc.id, briefDoc.id]) {
      const liveDoc = parse(await invoke('GET', `/api/sponsor-docs/${docId}`)).doc;
      assert.equal(liveDoc.eventMetadata.state, 'confirmed');
      assert.match(liveDoc.eventMetadata.label, /5 Nov 2026 12:30 Europe\/Berlin \(confirmed\)/);
    }

    // 3. RESCHEDULE (date change on an approved event returns it to 'proposed' and Google title back to '(Proposal)')
    const reschedRes = await invoke('POST', `/api/events/${card.id}/reschedule`, {
      date: '2026-12-01',
      time: '12:30',
    });
    assert.equal(reschedRes.statusCode, 200, reschedRes.body);
    const rescheduled = parse(reschedRes);
    assert.equal(rescheduled.event.status, 'proposed');
    assert.equal(rescheduled.event.date, '2026-12-01');
    assert.equal(rescheduled.event.time, '12:30');
    assert.equal(rescheduled.event.generation, 2);
    // Same Google event IDs preserved across reschedule
    assert.deepEqual(rescheduled.event.googleEventIds, approved.event.googleEventIds);

    for (const cal of [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
      const evId = rescheduled.event.googleEventIds[cal];
      const gEv = googleMock.calendars.get(cal)!.get(evId);
      assert.equal(gEv.summary, '(Proposal) Podcast: Ian Whitestone - Agentic Data Stack');
      assert.equal(gEv.location, '');
    }
    // Card, Episode, and linked Docs all reflect 2026-12-01 12:30 (tentative)
    assert.equal((await getCardConsistent(client, card.id))?.anchorDate, '2026-12-01');
    const epAfterResched = parse(await invoke('GET', `/api/podcast-episodes/${episode.id}`));
    assert.equal(epAfterResched.recordingDate, '2026-12-01');
    assert.equal(epAfterResched.recordingTime, '12:30');
    assert.equal(epAfterResched.recordingEventStatus, 'proposed');
    for (const docId of [guestDoc.id, briefDoc.id]) {
      const liveDoc = parse(await invoke('GET', `/api/sponsor-docs/${docId}`)).doc;
      assert.equal(liveDoc.eventMetadata.date, '2026-12-01');
      assert.equal(liveDoc.eventMetadata.state, 'tentative');
      assert.equal(liveDoc.eventMetadata.label, 'Tue, 1 Dec 2026 12:30 Europe/Berlin (tentative)');
    }

    // 4. RE-APPROVE on 2026-12-01
    const reapproveRes = await invoke('POST', `/api/events/${card.id}/approve`, {});
    assert.equal(reapproveRes.statusCode, 200, reapproveRes.body);
    assert.equal(parse(reapproveRes).event.status, 'approved');
    for (const docId of [guestDoc.id, briefDoc.id]) {
      const liveDoc = parse(await invoke('GET', `/api/sponsor-docs/${docId}`)).doc;
      assert.equal(liveDoc.eventMetadata.label, 'Tue, 1 Dec 2026 12:30 Europe/Berlin (confirmed)');
    }

    // 5. RELEASE
    const releaseRes = await invoke('POST', `/api/events/${card.id}/release`, {});
    assert.equal(releaseRes.statusCode, 200, releaseRes.body);
    const released = parse(releaseRes);
    assert.equal(released.event.status, 'released');
    assert.deepEqual(released.event.googleEventIds, {});
    for (const cal of [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
      assert.equal(googleMock.calendars.get(cal)!.size, 0, `Google event deleted on ${cal}`);
    }
    for (const docId of [guestDoc.id, briefDoc.id]) {
      const liveDoc = parse(await invoke('GET', `/api/sponsor-docs/${docId}`)).doc;
      assert.equal(liveDoc.eventMetadata.state, 'released');
      assert.equal(liveDoc.eventMetadata.label, 'Tue, 1 Dec 2026 12:30 Europe/Berlin (released)');
    }
  });

  it('AC3 + AC7 + AC8: webinar and workshop templates drive per-type behaviour and guest Google Calendar accept auto-approves idempotently (while decline never auto-releases)', async () => {
    sentEmails = [];
    googleMock = createMockGoogleCalendar();
    setCalendarHoldGoogleDepsForTests({
      credential: 'test-machine',
      connectionId: 'orin-calendar',
      fetchImpl: googleMock.fetchImpl,
    });

    const webinarTemplate = {
      id: webinarTemplateId,
      name: 'Webinar',
      type: 'webinar',
      version: 1,
      eventPolicy: buildTemplatePolicy('webinar'),
      taskDefinitions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    const webinarCard = await createCard(client, {
      ...templateLink(webinarTemplate),
      title: 'Streaming Lakehouse in Practice',
      anchorDate: '2026-11-12',
      people: ['Ada Speaker'],
      guestEmails: ['ada@example.invalid'],
    });

    // Propose webinar on 2026-11-12 evening (17:00 Berlin from webinar policy)
    const propRes = await invoke('POST', `/api/events/${webinarCard.id}/propose`, {
      date: '2026-11-12',
      window: 'evening',
    });
    assert.equal(propRes.statusCode, 201, propRes.body);
    const prop = parse(propRes);
    assert.equal(prop.event.status, 'proposed');
    assert.equal(prop.event.time, '17:00');
    assert.equal(prop.event.durationMinutes, 60);
    const orgId = prop.event.googleEventIds[HOLD_ORGANIZER];
    assert.equal(
      googleMock.getOrganizerEvent(orgId).summary,
      '(Proposal) Webinar: Streaming Lakehouse in Practice',
    );

    // 1. Guest declines first -> recorded and surfaced, NEVER auto-releases
    googleMock.setAttendeeResponse(orgId, 'ada@example.invalid', 'declined');
    const declinePoll = parse(await invoke('POST', `/api/events/${webinarCard.id}/poll`, {}));
    assert.equal(declinePoll.outcomes[0].action, 'declined');
    assert.equal(declinePoll.outcomes[0].status, 'proposed');
    assert.deepEqual(declinePoll.outcomes[0].declinedEmails, ['ada@example.invalid']);

    const afterDecline = parse(await invoke('GET', `/api/events/${webinarCard.id}`));
    assert.equal(afterDecline.event.status, 'proposed', 'Decline must never auto-release');
    assert.equal(afterDecline.attendeeResponses['ada@example.invalid'], 'declined');
    assert.equal(afterDecline.declinedBy[0].email, 'ada@example.invalid');

    // 2. Guest accepts on Google Calendar without replying by email -> auto-approves!
    googleMock.setAttendeeResponse(orgId, 'ada@example.invalid', 'accepted');
    const acceptPoll = parse(
      await invoke('POST', `/api/events/${webinarCard.id}/poll`, {
        now: '2026-10-15T14:00:00.000Z',
      }),
    );
    assert.equal(acceptPoll.outcomes[0].action, 'approved');
    assert.equal(acceptPoll.outcomes[0].status, 'approved');

    // Verify Google event switched to confirmed title + Zoom link + webinar 10-min lead time
    const orgEvAfterAccept = googleMock.getOrganizerEvent(orgId);
    assert.equal(orgEvAfterAccept.summary, 'Webinar: Streaming Lakehouse in Practice');
    assert.equal(orgEvAfterAccept.location, 'https://zoom.us/j/888333444');
    // Webinar approve email sent
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].subject, 'Webinar confirmed: Streaming Lakehouse in Practice');

    // Verify hold history records 'approved via calendar accept' with timestamp and attendee email
    const detailAfterAccept = parse(await invoke('GET', `/api/events/${webinarCard.id}`));
    assert.equal(detailAfterAccept.event.status, 'approved');
    const acceptHistory = detailAfterAccept.history.find((h: any) => h.transition === 'approve');
    assert.ok(acceptHistory);
    assert.equal(acceptHistory.note, 'approved via calendar accept');
    assert.equal(acceptHistory.attendeeEmail, 'ada@example.invalid');
    assert.equal(acceptHistory.at, '2026-10-15T14:00:00.000Z');

    // 3. Repeated poll / webhook notifications are idempotent no-ops
    const versionAfterAccept = detailAfterAccept.event.version;
    const emailCountAfterAccept = sentEmails.length;
    const repeatPoll = parse(await invoke('POST', `/api/events/${webinarCard.id}/poll`, {}));
    assert.equal(repeatPoll.outcomes[0].action, 'noop');
    assert.equal(repeatPoll.outcomes[0].status, 'approved');
    assert.equal(sentEmails.length, emailCountAfterAccept);
    assert.equal(
      parse(await invoke('GET', `/api/events/${webinarCard.id}`)).event.version,
      versionAfterAccept,
    );

    // 4. Workshop template (90 min, evening=16:30, zoom disabled)
    const workshopTemplate = {
      id: workshopTemplateId,
      name: 'Workshop',
      type: 'workshop',
      version: 1,
      eventPolicy: buildTemplatePolicy('workshop'),
      taskDefinitions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const workshopCard = await createCard(client, {
      ...templateLink(workshopTemplate),
      title: 'Hands-On DuckDB',
      anchorDate: '2026-11-20',
      people: ['Duck Instructor'],
      guestEmails: ['duck@example.invalid'],
    });
    const wsPropose = parse(
      await invoke('POST', `/api/events/${workshopCard.id}/propose`, {
        date: '2026-11-20',
        window: 'evening',
      }),
    );
    assert.equal(wsPropose.event.durationMinutes, 90);
    assert.equal(wsPropose.event.time, '16:30');
    const wsApprove = parse(await invoke('POST', `/api/events/${workshopCard.id}/approve`, {}));
    assert.equal(wsApprove.event.status, 'approved');
    const wsOrgEv = googleMock.getOrganizerEvent(wsApprove.event.googleEventIds[HOLD_ORGANIZER]);
    assert.equal(wsOrgEv.summary, 'Workshop: Hands-On DuckDB');
    assert.equal(wsOrgEv.location, '');
  });
});
