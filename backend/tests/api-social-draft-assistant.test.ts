import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import {
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
  anthropicMessagesUrl,
} from '../src/assistant/socialDraftAssistant';

describe('retired social draft assistant', () => {
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

  it('keeps the historical z.ai constants as non-executing compatibility exports', () => {
    assert.strictEqual(DEFAULT_ZAI_BASE_URL, 'https://api.z.ai/api/anthropic');
    assert.strictEqual(DEFAULT_ZAI_MODEL, 'glm-5.2');
    assert.strictEqual(
      anthropicMessagesUrl(DEFAULT_ZAI_BASE_URL),
      'https://api.z.ai/api/anthropic/v1/messages'
    );
  });

  it('returns 410 before any model or provider client can be instantiated', async () => {
    const beforeFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('legacy network path must be unreachable');
    }) as typeof fetch;
    try {
      const response = await handler({
        httpMethod: 'POST',
        path: '/api/assistant-social-drafts/mock-telegram',
        headers: { 'x-user-id': 'operator-1' },
        body: JSON.stringify({
          text: 'Draft Alexey social posts',
          token: 'must-not-be-processed',
        }),
      }, {});
      assert.strictEqual(response.statusCode, 410);
      assert.match(response.body, /conversational Typefully approval flow/);
      assert.strictEqual(calls, 0);
      assert.doesNotMatch(response.body, /must-not-be-processed/);
    } finally {
      globalThis.fetch = beforeFetch;
    }
  });
});
