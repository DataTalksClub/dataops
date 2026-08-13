import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables, TABLE_AUDIT_EVENTS } from '../scripts/local-dynamodb';
import { createCard, getCard } from '../src/db/cards';
import { createTask, getTask, listTasksByCard, updateTask } from '../src/db/tasks';
import { createTemplate, getTemplate, updateTemplate } from '../src/db/templates';
import type { LambdaResponse, Template } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    headers: { 'x-user-id': 'operator-template-review' },
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
}

function parsed(response: LambdaResponse): any {
  return JSON.parse(response.body);
}

async function createSourceTemplate(client: DynamoDBDocumentClient): Promise<Template> {
  return createTemplate(client, {
    name: 'Synthetic Event',
    type: `synthetic-event-${crypto.randomUUID()}`,
    sourceRevision: 'source-revision-1',
    tags: ['event'],
    sourceDocIds: ['process.synthetic-event'],
    references: [{ name: 'Process', url: '/content/process.synthetic-event' }],
    cardLinkDefinitions: [{ name: 'Registration' }, { name: 'Recording' }],
    defaultAssigneeId: 'operator-default',
    taskDefinitions: [
      {
        refId: 'announce',
        description: 'Announce synthetic event',
        offsetDays: -7,
        instructionDocId: 'process.synthetic-event',
      },
      {
        refId: 'host',
        description: 'Host synthetic event',
        offsetDays: 0,
        proofRequirement: { type: 'text' },
      },
      {
        refId: 'follow-up',
        description: 'Follow up synthetic event',
        offsetDays: 2,
      },
    ],
  });
}

async function createTemplateCard(template: Template, suffix: string) {
  const response = await invoke('POST', '/api/cards', {
    title: `Synthetic Card ${suffix}`,
    anchorDate: '2026-04-15',
    templateId: template.id,
  });
  assert.equal(response.statusCode, 201, response.body);
  return parsed(response);
}

async function advanceTemplate(client: DynamoDBDocumentClient, template: Template, revision: string): Promise<Template> {
  return (await updateTemplate(client, template.id, {
    sourceRevision: revision,
    cardLinkDefinitions: [{ name: 'Registration' }, { name: 'Slides' }],
    taskDefinitions: [
      {
        refId: 'host',
        description: 'Host revised synthetic event',
        offsetDays: 1,
        proofRequirement: { type: 'link' },
      },
      {
        refId: 'announce',
        description: 'Announce synthetic event',
        offsetDays: -7,
        instructionDocId: 'process.synthetic-event-revised',
      },
      {
        refId: 'publish',
        description: 'Publish synthetic recording',
        offsetDays: 3,
      },
    ],
  }))!;
}

describe('API — reviewed Card Template updates', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('previews and atomically applies a definition while retaining live work and audit privacy', async () => {
    const source = await createSourceTemplate(client);
    const created = await createTemplateCard(source, 'single');
    const cardId = created.card.id as string;
    const byRef = new Map(created.tasks.map((task: any) => [task.templateTaskRef, task]));
    const announce = byRef.get('announce') as any;
    const host = byRef.get('host') as any;
    const followUp = byRef.get('follow-up') as any;

    await updateTask(client, announce.id, {
      expectedVersion: announce.version,
      patch: {
        status: 'waiting',
        waitingFor: 'Synthetic private reply',
        comment: 'Synthetic private operator note',
        artifactRefs: [{ artifactId: 'artifact-synthetic-proof' }],
      },
    });
    await updateTask(client, host.id, {
      expectedVersion: host.version,
      patch: {
        status: 'done',
        completedBy: 'operator-template-review',
        completedAt: '2026-04-15T12:00:00.000Z',
        link: 'https://example.invalid/private-proof',
      },
    });
    await updateTask(client, followUp.id, {
      expectedVersion: followUp.version,
      patch: { waitingFor: 'Synthetic follow-up response' },
    });
    const linked = await invoke('PUT', `/api/cards/${cardId}`, {
      cardLinks: [
        { name: 'Registration', url: 'https://example.invalid/private-registration' },
        { name: 'Recording', url: '' },
        { name: 'Operator notes', url: 'https://example.invalid/private-notes' },
      ],
    });
    assert.equal(linked.statusCode, 200, linked.body);

    const target = await advanceTemplate(client, source, 'source-revision-2');
    const previewResponse = await invoke('GET', `/api/cards/${cardId}/template-update`);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = parsed(previewResponse).preview;
    assert.equal(preview.state, 'update-available');
    assert.equal(preview.targetTemplateVersion, target.version);
    assert.deepEqual(preview.counts, {
      cardFields: 1,
      added: 1,
      updated: 1,
      archived: 1,
      retainedCompleted: 1,
      reordered: 2,
      operatorOverrides: 1,
    });

    const applyResponse = await invoke('POST', `/api/cards/${cardId}/template-update`, {
      previewToken: preview.previewToken,
    });
    assert.equal(applyResponse.statusCode, 200, applyResponse.body);
    const applied = parsed(applyResponse);
    assert.equal(applied.applied, true);
    assert.equal(applied.idempotent, false);
    assert.equal(applied.card.templateVersion, target.version);
    assert.equal(applied.card.templateSourceRevision, 'source-revision-2');
    assert.deepEqual(applied.card.cardLinks, [
      { name: 'Registration', url: 'https://example.invalid/private-registration' },
      { name: 'Slides', url: '' },
      { name: 'Operator notes', url: 'https://example.invalid/private-notes' },
    ]);

    const storedTasks = await listTasksByCard(client, cardId);
    const storedByRef = new Map(storedTasks.map((task) => [task.templateTaskRef, task]));
    const updatedAnnounce = storedByRef.get('announce')!;
    assert.equal(updatedAnnounce.id, announce.id);
    assert.equal(updatedAnnounce.status, 'waiting');
    assert.equal(updatedAnnounce.waitingFor, 'Synthetic private reply');
    assert.equal(updatedAnnounce.comment, 'Synthetic private operator note');
    assert.deepEqual(updatedAnnounce.artifactRefs, [{ artifactId: 'artifact-synthetic-proof' }]);
    assert.equal(updatedAnnounce.instructionDocId, 'process.synthetic-event-revised');
    assert.equal(updatedAnnounce.templateVersion, target.version);

    const retainedHost = storedByRef.get('host')!;
    assert.equal(retainedHost.id, host.id);
    assert.equal(retainedHost.description, 'Host synthetic event');
    assert.equal(retainedHost.status, 'done');
    assert.equal(retainedHost.link, 'https://example.invalid/private-proof');
    assert.equal(retainedHost.templateRetiredReason, 'completed-modified');
    assert.equal(retainedHost.templateVersion, source.version);

    const archivedFollowUp = storedByRef.get('follow-up')!;
    assert.equal(archivedFollowUp.id, followUp.id);
    assert.equal(archivedFollowUp.status, 'archived');
    assert.equal(archivedFollowUp.waitingFor, 'Synthetic follow-up response');
    assert.equal(archivedFollowUp.templateRetiredReason, 'removed');
    assert.equal(storedByRef.get('publish')?.status, 'todo');

    const eventId = applied.auditEvent.id as string;
    const audit = await client.send(new GetCommand({
      TableName: TABLE_AUDIT_EVENTS,
      Key: { PK: `AUDIT_EVENT#${eventId}`, SK: `AUDIT_EVENT#${eventId}` },
    }));
    assert.equal(audit.Item?.actorId, 'operator-template-review');
    assert.equal(audit.Item?.sourceTemplateVersion, source.version);
    assert.equal(audit.Item?.targetTemplateVersion, target.version);
    const serializedAudit = JSON.stringify(audit.Item);
    for (const privateValue of [
      'Synthetic private operator note',
      'Synthetic private reply',
      'private-proof',
      'private-registration',
      'Host revised synthetic event',
    ]) assert.equal(serializedAudit.includes(privateValue), false);

    const retry = await invoke('POST', `/api/cards/${cardId}/template-update`, {
      previewToken: preview.previewToken,
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(parsed(retry).idempotent, true);
    assert.equal((await getCard(client, cardId))?.version, applied.card.version);
  });

  it('returns a no-write conflict for stale previews and succeeds after reload', async () => {
    const source = await createSourceTemplate(client);
    const created = await createTemplateCard(source, 'conflict');
    const cardId = created.card.id as string;
    const target = await advanceTemplate(client, source, 'source-revision-conflict');
    const preview = parsed(await invoke('GET', `/api/cards/${cardId}/template-update`)).preview;
    const beforeCard = await getCard(client, cardId);
    const announce = (await listTasksByCard(client, cardId)).find(({ templateTaskRef }) => templateTaskRef === 'announce')!;
    await updateTask(client, announce.id, {
      expectedVersion: announce.version,
      patch: { comment: 'Typed while preview was open' },
    });

    const stale = await invoke('POST', `/api/cards/${cardId}/template-update`, {
      previewToken: preview.previewToken,
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(parsed(stale).reloadLatest, true);
    assert.equal((await getCard(client, cardId))?.version, beforeCard?.version);
    assert.equal((await getTask(client, announce.id))?.templateVersion, source.version);

    const latest = parsed(await invoke('GET', `/api/cards/${cardId}/template-update`)).preview;
    assert.notEqual(latest.previewToken, preview.previewToken);
    const retried = await invoke('POST', `/api/cards/${cardId}/template-update`, {
      previewToken: latest.previewToken,
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(parsed(retried).card.templateVersion, target.version);
    const retainedInput = await getTask(client, announce.id);
    assert.equal(retainedInput?.comment, 'Typed while preview was open');
  });

  it('applies reviewed batches per Card and reports a partial conflict', async () => {
    const source = await createSourceTemplate(client);
    const first = await createTemplateCard(source, 'batch-one');
    const second = await createTemplateCard(source, 'batch-two');
    const target = await advanceTemplate(client, source, 'source-revision-batch');
    const previewResponse = await invoke('POST', '/api/cards/template-updates/preview', {
      cardIds: [first.card.id, second.card.id],
    });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const previews = parsed(previewResponse).results;
    const firstPreview = previews.find((result: any) => result.cardId === first.card.id).preview;
    const secondPreview = previews.find((result: any) => result.cardId === second.card.id).preview;
    const secondTask = (await listTasksByCard(client, second.card.id))[0];
    await updateTask(client, secondTask.id, {
      expectedVersion: secondTask.version,
      patch: { comment: 'Concurrent batch input' },
    });

    const applied = await invoke('POST', '/api/cards/template-updates/apply', {
      updates: [
        { cardId: first.card.id, previewToken: firstPreview.previewToken },
        { cardId: second.card.id, previewToken: secondPreview.previewToken },
      ],
    });
    assert.equal(applied.statusCode, 207, applied.body);
    const results = parsed(applied).results;
    assert.equal(results.find((result: any) => result.cardId === first.card.id).status, 'applied');
    const conflict = results.find((result: any) => result.cardId === second.card.id);
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.httpStatus, 409);
    assert.equal((await getCard(client, first.card.id))?.templateVersion, target.version);
    assert.equal((await getCard(client, second.card.id))?.templateVersion, source.version);
    assert.equal((await getTask(client, secondTask.id))?.comment, 'Concurrent batch input');
  });

  it('rolls back every Card, Task and audit write when an apply fails', async () => {
    const source = await createSourceTemplate(client);
    const created = await createTemplateCard(source, 'rollback');
    const cardId = created.card.id as string;
    await advanceTemplate(client, source, 'source-revision-rollback');
    const preview = parsed(await invoke('GET', `/api/cards/${cardId}/template-update`)).preview;
    const beforeCard = await getCard(client, cardId);
    const beforeTasks = (await listTasksByCard(client, cardId))
      .sort((left, right) => left.id.localeCompare(right.id));

    process.env.CARD_TEMPLATE_UPDATE_TEST_FAIL_AFTER = '2';
    try {
      const failed = await invoke('POST', `/api/cards/${cardId}/template-update`, {
        previewToken: preview.previewToken,
      });
      assert.equal(failed.statusCode, 500, failed.body);
    } finally {
      delete process.env.CARD_TEMPLATE_UPDATE_TEST_FAIL_AFTER;
    }

    assert.deepEqual(await getCard(client, cardId), beforeCard);
    assert.deepEqual(
      (await listTasksByCard(client, cardId)).sort((left, right) => left.id.localeCompare(right.id)),
      beforeTasks,
    );
    const retried = await invoke('POST', `/api/cards/${cardId}/template-update`, {
      previewToken: preview.previewToken,
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(parsed(retried).applied, true);
  });

  it('uses the reviewed flow to establish provenance for legacy Card/Task rows', async () => {
    const source = await createSourceTemplate(client);
    const card = await createCard(client, {
      title: 'Legacy synthetic Card',
      anchorDate: '2026-04-15',
      templateId: source.id,
      status: 'active',
    });
    const task = await createTask(client, {
      description: 'Legacy operator wording',
      date: '2026-04-08',
      status: 'todo',
      source: 'template',
      cardId: card.id,
      templateId: source.id,
      templateTaskRef: 'announce',
      comment: 'Legacy note survives',
    });

    const preview = parsed(await invoke('GET', `/api/cards/${card.id}/template-update`)).preview;
    assert.equal(preview.state, 'baseline-required');
    const response = await invoke('POST', `/api/cards/${card.id}/template-update`, {
      previewToken: preview.previewToken,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(parsed(response).card.templateVersion, source.version);
    const stored = await getTask(client, task.id);
    assert.equal(stored?.templateVersion, source.version);
    assert.equal(stored?.comment, 'Legacy note survives');
  });

  it('rejects invalid selections and Cards without a Template', async () => {
    const manual = await createCard(client, { title: 'Manual Card', anchorDate: '2026-01-01' });
    assert.equal((await invoke('GET', `/api/cards/${manual.id}/template-update`)).statusCode, 422);
    assert.equal((await invoke('POST', '/api/cards/template-updates/preview', { cardIds: [] })).statusCode, 400);
    assert.equal((await invoke('POST', '/api/cards/template-updates/apply', {
      updates: [{ cardId: manual.id, previewToken: 'not-a-digest' }],
    })).statusCode, 400);
    assert.ok(await getTemplate(client, (await createSourceTemplate(client)).id));
  });
});
