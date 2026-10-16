import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { TABLE_TASKS } from '../src/db/tableNames';
import { createCard, getCard } from '../src/db/cards';
import { createTask, getTask } from '../src/db/tasks';
import type { LambdaResponse } from '../src/types';

const OLD_DOC = 'sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners';
const NEW_DOC = 'sop.media.covers.create-an-event-cover';

function invoke(body: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: 'POST',
    path: '/api/admin/banner-id-migration',
    headers: { 'x-user-id': 'operator-banner-id-migration' },
    body: JSON.stringify(body),
  }, {});
}

describe('Banner id migration', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('renames Figma doc, step and resource ids and leaves history alone', async () => {
    const card = await createCard(client, {
      title: 'Podcast',
      anchorDate: '2026-09-01',
      sourceDocIds: [OLD_DOC],
      templateId: 'template-podcast',
      templateVersion: 1,
      selectedOptionalGroups: [],
      templateDefinitionSnapshot: {
        tags: [], sourceDocIds: [OLD_DOC, 'other'], references: [], cardLinkDefinitions: [], taskRefs: ['create-banner-figma', 'invite'],
      },
    });
    const task = await createTask(client, {
      cardId: card.id,
      description: 'Create a banner',
      date: '2026-08-14',
      status: 'done',
      templateTaskRef: 'create-banner-figma',
      instructionDocId: OLD_DOC,
      instructionsUrl: 'https://www.figma.com/design/example',
      requires: ['banner-generator'],
    });
    await client.send(new UpdateCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}` },
      UpdateExpression: 'SET templateDefinitionSnapshot = :snapshot',
      ExpressionAttributeValues: {
        ':snapshot': { description: 'Create a banner in Figma', date: '2026-08-14', templateOffsetDays: -18, templateTaskOrder: 3, requires: ['figma'], dependsOnRefs: ['create-banner-figma'] },
      },
    }));
    const untouched = await createTask(client, { cardId: card.id, description: 'Invite guest', date: '2026-08-01', status: 'todo' });

    const dry = await invoke({ apply: false });
    assert.equal(dry.statusCode, 200, dry.body);
    const plan = JSON.parse(dry.body);
    assert.equal(plan.cardsToRewrite, 1);
    assert.equal(plan.tasksToRewrite, 1);
    assert.deepEqual(plan.remainingFigmaMentions, {
      'task.instructionsUrl': 1,
      'task.templateDefinitionSnapshot.description': 1,
    });
    assert.equal((await getTask(client, task.id))?.templateTaskRef, 'create-banner-figma', 'dry run writes nothing');

    const applied = await invoke({ apply: true });
    assert.equal(applied.statusCode, 200, applied.body);

    const migratedCard = await getCard(client, card.id);
    assert.deepEqual(migratedCard?.sourceDocIds, [NEW_DOC]);
    assert.deepEqual(migratedCard?.templateDefinitionSnapshot.sourceDocIds, [NEW_DOC, 'other']);
    assert.deepEqual(migratedCard?.templateDefinitionSnapshot.taskRefs, ['create-banner', 'invite']);

    const migratedTask = await getTask(client, task.id);
    assert.equal(migratedTask?.templateTaskRef, 'create-banner');
    assert.equal(migratedTask?.instructionDocId, NEW_DOC);
    assert.equal(migratedTask?.instructionsUrl, 'https://www.figma.com/design/example');
    assert.deepEqual(migratedTask?.templateDefinitionSnapshot?.requires, ['banner-generator']);
    assert.deepEqual(migratedTask?.templateDefinitionSnapshot?.dependsOnRefs, ['create-banner']);
    assert.equal(migratedTask?.templateDefinitionSnapshot?.description, 'Create a banner in Figma');
    assert.equal(migratedTask?.version, task.version + 1);
    assert.deepEqual(await getTask(client, untouched.id), untouched);

    const again = JSON.parse((await invoke({ apply: false })).body);
    assert.equal(again.cardsToRewrite + again.tasksToRewrite, 0, 'the migration is idempotent');
  });
});
