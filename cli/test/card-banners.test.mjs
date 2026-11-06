import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const { run } = await import('../src/cli.mjs');
test('Card banner request carries only register/file IDs and stable revision', async () => {
  const calls = fakePortal({ 'POST /api/cards/card/banners': { job: { id: 'a'.repeat(64), state: 'queued' } } });
  const io = captureIo();
  assert.equal(await run(['cards', 'banner', 'card', '--event-type', 'workshop', '--layout', 'square', '--speakers', 'person:portrait', '--revision', 'cover-v1', '--json'], io), 0);
  assert.deepEqual(calls[0].body, { eventType: 'workshop', layout: 'square', speakers: [{ personId: 'person', portraitFileId: 'portrait' }], revision: 'cover-v1' });
  assert.equal(io.json().job.state, 'queued');
});
test('Card banner status and safe failure surface without new generation', async () => {
  const id = 'b'.repeat(64);
  const calls = fakePortal({ [`GET /api/cards/card/banners/${id}`]: { job: { id, state: 'failed', error: 'renderer-cold-activating' } } });
  const io = captureIo();
  assert.notEqual(await run(['cards', 'banner', 'card', '--job', id], io), 0);
  assert.match(io.errors.join('\n'), /renderer-cold-activating/); assert.equal(calls.length, 1);
});
test('approved sponsor treatment uses a saved logo ID without a local path', async () => {
  const calls = fakePortal({ 'POST /api/cards/card/banners': { job: { id: 'c'.repeat(64), state: 'queued' } } });
  assert.equal(await run(['cards', 'banner', 'card', '--event-type', 'webinar', '--layout', 'square', '--speakers', 'person:portrait', '--revision', 'sponsor-v1', '--sponsor-logo', 'logo', '--sponsor-treatment', 'approved-logo', '--json'], captureIo()), 0);
  assert.equal(calls[0].body.sponsorLogoFileId, 'logo'); assert.equal(calls[0].body.sponsorTreatment, 'approved-logo');
});
test('artifact download verifies bytes, strips traversal from default name, refuses overwrite', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dataops-banner-download-'));
  const previous = process.cwd();
  const bytes = Buffer.from('synthetic PNG bytes');
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const calls = fakePortal({
    'GET /api/artifacts/banner': { artifact: { id: 'banner', filename: '../escaped.png', sizeBytes: bytes.length, checksum } },
    'GET /api/artifacts/banner/download': { downloadUrl: 'https://storage.example.test/banner.png?signed=secret' },
    'GET /banner.png': () => new Response(bytes),
  });
  process.chdir(dir);
  try {
    assert.equal(await run(['artifacts', 'download', 'banner'], captureIo()), 0);
    assert.deepEqual(readFileSync(path.join(dir, 'escaped.png')), bytes);
    assert.equal(existsSync(path.join(dir, '..', 'escaped.png')), false);
    const io = captureIo();
    assert.notEqual(await run(['artifacts', 'download', 'banner'], io), 0);
    assert.deepEqual(readFileSync(path.join(dir, 'escaped.png')), bytes);
    const transfer = calls.find(call => call.rawPath === '/banner.png');
    assert.equal(Object.keys(transfer.headers).some(key => key.toLowerCase() === 'authorization'), false);
    assert.equal(io.errors.join('\n').includes('signed=secret'), false);
  } finally { process.chdir(previous); }
});


test('explicit Q&A label is sent without changing the webinar event type', async () => {
  const calls = fakePortal({ 'POST /api/cards/card/banners': { job: { id: 'd'.repeat(64), state: 'queued' } } });
  assert.equal(await run(['cards', 'banner', 'card', '--event-type', 'webinar', '--event-label', 'Live Q&A', '--layout', 'square', '--speakers', 'a:pa,b:pb,c:pc', '--revision', 'qa-v1', '--json'], captureIo()), 0);
  assert.equal(calls[0].body.eventLabel, 'Live Q&A'); assert.equal(calls[0].body.eventType, 'webinar'); assert.equal(calls[0].body.speakers.length, 3);
});
