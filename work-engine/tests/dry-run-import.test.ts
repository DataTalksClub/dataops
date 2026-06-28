import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBundle } from '../src/db/bundles';
import { createIntakeItem } from '../src/db/intake';
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
    const task = await createTask(client, {
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
    await createIntakeItem(client, {
      id: 'dry-run-intake',
      source: 'manual',
      sourceReceivedAt: '2026-06-20T09:00:00.000Z',
      status: 'attached',
      title: 'Dry-run intake',
      summary: 'Safe intake context',
      receivedChannels: ['manual'],
      taskIds: [task.id],
      bundleIds: [bundle.id],
      tags: ['restore'],
      priority: 'normal',
      dataClass: 'internal',
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
    assert.strictEqual(result.wouldWrite.intake_items, 1);
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
      await fs.writeFile(
        path.join(brokenDir, 'intake_items.jsonl'),
        JSON.stringify({
          intake_item_id: 'intake-broken',
          source: 'manual',
          source_received_at: '2026-06-27T00:00:00.000Z',
          status: 'attached',
          title: 'Broken intake',
          summary: 'References a missing task',
          task_ids: ['missing-task'],
          created_at: '2026-06-27T00:00:00.000Z',
          updated_at: '2026-06-27T00:00:00.000Z',
          priority: 'normal',
          data_class: 'internal',
        }) + '\n',
        'utf8'
      );

      const result = await dryRunImport(brokenDir);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('checksum mismatch')));
      assert.ok(result.errors.some((e) => e.includes('missing task_id: missing-task')));
      assert.ok(result.errors.some((e) => e.includes('intake_items[0].task_ids[0] references missing task_id: missing-task')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });

  it('preserves waiting/follow-up fields in the export', async () => {
    const tasksJsonl = await fs.readFile(path.join(exportDir, 'tasks.jsonl'), 'utf8');
    assert.match(tasksJsonl, /"waiting_for":"Guest reply"/);
    assert.match(tasksJsonl, /"follow_up_at":"2026-06-27"/);
  });

  it('reports invalid waiting and reminder records before import', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-dryrun-invalid-state-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });
      await fs.writeFile(
        path.join(brokenDir, 'tasks.jsonl'),
        JSON.stringify({
          task_id: 'task-invalid-waiting',
          description: 'Waiting task without metadata',
          date: '2026-99-99',
          status: 'waiting',
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(brokenDir, 'notifications.jsonl'),
        JSON.stringify({
          notification_id: 'notification-invalid-type',
          notification_type: 'not-a-real-reminder',
          message: 'Unknown type',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );

      const result = await dryRunImport(brokenDir);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.wouldWrite.tasks, 1);
      assert.strictEqual(result.wouldWrite.notifications, 1);
      assert.ok(result.errors.some((e) => e.includes('tasks[0] missing required string field waiting_for')));
      assert.ok(result.errors.some((e) => e.includes('tasks[0] field date must be a YYYY-MM-DD date')));
      assert.ok(result.errors.some((e) => e.includes('notifications[0] field notification_type has unknown value: not-a-real-reminder')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });
});
