import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { DATAOPS_TABLES, TABLE_SESSIONS, TABLE_USERS } from '../src/db/tableNames';
import { createTask } from '../src/db/tasks';
import { handleCronRoutes } from '../src/routes/cron';
import { SCHEMA_VERSION, writeRawDynamoBackup } from '../src/export/dynamoBackup';

describe('raw DynamoDB dump', { concurrency: 1 }, () => {
  let client: DynamoDBDocumentClient;
  let backupDir: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-dynamo-backup-'));
  });

  after(async () => {
    await fs.rm(backupDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('writes gzip NDJSON for every application table including sessions', async () => {
    await createTask(client, { description: 'Backup dump task', date: '2026-10-10' });
    await client.send(new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: { PK: 'SESSION#dump-test', SK: 'SESSION', token: 'live-session-token' },
    }));
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: {
        PK: 'USER#dump-test',
        SK: 'USER',
        id: 'dump-test',
        email: 'dump@example.com',
        password_hash: 'not-for-portable-export',
      },
    }));

    const generatedAt = new Date('2026-10-10T09:00:00.000Z');
    const result = await writeRawDynamoBackup(client, {
      localDir: backupDir,
      prefix: 'dynamo-backups',
      environment: 'sandbox',
      generatedAt,
    });

    assert.strictEqual(result.manifest.schema_version, SCHEMA_VERSION);
    assert.strictEqual(result.manifest.source_environment, 'sandbox');
    assert.strictEqual(result.manifest.table_count, DATAOPS_TABLES.length);
    assert.ok(result.manifest.item_count >= 3);
    assert.strictEqual(
      result.manifestKey,
      'dynamo-backups/sandbox/2026-10-10/manifest.json',
    );
    assert.match(result.manifestUri, /^file:\/\//);

    for (const tableName of DATAOPS_TABLES) {
      const stats = result.manifest.tables[tableName];
      assert.ok(stats, `missing stats for ${tableName}`);
      assert.strictEqual(stats.error, undefined);
      const filePath = path.join(backupDir, stats.key);
      const unzipped = zlib.gunzipSync(await fs.readFile(filePath)).toString('utf8');
      if (stats.items === 0) {
        assert.strictEqual(unzipped, '');
        continue;
      }
      const rows = unzipped.trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.strictEqual(rows.length, stats.items);
    }

    const sessionRows = zlib.gunzipSync(
      await fs.readFile(path.join(backupDir, result.manifest.tables[TABLE_SESSIONS].key)),
    ).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.ok(sessionRows.some((row) => row.token === 'live-session-token'));

    const userRows = zlib.gunzipSync(
      await fs.readFile(path.join(backupDir, result.manifest.tables[TABLE_USERS].key)),
    ).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.ok(userRows.some((row) => row.password_hash === 'not-for-portable-export'));
  });

  it('puts gzip objects to S3 when a bucket is configured', async () => {
    const objects = new Map<string, Buffer>();
    const s3Client = {
      send: async (command: { input?: { Key?: string; Body?: Buffer | string; ServerSideEncryption?: string } }) => {
        assert.ok(command instanceof PutObjectCommand);
        const key = String(command.input?.Key);
        const body = command.input?.Body;
        assert.strictEqual(command.input?.ServerSideEncryption, 'AES256');
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        return {};
      },
    };

    const result = await writeRawDynamoBackup(client, {
      bucket: 'dataops-export-test',
      prefix: 'dynamo-backups',
      environment: 'sandbox',
      generatedAt: new Date('2026-10-10T09:00:00.000Z'),
      s3Client,
    });

    assert.strictEqual(
      result.manifestUri,
      's3://dataops-export-test/dynamo-backups/sandbox/2026-10-10/manifest.json',
    );
    assert.ok(objects.has(result.manifestKey));
    for (const tableName of DATAOPS_TABLES) {
      assert.ok(objects.has(result.manifest.tables[tableName].key), `missing ${tableName}`);
    }
  });

  it('records a table error and fails the dump after writing the manifest', async () => {
    const failing = {
      send: async (command: unknown) => {
        if (command instanceof ScanCommand && (command.input as { TableName?: string }).TableName === TABLE_SESSIONS) {
          throw new Error('sessions scan denied');
        }
        return client.send(command as Parameters<DynamoDBDocumentClient['send']>[0]);
      },
    } as DynamoDBDocumentClient;

    await assert.rejects(
      () => writeRawDynamoBackup(failing, {
        localDir: backupDir,
        prefix: 'dynamo-backups',
        environment: 'sandbox',
        generatedAt: new Date('2026-10-11T11:00:00.000Z'),
      }),
      new RegExp(`Dynamo backup failed for: ${TABLE_SESSIONS}`),
    );

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(backupDir, 'dynamo-backups/sandbox/2026-10-11/manifest.json'),
        'utf8',
      ),
    );
    assert.strictEqual(manifest.tables[TABLE_SESSIONS].error, 'sessions scan denied');
    assert.ok(manifest.tables.Tasks.items >= 1);
  });

  it('serves POST /api/cron/dynamo-backup', async () => {
    process.env.DATAOPS_DYNAMO_BACKUP_LOCAL_DIR = backupDir;
    process.env.DATAOPS_DYNAMO_BACKUP_PREFIX = 'dynamo-backups';
    process.env.DATAOPS_ENV = 'staging';
    delete process.env.DATAOPS_EXPORT_ARCHIVE_BUCKET;
    try {
      const denied = await handleCronRoutes('/api/cron/dynamo-backup', 'GET');
      assert.ok(denied);
      assert.strictEqual(denied!.statusCode, 405);

      const result = await handleCronRoutes('/api/cron/dynamo-backup', 'POST');
      assert.ok(result);
      assert.strictEqual(result!.statusCode, 200);
      const body = JSON.parse(result!.body);
      assert.strictEqual(body.schema_version, SCHEMA_VERSION);
      assert.strictEqual(body.source_environment, 'staging');
      assert.strictEqual(body.table_count, DATAOPS_TABLES.length);
      assert.match(body.manifest_key, /^dynamo-backups\/staging\//);
      assert.doesNotMatch(result!.body, /password_hash|live-session-token/);
    } finally {
      delete process.env.DATAOPS_DYNAMO_BACKUP_LOCAL_DIR;
      delete process.env.DATAOPS_DYNAMO_BACKUP_PREFIX;
      delete process.env.DATAOPS_ENV;
    }
  });
});
