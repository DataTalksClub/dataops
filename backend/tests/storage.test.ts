import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FileRecord } from '../src/types';
import { saveFile, readFile, removeFile, isLocalFilesystemStorageAllowed, setFileStorageClientForTests, setLocalDownloadKeyForTests, createFileDownloadAuthorization, verifyLocalDownloadLink, MAX_TASK_FILE_BYTES } from '../src/storage';

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

  it('mints a real short-lived presigned GET that names the private object and carries the disposition', async () => {
    // SigV4 presigning is local computation: with static test credentials the
    // real presigner runs without any network access.
    const credentialVariables = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_SESSION_TOKEN'];
    const savedCredentials = Object.fromEntries(credentialVariables.map(key => [key, process.env[key]]));
    process.env.AWS_ACCESS_KEY_ID = 'ASIA-test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.TASK_FILES_BUCKET = 'private-task-files';
    try {
      const authorization = await createFileDownloadAuthorization({
        id: 'file-1',
        filename: 'a proof.png',
        storageProvider: 's3',
        storagePath: 'tasks/task-1/abc/proof.png',
        storageUri: 's3://private-task-files/tasks/task-1/abc/proof.png',
        contentType: 'image/png',
      } as FileRecord);
      assert.equal(authorization.expiresIn, 300);
      const url = new URL(authorization.url);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.host, 'private-task-files.s3.eu-central-1.amazonaws.com');
      assert.equal(url.pathname, '/tasks/task-1/abc/proof.png');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
      assert.ok(url.searchParams.get('X-Amz-Signature'), 'the URL carries a SigV4 signature');
      assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
      assert.match(url.searchParams.get('response-content-disposition') || '', /^attachment; filename="download"; filename\*=UTF-8''a%20proof\.png$/);
      assert.equal(url.searchParams.get('response-content-type'), 'image/png');
    } finally {
      for (const key of credentialVariables) { if (savedCredentials[key] === undefined) delete process.env[key]; else process.env[key] = savedCredentials[key]; }
    }
  });

  it('signs local-dev delivery links with the per-process key and refuses tampering', async () => {
    const authorization = await createFileDownloadAuthorization({
      id: 'file-9',
      filename: 'local.txt',
      storageProvider: 'local-dev',
      storagePath: 'tasks/task/file',
    } as FileRecord);
    assert.match(authorization.url, /^\/api\/files\/file-9\/content\?expires=\d+&mac=[0-9a-f]{64}$/);
    const params = Object.fromEntries(new URLSearchParams(authorization.url.split('?')[1]));
    assert.equal(verifyLocalDownloadLink('file-9', params.expires, params.mac), true);
    const flipped = params.mac.slice(0, -1) + (params.mac.endsWith('0') ? '1' : '0');
    assert.equal(verifyLocalDownloadLink('file-9', params.expires, flipped), false);
    assert.equal(verifyLocalDownloadLink('other-file', params.expires, params.mac), false);
    assert.equal(verifyLocalDownloadLink('file-9', String(Number(params.expires) - 1), params.mac), false);
    // A different process (fresh key) must not accept the first process's link.
    setLocalDownloadKeyForTests();
    assert.equal(verifyLocalDownloadLink('file-9', params.expires, params.mac), false);
  });
});
