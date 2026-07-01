const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper: create a task via API
async function createTask(request, data) {
  const res = await request.post('/api/tasks', { data });
  const body = await res.json();
  return body;
}

// Helper: build multipart form data for file upload
function buildMultipartBuffer(fields, file) {
  const boundary = '----PlaywrightBoundary' + Date.now();
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  if (file) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`
    );
    // We need to combine text parts and binary content
    const headerBuffer = Buffer.from(parts.join(''), 'binary');
    const fileBuffer = file.content;
    const footerBuffer = Buffer.from(`\r\n--${boundary}--\r\n`, 'binary');

    return {
      body: Buffer.concat([headerBuffer, fileBuffer, footerBuffer]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  parts.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.from(parts.join(''), 'binary'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test.describe('File uploads API', () => {
  let taskId;

  test.beforeAll(async ({ request }) => {
    const task = await createTask(request, {
      description: 'E2E file test task',
      date: '2026-07-01',
    });
    taskId = task.id;
  });

  // ── Scenario: Upload a file to a task ──────────────────────────

  test('uploads a file to a task', async ({ request }) => {
    const fileContent = Buffer.from('e2e test file content');
    const { body, contentType } = buildMultipartBuffer(
      { taskId, category: 'image' },
      { fieldName: 'file', filename: 'e2e-test.png', content: fileContent, contentType: 'image/png' }
    );

    const res = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.file.id).toMatch(UUID_RE);
    expect(json.file.taskId).toBe(taskId);
    expect(json.file.filename).toBe('e2e-test.png');
    expect(json.file.category).toBe('image');
    expect(json.file.storagePath).toBeTruthy();
    expect(json.file.createdAt).toBeTruthy();
  });

  // ── Scenario: Upload a file with default category ──────────────

  test('uploads a file with default category', async ({ request }) => {
    const fileContent = Buffer.from('default category test');
    const { body, contentType } = buildMultipartBuffer(
      { taskId },
      { fieldName: 'file', filename: 'default-cat.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.file.category).toBe('document');
  });

  // ── Scenario: Upload rejected without taskId ───────────────────

  test('rejects upload without taskId', async ({ request }) => {
    const fileContent = Buffer.from('no task id');
    const { body, contentType } = buildMultipartBuffer(
      {},
      { fieldName: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('taskId');
  });

  // ── Scenario: Upload rejected without file ─────────────────────

  test('rejects upload without file', async ({ request }) => {
    const { body, contentType } = buildMultipartBuffer({ taskId });

    const res = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('file');
  });

  // ── Scenario: Upload rejected for non-existent task ────────────

  test('rejects upload for non-existent task', async ({ request }) => {
    const fileContent = Buffer.from('no such task');
    const { body, contentType } = buildMultipartBuffer(
      { taskId: 'nonexistent' },
      { fieldName: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' }
    );

    const res = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    expect(res.status()).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Task not found');
  });

  // ── Scenario: List files for a task ────────────────────────────

  test('lists files for a task', async ({ request }) => {
    // Upload two files
    for (let i = 0; i < 2; i++) {
      const fileContent = Buffer.from(`list test file ${i}`);
      const { body, contentType } = buildMultipartBuffer(
        { taskId },
        { fieldName: 'file', filename: `list-test-${i}.txt`, content: fileContent, contentType: 'text/plain' }
      );
      await request.post('/api/files', {
        data: body,
        headers: { 'Content-Type': contentType },
      });
    }

    const res = await request.get(`/api/files?taskId=${taskId}`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.files.length).toBeGreaterThanOrEqual(2);
    for (const f of json.files) {
      expect(f.taskId).toBe(taskId);
    }
  });

  // ── Scenario: List files returns empty array for task with no files ──

  test('returns empty array for task with no files', async ({ request }) => {
    // Create a fresh task with no files
    const task = await createTask(request, {
      description: 'No files task',
      date: '2026-07-02',
    });

    const res = await request.get(`/api/files?taskId=${task.id}`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.files).toEqual([]);
  });

  // ── Scenario: Get file metadata by ID ──────────────────────────

  test('gets file metadata by ID', async ({ request }) => {
    // Upload a file
    const fileContent = Buffer.from('metadata by id');
    const { body, contentType } = buildMultipartBuffer(
      { taskId },
      { fieldName: 'file', filename: 'meta-id.txt', content: fileContent, contentType: 'text/plain' }
    );
    const uploadRes = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });
    const uploaded = await uploadRes.json();

    const res = await request.get(`/api/files/${uploaded.file.id}`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.file.id).toBe(uploaded.file.id);
    expect(json.file.filename).toBe('meta-id.txt');
  });

  // ── Scenario: Download a file ──────────────────────────────────

  test('downloads a file with correct content', async ({ request }) => {
    const fileContent = Buffer.from('download this content');
    const { body, contentType } = buildMultipartBuffer(
      { taskId },
      { fieldName: 'file', filename: 'download-test.txt', content: fileContent, contentType: 'text/plain' }
    );
    const uploadRes = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });
    const uploaded = await uploadRes.json();

    const res = await request.get(`/api/files/${uploaded.file.id}/download`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('text/plain');
    expect(res.headers()['content-disposition']).toContain('download-test.txt');

    const downloadedBody = await res.body();
    expect(downloadedBody.toString()).toBe('download this content');
  });

  // ── Scenario: Delete a file ────────────────────────────────────

  test('deletes a file (metadata and disk)', async ({ request }) => {
    const fileContent = Buffer.from('delete this');
    const { body, contentType } = buildMultipartBuffer(
      { taskId },
      { fieldName: 'file', filename: 'delete-e2e.txt', content: fileContent, contentType: 'text/plain' }
    );
    const uploadRes = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });
    const uploaded = await uploadRes.json();
    const fileId = uploaded.file.id;

    // Delete
    const delRes = await request.delete(`/api/files/${fileId}`);
    expect(delRes.status()).toBe(204);

    // Verify metadata gone
    const getRes = await request.get(`/api/files/${fileId}`);
    expect(getRes.status()).toBe(404);
  });

  // ── Scenario: requiresFile prevents task completion without file ──

  test('requiresFile prevents task completion without file', async ({ request }) => {
    const task = await createTask(request, {
      description: 'Needs file to complete',
      date: '2026-07-03',
      requiresFile: true,
    });

    const res = await request.put(`/api/tasks/${task.id}`, {
      data: { status: 'done' },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Cannot mark task as done: required file has not been uploaded');
  });

  // ── Scenario: requiresFile allows task completion after file upload ──

  test('requiresFile allows task completion after file upload', async ({ request }) => {
    const task = await createTask(request, {
      description: 'Upload then complete',
      date: '2026-07-04',
      requiresFile: true,
    });

    // Upload a file
    const fileContent = Buffer.from('proof of work');
    const { body, contentType } = buildMultipartBuffer(
      { taskId: task.id },
      { fieldName: 'file', filename: 'proof.txt', content: fileContent, contentType: 'text/plain' }
    );
    await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });

    // Now complete the task
    const res = await request.put(`/api/tasks/${task.id}`, {
      data: { status: 'done' },
    });

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('done');
  });

  // ── Scenario: Filter files by category ─────────────────────────

  test('filters files by category', async ({ request }) => {
    const res = await request.get('/api/files?category=image');
    expect(res.status()).toBe(200);
    const json = await res.json();
    for (const f of json.files) {
      expect(f.category).toBe('image');
    }
  });

  // ── Scenario: Get metadata for non-existent file returns 404 ──

  test('returns 404 for non-existent file metadata', async ({ request }) => {
    const res = await request.get('/api/files/nonexistent');
    expect(res.status()).toBe(404);
  });

  // ── Scenario: Download non-existent file returns 404 ──────────

  test('returns 404 for non-existent file download', async ({ request }) => {
    const res = await request.get('/api/files/nonexistent/download');
    expect(res.status()).toBe(404);
  });

  // ── Scenario: Deleting the only file re-enables requirement ───

  test('deleting the only file re-enables the file requirement', async ({ request }) => {
    const task = await createTask(request, {
      description: 'Delete re-enables requirement',
      date: '2026-07-05',
      requiresFile: true,
    });

    // Upload a file
    const fileContent = Buffer.from('temporary file');
    const { body, contentType } = buildMultipartBuffer(
      { taskId: task.id },
      { fieldName: 'file', filename: 'temp.txt', content: fileContent, contentType: 'text/plain' }
    );
    const uploadRes = await request.post('/api/files', {
      data: body,
      headers: { 'Content-Type': contentType },
    });
    const uploaded = await uploadRes.json();

    // Delete the file
    await request.delete(`/api/files/${uploaded.file.id}`);

    // Try to mark done - should fail again
    const res = await request.put(`/api/tasks/${task.id}`, {
      data: { status: 'done' },
    });

    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Cannot mark task as done: required file has not been uploaded');
  });
});
