import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import type { LambdaResponse } from '../src/types';
import type { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { setFileStorageClientForTests } from '../src/storage';
import { TABLE_FILES } from '../src/db/tableNames';

const TEST_UPLOAD_DIR = path.join(__dirname, '..', 'test-uploads-api-' + process.pid);

/**
 * Build a multipart/form-data body for testing.
 */
function buildMultipart(fields: Record<string, string>, file?: { fieldName: string; filename: string; content: Buffer; contentType: string }): { body: string; contentType: string } {
  const boundary = '----TestBoundary' + Date.now();
  let body = '';

  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  if (file) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n`;
    body += `Content-Type: ${file.contentType}\r\n\r\n`;
    body += file.content.toString('binary');
    body += '\r\n';
  }

  body += `--${boundary}--\r\n`;

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('API - File uploads', () => {
  let handler: typeof import('../src/handler').handler;
  let taskId: string;

  before(async () => {
    process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
    const localPort = await startLocal();
    await createTables(await getClient(localPort));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    // Warm up
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);

    // Create a task to attach files to
    const taskRes = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'File test task', date: '2026-06-01' }),
    }, {});
    const task = JSON.parse(taskRes.body);
    taskId = task.id;
  });

  after(async () => {
    if (fs.existsSync(TEST_UPLOAD_DIR)) {
      fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
    }
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.UPLOAD_DIR;
  });

  it('POST /api/files uploads a file and returns 201', async () => {
    const fileContent = Buffer.from('hello file content');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 201);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.file.id);
    assert.strictEqual(parsed.file.taskId, taskId);
    assert.strictEqual(parsed.file.filename, 'test.txt');
    assert.strictEqual(parsed.file.category, 'document');
    assert.ok(parsed.file.storagePath);
    assert.ok(parsed.file.createdAt);
  });

  it('POST /api/files with category "image"', async () => {
    const fileContent = Buffer.from('fake image data');
    const { body, contentType } = buildMultipart(
      { taskId, category: 'image' },
      { fieldName: 'file', filename: 'photo.jpg', content: fileContent, contentType: 'image/jpeg' }
    );

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 201);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.file.category, 'image');
    assert.strictEqual(parsed.file.filename, 'photo.jpg');
  });

  it('POST /api/files defaults category to "document"', async () => {
    const fileContent = Buffer.from('some data');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'readme.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 201);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.file.category, 'document');
  });

  it('POST /api/files decodes base64 Lambda request bodies', async () => {
    const fileContent = Buffer.from('base64 upload content');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'base64.txt', content: fileContent, contentType: 'text/plain' }
    );

    const uploadRes = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body: Buffer.from(body, 'binary').toString('base64'),
      isBase64Encoded: true,
    }, {});

    assert.strictEqual(uploadRes.statusCode, 201);
    const uploaded = JSON.parse(uploadRes.body);
    assert.strictEqual(uploaded.file.filename, 'base64.txt');

    const downloadRes = await handler({
      httpMethod: 'GET',
      path: `/api/files/${uploaded.file.id}/download`,
    }, {});

    assert.strictEqual(downloadRes.statusCode, 200);
    assert.strictEqual(downloadRes.isBase64Encoded, true);
    assert.deepStrictEqual(Buffer.from(downloadRes.body, 'base64'), fileContent);
  });

  it('round-trips production S3 binary proofs, preserves earlier same-name uploads, and retains retryable deletion metadata', async () => {
    const keys = ['TASK_FILES_BUCKET', 'DATAOPS_FILE_STORAGE_PROVIDER', 'AWS_LAMBDA_FUNCTION_NAME'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.TASK_FILES_BUCKET = 'private-proof-test';
    process.env.DATAOPS_FILE_STORAGE_PROVIDER = 's3';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-production';
    const objects = new Map<string, Buffer>();
    let failDelete = false;
    setFileStorageClientForTests({ send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const key = command.input.Key as string;
      if (command.constructor.name === 'PutObjectCommand') objects.set(key, Buffer.from(command.input.Body as Buffer));
      if (command.constructor.name === 'DeleteObjectCommand') {
        if (failDelete) throw new Error('S3 temporarily unavailable');
        objects.delete(key);
      }
      if (command.constructor.name === 'GetObjectCommand' && !objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => objects.get(key) } };
    } } as unknown as Pick<S3Client, 'send'>);
    try {
      const created = await handler({ httpMethod: 'POST', path: '/api/tasks', body: JSON.stringify({ description: 'Durable binary proof', date: '2026-06-01', requiresFile: true }) }, {});
      assert.equal(created.statusCode, 201, created.body);
      const task = JSON.parse(created.body);
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
      const upload = async (data: Buffer) => {
        const multipart = buildMultipart({ taskId: task.id }, { fieldName: 'file', filename: 'proof.png', content: data, contentType: 'image/png' });
        return handler({ httpMethod: 'POST', path: '/api/files', headers: { 'content-type': multipart.contentType }, body: Buffer.from(multipart.body, 'binary').toString('base64'), isBase64Encoded: true }, {});
      };
      const firstRes = await upload(bytes);
      assert.equal(firstRes.statusCode, 201, firstRes.body);
      const first = JSON.parse(firstRes.body).file;
      assert.equal(first.storageProvider, 's3');
      const second = JSON.parse((await upload(Buffer.from('replacement'))).body).file;
      assert.notEqual(first.storagePath, second.storagePath);
      const downloaded = await handler({ httpMethod: 'GET', path: `/api/files/${first.id}/download` }, {});
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.equal(downloaded.isBase64Encoded, true);
      assert.deepEqual(Buffer.from(downloaded.body, 'base64'), bytes);
      assert.equal(downloaded.headers?.['Content-Type'], 'image/png');
      const done = await handler({ httpMethod: 'PUT', path: `/api/tasks/${task.id}`, body: JSON.stringify({ expectedVersion: task.version, status: 'done' }) }, {});
      assert.equal(done.statusCode, 200, done.body);

      // A failed database write must clean up the object rather than orphan it.
      const send = DynamoDBDocumentClient.prototype.send;
      DynamoDBDocumentClient.prototype.send = (async function (this: DynamoDBDocumentClient, command: { constructor: { name: string }; input: { TableName?: string } }) {
        if (command.constructor.name === 'PutCommand' && command.input.TableName === TABLE_FILES) throw new Error('metadata unavailable');
        return send.call(this, command as never);
      }) as typeof DynamoDBDocumentClient.prototype.send;
      try { assert.equal((await upload(Buffer.from('failed metadata'))).statusCode, 500); }
      finally { DynamoDBDocumentClient.prototype.send = send; }
      assert.equal(objects.size, 2);

      failDelete = true;
      const failedDelete = await handler({ httpMethod: 'DELETE', path: `/api/files/${second.id}` }, {});
      assert.equal(failedDelete.statusCode, 500);
      assert.equal((await handler({ httpMethod: 'GET', path: `/api/files/${second.id}` }, {})).statusCode, 200);
      failDelete = false;
      assert.equal((await handler({ httpMethod: 'DELETE', path: `/api/files/${second.id}` }, {})).statusCode, 204);
      assert.equal((await handler({ httpMethod: 'GET', path: `/api/files/${second.id}` }, {})).statusCode, 404);
      assert.equal(objects.has(first.storagePath), true);
    } finally {
      setFileStorageClientForTests();
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
  });

  it('POST /api/files returns 400 when taskId missing', async () => {
    const fileContent = Buffer.from('no task id');
    const { body, contentType } = buildMultipart(
      {},
      { fieldName: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Missing required field: taskId');
  });

  it('POST /api/files returns 400 when file missing', async () => {
    const { body, contentType } = buildMultipart({ taskId });

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 400);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Missing required field: file');
  });

  it('POST /api/files returns 404 for non-existent task', async () => {
    const fileContent = Buffer.from('no task');
    const { body, contentType } = buildMultipart(
      { taskId: 'nonexistent' },
      { fieldName: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});

    assert.strictEqual(res.statusCode, 404);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.error, 'Task not found');
  });

  it('GET /api/files?taskId=... lists files for a task', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId },
    }, {});

    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.files.items));
    assert.ok(parsed.files.items.length >= 1);
    for (const f of parsed.files.items) {
      assert.strictEqual(f.taskId, taskId);
    }
  });

  it('GET /api/files?taskId=... returns empty for task with no files', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId: 'no-files-task-id' },
    }, {});

    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.deepStrictEqual(parsed.files, { items: [] });
  });

  it('GET /api/files/:id returns file metadata', async () => {
    // Upload a file first
    const fileContent = Buffer.from('metadata test');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'meta.txt', content: fileContent, contentType: 'text/plain' }
    );

    const uploadRes = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});
    const uploaded = JSON.parse(uploadRes.body);

    const res = await handler({
      httpMethod: 'GET',
      path: `/api/files/${uploaded.file.id}`,
    }, {});

    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.file.id, uploaded.file.id);
    assert.strictEqual(parsed.file.filename, 'meta.txt');
  });

  it('GET /api/files/:id returns 404 for non-existent file', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/files/nonexistent',
    }, {});

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/files/:id/download returns file content', async () => {
    const fileContent = Buffer.from('download me');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'download.txt', content: fileContent, contentType: 'text/plain' }
    );

    const uploadRes = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});
    const uploaded = JSON.parse(uploadRes.body);

    const res = await handler({
      httpMethod: 'GET',
      path: `/api/files/${uploaded.file.id}/download`,
    }, {});

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers!['Content-Type'], 'text/plain');
    assert.ok(res.headers!['Content-Disposition']!.includes('download.txt'));
    assert.strictEqual(res.isBase64Encoded, true);
    const bodyBuffer = Buffer.from(res.body, 'base64');
    assert.deepStrictEqual(bodyBuffer, fileContent);
  });

  it('GET /api/files/:id/download returns 404 for non-existent file', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/files/nonexistent/download',
    }, {});

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/files/:id removes file and metadata', async () => {
    const fileContent = Buffer.from('delete me');
    const { body, contentType } = buildMultipart(
      { taskId },
      { fieldName: 'file', filename: 'delete-me.txt', content: fileContent, contentType: 'text/plain' }
    );

    const uploadRes = await handler({
      httpMethod: 'POST',
      path: '/api/files',
      headers: { 'content-type': contentType },
      body,
    }, {});
    const uploaded = JSON.parse(uploadRes.body);

    // Verify file exists on disk
    const fullPath = path.join(TEST_UPLOAD_DIR, uploaded.file.storagePath);
    assert.ok(fs.existsSync(fullPath), 'File should exist before deletion');

    const res = await handler({
      httpMethod: 'DELETE',
      path: `/api/files/${uploaded.file.id}`,
    }, {});

    assert.strictEqual(res.statusCode, 204);

    // Verify metadata is gone
    const getRes = await handler({
      httpMethod: 'GET',
      path: `/api/files/${uploaded.file.id}`,
    }, {});
    assert.strictEqual(getRes.statusCode, 404);

    // Verify file is gone from disk
    assert.ok(!fs.existsSync(fullPath), 'File should not exist after deletion');
  });

  it('DELETE /api/files/:id returns 404 for non-existent file', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/api/files/nonexistent',
    }, {});

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/files?category=image filters by category', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { category: 'image' },
    }, {});

    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    for (const f of parsed.files.items) {
      assert.strictEqual(f.category, 'image');
    }
  });

  describe('requiresFile validation', () => {
    it('prevents marking done when requiresFile is true and no files uploaded', async () => {
      // Create a task with requiresFile
      const taskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Requires file task',
          date: '2026-06-01',
          requiresFile: true,
        }),
      }, {});
      const task = JSON.parse(taskRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: task.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.error, 'Cannot mark task as done: required file has not been uploaded');
    });

    it('allows marking done after file is uploaded', async () => {
      // Create a task with requiresFile
      const taskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Requires file done task',
          date: '2026-06-01',
          requiresFile: true,
        }),
      }, {});
      const task = JSON.parse(taskRes.body);

      // Upload a file for this task
      const fileContent = Buffer.from('requirement satisfied');
      const { body, contentType } = buildMultipart(
        { taskId: task.id },
        { fieldName: 'file', filename: 'proof.txt', content: fileContent, contentType: 'text/plain' }
      );

      await handler({
        httpMethod: 'POST',
        path: '/api/files',
        headers: { 'content-type': contentType },
        body,
      }, {});

      // Now marking done should succeed
      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: task.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.status, 'done');
    });

    it('prevents completion again after the only required file is deleted', async () => {
      const taskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Required file removed task',
          date: '2026-06-01',
          requiresFile: true,
        }),
      }, {});
      const task = JSON.parse(taskRes.body);

      const { body, contentType } = buildMultipart(
        { taskId: task.id },
        {
          fieldName: 'file',
          filename: 'temporary-proof.txt',
          content: Buffer.from('temporary proof'),
          contentType: 'text/plain',
        }
      );
      const uploadRes = await handler({
        httpMethod: 'POST',
        path: '/api/files',
        headers: { 'content-type': contentType },
        body,
      }, {});
      assert.strictEqual(uploadRes.statusCode, 201);
      const uploaded = JSON.parse(uploadRes.body);

      const deleteRes = await handler({
        httpMethod: 'DELETE',
        path: `/api/files/${uploaded.file.id}`,
      }, {});
      assert.strictEqual(deleteRes.statusCode, 204);

      const completionRes = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: task.version }),
      }, {});
      assert.strictEqual(completionRes.statusCode, 400);

      const persistedTaskRes = await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${task.id}`,
      }, {});
      assert.strictEqual(persistedTaskRes.statusCode, 200);
      assert.strictEqual(JSON.parse(persistedTaskRes.body).status, 'todo');
    });

    it('allows marking done when requiresFile is not set', async () => {
      const taskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'No file requirement',
          date: '2026-06-01',
        }),
      }, {});
      const task = JSON.parse(taskRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: task.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.status, 'done');
    });
  });
});
