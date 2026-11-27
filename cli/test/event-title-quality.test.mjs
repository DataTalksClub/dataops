import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/cli.mjs';

test('title CLI forwards explicit review, prints checklist, and rejects incomplete review locally', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.DATAOPS_TOKEN;
  const previousUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = 'invented-test-token';
  process.env.DATAOPS_URL = 'http://127.0.0.1';
  const calls = [], lines = [], errors = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ title: 'Forward Deployed Engineering', issues: [], checklist: { broad: 'Useful without the employer' }, approved: true, titleQuality: { reviewRequired: true, issues: [{ message: 'Use Title Case: Building AI Systems' }] } }), { status: 200 });
  };
  const io = { log: line => lines.push(line), error: line => errors.push(line) };
  try {
    assert.equal(await run(['event', 'title-check', '--title', 'Forward Deployed Engineering'], io), 0);
    assert.equal(calls[0].url, 'http://127.0.0.1/api/events/title-check');
    assert.deepEqual(calls[0].body, { title: 'Forward Deployed Engineering' });
    assert.ok(lines.some(line => line.includes('Useful without the employer')));
    assert.equal(await run(['event', 'approve-title', 'example', '--meaningful', '--broad', '--consistent', '--note', 'All copies checked', '--expected-version', '4', '--json'], io), 0);
    assert.deepEqual(calls[1].body, { meaningful: true, broad: true, consistent: true, note: 'All copies checked', expectedVersion: 4 });
    assert.equal(await run(['event', 'approve-title', 'example', '--meaningful'], io), 2);
    assert.equal(calls.length, 2);
    assert.equal(await run(['event', 'propose', 'example', '--date', '2038-10-29'], io), 0);
    assert.ok(lines.some(line => line.includes('Title check: Use Title Case')));
    assert.ok(lines.some(line => line.includes('approve-title records')));
    assert.ok(errors.some(line => line.includes('--broad')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = previousUrl;
  }
});
