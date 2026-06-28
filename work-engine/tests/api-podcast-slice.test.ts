import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createFile } from '../src/db/files';
import { listTemplates } from '../src/db/templates';
import { seed } from '../scripts/seed-templates';
import type { LambdaResponse, Task } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    body: body !== undefined ? JSON.stringify(body) : null,
  }, {}) as Promise<LambdaResponse>;
}

function parse(res: LambdaResponse): any {
  return JSON.parse(res.body);
}

describe('API - Podcast end-to-end operator slice (#9)', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    process.env.IS_LOCAL = 'true';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await seed(true);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('starts and operates a Podcast workflow with proof, waiting, stage, and assistant output', async () => {
    const templates = await listTemplates(client);
    const podcastTemplate = templates.find((template) => template.type === 'podcast');
    assert.ok(podcastTemplate, 'seeded Podcast template should exist');

    const start = await invoke('POST', '/api/bundles', {
      title: 'Podcast: 2026-08-17 - Vector Search - Jane Guest',
      anchorDate: '2026-08-17',
      description: 'Guest: Jane Guest\nTopic: Vector Search\nSource note: referred by community',
      templateId: podcastTemplate.id,
    });
    assert.strictEqual(start.statusCode, 201, start.body);
    const started = parse(start);
    const bundle = started.bundle;
    const tasks = started.tasks as Task[];
    assert.strictEqual(bundle.stage, 'preparation');
    assert.strictEqual(bundle.status, 'active');
    assert.strictEqual(bundle.templateId, podcastTemplate.id);
    assert.ok(bundle.tags.includes('Podcast'));
    assert.strictEqual(tasks.length, 42);
    assert.strictEqual(bundle.bundleLinks.length, 12);
    assert.ok(bundle.bundleLinks.some((link: any) => link.name === 'Podcast document' && link.url === ''));

    const lumaTask = tasks.find((task) => task.templateTaskRef === 'create-event-luma') as Task;
    assert.ok(lumaTask);
    assert.strictEqual(lumaTask.requiredLinkName, 'Luma');
    assert.strictEqual(lumaTask.instructionDocId, 'sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma');
    assert.strictEqual(lumaTask.phase, 'event-setup');
    assert.ok(lumaTask.systems?.includes('luma'));
    assert.strictEqual((lumaTask.validation as any).operatorAction, 'Create an event in Luma');

    const blockedLink = await invoke('PUT', `/api/tasks/${lumaTask.id}`, { status: 'done' });
    assert.strictEqual(blockedLink.statusCode, 400);
    assert.match(parse(blockedLink).error, /required link 'Luma'/);
    const lumaUrl = 'https://lu.ma/vector-search';
    const savedLink = await invoke('PUT', `/api/tasks/${lumaTask.id}`, { link: lumaUrl });
    assert.strictEqual(savedLink.statusCode, 200, savedLink.body);
    const bundleWithLuma = {
      bundleLinks: bundle.bundleLinks.map((link: any) => (
        link.name === 'Luma' ? { name: link.name, url: lumaUrl } : link
      )),
    };
    const savedBundleLink = await invoke('PUT', `/api/bundles/${bundle.id}`, bundleWithLuma);
    assert.strictEqual(savedBundleLink.statusCode, 200, savedBundleLink.body);

    const bannerTask = tasks.find((task) => task.templateTaskRef === 'create-banner-figma') as Task;
    assert.ok(bannerTask);
    const blockedFile = await invoke('PUT', `/api/tasks/${bannerTask.id}`, { status: 'done' });
    assert.strictEqual(blockedFile.statusCode, 400);
    assert.match(parse(blockedFile).error, /required file/);
    await createFile(client, {
      taskId: bannerTask.id,
      bundleId: bundle.id,
      filename: 'podcast-banner.png',
      category: 'image',
      storagePath: '.tmp/podcast-banner.png',
      storageProvider: 'local-dev',
      storageUri: 'local-dev://podcast-banner.png',
      checksum: 'sha256:test',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const doneFile = await invoke('PUT', `/api/tasks/${bannerTask.id}`, { status: 'done' });
    assert.strictEqual(doneFile.statusCode, 200, doneFile.body);
    assert.strictEqual(parse(doneFile).status, 'done');

    const waitingTask = tasks.find((task) => task.templateTaskRef === 'agree-on-a-date') as Task;
    assert.ok(waitingTask);
    const missingWaitingNote = await invoke('PUT', `/api/tasks/${waitingTask.id}`, {
      status: 'waiting',
      waitingFor: 'Jane Guest',
      followUpAt: '2000-01-01',
    });
    assert.strictEqual(missingWaitingNote.statusCode, 400);
    assert.strictEqual(parse(missingWaitingNote).error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    const waiting = await invoke('PUT', `/api/tasks/${waitingTask.id}`, {
      status: 'waiting',
      waitingFor: 'Jane Guest',
      followUpAt: '2000-01-01',
      comment: '[2026-06-25T09:00:00.000Z] Waiting for Jane Guest: date confirmation',
    });
    assert.strictEqual(waiting.statusCode, 200, waiting.body);
    assert.strictEqual(parse(waiting).status, 'waiting');
    const notifications = await invoke('GET', '/api/notifications');
    assert.strictEqual(notifications.statusCode, 200, notifications.body);
    assert.ok(parse(notifications).notifications.some((notification: any) => (
      notification.type === 'follow-up-due' && notification.taskId === waitingTask.id && notification.bundleId === bundle.id
    )));
    const responseReceived = await invoke('PUT', `/api/tasks/${waitingTask.id}`, {
      status: 'todo',
      comment: '[2026-06-27T10:00:00.000Z] Response received',
    });
    assert.strictEqual(responseReceived.statusCode, 200, responseReceived.body);
    assert.strictEqual(parse(responseReceived).status, 'todo');
    const followUpSent = await invoke('PUT', `/api/tasks/${waitingTask.id}`, {
      status: 'waiting',
      waitingFor: 'Jane Guest',
      followUpAt: '2026-06-29',
      comment: '[2026-06-27T11:00:00.000Z] Follow-up sent; next follow-up 2026-06-29',
    });
    assert.strictEqual(followUpSent.statusCode, 200, followUpSent.body);
    assert.strictEqual(parse(followUpSent).followUpAt, '2026-06-29');

    const docTask = tasks.find((task) => task.templateTaskRef === 'create-podcast-document') as Task;
    assert.ok(docTask);
    const jobCreate = await invoke('POST', '/api/assistant-jobs', {
      assistantType: 'podcast',
      title: 'Podcast assistant: Jane Guest prep',
      taskId: docTask.id,
      bundleId: bundle.id,
      inputRefs: [{ type: 'url', uri: 'https://example.com/jane' }],
      approvalRequired: true,
    });
    assert.strictEqual(jobCreate.statusCode, 201, jobCreate.body);
    const job = parse(jobCreate).job;
    const dryRun = await invoke('POST', `/api/assistant-jobs/${job.id}/run-dry`);
    assert.strictEqual(dryRun.statusCode, 200, dryRun.body);
    assert.strictEqual(parse(dryRun).job.status, 'waiting_approval');
    const approve = await invoke('POST', `/api/assistant-jobs/${job.id}/approve`);
    assert.strictEqual(approve.statusCode, 200, approve.body);
    const docAfterApproval = await invoke('GET', `/api/tasks/${docTask.id}`);
    const approvedDocTask = parse(docAfterApproval);
    assert.ok(approvedDocTask.link.startsWith('local-dev://assistant-jobs/'));
    assert.ok(approvedDocTask.artifactRefs.some((ref: any) => ref.status === 'approved'));
    const bundleAfterApproval = parse(await invoke('GET', `/api/bundles/${bundle.id}`)).bundle;
    assert.ok(bundleAfterApproval.bundleLinks.some((link: any) => (
      link.name === 'Podcast document' && link.url.startsWith('local-dev://assistant-jobs/')
    )));
    const doneDocTask = await invoke('PUT', `/api/tasks/${docTask.id}`, { status: 'done' });
    assert.strictEqual(doneDocTask.statusCode, 200, doneDocTask.body);

    const actualStream = tasks.find((task) => task.templateTaskRef === 'actual-stream') as Task;
    assert.ok(actualStream);
    assert.strictEqual(actualStream.stageOnComplete, 'after-event');
    const streamUrl = 'https://youtube.com/watch?v=vector';
    const streamReady = await invoke('PUT', `/api/tasks/${actualStream.id}`, { link: streamUrl });
    assert.strictEqual(streamReady.statusCode, 200, streamReady.body);
    const bundleBeforeStreamDone = parse(await invoke('GET', `/api/bundles/${bundle.id}`)).bundle;
    const streamBundleLinks = bundleBeforeStreamDone.bundleLinks.map((link: any) => (
      link.name === 'YouTube stream/video' ? { name: link.name, url: streamUrl } : link
    ));
    const streamBundleLinkReady = await invoke('PUT', `/api/bundles/${bundle.id}`, { bundleLinks: streamBundleLinks });
    assert.strictEqual(streamBundleLinkReady.statusCode, 200, streamBundleLinkReady.body);
    const streamDone = await invoke('PUT', `/api/tasks/${actualStream.id}`, { status: 'done' });
    assert.strictEqual(streamDone.statusCode, 200, streamDone.body);
    const advancedBundle = parse(await invoke('GET', `/api/bundles/${bundle.id}`)).bundle;
    assert.strictEqual(advancedBundle.stage, 'after-event');
  });
});
