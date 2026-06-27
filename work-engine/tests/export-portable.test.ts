import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBundle } from '../src/db/bundles';
import { createFile } from '../src/db/files';
import { createNotification } from '../src/db/notifications';
import { createRecurringConfig } from '../src/db/recurring';
import { createTask } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { createUser } from '../src/db/users';
import { validatePortableExport, writePortableExport } from '../src/export/portable';

describe('portable execution data export', () => {
  let client: DynamoDBDocumentClient;
  let exportDir: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-'));
  });

  after(async () => {
    await fs.rm(exportDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('writes manifest and JSONL files for current execution entities', async () => {
    const user = await createUser(client, {
      name: 'Operations Manager',
      email: 'ops@example.com',
      passwordHash: 'must-not-export',
    });
    const template = await createTemplate(client, {
      name: 'Podcast',
      type: 'podcast',
      taskDefinitions: [
        {
          refId: 'send-follow-up',
          description: 'Send guest follow-up',
          offsetDays: -7,
        },
      ],
    });
    const bundle = await createBundle(client, {
      title: 'Podcast episode',
      anchorDate: '2026-06-27',
      templateId: template.id,
      status: 'active',
    });
    const task = await createTask(client, {
      description: 'Send guest follow-up',
      date: '2026-06-20',
      assigneeId: user.id,
      bundleId: bundle.id,
      source: 'template',
      completedBy: user.id,
      completedAt: '2026-06-20T12:00:00.000Z',
    });
    await createRecurringConfig(client, {
      description: 'Weekly community backup',
      cronExpression: '0 0 * * 1',
      assigneeId: user.id,
    });
    await createFile(client, {
      taskId: task.id,
      bundleId: bundle.id,
      filename: 'proof.txt',
      category: 'document',
      storagePath: `uploads/${task.id}/proof.txt`,
    });
    await createNotification(client, {
      type: 'follow-up-due',
      message: 'Follow up with guest',
      userId: user.id,
      taskId: task.id,
      bundleId: bundle.id,
      templateId: template.id,
      dueAt: '2026-06-21T09:00:00.000Z',
    });

    const result = await writePortableExport(client, exportDir, {
      generatedAt: '2026-06-27T00:00:00.000Z',
      sourceEnvironment: 'test',
      sourceStack: 'test-stack',
      sourceRegion: 'eu-west-1',
      appGitSha: 'test-sha',
    });

    assert.strictEqual(result.manifest.schema_version, 'dataops.execution.v1');
    assert.strictEqual(result.manifest.entity_counts.users, 1);
    assert.strictEqual(result.manifest.entity_counts.tasks, 1);
    assert.strictEqual(result.manifest.entity_counts.bundles, 1);
    assert.strictEqual(result.manifest.entity_counts.templates, 1);
    assert.strictEqual(result.manifest.entity_counts.recurring_configs, 1);
    assert.strictEqual(result.manifest.entity_counts.files, 1);
    assert.strictEqual(result.manifest.entity_counts.notifications, 1);
    assert.ok(result.manifest.redactions.includes('users.password_hash'));
    assert.ok(result.manifest.omitted_entities.includes('sessions'));

    const usersJsonl = await fs.readFile(path.join(exportDir, 'users.jsonl'), 'utf8');
    assert.match(usersJsonl, /"user_id"/);
    assert.doesNotMatch(usersJsonl, /passwordHash|password_hash|must-not-export/);

    const tasksJsonl = await fs.readFile(path.join(exportDir, 'tasks.jsonl'), 'utf8');
    assert.match(tasksJsonl, /"task_id"/);
    assert.match(tasksJsonl, /"assignee_id"/);
    assert.match(tasksJsonl, /"completed_by"/);
    assert.match(tasksJsonl, /"completed_at":"2026-06-20T12:00:00.000Z"/);
    assert.doesNotMatch(tasksJsonl, /"PK"|"SK"/);

    const notificationsJsonl = await fs.readFile(path.join(exportDir, 'notifications.jsonl'), 'utf8');
    assert.match(notificationsJsonl, /"notification_type":"follow-up-due"/);
    assert.match(notificationsJsonl, /"due_at":"2026-06-21T09:00:00.000Z"/);

    const validation = await validatePortableExport(exportDir);
    assert.deepStrictEqual(validation.errors, []);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.entityCounts.tasks, 1);
  });

  it('reports validation errors for broken references', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-broken-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });
      await fs.writeFile(
        path.join(brokenDir, 'files.jsonl'),
        JSON.stringify({
          file_id: 'file-broken',
          task_id: 'missing-task',
          filename: 'proof.txt',
          storage_uri: 'uploads/missing-task/proof.txt',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );

      const validation = await validatePortableExport(brokenDir);
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('checksum mismatch')));
      assert.ok(validation.errors.some((error) => error.includes('missing task_id: missing-task')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });

  it('validates waiting tasks and notification types for restore safety', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-validation-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });

      await fs.writeFile(
        path.join(brokenDir, 'tasks.jsonl'),
        JSON.stringify({
          task_id: 'task-waiting-broken',
          description: 'Waiting without follow-up metadata',
          date: '2026-06-27',
          status: 'waiting',
        }) + '\n',
        'utf8'
      );
      await fs.appendFile(
        path.join(brokenDir, 'tasks.jsonl'),
        JSON.stringify({
          task_id: 'task-invalid-date',
          description: 'Invalid date fields',
          date: '2026-99-99',
          status: 'todo',
          created_at: 123,
          updated_at: 'not-a-timestamp',
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(brokenDir, 'notifications.jsonl'),
        JSON.stringify({
          notification_id: 'notification-broken-type',
          notification_type: 'unknown-reminder',
          message: 'Unknown reminder type',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n'
        + JSON.stringify({
          notification_id: 'notification-followup-broken',
          notification_type: 'follow-up-due',
          message: 'Missing due date',
          task_id: 'task-waiting-broken',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );
      await fs.appendFile(
        path.join(brokenDir, 'notifications.jsonl'),
        JSON.stringify({
          notification_id: 'notification-followup-invalid-date',
          notification_type: 'follow-up-due',
          message: 'Invalid due date',
          task_id: 'task-waiting-broken',
          due_at: 'not-a-date',
          created_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );

      const validation = await validatePortableExport(brokenDir);

      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field waiting_for')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field follow_up_at')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field date must be a YYYY-MM-DD date')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field created_at must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field updated_at must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[0] field notification_type has unknown value: unknown-reminder')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[1] missing required string field due_at')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[2] field due_at must be a parseable date or timestamp')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });

  it('rejects non-string manifest timestamps', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-manifest-date-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });
      const manifestPath = path.join(brokenDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.generated_at = 123;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

      const validation = await validatePortableExport(brokenDir);

      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('manifest generated_at must be a parseable date or timestamp')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
  });
});
