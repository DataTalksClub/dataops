import { DescribeContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DATAOPS_TABLES } from '../db/tableNames';

/**
 * Daily PITR guard: describe continuous backups for every application table
 * and publish the count of tables without point-in-time recovery to
 * CloudWatch (`DataOps/DynamoBackup` / `PitrDisabledTables`). The
 * `DynamoPitrDisabledAlarm` in infra/template.full.yaml pages
 * dev@dtcdev.click when the count reaches 1 (or when the check stops
 * reporting at all).
 *
 * A single unreadable table never fails the check: it is reported as
 * unknown and the remaining tables are still evaluated.
 */

const METRIC_NAMESPACE = 'DataOps/DynamoBackup';
const METRIC_NAME = 'PitrDisabledTables';

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
  unknownTables: string[];
  tables: PitrTableStatus[];
}

interface PitrCheckDeps {
  cloudWatch?: Pick<CloudWatchClient, 'send'>;
  metricNamespace?: string;
  generatedAt?: Date;
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

async function checkDynamoPitrStatus(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  deps: PitrCheckDeps = {},
): Promise<PitrCheckResult> {
  const generatedAt = (deps.generatedAt || new Date()).toISOString();
  const tables: PitrTableStatus[] = [];

  for (const table of DATAOPS_TABLES) {
    try {
      const response = await client.send(new DescribeContinuousBackupsCommand({ TableName: table }));
      tables.push(statusOfTable(table, response));
    } catch (error) {
      tables.push({ table, pitrEnabled: null, error: (error as Error)?.message || 'unknown error' });
    }
  }

  const disabledTables = tables.filter((t) => t.pitrEnabled === false).map((t) => t.table);
  const unknownTables = tables.filter((t) => t.pitrEnabled === null).map((t) => t.table);

  // Never assert "all healthy" when nothing could be verified: with no
  // datapoint the alarm's TreatMissingData=breaching pages instead.
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
    unknownTables,
    tables,
  };
}

export { checkDynamoPitrStatus, METRIC_NAMESPACE, METRIC_NAME };
export type { PitrCheckResult, PitrTableStatus };
