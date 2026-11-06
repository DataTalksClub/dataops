import { rescheduleEvent, approveEvent } from '../src/events/service';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import { guestPortalSlots, recordGuestPortalTimeChoice, processGuestChoice } from '../src/events/guestIntakePortal';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
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
  setSponsorDocEmailDepsForTests({ credential: 'synthetic', fetchImpl: async (url) => {
    if (String(url).endsWith('/messages/send')) { mails++; if (onMailSend) { const callback = onMailSend; onMailSend = undefined; await callback(); } if (failMail) throw new Error('synthetic ambiguous timeout'); return new Response(JSON.stringify({ id: `synthetic-mail-${mails}` }), { status: 200 }); }
    if (String(url).includes('userinfo')) return new Response(JSON.stringify({ email: 'orin@datatalks.club' }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'synthetic', provider_account_id: 'orin@datatalks.club', scopes: ['https://www.googleapis.com/auth/gmail.send'] }), { status: 200 });
  } });
  await db.send(new PutCommand({ TableName: TABLE_USERS, Item: { PK: 'SETTINGS#text-templates', SK: 'SETTINGS#text-templates', version: 1, templates: ['podcast','webinar','workshop'].map(type => ({ id: `${type}.first-contact`, body: `Subject: <FIRST_NAME_SUBJECT_PREFIX>DataTalks.Club ${type}\n\n<GREETING>\nJoin us<TOPIC_CLAUSE>. Would <WEEKDAY_DATE> at <TIME_TIMEZONE> work?\n<GUEST_FORM_URL>\nAccess code: <ACCESS_CODE>`, title: type, updatedAt: '2030-01-01' })) } }));
});
after(async () => { configureTaskChecklistStore(null); checklist.cleanup(); setCalendarHoldGoogleDepsForTests({}); setSponsorDocEmailDepsForTests({}); setOwnerCalendarProviderClientsForTests({}); await stopLocal(); });
async function card(type: 'podcast'|'webinar'|'workshop', extra: Record<string, unknown> = {}) {
  const eventPolicy = policy(type);
  eventPolicy.zoom = { enabled: false }; eventPolicy.guests.leadMinutes = 5;
  for (const notification of Object.values(eventPolicy.notifications)) notification.emails = [];
  const template = await createTemplate(db, { name: type, type, eventPolicy, guestIntake: { enabled: true, emailTemplateId: `${type}.first-contact`, formTemplate: type, followUpDays: 7, ...(type === 'podcast' ? { weekdays: [1,2], firstContactTaskRefs: ['obtain-speaker-email','create-proposed-calendar-invite'] } : {}) }, taskDefinitions: type === 'podcast' ? [
    { refId: 'obtain-speaker-email', description: 'Obtain guest email', offsetDays: 0, requiredLinkName: 'Guest email', proofRequirement: { type: 'url', required: true } },
    { refId: 'create-proposed-calendar-invite', description: 'Create proposed invite', offsetDays: 0, dependsOn: ['obtain-speaker-email'], proofRequirement: { type: 'comment', required: true } },
  ] : [] });
  const body = { templateId: template.id, guestEmail: 'synthetic-guest@example.test', creationKey: crypto.randomUUID(), ...extra };
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
  const event = (await getEventRecord(db, job.holdId!))!;
  assert.equal(event.durationMinutes, 60);
  assert.equal(event.operations[0].desired.startIso, new Date(Date.parse(event.startIso)-5*60000).toISOString()); assert.match(event.operations[0].desired.summary, /^\[Proposed\] /);
  assert.ok(event.operations[0].desired.attendees.includes(created.body.guestEmail));
  assert.equal(event.operations[0].desired.sendUpdates, 'all');
  assert.match(event.operations[0].desired.description, /Access code:/); assert.match(event.operations[0].desired.description, /America\/New_York/);
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
