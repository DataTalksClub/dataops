import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables, deleteTables } from '../scripts/local-dynamodb';
import {
  createCard,
  getCard,
  updateCard,
  deleteCard,
  listCards,
} from '../src/db/cards';

describe('Cards data layer', () => {
  let client: DynamoDBDocumentClient;
  let port: number;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('createCard returns a card with id, createdAt, updatedAt', async () => {
    const card = await createCard(client, {
      title: 'DataOps v2',
      description: 'Next version of the app',
    });

    assert.ok(card.id);
    assert.strictEqual(card.version, 1);
    assert.ok(card.createdAt);
    assert.ok(card.updatedAt);
    assert.strictEqual(card.title, 'DataOps v2');
    assert.strictEqual(card.description, 'Next version of the app');
    assert.strictEqual((card as Record<string, unknown>).PK, undefined);
    assert.strictEqual((card as Record<string, unknown>).SK, undefined);
  });

  it('getCard returns the card by id', async () => {
    const created = await createCard(client, { title: 'Fetch card' });
    const fetched = await getCard(client, created.id);

    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.title, 'Fetch card');
  });

  it('getCard returns null for non-existent id', async () => {
    const result = await getCard(client, 'does-not-exist');
    assert.strictEqual(result, null);
  });

  it('updateCard performs partial update and refreshes updatedAt', async () => {
    const created = await createCard(client, {
      title: 'Original title',
      status: 'active',
    });

    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateCard(client, created.id, {
      title: 'New title',
    });

    assert.strictEqual(updated!.title, 'New title');
    assert.strictEqual(updated!.status, 'active');
    assert.strictEqual(updated!.version, 2);
    assert.ok(updated!.updatedAt > created.updatedAt);
  });

  it('deleteCard removes the card', async () => {
    const created = await createCard(client, { title: 'Delete me' });
    await deleteCard(client, created.id);
    const result = await getCard(client, created.id);
    assert.strictEqual(result, null);
  });

  it('listCards returns all cards', async () => {
    const b1 = await createCard(client, { title: 'List test 1' });
    const b2 = await createCard(client, { title: 'List test 2' });

    const cards = await listCards(client);
    const ids = cards.map((b) => b.id);

    assert.ok(ids.includes(b1.id), 'should contain first card');
    assert.ok(ids.includes(b2.id), 'should contain second card');
    assert.ok(cards.length >= 2, 'should have at least 2 cards');
  });

  // ---- New field tests ----

  it('createCard stores references and cardLinks', async () => {
    const card = await createCard(client, {
      title: 'Links test',
      anchorDate: '2026-05-01',
      references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
      cardLinks: [{ name: 'Luma', url: '' }],
    });

    assert.ok(card.id);
    const fetched = await getCard(client, card.id);
    assert.ok(fetched);
    assert.deepStrictEqual(fetched.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
    assert.deepStrictEqual(fetched.cardLinks, [{ name: 'Luma', url: '' }]);
  });

  it('createCard stores emoji, tags, stage, status', async () => {
    const card = await createCard(client, {
      title: 'Full fields test',
      anchorDate: '2026-06-01',
      emoji: '📰',
      tags: ['newsletter', 'weekly'],
      stage: 'preparation',
      status: 'active',
    });

    const fetched = await getCard(client, card.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.emoji, '📰');
    assert.deepStrictEqual(fetched.tags, ['newsletter', 'weekly']);
    assert.strictEqual(fetched.stage, 'preparation');
    assert.strictEqual(fetched.status, 'active');
  });

  it('updateCard updates stage', async () => {
    const created = await createCard(client, {
      title: 'Stage test',
      anchorDate: '2026-06-01',
      stage: 'preparation',
    });

    const updated = await updateCard(client, created.id, {
      stage: 'announced',
    });

    assert.strictEqual(updated!.stage, 'announced');
    assert.strictEqual(updated!.title, 'Stage test');
  });

  it('updateCard updates status to archived', async () => {
    const created = await createCard(client, {
      title: 'Archive test',
      anchorDate: '2026-06-01',
      status: 'active',
    });

    const updated = await updateCard(client, created.id, {
      status: 'archived',
    });

    assert.strictEqual(updated!.status, 'archived');
  });

  it('updateCard updates references and cardLinks', async () => {
    const created = await createCard(client, {
      title: 'Update links test',
      anchorDate: '2026-06-01',
    });

    const updated = await updateCard(client, created.id, {
      references: [{ name: 'Proc doc', url: 'https://docs.google.com/proc' }],
      cardLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
    });

    assert.deepStrictEqual(updated!.references, [{ name: 'Proc doc', url: 'https://docs.google.com/proc' }]);
    assert.deepStrictEqual(updated!.cardLinks, [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
  });

  it('updateCard updates emoji and tags', async () => {
    const created = await createCard(client, {
      title: 'Emoji tags test',
      anchorDate: '2026-06-01',
    });

    const updated = await updateCard(client, created.id, {
      emoji: '🎙️',
      tags: ['podcast'],
    });

    assert.strictEqual(updated!.emoji, '🎙️');
    assert.deepStrictEqual(updated!.tags, ['podcast']);
  });

  it('existing cards without new fields still work', async () => {
    // Create a card with only basic fields (simulating old data)
    const card = await createCard(client, {
      title: 'Old card',
      anchorDate: '2026-01-01',
    });

    const fetched = await getCard(client, card.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.title, 'Old card');
    // New fields are simply absent
    assert.strictEqual(fetched.emoji, undefined);
    assert.strictEqual(fetched.tags, undefined);
    assert.strictEqual(fetched.stage, undefined);
    assert.strictEqual(fetched.status, undefined);
    assert.strictEqual(fetched.references, undefined);
    assert.strictEqual(fetched.cardLinks, undefined);
  });
});
