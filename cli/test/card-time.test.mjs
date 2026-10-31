import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const { run } = await import('../src/cli.mjs');
test('cards time sends arbitrary wall time, zone, duration and Card guests; --json', async () => {
  const calls = fakePortal({
    'POST /api/cards/test/time': {
      card: { id: 'test', calendarInvites: [] },
      invite: { outcome: 'sent', state: 'synced' },
      taskClosure: { outcome: 'blocked', message: 'Invite task "Create a calendar invite" remains todo: complete prerequisites first', tasks: [] },
    },
  });
  const io = captureIo();
  assert.equal(await run(['cards', 'time', 'test', '--at', '2026-11-09 14:37', '--duration', '90', '--tz', 'Europe/Berlin', '--guests', 'guest@example.test', '--json'], io), 0);
  assert.deepEqual(calls[0].body, { at: '2026-11-09 14:37', duration: 90, tz: 'Europe/Berlin', guestEmails: ['guest@example.test'] });
  assert.equal(io.json().card.id, 'test');
  assert.equal(io.json().invite.outcome, 'sent');
  assert.equal(io.json().taskClosure.outcome, 'blocked');
});
test('cards time human output prints invite result and task-closure outcome', async () => {
  fakePortal({
    'POST /api/cards/test/time': {
      card: {
        id: 'test',
        eventTime: { startIso: '2026-12-01T11:30:00.000Z', endIso: '2026-12-01T12:30:00.000Z', timeZone: 'Europe/Berlin' },
        calendarInvites: [{ eventId: 'evt-1', url: 'https://calendar.google.com/calendar/event?eid=evt-1' }],
      },
      invite: { outcome: 'sent', state: 'synced' },
      taskClosure: {
        outcome: 'blocked',
        message: 'Invite task "Create a calendar invite for guest speaker" (1a05883d) remains todo: Cannot mark task as done: complete or skip "Obtain speaker\'s email" first',
        tasks: [],
      },
    },
  });
  const io = captureIo();
  assert.equal(await run(['cards', 'time', 'test', '--at', '2026-12-01 12:30'], io), 0);
  const text = io.text();
  assert.match(text, /invite: evt-1/);
  assert.match(text, /taskClosure \(blocked\): Invite task "Create a calendar invite for guest speaker"/);
});
test('cards time requires --at before requesting API', async () => {
  const calls = fakePortal({});
  const io = captureIo();
  assert.notEqual(await run(['cards', 'time', 'test'], io), 0);
  assert.match(io.errors.join('\n'), /--at is required/);
  assert.equal(calls.length, 0);
});
