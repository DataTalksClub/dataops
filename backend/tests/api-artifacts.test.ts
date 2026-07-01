import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';

describe('API - Artifacts', () => {
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

  async function createTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Artifact task', date: '2026-06-28', ...body }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body);
  }

  async function createBundle(): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/bundles',
      body: JSON.stringify({ title: 'Artifact bundle', anchorDate: '2026-06-28' }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).bundle;
  }

  async function registerArtifact(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/artifacts',
      body: JSON.stringify({
        type: 'external-link',
        title: 'Published page',
        storageUri: 'https://example.com/page',
        storageProvider: 'external-url',
        dataClass: 'public',
        sourceType: 'manual-link',
        ...body,
      }),
    }, {});
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).artifact;
  }

  it('registers, lists, gets, updates, attaches, and archives artifact metadata', async () => {
    const task = await createTask({});
    const artifact = await registerArtifact({
      taskId: task.id,
      status: 'needs-review',
      metadata: { source: 'operator' },
      tags: ['podcast'],
    });

    assert.ok(artifact.id);
    assert.strictEqual(artifact.taskId, task.id);
    assert.strictEqual(artifact.status, 'needs-review');
    assert.strictEqual(artifact.storageUri, 'https://example.com/page');

    const listRes = await handler({
      httpMethod: 'GET',
      path: '/api/artifacts',
      queryStringParameters: { taskId: String(task.id), status: 'needs-review' },
    }, {});
    assert.strictEqual(listRes.statusCode, 200);
    const listed = JSON.parse(listRes.body).artifacts;
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, artifact.id);

    const getRes = await handler({ httpMethod: 'GET', path: `/api/artifacts/${artifact.id}` }, {});
    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(JSON.parse(getRes.body).artifact.title, 'Published page');

    const updateRes = await handler({
      httpMethod: 'PUT',
      path: `/api/artifacts/${artifact.id}`,
      headers: { 'x-user-id': 'reviewer-1' },
      body: JSON.stringify({ status: 'approved', reviewedBy: 'reviewer-1' }),
    }, {});
    assert.strictEqual(updateRes.statusCode, 200, updateRes.body);
    const updated = JSON.parse(updateRes.body).artifact;
    assert.strictEqual(updated.status, 'approved');
    assert.strictEqual(updated.reviewedBy, 'reviewer-1');
    assert.ok(updated.reviewedAt);

    const attachRes = await handler({
      httpMethod: 'PUT',
      path: `/api/artifacts/${artifact.id}/attach`,
      body: JSON.stringify({ taskId: task.id }),
    }, {});
    assert.strictEqual(attachRes.statusCode, 200, attachRes.body);

    const taskRes = await handler({ httpMethod: 'GET', path: `/api/tasks/${task.id}` }, {});
    const fetchedTask = JSON.parse(taskRes.body);
    assert.deepStrictEqual(fetchedTask.artifactRefs, [{
      artifactId: artifact.id,
      type: 'external-link',
      title: 'Published page',
      storageUri: 'https://example.com/page',
      status: 'approved',
    }]);

    const archiveRes = await handler({ httpMethod: 'PUT', path: `/api/artifacts/${artifact.id}/archive` }, {});
    assert.strictEqual(archiveRes.statusCode, 200);
    assert.strictEqual(JSON.parse(archiveRes.body).artifact.status, 'archived');
  });

  it('requires approved artifact proof before task completion', async () => {
    const task = await createTask({
      proofRequirement: { type: 'artifact', label: 'Reviewed draft' },
    });

    const noArtifactRes = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ status: 'done' }),
    }, {});
    assert.strictEqual(noArtifactRes.statusCode, 400);
    assert.match(JSON.parse(noArtifactRes.body).error, /approved artifact proof 'Reviewed draft' is missing/);

    const artifact = await registerArtifact({
      taskId: task.id,
      type: 'assistant-output',
      title: 'Assistant draft',
      status: 'needs-review',
      sourceType: 'assistant-output',
    });

    const draftRes = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ status: 'done' }),
    }, {});
    assert.strictEqual(draftRes.statusCode, 400);

    await handler({
      httpMethod: 'PUT',
      path: `/api/artifacts/${artifact.id}`,
      body: JSON.stringify({ status: 'approved', reviewedBy: 'ops-reviewer' }),
    }, {});

    const doneRes = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ status: 'done' }),
    }, {});
    assert.strictEqual(doneRes.statusCode, 200, doneRes.body);
    assert.strictEqual(JSON.parse(doneRes.body).status, 'done');
  });

  it('allows approved bundle artifacts to satisfy task artifact proof', async () => {
    const bundle = await createBundle();
    const task = await createTask({
      bundleId: bundle.id,
      proofRequirement: { type: 'artifact', label: 'Published artifact' },
    });
    await registerArtifact({
      bundleId: bundle.id,
      status: 'approved',
      reviewedBy: 'ops-reviewer',
    });

    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ status: 'done' }),
    }, {});

    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(JSON.parse(res.body).status, 'done');
  });

  it('keeps rejected and archived artifacts from satisfying proof', async () => {
    const task = await createTask({
      proofRequirement: { type: 'artifact', label: 'Accepted output' },
    });
    await registerArtifact({ taskId: task.id, status: 'rejected', reviewedBy: 'ops-reviewer' });
    await registerArtifact({ taskId: task.id, status: 'archived' });

    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ status: 'done' }),
    }, {});

    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /approved artifact proof 'Accepted output' is missing/);
  });

  it('rejects artifact records with signed URLs or secret-like metadata', async () => {
    const signedUrlRes = await handler({
      httpMethod: 'POST',
      path: '/api/artifacts',
      body: JSON.stringify({
        type: 'external-link',
        title: 'Signed URL',
        storageUri: 'https://example.com/file?X-Amz-Signature=abc',
        storageProvider: 'external-url',
      }),
    }, {});
    assert.strictEqual(signedUrlRes.statusCode, 400);
    assert.match(JSON.parse(signedUrlRes.body).error, /signed URL/);

    const metadataRes = await handler({
      httpMethod: 'POST',
      path: '/api/artifacts',
      body: JSON.stringify({
        type: 'external-link',
        title: 'Metadata token',
        storageUri: 'https://example.com/file',
        storageProvider: 'external-url',
        metadata: { accessToken: 'secret' },
      }),
    }, {});
    assert.strictEqual(metadataRes.statusCode, 400);
    assert.match(JSON.parse(metadataRes.body).error, /must not contain secrets/);
  });
});
