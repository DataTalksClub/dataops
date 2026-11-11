import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const originalFetch = globalThis.fetch;
const { run } = await import('../src/cli.mjs');
afterEach(() => { globalThis.fetch = originalFetch; });
test('invitation status and preview are read-only, preserve evidence and show rendered copy', async () => {
  const calls = fakePortal({ 'GET /api/cards/synthetic-card/guest-intake': ({ query }) => ({ invitation: { status: 'sent', recipient: 'guest@example.test', taskId: 'task-test', messageId: 'gmail-test' }, ...(query.preview ? { preview: true, email: { cc: ['alexey@datatalks.club'], subject: 'Synthetic guest', body: 'Synthetic invitation body.' } } : {}) }) });
  const status = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card'], status), 0);
  assert.match(status.text(), /First invitation: sent/);
  assert.match(status.text(), /Gmail message ID: gmail-test/);
  const preview = captureIo();
  assert.equal(await run(['cards', 'invitation', 'synthetic-card', '--preview'], preview), 0);
  assert.match(preview.text(), /Cc: alexey@datatalks\.club/);
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
