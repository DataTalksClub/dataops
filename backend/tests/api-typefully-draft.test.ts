import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';
import { setTypefullyDraftClient } from '../src/routes/assistantJobs';
import {
  DEFAULT_TYPEFULLY_BASE_URL,
  FakeTypefullyDraftClient,
  FetchTypefullyDraftClient,
  TypefullyRequestError,
  buildCreateDraftRequest,
  isPublishAtAttempt,
  resetTypefullyCredentialCache,
  type TypefullyClientError,
  type TypefullySavedDraftInput,
} from '../src/assistant/typefullyClient';
import type { GeneratedSocialDraft } from '../src/assistant/socialDraftAssistant';

describe('API - Typefully saved draft creation', () => {
  let handler: typeof import('../src/handler').handler;
  const originalFetch = globalThis.fetch;

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.SKIP_AUTH = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  afterEach(() => {
    setTypefullyDraftClient(null);
    globalThis.fetch = originalFetch;
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_BASE_URL;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.SKIP_AUTH;
  });

  async function createTask(): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Typefully task', date: '2026-07-01' }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body);
  }

  async function createBundle(): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/bundles',
      body: JSON.stringify({ title: 'Typefully bundle', anchorDate: '2026-07-01' }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).bundle;
  }

  // Create an assistant job and move it to a ready status for Typefully writes.
  async function createJobInStatus(
    status: 'waiting_approval' | 'approved' | 'succeeded',
    overrides: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const task = await createTask();
    const bundle = await createBundle();
    const create = await handler({
      httpMethod: 'POST',
      path: '/api/assistant-jobs',
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify({
        assistantType: 'social-draft',
        title: 'Social draft job',
        taskId: task.id,
        bundleId: bundle.id,
        approvalRequired: true,
        ...overrides,
      }),
    }, {});
    assert.strictEqual(create.statusCode, 201, create.body);
    const job = JSON.parse(create.body).job;

    await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running' }),
    }, {});

    if (status === 'waiting_approval') {
      await handler({
        httpMethod: 'POST',
        path: `/api/assistant-jobs/${job.id}/transition`,
        body: JSON.stringify({ status: 'waiting_approval' }),
      }, {});
      return job;
    }
    if (status === 'approved') {
      await handler({
        httpMethod: 'POST',
        path: `/api/assistant-jobs/${job.id}/transition`,
        body: JSON.stringify({ status: 'waiting_approval' }),
      }, {});
      const approve = await handler({
        httpMethod: 'POST',
        path: `/api/assistant-jobs/${job.id}/approve`,
        headers: { 'x-user-id': 'reviewer-1' },
      }, {});
      return JSON.parse(approve.body).job;
    }
    // succeeded: approval not required path
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'succeeded' }),
    }, {});
    return job;
  }

  function draftRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      socialSetId: 188312,
      platforms: ['x', 'linkedin'],
      draftTitle: 'AI agents workshop',
      xPosts: ['Join our AI agents workshop next week'],
      linkedinPosts: ['A practical deep-dive into building AI agents end to end.'],
      ...overrides,
    };
  }

  async function callTypefullyDraft(jobId: string, body: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${jobId}/typefully-draft`,
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify(body),
    }, {});
    return { statusCode: res.statusCode, body: JSON.parse(res.body) };
  }

  it('creates a saved Typefully draft and stores a linked proof artifact with safe identifiers', async () => {
    const fake = new FakeTypefullyDraftClient({
      result: {
        id: 'tf-98765',
        status: 'draft',
        privateUrl: 'https://typefully.example/draft/tf-98765',
        shareUrl: null,
        socialSetId: 188312,
        platforms: ['x', 'linkedin'],
        preview: 'Join our AI agents workshop next week',
      },
    });
    setTypefullyDraftClient(fake);

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 201, JSON.stringify(body));
    assert.strictEqual(body.typefully.id, 'tf-98765');
    assert.strictEqual(body.typefully.status, 'draft');
    assert.strictEqual(body.typefully.privateUrl, 'https://typefully.example/draft/tf-98765');

    const artifact = body.artifact as Record<string, unknown>;
    assert.strictEqual(artifact.status, 'needs-review');
    assert.strictEqual(artifact.storageProvider, 'external-url');
    assert.strictEqual(artifact.storageUri, 'https://typefully.example/draft/tf-98765');

    const meta = artifact.metadata as Record<string, unknown>;
    assert.strictEqual(meta.integration, 'typefully');
    const tf = meta.typefully as Record<string, unknown>;
    assert.strictEqual(tf.draft_id, 'tf-98765');
    assert.strictEqual(tf.status, 'draft');
    assert.strictEqual(tf.social_set_id, 188312);
    assert.deepStrictEqual(tf.platforms, ['x', 'linkedin']);
    assert.strictEqual(meta.originating_job_id, job.id);
    assert.strictEqual(meta.publish_at_sent, false);

    assert.strictEqual(fake.callCount(), 1);
    const recorded = fake.recordedCalls()[0];
    assert.strictEqual(recorded.socialSetId, 188312);
    assert.deepStrictEqual(recorded.platforms, ['x', 'linkedin']);
  });

  it('never sends publish_at in the Typefully request body', async () => {
    const fake = new FakeTypefullyDraftClient();
    setTypefullyDraftClient(fake);

    const job = await createJobInStatus('waiting_approval');
    await callTypefullyDraft(job.id, draftRequest());

    const recorded = fake.recordedCalls()[0];
    const requestJson = JSON.stringify(recorded);
    assert.ok(!requestJson.includes('publish_at'), 'publish_at must never be sent to Typefully');
  });

  it('rejects publish_at: now before any Typefully client call', async () => {
    const fake = new FakeTypefullyDraftClient();
    setTypefullyDraftClient(fake);

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest({ publish_at: 'now' }));

    assert.strictEqual(statusCode, 400);
    assert.match(body.error as string, /publish_at is not allowed/i);
    assert.strictEqual(fake.callCount(), 0, 'client must not be called when publish_at is rejected');
  });

  it('rejects publish_at: next-free-slot before any client call', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest({ publish_at: 'next-free-slot' }));

    assert.strictEqual(statusCode, 400);
    assert.match(body.error as string, /publish_at is not allowed/i);
  });

  it('rejects publish_at as an ISO datetime before any client call', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest({ publish_at: '2026-12-25T09:00:00Z' }));

    assert.strictEqual(statusCode, 400);
    assert.match(body.error as string, /publish_at is not allowed/i);
  });

  it('blocks Typefully draft creation for unreviewed jobs', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const task = await createTask();
    const create = await handler({
      httpMethod: 'POST',
      path: '/api/assistant-jobs',
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify({ assistantType: 'social-draft', title: 'Draft job', taskId: task.id, approvalRequired: true }),
    }, {});
    const job = JSON.parse(create.body).job;

    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());
    assert.strictEqual(statusCode, 409);
    assert.match(body.error as string, /reviewed jobs/i);
  });

  it('marks the job failed with a redacted error on Typefully 401', async () => {
    const error: TypefullyClientError = { code: 'unauthorized', summary: 'Typefully rejected the API token (401)', retryable: false };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    assert.strictEqual(body.code, 'unauthorized');
    const failedJob = body.job as Record<string, unknown>;
    assert.strictEqual(failedJob.status, 'failed');
    const lastError = failedJob.lastError as Record<string, unknown>;
    assert.strictEqual(lastError.code, 'unauthorized');
    assert.ok(!JSON.stringify(body).includes('Bearer'), 'no bearer header in response');
  });

  it('marks the job failed on Typefully 403', async () => {
    const error: TypefullyClientError = { code: 'forbidden', summary: 'Typefully denied access to this social set (403)', retryable: false };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    assert.strictEqual(body.code, 'forbidden');
    assert.strictEqual((body.job as Record<string, unknown>).status, 'failed');
  });

  it('marks the job failed on Typefully 422 with operator-readable message', async () => {
    const error: TypefullyClientError = { code: 'unprocessable', summary: 'social_set_id does not exist', retryable: false };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    assert.strictEqual(body.code, 'unprocessable');
    const lastError = (body.job as Record<string, unknown>).lastError as Record<string, unknown>;
    assert.match(lastError.summary as string, /social_set_id does not exist/);
  });

  it('marks the job retryable on Typefully 429', async () => {
    const error: TypefullyClientError = { code: 'rate-limited', summary: 'Typefully rate limit reached (429); retry later', retryable: true };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    assert.strictEqual(body.retryable, true);
    assert.strictEqual((body.job as Record<string, unknown>).status, 'retrying');
  });

  it('marks the job retryable on a network failure', async () => {
    const error: TypefullyClientError = { code: 'network-error', summary: 'Could not reach Typefully', retryable: true };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    assert.strictEqual(body.retryable, true);
    assert.strictEqual((body.job as Record<string, unknown>).status, 'retrying');
  });

  it('redacts credential fragments from failure summaries and never persists them', async () => {
    const error: TypefullyClientError = {
      code: 'typefully-error',
      summary: 'failed with TYPEFULLY_API_KEY=sk-typefully-secret private_url=https://typefully.com/?d=12345 .tmp/typefully-export/all-drafts.json',
      retryable: false,
    };
    setTypefullyDraftClient(new FakeTypefullyDraftClient({ error }));

    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest());

    assert.strictEqual(statusCode, 502);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('sk-typefully-secret'), 'token must not leak into response');
    assert.ok(!serialized.includes('https://typefully.com/?d=12345'), 'private url must not leak');
    assert.ok(!serialized.includes('all-drafts.json'), 'export path must not leak');
    const lastError = (body.job as Record<string, unknown>).lastError as Record<string, unknown>;
    assert.match(lastError.summary as string, /redacted/i);
  });

  it('fails when socialSetId is missing or invalid', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');

    const noId = await callTypefullyDraft(job.id, draftRequest({ socialSetId: undefined }));
    assert.strictEqual(noId.statusCode, 400);
    assert.match(noId.body.error as string, /socialSetId/);

    const badId = await callTypefullyDraft(job.id, draftRequest({ socialSetId: 0 }));
    assert.strictEqual(badId.statusCode, 400);
  });

  it('fails when platform posts are empty', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');

    const empty = await callTypefullyDraft(job.id, draftRequest({ xPosts: [], linkedinPosts: [] }));
    assert.strictEqual(empty.statusCode, 400);
    assert.match(empty.body.error as string, /xPosts or linkedinPosts/i);
  });

  it('works for already-approved jobs and marks the proof artifact approved', async () => {
    const fake = new FakeTypefullyDraftClient({
      result: { id: 'tf-approved', status: 'draft', privateUrl: 'https://typefully.example/draft/tf-approved', shareUrl: null, socialSetId: 188312, platforms: ['x'], preview: 'preview' },
    });
    setTypefullyDraftClient(fake);

    const job = await createJobInStatus('approved');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest({ platforms: ['x'], linkedinPosts: [] }));

    assert.strictEqual(statusCode, 201, JSON.stringify(body));
    const artifact = body.artifact as Record<string, unknown>;
    assert.strictEqual(artifact.status, 'approved');
  });

  it('rejects request bodies that carry secret-like values', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');
    const { statusCode, body } = await callTypefullyDraft(job.id, draftRequest({ scratchpadText: 'token=sk-secret-leaked' }));

    assert.strictEqual(statusCode, 400);
    assert.match(body.error as string, /tokens or credentials/i);
    assert.ok(!JSON.stringify(body).includes('sk-secret-leaked'));
  });

  it('links the proof artifact to the originating task and bundle', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');
    await callTypefullyDraft(job.id, draftRequest());

    const task = await handler({ httpMethod: 'GET', path: `/api/tasks/${job.taskId}` }, {});
    const taskBody = JSON.parse(task.body);
    assert.ok(Array.isArray(taskBody.artifactRefs) && taskBody.artifactRefs.length > 0, 'task should reference the proof artifact');

    const bundle = await handler({ httpMethod: 'GET', path: `/api/bundles/${job.bundleId}` }, {});
    const bundleBody = JSON.parse(bundle.body).bundle;
    assert.ok(Array.isArray(bundleBody.artifactRefs) && bundleBody.artifactRefs.length > 0, 'bundle should reference the proof artifact');
  });

  it('exposes the Typefully draft proof in the job detail view', async () => {
    setTypefullyDraftClient(new FakeTypefullyDraftClient());
    const job = await createJobInStatus('waiting_approval');
    const created = await callTypefullyDraft(job.id, draftRequest());
    const proofId = (created.body.artifact as Record<string, unknown>).id;

    const detail = await handler({ httpMethod: 'GET', path: `/api/assistant-jobs/${job.id}` }, {});
    const detailBody = JSON.parse(detail.body);
    assert.ok(detailBody.artifacts.some((a: Record<string, unknown>) => a.id === proofId), 'proof artifact should be visible in job detail');
    const events = detailBody.events as Array<Record<string, unknown>>;
    assert.ok(events.some((e: Record<string, unknown>) => e.action === 'artifact-attached' && String(e.summary).includes('Typefully')));
  });
});

describe('Typefully client unit tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTypefullyCredentialCache();
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_API_KEY_SECRET_NAME;
    delete process.env.TYPEFULLY_BASE_URL;
  });

  it('DEFAULT_TYPEFULLY_BASE_URL is the production API', () => {
    assert.strictEqual(DEFAULT_TYPEFULLY_BASE_URL, 'https://api.typefully.com');
  });

  it('buildCreateDraftRequest omits publish_at and sets share false', () => {
    const draft: GeneratedSocialDraft = { draftTitle: 'T', xPosts: ['x post'], linkedinPosts: ['li post'] };
    const request = buildCreateDraftRequest(draft, ['x', 'linkedin']);
    assert.strictEqual(request.share, false);
    assert.ok(!('publish_at' in request));
    assert.strictEqual(request.platforms.x.enabled, true);
    assert.deepStrictEqual(request.platforms.x.posts, [{ text: 'x post' }]);
    assert.strictEqual(request.platforms.linkedin.enabled, true);
  });

  it('buildCreateDraftRequest throws publish-at-rejected when draft carries publish_at', () => {
    const draft = { xPosts: ['x'], linkedinPosts: [] } as unknown as GeneratedSocialDraft;
    assert.throws(
      () => buildCreateDraftRequest({ ...draft, publish_at: 'now' } as unknown as GeneratedSocialDraft, ['x']),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'publish-at-rejected'
    );
  });

  it('isPublishAtAttempt detects now, next-free-slot, and datetime', () => {
    assert.ok(isPublishAtAttempt({ publish_at: 'now' }));
    assert.ok(isPublishAtAttempt({ publish_at: 'next-free-slot' }));
    assert.ok(isPublishAtAttempt({ publish_at: '2026-12-25T09:00:00Z' }));
    assert.ok(!isPublishAtAttempt({ platforms: ['x'] }));
    assert.ok(!isPublishAtAttempt({ draft_title: 'hello' }));
  });

  it('isPublishAtAttempt detects publish_at nested in objects', () => {
    assert.ok(isPublishAtAttempt({ meta: { publish_at: 'now' } }));
    assert.ok(isPublishAtAttempt([{ publish_at: '2026-01-01T00:00:00Z' }]));
  });

  it('FetchTypefullyDraftClient throws missing-credentials without TYPEFULLY_API_KEY', async () => {
    delete process.env.TYPEFULLY_API_KEY;
    const draft: GeneratedSocialDraft = { xPosts: ['x'], linkedinPosts: [] };
    await assert.rejects(
      new FetchTypefullyDraftClient().createSavedDraft({ socialSetId: 1, draft, platforms: ['x'] }),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'missing-credentials'
    );
  });

  it('FetchTypefullyDraftClient sends a POST without publish_at and parses the response', async () => {
    process.env.TYPEFULLY_API_KEY = 'test-key';
    process.env.TYPEFULLY_BASE_URL = 'https://api.typefully.test/';
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({
        id: 555,
        status: 'draft',
        private_url: 'https://typefully.example/?d=555',
        share_url: null,
        preview: 'x post',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const result = await new FetchTypefullyDraftClient().createSavedDraft({
      socialSetId: 188312,
      platforms: ['x'],
      draft: { draftTitle: 'T', xPosts: ['x post'], linkedinPosts: [] },
    });

    assert.strictEqual(result.id, '555');
    assert.strictEqual(result.status, 'draft');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, 'https://api.typefully.test/v2/social-sets/188312/drafts');
    assert.strictEqual(requests[0].init.method, 'POST');
    assert.strictEqual((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const payload = JSON.parse(String(requests[0].init.body));
    assert.strictEqual(payload.share, false);
    assert.strictEqual(payload.publish_at, undefined);
    assert.strictEqual(payload.platforms.x.posts[0].text, 'x post');
  });

  it('FetchTypefullyDraftClient classifies 401 as unauthorized, non-retryable', async () => {
    process.env.TYPEFULLY_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 401 })) as typeof fetch;

    await assert.rejects(
      new FetchTypefullyDraftClient().createSavedDraft({ socialSetId: 1, platforms: ['x'], draft: { xPosts: ['x'], linkedinPosts: [] } }),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'unauthorized' && err.retryable === false && err.status === 401
    );
  });

  it('FetchTypefullyDraftClient classifies 429 as rate-limited, retryable', async () => {
    process.env.TYPEFULLY_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 429 })) as typeof fetch;

    await assert.rejects(
      new FetchTypefullyDraftClient().createSavedDraft({ socialSetId: 1, platforms: ['x'], draft: { xPosts: ['x'], linkedinPosts: [] } }),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'rate-limited' && err.retryable === true
    );
  });

  it('FetchTypefullyDraftClient classifies network failures as retryable with redacted message', async () => {
    process.env.TYPEFULLY_API_KEY = 'test-key';
    globalThis.fetch = (async () => { throw new TypeError('fetch failed with ECONNREFUSED'); }) as typeof fetch;

    await assert.rejects(
      new FetchTypefullyDraftClient().createSavedDraft({ socialSetId: 1, platforms: ['x'], draft: { xPosts: ['x'], linkedinPosts: [] } }),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'network-error' && err.retryable === true
    );
  });

  it('FakeTypefullyDraftClient records calls and enforces no publish_at', async () => {
    const fake = new FakeTypefullyDraftClient();
    const input: TypefullySavedDraftInput = { socialSetId: 1, platforms: ['x'], draft: { xPosts: ['x'], linkedinPosts: [] } };
    await fake.createSavedDraft(input);
    assert.strictEqual(fake.callCount(), 1);
    assert.deepStrictEqual(fake.recordedCalls()[0], input);

    await assert.rejects(
      fake.createSavedDraft({ ...input, draft: { ...input.draft, publish_at: 'now' } as unknown as GeneratedSocialDraft }),
      (err: unknown) => err instanceof TypefullyRequestError && err.code === 'publish-at-rejected'
    );
  });
});
