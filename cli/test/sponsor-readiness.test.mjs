import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readiness } from '../src/commands/sponsors.mjs';
test('readiness CLI reads and sends explicitly pinned revisions without inventing provenance', async () => {
  const original = globalThis.fetch, token = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = 'synthetic-token';
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify({ materialVersion: 2, checks: [] })); };
  try {
    const args = { _: ['synthetic-slot'], json: true, url: 'https://portal.example.test' };
    await readiness(args, { print() {} });
    assert.equal(calls[0].method, 'GET');
    const body = { version: 5, materialVersion: 2, checkId: 'later', criterion: 'materials-approved' };
    await readiness({ ...args, _: ['synthetic-slot', 'check'], data: JSON.stringify(body) }, { print() {} });
    assert.deepEqual(JSON.parse(calls[1].body), { ...body, action: 'check' });
    assert.ok(calls[1].url.endsWith('/deliverables/synthetic-slot/readiness'));
    await assert.rejects(readiness({ ...args, _: ['synthetic-slot', 'wrong'] }, { print() {} }), /Invalid readiness action/);
  } finally { globalThis.fetch = original; if (token === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = token; }
});
