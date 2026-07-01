import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  createFile,
  getFile,
  deleteFile,
  listFilesByTask,
  listFiles,
} from '../src/db/files';

describe('Files data layer', () => {
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

  it('createFile returns a file with id and createdAt', async () => {
    const file = await createFile(client, {
      taskId: 'task-1',
      filename: 'test.png',
      category: 'image',
      storagePath: 'task-1/test.png',
    });

    assert.ok(file.id);
    assert.ok(file.createdAt);
    assert.strictEqual(file.taskId, 'task-1');
    assert.strictEqual(file.filename, 'test.png');
    assert.strictEqual(file.category, 'image');
    assert.strictEqual(file.storagePath, 'task-1/test.png');
    assert.strictEqual((file as Record<string, unknown>).PK, undefined);
    assert.strictEqual((file as Record<string, unknown>).SK, undefined);
  });

  it('createFile stores tags', async () => {
    const file = await createFile(client, {
      taskId: 'task-2',
      filename: 'invoice.pdf',
      category: 'invoice',
      storagePath: 'task-2/invoice.pdf',
      tags: ['finance', 'Q1'],
    });

    assert.deepStrictEqual(file.tags, ['finance', 'Q1']);
  });

  it('getFile returns the file by id', async () => {
    const created = await createFile(client, {
      taskId: 'task-3',
      filename: 'doc.pdf',
      category: 'document',
      storagePath: 'task-3/doc.pdf',
    });

    const fetched = await getFile(client, created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.filename, 'doc.pdf');
    assert.strictEqual(fetched.taskId, 'task-3');
  });

  it('getFile returns null for non-existent id', async () => {
    const result = await getFile(client, 'does-not-exist');
    assert.strictEqual(result, null);
  });

  it('deleteFile removes the file', async () => {
    const created = await createFile(client, {
      taskId: 'task-4',
      filename: 'delete-me.txt',
      category: 'document',
      storagePath: 'task-4/delete-me.txt',
    });

    await deleteFile(client, created.id);
    const result = await getFile(client, created.id);
    assert.strictEqual(result, null);
  });

  it('listFilesByTask returns files for a specific task', async () => {
    const taskId = 'task-list-' + crypto.randomUUID();
    await createFile(client, {
      taskId,
      filename: 'file1.txt',
      category: 'document',
      storagePath: `${taskId}/file1.txt`,
    });
    await createFile(client, {
      taskId,
      filename: 'file2.txt',
      category: 'image',
      storagePath: `${taskId}/file2.txt`,
    });
    await createFile(client, {
      taskId: 'other-task',
      filename: 'file3.txt',
      category: 'document',
      storagePath: 'other-task/file3.txt',
    });

    const files = await listFilesByTask(client, taskId);
    assert.strictEqual(files.length, 2);
    for (const f of files) {
      assert.strictEqual(f.taskId, taskId);
    }
  });

  it('listFilesByTask returns empty array for task with no files', async () => {
    const files = await listFilesByTask(client, 'no-files-task');
    assert.deepStrictEqual(files, []);
  });

  it('listFiles returns all files when no filters', async () => {
    const files = await listFiles(client);
    assert.ok(files.length > 0);
  });

  it('listFiles filters by category', async () => {
    const taskId = 'task-cat-' + crypto.randomUUID();
    await createFile(client, {
      taskId,
      filename: 'photo.jpg',
      category: 'image',
      storagePath: `${taskId}/photo.jpg`,
    });

    const files = await listFiles(client, { category: 'image' });
    assert.ok(files.length > 0);
    for (const f of files) {
      assert.strictEqual(f.category, 'image');
    }
  });

  it('listFiles filters by tag', async () => {
    const taskId = 'task-tag-' + crypto.randomUUID();
    const uniqueTag = 'unique-tag-' + crypto.randomUUID();
    await createFile(client, {
      taskId,
      filename: 'tagged.pdf',
      category: 'document',
      storagePath: `${taskId}/tagged.pdf`,
      tags: [uniqueTag],
    });

    const files = await listFiles(client, { tag: uniqueTag });
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].tags!.includes(uniqueTag));
  });
});
