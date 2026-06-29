import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';
import {
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
  FetchTypefullyDraftClient,
  anthropicMessagesUrl,
  setSocialDraftAssistantClients,
  type GeneratedSocialDraft,
  type SocialDraftIntent,
  type TypefullyDraftClient,
  type ZaiSocialDraftClient,
} from '../src/assistant/socialDraftAssistant';

describe('API - Social draft assistant', () => {
  let handler: typeof import('../src/handler').handler;
  const originalFetch = globalThis.fetch;

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.TYPEFULLY_SOCIAL_SET_ALEXEY = '188312';
    process.env.TYPEFULLY_SOCIAL_SET_DATATALKSCLUB = '182343';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  afterEach(() => {
    setSocialDraftAssistantClients(null);
    globalThis.fetch = originalFetch;
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_BASE_URL;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.TYPEFULLY_SOCIAL_SET_ALEXEY;
    delete process.env.TYPEFULLY_SOCIAL_SET_DATATALKSCLUB;
  });

  function mockTelegram(text: string): Record<string, unknown> {
    return {
      telegramUpdate: {
        message: {
          message_id: 101,
          chat: { id: -100100, title: 'Social drafts' },
          from: { username: 'alexeygrigorev' },
          text,
        },
      },
    };
  }

  function successClients(calls: { intents: SocialDraftIntent[]; typefully: Array<Record<string, unknown>> }): {
    zai: ZaiSocialDraftClient;
    typefully: TypefullyDraftClient;
  } {
    return {
      zai: {
        async generateDraft(intent: SocialDraftIntent): Promise<GeneratedSocialDraft> {
          calls.intents.push(intent);
          return {
            draftTitle: `${intent.account.label} workshop draft`,
            scratchpadText: 'Generated from a mocked Telegram request for local verification.',
            xPosts: [`${intent.account.label}: X draft for ${intent.requestedIntent}`],
            linkedinPosts: [`${intent.account.label}: LinkedIn draft for ${intent.requestedIntent}`],
          };
        },
      },
      typefully: {
        async createSavedDraft(input) {
          calls.typefully.push(input as unknown as Record<string, unknown>);
          assert.ok(!JSON.stringify(input).includes('publish_at'));
          return {
            id: `mock-${input.socialSetId}`,
            status: 'draft',
            privateUrl: `https://typefully.example/draft/${input.socialSetId}`,
            shareUrl: null,
            socialSetId: input.socialSetId,
            platforms: input.platforms,
            preview: input.draft.xPosts[0],
          };
        },
      },
    };
  }

  async function runMockTelegram(text: string): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/assistant-social-drafts/mock-telegram',
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify(mockTelegram(text)),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body);
  }

  it('knows the z.ai Anthropic-compatible defaults', () => {
    assert.strictEqual(DEFAULT_ZAI_BASE_URL, 'https://api.z.ai/api/anthropic');
    assert.strictEqual(DEFAULT_ZAI_MODEL, 'glm-5.2');
    assert.strictEqual(
      anthropicMessagesUrl('https://api.z.ai/api/anthropic'),
      'https://api.z.ai/api/anthropic/v1/messages',
    );
    assert.strictEqual(
      anthropicMessagesUrl('https://api.z.ai/api/anthropic/v1'),
      'https://api.z.ai/api/anthropic/v1/messages',
    );
  });

  it('creates an Alexey / Al_Grigor Typefully saved draft from a mock Telegram request', async () => {
    const calls = { intents: [] as SocialDraftIntent[], typefully: [] as Array<Record<string, unknown>> };
    setSocialDraftAssistantClients(successClients(calls));

    const body = await runMockTelegram('Draft Alexey / Al_Grigor posts about the AI agents workshop next week');

    assert.strictEqual(body.reviewStatus, 'created');
    assert.strictEqual(body.typefullyCalled, true);
    assert.strictEqual(body.accountKey, 'alexey');
    assert.strictEqual(body.job.assistantType, 'social-draft');
    assert.strictEqual(body.job.status, 'waiting_approval');
    assert.strictEqual(body.artifact.status, 'needs-review');
    assert.strictEqual(body.artifact.metadata.target_account, 'alexey');
    assert.strictEqual(body.artifact.metadata.target_social_set_id, 188312);
    assert.deepStrictEqual(body.artifact.metadata.target_platforms, ['x', 'linkedin']);
    assert.strictEqual(body.artifact.metadata.typefully.status, 'draft');
    assert.strictEqual(calls.intents.length, 1);
    assert.strictEqual(calls.intents[0].account.key, 'alexey');
    assert.ok(calls.intents[0].styleExamples.some((example) => example.platform === 'x'));
    assert.ok(calls.intents[0].styleExamples.some((example) => example.platform === 'linkedin'));
    assert.strictEqual(calls.typefully.length, 1);
    assert.strictEqual(calls.typefully[0].socialSetId, 188312);
  });

  it('creates a DataTalksClub Typefully saved draft from a mock Telegram request', async () => {
    const calls = { intents: [] as SocialDraftIntent[], typefully: [] as Array<Record<string, unknown>> };
    setSocialDraftAssistantClients(successClients(calls));

    const body = await runMockTelegram('Please make DTC DataTalksClub social posts for the new ML Zoomcamp Q&A');

    assert.strictEqual(body.reviewStatus, 'created');
    assert.strictEqual(body.typefullyCalled, true);
    assert.strictEqual(body.accountKey, 'datatalksclub');
    assert.strictEqual(body.artifact.metadata.target_account, 'datatalksclub');
    assert.strictEqual(body.artifact.metadata.target_social_set_id, 182343);
    assert.strictEqual(calls.intents[0].account.key, 'datatalksclub');
    assert.strictEqual(calls.typefully[0].socialSetId, 182343);
  });

  it('does not call Typefully when the Telegram request has ambiguous account selection', async () => {
    const calls = { intents: [] as SocialDraftIntent[], typefully: [] as Array<Record<string, unknown>> };
    setSocialDraftAssistantClients(successClients(calls));

    const body = await runMockTelegram('Draft social posts about the new event');

    assert.strictEqual(body.reviewStatus, 'needs-account-clarification');
    assert.strictEqual(body.typefullyCalled, false);
    assert.strictEqual(body.job.status, 'waiting_approval');
    assert.strictEqual(body.artifact.status, 'needs-review');
    assert.strictEqual(body.artifact.metadata.review_status, 'needs-account-clarification');
    assert.strictEqual(body.artifact.metadata.typefully_called, false);
    assert.strictEqual(calls.intents.length, 0);
    assert.strictEqual(calls.typefully.length, 0);
  });

  it('records provider failures with redacted errors and no Typefully write', async () => {
    const calls = { typefully: 0 };
    setSocialDraftAssistantClients({
      zai: {
        async generateDraft(): Promise<GeneratedSocialDraft> {
          throw new Error('upstream failed with ZAI_API_KEY=sk-test-secret and TYPEFULLY_API_KEY=sk-typefully-secret');
        },
      },
      typefully: {
        async createSavedDraft() {
          calls.typefully += 1;
          throw new Error('should not be called');
        },
      },
    });

    const body = await runMockTelegram('Draft Alexey posts about a new AI Engineering lesson');

    assert.strictEqual(body.reviewStatus, 'failed');
    assert.strictEqual(body.typefullyCalled, false);
    assert.strictEqual(body.job.status, 'failed');
    assert.match(body.job.lastError.summary, /redacted/);
    assert.ok(!JSON.stringify(body).includes('sk-test-secret'));
    assert.ok(!JSON.stringify(body).includes('sk-typefully-secret'));
    assert.strictEqual(calls.typefully, 0);
  });

  it('redacts Typefully failures without leaking private draft URLs or raw exports', async () => {
    setSocialDraftAssistantClients({
      zai: {
        async generateDraft(): Promise<GeneratedSocialDraft> {
          return {
            xPosts: ['X draft'],
            linkedinPosts: ['LinkedIn draft'],
          };
        },
      },
      typefully: {
        async createSavedDraft() {
          throw new Error('Typefully failed private_url=https://typefully.com/?d=12345&a=188312 .tmp/typefully-export/all-drafts.json');
        },
      },
    });

    const body = await runMockTelegram('Draft Alexey posts about a new AI Engineering lesson');

    assert.strictEqual(body.reviewStatus, 'failed');
    assert.strictEqual(body.typefullyCalled, false);
    assert.strictEqual(body.job.status, 'failed');
    assert.match(body.job.lastError.summary, /redacted/);
    assert.ok(!JSON.stringify(body).includes('https://typefully.com/?d=12345'));
    assert.ok(!JSON.stringify(body).includes('.tmp/typefully-export'));
    assert.ok(!JSON.stringify(body).includes('all-drafts.json'));
  });

  it('rejects Telegram text that contains tokens without persisting the secret', async () => {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/assistant-social-drafts/mock-telegram',
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify(mockTelegram('Draft Alexey posts TELEGRAM_BOT_TOKEN=123456:ABC-private-token')),
    }, {});

    assert.strictEqual(res.statusCode, 400);
    assert.ok(!res.body.includes('123456:ABC-private-token'));
    assert.match(JSON.parse(res.body).error, /redacted|tokens|credentials/i);
  });

  it('sends Typefully a saved draft request without publish_at', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    process.env.TYPEFULLY_API_KEY = 'test-typefully-key';
    process.env.TYPEFULLY_BASE_URL = 'https://api.typefully.test/';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({
        id: 12345,
        status: 'draft',
        private_url: 'https://typefully.example/?d=12345&a=188312',
        share_url: null,
        preview: 'X draft',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await new FetchTypefullyDraftClient().createSavedDraft({
      socialSetId: 188312,
      platforms: ['x', 'linkedin'],
      draft: {
        draftTitle: 'Local verification draft',
        scratchpadText: 'For review only.',
        xPosts: ['X draft'],
        linkedinPosts: ['LinkedIn draft'],
      },
    });

    assert.strictEqual(result.id, '12345');
    assert.strictEqual(result.status, 'draft');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, 'https://api.typefully.test/v2/social-sets/188312/drafts');
    assert.strictEqual(requests[0].init.method, 'POST');
    assert.strictEqual((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer test-typefully-key');

    const payload = JSON.parse(String(requests[0].init.body));
    assert.strictEqual(payload.share, false);
    assert.strictEqual(payload.publish_at, undefined);
    assert.deepStrictEqual(payload.platforms.x.posts, [{ text: 'X draft' }]);
    assert.deepStrictEqual(payload.platforms.linkedin.posts, [{ text: 'LinkedIn draft' }]);
  });
});
