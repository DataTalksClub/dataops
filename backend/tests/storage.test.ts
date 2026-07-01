import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { saveFile, readFile, removeFile, getUploadDir, isLocalFilesystemStorageAllowed } from '../src/storage';

const TEST_UPLOAD_DIR = path.join(__dirname, '..', 'test-uploads-' + process.pid);

describe('Storage layer', () => {
  before(() => {
    process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
  });

  after(() => {
    // Clean up test upload directory
    if (fs.existsSync(TEST_UPLOAD_DIR)) {
      fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
    }
    delete process.env.UPLOAD_DIR;
  });

  it('getUploadDir returns UPLOAD_DIR env variable', () => {
    const dir = getUploadDir();
    assert.strictEqual(dir, TEST_UPLOAD_DIR);
  });

  it('getUploadDir returns default when env not set', () => {
    const saved = process.env.UPLOAD_DIR;
    delete process.env.UPLOAD_DIR;
    const dir = getUploadDir();
    assert.ok(dir.endsWith('uploads'));
    process.env.UPLOAD_DIR = saved;
  });

  it('allows local filesystem storage in test mode', () => {
    assert.strictEqual(isLocalFilesystemStorageAllowed(), true);
  });

  it('saveFile creates directories and writes file', () => {
    const taskId = 'task-123';
    const filename = 'test.txt';
    const data = Buffer.from('hello world');

    const storagePath = saveFile(taskId, filename, data);
    assert.strictEqual(storagePath, path.join(taskId, filename));

    const fullPath = path.join(TEST_UPLOAD_DIR, taskId, filename);
    assert.ok(fs.existsSync(fullPath), 'File should exist on disk');

    const content = fs.readFileSync(fullPath);
    assert.deepStrictEqual(content, data);
  });

  it('readFile reads file content', () => {
    const taskId = 'task-456';
    const filename = 'data.bin';
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);

    saveFile(taskId, filename, data);
    const storagePath = path.join(taskId, filename);

    const content = readFile(storagePath);
    assert.deepStrictEqual(content, data);
  });

  it('removeFile deletes the file', () => {
    const taskId = 'task-789';
    const filename = 'remove-me.txt';
    const data = Buffer.from('delete this');

    saveFile(taskId, filename, data);
    const storagePath = path.join(taskId, filename);

    const fullPath = path.join(TEST_UPLOAD_DIR, taskId, filename);
    assert.ok(fs.existsSync(fullPath), 'File should exist before removal');

    removeFile(storagePath);
    assert.ok(!fs.existsSync(fullPath), 'File should not exist after removal');
  });

  it('removeFile does not throw for non-existent file', () => {
    assert.doesNotThrow(() => {
      removeFile('nonexistent/file.txt');
    });
  });

  it('readFile throws for non-existent file', () => {
    assert.throws(() => {
      readFile('nonexistent/file.txt');
    });
  });

  it('rejects local filesystem storage in production-like mode', () => {
    const workDir = path.resolve(__dirname, '..');
    const script = `
      import('./src/storage.ts').then((storage) => {
        try {
          const saveFile = storage.saveFile || storage.default?.saveFile;
          saveFile('task-prod', 'proof.txt', Buffer.from('proof'));
          process.exit(2);
        } catch (err) {
          console.log(String(err.message));
        }
      });
    `;

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: workDir,
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local filesystem file storage is disabled/);
  });
});
