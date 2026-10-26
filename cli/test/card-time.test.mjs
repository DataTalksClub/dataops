import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const { run } = await import('../src/cli.mjs');
test('cards time sends arbitrary wall time, zone, duration and Card guests; --json', async () => {
  const calls = fakePortal({ 'POST /api/cards/test/time': { card: { id: 'test', calendarInvites: [] } } });
  const io = captureIo();
  assert.equal(await run(['cards', 'time', 'test', '--at', '2026-11-09 14:37', '--duration', '90', '--tz', 'Europe/Berlin', '--guests', 'guest@example.test', '--json'], io), 0);
  assert.deepEqual(calls[0].body, { at: '2026-11-09 14:37', duration: 90, tz: 'Europe/Berlin', guestEmails: ['guest@example.test'] });
  assert.equal(io.json().card.id, 'test');
});
test('cards time requires --at before requesting API', async () => {
  const calls = fakePortal({});
  const io = captureIo();
  assert.notEqual(await run(['cards', 'time', 'test'], io), 0);
  assert.match(io.errors.join('\n'), /--at is required/);
  assert.equal(calls.length, 0);
});
