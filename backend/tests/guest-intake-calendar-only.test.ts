import { rescheduleEvent } from '../src/events/service';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate, getTemplate } from '../src/db/templates';
import { getCardConsistent, parkCard, resumeCard } from '../src/db/cards';
import { getTaskConsistent, updateTask, listTasksByCardConsistent } from '../src/db/tasks';
import { getGuestIntakeJob } from '../src/events/guestIntakeStore';
import { processGuestIntake, pollGuestIntakeAcceptances } from '../src/events/guestIntakeWorker';
import { getEventRecord } from '../src/events/store';
import { getSponsorDocWithAuthMaterial, updateSponsorDoc, decryptSponsorDocAccessCode } from '../src/db/sponsorDocs';
import { setCalendarHoldGoogleDepsForTests } from '../src/db/calendarHolds';
import { setOwnerCalendarProviderClientsForTests } from '../src/calendar/ownerCalendarOverlay';
import { saveCalendarOverlaySettings } from '../src/db/calendar';
import { setSponsorDocEmailDepsForTests } from '../src/sponsorDocs/emailDelivery';
import { TABLE_USERS, TABLE_ARTIFACTS, TABLE_CARDS } from '../src/db/tableNames';
import { policy } from './helpers/eventPolicy';
import { createMockGoogleCalendar } from './helpers/guest-intake-google';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { handler } from '../src/handler';
let db: DynamoDBDocumentClient;
let google = createMockGoogleCalendar();
const checklist = createTaskChecklistFixture();
let mails = 0;
let sentMimes: string[] = [];
let ownerEvents: unknown[] = [];
let failMail = false;
let onMailSend: (() => Promise<void>) | undefined;
const invoke = (method: string, path: string, body?: unknown) => handler({ httpMethod: method, path, headers: { 'x-user-id': 'synthetic-actor' }, body: body ? JSON.stringify(body) : null, queryStringParameters: null });
before(async () => {
  configureTaskChecklistStore(checklist.store);
  db = await getClient(await startLocal()); await createTables(db);
  await saveCalendarOverlaySettings(db, { connectionId: 'synthetic-google' }, 'synthetic-actor');
  setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: google.fetchImpl });
  setOwnerCalendarProviderClientsForTests({ readSecret: async () => 'synthetic', fetch: async (url) => new Response(JSON.stringify(String(url).endsWith('/api/agent/token') ? { access_token: 'synthetic' } : { items: ownerEvents }), { status: 200 }) });
  setSponsorDocEmailDepsForTests({ credential: 'synthetic', fetchImpl: async (url, init) => {
    if (String(url).endsWith('/messages/send')) { mails++; if (onMailSend) { const callback = onMailSend; onMailSend = undefined; await callback(); } if (failMail) throw new Error('synthetic ambiguous timeout'); sentMimes.push(Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString('utf8')); return new Response(JSON.stringify({ id: `synthetic-mail-${mails}` }), { status: 200 }); }
    if (String(url).includes('userinfo')) return new Response(JSON.stringify({ email: 'orin@datatalks.club' }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'synthetic', provider_account_id: 'orin@datatalks.club', scopes: ['https://www.googleapis.com/auth/gmail.send'] }), { status: 200 });
  } });
  await db.send(new PutCommand({ TableName: TABLE_USERS, Item: { PK: 'SETTINGS#text-templates', SK: 'SETTINGS#text-templates', version: 1, templates: ['podcast','webinar','workshop'].map(type => ({ id: `${type}.first-contact`, body: `Subject: <FIRST_NAME_SUBJECT_PREFIX>DataTalks.Club ${type}\n\n<GREETING>\nJoin us<TOPIC_CLAUSE>. Would <WEEKDAY_DATE> at <TIME_TIMEZONE> work?\n<GUEST_FORM_URL>\nAccess code: <ACCESS_CODE>`, title: type, updatedAt: '2030-01-01' })) } }));
});
after(async () => { configureTaskChecklistStore(null); checklist.cleanup(); setCalendarHoldGoogleDepsForTests({}); setSponsorDocEmailDepsForTests({}); setOwnerCalendarProviderClientsForTests({}); await stopLocal(); });
async function card(type: 'podcast'|'webinar'|'workshop', extra: Record<string, unknown> = {}) {
  const eventPolicy = policy(type);
  if (type === 'workshop') eventPolicy.zoom = { enabled: false };
  eventPolicy.guests.leadMinutes = 5;
  for (const notification of Object.values(eventPolicy.notifications)) notification.emails = [];
  const template = await createTemplate(db, { name: type, type, origin: 'git', eventPolicy, guestIntake: { enabled: true, emailTemplateId: `${type}.first-contact`, formTemplate: type, followUpDays: 7, ...(type === 'podcast' ? { weekdays: [1,2], firstContactTaskRefs: ['obtain-speaker-email','create-proposed-calendar-invite'] } : {}) }, taskDefinitions: type === 'podcast' ? [
    { refId: 'obtain-speaker-email', description: 'Obtain guest email', offsetDays: 0, requiredLinkName: 'Guest email', proofRequirement: { type: 'url', required: true } },
    { refId: 'create-proposed-calendar-invite', description: 'Create proposed invite', offsetDays: 0, dependsOn: ['obtain-speaker-email'], proofRequirement: { type: 'comment', required: true } },
  ] : [] });
  const body = { templateId: template.id, guestEmail: 'synthetic-guest@example.test', creationKey: crypto.randomUUID(), ...extra };
  const result = await invoke('POST', '/api/cards', body);
  assert.equal(result.statusCode, 201, result.body);
  return { card: JSON.parse(result.body).card, body };
}

async function skippedPodcast() {
  const created = await card('podcast', { skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(job.status, 'skipped');
  const event = (await getEventRecord(db, job.holdId!))!;
  const eventId = event.googleEventIds[HOLD_ORGANIZER];
  return { cardId: created.card.id as string, job, event, eventId };
}
const organizerEvent = async (eventId: string) => {
  const response = await google.fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(HOLD_ORGANIZER)}/events/${eventId}`, {});
  return response.json() as Promise<any>;
};

test('invite guests on a silent --skip-email hold sends only the calendar invitation with guest, required attendees and Zoom', async () => {
  const { cardId, job, eventId } = await skippedPodcast();
  const silent = await organizerEvent(eventId);
  assert.deepEqual(silent.attendees || [], [], 'precondition: --skip-email leaves a silent hold');
  const beforeMails = mails; const beforeCalls = google.calls.length;

  const dry = await invoke('PATCH', `/api/cards/${cardId}/calendar-invites`, { guestEmails: ['synthetic-guest@example.test'], dryRun: true });
  assert.equal(dry.statusCode, 200, dry.body);
  const plan = JSON.parse(dry.body);
  assert.equal(plan.dryRun, true); assert.equal(plan.viaCalendarOnlyInvitation, true); assert.equal(plan.emailSent, false);
  assert.ok(plan.requiredAttendees.length > 0, 'policy has required attendees');
  const expected = [...new Set(['synthetic-guest@example.test', ...plan.requiredAttendees])].sort();
  assert.deepEqual(plan.attendees.sort(), expected);
  assert.ok(!google.calls.slice(beforeCalls).some(call => call.method !== 'GET'), 'dry run must not write to Google');
  assert.equal((await getGuestIntakeJob(db, job.id))!.calendarOnly, undefined);

  const sent = await invoke('PATCH', `/api/cards/${cardId}/calendar-invites`, { guestEmails: ['synthetic-guest@example.test'] });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(JSON.parse(sent.body).sent, true);
  assert.equal(mails, beforeMails, 'no first-contact email');
  const live = await organizerEvent(eventId);
  assert.deepEqual(live.attendees.map((a: any) => a.email).sort(), expected);
  assert.match(live.location, /zoom\.us\//);
  assert.match(live.summary, /^\[Proposed\]/);
  assert.ok(google.calls.slice(beforeCalls).some(call => call.method === 'PATCH' && call.url.includes(eventId) && new URL(call.url).searchParams.get('sendUpdates') === 'all'), 'Google Calendar notifies attendees');
  const marked = (await getGuestIntakeJob(db, job.id))!;
  assert.equal(marked.status, 'skipped'); assert.ok(marked.calendarOnly?.sentAt);
  assert.ok((await getCardConsistent(db, cardId))!.guestIntake!.calendarOnlySentAt);

  // A later first-contact send would duplicate the email already sent in the existing thread.
  const duplicate = await invoke('POST', `/api/cards/${cardId}/guest-intake/send`, {});
  assert.equal(duplicate.statusCode, 409);
  assert.match(JSON.parse(duplicate.body).error, /refusing to send a duplicate first-contact email/);
  await processGuestIntake(db, job.id);
  assert.equal(mails, beforeMails);

  // Once notified, invite guests is the ordinary private-invitation add and keeps the required attendees.
  // Real Google returns an etag on event reads; the shared mock does not.
  setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await google.fetchImpl(url, init);
    if ((init?.method || 'GET').toUpperCase() !== 'GET' || !String(url).includes(`/events/${eventId}`)) return response;
    return new Response(JSON.stringify({ ...(await response.json() as object), etag: '"synthetic-etag"' }), { status: response.status });
  }) as typeof fetch });
  let more;
  try { more = await invoke('PATCH', `/api/cards/${cardId}/calendar-invites`, { guestEmails: ['synthetic-cohost@example.test'] }); }
  finally { setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: google.fetchImpl }); }
  assert.equal(more.statusCode, 200, more.body);
  assert.equal(JSON.parse(more.body).viaCalendarOnlyInvitation, undefined);
  assert.deepEqual((await organizerEvent(eventId)).attendees.map((a: any) => a.email).sort(), [...expected, 'synthetic-cohost@example.test'].sort());
  assert.equal(mails, beforeMails);
});

test('send-calendar route is idempotent, dry-run safe, and leaves the event, form and Zoom unchanged', async () => {
  const { cardId, job, event, eventId } = await skippedPodcast();
  const beforeMails = mails;
  const dry = await invoke('POST', `/api/cards/${cardId}/guest-intake/send-calendar`, { dryRun: true });
  assert.equal(dry.statusCode, 200, dry.body);
  assert.equal(JSON.parse(dry.body).sent, false);
  assert.deepEqual((await organizerEvent(eventId)).attendees || [], []);
  const first = await invoke('POST', `/api/cards/${cardId}/guest-intake/send-calendar`, {});
  assert.equal(first.statusCode, 200, first.body);
  const result = JSON.parse(first.body);
  assert.equal(result.sent, true); assert.equal(result.emailSent, false); assert.equal(result.eventId, eventId);
  const after = (await getEventRecord(db, job.holdId!))!;
  assert.deepEqual(after.googleEventIds, event.googleEventIds);
  assert.equal(after.startIso, event.startIso);
  assert.equal(after.renderValues.documentUrl, event.renderValues.documentUrl);
  const again = await invoke('POST', `/api/cards/${cardId}/guest-intake/send-calendar`, {});
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(JSON.parse(again.body).alreadyNotified, true); assert.equal(JSON.parse(again.body).sent, false);
  assert.equal(mails, beforeMails);
});

test('calendar-only send refuses Cards whose first contact was not skipped, with a visible reason', async () => {
  const created = await card('webinar');
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const refused = await invoke('POST', `/api/cards/${created.card.id}/guest-intake/send-calendar`, {});
  assert.equal(refused.statusCode, 409);
  assert.match(JSON.parse(refused.body).error, /--skip-email/);
  const missing = await invoke('POST', `/api/cards/does-not-exist/guest-intake/send-calendar`, {});
  assert.equal(missing.statusCode, 404);
});

test('a Google failure surfaces as a visible error and is not recorded as sent', async () => {
  const { cardId, job } = await skippedPodcast();
  setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method || 'GET').toUpperCase() !== 'GET' && String(url).includes('/calendar/v3/')) return new Response(JSON.stringify({ error: { message: 'synthetic outage' } }), { status: 503 });
    return google.fetchImpl(url, init);
  }) as typeof fetch });
  try {
    const failed = await invoke('POST', `/api/cards/${cardId}/guest-intake/send-calendar`, {});
    assert.equal(failed.statusCode, 502, failed.body);
    assert.match(JSON.parse(failed.body).error, /Google Calendar did not confirm/);
    assert.equal((await getGuestIntakeJob(db, job.id))!.calendarOnly, undefined);
  } finally {
    setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: google.fetchImpl });
  }
  const retried = await invoke('POST', `/api/cards/${cardId}/guest-intake/send-calendar`, {});
  assert.equal(retried.statusCode, 200, retried.body);
  assert.ok((await getGuestIntakeJob(db, job.id))!.calendarOnly?.sentAt);
});
