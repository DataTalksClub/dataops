import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { appendAssistantJobEvent, createAssistantJob, updateAssistantJob } from '../src/db/assistantJobs';
import { createBundle } from '../src/db/bundles';
import { createArtifact } from '../src/db/artifacts';
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
      name: 'Representative workflow',
      type: 'workflow',
      phases: [
        { id: 'preparation', name: 'Preparation', stage: 'preparation' },
      ],
      sourceDocIds: ['workflow.definition.example'],
      taskDefinitions: [
        {
          refId: 'send-follow-up',
          description: 'Send external follow-up',
          offsetDays: -7,
          instructionDocId: 'sop.workflow.collect-inputs',
          instructionStepId: '4',
          phase: 'preparation',
          systems: ['google-drive'],
          validation: { requiredEvidence: 'Source document link' },
          requiredLinkName: 'Source document',
          proofRequirement: { type: 'url', label: 'Source document' },
          artifactRefs: [{ artifactId: 'artifact-template-ref', type: 'document' }],
          assistantJobRefs: [{ assistantJobId: 'assistant-template-ref', assistantType: 'research' }],
          auditEventRefs: [{ auditEventId: 'audit-template-ref', action: 'defined' }],
        },
      ],
    });
    const bundle = await createBundle(client, {
      title: 'Representative workflow run',
      anchorDate: '2026-06-27',
      templateId: template.id,
      status: 'active',
      artifactRefs: [{ artifactId: 'artifact-bundle-ref', type: 'document' }],
      assistantJobRefs: [{ assistantJobId: 'assistant-job-export', assistantType: 'podcast' }],
      auditEventRefs: [{ auditEventId: 'audit-bundle-ref', action: 'created' }],
    });
    const task = await createTask(client, {
      description: 'Send external follow-up',
      date: '2026-06-20',
      assigneeId: user.id,
      bundleId: bundle.id,
      templateId: template.id,
      templateTaskRef: 'send-follow-up',
      source: 'template',
      instructionDocId: 'sop.workflow.collect-inputs',
      instructionStepId: '4',
      phase: 'preparation',
      systems: ['google-drive'],
      validation: { requiredEvidence: 'Source document link' },
      link: 'https://example.com/source-document',
      requiredLinkName: 'Source document',
      proofRequirement: { type: 'url', label: 'Source document' },
      artifactRefs: [{ artifactId: 'artifact-task-ref', type: 'document' }],
      assistantJobRefs: [{ assistantJobId: 'assistant-job-export', assistantType: 'podcast' }],
      auditEventRefs: [{ auditEventId: 'audit-task-ref', action: 'completed' }],
      completedBy: user.id,
      completedAt: '2026-06-20T12:00:00.000Z',
      status: 'done',
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
    const assistantJob = await createAssistantJob(client, {
      id: 'assistant-job-export',
      assistantType: 'podcast',
      title: 'Podcast prep assistant',
      status: 'waiting_approval',
      taskId: task.id,
      bundleId: bundle.id,
      requestedBy: user.id,
      inputRefs: [{ type: 'task', id: task.id }],
      outputArtifactIds: [],
      logRefs: [{ artifactId: 'artifact-log-export', title: 'Dry-run log' }],
      approvalRequired: true,
      approval: { status: 'pending' },
      attemptCount: 1,
      maxAttempts: 2,
      queuedAt: '2026-06-20T11:00:00.000Z',
      startedAt: '2026-06-20T11:01:00.000Z',
    });
    const artifact = await createArtifact(client, {
      type: 'external-link',
      title: 'Reviewed source artifact',
      description: 'Public proof URL registered as artifact metadata',
      status: 'approved',
      storageProvider: 'external-url',
      storageUri: 'https://example.com/source-document',
      dataClass: 'public',
      visibility: 'public',
      taskId: task.id,
      bundleId: bundle.id,
      assistantJobId: assistantJob.id,
      sourceType: 'manual-link',
      createdBy: user.id,
      reviewedBy: user.id,
      reviewedAt: '2026-06-20T12:00:00.000Z',
      tags: ['proof'],
      metadata: { source: 'operator' },
    });
    await updateAssistantJob(client, assistantJob.id, { outputArtifactIds: [artifact.id] });
    await appendAssistantJobEvent(client, {
      assistantJobId: assistantJob.id,
      actorId: user.id,
      action: 'approval-requested',
      summary: 'Assistant output is ready for review',
      metadata: { artifactIds: [artifact.id] },
      createdAt: '2026-06-20T11:02:00.000Z',
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
    assert.strictEqual(result.manifest.entity_counts.artifacts, 1);
    assert.strictEqual(result.manifest.entity_counts.assistant_jobs, 1);
    assert.strictEqual(result.manifest.entity_counts.audit_events, 1);
    assert.strictEqual(result.manifest.entity_counts.notifications, 1);
    assert.ok(result.manifest.redactions.includes('users.password_hash'));
    assert.ok(result.manifest.omitted_entities.includes('sessions'));
    assert.ok(!result.manifest.omitted_entities.includes('artifacts'));
    assert.ok(!result.manifest.omitted_entities.includes('assistant_jobs'));
    assert.ok(!result.manifest.omitted_entities.includes('audit_events'));

    const usersJsonl = await fs.readFile(path.join(exportDir, 'users.jsonl'), 'utf8');
    assert.match(usersJsonl, /"user_id"/);
    assert.doesNotMatch(usersJsonl, /passwordHash|password_hash|must-not-export/);

    const tasksJsonl = await fs.readFile(path.join(exportDir, 'tasks.jsonl'), 'utf8');
    assert.match(tasksJsonl, /"task_id"/);
    assert.match(tasksJsonl, /"assignee_id"/);
    assert.match(tasksJsonl, /"instruction_doc_id":"sop.workflow.collect-inputs"/);
    assert.match(tasksJsonl, /"instruction_step_id":"4"/);
    assert.match(tasksJsonl, /"phase":"preparation"/);
    assert.match(tasksJsonl, /"systems":\["google-drive"\]/);
    assert.match(tasksJsonl, /"validation":\{"requiredEvidence":"Source document link"\}/);
    assert.match(tasksJsonl, /"template_id"/);
    assert.match(tasksJsonl, /"template_task_ref":"send-follow-up"/);
    assert.match(tasksJsonl, /"proof_requirement":\{"type":"url","label":"Source document"\}/);
    assert.match(tasksJsonl, /"required_link_name":"Source document"/);
    assert.match(tasksJsonl, /"link":"https:\/\/example.com\/source-document"/);
    assert.match(tasksJsonl, /"artifact_refs":\[\{"artifactId":"artifact-task-ref","type":"document"\}\]/);
    assert.match(tasksJsonl, /"assistant_job_refs":\[\{"assistantJobId":"assistant-job-export","assistantType":"podcast"\}\]/);
    assert.match(tasksJsonl, /"audit_event_refs":\[\{"auditEventId":"audit-task-ref","action":"completed"\}\]/);
    assert.match(tasksJsonl, /"completed_by"/);
    assert.match(tasksJsonl, /"completed_at":"2026-06-20T12:00:00.000Z"/);
    assert.doesNotMatch(tasksJsonl, /"PK"|"SK"/);

    const bundlesJsonl = await fs.readFile(path.join(exportDir, 'bundles.jsonl'), 'utf8');
    assert.match(bundlesJsonl, /"artifact_refs":\[\{"artifactId":"artifact-bundle-ref","type":"document"\}\]/);
    assert.match(bundlesJsonl, /"assistant_job_refs":\[\{"assistantJobId":"assistant-job-export","assistantType":"podcast"\}\]/);
    assert.match(bundlesJsonl, /"audit_event_refs":\[\{"auditEventId":"audit-bundle-ref","action":"created"\}\]/);

    const templatesJsonl = await fs.readFile(path.join(exportDir, 'templates.jsonl'), 'utf8');
    assert.match(templatesJsonl, /"phases":\[\{"id":"preparation","name":"Preparation","stage":"preparation"\}\]/);
    assert.match(templatesJsonl, /"source_doc_ids":\["workflow.definition.example"\]/);
    assert.match(templatesJsonl, /"instructionDocId":"sop.workflow.collect-inputs"/);
    assert.match(templatesJsonl, /"proofRequirement":\{"type":"url","label":"Source document"\}/);

    const notificationsJsonl = await fs.readFile(path.join(exportDir, 'notifications.jsonl'), 'utf8');
    assert.match(notificationsJsonl, /"notification_type":"follow-up-due"/);
    assert.match(notificationsJsonl, /"due_at":"2026-06-21T09:00:00.000Z"/);

    const filesJsonl = await fs.readFile(path.join(exportDir, 'files.jsonl'), 'utf8');
    assert.match(filesJsonl, /"storage_uri":"uploads\/.*\/proof.txt"/);

    const artifactsJsonl = await fs.readFile(path.join(exportDir, 'artifacts.jsonl'), 'utf8');
    assert.match(artifactsJsonl, /"artifact_id"/);
    assert.match(artifactsJsonl, /"storage_uri":"https:\/\/example.com\/source-document"/);
    assert.match(artifactsJsonl, /"status":"approved"/);
    assert.match(artifactsJsonl, /"task_id"/);
    assert.match(artifactsJsonl, /"bundle_id"/);
    assert.match(artifactsJsonl, /"assistant_job_id":"assistant-job-export"/);
    assert.match(artifactsJsonl, /"metadata":\{"source":"operator"\}/);
    assert.doesNotMatch(artifactsJsonl, /binary|password|token/i);

    const assistantJobsJsonl = await fs.readFile(path.join(exportDir, 'assistant_jobs.jsonl'), 'utf8');
    assert.match(assistantJobsJsonl, /"assistant_job_id":"assistant-job-export"/);
    assert.match(assistantJobsJsonl, /"assistant_type":"podcast"/);
    assert.match(assistantJobsJsonl, /"status":"waiting_approval"/);
    assert.match(assistantJobsJsonl, /"output_artifact_ids":\["/);
    assert.doesNotMatch(assistantJobsJsonl, /password|token|secret/i);

    const auditEventsJsonl = await fs.readFile(path.join(exportDir, 'audit_events.jsonl'), 'utf8');
    assert.match(auditEventsJsonl, /"assistant_job_id":"assistant-job-export"/);
    assert.match(auditEventsJsonl, /"action":"approval-requested"/);
    assert.doesNotMatch(auditEventsJsonl, /password|token|secret/i);

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
      await fs.writeFile(
        path.join(brokenDir, 'artifacts.jsonl'),
        JSON.stringify({
          artifact_id: 'artifact-broken',
          type: 'external-link',
          title: 'Broken artifact',
          status: 'approved',
          storage_provider: 'external-url',
          storage_uri: 'https://example.com/proof',
          task_id: 'missing-task',
          reviewed_at: '2026-06-27T00:00:00.000Z',
          created_at: '2026-06-27T00:00:00.000Z',
          updated_at: '2026-06-27T00:00:00.000Z',
          source_type: 'manual-link',
          data_class: 'public',
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
          status: 'done',
          instruction_doc_id: 123,
          systems: ['github', 42],
          validation: ['not-valid'],
          proof_requirement: { type: 'url' },
          created_at: 123,
          updated_at: 'not-a-timestamp',
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(brokenDir, 'templates.jsonl'),
        JSON.stringify({
          template_id: 'template-broken-doc-context',
          name: 'Broken doc context',
          type: 'podcast',
          source_doc_ids: ['task-template.tasks.podcast', 42],
          task_definitions: [
            {
              refId: 'broken',
              description: 'Broken',
              offsetDays: 0,
              instructionDocId: 42,
              systems: ['github', 42],
              validation: ['not-valid'],
              proofRequirement: { type: 'unsupported' },
              artifactRefs: [{ type: 'missing-id' }],
              assistantJobRefs: [{ assistantType: 'missing-id' }],
              auditEventRefs: [{ action: 'missing-id' }],
            },
          ],
          created_at: '2026-06-27T00:00:00.000Z',
          updated_at: '2026-06-27T00:00:00.000Z',
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
      await fs.writeFile(
        path.join(brokenDir, 'artifacts.jsonl'),
        JSON.stringify({
          artifact_id: 'artifact-invalid',
          type: 'bad-type',
          title: '',
          status: 'bad-status',
          storage_provider: 's3',
          storage_uri: 'https://example.com/private?token=abc',
          task_id: 'task-waiting-broken',
          file_id: 'missing-file',
          data_class: 'secret',
          source_type: 'bad-source',
          metadata: { accessToken: 'not-exportable' },
          created_at: 'not-a-date',
          updated_at: 123,
        }) + '\n',
        'utf8'
      );

      const validation = await validatePortableExport(brokenDir);

      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field waiting_for')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field follow_up_at')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field date must be a YYYY-MM-DD date')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field instruction_doc_id must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field systems must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field validation must be a string or object when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] cannot be done without required url proof')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field created_at must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field updated_at must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0] field source_doc_ids must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field instructionDocId must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field systems must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field validation must be a string or object when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field proofRequirement.type must be one of')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].artifactRefs[0] missing required string field artifactId')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].assistantJobRefs[0] missing required string field assistantJobId')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].auditEventRefs[0] missing required string field auditEventId')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[0] field notification_type has unknown value: unknown-reminder')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[1] missing required string field due_at')));
      assert.ok(validation.errors.some((error) => error.includes('notifications[2] field due_at must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0] field type has unknown value: bad-type')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0] field status has unknown value: bad-status')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0] field data_class has unknown value: secret')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0] field source_type has unknown value: bad-source')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0].storage_uri must not contain signed URLs or tokens')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0].metadata.accessToken must not contain secrets')));
      assert.ok(validation.errors.some((error) => error.includes('artifacts[0] checksum is required for DataOps-owned s3 artifacts')));
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
