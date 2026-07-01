import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';

describe('API - Assistant jobs', () => {
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function createBundle(): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/bundles',
      body: JSON.stringify({ title: 'Assistant bundle', anchorDate: '2026-06-28' }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).bundle;
  }

  async function createTask(bundleId?: string): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Assistant task', date: '2026-06-28', bundleId }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body);
  }

  async function createAssistantJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/assistant-jobs',
      headers: { 'x-user-id': 'operator-1' },
      body: JSON.stringify({
        assistantType: 'podcast',
        title: 'Podcast prep',
        inputRefs: [{ type: 'task', id: body.taskId || 'task-ref' }],
        ...body,
      }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).job;
  }

  async function createArtifact(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/artifacts',
      body: JSON.stringify({
        type: 'assistant-output',
        title: 'Assistant draft',
        storageUri: 'https://example.com/assistant-draft',
        storageProvider: 'external-url',
        dataClass: 'internal',
        sourceType: 'assistant-output',
        ...body,
      }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).artifact;
  }

  it('creates, submits, runs, attaches artifacts, and approves a workflow-linked job', async () => {
    const bundle = await createBundle();
    const task = await createTask(String(bundle.id));
    const job = await createAssistantJob({
      taskId: task.id,
      bundleId: bundle.id,
      approvalRequired: true,
      maxAttempts: 2,
    });

    assert.ok(job.id);
    assert.strictEqual(job.status, 'draft');
    assert.strictEqual(job.taskId, task.id);
    assert.strictEqual(job.bundleId, bundle.id);

    const taskWithRef = await handler({ httpMethod: 'GET', path: `/api/tasks/${task.id}` }, {});
    assert.deepStrictEqual(JSON.parse(taskWithRef.body).assistantJobRefs, [{
      assistantJobId: job.id,
      assistantType: 'podcast',
      status: 'draft',
    }]);

    const submit = await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    assert.strictEqual(submit.statusCode, 200, submit.body);
    assert.strictEqual(JSON.parse(submit.body).job.status, 'queued');

    const running = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running', metadata: { runner: 'test' } }),
    }, {});
    assert.strictEqual(running.statusCode, 200, running.body);

    const artifact = await createArtifact({ taskId: task.id, bundleId: bundle.id });
    const attach = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/artifacts`,
      body: JSON.stringify({ artifactId: artifact.id }),
    }, {});
    assert.strictEqual(attach.statusCode, 200, attach.body);
    assert.deepStrictEqual(JSON.parse(attach.body).job.outputArtifactIds, [artifact.id]);

    const wait = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'waiting_approval', outputArtifactIds: [artifact.id] }),
    }, {});
    assert.strictEqual(wait.statusCode, 200, wait.body);
    assert.strictEqual(JSON.parse(wait.body).job.status, 'waiting_approval');

    const approve = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/approve`,
      headers: { 'x-user-id': 'reviewer-1' },
    }, {});
    assert.strictEqual(approve.statusCode, 200, approve.body);
    const approved = JSON.parse(approve.body).job;
    assert.strictEqual(approved.status, 'approved');
    assert.strictEqual(approved.approval.status, 'approved');
    assert.strictEqual(approved.approval.decidedBy, 'reviewer-1');

    const detail = await handler({ httpMethod: 'GET', path: `/api/assistant-jobs/${job.id}` }, {});
    assert.strictEqual(detail.statusCode, 200, detail.body);
    const detailBody = JSON.parse(detail.body);
    assert.ok(detailBody.events.some((event: Record<string, unknown>) => event.action === 'approved'));
    assert.strictEqual(detailBody.artifacts[0].id, artifact.id);
  });

  it('blocks invalid transitions, invalid approval, and approval-required succeeded jumps', async () => {
    const task = await createTask();
    const job = await createAssistantJob({ taskId: task.id, approvalRequired: true });

    const badApproval = await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/approve` }, {});
    assert.strictEqual(badApproval.statusCode, 400);
    assert.match(JSON.parse(badApproval.body).error, /waiting_approval/);

    await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running' }),
    }, {});

    const succeeded = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'succeeded' }),
    }, {});
    assert.strictEqual(succeeded.statusCode, 400);
    assert.match(JSON.parse(succeeded.body).error, /Approval-required/);

    const unknown = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'unknown' }),
    }, {});
    assert.strictEqual(unknown.statusCode, 400);
    assert.match(JSON.parse(unknown.body).error, /Unknown/);
  });

  it('preserves rejection reason and enforces retry limits', async () => {
    const task = await createTask();
    const job = await createAssistantJob({ taskId: task.id, approvalRequired: true, maxAttempts: 1 });
    await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running' }),
    }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'waiting_approval' }),
    }, {});

    const reject = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/reject`,
      headers: { 'x-user-id': 'reviewer-1' },
      body: JSON.stringify({ reason: 'Needs a clearer guest framing.' }),
    }, {});
    assert.strictEqual(reject.statusCode, 200, reject.body);
    assert.strictEqual(JSON.parse(reject.body).job.approval.reason, 'Needs a clearer guest framing.');

    const retry = await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/retry` }, {});
    assert.strictEqual(retry.statusCode, 400);
    assert.match(JSON.parse(retry.body).error, /retry limit/);
  });

  it('blocks retry limit bypass through direct transition to retrying', async () => {
    const task = await createTask();
    const job = await createAssistantJob({ taskId: task.id, approvalRequired: false, maxAttempts: 1 });
    await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running' }),
    }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'failed', error: { code: 'runner', summary: 'Fixture failure' } }),
    }, {});

    const retry = await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/retry` }, {});
    assert.strictEqual(retry.statusCode, 400);
    assert.match(JSON.parse(retry.body).error, /retry limit/);

    const retryOverride = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/retry`,
      body: JSON.stringify({ override: true }),
    }, {});
    assert.strictEqual(retryOverride.statusCode, 400);
    assert.match(JSON.parse(retryOverride.body).error, /override is not supported/);

    const transitionRetry = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'retrying' }),
    }, {});
    assert.strictEqual(transitionRetry.statusCode, 400);
    assert.match(JSON.parse(transitionRetry.body).error, /retry limit/);

    const transitionRetryOverride = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'retrying', override: true }),
    }, {});
    assert.strictEqual(transitionRetryOverride.statusCode, 400);
    assert.match(JSON.parse(transitionRetryOverride.body).error, /override is not supported/);

    const detail = await handler({ httpMethod: 'GET', path: `/api/assistant-jobs/${job.id}` }, {});
    assert.strictEqual(detail.statusCode, 200, detail.body);
    const detailBody = JSON.parse(detail.body);
    assert.strictEqual(detailBody.job.status, 'failed');
    assert.strictEqual(detailBody.job.attemptCount, 1);
    assert.ok(!detailBody.events.some((event: Record<string, unknown>) => event.action === 'retry-requested'));
  });

  it('redacts detectable secrets in errors and rejects secret-like logs', async () => {
    const task = await createTask();
    const job = await createAssistantJob({ taskId: task.id, approvalRequired: false });
    await handler({ httpMethod: 'POST', path: `/api/assistant-jobs/${job.id}/submit` }, {});
    await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'running' }),
    }, {});

    const failed = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/transition`,
      body: JSON.stringify({ status: 'failed', error: { code: 'runner', summary: 'token=abc123 leaked' } }),
    }, {});
    assert.strictEqual(failed.statusCode, 200, failed.body);
    assert.match(JSON.parse(failed.body).job.lastError.summary, /redacted/);

    const log = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/events`,
      body: JSON.stringify({ action: 'log-appended', summary: 'Bearer abc123' }),
    }, {});
    assert.strictEqual(log.statusCode, 400);
    assert.match(JSON.parse(log.body).error, /secrets/);
  });

  it('runs the deterministic podcast dry-run path without external credentials', async () => {
    const bundle = await createBundle();
    const task = await createTask(String(bundle.id));
    const job = await createAssistantJob({
      taskId: task.id,
      bundleId: bundle.id,
      approvalRequired: true,
      inputRefs: [{ type: 'url', uri: 'https://example.com/guest' }],
    });

    const dryRun = await handler({
      httpMethod: 'POST',
      path: `/api/assistant-jobs/${job.id}/run-dry`,
      headers: { 'x-user-id': 'operator-1' },
    }, {});
    assert.strictEqual(dryRun.statusCode, 200, dryRun.body);
    const body = JSON.parse(dryRun.body);
    assert.strictEqual(body.job.status, 'waiting_approval');
    assert.strictEqual(body.artifact.type, 'assistant-output');
    assert.match(body.artifact.storageUri, /^local-dev:\/\/assistant-jobs\//);
    assert.strictEqual(body.artifact.metadata.runner, 'podcast-dry-run');

    const fetchedTask = await handler({ httpMethod: 'GET', path: `/api/tasks/${task.id}` }, {});
    assert.strictEqual(JSON.parse(fetchedTask.body).artifactRefs[0].artifactId, body.artifact.id);
  });
});
