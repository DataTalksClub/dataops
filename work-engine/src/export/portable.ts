import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  TABLE_BUNDLES,
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
  | 'notifications';

const SCHEMA_VERSION = 'dataops.execution.v1';
const EXPORT_FORMAT_VERSION = 1;
const OMITTED_ENTITIES = ['sessions', 'artifacts', 'assistant_jobs', 'audit_events'];
const REDACTIONS = ['users.password_hash', 'sessions'];

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
    instructions_url: optionalString(item.instructionsUrl),
    link: optionalString(item.link),
    required_link_name: optionalString(item.requiredLinkName),
    requires_file: optionalBoolean(item.requiresFile),
    assignee_id: optionalString(item.assigneeId),
    bundle_id: optionalString(item.bundleId),
    template_task_ref: optionalString(item.templateTaskRef),
    recurring_config_id: optionalString(item.recurringConfigId),
    stage_on_complete: optionalString(item.stageOnComplete),
    tags: stringArray(item.tags),
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
    checksum: optionalString(item.checksum),
    size_bytes: optionalNumber(item.sizeBytes),
    created_at: optionalString(item.createdAt),
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
  collectIds(recordsByEntity.files || [], 'file_id', 'files', errors);
  collectIds(recordsByEntity.notifications || [], 'notification_id', 'notifications', errors);

  for (const [index, task] of (recordsByEntity.tasks || []).entries()) {
    const context = `tasks[${index}]`;
    requireString(task, 'description', errors, context);
    requireString(task, 'date', errors, context);
    optionalReference(task, 'assignee_id', userIds, errors, context);
    optionalReference(task, 'bundle_id', bundleIds, errors, context);
  }

  for (const [index, bundle] of (recordsByEntity.bundles || []).entries()) {
    optionalReference(bundle, 'template_id', templateIds, errors, `bundles[${index}]`);
  }

  for (const [index, file] of (recordsByEntity.files || []).entries()) {
    optionalReference(file, 'task_id', taskIds, errors, `files[${index}]`);
    optionalReference(file, 'bundle_id', bundleIds, errors, `files[${index}]`);
  }

  for (const [index, notification] of (recordsByEntity.notifications || []).entries()) {
    const context = `notifications[${index}]`;
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

export {
  ENTITY_SPECS,
  EXPORT_FORMAT_VERSION,
  OMITTED_ENTITIES,
  REDACTIONS,
  SCHEMA_VERSION,
  validatePortableExport,
  writePortableExport,
};
export type { Manifest, PortableExportResult, ValidationResult };
