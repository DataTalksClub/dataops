import { withOwnerAvailability } from './helpers/owner-availability';
import { rescheduleEvent, approveEvent } from '../src/events/service';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import { guestPortalSlots, recordGuestPortalTimeChoice, processGuestChoice } from '../src/events/guestIntakePortal';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate, getTemplate } from '../src/db/templates';
import { getCardConsistent, parkCard, resumeCard } from '../src/db/cards';
import { getTaskConsistent, updateTask, listTasksByCardConsistent } from '../src/db/tasks';
import { getGuestIntakeJob, saveGuestIntakeJob } from '../src/events/guestIntakeStore';
import { processGuestIntake, pollGuestIntakeAcceptances } from '../src/events/guestIntakeWorker';
import { getEventRecord } from '../src/events/store';
import { getSponsorDocWithAuthMaterial, updateSponsorDoc, decryptSponsorDocAccessCode } from '../src/db/sponsorDocs';
import { setCalendarHoldGoogleDepsForTests } from '../src/db/calendarHolds';
import { setOwnerCalendarProviderClientsForTests as setOwnerCalendarClients } from '../src/calendar/ownerCalendarOverlay';
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
  const body = { agreedFrom: '2026-11-25', agreedTo: '2031-12-31', templateId: template.id, guestEmail: 'synthetic-guest@example.test', creationKey: crypto.randomUUID(), ...extra };
  const result = await invoke('POST', '/api/cards', body);
  assert.equal(result.statusCode, 201, result.body);
  return { card: JSON.parse(result.body).card, body };
}
test('creation queues a durable job with email alone; one worker sends both channels and retries do not duplicate', async () => {
  const created = await card('podcast', { guestTimezone: 'America/New_York' });
  const beforeMails = mails;
  assert.equal(created.card.guestIntake.status, 'queued');
  assert.equal(mails, beforeMails);
  const replay = await invoke('POST','/api/cards',created.body);
  assert.equal(JSON.parse(replay.body).card.id, created.card.id);
  await handler({ Records: [{ eventSource: 'aws:dynamodb', eventName: 'INSERT', dynamodb: { NewImage: { guestIntake: { M: { jobId: { S: created.card.guestIntake.jobId } } } } } }] });
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(job.status, 'sent'); assert.equal(mails, beforeMails + 1);
  assert.match(sentMimes.at(-1) || '', /^Cc: alexey@datatalks\.club$/m);
  const event = (await getEventRecord(db, job.holdId!))!;
  assert.equal(event.durationMinutes, 60);
  assert.equal(event.operations[0].desired.startIso, new Date(Date.parse(event.startIso)-5*60000).toISOString()); assert.match(event.operations[0].desired.summary, /^\[Proposed\] /);
  // Podcast invites are canonical (shared builder): the standard DataOps Zoom room, not the Template policy's.
  assert.equal(event.operations[0].desired.location, 'https://zoom.us/j/94755324762');
  assert.match(event.operations[0].desired.description, /Zoom link: https:\/\/zoom\.us\/j\/94755324762/);
  assert.ok(event.operations[0].desired.attendees.includes(created.body.guestEmail));
  assert.equal(event.operations[0].desired.sendUpdates, 'all');
  assert.match(event.operations[0].desired.description, /Podcast document: https:\/\/\S+code=/); // the guest form link (with its code) rides in the canonical description
  const doc = (await getSponsorDocWithAuthMaterial(db, job.docId!))!.doc;
  assert.equal(doc.status, 'draft'); assert.equal(doc.content.bio || '', '');
  assert.equal((await getTaskConsistent(db, job.taskId))!.status, 'waiting');
  const completedRefs = (await listTasksByCardConsistent(db, job.cardId)).filter(t => t.templateTaskRef);
  assert.equal(completedRefs.length, 2);
  assert.ok(completedRefs.every(t => t.status === 'done' && t.completedAt && t.link?.includes(job.messageId!)));
  assert.ok((await getCardConsistent(db, job.cardId))!.cardLinks!.some(l => l.name === 'Guest email' && l.url.includes(job.messageId!)));
  await processGuestIntake(db, job.id); assert.equal(mails, beforeMails + 1);
  assert.equal((await getCardConsistent(db, job.cardId))!.eventTime!.eventKey, event.id);
  const ids = { ...event.googleEventIds };
  google.setAttendeeResponse(ids[HOLD_ORGANIZER], created.body.guestEmail, 'accepted');
  await pollGuestIntakeAcceptances(db);
  const accepted = (await getEventRecord(db, event.id))!;
  assert.equal(accepted.status, 'approved');
  const acceptanceTask = (await getTaskConsistent(db, job.taskId))!;
  assert.equal(acceptanceTask.status, 'done'); assert.equal(acceptanceTask.followUpAt ?? null, null); assert.deepEqual(accepted.googleEventIds, ids);
  assert.ok(!accepted.operations.at(-1)!.desired.summary.startsWith('[Proposed]'));
  const moved = await rescheduleEvent(db, job.cardId, { date: '2030-12-10', time: '17:00', actor: 'synthetic-staff', operationKey: 'staff-move-requires-fresh-rsvp' });
  assert.equal(moved.event.status, 'proposed');
  assert.deepEqual(moved.event.googleEventIds, ids);
  await pollGuestIntakeAcceptances(db);
  assert.equal((await getEventRecord(db, event.id))!.status, 'proposed', 'old accepted response must reset; staff move is not new guest acceptance');
});
test('skip-email creates one private workshop event and one blank form, without email or calendar notification', async () => {
  const created = await card('workshop', { skipEmail: true, anchorDate: '2030-12-02', time: '10:00', timeZone: 'America/New_York' });
  const beforeMails = mails; const beforeCalendarCalls = google.calls.length;
  await processGuestIntake(db, created.card.guestIntake.jobId);
  assert.ok(!google.calls.slice(beforeCalendarCalls).some(call => new URL(call.url).searchParams.get('sendUpdates') === 'all'));
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(job.status, 'skipped'); assert.equal(mails, beforeMails);
  const event = (await getEventRecord(db, job.holdId!))!;
  assert.equal(event.startIso, '2030-12-02T15:00:00.000Z'); assert.equal(event.durationMinutes, 90);
  assert.deepEqual(event.operations[0].desired.attendees, []); assert.equal(event.operations[0].desired.sendUpdates, 'none');
  assert.equal((await getSponsorDocWithAuthMaterial(db, job.docId!))!.doc.template, 'workshop');
  await processGuestIntake(db, job.id); assert.equal(mails, beforeMails);
});
test('an ambiguous Gmail timeout preserves one attempted send and blocks automatic resend', async () => {
  const created = await card('webinar'); const beforeMails = mails; failMail = true;
  await assert.rejects(processGuestIntake(db, created.card.guestIntake.jobId), /pending/);
  failMail = false;
  const failed = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.retryable, false);
  await processGuestIntake(db, failed.id); assert.equal(mails, beforeMails + 1);
});

test('durable failed Calendar stage resumes automatically with the same event, document and one email', async () => {
  const created = await card('webinar'); const beforeMails = mails;
  let failOnce = true;
  setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: async (url, init) => {
    if (failOnce && init?.method === 'PATCH') { failOnce = false; return new Response('{}', { status: 503 }); }
    return google.fetchImpl(url, init);
  } });
  await assert.rejects(processGuestIntake(db, created.card.guestIntake.jobId), /Calendar invitation is pending/);
  const failed = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(failed.retryable, true); assert.equal(mails, beforeMails);
  const firstEvent = (await getEventRecord(db, `hold_${created.card.id}`))!;
  const resumed = await handler({ source: 'aws.events', detail: { dataopsAction: 'guest-event-intake-resume' } });
  assert.equal(resumed.statusCode, 200);
  const done = (await getGuestIntakeJob(db, failed.id))!;
  assert.equal(done.status, 'sent'); assert.equal(done.docId, failed.docId); assert.equal(done.holdId, firstEvent.id);
  assert.equal(mails, beforeMails + 1);
  setCalendarHoldGoogleDepsForTests({ credential: 'synthetic', connectionId: 'synthetic-google', fetchImpl: google.fetchImpl });
});
test('guest alternative time confirms immediately on the same event without completing bio or outline', async () => {
  const created = await card('webinar');
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const before = (await getEventRecord(db, job.holdId!))!;
  const loaded = (await getSponsorDocWithAuthMaterial(db, job.docId!))!;
  const slots = await guestPortalSlots(db, loaded.doc);
  const chosen = slots!.find(s => s.startIso !== before.startIso)!;
  assert.ok(chosen);
  const chosenDoc = (await updateSponsorDoc(db, loaded.doc.id, { content: { slotChoice: `slot:${chosen.date}:${chosen.window}`, guestTimezone: 'America/New_York' }, actorKind: 'sponsor' }))!;
  await recordGuestPortalTimeChoice(db, chosenDoc, { choice: chosenDoc.content.slotChoice, proposalVersion: before.version, proposalStartIso: before.startIso });
  const after = (await getEventRecord(db, before.id))!;
  assert.equal(after.status, 'approved'); assert.equal(after.startIso, chosen.startIso);
  assert.equal((await getTaskConsistent(db, job.taskId))!.status, 'done');
  assert.equal((await getTaskConsistent(db, job.taskId))!.followUpAt ?? null, null);
  assert.deepEqual(after.googleEventIds, before.googleEventIds);
  assert.ok(!after.operations.at(-1)!.desired.summary.startsWith('[Proposed]'));
  assert.equal(loaded.doc.content.speakerBio || '', '');
});

test('a skipped invitation preview is read-only; explicit first-send reuses its private event and form', async () => {
  const created = await card('webinar', { skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const skipped = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const ids = { ...(await getEventRecord(db, skipped.holdId!))!.googleEventIds };
  const beforeMails = mails;
  const preview = await handler({ httpMethod: 'GET', path: `/api/cards/${created.card.id}/guest-intake`, headers: { 'x-user-id': 'synthetic-actor' }, queryStringParameters: { preview: '1' }, body: null });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(JSON.parse(preview.body).preview, true); assert.equal(mails, beforeMails);
  const queued = await invoke('POST', `/api/cards/${created.card.id}/guest-intake/send`, {});
  assert.equal(queued.statusCode, 202, queued.body);
  await processGuestIntake(db, skipped.id);
  const sent = (await getGuestIntakeJob(db, skipped.id))!;
  assert.equal(sent.status, 'sent'); assert.equal(sent.docId, skipped.docId); assert.equal(sent.holdId, skipped.holdId);
  assert.deepEqual((await getEventRecord(db, sent.holdId!))!.googleEventIds, ids);
  assert.equal(mails, beforeMails + 1);
  assert.equal((await invoke('POST', `/api/cards/${created.card.id}/guest-intake/send`, {})).statusCode, 409);
});

test('cards time on a guest-intake Card moves the event, the Card anchor and the intake job together', async () => {
  const created = await card('webinar', { skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const event = (await getEventRecord(db, job.holdId!))!;
  const moved = new Date(Date.parse(event.startIso) + 7 * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(moved).map(p => [p.type, p.value]));
  const res = await invoke('POST', `/api/cards/${created.card.id}/time`, { at: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` });
  assert.equal(res.statusCode, 200, res.body);
  const after = (await getEventRecord(db, event.id))!;
  assert.equal(after.date, `${parts.year}-${parts.month}-${parts.day}`);
  const card2 = (await invoke('GET', `/api/cards/${created.card.id}`)).body;
  assert.equal(JSON.parse(card2).card.anchorDate, after.date);
  const updated = (await getGuestIntakeJob(db, job.id))!;
  assert.equal(updated.requestedDate, after.date); assert.equal(updated.requestedTime, `${parts.hour}:${parts.minute}`);
});
test('cards time normalizes a cross-date timezone move before an initial invitation retry', async () => {
  const created = await card('webinar', { skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const event = (await getEventRecord(db, job.holdId!))!;
  const beforeMails = mails;
  // The caller's Friday is still Thursday's normal midday window in Berlin.
  const res = await invoke('POST', `/api/cards/${created.card.id}/time`, {
    at: '2030-12-06 01:30', tz: 'Pacific/Kiritimati',
  });
  assert.equal(res.statusCode, 200, res.body);
  const moved = (await getEventRecord(db, event.id))!;
  assert.equal(moved.date, '2030-12-05');
  assert.equal(moved.time, '12:30');
  assert.equal(moved.timeZone, 'Europe/Berlin');
  assert.equal(moved.startIso, '2030-12-05T11:30:00.000Z');
  const updated = (await getGuestIntakeJob(db, job.id))!;
  assert.equal((await getCardConsistent(db, created.card.id))!.anchorDate, moved.date);
  assert.equal(updated.requestedDate, moved.date);
  assert.equal(updated.requestedTime, moved.time);
  assert.equal(updated.timeZone, moved.timeZone);
  assert.equal(updated.startIso, moved.startIso);
  assert.equal(mails, beforeMails, 'rescheduling never sends the first-contact email');
  const queued = await invoke('POST', `/api/cards/${created.card.id}/guest-intake/send`, {});
  assert.equal(queued.statusCode, 202, queued.body);
  await processGuestIntake(db, job.id);
  const sent = (await getGuestIntakeJob(db, job.id))!;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.holdId, event.id);
  assert.equal(sent.startIso, moved.startIso);
  assert.equal(mails, beforeMails + 1);
});
test('acceptance racing Gmail receipt bookkeeping leaves no waiting follow-up', async () => {
  const created = await card('webinar');
  onMailSend = async () => { await approveEvent(db, created.card.id, { actor: 'synthetic-guest-accept', operationKey: 'accept-during-mail-send' }); };
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const task = (await getTaskConsistent(db, job.taskId))!;
  assert.equal(job.status, 'sent'); assert.equal(task.status, 'done'); assert.equal(task.followUpAt ?? null, null);
});
test('ordinary guest bio saves do not approve staff moves; stale explicit confirmations are rejected', async () => {
  const created = await card('webinar'); await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const original = (await getEventRecord(db, job.holdId!))!;
  const loaded = (await getSponsorDocWithAuthMaterial(db, job.docId!))!;
  const code = decryptSponsorDocAccessCode(loaded.doc.id, loaded.accessCodeCiphertext)!;
  const guestPut = (body: unknown) => handler({ httpMethod: 'PUT', path: `/api/sponsor-docs/${loaded.doc.id}`, headers: { 'x-sponsor-doc-anonymous': 'true' }, queryStringParameters: { code }, body: JSON.stringify(body) });
  const first = await guestPut({ content: { slotChoice: 'confirm_proposed' }, status: 'draft', timeChoiceIntent: { choice: 'confirm_proposed', proposalVersion: original.version, proposalStartIso: original.startIso } });
  assert.equal(first.statusCode, 200, first.body);
  const moved = await rescheduleEvent(db, job.cardId, { date: '2030-12-17', time: '17:00', actor: 'synthetic-staff', operationKey: 'staff-move-after-guest-confirm' });
  const bio = await guestPut({ content: { slotChoice: 'confirm_proposed', bio: 'Updated biography' }, status: 'draft' });
  assert.equal(bio.statusCode, 200, bio.body);
  assert.equal((await getEventRecord(db, job.holdId!))!.status, 'proposed');
  assert.equal((await getEventRecord(db, job.holdId!))!.startIso, moved.event.startIso);
  const stale = await guestPut({ content: { slotChoice: 'confirm_proposed' }, status: 'draft', timeChoiceIntent: { choice: 'confirm_proposed', proposalVersion: original.version, proposalStartIso: original.startIso } });
  assert.equal(stale.statusCode, 422, stale.body);
  assert.equal((await getEventRecord(db, job.holdId!))!.status, 'proposed');
});

test('a stale scanned guest choice cannot update Calendar after a newer intent or changed selection', async () => {
  const created = await card('webinar'); await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  const event = (await getEventRecord(db, job.holdId!))!;
  const loaded = (await getSponsorDocWithAuthMaterial(db, job.docId!))!;
  const first = (await updateSponsorDoc(db, job.docId!, { content: { slotChoice: 'confirm_proposed' }, actorKind: 'sponsor' }))!;
  const key = { PK: `GUESTCHOICE#${job.docId}`, SK: `GUESTCHOICE#${job.docId}` };
  const scanned = { ...key, docId: job.docId, choice: 'confirm_proposed', intent: { choice: 'confirm_proposed', proposalVersion: event.version, proposalStartIso: event.startIso }, version: first.version, status: 'pending' };
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...scanned, version: first.version+1, choice: 'none_fit', status: 'cancelled' } }));
  const calls = google.calls.length;
  await processGuestChoice(db, scanned);
  assert.equal(google.calls.length, calls, 'stale scan must fail its version claim before provider calls');
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: scanned }));
  await updateSponsorDoc(db, loaded.doc.id, { content: { slotChoice: 'none_fit' }, actorKind: 'sponsor' });
  await processGuestChoice(db, scanned);
  assert.equal(google.calls.length, calls, 'changed current guest choice must cancel the old action before provider calls');
  assert.equal((await getEventRecord(db, event.id))!.status, 'proposed');
});

test('explicit recording time is not moved when its five-minute join lead overlaps a prior booking', async () => {
  ownerEvents = [{ id: 'synthetic-prior-booking', summary: 'Client meeting', start: { dateTime: '2030-12-18T15:00:00Z' }, end: { dateTime: '2030-12-18T16:00:00Z' } }];
  const created = await card('webinar', { anchorDate: '2030-12-18', time: '17:00', timeZone: 'Europe/Berlin' });
  const beforeMails = mails;
  await assert.rejects(processGuestIntake(db, created.card.guestIntake.jobId), /requested date\/time is unavailable/);
  const failed = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.requestedTime, '17:00'); assert.equal(failed.selectedTime, undefined);
  assert.equal(await getEventRecord(db, `hold_${created.card.id}`), null); assert.equal(mails, beforeMails);
  const taskVersion = (await getTaskConsistent(db, failed.taskId))!.version;
  await assert.rejects(processGuestIntake(db, failed.id), /requested date\/time is unavailable/);
  assert.equal((await getTaskConsistent(db, failed.taskId))!.version, taskVersion, 'identical automatic failure must not append another Task update');
  ownerEvents = [];
});

test('parked Cards pause quietly and resume the same job; archived Cards cancel permanently', async () => {
  const created = await card('webinar', { skipEmail: true });
  await parkCard(db, created.card.id, created.card.version);
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const paused = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(paused.status, 'paused'); assert.equal(paused.docId, undefined);
  const taskVersion = (await getTaskConsistent(db, paused.taskId))!.version;
  await processGuestIntake(db, paused.id);
  assert.equal((await getTaskConsistent(db, paused.taskId))!.version, taskVersion);
  const parked = (await getCardConsistent(db, created.card.id))!;
  await resumeCard(db, parked.id, parked.version); await processGuestIntake(db, paused.id);
  assert.equal((await getGuestIntakeJob(db, paused.id))!.status, 'skipped');
  const archived = await card('webinar'); const beforeMails = mails;
  const owningTask = (await getTaskConsistent(db, archived.card.guestIntake.taskId))!;
  await updateTask(db, owningTask.id, { currentTask: owningTask, expectedVersion: owningTask.version, patch: { status: 'skipped', skipReason: 'Synthetic owner cancelled intake' } });
  await processGuestIntake(db, archived.card.guestIntake.jobId);
  assert.equal((await getGuestIntakeJob(db, archived.card.guestIntake.jobId))!.status, 'cancelled');
  const cancelledTask = (await getTaskConsistent(db, owningTask.id))!;
  await updateTask(db, cancelledTask.id, { currentTask: cancelledTask, expectedVersion: cancelledTask.version, patch: { status: 'todo', skipReason: null } });
  await processGuestIntake(db, archived.card.guestIntake.jobId);
  assert.equal(mails, beforeMails); assert.equal((await getGuestIntakeJob(db, archived.card.guestIntake.jobId))!.status, 'cancelled');
});

test('an unconfigured other-type Card supports explicit Calendar-only blockers without enabling intake', async () => {
  const template = await createTemplate(db, { name: 'Synthetic office hours', type: 'office-hours', taskDefinitions: [] });
  const created = await invoke('POST', '/api/cards', { templateId: template.id, title: 'Synthetic Calendar-only event', anchorDate: '2030-12-19' });
  assert.equal(created.statusCode, 201, created.body);
  const target = JSON.parse(created.body).card;
  assert.equal(target.guestIntake, undefined);
  const beforeMails = mails;
  const missing = await invoke('POST', `/api/events/${target.id}/propose`, { date: '2030-12-19', time: '17:00', guestEmails: ['synthetic-guest@example.test'] });
  assert.equal(missing.statusCode, 422, missing.body); assert.match(JSON.parse(missing.body).error, /duration/);
  const proposed = await invoke('POST', `/api/events/${target.id}/propose`, { date: '2030-12-19', time: '12:00', timeZone: 'America/New_York', durationMinutes: 45, guestEmails: ['synthetic-guest@example.test'] });
  assert.equal(proposed.statusCode, 201);
  const event = JSON.parse(proposed.body).event;
  assert.equal(event.durationMinutes, 45); assert.equal(event.startIso, '2030-12-19T17:00:00.000Z');
  assert.equal(event.policy.guests.leadMinutes, 5); assert.equal(event.policy.zoom.enabled, true);
  assert.equal(event.operations[0].desired.emails.length, 0); assert.equal(mails, beforeMails);
  assert.equal((await getTemplate(db, template.id))!.eventPolicy, undefined);
  assert.equal((await getCardConsistent(db, target.id))!.guestIntake, undefined);
  const moved = await invoke('POST', `/api/events/${target.id}/reschedule`, { date: '2030-12-20', time: '12:00' });
  assert.equal(moved.statusCode, 200);
  const newEvent = JSON.parse(moved.body).event;
  assert.equal(newEvent.durationMinutes, 45); assert.deepEqual(newEvent.googleEventIds, event.googleEventIds);
  google.setAttendeeResponse(newEvent.googleEventIds[HOLD_ORGANIZER], 'synthetic-guest@example.test', 'accepted');
  await pollGuestIntakeAcceptances(db);
  assert.equal((await getEventRecord(db, event.id))!.status, 'approved'); assert.equal(mails, beforeMails);
  const configured = await card('webinar', { skipEmail: true });
  const conflict = await invoke('POST', `/api/events/${configured.card.id}/propose`, { date: '2030-12-20', time: '12:30', durationMinutes: 45, guestEmails: ['synthetic-guest@example.test'] });
  assert.equal(conflict.statusCode, 422, conflict.body); assert.match(JSON.parse(conflict.body).error, /duration conflicts/);
});

test('new Card-linked blockers cannot be created through the private legacy hold endpoint', async () => {
  const created = await card('webinar', { skipEmail: true });
  const result = await invoke('POST', '/api/calendar-holds', { cardId: created.card.id, date: '2030-12-23', title: 'Synthetic blocker', topic: 'Synthetic topic', guestRef: 'synthetic-guest@example.test' });
  assert.equal(result.statusCode, 422); assert.equal(JSON.parse(result.body).code, 'use_card_event_proposal');
});

test('podcast first-contact fails loudly with a Task error if required Cc cannot be added', async () => {
  const { deliverRenderedEmail } = await import('../src/sponsorDocs/emailDelivery');
  const created = await card('podcast');
  const beforeMails = mails;
  const taskId = created.card.guestIntake.taskId;
  const deferred = await deliverRenderedEmail(db, {
    draft: { subject: 'Test', body: 'Body' },
    recipientEmail: 'synthetic-guest@example.test',
    taskId,
    cc: [],
    requiredCc: ['alexey@datatalks.club'],
  });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.reason, 'invalid_cc');
  assert.match(deferred.message || '', /could not be added/);
  assert.equal(mails, beforeMails);
});

test('first-contact Card with event hold dates Template Tasks from proposed anchorDate, and redate-tasks repairs existing hold-owned Cards without touching the hold', async () => {
  const { dateFromTemplateOffset } = await import('../src/templates/cardTemplateProjection');
  const eventPolicy = policy('podcast');
  eventPolicy.guests.leadMinutes = 5;
  for (const notification of Object.values(eventPolicy.notifications)) notification.emails = [];
  const template = await createTemplate(db, {
    name: 'Podcast with offsets',
    type: 'podcast',
    origin: 'git',
    eventPolicy,
    guestIntake: { enabled: true, emailTemplateId: 'podcast.first-contact', formTemplate: 'podcast', followUpDays: 7, weekdays: [1, 2] },
    taskDefinitions: [
      { refId: 'prep', description: 'Prep guest', offsetDays: -14 },
      { refId: 'stream', description: 'Actual stream', offsetDays: 0 },
      { refId: 'followup', description: 'Post-stream followup', offsetDays: 5 },
      { refId: 'release', description: 'Publish episode', offsetDays: -2, anchor: 'end' },
    ],
  });
  const createdRes = await invoke('POST', '/api/cards', {
    templateId: template.id,
    guestEmail: 'synthetic-guest@example.test',
    creationKey: crypto.randomUUID(),
    endDate: '2035-06-01', agreedFrom: '2026-11-25', agreedTo: '2027-12-31',
  });
  assert.equal(createdRes.statusCode, 201, createdRes.body);
  const createdCard = JSON.parse(createdRes.body).card;
  await processGuestIntake(db, createdCard.guestIntake.jobId);

  const cardAfter = (await getCardConsistent(db, createdCard.id))!;
  assert.ok(cardAfter.anchorDate, 'event hold should set card.anchorDate');
  const eventBefore = (await getEventRecord(db, cardAfter.eventTime!.eventKey))!;
  const tasksAfter = await listTasksByCardConsistent(db, createdCard.id);
  const byRef = new Map(tasksAfter.filter((t) => t.templateTaskRef).map((t) => [t.templateTaskRef!, t]));
  assert.equal(byRef.get('prep')!.date, dateFromTemplateOffset(cardAfter.anchorDate!, -14));
  assert.equal(byRef.get('stream')!.date, cardAfter.anchorDate);
  assert.equal(byRef.get('followup')!.date, dateFromTemplateOffset(cardAfter.anchorDate!, 5));
  assert.equal(byRef.get('release')!.date, '2035-05-30');

  // Simulate an existing hold-owned Card whose open tasks were mis-dated to creation day,
  // with one done task and one skipped task that must remain untouched.
  const prepTask = byRef.get('prep')!;
  await updateTask(db, prepTask.id, { currentTask: prepTask, expectedVersion: prepTask.version, patch: { status: 'done', completedAt: new Date().toISOString(), date: '2020-01-01' } });
  const followupTask = byRef.get('followup')!;
  await updateTask(db, followupTask.id, { currentTask: followupTask, expectedVersion: followupTask.version, patch: { status: 'skipped', skipReason: 'Not needed', date: '2020-01-02' } });
  const streamTask = byRef.get('stream')!;
  await updateTask(db, streamTask.id, { currentTask: streamTask, expectedVersion: streamTask.version, patch: { date: '2020-01-03' } });

  const previewRes = await invoke('GET', `/api/cards/${createdCard.id}/redate-tasks`);
  assert.equal(previewRes.statusCode, 200, previewRes.body);
  const preview = JSON.parse(previewRes.body);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.updatedCount, 0);
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].taskId, streamTask.id);
  assert.equal(preview.changes[0].from, '2020-01-03');
  assert.equal(preview.changes[0].to, cardAfter.anchorDate);
  assert.equal((await getTaskConsistent(db, streamTask.id))!.date, '2020-01-03');

  const beforeMails = mails;
  const applyRes = await invoke('POST', `/api/cards/${createdCard.id}/redate-tasks`, { dryRun: false });
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = JSON.parse(applyRes.body);
  assert.equal(applied.dryRun, false);
  assert.equal(applied.updatedCount, 1);
  assert.equal((await getTaskConsistent(db, streamTask.id))!.date, cardAfter.anchorDate);
  assert.equal((await getTaskConsistent(db, prepTask.id))!.date, '2020-01-01');
  assert.equal((await getTaskConsistent(db, followupTask.id))!.date, '2020-01-02');
  assert.equal((await getTaskConsistent(db, byRef.get('release')!.id))!.date, '2035-05-30');
  assert.equal(mails, beforeMails);
  const eventAfter = (await getEventRecord(db, cardAfter.eventTime!.eventKey))!;
  assert.equal(eventAfter.version, eventBefore.version);
  assert.deepEqual(eventAfter.googleEventIds, eventBefore.googleEventIds);
});

function setOwnerCalendarProviderClientsForTests(value: Parameters<typeof setOwnerCalendarClients>[0]) { setOwnerCalendarClients({ ...value, ...(value.fetch ? { fetch: withOwnerAvailability(value.fetch) } : {}) }); }

test('January agreement bounds automatic selection and rejects an earlier November request without writes', async () => {
  const created = await card('podcast', { agreedFrom: '2031-01-01', agreedTo: '2031-01-31', skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.ok(job.selectedDate! >= '2031-01-01' && job.selectedDate! <= '2031-01-31');
  const earlier = await card('podcast', { agreedFrom: '2031-01-01', agreedTo: '2031-01-31', skipEmail: true });
  const queued = (await getGuestIntakeJob(db, earlier.card.guestIntake.jobId))!;
  queued.requestedDate = '2030-11-26';
  await saveGuestIntakeJob(db, queued);
  const before = google.calls.length, beforeMails = mails;
  await assert.rejects(processGuestIntake(db, queued.id), /outside the guest agreement/);
  assert.equal(google.calls.length, before); assert.equal(mails, beforeMails);
});

test('completed invitation never replays a stale November job after its Card moves to January', async () => {
  const created = await card('podcast', { skipEmail: true });
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  job.requestedDate = '2030-11-26';
  await saveGuestIntakeJob(db, job);
  const task = (await getTaskConsistent(db, job.taskId))!;
  await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { status: 'done' } });
  const before = google.calls.length, beforeMails = mails;
  await processGuestIntake(db, job.id);
  assert.equal(google.calls.length, before); assert.equal(mails, beforeMails);
  assert.equal((await getGuestIntakeJob(db, job.id))!.status, job.status);
  const retry = await invoke('POST', `/api/cards/${job.cardId}/guest-intake/retry`, {});
  assert.equal(retry.statusCode, 409, retry.body);
  assert.match(JSON.parse(retry.body).error, /completed/);
});

test('explicit anchorDate on a free Wednesday succeeds even when podcast policy defaults weekdays to Mon/Tue', async () => {
  // 2030-12-04 is a Wednesday; podcast guestIntake.weekdays is [1, 2] for auto-pick only.
  const created = await card('podcast', { anchorDate: '2030-12-04', skipEmail: true });
  await processGuestIntake(db, created.card.guestIntake.jobId);
  const job = (await getGuestIntakeJob(db, created.card.guestIntake.jobId))!;
  assert.equal(job.status, 'skipped');
  assert.equal(job.selectedDate, '2030-12-04');
  const event = (await getEventRecord(db, job.holdId!))!;
  assert.equal(event.date, '2030-12-04');
});

test('GET /api/calendar-items/next-free-day honors all-day summit blockers and returns the nearest free day', async () => {
  ownerEvents = [
    { id: 'evt-summit', summary: 'AI Coding Summit Berlin', transparency: 'transparent', start: { date: '2030-12-02' }, end: { date: '2030-12-03' } },
  ];
  try {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/calendar-items/next-free-day',
      headers: { 'x-user-id': 'synthetic-actor' },
      body: null,
      queryStringParameters: { type: 'podcast', window: 'midday', from: '2030-12-02', to: '2030-12-06' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.found, true);
    assert.equal(body.date, '2030-12-03');
    assert.equal(body.window, 'midday');
    assert.equal(body.time, '12:30');
    assert.equal(body.durationMinutes, 60);
  } finally {
    ownerEvents = [];
  }
});
