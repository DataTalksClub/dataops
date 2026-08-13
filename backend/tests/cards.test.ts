import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import {
  CardVersionConflictError,
  createCard,
  getCard,
  listCards,
  updateCard,
  updateCardAdditive,
} from '../src/db/cards';
import { TABLE_CARDS } from '../src/db/tableNames';

describe('Cards data layer', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(stopLocal);

  it('creates the strict canonical empty Card shape', async () => {
    const card = await createCard(client, {
      title: 'DataOps',
      anchorDate: '2026-09-01',
      description: 'Operations work',
      references: [{ name: 'Guide', url: 'https://example.com/guide' }],
      cardLinks: [{ name: 'Event', url: '' }],
      emoji: '📋',
      tags: ['operations'],
    });
    assert.ok(card.id);
    assert.deepEqual(
      {
        version: card.version,
        taskCount: card.taskCount,
        openTaskCount: card.openTaskCount,
        stage: card.stage,
        status: card.status,
      },
      { version: 1, taskCount: 0, openTaskCount: 0, stage: 'preparation', status: 'active' },
    );
    assert.equal(card.completedAt, undefined);
    assert.deepEqual(card.references, [{ name: 'Guide', url: 'https://example.com/guide' }]);
    assert.deepEqual(card.cardLinks, [{ name: 'Event', url: '' }]);
    assert.equal((card as unknown as Record<string, unknown>).PK, undefined);
  });

  it('reads, lists, and returns null for missing Cards', async () => {
    const created = await createCard(client, { title: 'Fetch', anchorDate: '2026-09-02' });
    assert.equal((await getCard(client, created.id))?.title, 'Fetch');
    assert.equal(await getCard(client, 'missing'), null);
    assert.ok((await listCards(client)).some(({ id }) => id === created.id));
  });

  it('updates caller-owned fields with an exact version condition', async () => {
    const created = await createCard(client, { title: 'Original', anchorDate: '2026-09-03' });
    const updated = await updateCard(client, created.id, {
      expectedVersion: created.version,
      patch: {
        title: 'Updated',
        stage: 'announced',
        references: [{ name: 'Runbook', url: 'https://example.com/runbook' }],
        cardLinks: [{ name: 'Event', url: 'https://example.com/event' }],
        emoji: '🎙️',
        tags: ['podcast'],
      },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.stage, 'announced');
    assert.deepEqual(updated.tags, ['podcast']);
  });

  it('returns one winner and rejects a stale direct Card mutation', async () => {
    const created = await createCard(client, { title: 'Race', anchorDate: '2026-09-04' });
    const results = await Promise.allSettled([
      updateCard(client, created.id, { expectedVersion: 1, patch: { title: 'First' } }),
      updateCard(client, created.id, { expectedVersion: 1, patch: { title: 'Second' } }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof CardVersionConflictError);
  });

  it('bounds additive remerge to one strongly-consistent retry', async () => {
    const created = await createCard(client, {
      title: 'Additive',
      anchorDate: '2026-09-05',
      references: [],
    });
    await updateCard(client, created.id, { expectedVersion: 1, patch: { tags: ['current'] } });
    const updated = await updateCardAdditive(client, created, (current) => ({
      references: [...(current.references || []), { name: `v${current.version}`, url: 'https://example.com' }],
    }));
    assert.equal(updated.version, 3);
    assert.deepEqual(updated.tags, ['current']);
    assert.deepEqual(updated.references, [{ name: 'v2', url: 'https://example.com' }]);
  });

  it('rejects lifecycle fields and completed stages from direct updates', async () => {
    const created = await createCard(client, { title: 'System fields', anchorDate: '2026-09-06' });
    await assert.rejects(
      updateCard(client, created.id, {
        expectedVersion: 1,
        patch: { status: 'archived' } as never,
      }),
      /status is not an allowed Card patch field/,
    );
    await assert.rejects(
      updateCard(client, created.id, { expectedVersion: 1, patch: { stage: 'done' } }),
      /stage must be preparation, announced, or after-event/,
    );

    const archivedId = crypto.randomUUID();
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: {
        PK: `CARD#${archivedId}`,
        SK: `CARD#${archivedId}`,
        id: archivedId,
        version: 2,
        title: 'Completed Card',
        status: 'archived',
        stage: 'done',
        taskCount: 1,
        openTaskCount: 0,
        completedAt: '2026-09-06T12:00:00.000Z',
        completedBy: 'system:task-lifecycle',
        activeStageBeforeCompletion: 'announced',
      },
    }));
    await assert.rejects(
      updateCard(client, archivedId, { expectedVersion: 2, patch: { stage: 'preparation' } }),
      CardVersionConflictError,
    );
    assert.strictEqual((await getCard(client, archivedId))?.stage, 'done');
  });

  it('fails loudly on non-canonical persisted Card rows', async () => {
    const id = crypto.randomUUID();
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: {
        PK: `CARD#${id}`,
        SK: `CARD#${id}`,
        id,
        title: 'Versionless',
        status: 'active',
        stage: 'preparation',
        taskCount: 0,
        openTaskCount: 0,
      },
    }));
    await assert.rejects(getCard(client, id), /not in the canonical lifecycle shape/);

    const stringId = crypto.randomUUID();
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: {
        PK: `CARD#${stringId}`,
        SK: `CARD#${stringId}`,
        id: stringId,
        version: '1',
        title: 'Numeric strings',
        status: 'active',
        stage: 'preparation',
        taskCount: '0',
        openTaskCount: '0',
      },
    }));
    await assert.rejects(getCard(client, stringId), /not in the canonical lifecycle shape/);

    const impossibleAggregates = [
      {
        title: 'Active with no open Tasks',
        status: 'active', stage: 'preparation', taskCount: 1, openTaskCount: 0,
      },
      {
        title: 'Archived without Tasks',
        status: 'archived', stage: 'done', taskCount: 0, openTaskCount: 0,
        completedAt: '2026-09-06T12:00:00.000Z', completedBy: 'system:task-lifecycle',
        activeStageBeforeCompletion: 'preparation',
      },
      {
        title: 'Archived with open Tasks',
        status: 'archived', stage: 'done', taskCount: 2, openTaskCount: 1,
        completedAt: '2026-09-06T12:00:00.000Z', completedBy: 'system:task-lifecycle',
        activeStageBeforeCompletion: 'preparation',
      },
    ];
    for (const malformed of impossibleAggregates) {
      const malformedId = crypto.randomUUID();
      await client.send(new PutCommand({
        TableName: TABLE_CARDS,
        Item: {
          PK: `CARD#${malformedId}`,
          SK: `CARD#${malformedId}`,
          id: malformedId,
          version: 1,
          ...malformed,
        },
      }));
      await assert.rejects(getCard(client, malformedId), /not in the canonical lifecycle shape/);
    }
  });
});
