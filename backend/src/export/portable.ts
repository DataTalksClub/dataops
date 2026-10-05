import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  TABLE_BOOKKEEPING,
  TABLE_CARDS,
  TABLE_ARTIFACTS,
  TABLE_ASSISTANT_JOBS,
  TABLE_AUDIT_EVENTS,
  TABLE_FILES,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
  TABLE_USERS,
} from '../db/tableNames';
import {
  CONVERSATIONAL_ENTITY_SPECS,
} from '../conversation/portable';
import { canonicalizeRfc3339Instant } from './portableChecks';
import {
  mapArtifact,
  mapAssistantJob,
  mapAuditEvent,
  mapCard,
  mapFile,
  mapIntakeItem,
  mapNotification,
  mapRecurringConfig,
  mapTask,
  mapTemplate,
  mapUser,
} from './portableMappers';
import type { JsonRecord } from './portableMappers';

/**
 * Portable export: the entity specs and the writer that scans DynamoDB into
 * canonical JSONL files plus a manifest. Validation and dry-run import live in
 * `./portableValidate`; the canonical record mappers in `./portableMappers`;
 * the shared field checks in `./portableChecks`.
 */

interface EntitySpec {
  name: ExportEntityName;
  filename: string;
  tableName: string;
  prefix?: string;
  prefixes?: string[];
  recordType?: string;
  filter?: (item: Record<string, unknown>) => boolean;
  map: (item: Record<string, unknown>) => JsonRecord;
  sortKey?: (record: JsonRecord) => string;
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
type ExportEntityName =
  | 'invoice_records'
  | 'invoice_claims'
  | 'invoice_cursors'
  | 'bookkeeping_records'
  | 'users'
  | 'tasks'
  | 'cards'
  | 'templates'
  | 'recurring_configs'
  | 'files'
  | 'artifacts'
  | 'assistant_jobs'
  | 'audit_events'
  | 'intake_items'
  | 'notifications'
  | 'identity_bindings'
  | 'conversations'
  | 'channel_bindings'
  | 'conversation_events'
  | 'summary_checkpoints'
  | 'plugin_drafts'
  | 'proposal_versions'
  | 'proposal_presentations'
  | 'execution_attempts'
  | 'conversation_audit_events'
  | 'conversational_private_payloads';

const SCHEMA_VERSION = 'dataops.execution.v1';
const EXPORT_FORMAT_VERSION = 1;
const OMITTED_ENTITIES = [
  'sessions',
  'media_bytes',
  'provider_credentials',
  'sponsor_finance_state',
  'sponsor_finance_links',
  'sponsor_finance_claims',
  'sponsor_finance_history',
  'sponsor_finance_receipts',
  'sponsor_finance_alerts',
];
const REDACTIONS = [
  'users.password_hash',
  'sessions',
  'proposal_presentations.action_token_hash',
  'callback_tokens',
  'signed_urls',
];
const ENTITY_SPECS: EntitySpec[] = [
  ...(['invoice_records','invoice_claims','invoice_cursors','bookkeeping_records'] as const).map((name, index) => ({
    name, filename: `${name}.jsonl`, tableName: TABLE_BOOKKEEPING,
    prefix: ['INVOICE#','INVOICE_IDENTITY#','INVOICE_CURSOR#','BOOKKEEPING#'][index],
    map: (item: Record<string, unknown>) => JSON.parse(JSON.stringify(item)) as JsonRecord,
    sortKey: (record: JsonRecord) => String(record.PK),
  })),
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
    name: 'cards',
    filename: 'cards.jsonl',
    tableName: TABLE_CARDS,
    prefix: 'CARD#',
    map: mapCard,
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
    name: 'assistant_jobs',
    filename: 'assistant_jobs.jsonl',
    tableName: TABLE_ASSISTANT_JOBS,
    prefix: 'ASSISTANT_JOB#',
    map: mapAssistantJob,
  },
  {
    name: 'audit_events',
    filename: 'audit_events.jsonl',
    tableName: TABLE_AUDIT_EVENTS,
    prefixes: ['AUDIT_EVENT#', 'TEMPLATE_AUDIT#'],
    map: mapAuditEvent,
  },
  {
    name: 'intake_items',
    filename: 'intake_items.jsonl',
    tableName: TABLE_INTAKE,
    prefix: 'INTAKE#',
    map: mapIntakeItem,
  },
  {
    name: 'notifications',
    filename: 'notifications.jsonl',
    tableName: TABLE_NOTIFICATIONS,
    prefix: 'NOTIFICATION#',
    filter: (item) => (
      item.type !== 'sponsor-finance'
      && !(item.metadata as Record<string, unknown> | undefined)?.financeFingerprint
    ),
    map: mapNotification,
  },
  ...(CONVERSATIONAL_ENTITY_SPECS as EntitySpec[]),
];
async function scanByPrefix(
  client: DynamoDBDocumentClient,
  tableName: string,
  prefix?: string,
  recordType?: string,
  prefixes?: string[],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(recordType
          ? {
            FilterExpression: '#recordType = :recordType',
            ExpressionAttributeNames: { '#recordType': 'recordType' },
            ExpressionAttributeValues: { ':recordType': recordType },
          }
          : prefixes && prefixes.length > 0
            ? {
              FilterExpression: prefixes.map((_, index) => `begins_with(PK, :prefix${index})`).join(' OR '),
              ExpressionAttributeValues: Object.fromEntries(prefixes.map((value, index) => [`:prefix${index}`, value])),
            }
            : {
              FilterExpression: 'begins_with(PK, :prefix)',
              ExpressionAttributeValues: { ':prefix': prefix },
            }),
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
let portableExportClock: () => Date = () => new Date();

function resolveGeneratedAt(value?: string): string {
  if (value === undefined) return portableExportClock().toISOString();
  return canonicalizeRfc3339Instant(value);
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
  const generatedAt = resolveGeneratedAt(options.generatedAt);
  await fs.mkdir(outputDir, { recursive: true });

  const entityFiles: Record<string, string> = {};
  const entityCounts: Record<string, number> = {};
  const checksums: Record<string, string> = {};

  for (const spec of ENTITY_SPECS) {
    const rawItems = await scanByPrefix(client, spec.tableName, spec.prefix, spec.recordType, spec.prefixes);
    const records = rawItems
      .filter((item) => (
        (!spec.filter || spec.filter(item))
        && (
          typeof item.expiresAt !== 'string'
          || Date.parse(item.expiresAt) > Date.parse(generatedAt)
        )
      ))
      .map(spec.map).sort((a, b) => {
        const left = spec.sortKey ? spec.sortKey(a) : (Object.values(a)[0] || '');
        const right = spec.sortKey ? spec.sortKey(b) : (Object.values(b)[0] || '');
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
    generated_at: generatedAt,
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
function setPortableExportClockForTests(clock?: () => Date): void {
  portableExportClock = clock || (() => new Date());
}

export {
  ENTITY_SPECS,
  EXPORT_FORMAT_VERSION,
  OMITTED_ENTITIES,
  REDACTIONS,
  SCHEMA_VERSION,
  setPortableExportClockForTests,
  sha256,
  writePortableExport,
};
export type { ExportEntityName, Manifest, PortableExportResult };
