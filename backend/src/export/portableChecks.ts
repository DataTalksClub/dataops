/**
 * Field-level checks for portable export validation: string, enum, reference,
 * number, and array field validators; secret and signed-URL payload scanning;
 * the entity-level validators (task history, assistant execution refs, proof
 * requirements, template phases and task definitions, completed-task proofs);
 * and the RFC3339/date vocabulary shared by the export writer and validator.
 *
 * Extracted verbatim from `export/portable.ts`.
 */

import type { JsonRecord, JsonValue } from './portableMappers';

export const VALID_TASK_STATUSES = new Set(['todo', 'waiting', 'done', 'archived']);
const VALID_ACTIVE_CARD_STAGES = new Set(['preparation', 'announced', 'after-event']);
const VALID_TASK_HISTORY_ACTIONS = new Set([
  'waiting-started',
  'follow-up-sent',
  'response-received',
  'unblocked',
  'wait-resolved',
  'completed',
  'reopened',
  'template-retired',
  'template-restored',
]);
export const VALID_NOTIFICATION_TYPES = new Set([
  'task-due',
  'task-overdue',
  'follow-up-due',
  'missing-evidence',
  'recurring-due',
  'stage-change',
  'automation-failure',
]);
const VALID_PROOF_REQUIREMENT_TYPES = new Set(['url', 'file', 'artifact', 'comment', 'external-status']);
export const VALID_ARTIFACT_TYPES = new Set(['podcast-doc', 'transcript', 'recording', 'report', 'invoice', 'event-page', 'assistant-output', 'external-link', 'other']);
export const VALID_ARTIFACT_STATUSES = new Set(['draft', 'needs-review', 'approved', 'rejected', 'archived', 'superseded']);
export const VALID_ARTIFACT_STORAGE_PROVIDERS = new Set(['s3', 'dropbox', 'google-drive', 'github', 'external-url', 'local-dev', 'unknown']);
export const VALID_ARTIFACT_DATA_CLASSES = new Set(['public', 'internal', 'private', 'sensitive']);
export const VALID_ARTIFACT_SOURCE_TYPES = new Set(['manual-link', 'manual-upload', 'assistant-output', 'import', 'migration', 'system']);
export const VALID_ASSISTANT_JOB_STATUSES = new Set(['draft', 'queued', 'running', 'waiting_approval', 'approved', 'rejected', 'retrying', 'succeeded', 'failed', 'canceled']);
export const VALID_ASSISTANT_EVENT_ACTIONS = new Set(['created', 'queued', 'started', 'log-appended', 'artifact-attached', 'approval-requested', 'approved', 'rejected', 'retry-requested', 'failed', 'canceled', 'succeeded']);
export const VALID_CARD_LIFECYCLE_AUDIT_ACTIONS = new Set(['card-completed', 'card-reactivated']);
export const VALID_INTAKE_SOURCES = new Set(['telegram', 'email', 'manual', 'file', 'link', 'import', 'assistant', 'unknown']);
export const VALID_INTAKE_STATUSES = new Set(['new', 'triaged', 'attached', 'converted', 'ignored', 'duplicate', 'blocked', 'archived']);
export const VALID_INTAKE_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
export const VALID_INTAKE_DATA_CLASSES = new Set(['public', 'internal', 'private', 'sensitive']);
export const VALID_INTAKE_ASSISTANT_STATUSES = new Set(['not-applicable', 'candidate', 'ready', 'submitted', 'blocked']);
const SECRET_EXPORT_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SIGNED_URL_EXPORT_PATTERN = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=|password=|secret=|credential=|api[_-]?key=)/i;
const RFC3339_INSTANT_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?:(?<utcZone>[Zz])|(?<offsetSign>[+-])(?<offsetHours>\d{2}):(?<offsetMinutes>\d{2}))$/;
export function requireString(record: JsonRecord, field: string, errors: string[], context: string): string | null {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${context} missing required string field ${field}`);
    return null;
  }
  return value;
}

export function collectIds(
  records: JsonRecord[],
  idField: string,
  entityName: string,
  errors: string[]
): Set<string> {
  const ids = new Set<string>();

  for (const [index, record] of records.entries()) {
    const id = requireString(record, idField, errors, `${entityName}[${index}]`);
    if (!id) continue;

    if (ids.has(id)) {
      errors.push(`${entityName} has duplicate ${idField}: ${id}`);
    }
    ids.add(id);
  }

  return ids;
}

export function optionalReference(
  record: JsonRecord,
  field: string,
  ids: Set<string>,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    errors.push(`${context} field ${field} must be a string when present`);
    return;
  }
  if (!ids.has(value)) {
    errors.push(`${context} references missing ${field}: ${value}`);
  }
}

export function optionalEnum(
  record: JsonRecord,
  field: string,
  allowedValues: Set<string>,
  errors: string[],
  context: string
): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push(`${context} field ${field} must be a string when present`);
    return null;
  }
  if (!allowedValues.has(value)) {
    errors.push(`${context} field ${field} has unknown value: ${value}`);
    return null;
  }
  return value;
}

export function requiredEnum(
  record: JsonRecord,
  field: string,
  allowedValues: Set<string>,
  errors: string[],
  context: string
): string | null {
  const value = requireString(record, field, errors, context);
  if (value === null) return null;
  if (!allowedValues.has(value)) {
    errors.push(`${context} field ${field} has unknown value: ${value}`);
    return null;
  }
  return value;
}

export function optionalStringField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push(`${context} field ${field} must be a string when present`);
    return null;
  }
  return value;
}

export function optionalStringArrayField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    errors.push(`${context} field ${field} must be an array of strings when present`);
  }
}

export function optionalNumberField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${context} field ${field} must be a finite number when present`);
  }
}

export function optionalIntegerField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string,
  minimum?: number,
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (minimum !== undefined && Number(value) < minimum)) {
    errors.push(`${context} field ${field} must be an integer${minimum === undefined ? '' : ` >= ${minimum}`} when present`);
  }
}

export function requiredIntegerField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string,
  minimum: number,
): number | null {
  const value = record[field];
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    errors.push(`${context} field ${field} must be an integer >= ${minimum}`);
    return null;
  }
  return Number(value);
}

export function optionalBooleanField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'boolean') {
    errors.push(`${context} field ${field} must be a boolean when present`);
  }
}

export function optionalStringOrObjectField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'string') return;
  if (typeof value === 'object' && !Array.isArray(value)) return;
  errors.push(`${context} field ${field} must be a string or object when present`);
}

export function optionalRefArrayField(
  record: JsonRecord,
  field: string,
  idField: string,
  errors: string[],
  context: string
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    errors.push(`${context} field ${field} must be an array when present`);
    return;
  }
  for (const [index, item] of value.entries()) {
    const itemContext = `${context}.${field}[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${itemContext} must be an object`);
      continue;
    }
    const id = (item as JsonRecord)[idField];
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`${itemContext} missing required string field ${idField}`);
    }
  }
}

export function requiredTaskHistoryField(
  task: JsonRecord,
  errors: string[],
  context: string
): void {
  const value = task.task_history;
  if (!Array.isArray(value)) {
    errors.push(`${context} field task_history must be an array`);
    return;
  }
  const seenIds = new Set<string>();
  const taskId = typeof task.task_id === 'string' ? task.task_id : '';
  const cardId = typeof task.card_id === 'string' ? task.card_id : '';
  for (const [index, item] of value.entries()) {
    const itemContext = `${context}.task_history[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${itemContext} must be an object`);
      continue;
    }
    const event = item as JsonRecord;
    const id = requireString(event, 'id', errors, itemContext);
    if (id) {
      if (seenIds.has(id)) errors.push(`${itemContext} has duplicate id: ${id}`);
      seenIds.add(id);
    }
    const eventTaskId = requireString(event, 'taskId', errors, itemContext);
    if (eventTaskId && taskId && eventTaskId !== taskId) {
      errors.push(`${itemContext} taskId must match parent task_id`);
    }
    const eventCardId = optionalStringField(event, 'cardId', errors, itemContext);
    if (eventCardId && cardId && eventCardId !== cardId) {
      errors.push(`${itemContext} cardId must match parent card_id`);
    }
    optionalEnum(event, 'action', VALID_TASK_HISTORY_ACTIONS, errors, itemContext);
    optionalStringField(event, 'actorId', errors, itemContext);
    optionalStringField(event, 'channel', errors, itemContext);
    optionalStringField(event, 'waitingFor', errors, itemContext);
    validateDateOrTimestampField(event, 'followUpAt', errors, itemContext);
    validateDateOrTimestampField(event, 'previousFollowUpAt', errors, itemContext);
    optionalStringField(event, 'note', errors, itemContext);
    validateDateOrTimestampField(event, 'createdAt', errors, itemContext, true);
    validateNoSecretPayload(event, errors, itemContext);
  }
}

export function optionalAssistantExecutionRef(
  task: JsonRecord,
  errors: string[],
  context: string
): void {
  const value = task.assistant_execution_ref;
  if (value === undefined || value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${context} field assistant_execution_ref must be an object when present`);
    return;
  }
  const reference = value as JsonRecord;
  validateNoSecretPayload(reference, errors, `${context}.assistant_execution_ref`);
  const expected = [
    'canonicalPayloadHash',
    'executionAttemptId',
    'proposalId',
    'proposalVersion',
  ];
  if (
    Object.keys(reference).sort().join(',') !== expected.sort().join(',')
    || typeof reference.executionAttemptId !== 'string'
    || reference.executionAttemptId.length === 0
    || typeof reference.proposalId !== 'string'
    || reference.proposalId.length === 0
    || !Number.isSafeInteger(reference.proposalVersion)
    || Number(reference.proposalVersion) < 1
    || typeof reference.canonicalPayloadHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(reference.canonicalPayloadHash)
  ) {
    errors.push(`${context} field assistant_execution_ref is malformed`);
    return;
  }
}

export function optionalProofRequirementField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string
): JsonRecord | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${context} field ${field} must be an object when present`);
    return null;
  }
  const proofRequirement = value as JsonRecord;
  const type = proofRequirement.type;
  if (typeof type !== 'string' || !VALID_PROOF_REQUIREMENT_TYPES.has(type)) {
    errors.push(`${context} field ${field}.type must be one of: ${Array.from(VALID_PROOF_REQUIREMENT_TYPES).join(', ')}`);
  }
  if (proofRequirement.label !== undefined && typeof proofRequirement.label !== 'string') {
    errors.push(`${context} field ${field}.label must be a string when present`);
  }
  if (proofRequirement.required !== undefined && typeof proofRequirement.required !== 'boolean') {
    errors.push(`${context} field ${field}.required must be a boolean when present`);
  }
  return proofRequirement;
}

export function validateNoSecretPayload(record: JsonRecord, errors: string[], context: string): void {
  const stack: Array<{ prefix: string; value: JsonValue }> = [{ prefix: context, value: record }];
  while (stack.length > 0) {
    const current = stack.pop() as { prefix: string; value: JsonValue };
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ prefix: `${current.prefix}[${index}]`, value: item }));
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      const fieldPath = `${current.prefix}.${key}`;
      if (SECRET_EXPORT_PATTERN.test(key)) {
        errors.push(`${fieldPath} must not contain secrets or signed URLs`);
      }
      if (typeof value === 'string' && SIGNED_URL_EXPORT_PATTERN.test(value)) {
        errors.push(`${fieldPath} must not contain signed URLs or tokens`);
      }
      stack.push({ prefix: fieldPath, value });
    }
  }
}

export function validateTaskDefinitionDocContext(
  template: JsonRecord,
  errors: string[],
  context: string
): void {
  const definitions = template.task_definitions;
  if (definitions === undefined || definitions === null) return;
  if (!Array.isArray(definitions)) {
    errors.push(`${context} field task_definitions must be an array when present`);
    return;
  }
  for (const [index, definition] of definitions.entries()) {
    const definitionContext = `${context}.task_definitions[${index}]`;
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      errors.push(`${definitionContext} must be an object`);
      continue;
    }
    const record = definition as JsonRecord;
    requireString(record, 'refId', errors, definitionContext);
    requireString(record, 'description', errors, definitionContext);
    if (!Number.isSafeInteger(record.offsetDays)) {
      errors.push(`${definitionContext} field offsetDays must be an integer`);
    }
    optionalEnum(record, 'stageOnComplete', VALID_ACTIVE_CARD_STAGES, errors, definitionContext);
    for (const field of [
      'assigneeId', 'instructionsUrl', 'instructionDocId',
      'instructionStepId', 'phase', 'requiredLinkName',
    ]) {
      optionalStringField(record, field, errors, definitionContext);
    }
    optionalBooleanField(record, 'isMilestone', errors, definitionContext);
    optionalBooleanField(record, 'requiresFile', errors, definitionContext);
    optionalStringArrayField(record, 'systems', errors, definitionContext);
    optionalStringOrObjectField(record, 'validation', errors, definitionContext);
    optionalProofRequirementField(record, 'proofRequirement', errors, definitionContext);
    optionalRefArrayField(record, 'artifactRefs', 'artifactId', errors, definitionContext);
    optionalRefArrayField(record, 'assistantJobRefs', 'assistantJobId', errors, definitionContext);
    optionalRefArrayField(record, 'intakeRefs', 'intakeItemId', errors, definitionContext);
    optionalRefArrayField(record, 'auditEventRefs', 'auditEventId', errors, definitionContext);
  }
}

export function validateWorkflowPhases(
  template: JsonRecord,
  errors: string[],
  context: string
): void {
  const phases = template.phases;
  if (phases === undefined || phases === null) return;
  if (!Array.isArray(phases)) {
    errors.push(`${context} field phases must be an array when present`);
    return;
  }
  for (const [index, phase] of phases.entries()) {
    const phaseContext = `${context}.phases[${index}]`;
    if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
      errors.push(`${phaseContext} must be an object`);
      continue;
    }
    const record = phase as JsonRecord;
    requireString(record, 'id', errors, phaseContext);
    requireString(record, 'name', errors, phaseContext);
    optionalStringField(record, 'stage', errors, phaseContext);
  }
}

export function validateCompletedTaskProof(
  task: JsonRecord,
  proofRequirement: JsonRecord | null,
  taskFileIds: Set<string>,
  approvedArtifactTaskIds: Set<string>,
  approvedArtifactCardIds: Set<string>,
  approvedArtifactIds: Set<string>,
  errors: string[],
  context: string
): void {
  if (task.status !== 'done') return;

  const requiredLinkName = task.required_link_name;
  if (typeof requiredLinkName === 'string' && requiredLinkName.length > 0) {
    const link = task.link;
    if (typeof link !== 'string' || link.length === 0) {
      errors.push(`${context} cannot be done without required link ${requiredLinkName}`);
    }
  }

  const taskId = typeof task.task_id === 'string' ? task.task_id : null;
  if (task.requires_file === true && taskId && !taskFileIds.has(taskId)) {
    errors.push(`${context} cannot be done without an exported file proof`);
  }

  if (!proofRequirement || proofRequirement.required === false) return;
  const type = proofRequirement.type;
  if (type === 'url' && (typeof task.link !== 'string' || task.link.length === 0)) {
    errors.push(`${context} cannot be done without required url proof`);
  }
  if (type === 'comment' && (typeof task.comment !== 'string' || task.comment.trim().length === 0)) {
    errors.push(`${context} cannot be done without required comment proof`);
  }
  if (type === 'external-status' && (typeof task.external_status !== 'string' || task.external_status.length === 0)) {
    errors.push(`${context} cannot be done without required external-status proof`);
  }
  if (type === 'artifact') {
    const taskArtifactRefIds = Array.isArray(task.artifact_refs)
      ? task.artifact_refs
        .map((ref) => (ref && typeof ref === 'object' && !Array.isArray(ref) ? (ref as JsonRecord).artifactId : null))
        .filter((artifactId): artifactId is string => typeof artifactId === 'string' && artifactId.length > 0)
      : [];
    const taskIdHasApproved = taskId ? approvedArtifactTaskIds.has(taskId) : false;
    const cardId = typeof task.card_id === 'string' ? task.card_id : null;
    const cardIdHasApproved = cardId ? approvedArtifactCardIds.has(cardId) : false;
    const refHasApproved = taskArtifactRefIds.some((artifactId) => approvedArtifactIds.has(artifactId));
    if (!taskIdHasApproved && !cardIdHasApproved && !refHasApproved) {
      errors.push(`${context} cannot be done without required approved artifact proof`);
    }
  }
  if (type === 'file' && taskId && !taskFileIds.has(taskId)) {
    errors.push(`${context} cannot be done without required file proof`);
  }
}

function isIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

export function isRfc3339Instant(value: string, requireUtc = false): boolean {
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match?.groups) return false;

  if (requireUtc && !match.groups.utcZone) return false;
  if (Number(match.groups.second) > 59) return false;
  if (match.groups.offsetHours && Number(match.groups.offsetHours) > 23) return false;
  if (match.groups.offsetMinutes && Number(match.groups.offsetMinutes) > 59) return false;

  // Reapplying the numeric offset recovers the supplied wall-clock fields and
  // prevents JavaScript from rolling invalid dates such as February 30 forward.
  const secondTimestamp = Date.parse(rfc3339SecondBase(value));
  if (Number.isNaN(secondTimestamp)) return false;
  const offsetSign = match.groups.offsetSign === '-' ? -1 : 1;
  const offsetMinutes = (
    Number(match.groups.offsetHours || 0) * 60
    + Number(match.groups.offsetMinutes || 0)
  ) * offsetSign;
  const wallClock = new Date(secondTimestamp + offsetMinutes * 60_000);
  return (
    wallClock.getUTCFullYear() === Number(match.groups.year)
    && wallClock.getUTCMonth() + 1 === Number(match.groups.month)
    && wallClock.getUTCDate() === Number(match.groups.day)
    && wallClock.getUTCHours() === Number(match.groups.hour)
    && wallClock.getUTCMinutes() === Number(match.groups.minute)
    && wallClock.getUTCSeconds() === Number(match.groups.second)
  );
}

function rfc3339SecondBase(value: string): string {
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match?.groups) throw new Error('Value is not an RFC3339 instant');

  const zone = match.groups.utcZone
    ? 'Z'
    : `${match.groups.offsetSign}${match.groups.offsetHours}:${match.groups.offsetMinutes}`;
  return `${match.groups.year}-${match.groups.month}-${match.groups.day}`
    + `T${match.groups.hour}:${match.groups.minute}:${match.groups.second}.000${zone}`;
}

export function canonicalizeRfc3339Instant(value: string): string {
  if (!isRfc3339Instant(value)) {
    throw new Error('generatedAt must be an RFC3339 date-time with millisecond precision');
  }

  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match?.groups) throw new Error('generatedAt must be an RFC3339 date-time with millisecond precision');
  const utcSeconds = new Date(Date.parse(rfc3339SecondBase(value)))
    .toISOString()
    .slice(0, 19);
  const fraction = (match.groups.fraction || '').padEnd(3, '0');
  return `${utcSeconds}.${fraction}Z`;
}

function isParseableDateOrTimestamp(value: string): boolean {
  return isIsoDate(value) || !Number.isNaN(Date.parse(value));
}
export function validateDateField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string,
  required = false
): string | null {
  let value: string | null;
  if (required) {
    value = requireString(record, field, errors, context);
  } else {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
      errors.push(`${context} field ${field} must be a string when present`);
      return null;
    }
    value = raw;
  }
  if (!value) return null;
  if (!isIsoDate(value)) {
    errors.push(`${context} field ${field} must be a YYYY-MM-DD date`);
    return null;
  }
  return value;
}

export function validateDateOrTimestampField(
  record: JsonRecord,
  field: string,
  errors: string[],
  context: string,
  required = false
): string | null {
  let value: string | null;
  if (required) {
    value = requireString(record, field, errors, context);
  } else {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
      errors.push(`${context} field ${field} must be a string when present`);
      return null;
    }
    value = raw;
  }
  if (!value) return null;
  if (!isParseableDateOrTimestamp(value)) {
    errors.push(`${context} field ${field} must be a parseable date or timestamp`);
    return null;
  }
  return value;
}
