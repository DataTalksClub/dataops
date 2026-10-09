import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DATAOPS_TABLES } from '../db/tableNames';

/**
 * Raw DynamoDB dump: scan every application table into gzip NDJSON plus a
 * manifest. This is the inspectable backup (dapier / rds-export analogue).
 * Portable execution archives stay the redacted restore/migration format.
 */

const gzip = promisify(zlib.gzip);
const SCHEMA_VERSION = 'dataops.dynamo-backup.v1';

interface DynamoBackupConfig {
  bucket?: string;
  prefix?: string;
  environment?: string;
  localDir?: string;
  generatedAt?: Date;
  s3Client?: Pick<S3Client, 'send'>;
}

interface TableBackupStats {
  key: string;
  items: number;
  bytes: number;
  error?: string;
}

interface DynamoBackupManifest {
  schema_version: string;
  generated_at: string;
  source_environment: string;
  source_region: string;
  prefix: string;
  tables: Record<string, TableBackupStats>;
  item_count: number;
  table_count: number;
}

interface DynamoBackupResult {
  manifest: DynamoBackupManifest;
  manifestKey: string;
  manifestUri: string;
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Set) return [...value];
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function backupConfigFromEnv(): DynamoBackupConfig {
  return {
    bucket: process.env.DATAOPS_EXPORT_ARCHIVE_BUCKET || undefined,
    prefix: process.env.DATAOPS_DYNAMO_BACKUP_PREFIX || 'dynamo-backups',
    environment: process.env.DATAOPS_ENV,
    localDir: process.env.DATAOPS_DYNAMO_BACKUP_LOCAL_DIR || undefined,
  };
}

async function scanTable(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}

async function writeBackupObject(
  config: DynamoBackupConfig,
  key: string,
  body: Buffer,
  contentType: string,
  contentEncoding?: string,
): Promise<string> {
  if (config.bucket) {
    const s3Client = config.s3Client || new S3Client({});
    await s3Client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentEncoding: contentEncoding,
      ServerSideEncryption: 'AES256',
    }));
    return `s3://${config.bucket}/${key}`;
  }

  if (!config.localDir) {
    throw new Error('Dynamo backup storage is not configured');
  }

  const filePath = path.resolve(config.localDir, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);
  return `file://${filePath}`;
}

async function writeRawDynamoBackup(
  client: DynamoDBDocumentClient,
  config: DynamoBackupConfig = {},
): Promise<DynamoBackupResult> {
  if (!config.bucket && !config.localDir) {
    throw new Error('Dynamo backup storage is not configured');
  }

  const generatedAt = config.generatedAt || new Date();
  const generatedAtIso = generatedAt.toISOString();
  const day = generatedAtIso.slice(0, 10);
  const prefix = (config.prefix || 'dynamo-backups').replace(/^\/+|\/+$/g, '') || 'dynamo-backups';
  const environment = sanitizePathSegment(
    config.environment || process.env.DATAOPS_ENV || process.env.NODE_ENV || 'unknown',
  );
  const base = `${prefix}/${environment}/${day}`;
  const tables: Record<string, TableBackupStats> = {};
  const errors: string[] = [];
  let itemCount = 0;

  for (const tableName of DATAOPS_TABLES) {
    const key = `${base}/${tableName}.json.gz`;
    try {
      const items = await scanTable(client, tableName);
      const payload = items.map((item) => JSON.stringify(item, jsonReplacer)).join('\n')
        + (items.length > 0 ? '\n' : '');
      const body = await gzip(Buffer.from(payload, 'utf8'));
      await writeBackupObject(config, key, body, 'application/x-ndjson', 'gzip');
      tables[tableName] = { key, items: items.length, bytes: body.length };
      itemCount += items.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tables[tableName] = { key, items: 0, bytes: 0, error: message };
      errors.push(tableName);
    }
  }

  const manifest: DynamoBackupManifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAtIso,
    source_environment: environment,
    source_region: process.env.AWS_REGION || 'unknown',
    prefix,
    tables,
    item_count: itemCount,
    table_count: DATAOPS_TABLES.length,
  };
  const manifestKey = `${base}/manifest.json`;
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestUri = await writeBackupObject(config, manifestKey, manifestBody, 'application/json');

  if (errors.length > 0) {
    throw new Error(`Dynamo backup failed for: ${errors.sort().join(', ')}`);
  }

  return { manifest, manifestKey, manifestUri };
}

export {
  SCHEMA_VERSION,
  backupConfigFromEnv,
  writeRawDynamoBackup,
};
export type {
  DynamoBackupConfig,
  DynamoBackupManifest,
  DynamoBackupResult,
  TableBackupStats,
};
