import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  TABLE_BUNDLES,
  TABLE_ARTIFACTS,
  TABLE_FILES,
  TABLE_NOTIFICATIONS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
  TABLE_USERS,
} from '../db/setup';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

interface EntitySpec {
  name: ExportEntityName;
  filename: string;
  tableName: string;
  prefix: string;
  map: (item: Record<string, unknown>) => JsonRecord;
}

interface Manifest {
  schema_version: string;
  generated_at: string;
  source_environment: string;
  source_stack: string;
  source_region: string;
  app_git_sha: string;
  export_format_version: number;
  entity_files: Record<string, string>;
  entity_counts: Record<string, number>;
  checksums: Record<string, string>;
  redactions: string[];
  omitted_entities: string[];
}

interface PortableExportResult {
  manifest: Manifest;
  outputDir: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  entityCounts: Record<string, number>;
}

type ExportEntityName =
  | 'users'
  | 'tasks'
  | 'bundles'
  | 'templates'
  | 'recurring_configs'
  | 'files'
  | 'artifacts'
  | 'notifications';

const SCHEMA_VERSION = 'dataops.execution.v1';
const EXPORT_FORMAT_VERSION = 1;
const OMITTED_ENTITIES = ['sessions', 'assistant_jobs', 'audit_events'];
const REDACTIONS = ['users.password_hash', 'sessions'];
const VALID_TASK_STATUSES = new Set(['todo', 'waiting', 'done', 'archived']);
const VALID_NOTIFICATION_TYPES = new Set([
  'task-due',
  'task-overdue',
  'follow-up-due',
  'missing-evidence',
  'recurring-due',
  'stage-change',
  'automation-failure',
]);
const VALID_PROOF_REQUIREMENT_TYPES = new Set(['url', 'file', 'artifact', 'comment', 'external-status']);
const VALID_ARTIFACT_TYPES = new Set(['podcast-doc', 'transcript', 'recording', 'report', 'invoice', 'event-page', 'assistant-output', 'external-link', 'other']);
const VALID_ARTIFACT_STATUSES = new Set(['draft', 'needs-review', 'approved', 'rejected', 'archived', 'superseded']);
const VALID_ARTIFACT_STORAGE_PROVIDERS = new Set(['s3', 'dropbox', 'google-drive', 'github', 'external-url', 'local-dev', 'unknown']);
const VALID_ARTIFACT_DATA_CLASSES = new Set(['public', 'internal', 'private', 'sensitive']);
const VALID_ARTIFACT_SOURCE_TYPES = new Set(['manual-link', 'manual-upload', 'assistant-output', 'import', 'migration', 'system']);
const SECRET_EXPORT_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SIGNED_URL_EXPORT_PATTERN = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=)/i;

const ENTITY_SPECS: EntitySpec[] = [
  {
    name: 'users',
    filename: 'users.jsonl',
    tableName: TABLE_USERS,
    prefix: 'USER#',
    map: mapUser,
  },
  {
    name: 'tasks',
    filename: 'tasks.jsonl',
    tableName: TABLE_TASKS,
    prefix: 'TASK#',
    map: mapTask,
  },
  {
    name: 'bundles',
    filename: 'bundles.jsonl',
    tableName: TABLE_BUNDLES,
    prefix: 'BUNDLE#',
    map: mapBundle,
  },
  {
    name: 'templates',
    filename: 'templates.jsonl',
    tableName: TABLE_TEMPLATES,
    prefix: 'TEMPLATE#',
    map: mapTemplate,
  },
  {
    name: 'recurring_configs',
    filename: 'recurring_configs.jsonl',
    tableName: TABLE_TASKS,
    prefix: 'RECURRING#',
    map: mapRecurringConfig,
  },
  {
    name: 'files',
    filename: 'files.jsonl',
    tableName: TABLE_FILES,
    prefix: 'FILE#',
    map: mapFile,
  },
  {
    name: 'artifacts',
    filename: 'artifacts.jsonl',
    tableName: TABLE_ARTIFACTS,
    prefix: 'ARTIFACT#',
    map: mapArtifact,
  },
  {
    name: 'notifications',
    filename: 'notifications.jsonl',
    tableName: TABLE_NOTIFICATIONS,
    prefix: 'NOTIFICATION#',
    map: mapNotification,
  },
];

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function jsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) as JsonValue[] : [];
}

function optionalJsonStringOrObject(value: unknown): JsonValue | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }
  return null;
}

function stripEmpty(record: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result;
}

function mapUser(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    user_id: optionalString(item.id),
    name: optionalString(item.name),
    email: optionalString(item.email),
    created_at: optionalString(item.createdAt),
  });
}

function mapTask(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    task_id: optionalString(item.id),
    description: optionalString(item.description),
    date: optionalString(item.date),
    status: optionalString(item.status),
    source: optionalString(item.source),
    comment: optionalString(item.comment),
    waiting_for: optionalString(item.waitingFor),
    follow_up_at: optionalString(item.followUpAt),
    proof_requirement: optionalJsonStringOrObject(item.proofRequirement),
    external_status: optionalString(item.externalStatus),
    instructions_url: optionalString(item.instructionsUrl),
    instruction_doc_id: optionalString(item.instructionDocId),
    instruction_step_id: optionalString(item.instructionStepId),
    phase: optionalString(item.phase),
    systems: stringArray(item.systems),
    validation: optionalJsonStringOrObject(item.validation),
    link: optionalString(item.link),
    required_link_name: optionalString(item.requiredLinkName),
    requires_file: optionalBoolean(item.requiresFile),
    assignee_id: optionalString(item.assigneeId),
    bundle_id: optionalString(item.bundleId),
    template_id: optionalString(item.templateId),
    template_task_ref: optionalString(item.templateTaskRef),
    recurring_config_id: optionalString(item.recurringConfigId),
    stage_on_complete: optionalString(item.stageOnComplete),
    artifact_refs: jsonArray(item.artifactRefs),
    assistant_job_refs: jsonArray(item.assistantJobRefs),
    audit_event_refs: jsonArray(item.auditEventRefs),
    tags: stringArray(item.tags),
    completed_by: optionalString(item.completedBy),
    completed_at: optionalString(item.completedAt),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

function mapBundle(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    bundle_id: optionalString(item.id),
    title: optionalString(item.title),
    description: optionalString(item.description),
    anchor_date: optionalString(item.anchorDate),
    template_id: optionalString(item.templateId),
    status: optionalString(item.status),
    stage: optionalString(item.stage),
    references: jsonArray(item.references),
    bundle_links: jsonArray(item.bundleLinks),
    tags: stringArray(item.tags),
    artifact_refs: jsonArray(item.artifactRefs),
    assistant_job_refs: jsonArray(item.assistantJobRefs),
    audit_event_refs: jsonArray(item.auditEventRefs),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

function mapTemplate(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    template_id: optionalString(item.id),
    name: optionalString(item.name),
    type: optionalString(item.type),
    tags: stringArray(item.tags),
    default_assignee_id: optionalString(item.defaultAssigneeId),
    phases: jsonArray(item.phases),
    source_doc_ids: stringArray(item.sourceDocIds),
    references: jsonArray(item.references),
    bundle_link_definitions: jsonArray(item.bundleLinkDefinitions),
    task_definitions: jsonArray(item.taskDefinitions),
    trigger_type: optionalString(item.triggerType),
    trigger_schedule: optionalString(item.triggerSchedule),
    trigger_lead_days: optionalNumber(item.triggerLeadDays),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

function mapRecurringConfig(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    recurring_config_id: optionalString(item.id),
    description: optionalString(item.description),
    cron_expression: optionalString(item.cronExpression),
    assignee_id: optionalString(item.assigneeId),
    enabled: optionalBoolean(item.enabled),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
  });
}

function mapFile(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    file_id: optionalString(item.id),
    task_id: optionalString(item.taskId),
    bundle_id: optionalString(item.bundleId),
    filename: optionalString(item.filename),
    category: optionalString(item.category),
    tags: stringArray(item.tags),
    storage_uri: optionalString(item.storageUri) || optionalString(item.storagePath),
    storage_provider: optionalString(item.storageProvider),
    content_type: optionalString(item.contentType),
    checksum: optionalString(item.checksum),
    size_bytes: optionalNumber(item.sizeBytes),
    created_at: optionalString(item.createdAt),
  });
}

function mapArtifact(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    artifact_id: optionalString(item.id),
    type: optionalString(item.type),
    title: optionalString(item.title),
    description: optionalString(item.description),
    status: optionalString(item.status),
    storage_provider: optionalString(item.storageProvider),
    storage_uri: optionalString(item.storageUri),
    filename: optionalString(item.filename),
    content_type: optionalString(item.contentType),
    checksum: optionalString(item.checksum),
    size_bytes: optionalNumber(item.sizeBytes),
    visibility: optionalString(item.visibility),
    data_class: optionalString(item.dataClass),
    task_id: optionalString(item.taskId),
    bundle_id: optionalString(item.bundleId),
    assistant_job_id: optionalString(item.assistantJobId),
    file_id: optionalString(item.fileId),
    source_type: optionalString(item.sourceType),
    created_by: optionalString(item.createdBy),
    reviewed_by: optionalString(item.reviewedBy),
    created_at: optionalString(item.createdAt),
    updated_at: optionalString(item.updatedAt),
    reviewed_at: optionalString(item.reviewedAt),
    tags: stringArray(item.tags),
    metadata: optionalJsonStringOrObject(item.metadata),
  });
}

function mapNotification(item: Record<string, unknown>): JsonRecord {
  return stripEmpty({
    notification_id: optionalString(item.id),
    notification_type: optionalString(item.type),
    message: optionalString(item.message),
    user_id: optionalString(item.userId),
    task_id: optionalString(item.taskId),
    bundle_id: optionalString(item.bundleId),
    template_id: optionalString(item.templateId),
    due_at: optionalString(item.dueAt),
    dismissed: optionalBoolean(item.dismissed),
    created_at: optionalString(item.createdAt),
  });
}

async function scanByPrefix(
  client: DynamoDBDocumentClient,
  tableName: string,
  prefix: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': prefix },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    items.push(...((result.Items || []) as Record<string, unknown>[]));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}

function stableStringify(record: JsonRecord): string {
  const ordered: JsonRecord = {};
  for (const key of Object.keys(record).sort()) {
    ordered[key] = record[key];
  }
  return JSON.stringify(ordered);
}

function sha256(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

async function writePortableExport(
  client: DynamoDBDocumentClient,
  outputDir: string,
  options: {
    sourceEnvironment?: string;
    sourceStack?: string;
    sourceRegion?: string;
    appGitSha?: string;
    generatedAt?: string;
  } = {}
): Promise<PortableExportResult> {
  await fs.mkdir(outputDir, { recursive: true });

  const entityFiles: Record<string, string> = {};
  const entityCounts: Record<string, number> = {};
  const checksums: Record<string, string> = {};

  for (const spec of ENTITY_SPECS) {
    const rawItems = await scanByPrefix(client, spec.tableName, spec.prefix);
    const records = rawItems.map(spec.map).sort((a, b) => {
      const left = Object.values(a)[0] || '';
      const right = Object.values(b)[0] || '';
      return String(left).localeCompare(String(right));
    });
    const content = records.map(stableStringify).join('\n') + (records.length > 0 ? '\n' : '');

    await fs.writeFile(path.join(outputDir, spec.filename), content, 'utf8');
    entityFiles[spec.name] = spec.filename;
    entityCounts[spec.name] = records.length;
    checksums[spec.filename] = sha256(content);
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: options.generatedAt || new Date().toISOString(),
    source_environment: options.sourceEnvironment || process.env.DATAOPS_ENV || process.env.NODE_ENV || 'unknown',
    source_stack: options.sourceStack || process.env.AWS_STACK_NAME || 'unknown',
    source_region: options.sourceRegion || process.env.AWS_REGION || 'unknown',
    app_git_sha: options.appGitSha || process.env.GITHUB_SHA || process.env.APP_GIT_SHA || 'unknown',
    export_format_version: EXPORT_FORMAT_VERSION,
    entity_files: entityFiles,
    entity_counts: entityCounts,
    checksums,
    redactions: REDACTIONS,
    omitted_entities: OMITTED_ENTITIES,
  };

  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );

  return { manifest, outputDir };
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

function requireString(record: JsonRecord, field: string, errors: string[], context: string): string | null {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${context} missing required string field ${field}`);
    return null;
  }
  return value;
}

function collectIds(
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

function optionalReference(
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

function optionalEnum(
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

function optionalStringField(
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

function optionalStringArrayField(
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

function optionalNumberField(
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

function optionalStringOrObjectField(
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

function optionalRefArrayField(
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

function optionalProofRequirementField(
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

function validateNoSecretPayload(record: JsonRecord, errors: string[], context: string): void {
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

function validateTaskDefinitionDocContext(
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
    for (const field of ['instructionDocId', 'instructionStepId', 'phase']) {
      optionalStringField(record, field, errors, definitionContext);
    }
    optionalStringArrayField(record, 'systems', errors, definitionContext);
    optionalStringOrObjectField(record, 'validation', errors, definitionContext);
    optionalProofRequirementField(record, 'proofRequirement', errors, definitionContext);
    optionalRefArrayField(record, 'artifactRefs', 'artifactId', errors, definitionContext);
    optionalRefArrayField(record, 'assistantJobRefs', 'assistantJobId', errors, definitionContext);
    optionalRefArrayField(record, 'auditEventRefs', 'auditEventId', errors, definitionContext);
  }
}

function validateWorkflowPhases(
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

function validateCompletedTaskProof(
  task: JsonRecord,
  proofRequirement: JsonRecord | null,
  taskFileIds: Set<string>,
  approvedArtifactTaskIds: Set<string>,
  approvedArtifactBundleIds: Set<string>,
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
    const bundleId = typeof task.bundle_id === 'string' ? task.bundle_id : null;
    const bundleIdHasApproved = bundleId ? approvedArtifactBundleIds.has(bundleId) : false;
    const refHasApproved = taskArtifactRefIds.some((artifactId) => approvedArtifactIds.has(artifactId));
    if (!taskIdHasApproved && !bundleIdHasApproved && !refHasApproved) {
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

function isParseableDateOrTimestamp(value: string): boolean {
  return isIsoDate(value) || !Number.isNaN(Date.parse(value));
}

function validateDateField(
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

function validateDateOrTimestampField(
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

async function validatePortableExport(exportDir: string): Promise<ValidationResult> {
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
  if (typeof manifest.generated_at !== 'string' || !isParseableDateOrTimestamp(manifest.generated_at)) {
    errors.push('manifest generated_at must be a parseable date or timestamp');
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

  const userIds = collectIds(recordsByEntity.users || [], 'user_id', 'users', errors);
  const taskIds = collectIds(recordsByEntity.tasks || [], 'task_id', 'tasks', errors);
  const bundleIds = collectIds(recordsByEntity.bundles || [], 'bundle_id', 'bundles', errors);
  const templateIds = collectIds(recordsByEntity.templates || [], 'template_id', 'templates', errors);
  collectIds(recordsByEntity.recurring_configs || [], 'recurring_config_id', 'recurring_configs', errors);
  const fileIds = collectIds(recordsByEntity.files || [], 'file_id', 'files', errors);
  const artifactIds = collectIds(recordsByEntity.artifacts || [], 'artifact_id', 'artifacts', errors);
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
  const approvedArtifactBundleIds = new Set(
    (recordsByEntity.artifacts || [])
      .filter((artifact) => artifact.status === 'approved')
      .map((artifact) => artifact.bundle_id)
      .filter((bundleId): bundleId is string => typeof bundleId === 'string' && bundleId.length > 0)
  );
  const approvedArtifactIds = new Set(
    (recordsByEntity.artifacts || [])
      .filter((artifact) => artifact.status === 'approved')
      .map((artifact) => artifact.artifact_id)
      .filter((artifactId): artifactId is string => typeof artifactId === 'string' && artifactId.length > 0)
  );

  for (const [index, task] of (recordsByEntity.tasks || []).entries()) {
    const context = `tasks[${index}]`;
    requireString(task, 'description', errors, context);
    validateDateField(task, 'date', errors, context, true);
    const status = optionalEnum(task, 'status', VALID_TASK_STATUSES, errors, context);
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
    optionalStringOrObjectField(task, 'validation', errors, context);
    const proofRequirement = optionalProofRequirementField(task, 'proof_requirement', errors, context);
    optionalStringField(task, 'external_status', errors, context);
    optionalRefArrayField(task, 'artifact_refs', 'artifactId', errors, context);
    optionalRefArrayField(task, 'assistant_job_refs', 'assistantJobId', errors, context);
    optionalRefArrayField(task, 'audit_event_refs', 'auditEventId', errors, context);
    optionalReference(task, 'assignee_id', userIds, errors, context);
    optionalReference(task, 'completed_by', userIds, errors, context);
    optionalReference(task, 'bundle_id', bundleIds, errors, context);
    optionalReference(task, 'template_id', templateIds, errors, context);
    validateCompletedTaskProof(task, proofRequirement, taskFileIds, approvedArtifactTaskIds, approvedArtifactBundleIds, approvedArtifactIds, errors, context);
  }

  for (const [index, bundle] of (recordsByEntity.bundles || []).entries()) {
    const context = `bundles[${index}]`;
    validateDateField(bundle, 'anchor_date', errors, context);
    validateDateOrTimestampField(bundle, 'created_at', errors, context);
    validateDateOrTimestampField(bundle, 'updated_at', errors, context);
    optionalReference(bundle, 'template_id', templateIds, errors, context);
    optionalRefArrayField(bundle, 'artifact_refs', 'artifactId', errors, context);
    optionalRefArrayField(bundle, 'assistant_job_refs', 'assistantJobId', errors, context);
    optionalRefArrayField(bundle, 'audit_event_refs', 'auditEventId', errors, context);
  }

  for (const [index, template] of (recordsByEntity.templates || []).entries()) {
    const context = `templates[${index}]`;
    validateDateOrTimestampField(template, 'created_at', errors, context);
    validateDateOrTimestampField(template, 'updated_at', errors, context);
    optionalStringArrayField(template, 'source_doc_ids', errors, context);
    validateWorkflowPhases(template, errors, context);
    validateTaskDefinitionDocContext(template, errors, context);
  }

  for (const [index, recurring] of (recordsByEntity.recurring_configs || []).entries()) {
    const context = `recurring_configs[${index}]`;
    validateDateOrTimestampField(recurring, 'created_at', errors, context);
    validateDateOrTimestampField(recurring, 'updated_at', errors, context);
  }

  for (const [index, file] of (recordsByEntity.files || []).entries()) {
    const context = `files[${index}]`;
    validateDateOrTimestampField(file, 'created_at', errors, context);
    optionalReference(file, 'task_id', taskIds, errors, context);
    optionalReference(file, 'bundle_id', bundleIds, errors, context);
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
    optionalReference(artifact, 'bundle_id', bundleIds, errors, context);
    optionalReference(artifact, 'file_id', fileIds, errors, context);
    optionalReference(artifact, 'created_by', userIds, errors, context);
    optionalReference(artifact, 'reviewed_by', userIds, errors, context);
    validateNoSecretPayload(artifact, errors, context);
    if ((provider === 's3' || provider === 'local-dev') && typeof artifact.checksum !== 'string') {
      errors.push(`${context} checksum is required for DataOps-owned ${provider} artifacts`);
    }
    if ((status === 'approved' || status === 'rejected') && typeof artifact.reviewed_at !== 'string') {
      errors.push(`${context} reviewed_at is required for reviewed artifacts`);
    }
    if (artifactIds.size > 0) {
      // assistant_job_id is intentionally opaque until assistant_jobs is exported by #30.
      optionalStringField(artifact, 'assistant_job_id', errors, context);
    }
  }

  for (const [index, notification] of (recordsByEntity.notifications || []).entries()) {
    const context = `notifications[${index}]`;
    const notificationType = optionalEnum(notification, 'notification_type', VALID_NOTIFICATION_TYPES, errors, context);
    if (notificationType === 'follow-up-due') {
      requireString(notification, 'task_id', errors, context);
      validateDateOrTimestampField(notification, 'due_at', errors, context, true);
    } else {
      validateDateOrTimestampField(notification, 'due_at', errors, context);
    }
    validateDateOrTimestampField(notification, 'created_at', errors, context);
    optionalReference(notification, 'user_id', userIds, errors, context);
    optionalReference(notification, 'task_id', taskIds, errors, context);
    optionalReference(notification, 'bundle_id', bundleIds, errors, context);
    optionalReference(notification, 'template_id', templateIds, errors, context);
  }

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

interface DryRunImportResult {
  valid: boolean;
  errors: string[];
  totalRecords: number;
  wouldWrite: Record<string, number>;
  skipped: Record<string, number>;
}

/**
 * Validate an export and report what a restore/import would write, without
 * connecting to or mutating any database. This is the safety check before
 * using an export for migration or restore.
 */
async function dryRunImport(exportDir: string): Promise<DryRunImportResult> {
  const validation = await validatePortableExport(exportDir);
  const wouldWrite: Record<string, number> = {};
  const skipped: Record<string, number> = {};
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
    wouldWrite[spec.name] = records.length;
    totalRecords += records.length;
  }

  return {
    valid: validation.valid,
    errors: validation.errors,
    totalRecords,
    wouldWrite,
    skipped,
  };
}

export {
  ENTITY_SPECS,
  EXPORT_FORMAT_VERSION,
  OMITTED_ENTITIES,
  REDACTIONS,
  SCHEMA_VERSION,
  dryRunImport,
  validatePortableExport,
  writePortableExport,
};
export type { DryRunImportResult, Manifest, PortableExportResult, ValidationResult };
