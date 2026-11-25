import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const { run } = await import('../src/cli.mjs');
test('cards invite guests explicitly adds guests to an existing private invitation', async () => {
  const calls = fakePortal({ 'PATCH /api/cards/test/calendar-invites': { eventId: 'private-event', added: ['speaker@example.test'] } });
  const io = captureIo();
  assert.equal(await run(['cards', 'invite', 'guests', 'test', '--guests', 'speaker@example.test', '--json'], io), 0);
  assert.deepEqual(calls[0].body, { guestEmails: ['speaker@example.test'] });
  assert.equal(io.json().eventId, 'private-event');
});
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
test('cards time labels the public DTC events entry apart from the guest invitation', async () => {
  fakePortal({
    'POST /api/cards/test/time': {
      card: {
        id: 'test',
        eventTime: { startIso: '2026-12-01T16:00:00.000Z', endIso: '2026-12-01T17:00:00.000Z', timeZone: 'Europe/Berlin' },
        calendarInvites: [
          { eventId: 'public-1', calendar: 'f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com', label: 'From Ad-Hoc SQL to AI Agents' },
          { eventId: 'private-1', calendar: 'orin@datatalks.club' },
        ],
      },
      invite: { outcome: 'sent', state: 'synced' },
      taskClosure: { outcome: 'closed', message: 'Closed invite task.', tasks: [] },
    },
  });
  const io = captureIo();
  assert.equal(await run(['cards', 'time', 'test', '--at', '2026-12-01 17:00'], io), 0);
  const text = io.text();
  assert.match(text, /public entry: public-1 on DTC events/);
  assert.match(text, /invite: private-1 on orin@datatalks\.club/);
});
test('cards time requires --at before requesting API', async () => {
  const calls = fakePortal({});
  const io = captureIo();
  assert.notEqual(await run(['cards', 'time', 'test'], io), 0);
  assert.match(io.errors.join('\n'), /--at is required/);
  assert.equal(calls.length, 0);
});
