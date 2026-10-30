import { createHash, createHmac, type BinaryLike } from 'node:crypto';
import { DescribeContinuousBackupsCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DATAOPS_TABLES, TABLE_SESSIONS } from '../db/tableNames';

/**
 * Daily PITR guard: describe continuous backups for every application table
 * (plus any configured account table prefixes such as `dapier-`) and publish
 * the count of tables without point-in-time recovery to CloudWatch
 * (`DataOps/DynamoBackup` / `PitrDisabledTables`) for dashboards.
 *
 * When a breach is detected (any table with PITR unexpectedly disabled, or all
 * tables unreadable), the scheduled handler raises one undismissed
 * `automation-failure` portal notification and publishes an alarm message to
 * the shared operator SNS alarm topic (`DYNAMO_PITR_ALERT_TOPIC_ARN`, which
 * triggers `AlarmNotifyFunction` -> SES email to `dev@dtcdev.click`), and
 * auto-dismisses the notification once the guard is green again.
 *
 * The sessions table is a deliberate exception: it holds TTL-expired
 * ephemeral login state, not durable execution state (enforced by
 * tests/infra/test_template.py), so PITR stays off there by design and it
 * does not count toward the alarm.
 *
 * A single unreadable table never fails the check: it is reported as
 * unknown and the remaining tables are still evaluated.
 */

const METRIC_NAMESPACE = 'DataOps/DynamoBackup';
const METRIC_NAME = 'PitrDisabledTables';
const DEFAULT_ALERT_EMAIL = 'dev@dtcdev.click';
const EXPECTED_PITR_DISABLED = new Set([TABLE_SESSIONS]);

interface PitrTableStatus {
  table: string;
  pitrEnabled: boolean | null;
  earliestRestorable?: string;
  latestRestorable?: string;
  error?: string;
}

interface PitrCheckResult {
  generatedAt: string;
  tableCount: number;
  disabledTables: string[];
  expectedDisabledTables: string[];
  unknownTables: string[];
  tables: PitrTableStatus[];
}

interface PitrCheckDeps {
  cloudWatch?: Pick<CloudWatchClient, 'send'>;
  metricNamespace?: string;
  generatedAt?: Date;
  extraTablePrefixes?: string[];
}

interface SnsPublishCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface PitrAlertDeps {
  topicArn?: string;
  alertEmail?: string;
  fetchImpl?: typeof fetch;
  credentials?: SnsPublishCreds | (() => Promise<SnsPublishCreds>);
  now?: Date;
}

function statusOfTable(
  table: string,
  response: unknown,
): PitrTableStatus {
  const description = (response as {
    ContinuousBackupsDescription?: {
      PointInTimeRecoveryDescription?: {
        PointInTimeRecoveryStatus?: string;
        EarliestRestorableDateTime?: Date;
        LatestRestorableDateTime?: Date;
      };
      ContinuousBackupsStatus?: string;
    };
  } | undefined)?.ContinuousBackupsDescription;
  const recovery = description?.PointInTimeRecoveryDescription;
  const toIso = (value: unknown): string | undefined => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    return undefined;
  };
  const earliestRestorable = toIso(recovery?.EarliestRestorableDateTime);
  const latestRestorable = toIso(recovery?.LatestRestorableDateTime);
  if (recovery?.PointInTimeRecoveryStatus === 'ENABLED') {
    return { table, pitrEnabled: true, earliestRestorable, latestRestorable };
  }
  if (recovery?.PointInTimeRecoveryStatus === 'DISABLED') {
    return { table, pitrEnabled: false };
  }
  return { table, pitrEnabled: null, error: `unexpected PITR status: ${String(recovery?.PointInTimeRecoveryStatus)}` };
}

function configuredExtraPrefixes(deps: PitrCheckDeps): string[] {
  if (deps.extraTablePrefixes !== undefined) {
    return deps.extraTablePrefixes.map((p) => p.trim()).filter(Boolean);
  }
  if (process.env.DYNAMODB_ENDPOINT) return [];
  return String(process.env.DYNAMO_PITR_EXTRA_TABLE_PREFIXES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function discoverExtraTables(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  prefixes: string[],
): Promise<string[]> {
  if (prefixes.length === 0) return [];
  const discovered = new Set<string>();
  let exclusiveStartTableName: string | undefined;
  try {
    do {
      const page = (await client.send(
        new ListTablesCommand(
          exclusiveStartTableName ? { ExclusiveStartTableName: exclusiveStartTableName } : {},
        ),
      )) as { TableNames?: string[]; LastEvaluatedTableName?: string };
      for (const name of page.TableNames || []) {
        if (name.includes('-restore-drill-')) continue;
        if (prefixes.some((prefix) => name.startsWith(prefix))) {
          discovered.add(name);
        }
      }
      exclusiveStartTableName = page.LastEvaluatedTableName;
    } while (exclusiveStartTableName);
  } catch (error) {
    console.error(`Could not list extra tables for PITR guard: ${(error as Error)?.message || 'unknown error'}`);
  }
  return [...discovered].sort();
}

async function checkDynamoPitrStatus(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  deps: PitrCheckDeps = {},
): Promise<PitrCheckResult> {
  const generatedAt = (deps.generatedAt || new Date()).toISOString();
  const extraTables = await discoverExtraTables(client, configuredExtraPrefixes(deps));
  const targetTables = [...new Set([...DATAOPS_TABLES, ...extraTables])];
  const tables: PitrTableStatus[] = [];

  for (const table of targetTables) {
    try {
      const response = await client.send(new DescribeContinuousBackupsCommand({ TableName: table }));
      tables.push(statusOfTable(table, response));
    } catch (error) {
      tables.push({ table, pitrEnabled: null, error: (error as Error)?.message || 'unknown error' });
    }
  }

  const disabledTables = tables
    .filter((t) => t.pitrEnabled === false && !EXPECTED_PITR_DISABLED.has(t.table))
    .map((t) => t.table);
  const expectedDisabledTables = tables
    .filter((t) => t.pitrEnabled === false && EXPECTED_PITR_DISABLED.has(t.table))
    .map((t) => t.table);
  const unknownTables = tables.filter((t) => t.pitrEnabled === null).map((t) => t.table);

  // Never assert "all healthy" when nothing could be verified: with no
  // datapoint dashboards stay empty and the handler pages instead.
  // Local runs (DYNAMODB_ENDPOINT set by test/script tooling) also skip the
  // publish so unit tests never touch real CloudWatch.
  if (unknownTables.length < tables.length && !process.env.DYNAMODB_ENDPOINT) {
    try {
      const cloudWatch = deps.cloudWatch || new CloudWatchClient({});
      await cloudWatch.send(new PutMetricDataCommand({
        Namespace: deps.metricNamespace || METRIC_NAMESPACE,
        MetricData: [{
          MetricName: METRIC_NAME,
          Value: disabledTables.length,
          Unit: 'Count',
          Timestamp: new Date(generatedAt),
        }],
      }));
    } catch (error) {
      console.error(`Could not publish PITR metric: ${(error as Error)?.message || 'unknown error'}`);
    }
  } else {
    console.error(
      `Skipping PITR metric publish: ${unknownTables.length}/${tables.length} tables unknown`
      + (process.env.DYNAMODB_ENDPOINT ? ' (local endpoint)' : ''),
    );
  }

  return {
    generatedAt,
    tableCount: tables.length,
    disabledTables,
    expectedDisabledTables,
    unknownTables,
    tables,
  };
}

/**
 * Publish a PITR breach alert to the shared operator SNS alarm topic so
 * `AlarmNotifyFunction` emails `dev@dtcdev.click` via SES.
 */
async function publishPitrGuardAlert(
  result: PitrCheckResult,
  deps: PitrAlertDeps = {},
): Promise<{ published: boolean; topicArn?: string; alertEmail: string }> {
  const topicArn = (deps.topicArn ?? process.env.DYNAMO_PITR_ALERT_TOPIC_ARN ?? '').trim();
  const alertEmail = (deps.alertEmail ?? process.env.DYNAMO_PITR_ALERT_EMAIL ?? DEFAULT_ALERT_EMAIL).trim() || DEFAULT_ALERT_EMAIL;
  if (!topicArn) {
    return { published: false, alertEmail };
  }

  const arnParts = topicArn.split(':');
  const region = arnParts[3] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1';
  const reason = result.disabledTables.length > 0
    ? `DynamoDB PITR disabled on ${result.disabledTables.length} table(s): ${result.disabledTables.join(', ')} (recipient: ${alertEmail})`
    : `DynamoDB PITR status unknown for all ${result.tableCount} tables (recipient: ${alertEmail})`;

  const message = JSON.stringify({
    AlarmName: 'dataops-v1-dynamo-pitr-disabled',
    AlarmDescription: `Daily DynamoDB PITR guard alert for ${alertEmail}`,
    NewStateValue: 'ALARM',
    NewStateReason: reason,
    StateChangeTime: result.generatedAt,
    AlertRecipient: alertEmail,
    DisabledTables: result.disabledTables,
    UnknownTables: result.unknownTables,
    TableCount: result.tableCount,
  });
  const subject = `[DataOps] DynamoDB PITR disabled (${result.disabledTables.length || 'unknown'})`;
  const body = new URLSearchParams({
    Action: 'Publish',
    Version: '2010-03-31',
    TopicArn: topicArn,
    Subject: subject.slice(0, 100),
    Message: message,
  }).toString();

  const resolveCreds = typeof deps.credentials === 'function'
    ? deps.credentials
    : deps.credentials
      ? async () => deps.credentials as SnsPublishCreds
      : defaultProvider();
  const creds = await resolveCreds();

  const now = deps.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `sns.${region}.amazonaws.com`;
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');

  const headerEntries: [string, string][] = [
    ['content-type', contentType],
    ['host', host],
    ['x-amz-date', amzDate],
  ];
  if (creds.sessionToken) {
    headerEntries.push(['x-amz-security-token', creds.sessionToken]);
  }
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/sns/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const hmac = (key: BinaryLike, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), 'sns'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-amz-date': amzDate,
    authorization,
  };
  if (creds.sessionToken) {
    headers['x-amz-security-token'] = creds.sessionToken;
  }

  const runFetch = deps.fetchImpl || fetch;
  const response = await runFetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`SNS Publish failed with HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }
  return { published: true, topicArn, alertEmail };
}

export {
  checkDynamoPitrStatus,
  publishPitrGuardAlert,
  DEFAULT_ALERT_EMAIL,
  METRIC_NAMESPACE,
  METRIC_NAME,
};
export type { PitrAlertDeps, PitrCheckDeps, PitrCheckResult, PitrTableStatus };
