import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBundle, getBundle } from '../src/db/bundles';
import { getIntakeItem } from '../src/db/intake';
import { getTask, createTask } from '../src/db/tasks';
import { createUser } from '../src/db/users';

describe('intake API', () => {
  let handler: typeof import('../src/handler').handler;

  async function request(method: string, path: string, body?: Record<string, unknown>, queryStringParameters?: Record<string, string>) {
    return await handler({
      httpMethod: method,
      path,
      headers: { 'x-user-id': 'operator-test' },
      body: body === undefined ? null : JSON.stringify(body),
      queryStringParameters,
    }, {});
  }

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    const client = await getClient();
    await createTables(client);
    handler = (await import('../src/handler')).handler;
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('creates, lists, and fetches a bounded manual intake item with links', async () => {
    const res = await request('POST', '/api/intake', {
      source: 'manual',
      title: 'Sponsor asks for invoice review',
      note: 'Please review invoice context https://example.com/invoice and do not store api_key=abc123',
      dataClass: 'private',
      tags: ['finance'],
      metadata: { source: 'operator' },
    });
    assert.strictEqual(res.statusCode, 201, res.body);
    const created = JSON.parse(res.body).item;
    assert.ok(created.id);
    assert.strictEqual(created.status, 'new');
    assert.strictEqual(created.source, 'manual');
    assert.strictEqual(created.dataClass, 'private');
    assert.match(created.summary, /\[redacted\]/);
    assert.strictEqual(created.linkRefs[0].normalizedUrl, 'https://example.com/invoice');

    const list = await request('GET', '/api/intake', undefined, { status: 'new', tag: 'finance' });
    assert.strictEqual(list.statusCode, 200);
    assert.ok(JSON.parse(list.body).items.some((item: any) => item.id === created.id));

    const detail = await request('GET', `/api/intake/${created.id}`);
    assert.strictEqual(detail.statusCode, 200);
    assert.strictEqual(JSON.parse(detail.body).item.title, 'Sponsor asks for invoice review');
  });

  it('rejects secret-bearing metadata and signed URLs', async () => {
    const secretMetadata = await request('POST', '/api/intake', {
      title: 'Bad metadata',
      note: 'Contains unsafe metadata',
      metadata: { apiKey: 'secret-value' },
    });
    assert.strictEqual(secretMetadata.statusCode, 400);
    assert.match(JSON.parse(secretMetadata.body).error, /metadata must not contain secrets/);

    const signedUrl = await request('POST', '/api/intake', {
      title: 'Bad URL',
      note: 'Contains signed URL',
      linkRefs: [{ url: 'https://example.com/file?X-Amz-Signature=abc' }],
    });
    assert.strictEqual(signedUrl.statusCode, 400);
    assert.match(JSON.parse(signedUrl.body).error, /signed URLs/);
  });

  it('attaches intake to tasks and bundles without copying raw content', async () => {
    const client = await getClient();
    const user = await createUser(client, { name: 'Intake Owner', email: 'intake-owner@example.com', passwordHash: 'x' });
    const bundle = await createBundle(client, { title: 'Inbox workflow', anchorDate: '2026-07-01', status: 'active' });
    const task = await createTask(client, {
      description: 'Existing workflow task',
      date: '2026-07-01',
      assigneeId: user.id,
      bundleId: bundle.id,
    });
    const created = JSON.parse((await request('POST', '/api/intake', {
      title: 'Attach this source',
      note: 'Large raw email body should stay in intake summary only',
      source: 'email',
      sourceMessageId: 'email-attach-1',
    })).body).item;

    const attach = await request('POST', `/api/intake/${created.id}/attach`, {
      taskIds: [task.id],
      bundleIds: [bundle.id],
    });
    assert.strictEqual(attach.statusCode, 200);
    const item = JSON.parse(attach.body).item;
    assert.strictEqual(item.status, 'attached');
    assert.deepStrictEqual(item.taskIds, [task.id]);
    assert.deepStrictEqual(item.bundleIds, [bundle.id]);

    const updatedTask = await getTask(client, task.id);
    const updatedBundle = await getBundle(client, bundle.id);
    assert.ok(updatedTask?.intakeRefs?.some((ref) => ref.intakeItemId === created.id));
    assert.ok(updatedBundle?.intakeRefs?.some((ref) => ref.intakeItemId === created.id));
    assert.strictEqual(updatedTask?.comment, undefined);
    assert.strictEqual(updatedBundle?.description, undefined);
  });

  it('converts intake to a task and prepares assistant input refs/job', async () => {
    const client = await getClient();
    const bundle = await createBundle(client, { title: 'Assistant intake workflow', anchorDate: '2026-07-02', tags: ['podcast'] });
    const created = JSON.parse((await request('POST', '/api/intake', {
      title: 'Podcast source material',
      note: 'Guest links https://example.com/guest',
      tags: ['podcast'],
      bundleIds: [bundle.id],
    })).body).item;

    const converted = await request('POST', `/api/intake/${created.id}/convert-task`, {
      date: '2026-07-02',
      bundleId: bundle.id,
    });
    assert.strictEqual(converted.statusCode, 201);
    const convertedBody = JSON.parse(converted.body);
    assert.strictEqual(convertedBody.item.status, 'converted');
    assert.ok(convertedBody.task.id);
    const task = await getTask(client, convertedBody.task.id);
    assert.strictEqual(task?.source, 'intake');
    assert.ok(task?.intakeRefs?.some((ref) => ref.intakeItemId === created.id));
    assert.strictEqual(task?.comment, undefined);

    const prepared = await request('POST', `/api/intake/${created.id}/prepare-assistant`, {
      assistantType: 'podcast',
      createJob: true,
      taskId: convertedBody.task.id,
      bundleId: bundle.id,
    });
    assert.strictEqual(prepared.statusCode, 200);
    const preparedBody = JSON.parse(prepared.body);
    assert.ok(preparedBody.assistantJobId);
    assert.ok(preparedBody.inputRefs.some((ref: any) => ref.type === 'source-message'));
    assert.ok(preparedBody.item.assistantJobIds.includes(preparedBody.assistantJobId));
  });

  it('requires reasons for duplicate, blocked, ignored, and archived states', async () => {
    const first = JSON.parse((await request('POST', '/api/intake', {
      title: 'Original request',
      note: 'Original',
    })).body).item;
    const duplicate = JSON.parse((await request('POST', '/api/intake', {
      title: 'Duplicate request',
      note: 'Same as original',
    })).body).item;

    const missingReason = await request('POST', `/api/intake/${duplicate.id}/mark-duplicate`, {
      duplicateOfIntakeItemId: first.id,
    });
    assert.strictEqual(missingReason.statusCode, 400);

    const marked = await request('POST', `/api/intake/${duplicate.id}/mark-duplicate`, {
      duplicateOfIntakeItemId: first.id,
      reason: 'Same upstream request',
    });
    assert.strictEqual(marked.statusCode, 200);
    assert.strictEqual(JSON.parse(marked.body).item.status, 'duplicate');

    const blocked = await request('POST', `/api/intake/${first.id}/block`, {
      reason: 'Waiting for requester',
      waitingFor: 'Requester',
      followUpAt: '2026-07-03',
    });
    assert.strictEqual(blocked.statusCode, 200);
    assert.strictEqual(JSON.parse(blocked.body).item.status, 'blocked');

    const ignoredNoReason = await request('POST', `/api/intake/${first.id}/ignore`, {});
    assert.strictEqual(ignoredNoReason.statusCode, 400);

    const archived = await request('POST', `/api/intake/${first.id}/archive`, { reason: 'No longer needed' });
    assert.strictEqual(archived.statusCode, 200);
    assert.strictEqual(JSON.parse(archived.body).item.status, 'archived');

    const persisted = await getIntakeItem(await getClient(), first.id);
    assert.ok(persisted?.history.some((event) => event.action === 'archived'));
  });

  it('requires a concrete follow-up path when blocking intake and exposes due standalone lookup', async () => {
    const due = JSON.parse((await request('POST', '/api/intake', {
      title: 'Due blocked intake',
      note: 'Needs a reply today',
    })).body).item;
    const future = JSON.parse((await request('POST', '/api/intake', {
      title: 'Future blocked intake',
      note: 'Needs a reply later',
    })).body).item;

    const missingPath = await request('POST', `/api/intake/${due.id}/block`, {
      reason: 'Waiting for guest',
    });
    assert.strictEqual(missingPath.statusCode, 400);
    assert.match(JSON.parse(missingPath.body).error, /waitingFor is required/);

    assert.strictEqual((await request('POST', `/api/intake/${due.id}/block`, {
      reason: 'Waiting for guest',
      waitingFor: 'Guest',
      followUpAt: '2026-06-28',
    })).statusCode, 200);
    assert.strictEqual((await request('POST', `/api/intake/${future.id}/block`, {
      reason: 'Waiting for sponsor',
      waitingFor: 'Sponsor',
      followUpAt: '2026-07-05',
    })).statusCode, 200);

    const dueList = await request('GET', '/api/intake', undefined, {
      status: 'blocked',
      standaloneOnly: 'true',
      dueFollowUpAt: '2026-06-28',
    });
    assert.strictEqual(dueList.statusCode, 200);
    const titles = JSON.parse(dueList.body).items.map((item: any) => item.title);
    assert.ok(titles.includes('Due blocked intake'));
    assert.ok(!titles.includes('Future blocked intake'));
  });

  it('converts and attaches blocked intake to waiting task follow-up flow', async () => {
    const client = await getClient();
    const blocked = JSON.parse((await request('POST', '/api/intake', {
      title: 'Long-lived sponsor reply',
      note: 'Sponsor needs repeated follow-up',
      tags: ['sponsor'],
    })).body).item;
    await request('POST', `/api/intake/${blocked.id}/block`, {
      reason: 'Waiting for sponsor assets',
      waitingFor: 'Sponsor',
      followUpAt: '2026-07-10',
    });

    const converted = await request('POST', `/api/intake/${blocked.id}/convert-task`, {
      date: '2026-07-08',
      note: 'Move repeated follow-up to task path',
    });
    assert.strictEqual(converted.statusCode, 201, converted.body);
    const convertedBody = JSON.parse(converted.body);
    const waitingTask = await getTask(client, convertedBody.task.id);
    assert.strictEqual(waitingTask?.status, 'waiting');
    assert.strictEqual(waitingTask?.waitingFor, 'Sponsor');
    assert.strictEqual(waitingTask?.followUpAt, '2026-07-10');
    assert.ok(waitingTask?.comment?.includes('Move repeated follow-up'));
    assert.ok(waitingTask?.intakeRefs?.some((ref) => ref.intakeItemId === blocked.id));
    assert.ok(waitingTask?.taskHistory?.some((event) => event.action === 'waiting-started'));

    const attachSource = JSON.parse((await request('POST', '/api/intake', {
      title: 'Attach blocked intake to task',
      note: 'Same sponsor follow-up',
    })).body).item;
    await request('POST', `/api/intake/${attachSource.id}/block`, {
      reason: 'Waiting for sponsor',
      waitingFor: 'Sponsor',
      followUpAt: '2026-07-11',
    });
    const task = await createTask(client, {
      description: 'Existing sponsor waiting task',
      date: '2026-07-08',
      status: 'waiting',
      waitingFor: 'Sponsor',
      followUpAt: '2026-07-11',
      comment: 'Existing wait',
    });
    const attach = await request('POST', `/api/intake/${attachSource.id}/attach`, {
      taskIds: [task.id],
      note: 'Attach source context',
    });
    assert.strictEqual(attach.statusCode, 200, attach.body);
    const attachedTask = await getTask(client, task.id);
    assert.ok(attachedTask?.intakeRefs?.some((ref) => ref.intakeItemId === attachSource.id));
    assert.ok(attachedTask?.comment?.includes('Attach source context'));
  });

  it('records standalone blocked intake follow-up outcomes', async () => {
    const created = JSON.parse((await request('POST', '/api/intake', {
      title: 'Standalone blocked intake',
      note: 'Needs a reply',
    })).body).item;
    await request('POST', `/api/intake/${created.id}/block`, {
      reason: 'Waiting for guest',
      waitingFor: 'Guest',
      followUpAt: '2026-06-28',
    });

    const sent = await request('POST', `/api/intake/${created.id}/follow-up-sent`, {
      note: 'Sent reminder',
      nextFollowUpAt: '2026-07-01',
      channel: 'email',
    });
    assert.strictEqual(sent.statusCode, 200, sent.body);
    assert.strictEqual(JSON.parse(sent.body).item.followUpAt, '2026-07-01');

    const response = await request('POST', `/api/intake/${created.id}/response-received`, {
      note: 'Guest replied',
    });
    assert.strictEqual(response.statusCode, 200, response.body);
    const item = JSON.parse(response.body).item;
    assert.strictEqual(item.status, 'triaged');
    assert.strictEqual(item.followUpAt, undefined);
    assert.ok(item.history.some((event: any) => event.action === 'follow-up-sent'));
    assert.ok(item.history.some((event: any) => event.action === 'response-received'));
  });
});
