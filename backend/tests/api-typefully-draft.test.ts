import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';

describe('retired assistant-job Typefully write path', () => {
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    const localPort = await startLocal();
    await createTables(await getClient(localPort));
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    await handler({ httpMethod: 'GET', path: '/api/health' }, {});
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('returns 410 for every former write status and request body without provider access', async () => {
    const beforeFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('legacy provider path must be unreachable');
    }) as typeof fetch;
    try {
      for (const method of ['POST', 'PUT']) {
        const response = await handler({
          httpMethod: method,
          path: '/api/assistant-jobs/any-status/typefully-draft',
          headers: { 'x-user-id': 'operator-1' },
          body: JSON.stringify({
            socialSetId: 123,
            platforms: ['x'],
            xPosts: ['must never be sent'],
          }),
        }, {});
        assert.strictEqual(response.statusCode, 410);
        assert.match(response.body, /legacy Typefully write path is retired/);
      }
      assert.strictEqual(calls, 0);
    } finally {
      globalThis.fetch = beforeFetch;
    }
  });
});
