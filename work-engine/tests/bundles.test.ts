import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import {
  createBundle,
  getBundle,
  updateBundle,
  deleteBundle,
  listBundles,
} from '../src/db/bundles';

describe('Bundles data layer', () => {
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

  it('createBundle returns a bundle with id, createdAt, updatedAt', async () => {
    const bundle = await createBundle(client, {
      title: 'DataTasks v2',
      description: 'Next version of the app',
    });

    assert.ok(bundle.id);
    assert.ok(bundle.createdAt);
    assert.ok(bundle.updatedAt);
    assert.strictEqual(bundle.title, 'DataTasks v2');
    assert.strictEqual(bundle.description, 'Next version of the app');
    assert.strictEqual((bundle as Record<string, unknown>).PK, undefined);
    assert.strictEqual((bundle as Record<string, unknown>).SK, undefined);
  });

  it('getBundle returns the bundle by id', async () => {
    const created = await createBundle(client, { title: 'Fetch bundle' });
    const fetched = await getBundle(client, created.id);

    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.title, 'Fetch bundle');
  });

  it('getBundle returns null for non-existent id', async () => {
    const result = await getBundle(client, 'does-not-exist');
    assert.strictEqual(result, null);
  });

  it('updateBundle performs partial update and refreshes updatedAt', async () => {
    const created = await createBundle(client, {
      title: 'Original title',
      status: 'active',
    });

    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateBundle(client, created.id, {
      title: 'New title',
    });

    assert.strictEqual(updated!.title, 'New title');
    assert.strictEqual(updated!.status, 'active');
    assert.ok(updated!.updatedAt > created.updatedAt);
  });

  it('deleteBundle removes the bundle', async () => {
    const created = await createBundle(client, { title: 'Delete me' });
    await deleteBundle(client, created.id);
    const result = await getBundle(client, created.id);
    assert.strictEqual(result, null);
  });

  it('listBundles returns all bundles', async () => {
    const b1 = await createBundle(client, { title: 'List test 1' });
    const b2 = await createBundle(client, { title: 'List test 2' });

    const bundles = await listBundles(client);
    const ids = bundles.map((b) => b.id);

    assert.ok(ids.includes(b1.id), 'should contain first bundle');
    assert.ok(ids.includes(b2.id), 'should contain second bundle');
    assert.ok(bundles.length >= 2, 'should have at least 2 bundles');
  });

  // ---- New field tests ----

  it('createBundle stores references and bundleLinks', async () => {
    const bundle = await createBundle(client, {
      title: 'Links test',
      anchorDate: '2026-05-01',
      references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
      bundleLinks: [{ name: 'Luma', url: '' }],
    });

    assert.ok(bundle.id);
    const fetched = await getBundle(client, bundle.id);
    assert.ok(fetched);
    assert.deepStrictEqual(fetched.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
    assert.deepStrictEqual(fetched.bundleLinks, [{ name: 'Luma', url: '' }]);
  });

  it('createBundle stores emoji, tags, stage, status', async () => {
    const bundle = await createBundle(client, {
      title: 'Full fields test',
      anchorDate: '2026-06-01',
      emoji: '📰',
      tags: ['newsletter', 'weekly'],
      stage: 'preparation',
      status: 'active',
    });

    const fetched = await getBundle(client, bundle.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.emoji, '📰');
    assert.deepStrictEqual(fetched.tags, ['newsletter', 'weekly']);
    assert.strictEqual(fetched.stage, 'preparation');
    assert.strictEqual(fetched.status, 'active');
  });

  it('updateBundle updates stage', async () => {
    const created = await createBundle(client, {
      title: 'Stage test',
      anchorDate: '2026-06-01',
      stage: 'preparation',
    });

    const updated = await updateBundle(client, created.id, {
      stage: 'announced',
    });

    assert.strictEqual(updated!.stage, 'announced');
    assert.strictEqual(updated!.title, 'Stage test');
  });

  it('updateBundle updates status to archived', async () => {
    const created = await createBundle(client, {
      title: 'Archive test',
      anchorDate: '2026-06-01',
      status: 'active',
    });

    const updated = await updateBundle(client, created.id, {
      status: 'archived',
    });

    assert.strictEqual(updated!.status, 'archived');
  });

  it('updateBundle updates references and bundleLinks', async () => {
    const created = await createBundle(client, {
      title: 'Update links test',
      anchorDate: '2026-06-01',
    });

    const updated = await updateBundle(client, created.id, {
      references: [{ name: 'Proc doc', url: 'https://docs.google.com/proc' }],
      bundleLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
    });

    assert.deepStrictEqual(updated!.references, [{ name: 'Proc doc', url: 'https://docs.google.com/proc' }]);
    assert.deepStrictEqual(updated!.bundleLinks, [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
  });

  it('updateBundle updates emoji and tags', async () => {
    const created = await createBundle(client, {
      title: 'Emoji tags test',
      anchorDate: '2026-06-01',
    });

    const updated = await updateBundle(client, created.id, {
      emoji: '🎙️',
      tags: ['podcast'],
    });

    assert.strictEqual(updated!.emoji, '🎙️');
    assert.deepStrictEqual(updated!.tags, ['podcast']);
  });

  it('existing bundles without new fields still work', async () => {
    // Create a bundle with only basic fields (simulating old data)
    const bundle = await createBundle(client, {
      title: 'Old bundle',
      anchorDate: '2026-01-01',
    });

    const fetched = await getBundle(client, bundle.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.title, 'Old bundle');
    // New fields are simply absent
    assert.strictEqual(fetched.emoji, undefined);
    assert.strictEqual(fetched.tags, undefined);
    assert.strictEqual(fetched.stage, undefined);
    assert.strictEqual(fetched.status, undefined);
    assert.strictEqual(fetched.references, undefined);
    assert.strictEqual(fetched.bundleLinks, undefined);
  });
});
