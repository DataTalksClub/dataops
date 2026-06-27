import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import type { LambdaResponse } from '../src/types';

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
    await startLocal();
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
    assert.ok(Array.isArray(parsed.files));
    assert.ok(parsed.files.length >= 1);
    for (const f of parsed.files) {
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
    assert.deepStrictEqual(parsed.files, []);
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
    const bodyBuffer = Buffer.from(res.body, 'binary');
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
    for (const f of parsed.files) {
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
        body: JSON.stringify({ status: 'done' }),
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
        body: JSON.stringify({ status: 'done' }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.status, 'done');
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
        body: JSON.stringify({ status: 'done' }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.status, 'done');
    });
  });
});
