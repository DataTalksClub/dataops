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
      PointInTimeRecoveryDescription?: { PointInTimeRecoveryStatus?: string };
      ContinuousBackupsStatus?: string;
    };
  } | undefined)?.ContinuousBackupsDescription;
  const recoveryStatus = description?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
  if (recoveryStatus === 'ENABLED') {
    return { table, pitrEnabled: true };
  }
  if (recoveryStatus === 'DISABLED') {
    return { table, pitrEnabled: false };
  }
  return { table, pitrEnabled: null, error: `unexpected PITR status: ${String(recoveryStatus)}` };
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
