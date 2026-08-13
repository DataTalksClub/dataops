import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { appendAssistantJobEvent, createAssistantJob, updateAssistantJob } from '../src/db/assistantJobs';
import { createCard, getCard, updateCard } from '../src/db/cards';
import { createArtifact } from '../src/db/artifacts';
import { createFile } from '../src/db/files';
import { createIntakeItem } from '../src/db/intake';
import { createNotification } from '../src/db/notifications';
import { createRecurringConfig } from '../src/db/recurring';
import { createTask, updateTask } from '../src/db/tasks';
import { createTemplate, updateTemplate } from '../src/db/templates';
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
    let template = await createTemplate(client, {
      name: 'Representative workflow',
      type: 'workflow',
      sourcePath: 'workflow-templates/representative-workflow.yaml',
      sourceRevision: 'synthetic-source-revision',
      emoji: '🧭',
      phases: [
        { id: 'preparation', name: 'Preparation', stage: 'preparation' },
      ],
      sourceDocIds: ['workflow.definition.example'],
      taskDefinitions: [
        {
          refId: 'send-follow-up',
          description: 'Send external follow-up',
          offsetDays: -7,
          isMilestone: true,
          stageOnComplete: 'announced',
          instructionDocId: 'sop.workflow.collect-inputs',
          instructionStepId: '4',
          phase: 'preparation',
          systems: ['google-drive'],
          validation: { requiredEvidence: 'Source document link' },
          requiredLinkName: 'Source document',
          requiresFile: true,
          proofRequirement: { type: 'url', label: 'Source document' },
          artifactRefs: [{ artifactId: 'artifact-template-ref', type: 'document' }],
          assistantJobRefs: [{ assistantJobId: 'assistant-template-ref', assistantType: 'research' }],
          intakeRefs: [{ intakeItemId: 'intake-template-ref', source: 'manual' }],
          auditEventRefs: [{ auditEventId: 'audit-template-ref', action: 'defined' }],
        },
      ],
    });
    template = (await updateTemplate(client, template.id, { triggerEnabled: true }))!;
    const card = await createCard(client, {
      title: 'Representative workflow run',
      anchorDate: '2026-06-27',
      templateId: template.id,
      sourceDocIds: ['workflow.definition.example'],
      emoji: template.emoji,
      status: 'active',
      artifactRefs: [{ artifactId: 'artifact-card-ref', type: 'document' }],
      assistantJobRefs: [{ assistantJobId: 'assistant-job-export', assistantType: 'podcast' }],
      auditEventRefs: [{ auditEventId: 'audit-card-ref', action: 'created' }],
    });
    const taskHistory = [
      {
        id: 'history-waiting-started',
        taskId: 'task-export-stable',
        cardId: card.id,
        action: 'waiting-started' as const,
        actorId: 'system:task-lifecycle',
        channel: 'email',
        waitingFor: 'Sponsor assets',
        followUpAt: '2026-06-21',
        note: 'Asked sponsor for assets',
        createdAt: '2026-06-20T09:00:00.000Z',
      },
      {
        id: 'history-follow-up-sent',
        taskId: 'task-export-stable',
        cardId: card.id,
        action: 'follow-up-sent' as const,
        actorId: user.id,
        channel: 'email',
        waitingFor: 'Sponsor assets',
        previousFollowUpAt: '2026-06-21',
        followUpAt: '2026-06-22',
        note: 'Sent reminder',
        createdAt: '2026-06-21T09:00:00.000Z',
      },
    ];
    let task = await createTask(client, {
      description: 'Send external follow-up',
      date: '2026-06-20',
      assigneeId: user.id,
      createdBy: user.id,
      assistantExecutionRef: {
        executionAttemptId: 'attempt-export-safe',
        proposalId: 'proposal-export-safe',
        proposalVersion: 1,
        canonicalPayloadHash: `sha256:${'a'.repeat(64)}`,
      },
      cardId: card.id,
      templateId: template.id,
      templateTaskRef: 'send-follow-up',
      templateOffsetDays: -7,
      isMilestone: true,
      sourceDocIds: ['workflow.definition.example'],
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
      completedBy: 'system:task-lifecycle',
      completedAt: '2026-06-20T12:00:00.000Z',
      status: 'done',
      id: 'task-export-stable',
    });
    task = await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: {},
      historyEvents: taskHistory,
    });
    const recurringConfig = await createRecurringConfig(client, {
      description: 'Weekly community backup',
      cronExpression: '0 0 * * 1',
      assigneeId: user.id,
      instructionDocId: 'sop.workflow.collect-inputs',
      instructionStepId: '2',
      systems: ['google-drive'],
      proofRequirement: { type: 'comment', label: 'Backup reviewed', required: false },
      requiredLinkName: 'Backup folder',
      requiresFile: true,
      tags: ['community', 'backup'],
    });
    const recurringTask = await createTask(client, {
      description: 'Weekly community backup',
      date: '2026-06-23',
      assigneeId: user.id,
      source: 'recurring',
      recurringConfigId: recurringConfig.id,
      status: 'todo',
    });
    await createFile(client, {
      taskId: task.id,
      cardId: card.id,
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
      cardId: card.id,
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
      cardId: card.id,
      assistantJobId: assistantJob.id,
      sourceType: 'manual-link',
      createdBy: user.id,
      reviewedBy: user.id,
      reviewedAt: '2026-06-20T12:00:00.000Z',
      tags: ['proof'],
      metadata: { source: 'operator' },
    });
    await updateAssistantJob(client, assistantJob.id, { outputArtifactIds: [artifact.id] });
    const intake = await createIntakeItem(client, {
      id: 'intake-export',
      source: 'manual',
      sourceMessageId: 'manual-export-1',
      sourceReceivedAt: '2026-06-20T10:00:00.000Z',
      createdBy: user.id,
      triagedBy: user.id,
      ownerId: user.id,
      assigneeId: user.id,
      status: 'converted',
      title: 'Exported intake',
      summary: 'Safe bounded operator excerpt with https://example.com/source-document',
      sourceActor: { name: 'Operator' },
      receivedChannels: ['manual'],
      linkRefs: [{ url: 'https://example.com/source-document', normalizedUrl: 'https://example.com/source-document', safetyStatus: 'unchecked' }],
      fileRefs: [{ fileId: 'file-export-ref', filename: 'source.txt', storageUri: 'https://example.com/source-file' }],
      artifactRefs: [{ artifactId: artifact.id, type: artifact.type, title: artifact.title, status: artifact.status }],
      taskIds: [task.id],
      cardIds: [card.id],
      assistantJobIds: [assistantJob.id],
      assistantReadiness: {
        assistantType: 'podcast',
        status: 'submitted',
        inputRefs: [{ type: 'source-message', id: 'intake-export' }],
        missingFields: [],
      },
      tags: ['podcast'],
      priority: 'high',
      dataClass: 'private',
      metadata: { source: 'operator' },
      history: [{
        id: 'intake-history-export',
        action: 'converted-to-task',
        actorId: user.id,
        createdAt: '2026-06-20T10:05:00.000Z',
      }],
    });
    const blockedIntake = await createIntakeItem(client, {
      id: 'intake-export-blocked',
      source: 'manual',
      sourceMessageId: 'manual-export-blocked-1',
      sourceReceivedAt: '2026-06-20T10:30:00.000Z',
      createdBy: user.id,
      triagedBy: user.id,
      status: 'blocked',
      title: 'Blocked intake follow-up',
      summary: 'Bounded follow-up context',
      receivedChannels: ['manual'],
      taskIds: [],
      cardIds: [],
      tags: ['follow-up'],
      priority: 'normal',
      dataClass: 'internal',
      blockedReason: 'Waiting for requester',
      waitingFor: 'Requester',
      followUpAt: '2026-06-21T09:00:00.000Z',
      history: [{
        id: 'intake-history-blocked',
        action: 'blocked',
        actorId: user.id,
        reason: 'Waiting for requester',
        metadata: { waitingFor: 'Requester', followUpAt: '2026-06-21T09:00:00.000Z' },
        createdAt: '2026-06-20T10:35:00.000Z',
      }],
    });
    await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: {
        intakeRefs: [{ intakeItemId: intake.id, source: intake.source, title: intake.title, status: intake.status }],
      },
    });
    const currentCard = await getCard(client, card.id);
    assert.ok(currentCard);
    await updateCard(client, card.id, {
      expectedVersion: currentCard.version,
      patch: { intakeRefs: [{ intakeItemId: intake.id, source: intake.source, title: intake.title, status: intake.status }] },
    });
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
      cardId: card.id,
      templateId: template.id,
      dueAt: '2026-06-21T09:00:00.000Z',
    });
    await createNotification(client, {
      type: 'follow-up-due',
      message: 'Intake follow-up due: Blocked intake follow-up',
      userId: user.id,
      intakeItemId: blockedIntake.id,
      dueAt: '2026-06-21T09:00:00.000Z',
      metadata: { kind: 'intake-follow-up-due' },
    });
    await createNotification(client, {
      type: 'recurring-due',
      message: 'Recurring task generated: Weekly community backup',
      userId: user.id,
      taskId: recurringTask.id,
      recurringConfigId: recurringConfig.id,
      dueAt: '2026-06-23',
      metadata: { recurringConfigId: recurringConfig.id },
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
    assert.strictEqual(result.manifest.entity_counts.tasks, 2);
    assert.strictEqual(result.manifest.entity_counts.cards, 1);
    assert.strictEqual(result.manifest.entity_counts.templates, 1);
    assert.strictEqual(result.manifest.entity_counts.recurring_configs, 1);
    assert.strictEqual(result.manifest.entity_counts.files, 1);
    assert.strictEqual(result.manifest.entity_counts.artifacts, 1);
    assert.strictEqual(result.manifest.entity_counts.assistant_jobs, 1);
    assert.strictEqual(result.manifest.entity_counts.audit_events, 2);
    assert.strictEqual(result.manifest.entity_counts.intake_items, 2);
    assert.strictEqual(result.manifest.entity_counts.notifications, 3);
    assert.ok(result.manifest.redactions.includes('users.password_hash'));
    assert.ok(result.manifest.omitted_entities.includes('sessions'));
    assert.ok(!result.manifest.omitted_entities.includes('artifacts'));
    assert.ok(!result.manifest.omitted_entities.includes('assistant_jobs'));
    assert.ok(!result.manifest.omitted_entities.includes('audit_events'));
    assert.ok(!result.manifest.omitted_entities.includes('intake_items'));

    const usersJsonl = await fs.readFile(path.join(exportDir, 'users.jsonl'), 'utf8');
    assert.match(usersJsonl, /"user_id"/);
    assert.doesNotMatch(usersJsonl, /passwordHash|password_hash|must-not-export/);

    const tasksJsonl = await fs.readFile(path.join(exportDir, 'tasks.jsonl'), 'utf8');
    const taskRecords = tasksJsonl.trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.ok(taskRecords.every((record) => Number.isSafeInteger(record.version) && record.version >= 1));
    assert.ok(taskRecords.every((record) => ['todo', 'waiting', 'done', 'archived'].includes(record.status)));
    assert.ok(taskRecords.every((record) => Array.isArray(record.task_history)));
    assert.match(tasksJsonl, /"task_id"/);
    assert.match(tasksJsonl, /"assignee_id"/);
    assert.match(tasksJsonl, /"created_by"/);
    assert.match(tasksJsonl, /"assistant_execution_ref":\{"executionAttemptId":"attempt-export-safe"/);
    assert.match(tasksJsonl, /"source":"recurring"/);
    assert.match(tasksJsonl, /"recurring_config_id"/);
    assert.match(tasksJsonl, /"instruction_doc_id":"sop.workflow.collect-inputs"/);
    assert.match(tasksJsonl, /"instruction_step_id":"4"/);
    assert.match(tasksJsonl, /"phase":"preparation"/);
    assert.match(tasksJsonl, /"systems":\["google-drive"\]/);
    assert.match(tasksJsonl, /"validation":\{"requiredEvidence":"Source document link"\}/);
    assert.match(tasksJsonl, /"template_id"/);
    assert.match(tasksJsonl, /"template_task_ref":"send-follow-up"/);
    assert.match(tasksJsonl, /"template_offset_days":-7/);
    assert.match(tasksJsonl, /"is_milestone":true/);
    assert.match(tasksJsonl, /"source_doc_ids":\["workflow.definition.example"\]/);
    assert.match(tasksJsonl, /"proof_requirement":\{"type":"url","label":"Source document"\}/);
    assert.match(tasksJsonl, /"required_link_name":"Source document"/);
    assert.match(tasksJsonl, /"link":"https:\/\/example.com\/source-document"/);
    assert.match(tasksJsonl, /"artifact_refs":\[\{"artifactId":"artifact-task-ref","type":"document"\}\]/);
    assert.match(tasksJsonl, /"assistant_job_refs":\[\{"assistantJobId":"assistant-job-export","assistantType":"podcast"\}\]/);
    assert.match(tasksJsonl, /"intake_refs":\[\{"intakeItemId":"intake-export","source":"manual","title":"Exported intake","status":"converted"\}\]/);
    assert.match(tasksJsonl, /"audit_event_refs":\[\{"auditEventId":"audit-task-ref","action":"completed"\}\]/);
    assert.match(tasksJsonl, /"task_history":\[/);
    assert.match(tasksJsonl, /"id":"history-waiting-started"/);
    assert.match(tasksJsonl, /"action":"follow-up-sent"/);
    assert.match(tasksJsonl, /"previousFollowUpAt":"2026-06-21"/);
    assert.match(tasksJsonl, /"completed_by"/);
    assert.match(tasksJsonl, /"completed_at":"2026-06-20T12:00:00.000Z"/);
    assert.doesNotMatch(tasksJsonl, /"PK"|"SK"/);

    const cardsJsonl = await fs.readFile(path.join(exportDir, 'cards.jsonl'), 'utf8');
    assert.match(cardsJsonl, /"version":\d+/);
    assert.match(cardsJsonl, /"task_count":\d+/);
    assert.match(cardsJsonl, /"open_task_count":\d+/);
    assert.match(cardsJsonl, /"artifact_refs":\[\{"artifactId":"artifact-card-ref","type":"document"\}\]/);
    assert.match(cardsJsonl, /"assistant_job_refs":\[\{"assistantJobId":"assistant-job-export","assistantType":"podcast"\}\]/);
    assert.match(cardsJsonl, /"intake_refs":\[\{"intakeItemId":"intake-export","source":"manual","title":"Exported intake","status":"converted"\}\]/);
    assert.match(cardsJsonl, /"audit_event_refs":\[/);
    assert.match(cardsJsonl, /"auditEventId":"audit-card-ref","action":"created"/);
    assert.match(cardsJsonl, /"action":"card-completed"/);
    assert.match(cardsJsonl, /"emoji":"🧭"/);
    assert.match(cardsJsonl, /"source_doc_ids":\["workflow.definition.example"\]/);

    const templatesJsonl = await fs.readFile(path.join(exportDir, 'templates.jsonl'), 'utf8');
    assert.match(templatesJsonl, /"phases":\[\{"id":"preparation","name":"Preparation","stage":"preparation"\}\]/);
    assert.match(templatesJsonl, /"source_doc_ids":\["workflow.definition.example"\]/);
    assert.match(templatesJsonl, /"instructionDocId":"sop.workflow.collect-inputs"/);
    assert.match(templatesJsonl, /"proofRequirement":\{"type":"url","label":"Source document"\}/);
    assert.match(templatesJsonl, /"emoji":"🧭"/);
    assert.match(templatesJsonl, /"version":2/);
    assert.match(templatesJsonl, /"source_path":"workflow-templates\/representative-workflow.yaml"/);
    assert.match(templatesJsonl, /"source_revision":"synthetic-source-revision"/);

    const recurringConfigsJsonl = await fs.readFile(path.join(exportDir, 'recurring_configs.jsonl'), 'utf8');
    assert.match(recurringConfigsJsonl, /"instruction_doc_id":"sop.workflow.collect-inputs"/);
    assert.match(recurringConfigsJsonl, /"instruction_step_id":"2"/);
    assert.match(recurringConfigsJsonl, /"systems":\["google-drive"\]/);
    assert.match(recurringConfigsJsonl, /"proof_requirement":\{"type":"comment","label":"Backup reviewed","required":false\}/);
    assert.match(recurringConfigsJsonl, /"required_link_name":"Backup folder"/);
    assert.match(recurringConfigsJsonl, /"requires_file":true/);
    assert.match(recurringConfigsJsonl, /"tags":\["community","backup"\]/);

    const notificationsJsonl = await fs.readFile(path.join(exportDir, 'notifications.jsonl'), 'utf8');
    assert.match(notificationsJsonl, /"notification_type":"follow-up-due"/);
    assert.match(notificationsJsonl, /"notification_type":"recurring-due"/);
    assert.match(notificationsJsonl, /"intake_item_id":"intake-export-blocked"/);
    assert.match(notificationsJsonl, /"recurring_config_id"/);
    assert.match(notificationsJsonl, /"due_at":"2026-06-21T09:00:00.000Z"/);

    const filesJsonl = await fs.readFile(path.join(exportDir, 'files.jsonl'), 'utf8');
    assert.match(filesJsonl, /"storage_uri":"uploads\/.*\/proof.txt"/);

    const artifactsJsonl = await fs.readFile(path.join(exportDir, 'artifacts.jsonl'), 'utf8');
    assert.match(artifactsJsonl, /"artifact_id"/);
    assert.match(artifactsJsonl, /"storage_uri":"https:\/\/example.com\/source-document"/);
    assert.match(artifactsJsonl, /"status":"approved"/);
    assert.match(artifactsJsonl, /"task_id"/);
    assert.match(artifactsJsonl, /"card_id"/);
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

    const intakeJsonl = await fs.readFile(path.join(exportDir, 'intake_items.jsonl'), 'utf8');
    assert.match(intakeJsonl, /"intake_item_id":"intake-export"/);
    assert.match(intakeJsonl, /"intake_item_id":"intake-export-blocked"/);
    assert.match(intakeJsonl, /"source":"manual"/);
    assert.match(intakeJsonl, /"blocked_reason":"Waiting for requester"/);
    assert.match(intakeJsonl, /"waiting_for":"Requester"/);
    assert.match(intakeJsonl, /"follow_up_at":"2026-06-21T09:00:00.000Z"/);
    assert.match(intakeJsonl, /"task_ids":\["task-export-stable"\]/);
    assert.match(intakeJsonl, /"assistant_job_ids":\["assistant-job-export"\]/);
    assert.match(intakeJsonl, /"assistant_readiness":\{"assistantType":"podcast","status":"submitted"/);
    assert.doesNotMatch(intakeJsonl, /api[_-]?key|access_token|X-Amz-Signature|password/i);

    const validation = await validatePortableExport(exportDir);
    assert.deepStrictEqual(validation.errors, []);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.entityCounts.tasks, 2);
  });

  it('rejects noncanonical portable Task fields and Template completion stages', async () => {
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-canonical-task-'));
    try {
      await fs.cp(exportDir, brokenDir, { recursive: true });

      const tasksPath = path.join(brokenDir, 'tasks.jsonl');
      const tasks = (await fs.readFile(tasksPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(tasks.length >= 2);
      delete tasks[0].version;
      delete tasks[0].status;
      delete tasks[0].task_history;
      tasks[1].version = 0;
      tasks[1].status = 'complete';
      tasks[1].task_history = {};
      const tasksContent = `${tasks.map((record) => JSON.stringify(record)).join('\n')}\n`;
      await fs.writeFile(tasksPath, tasksContent, 'utf8');

      const templatesPath = path.join(brokenDir, 'templates.jsonl');
      const templates = (await fs.readFile(templatesPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const templateWithTasks = templates.find((record) => record.task_definitions?.length > 0);
      assert.ok(templateWithTasks);
      const baseDefinition = templateWithTasks.task_definitions[0];
      templateWithTasks.task_definitions = [
        { ...baseDefinition, refId: 'active-preparation', stageOnComplete: 'preparation' },
        { ...baseDefinition, refId: 'active-announced', stageOnComplete: 'announced' },
        { ...baseDefinition, refId: 'active-after-event', stageOnComplete: 'after-event' },
        { ...baseDefinition, refId: 'invalid-done', stageOnComplete: 'done' },
      ];
      const templatesContent = `${templates.map((record) => JSON.stringify(record)).join('\n')}\n`;
      await fs.writeFile(templatesPath, templatesContent, 'utf8');

      const manifestPath = path.join(brokenDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.checksums['tasks.jsonl'] = `sha256:${crypto.createHash('sha256').update(tasksContent).digest('hex')}`;
      manifest.checksums['templates.jsonl'] = `sha256:${crypto.createHash('sha256').update(templatesContent).digest('hex')}`;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const validation = await validatePortableExport(brokenDir);
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] field version must be an integer >= 1')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field status')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] field task_history must be an array')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field version must be an integer >= 1')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field status has unknown value: complete')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field task_history must be an array')));
      assert.ok(validation.errors.some((error) => error.includes('task_definitions[3] field stageOnComplete has unknown value: done')));
      assert.ok(validation.errors.every((error) => !error.includes('stageOnComplete has unknown value: preparation')));
      assert.ok(validation.errors.every((error) => !error.includes('stageOnComplete has unknown value: announced')));
      assert.ok(validation.errors.every((error) => !error.includes('stageOnComplete has unknown value: after-event')));
    } finally {
      await fs.rm(brokenDir, { recursive: true, force: true });
    }
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
      await fs.appendFile(
        path.join(brokenDir, 'tasks.jsonl'),
        JSON.stringify({
          task_id: 'task-broken-recurring',
          description: 'Broken recurring relationship',
          date: '2026-06-28',
          status: 'todo',
          source: 'recurring',
          recurring_config_id: 'missing-recurring-config',
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(brokenDir, 'cards.jsonl'),
        [
          {
            card_id: 'card-missing-status', version: 1, stage: 'preparation',
            task_count: 0, open_task_count: 0,
          },
          {
            card_id: 'card-missing-stage', version: 1, status: 'active',
            task_count: 0, open_task_count: 0,
          },
          {
            card_id: 'card-mixed-active', version: 1, status: 'active', stage: 'preparation',
            task_count: 0, open_task_count: 0,
            completed_at: '2026-06-27T00:00:00.000Z',
            completed_by: 'system:task-lifecycle',
            active_stage_before_completion: 'preparation',
          },
          {
            card_id: 'card-active-zero-open', version: 1, status: 'active', stage: 'preparation',
            task_count: 1, open_task_count: 0,
          },
          {
            card_id: 'card-empty-archive', version: 1, status: 'archived', stage: 'done',
            task_count: 0, open_task_count: 0,
            completed_at: '2026-06-27T00:00:00.000Z',
            completed_by: 'system:task-lifecycle',
            active_stage_before_completion: 'preparation',
          },
        ].map((record) => JSON.stringify(record)).join('\n') + '\n',
        'utf8'
      );

      const validation = await validatePortableExport(brokenDir);
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.includes('checksum mismatch')));
      assert.ok(validation.errors.some((error) => error.includes('missing task_id: missing-task')));
      assert.ok(validation.errors.some((error) => error.includes('missing recurring_config_id: missing-recurring-config')));
      assert.ok(validation.errors.some((error) => error.includes('cards[0] missing required string field status')));
      assert.ok(validation.errors.some((error) => error.includes('cards[1] missing required string field stage')));
      assert.ok(validation.errors.some((error) => error.includes('cards[2] must use the canonical active Card lifecycle shape')));
      assert.ok(validation.errors.some((error) => error.includes('cards[3] must use the canonical active Card lifecycle shape')));
      assert.ok(validation.errors.some((error) => error.includes('cards[4] must use the canonical archived Card lifecycle shape')));
      assert.ok(validation.errors.every((error) => !error.includes('references missing completed_by')));
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
          template_offset_days: 'seven',
          is_milestone: 'yes',
          source_doc_ids: ['valid', 42],
          instruction_doc_id: 123,
          systems: ['github', 42],
          validation: ['not-valid'],
          assistant_execution_ref: {
            executionAttemptId: 'attempt',
            proposalId: 'proposal',
            proposalVersion: 0,
            canonicalPayloadHash: 'invalid',
            rawToken: 'must-never-echo-this-value',
          },
          proof_requirement: { type: 'url' },
          task_history: [
            {
              id: 'broken-history',
              taskId: 'other-task',
              action: 'unknown-action',
              actorId: 'missing-user',
              followUpAt: 'bad-follow-up-date',
              createdAt: 'not-a-timestamp',
            },
          ],
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
          emoji: 42,
          version: 0,
          source_doc_ids: ['task-template.tasks.podcast', 42],
          task_definitions: [
            {
              refId: 'broken',
              description: 'Broken',
              offsetDays: 'zero',
              isMilestone: 'yes',
              instructionDocId: 42,
              systems: ['github', 42],
              validation: ['not-valid'],
              proofRequirement: { type: 'unsupported' },
              artifactRefs: [{ type: 'missing-id' }],
              assistantJobRefs: [{ assistantType: 'missing-id' }],
              intakeRefs: [{ source: 'missing-id' }],
              auditEventRefs: [{ action: 'missing-id' }],
            },
          ],
          created_at: '2026-06-27T00:00:00.000Z',
          updated_at: '2026-06-27T00:00:00.000Z',
        }) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(brokenDir, 'recurring_configs.jsonl'),
        JSON.stringify({
          recurring_config_id: 'recurring-broken-doc-context',
          description: 'Broken recurring doc context',
          cron_expression: '0 9 * * *',
          instruction_doc_id: 42,
          systems: ['github', 42],
          proof_requirement: { type: 'unsupported' },
          requires_file: 'yes',
          tags: ['daily', 42],
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
      assert.ok(validation.errors.some((error) => error.includes('assistant_execution_ref is malformed')));
      assert.ok(validation.errors.some((error) => error.includes('must not contain secrets')));
      assert.ok(validation.errors.every((error) => !error.includes('must-never-echo-this-value')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field waiting_for')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[0] missing required string field follow_up_at')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field date must be a YYYY-MM-DD date')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field instruction_doc_id must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field systems must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field validation must be a string or object when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field template_offset_days must be an integer')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field is_milestone must be a boolean')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field source_doc_ids must be an array of strings')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1].task_history[0] taskId must match parent task_id')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1].task_history[0] field action has unknown value: unknown-action')));
      assert.ok(validation.errors.every((error) => !error.includes('references missing actorId')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1].task_history[0] field followUpAt must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1].task_history[0] field createdAt must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] cannot be done without required url proof')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field created_at must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('tasks[1] field updated_at must be a parseable date or timestamp')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0] field source_doc_ids must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0] field emoji must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0] field version must be an integer >= 1')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field offsetDays must be an integer')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field isMilestone must be a boolean')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field instructionDocId must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field systems must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field validation must be a string or object when present')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0] field proofRequirement.type must be one of')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].artifactRefs[0] missing required string field artifactId')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].assistantJobRefs[0] missing required string field assistantJobId')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].intakeRefs[0] missing required string field intakeItemId')));
      assert.ok(validation.errors.some((error) => error.includes('templates[0].task_definitions[0].auditEventRefs[0] missing required string field auditEventId')));
      assert.ok(validation.errors.some((error) => error.includes('recurring_configs[0] field instruction_doc_id must be a string when present')));
      assert.ok(validation.errors.some((error) => error.includes('recurring_configs[0] field systems must be an array of strings when present')));
      assert.ok(validation.errors.some((error) => error.includes('recurring_configs[0] field proof_requirement.type must be one of')));
      assert.ok(validation.errors.some((error) => error.includes('recurring_configs[0] field requires_file must be a boolean when present')));
      assert.ok(validation.errors.some((error) => error.includes('recurring_configs[0] field tags must be an array of strings when present')));
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

  it('rejects a portable Template without the required version', async () => {
    const mixedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-export-mixed-template-versions-'));
    try {
      await fs.cp(exportDir, mixedDir, { recursive: true });
      const templatesPath = path.join(mixedDir, 'templates.jsonl');
      const records = (await fs.readFile(templatesPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.ok(records[0]);
      delete records[0].version;
      const content = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
      await fs.writeFile(templatesPath, content, 'utf8');
      const manifestPath = path.join(mixedDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.checksums['templates.jsonl'] = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const validation = await validatePortableExport(mixedDir);
      assert.ok(validation.errors.some((error) => error.includes('templates[0] field version must be an integer >= 1')));
      assert.strictEqual(validation.valid, false);
    } finally {
      await fs.rm(mixedDir, { recursive: true, force: true });
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
