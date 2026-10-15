import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { S3Client } from '@aws-sdk/client-s3';
import { saveFile, readFile, removeFile, isLocalFilesystemStorageAllowed, setFileStorageClientForTests, MAX_TASK_FILE_BYTES } from '../src/storage';

describe('Task file storage', () => {
  const variables = ['UPLOAD_DIR', 'NODE_ENV', 'AWS_LAMBDA_FUNCTION_NAME', 'IS_LOCAL', 'DATAOPS_FILE_STORAGE_PROVIDER', 'TASK_FILES_BUCKET'];
  let previous: Record<string, string | undefined>;
  let root: string;
  beforeEach(() => {
    previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
    for (const key of variables) delete process.env[key];
    process.env.NODE_ENV = 'test';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataops-task-files-'));
    process.env.UPLOAD_DIR = root;
  });
  afterEach(() => {
    setFileStorageClientForTests();
    for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps same-name proofs independent and round-trips binary bytes locally', async () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
    const first = await saveFile('task-1', 'cover.png', bytes, 'image/png');
    const second = await saveFile('task-1', 'cover.png', Buffer.from('other'), 'image/png');
    assert.notEqual(first.storagePath, second.storagePath);
    assert.equal(first.storageProvider, 'local-dev');
    assert.deepEqual(await readFile(first), bytes);
    await removeFile(second);
    assert.deepEqual(await readFile(first), bytes);
    await assert.rejects(readFile(second), { code: 'file_not_found' });
  });

  it('never enables an ephemeral production or Lambda filesystem through flags', async () => {
    process.env.NODE_ENV = 'production';
    process.env.IS_LOCAL = 'true';
    process.env.DATAOPS_FILE_STORAGE_PROVIDER = 'local-dev';
    assert.equal(isLocalFilesystemStorageAllowed(), false);
    await assert.rejects(saveFile('task', 'proof.txt', Buffer.from('proof'), 'text/plain'), /TASK_FILES_BUCKET is not configured/);
    process.env.NODE_ENV = 'test'; process.env.AWS_LAMBDA_FUNCTION_NAME = 'production-function';
    assert.equal(isLocalFilesystemStorageAllowed(), false);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('rejects traversal, control characters, and oversized uploads before storage', async () => {
    for (const filename of ['../escape', '..\\escape', '/absolute', 'bad\r\nheader', '..']) {
      await assert.rejects(saveFile('task', filename, Buffer.alloc(0), 'text/plain'), { code: 'invalid_filename' });
    }
    await assert.rejects(saveFile('task', 'large.bin', Buffer.alloc(MAX_TASK_FILE_BYTES + 1), 'application/octet-stream'), { code: 'file_too_large' });
    await assert.rejects(readFile({ storagePath: '../outside', storageProvider: 'local-dev' }), { code: 'invalid_file_path' });
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('stores, reads, and deletes immutable private S3 objects without local writes', async () => {
    process.env.TASK_FILES_BUCKET = 'private-task-files';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'dataops';
    const objects = new Map<string, Buffer>();
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    setFileStorageClientForTests({ send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      const key = command.input.Key as string;
      if (command.constructor.name === 'PutObjectCommand') objects.set(key, Buffer.from(command.input.Body as Buffer));
      if (command.constructor.name === 'DeleteObjectCommand') objects.delete(key);
      return { Body: { transformToByteArray: async () => objects.get(key) } };
    } } as unknown as Pick<S3Client, 'send'>);
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    const first = await saveFile('task/a', 'a proof.png', bytes, 'image/png');
    const second = await saveFile('task/a', 'a proof.png', Buffer.from('second'), 'image/png');
    assert.equal(first.storageProvider, 's3');
    assert.notEqual(first.storagePath, second.storagePath);
    assert.match(first.storagePath, /^tasks\/task%2Fa\/[a-f0-9-]+\/a%20proof.png$/);
    assert.equal(calls[0].input.Bucket, 'private-task-files');
    assert.equal(calls[0].input.IfNoneMatch, '*');
    assert.equal(calls[0].input.ContentType, 'image/png');
    assert.deepEqual(await readFile(first), bytes);
    await removeFile(first);
    assert.equal(objects.has(first.storagePath), false);
    assert.equal(objects.has(second.storagePath), true);
    assert.deepEqual(fs.readdirSync(root), []);
    const count = calls.length;
    await assert.rejects(readFile({ ...second, storageUri: 's3://another-bucket/stolen' }), { code: 'file_storage_mismatch' });
    assert.equal(calls.length, count);
  });

  it('preserves S3 service failures instead of reporting a missing file', async () => {
    process.env.TASK_FILES_BUCKET = 'private-task-files';
    setFileStorageClientForTests({ send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } } as unknown as Pick<S3Client, 'send'>);
    await assert.rejects(readFile({ storageProvider: 's3', storagePath: 'tasks/task/file', storageUri: 's3://private-task-files/tasks/task/file' }), { name: 'AccessDenied' });
  });
});
