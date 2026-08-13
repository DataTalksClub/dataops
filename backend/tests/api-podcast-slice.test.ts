import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createFile } from '../src/db/files';
import { createTemplate } from '../src/db/templates';
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
    await createTemplate(client, {
      name: 'Synthetic operator workflow',
      type: 'synthetic-operator-workflow',
      emoji: '🧪',
      tags: ['Synthetic'],
      defaultAssigneeId: '00000000-0000-0000-0000-000000000001',
      phases: [
        { id: 'preparation', name: 'Preparation', stage: 'preparation' },
        { id: 'event', name: 'Synthetic event', stage: 'announced' },
      ],
      references: [],
      cardLinkDefinitions: [
        { name: 'Synthetic event' },
        { name: 'Synthetic document' },
        { name: 'Synthetic stream' },
      ],
      triggerType: 'manual',
      taskDefinitions: [
        {
          refId: 'create-event',
          description: 'Create the synthetic event',
          offsetDays: -2,
          requiredLinkName: 'Synthetic event',
          instructionDocId: 'sop.synthetic.create-event',
          phase: 'preparation',
          systems: ['synthetic-calendar'],
          validation: { operatorAction: 'Create a synthetic event' },
        },
        {
          refId: 'create-banner',
          description: 'Create the synthetic banner',
          offsetDays: -1,
          requiresFile: true,
          phase: 'preparation',
        },
        {
          refId: 'agree-on-date',
          description: 'Agree on the synthetic date',
          offsetDays: -3,
          phase: 'preparation',
        },
        {
          refId: 'create-document',
          description: 'Create the synthetic document',
          offsetDays: -2,
          requiredLinkName: 'Synthetic document',
          phase: 'preparation',
        },
        {
          refId: 'actual-event',
          description: 'Run the synthetic event',
          offsetDays: 0,
          isMilestone: true,
          stageOnComplete: 'after-event',
          requiredLinkName: 'Synthetic stream',
          phase: 'event',
        },
      ],
    });
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('starts and operates a workflow with proof, waiting, stage, and assistant output', async () => {
    const templatesResponse = await invoke('GET', '/api/templates');
    const workflowTemplate = parse(templatesResponse).templates.find(
      (template: { type?: string }) => template.type === 'synthetic-operator-workflow',
    );
    assert.ok(workflowTemplate, 'synthetic workflow template should exist');

    const start = await invoke('POST', '/api/cards', {
      title: 'Podcast: 2026-08-17 - Vector Search - Jane Guest',
      anchorDate: '2026-08-17',
      description: 'Guest: Jane Guest\nTopic: Vector Search\nSource note: referred by community',
      templateId: workflowTemplate.id,
    });
    assert.strictEqual(start.statusCode, 201, start.body);
    const started = parse(start);
    const card = started.card;
    const tasks = started.tasks as Task[];
    assert.strictEqual(card.stage, 'preparation');
    assert.strictEqual(card.status, 'active');
    assert.strictEqual(card.templateId, workflowTemplate.id);
    assert.ok(card.tags.includes('Synthetic'));
    assert.strictEqual(tasks.length, 5);
    assert.strictEqual(card.cardLinks.length, 3);
    assert.ok(card.cardLinks.some((link: any) => link.name === 'Synthetic document' && link.url === ''));

    const lumaTask = tasks.find((task) => task.templateTaskRef === 'create-event') as Task;
    assert.ok(lumaTask);
    assert.strictEqual(lumaTask.requiredLinkName, 'Synthetic event');
    assert.strictEqual(lumaTask.instructionDocId, 'sop.synthetic.create-event');
    assert.strictEqual(lumaTask.phase, 'preparation');
    assert.ok(lumaTask.systems?.includes('synthetic-calendar'));
    assert.strictEqual((lumaTask.validation as any).operatorAction, 'Create a synthetic event');

    const blockedLink = await invoke('PUT', `/api/tasks/${lumaTask.id}`, { status: 'done' });
    assert.strictEqual(blockedLink.statusCode, 400);
    assert.match(parse(blockedLink).error, /required link 'Synthetic event'/);
    const lumaUrl = 'https://lu.ma/vector-search';
    const savedLink = await invoke('PUT', `/api/tasks/${lumaTask.id}`, { link: lumaUrl });
    assert.strictEqual(savedLink.statusCode, 200, savedLink.body);
    const cardWithLuma = {
      cardLinks: card.cardLinks.map((link: any) => (
        link.name === 'Synthetic event' ? { name: link.name, url: lumaUrl } : link
      )),
    };
    const savedCardLink = await invoke('PUT', `/api/cards/${card.id}`, cardWithLuma);
    assert.strictEqual(savedCardLink.statusCode, 200, savedCardLink.body);

    const bannerTask = tasks.find((task) => task.templateTaskRef === 'create-banner') as Task;
    assert.ok(bannerTask);
    const blockedFile = await invoke('PUT', `/api/tasks/${bannerTask.id}`, { status: 'done' });
    assert.strictEqual(blockedFile.statusCode, 400);
    assert.match(parse(blockedFile).error, /required file/);
    await createFile(client, {
      taskId: bannerTask.id,
      cardId: card.id,
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

    const waitingTask = tasks.find((task) => task.templateTaskRef === 'agree-on-date') as Task;
    assert.ok(waitingTask);
    const missingWaitingNote = await invoke('PUT', `/api/tasks/${waitingTask.id}`, {
      status: 'waiting',
      waitingFor: 'Jane Guest',
      followUpAt: '2000-01-01',
    });
    assert.strictEqual(missingWaitingNote.statusCode, 400);
    assert.strictEqual(parse(missingWaitingNote).error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    const waiting = await invoke('POST', `/api/tasks/${waitingTask.id}/actions/mark-waiting`, {
      waitingFor: 'Jane Guest',
      channel: 'email',
      followUpAt: '2000-01-01',
      note: 'date confirmation',
    });
    assert.strictEqual(waiting.statusCode, 200, waiting.body);
    assert.strictEqual(parse(waiting).status, 'waiting');
    const notifications = await invoke('GET', '/api/notifications');
    assert.strictEqual(notifications.statusCode, 200, notifications.body);
    assert.ok(parse(notifications).notifications.some((notification: any) => (
      notification.type === 'follow-up-due' && notification.taskId === waitingTask.id && notification.cardId === card.id
    )));
    const responseReceived = await invoke('POST', `/api/tasks/${waitingTask.id}/actions/response-received`, {
      note: 'Jane replied with available dates',
    });
    assert.strictEqual(responseReceived.statusCode, 200, responseReceived.body);
    assert.strictEqual(parse(responseReceived).status, 'todo');
    const waitingAgain = await invoke('POST', `/api/tasks/${waitingTask.id}/actions/mark-waiting`, {
      waitingFor: 'Jane Guest',
      channel: 'email',
      followUpAt: '2026-06-29',
      note: 'Need final confirmation',
    });
    assert.strictEqual(waitingAgain.statusCode, 200, waitingAgain.body);
    const followUpSent = await invoke('POST', `/api/tasks/${waitingTask.id}/actions/follow-up-sent`, {
      channel: 'email',
      note: 'Sent final reminder',
      nextFollowUpAt: '2026-06-30',
    });
    assert.strictEqual(followUpSent.statusCode, 200, followUpSent.body);
    assert.strictEqual(parse(followUpSent).followUpAt, '2026-06-30');

    const docTask = tasks.find((task) => task.templateTaskRef === 'create-document') as Task;
    assert.ok(docTask);
    const jobCreate = await invoke('POST', '/api/assistant-jobs', {
      assistantType: 'podcast',
      title: 'Podcast assistant: Jane Guest prep',
      taskId: docTask.id,
      cardId: card.id,
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
    const cardAfterApproval = parse(await invoke('GET', `/api/cards/${card.id}`)).card;
    assert.ok(cardAfterApproval.cardLinks.some((link: any) => (
      link.name === 'Synthetic document' && link.url.startsWith('local-dev://assistant-jobs/')
    )));
    const doneDocTask = await invoke('PUT', `/api/tasks/${docTask.id}`, { status: 'done' });
    assert.strictEqual(doneDocTask.statusCode, 200, doneDocTask.body);

    const actualStream = tasks.find((task) => task.templateTaskRef === 'actual-event') as Task;
    assert.ok(actualStream);
    assert.strictEqual(actualStream.stageOnComplete, 'after-event');
    const streamUrl = 'https://youtube.com/watch?v=vector';
    const streamReady = await invoke('PUT', `/api/tasks/${actualStream.id}`, { link: streamUrl });
    assert.strictEqual(streamReady.statusCode, 200, streamReady.body);
    const cardBeforeStreamDone = parse(await invoke('GET', `/api/cards/${card.id}`)).card;
    const streamCardLinks = cardBeforeStreamDone.cardLinks.map((link: any) => (
      link.name === 'Synthetic stream' ? { name: link.name, url: streamUrl } : link
    ));
    const streamCardLinkReady = await invoke('PUT', `/api/cards/${card.id}`, { cardLinks: streamCardLinks });
    assert.strictEqual(streamCardLinkReady.statusCode, 200, streamCardLinkReady.body);
    const streamDone = await invoke('PUT', `/api/tasks/${actualStream.id}`, { status: 'done' });
    assert.strictEqual(streamDone.statusCode, 200, streamDone.body);
    const advancedCard = parse(await invoke('GET', `/api/cards/${card.id}`)).card;
    assert.strictEqual(advancedCard.stage, 'after-event');
  });
});
