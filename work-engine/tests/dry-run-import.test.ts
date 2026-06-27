import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBundle } from '../src/db/bundles';
import { createTask } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { createUser } from '../src/db/users';
import { dryRunImport, writePortableExport } from '../src/export/portable';

describe('dry-run import', () => {
  let client: DynamoDBDocumentClient;
  let exportDir: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-dryrun-'));
  });

  after(async () => {
    await fs.rm(exportDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('reports would-write counts for a valid export without writing', async () => {
    const user = await createUser(client, { name: 'Ops', email: 'ops@test', passwordHash: 'x' });
    const template = await createTemplate(client, { name: 'Podcast', type: 'podcast' });
    const bundle = await createBundle(client, { title: 'Episode 1', anchorDate: '2026-06-27', templateId: template.id, status: 'active' });
    await createTask(client, {
      description: 'Send follow-up',
      date: '2026-06-20',
      assigneeId: user.id,
      bundleId: bundle.id,
      status: 'waiting',
      waitingFor: 'Guest reply',
      followUpAt: '2026-06-27',
      completedBy: user.id,
      completedAt: '2026-06-20T12:00:00.000Z',
    });

    await writePortableExport(client, exportDir, {
      generatedAt: '2026-06-27T00:00:00.000Z',
      sourceEnvironment: 'test',
      sourceStack: 'test-stack',
      sourceRegion: 'eu-west-1',
      appGitSha: 'test-sha',
    });

    const result = await dryRunImport(exportDir);

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.wouldWrite.users, 1);
    assert.strictEqual(result.wouldWrite.tasks, 1);
    assert.strictEqual(result.wouldWrite.bundles, 1);
    assert.strictEqual(result.wouldWrite.templates, 1);
    assert.ok(result.totalRecords >= 4, `expected >= 4 records, got ${result.totalRecords}`);
  });

  it('fails validation and reports errors for a broken export', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-dryrun-broken-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });
      // Tamper: add a file with a broken task reference
      await fs.writeFile(
        path.join(brokenDir, 'files.jsonl'),
        JSON.stringify({
          file_id: 'file-broken',
          task_id: 'missing-task',
          filename: 'proof.txt',
          storage_uri: 'uploads/missing/proof.txt',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );

      const result = await dryRunImport(brokenDir);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('checksum mismatch')));
      assert.ok(result.errors.some((e) => e.includes('missing task_id: missing-task')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });

  it('preserves waiting/follow-up fields in the export', async () => {
    const tasksJsonl = await fs.readFile(path.join(exportDir, 'tasks.jsonl'), 'utf8');
    assert.match(tasksJsonl, /"waiting_for":"Guest reply"/);
    assert.match(tasksJsonl, /"follow_up_at":"2026-06-27"/);
  });
});
