import fs from 'fs/promises';
import path from 'path';

import { restoredRecord, validateConversationalEntities } from '../conversation/portable';
import {
  ENTITY_SPECS,
  EXPORT_FORMAT_VERSION,
  OMITTED_ENTITIES,
  REDACTIONS,
  SCHEMA_VERSION,
  sha256,
} from './portable';
import {
  VALID_ARTIFACT_DATA_CLASSES,
  VALID_ARTIFACT_SOURCE_TYPES,
  VALID_ARTIFACT_STATUSES,
  VALID_ARTIFACT_STORAGE_PROVIDERS,
  VALID_ARTIFACT_TYPES,
  VALID_ASSISTANT_EVENT_ACTIONS,
  VALID_ASSISTANT_JOB_STATUSES,
  VALID_CARD_LIFECYCLE_AUDIT_ACTIONS,
  VALID_INTAKE_ASSISTANT_STATUSES,
  VALID_INTAKE_DATA_CLASSES,
  VALID_INTAKE_PRIORITIES,
  VALID_INTAKE_SOURCES,
  VALID_INTAKE_STATUSES,
  VALID_NOTIFICATION_TYPES,
  VALID_TASK_STATUSES,
  collectIds,
  isRfc3339Instant,
  optionalAssistantExecutionRef,
  optionalBooleanField,
  optionalEnum,
  optionalIntegerField,
  optionalNumberField,
  optionalProofRequirementField,
  optionalRefArrayField,
  optionalReference,
  optionalStringArrayField,
  optionalStringField,
  optionalStringOrObjectField,
  requiredEnum,
  requiredIntegerField,
  requiredTaskHistoryField,
  requireString,
  validateCompletedTaskProof,
  validateDateField,
  validateDateOrTimestampField,
  validateNoSecretPayload,
  validateTaskDefinitionDocContext,
  validateWorkflowPhases,
} from './portableChecks';
import type { ExportEntityName, Manifest } from './portable';
import type { JsonRecord } from './portableMappers';

/**
 * Portable export validation and dry-run import: checksum/count verification
 * of an exported directory, per-entity canonical record validation, and the
 * no-side-effect restore dry run.
 *
 * Extracted verbatim from `export/portable.ts`.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  entityCounts: Record<string, number>;
}
async function readJsonLines(filePath: string): Promise<JsonRecord[]> {
  const content = await fs.readFile(filePath, 'utf8');
  if (content.trim().length === 0) return [];

  return content
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonRecord;
      } catch (err) {
        throw new Error(`${path.basename(filePath)} line ${index + 1} is invalid JSON: ${(err as Error).message}`);
      }
    });
}
export async function validatePortableExport(exportDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const manifestPath = path.join(exportDir, 'manifest.json');
  let manifest: Manifest;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
  } catch (err) {
    return {
      valid: false,
      errors: [`manifest.json is missing or invalid: ${(err as Error).message}`],
      entityCounts: {},
    };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    errors.push(`manifest schema_version must be ${SCHEMA_VERSION}`);
  }
  if (manifest.export_format_version !== EXPORT_FORMAT_VERSION) {
    errors.push(`manifest export_format_version must be ${EXPORT_FORMAT_VERSION}`);
  }
  if (typeof manifest.generated_at !== 'string' || !isRfc3339Instant(manifest.generated_at, true)) {
    errors.push('manifest generated_at must be a UTC RFC3339 date-time');
  }

  const recordsByEntity: Partial<Record<ExportEntityName, JsonRecord[]>> = {};
  const entityCounts: Record<string, number> = {};

  for (const spec of ENTITY_SPECS) {
    const filename = manifest.entity_files?.[spec.name];
    if (!filename) {
      errors.push(`manifest missing entity file for ${spec.name}`);
      continue;
    }

    const filePath = path.join(exportDir, filename);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      errors.push(`${filename} is missing: ${(err as Error).message}`);
      continue;
    }

    const expectedChecksum = manifest.checksums?.[filename];
    const actualChecksum = sha256(content);
    if (expectedChecksum !== actualChecksum) {
      errors.push(`${filename} checksum mismatch`);
    }

    try {
      const records = await readJsonLines(filePath);
      recordsByEntity[spec.name] = records;
      entityCounts[spec.name] = records.length;

      if (manifest.entity_counts?.[spec.name] !== records.length) {
        errors.push(`${spec.name} count mismatch`);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  for (const [index, record] of (recordsByEntity.invoice_records || []).entries()) {
    const context = `invoice_records[${index}]`;
    requireString(record, 'id', errors, context);
    requiredIntegerField(record, 'revision', errors, context, 1);
    requiredEnum(record, 'status', new Set(['pending','confirmed','rejected']), errors, context);
    if (record.PK !== `INVOICE#${record.id}` || record.SK !== record.PK) errors.push(`${context} invalid storage identity`);
    if (!record.source || !record.destinations || !Array.isArray(record.audit)) errors.push(`${context} missing publication provenance or audit`);
  }

  const userIds = collectIds(recordsByEntity.users || [], 'user_id', 'users', errors);
  const taskIds = collectIds(recordsByEntity.tasks || [], 'task_id', 'tasks', errors);
  const cardIds = collectIds(recordsByEntity.cards || [], 'card_id', 'cards', errors);
  const templateIds = collectIds(recordsByEntity.templates || [], 'template_id', 'templates', errors);
  const recurringConfigIds = collectIds(recordsByEntity.recurring_configs || [], 'recurring_config_id', 'recurring_configs', errors);
  const fileIds = collectIds(recordsByEntity.files || [], 'file_id', 'files', errors);
  const artifactIds = collectIds(recordsByEntity.artifacts || [], 'artifact_id', 'artifacts', errors);
  const assistantJobIds = collectIds(recordsByEntity.assistant_jobs || [], 'assistant_job_id', 'assistant_jobs', errors);
  collectIds(recordsByEntity.audit_events || [], 'audit_event_id', 'audit_events', errors);
  const intakeItemIds = collectIds(recordsByEntity.intake_items || [], 'intake_item_id', 'intake_items', errors);
  collectIds(recordsByEntity.notifications || [], 'notification_id', 'notifications', errors);
  const taskFileIds = new Set(
    (recordsByEntity.files || [])
      .map((file) => file.task_id)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
  );
  const approvedArtifactTaskIds = new Set(
    (recordsByEntity.artifacts || [])
      .filter((artifact) => artifact.status === 'approved')
      .map((artifact) => artifact.task_id)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
  );
  const approvedArtifactCardIds = new Set(
    (recordsByEntity.artifacts || [])
      .filter((artifact) => artifact.status === 'approved')
      .map((artifact) => artifact.card_id)
      .filter((cardId): cardId is string => typeof cardId === 'string' && cardId.length > 0)
  );
  const approvedArtifactIds = new Set(
    (recordsByEntity.artifacts || [])
      .filter((artifact) => artifact.status === 'approved')
      .map((artifact) => artifact.artifact_id)
      .filter((artifactId): artifactId is string => typeof artifactId === 'string' && artifactId.length > 0)
  );

  for (const [index, task] of (recordsByEntity.tasks || []).entries()) {
    const context = `tasks[${index}]`;
    requiredIntegerField(task, 'version', errors, context, 1);
    requireString(task, 'description', errors, context);
    validateDateField(task, 'date', errors, context, true);
    const status = requiredEnum(task, 'status', VALID_TASK_STATUSES, errors, context);
    if (status === 'waiting') {
      requireString(task, 'waiting_for', errors, context);
      validateDateOrTimestampField(task, 'follow_up_at', errors, context, true);
    } else {
      validateDateOrTimestampField(task, 'follow_up_at', errors, context);
    }
    validateDateOrTimestampField(task, 'completed_at', errors, context);
    validateDateOrTimestampField(task, 'created_at', errors, context);
    validateDateOrTimestampField(task, 'updated_at', errors, context);
    optionalStringField(task, 'instructions_url', errors, context);
    optionalStringField(task, 'instruction_doc_id', errors, context);
    optionalStringField(task, 'instruction_step_id', errors, context);
    optionalStringField(task, 'phase', errors, context);
    optionalStringArrayField(task, 'systems', errors, context);
    optionalStringArrayField(task, 'source_doc_ids', errors, context);
    optionalIntegerField(task, 'template_offset_days', errors, context);
    optionalBooleanField(task, 'is_milestone', errors, context);
    optionalStringOrObjectField(task, 'validation', errors, context);
    const proofRequirement = optionalProofRequirementField(task, 'proof_requirement', errors, context);
    optionalStringField(task, 'external_status', errors, context);
    optionalRefArrayField(task, 'artifact_refs', 'artifactId', errors, context);
    optionalRefArrayField(task, 'assistant_job_refs', 'assistantJobId', errors, context);
    optionalRefArrayField(task, 'intake_refs', 'intakeItemId', errors, context);
    optionalRefArrayField(task, 'audit_event_refs', 'auditEventId', errors, context);
    requiredTaskHistoryField(task, errors, context);
    optionalReference(task, 'assignee_id', userIds, errors, context);
    optionalReference(task, 'created_by', userIds, errors, context);
    optionalAssistantExecutionRef(task, errors, context);
    optionalStringField(task, 'completed_by', errors, context);
    optionalReference(task, 'card_id', cardIds, errors, context);
    optionalReference(task, 'template_id', templateIds, errors, context);
    optionalReference(task, 'recurring_config_id', recurringConfigIds, errors, context);
    if (Array.isArray(task.assistant_job_refs)) {
      task.assistant_job_refs.forEach((ref, refIndex) => {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          optionalReference(ref as JsonRecord, 'assistantJobId', assistantJobIds, errors, `${context}.assistant_job_refs[${refIndex}]`);
        }
      });
    }
    if (Array.isArray(task.intake_refs)) {
      task.intake_refs.forEach((ref, refIndex) => {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          optionalReference(ref as JsonRecord, 'intakeItemId', intakeItemIds, errors, `${context}.intake_refs[${refIndex}]`);
        }
      });
    }
    validateCompletedTaskProof(task, proofRequirement, taskFileIds, approvedArtifactTaskIds, approvedArtifactCardIds, approvedArtifactIds, errors, context);
  }

  for (const [index, card] of (recordsByEntity.cards || []).entries()) {
    const context = `cards[${index}]`;
    requiredIntegerField(card, 'version', errors, context, 1);
    const taskCount = requiredIntegerField(card, 'task_count', errors, context, 0);
    const openTaskCount = requiredIntegerField(card, 'open_task_count', errors, context, 0);
    if (taskCount !== null && openTaskCount !== null && openTaskCount > taskCount) {
      errors.push(`${context} field open_task_count must not exceed task_count`);
    }
    validateDateField(card, 'anchor_date', errors, context);
    validateDateOrTimestampField(card, 'completed_at', errors, context);
    validateDateOrTimestampField(card, 'created_at', errors, context);
    validateDateOrTimestampField(card, 'updated_at', errors, context);
    optionalReference(card, 'template_id', templateIds, errors, context);
    const completedBy = optionalStringField(card, 'completed_by', errors, context);
    optionalStringField(card, 'active_stage_before_completion', errors, context);
    const status = requiredEnum(card, 'status', new Set(['active', 'archived']), errors, context);
    const stage = requiredEnum(
      card,
      'stage',
      new Set(['preparation', 'announced', 'after-event', 'done']),
      errors,
      context,
    );
    if (status === 'active' && (
      !['preparation', 'announced', 'after-event'].includes(stage || '')
      || taskCount === null
      || openTaskCount === null
      || (taskCount > 0 && openTaskCount === 0)
      || card.completed_at !== undefined
      || card.completed_by !== undefined
      || card.active_stage_before_completion !== undefined
    )) {
      errors.push(`${context} must use the canonical active Card lifecycle shape`);
    }
    if (status === 'archived' && (
      stage !== 'done'
      || taskCount === null
      || taskCount < 1
      || openTaskCount !== 0
      || typeof card.completed_at !== 'string'
      || completedBy === null
      || !['preparation', 'announced', 'after-event'].includes(String(card.active_stage_before_completion || ''))
    )) {
      errors.push(`${context} must use the canonical archived Card lifecycle shape`);
    }
    optionalStringArrayField(card, 'source_doc_ids', errors, context);
    optionalStringField(card, 'emoji', errors, context);
    optionalRefArrayField(card, 'artifact_refs', 'artifactId', errors, context);
    optionalRefArrayField(card, 'assistant_job_refs', 'assistantJobId', errors, context);
    optionalRefArrayField(card, 'intake_refs', 'intakeItemId', errors, context);
    optionalRefArrayField(card, 'audit_event_refs', 'auditEventId', errors, context);
    if (Array.isArray(card.assistant_job_refs)) {
      card.assistant_job_refs.forEach((ref, refIndex) => {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          optionalReference(ref as JsonRecord, 'assistantJobId', assistantJobIds, errors, `${context}.assistant_job_refs[${refIndex}]`);
        }
      });
    }
    if (Array.isArray(card.intake_refs)) {
      card.intake_refs.forEach((ref, refIndex) => {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          optionalReference(ref as JsonRecord, 'intakeItemId', intakeItemIds, errors, `${context}.intake_refs[${refIndex}]`);
        }
      });
    }
  }

  for (const [index, template] of (recordsByEntity.templates || []).entries()) {
    const context = `templates[${index}]`;
    requireString(template, 'name', errors, context);
    requireString(template, 'type', errors, context);
    validateDateOrTimestampField(template, 'created_at', errors, context);
    validateDateOrTimestampField(template, 'updated_at', errors, context);
    optionalStringField(template, 'source_path', errors, context);
    optionalStringField(template, 'source_revision', errors, context);
    optionalStringField(template, 'emoji', errors, context);
    optionalStringArrayField(template, 'source_doc_ids', errors, context);
    optionalBooleanField(template, 'trigger_enabled', errors, context);
    requiredIntegerField(template, 'version', errors, context, 1);
    validateWorkflowPhases(template, errors, context);
    validateTaskDefinitionDocContext(template, errors, context);
  }

  for (const [index, recurring] of (recordsByEntity.recurring_configs || []).entries()) {
    const context = `recurring_configs[${index}]`;
    requireString(recurring, 'description', errors, context);
    requireString(recurring, 'cron_expression', errors, context);
    optionalReference(recurring, 'assignee_id', userIds, errors, context);
    optionalStringField(recurring, 'instructions_url', errors, context);
    optionalStringField(recurring, 'instruction_doc_id', errors, context);
    optionalStringField(recurring, 'instruction_step_id', errors, context);
    optionalStringArrayField(recurring, 'systems', errors, context);
    optionalProofRequirementField(recurring, 'proof_requirement', errors, context);
    optionalStringField(recurring, 'required_link_name', errors, context);
    optionalBooleanField(recurring, 'requires_file', errors, context);
    optionalStringArrayField(recurring, 'tags', errors, context);
    validateDateOrTimestampField(recurring, 'created_at', errors, context);
    validateDateOrTimestampField(recurring, 'updated_at', errors, context);
  }

  for (const [index, file] of (recordsByEntity.files || []).entries()) {
    const context = `files[${index}]`;
    validateDateOrTimestampField(file, 'created_at', errors, context);
    optionalReference(file, 'task_id', taskIds, errors, context);
    optionalReference(file, 'card_id', cardIds, errors, context);
  }

  for (const [index, artifact] of (recordsByEntity.artifacts || []).entries()) {
    const context = `artifacts[${index}]`;
    requireString(artifact, 'type', errors, context);
    requireString(artifact, 'title', errors, context);
    requireString(artifact, 'storage_uri', errors, context);
    optionalEnum(artifact, 'type', VALID_ARTIFACT_TYPES, errors, context);
    const status = optionalEnum(artifact, 'status', VALID_ARTIFACT_STATUSES, errors, context);
    const provider = optionalEnum(artifact, 'storage_provider', VALID_ARTIFACT_STORAGE_PROVIDERS, errors, context);
    optionalEnum(artifact, 'visibility', VALID_ARTIFACT_DATA_CLASSES, errors, context);
    optionalEnum(artifact, 'data_class', VALID_ARTIFACT_DATA_CLASSES, errors, context);
    optionalEnum(artifact, 'source_type', VALID_ARTIFACT_SOURCE_TYPES, errors, context);
    optionalStringField(artifact, 'description', errors, context);
    optionalStringField(artifact, 'filename', errors, context);
    optionalStringField(artifact, 'content_type', errors, context);
    optionalStringField(artifact, 'checksum', errors, context);
    optionalNumberField(artifact, 'size_bytes', errors, context);
    optionalStringArrayField(artifact, 'tags', errors, context);
    validateDateOrTimestampField(artifact, 'created_at', errors, context, true);
    validateDateOrTimestampField(artifact, 'updated_at', errors, context, true);
    validateDateOrTimestampField(artifact, 'reviewed_at', errors, context);
    optionalReference(artifact, 'task_id', taskIds, errors, context);
    optionalReference(artifact, 'card_id', cardIds, errors, context);
    optionalReference(artifact, 'file_id', fileIds, errors, context);
    optionalReference(artifact, 'assistant_job_id', assistantJobIds, errors, context);
    optionalReference(artifact, 'created_by', userIds, errors, context);
    optionalReference(artifact, 'reviewed_by', userIds, errors, context);
    validateNoSecretPayload(artifact, errors, context);
    if ((provider === 's3' || provider === 'local-dev') && typeof artifact.checksum !== 'string') {
      errors.push(`${context} checksum is required for DataOps-owned ${provider} artifacts`);
    }
    if ((status === 'approved' || status === 'rejected') && typeof artifact.reviewed_at !== 'string') {
      errors.push(`${context} reviewed_at is required for reviewed artifacts`);
    }
  }

  for (const [index, job] of (recordsByEntity.assistant_jobs || []).entries()) {
    const context = `assistant_jobs[${index}]`;
    requireString(job, 'assistant_type', errors, context);
    requireString(job, 'title', errors, context);
    const status = optionalEnum(job, 'status', VALID_ASSISTANT_JOB_STATUSES, errors, context);
    optionalReference(job, 'task_id', taskIds, errors, context);
    optionalReference(job, 'card_id', cardIds, errors, context);
    if (job.task_id === undefined && job.card_id === undefined) {
      errors.push(`${context} must reference task_id or card_id`);
    }
    optionalReference(job, 'requested_by', userIds, errors, context);
    optionalReference(job, 'retry_of_job_id', assistantJobIds, errors, context);
    optionalStringArrayField(job, 'output_artifact_ids', errors, context);
    if (Array.isArray(job.output_artifact_ids)) {
      job.output_artifact_ids.forEach((artifactId, artifactIndex) => {
        if (typeof artifactId === 'string' && !artifactIds.has(artifactId)) {
          errors.push(`${context}.output_artifact_ids[${artifactIndex}] references missing artifact_id: ${artifactId}`);
        }
      });
    }
    if (job.input_refs !== undefined && !Array.isArray(job.input_refs)) {
      errors.push(`${context} field input_refs must be an array when present`);
    }
    if (job.log_refs !== undefined && !Array.isArray(job.log_refs)) {
      errors.push(`${context} field log_refs must be an array when present`);
    }
    if (job.approval_required !== undefined && typeof job.approval_required !== 'boolean') {
      errors.push(`${context} field approval_required must be a boolean when present`);
    }
    optionalNumberField(job, 'attempt_count', errors, context);
    optionalNumberField(job, 'max_attempts', errors, context);
    validateDateOrTimestampField(job, 'created_at', errors, context, true);
    validateDateOrTimestampField(job, 'updated_at', errors, context, true);
    validateDateOrTimestampField(job, 'queued_at', errors, context);
    validateDateOrTimestampField(job, 'started_at', errors, context);
    validateDateOrTimestampField(job, 'completed_at', errors, context);
    validateNoSecretPayload(job, errors, context);
    if (job.approval !== undefined) {
      if (job.approval === null || typeof job.approval !== 'object' || Array.isArray(job.approval)) {
        errors.push(`${context} field approval must be an object when present`);
      } else {
        const approval = job.approval as JsonRecord;
        optionalEnum(approval, 'status', new Set(['pending', 'approved', 'rejected']), errors, `${context}.approval`);
        optionalReference(approval, 'decidedBy', userIds, errors, `${context}.approval`);
        validateDateOrTimestampField(approval, 'decidedAt', errors, `${context}.approval`);
        if (status === 'rejected') requireString(approval, 'reason', errors, `${context}.approval`);
      }
    }
    if (status === 'waiting_approval' && job.approval_required === false) {
      errors.push(`${context} cannot wait for approval when approval_required is false`);
    }
  }

  for (const [index, event] of (recordsByEntity.audit_events || []).entries()) {
    const context = `audit_events[${index}]`;
    const action = requireString(event, 'action', errors, context);
    if (action && VALID_CARD_LIFECYCLE_AUDIT_ACTIONS.has(action)) {
      requireString(event, 'actor_id', errors, context);
      requireString(event, 'card_id', errors, context);
      requireString(event, 'trigger_task_id', errors, context);
      requireString(event, 'trigger_kind', errors, context);
      optionalReference(event, 'card_id', cardIds, errors, context);
      for (const field of ['before', 'after']) {
        const snapshot = event[field];
        const snapshotContext = `${context}.${field}`;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          errors.push(`${snapshotContext} must be an object`);
          continue;
        }
        const value = snapshot as JsonRecord;
        requiredEnum(value, 'stage', new Set(['preparation', 'announced', 'after-event', 'done']), errors, snapshotContext);
        requiredEnum(value, 'status', new Set(['active', 'archived']), errors, snapshotContext);
        requiredIntegerField(value, 'taskCount', errors, snapshotContext, 0);
        requiredIntegerField(value, 'openTaskCount', errors, snapshotContext, 0);
      }
    } else {
      requireString(event, 'summary', errors, context);
      if (action && !VALID_ASSISTANT_EVENT_ACTIONS.has(action)) {
        errors.push(`${context} field action has unknown value: ${action}`);
      }
      optionalReference(event, 'assistant_job_id', assistantJobIds, errors, context);
      optionalReference(event, 'actor_id', userIds, errors, context);
    }
    validateDateOrTimestampField(event, 'created_at', errors, context, true);
    validateNoSecretPayload(event, errors, context);
  }

  const seenSourceIds = new Set<string>();
  for (const [index, item] of (recordsByEntity.intake_items || []).entries()) {
    const context = `intake_items[${index}]`;
    requireString(item, 'source', errors, context);
    requireString(item, 'status', errors, context);
    requireString(item, 'title', errors, context);
    requireString(item, 'summary', errors, context);
    validateDateOrTimestampField(item, 'source_received_at', errors, context, true);
    validateDateOrTimestampField(item, 'created_at', errors, context, true);
    validateDateOrTimestampField(item, 'updated_at', errors, context, true);
    validateDateOrTimestampField(item, 'triaged_at', errors, context);
    validateDateOrTimestampField(item, 'archived_at', errors, context);
    validateDateOrTimestampField(item, 'follow_up_at', errors, context);
    validateDateOrTimestampField(item, 'last_follow_up_at', errors, context);
    optionalEnum(item, 'source', VALID_INTAKE_SOURCES, errors, context);
    const status = optionalEnum(item, 'status', VALID_INTAKE_STATUSES, errors, context);
    optionalEnum(item, 'priority', VALID_INTAKE_PRIORITIES, errors, context);
    optionalEnum(item, 'data_class', VALID_INTAKE_DATA_CLASSES, errors, context);
    optionalReference(item, 'created_by', userIds, errors, context);
    optionalReference(item, 'triaged_by', userIds, errors, context);
    optionalReference(item, 'owner_id', userIds, errors, context);
    optionalReference(item, 'assignee_id', userIds, errors, context);
    optionalReference(item, 'duplicate_of_intake_item_id', intakeItemIds, errors, context);
    optionalStringArrayField(item, 'received_channels', errors, context);
    optionalStringArrayField(item, 'task_ids', errors, context);
    optionalStringArrayField(item, 'card_ids', errors, context);
    optionalStringArrayField(item, 'assistant_job_ids', errors, context);
    optionalStringArrayField(item, 'related_intake_item_ids', errors, context);
    optionalStringArrayField(item, 'tags', errors, context);
    optionalStringField(item, 'body_ref', errors, context);
    optionalStringField(item, 'resolution_reason', errors, context);
    optionalStringField(item, 'blocked_reason', errors, context);
    optionalStringField(item, 'waiting_for', errors, context);
    if (typeof item.summary === 'string' && item.summary.length > 1000) {
      errors.push(`${context} summary must be 1000 characters or fewer`);
    }
    if (typeof item.title === 'string' && item.title.length > 160) {
      errors.push(`${context} title must be 160 characters or fewer`);
    }
    if (item.metadata !== undefined && JSON.stringify(item.metadata).length > 4096) {
      errors.push(`${context} metadata must be 4096 bytes or less`);
    }
    if (status === 'duplicate') {
      requireString(item, 'duplicate_of_intake_item_id', errors, context);
      requireString(item, 'resolution_reason', errors, context);
    }
    if (status === 'ignored' || status === 'archived') {
      requireString(item, 'resolution_reason', errors, context);
    }
    if (status === 'blocked') {
      requireString(item, 'blocked_reason', errors, context);
      requireString(item, 'waiting_for', errors, context);
      validateDateOrTimestampField(item, 'follow_up_at', errors, context, true);
    }
    if (typeof item.source === 'string' && typeof item.source_message_id === 'string') {
      const sourceKey = `${item.source}#${item.source_message_id}`;
      if (seenSourceIds.has(sourceKey)) errors.push(`${context} duplicates source/source_message_id: ${sourceKey}`);
      seenSourceIds.add(sourceKey);
    }
    if (Array.isArray(item.task_ids)) {
      item.task_ids.forEach((taskId, taskIndex) => {
        if (typeof taskId === 'string' && !taskIds.has(taskId)) errors.push(`${context}.task_ids[${taskIndex}] references missing task_id: ${taskId}`);
      });
    }
    if (Array.isArray(item.card_ids)) {
      item.card_ids.forEach((cardId, cardIndex) => {
        if (typeof cardId === 'string' && !cardIds.has(cardId)) errors.push(`${context}.card_ids[${cardIndex}] references missing card_id: ${cardId}`);
      });
    }
    if (Array.isArray(item.assistant_job_ids)) {
      item.assistant_job_ids.forEach((jobId, jobIndex) => {
        if (typeof jobId === 'string' && !assistantJobIds.has(jobId)) errors.push(`${context}.assistant_job_ids[${jobIndex}] references missing assistant_job_id: ${jobId}`);
      });
    }
    if (Array.isArray(item.related_intake_item_ids)) {
      item.related_intake_item_ids.forEach((relatedId, relatedIndex) => {
        if (typeof relatedId === 'string' && !intakeItemIds.has(relatedId)) errors.push(`${context}.related_intake_item_ids[${relatedIndex}] references missing intake_item_id: ${relatedId}`);
      });
    }
    if (Array.isArray(item.artifact_refs)) {
      item.artifact_refs.forEach((ref, refIndex) => {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) optionalReference(ref as JsonRecord, 'artifactId', artifactIds, errors, `${context}.artifact_refs[${refIndex}]`);
      });
    }
    if (item.assistant_readiness !== undefined) {
      if (item.assistant_readiness === null || typeof item.assistant_readiness !== 'object' || Array.isArray(item.assistant_readiness)) {
        errors.push(`${context} field assistant_readiness must be an object when present`);
      } else {
        const readiness = item.assistant_readiness as JsonRecord;
        optionalEnum(readiness, 'status', VALID_INTAKE_ASSISTANT_STATUSES, errors, `${context}.assistant_readiness`);
        if (readiness.inputRefs !== undefined && !Array.isArray(readiness.inputRefs)) {
          errors.push(`${context}.assistant_readiness field inputRefs must be an array when present`);
        }
        if (readiness.missingFields !== undefined && !Array.isArray(readiness.missingFields)) {
          errors.push(`${context}.assistant_readiness field missingFields must be an array when present`);
        }
      }
    }
    validateNoSecretPayload(item, errors, context);
  }

  const reminderKeys = new Set<string>();
  for (const [index, notification] of (recordsByEntity.notifications || []).entries()) {
    const context = `notifications[${index}]`;
    const notificationType = optionalEnum(notification, 'notification_type', VALID_NOTIFICATION_TYPES, errors, context);
    requireString(notification, 'message', errors, context);
    if (notificationType === 'follow-up-due') {
      const taskId = optionalStringField(notification, 'task_id', errors, context);
      const intakeItemId = optionalStringField(notification, 'intake_item_id', errors, context);
      if (!taskId && !intakeItemId) {
        errors.push(`${context} follow-up-due requires task_id or intake_item_id`);
      }
      validateDateOrTimestampField(notification, 'due_at', errors, context, true);
      if ((taskId || intakeItemId) && typeof notification.due_at === 'string') {
        const key = `${taskId ? `task:${taskId}` : `intake:${intakeItemId}`}#${notification.due_at}`;
        if (reminderKeys.has(key)) errors.push(`${context} duplicates follow-up reminder key: ${key}`);
        reminderKeys.add(key);
      }
    } else {
      validateDateOrTimestampField(notification, 'due_at', errors, context);
    }
    validateDateOrTimestampField(notification, 'created_at', errors, context);
    optionalReference(notification, 'user_id', userIds, errors, context);
    optionalReference(notification, 'task_id', taskIds, errors, context);
    optionalReference(notification, 'intake_item_id', intakeItemIds, errors, context);
    optionalReference(notification, 'card_id', cardIds, errors, context);
    optionalReference(notification, 'template_id', templateIds, errors, context);
    optionalReference(notification, 'recurring_config_id', recurringConfigIds, errors, context);
    optionalStringOrObjectField(notification, 'metadata', errors, context);
    validateNoSecretPayload(notification, errors, context);
  }

  validateConversationalEntities(
    recordsByEntity as Record<string, JsonRecord[]>,
    errors,
    manifest.generated_at
  );

  const manifestRedactions = new Set(manifest.redactions || []);
  for (const redaction of REDACTIONS) {
    if (!manifestRedactions.has(redaction)) {
      errors.push(`manifest missing redaction marker ${redaction}`);
    }
  }

  const omittedEntities = new Set(manifest.omitted_entities || []);
  for (const omitted of OMITTED_ENTITIES) {
    if (!omittedEntities.has(omitted)) {
      errors.push(`manifest missing omitted entity marker ${omitted}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    entityCounts,
  };
}

export interface DryRunImportResult {
  valid: boolean;
  errors: string[];
  totalRecords: number;
  wouldWrite: Record<string, number>;
  skipped: Record<string, number>;
  wouldInsert: Record<string, number>;
  wouldUpdateForRestoreSafety: Record<string, number>;
  effectsExecuted: 0;
  followUpSummary: {
    blockedIntakeItems: number;
    standaloneBlockedIntakeItems: number;
    linkedWaitingTasks: number;
    intakeFollowUpNotifications: number;
  };
}

/**
 * Validate an export and report what a restore/import would write, without
 * connecting to or mutating any database. This is the safety check before
 * using an export for migration or restore.
 */
export async function dryRunImport(exportDir: string): Promise<DryRunImportResult> {
  const validation = await validatePortableExport(exportDir);
  const wouldWrite: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const wouldInsert: Record<string, number> = {};
  const wouldUpdateForRestoreSafety: Record<string, number> = {};
  const recordsByEntity: Partial<Record<ExportEntityName, JsonRecord[]>> = {};
  let totalRecords = 0;

  const manifest = JSON.parse(await fs.readFile(path.join(exportDir, 'manifest.json'), 'utf8')) as Manifest;

  for (const spec of ENTITY_SPECS) {
    const filename = manifest.entity_files?.[spec.name];
    if (!filename) {
      skipped[spec.name] = 0;
      continue;
    }
    const filePath = path.join(exportDir, filename);
    let records: JsonRecord[] = [];
    try {
      records = await readJsonLines(filePath);
    } catch {
      records = [];
    }
    recordsByEntity[spec.name] = records;
    wouldWrite[spec.name] = records.length;
    const adjusted = records.filter((record) => (
      JSON.stringify(restoredRecord(spec.name, record)) !== JSON.stringify(record)
    )).length;
    wouldUpdateForRestoreSafety[spec.name] = adjusted;
    wouldInsert[spec.name] = records.length - adjusted;
    totalRecords += records.length;
  }

  const intakeRecords = recordsByEntity.intake_items || [];
  const taskRecords = recordsByEntity.tasks || [];
  const notificationRecords = recordsByEntity.notifications || [];
  const blockedIntakeItems = intakeRecords.filter((item) => item.status === 'blocked').length;
  const standaloneBlockedIntakeItems = intakeRecords.filter((item) => (
    item.status === 'blocked'
    && (!Array.isArray(item.task_ids) || item.task_ids.length === 0)
  )).length;
  const linkedWaitingTaskIds = new Set(
    intakeRecords.flatMap((item) => (
      Array.isArray(item.task_ids) ? item.task_ids.filter((taskId): taskId is string => typeof taskId === 'string') : []
    ))
  );
  const linkedWaitingTasks = taskRecords.filter((task) => (
    task.status === 'waiting'
    && typeof task.task_id === 'string'
    && linkedWaitingTaskIds.has(task.task_id)
  )).length;
  const intakeFollowUpNotifications = notificationRecords.filter((notification) => (
    notification.notification_type === 'follow-up-due'
    && typeof notification.intake_item_id === 'string'
  )).length;

  return {
    valid: validation.valid,
    errors: validation.errors,
    totalRecords,
    wouldWrite,
    skipped,
    wouldInsert,
    wouldUpdateForRestoreSafety,
    effectsExecuted: 0,
    followUpSummary: {
      blockedIntakeItems,
      standaloneBlockedIntakeItems,
      linkedWaitingTasks,
      intakeFollowUpNotifications,
    },
  };
}
