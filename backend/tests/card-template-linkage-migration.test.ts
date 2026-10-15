import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeleteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { TABLE_CARDS } from '../src/db/tableNames';
import { createCard, getCard } from '../src/db/cards';
import { createTask, getTask } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    headers: { 'x-user-id': 'operator-linkage-migration' },
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
}

describe('Card Template linkage migration', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('links title-tagged Cards and records task refs without touching Tasks', async () => {
    const template = await createTemplate(client, {
      name: 'Podcast',
      type: 'podcast',
      sourceRevision: 'rev-1',
      tags: ['podcast'],
      taskDefinitions: [
        { refId: 'invite', description: 'Invite guest', offsetDays: -10 },
        { refId: 'record', description: 'Record episode', offsetDays: 0 },
        { refId: 'sponsor-read', description: 'Record sponsor read', offsetDays: 0, optionalGroup: 'sponsored' },
      ],
    });
    const imported = await createCard(client, {
      title: '[Podcast] 2026-AUG-17 - Imported episode - Guest',
      anchorDate: '2026-08-17',
      tags: ['trello-label'],
    });
    const importedTask = await createTask(client, {
      cardId: imported.id,
      description: '[Checklist] Invite guest',
      date: '2026-08-07',
      status: 'todo',
      source: 'import',
      templateTaskRef: 'checklist-invite-guest-abc',
    });
    const created = await invoke('POST', '/api/cards', { title: 'Instantiated', anchorDate: '2026-09-01', templateId: template.id });
    assert.equal(created.statusCode, 201, created.body);
    const instantiatedId = JSON.parse(created.body).card.id;
    // Cards instantiated before snapshots recorded task refs.
    await client.send(new UpdateCommand({
      TableName: TABLE_CARDS,
      Key: { PK: `CARD#${instantiatedId}`, SK: `CARD#${instantiatedId}` },
      UpdateExpression: 'REMOVE templateDefinitionSnapshot.taskRefs, selectedOptionalGroups',
    }));
    const untagged = await createCard(client, { title: 'No tag at all', anchorDate: '2026-09-02' });

    const dry = await invoke('POST', '/api/admin/card-template-linkage', { apply: false });
    assert.equal(dry.statusCode, 200, dry.body);
    const plans = new Map(JSON.parse(dry.body).plans.map((plan: any) => [plan.cardId, plan]));
    assert.equal((plans.get(imported.id) as any).action, 'link-to-template');
    assert.equal((plans.get(untagged.id) as any).action, 'unmapped');
    assert.equal((plans.get(instantiatedId) as any).action, 'record-task-refs');
    assert.equal((await getCard(client, imported.id))?.templateId, undefined, 'dry run writes nothing');

    const refused = await invoke('POST', '/api/admin/card-template-linkage', { apply: true });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal((await getCard(client, imported.id))?.templateId, undefined, 'an unmapped Card blocks every write');

    // The operator resolves the unmapped Card, here by deleting it.
    await client.send(new DeleteCommand({ TableName: TABLE_CARDS, Key: { PK: `CARD#${untagged.id}`, SK: `CARD#${untagged.id}` } }));
    assert.equal(await getCard(client, untagged.id), null);

    const beforeApply = await getCard(client, imported.id);
    const applied = await invoke('POST', '/api/admin/card-template-linkage', { apply: true });
    assert.equal(applied.statusCode, 200, applied.body);

    const linked = await getCard(client, imported.id);
    assert.equal(linked?.templateId, template.id);
    assert.equal(linked?.templateVersion, template.version);
    assert.equal(linked?.templateSourceRevision, 'rev-1');
    assert.deepEqual(linked?.selectedOptionalGroups, []);
    assert.deepEqual(linked?.templateDefinitionSnapshot?.taskRefs, ['invite', 'record']);
    assert.deepEqual(linked?.tags, ['trello-label'], 'Card content is unchanged');
    assert.equal(linked?.version, beforeApply!.version + 1);
    assert.deepEqual(await getTask(client, importedTask.id), importedTask, 'imported Tasks are unchanged');

    const instantiated = await getCard(client, instantiatedId);
    assert.deepEqual(instantiated?.templateDefinitionSnapshot?.taskRefs, ['invite', 'record']);
    assert.deepEqual(instantiated?.selectedOptionalGroups, []);

    const again = await invoke('POST', '/api/admin/card-template-linkage', { apply: true });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(JSON.parse(again.body).results.length, 0, 'a second run has nothing to write');
  });
});
