import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const originalFetch = globalThis.fetch;
const { run } = await import('../src/cli.mjs');
afterEach(() => { globalThis.fetch = originalFetch; });
test('invitation status and preview are read-only, preserve evidence and show rendered copy', async () => {
  const calls = fakePortal({ 'GET /api/cards/synthetic-card/guest-intake': ({ query }) => ({ invitation: { status: 'sent', recipient: 'guest@example.test', taskId: 'task-test', messageId: 'gmail-test' }, ...(query.preview ? { preview: true, email: { subject: 'Synthetic guest', body: 'Synthetic invitation body.' } } : {}) }) });
  const status = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card'], status), 0);
  assert.match(status.text(), /First invitation: sent/);
  assert.match(status.text(), /Gmail message ID: gmail-test/);
  const preview = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--preview'], preview), 0);
  assert.match(preview.text(), /Subject: Synthetic guest/);
  assert.match(preview.text(), /Synthetic invitation body/);
  assert.equal(calls.at(-1).query.preview, '1');
  assert.ok(calls.every(call => call.method === 'GET'));
});
test('first-invitation send and proven pre-send recovery invoke only their guarded server routes', async () => {
  const calls = fakePortal({
    'POST /api/cards/synthetic-card/guest-intake/send': { invitation: { status: 'queued' } },
    'POST /api/cards/synthetic-card/guest-intake/retry': { invitation: { status: 'queued' } },
  });
  for (const action of ['--send', '--retry-pre-send']) {
    const io = captureIo();
    assert.equal(await run(['cards', 'invitation', 'synthetic-card', action], io), 0);
    assert.match(io.text(), /First invitation: queued/);
    assert.doesNotMatch(io.text(), /First invitation: sent/);
    assert.deepEqual(calls.at(-1).body, {});
  }
  assert.equal(calls.length, 2);
});
test('conflicting invitation actions fail before requests', async () => {
  const calls = fakePortal({});
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--send', '--preview'], captureIo()), 2);
  assert.equal(calls.length, 0);
});
test('retry-pre-send can re-point a failed invitation at a new date without an event', async () => {
  const calls = fakePortal({ 'POST /api/cards/synthetic-card/guest-intake/retry': { invitation: { status: 'queued' } } });
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--retry-pre-send', '--date', '2026-11-25', '--time', '12:30'], captureIo()), 0);
  assert.deepEqual(calls.at(-1).body, { date: '2026-11-25', time: '12:30' });
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--retry-pre-send', '--time', '12:30'], captureIo()), 2);
  assert.equal(calls.length, 1);
});
test('--send-calendar posts only to the calendar-only route; --dry-run is a plan and email is never sent', async () => {
  const plan = { dryRun: true, sent: false, emailSent: false, alreadyNotified: false, cardId: 'synthetic-card', invitationId: 'job', holdId: 'hold_synthetic-card', eventId: 'evt', calendar: 'orin@datatalks.club', startIso: '2030-01-01T18:00:00.000Z', guests: ['guest@example.test'], requiredAttendees: ['internal@example.invalid'], attendees: ['guest@example.test', 'internal@example.invalid'] };
  const calls = fakePortal({ 'POST /api/cards/synthetic-card/guest-intake/send-calendar': ({ body }) => ({ ...plan, dryRun: body.dryRun === true, sent: body.dryRun !== true }) });
  const dry = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--send-calendar', '--dry-run'], dry), 0);
  assert.deepEqual(calls.at(-1).body, { dryRun: true });
  assert.match(dry.text(), /Dry run \(nothing sent\)/);
  assert.match(dry.text(), /first-contact email: not sent/);
  assert.match(dry.text(), /internal@example\.invalid/);
  const sent = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--send-calendar', '--guests', 'cohost@example.test'], sent), 0);
  assert.deepEqual(calls.at(-1).body, { guestEmails: ['cohost@example.test'] });
  assert.match(sent.text(), /^Sent the \[Proposed\] calendar invitation only/m);
  assert.match(sent.text(), /--send refuses/);
  assert.ok(calls.every(call => !call.route.endsWith('/guest-intake/send')));
});
test('--send-calendar cannot combine with --send; --dry-run needs --send-calendar', async () => {
  const calls = fakePortal({});
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--send', '--send-calendar'], captureIo()), 2);
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--send', '--dry-run'], captureIo()), 2);
  assert.equal(calls.length, 0);
});
test('invite guests --dry-run forwards dryRun and prints the calendar-only plan on a silent hold', async () => {
  const calls = fakePortal({ 'PATCH /api/cards/synthetic-card/calendar-invites': ({ body }) => ({ viaCalendarOnlyInvitation: true, dryRun: body.dryRun === true, sent: false, emailSent: false, holdId: 'hold', eventId: 'evt', calendar: 'orin@datatalks.club', startIso: '2030-01-01T18:00:00.000Z', guests: ['guest@example.test'], attendees: ['guest@example.test', 'internal@example.invalid'], added: ['guest@example.test'] }) });
  const io = captureIo();
  assert.equal(await run(['cards', 'invite', 'guests', 'synthetic-card', '--guests', 'guest@example.test', '--dry-run'], io), 0);
  assert.deepEqual(calls.at(-1).body, { guestEmails: ['guest@example.test'], dryRun: true });
  assert.match(io.text(), /Dry run \(nothing sent\)/);
});
