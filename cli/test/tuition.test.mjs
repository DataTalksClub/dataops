import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands/tuition.mjs';
test('tuition CLI shares the bounded billing API and uses current versions for updates', async () => {
  const oldFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = 'synthetic-billing-token';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), method: options.method, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify(options.method === 'GET' && !new URL(url).pathname.endsWith('/agreement')
      ? { items: [], nextCursor: '30', total: 50 } : { id: 'agreement', version: 3 }));
  };
  try {
    const args = { json: true, url: 'https://synthetic.example.test' };
    const page = await commands.list({ ...args, search: 'Student', status: 'conditional', limit: '30' }, {});
    assert.equal(page.nextCursor, '30'); assert.equal(calls.length, 1);
    assert.equal(calls[0].url.searchParams.get('status'), 'conditional');
    assert.equal(calls[0].url.searchParams.get('limit'), '30');
    await commands.update({ ...args, _: ['agreement'], data: JSON.stringify({ notes: 'Retain actual payment condition' }) }, {});
    assert.equal(calls[1].method, 'GET'); assert.equal(calls[2].method, 'PUT');
    assert.equal(calls[2].body.version, 3); assert.equal(calls[2].body.dueOn, undefined);
  } finally { globalThis.fetch = oldFetch; if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken; }
});
