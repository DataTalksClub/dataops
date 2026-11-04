import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  BackupClient,
  DescribeBackupVaultCommand,
  ListBackupVaultsCommand,
} from '@aws-sdk/client-backup';

import { DATAOPS_TABLES } from '../db/tableNames';

/**
 * Read-only inventory of AWS resources that are leftovers relative to the
 * current serverless DataOps runtime: RDS instances and clusters (the runtime
 * has no relational database — anything found here predates or sits outside
 * the stack), AWS Backup vaults with their recovery-point counts, and DynamoDB
 * tables outside the stack-managed table list (dapier-* tables, leftover
 * restore-drill tables, and anything else unmanaged).
 *
 * Every AWS call is a describe/list read. No command in this module creates,
 * modifies or deletes anything. A section the caller has no permission to
 * read is tolerated: it is recorded in `errors` and the rest of the
 * inventory is still produced.
 */

export interface AwsLeftoversRdsInstance {
  identifier: string;
  engine: string;
  status: string;
  createdAt?: string;
  multiAz?: boolean;
}

export interface AwsLeftoversRdsCluster {
  identifier: string;
  engine: string;
  status: string;
  createdAt?: string;
}

export interface AwsLeftoversBackupVault {
  name: string;
  recoveryPointCount: number | null;
}

export interface AwsLeftoversDynamoTables {
  unmanagedTables: string[];
  restoreDrillTables: string[];
  stackTableCount: number;
}

export interface AwsLeftoversInventory {
  generatedAt: string;
  rdsInstances: AwsLeftoversRdsInstance[];
  rdsClusters: AwsLeftoversRdsCluster[];
  backupVaults: AwsLeftoversBackupVault[];
  dynamo: AwsLeftoversDynamoTables | null;
  errors: string[];
}

export interface AwsLeftoversDeps {
  rds?: Pick<RDSClient, 'send'>;
  backup?: Pick<BackupClient, 'send'>;
  dynamo?: Pick<DynamoDBDocumentClient, 'send'>;
  now?: Date;
}

const RESTORE_DRILL_TABLE_MARKER = '-restore-drill-';

function errorMessage(error: unknown): string {
  return (error as Error)?.message || 'unknown error';
}

async function collectRdsInstances(
  rds: Pick<RDSClient, 'send'>,
  errors: string[],
): Promise<AwsLeftoversRdsInstance[]> {
  try {
    const response = await rds.send(new DescribeDBInstancesCommand({})) as {
      DBInstances?: Array<{
        DBInstanceIdentifier?: string;
        Engine?: string;
        DBInstanceStatus?: string;
        InstanceCreateTime?: Date;
        MultiAZ?: boolean;
      }>;
    };
    return (response.DBInstances || []).map((instance) => ({
      identifier: instance.DBInstanceIdentifier || 'unknown',
      engine: instance.Engine || 'unknown',
      status: instance.DBInstanceStatus || 'unknown',
      createdAt: instance.InstanceCreateTime?.toISOString(),
      multiAz: instance.MultiAZ,
    }));
  } catch (error) {
    errors.push(`rds:DescribeDBInstances failed: ${errorMessage(error)}`);
    return [];
  }
}

async function collectRdsClusters(
  rds: Pick<RDSClient, 'send'>,
  errors: string[],
): Promise<AwsLeftoversRdsCluster[]> {
  try {
    const response = await rds.send(new DescribeDBClustersCommand({})) as {
      DBClusters?: Array<{
        DBClusterIdentifier?: string;
        Engine?: string;
        Status?: string;
        ClusterCreateTime?: Date;
      }>;
    };
    return (response.DBClusters || []).map((cluster) => ({
      identifier: cluster.DBClusterIdentifier || 'unknown',
      engine: cluster.Engine || 'unknown',
      status: cluster.Status || 'unknown',
      createdAt: cluster.ClusterCreateTime?.toISOString(),
    }));
  } catch (error) {
    errors.push(`rds:DescribeDBClusters failed: ${errorMessage(error)}`);
    return [];
  }
}

async function collectBackupVaults(
  backup: Pick<BackupClient, 'send'>,
  errors: string[],
): Promise<AwsLeftoversBackupVault[]> {
  const vaults: AwsLeftoversBackupVault[] = [];
  let nextToken: string | undefined;
  do {
    let response: { BackupVaultList?: Array<{ BackupVaultName?: string }>; NextToken?: string };
    try {
      response = await backup.send(new ListBackupVaultsCommand(
        nextToken ? { NextToken: nextToken } : {},
      )) as { BackupVaultList?: Array<{ BackupVaultName?: string }>; NextToken?: string };
    } catch (error) {
      errors.push(`backup:ListBackupVaults failed: ${errorMessage(error)}`);
      return vaults;
    }
    for (const vault of response.BackupVaultList || []) {
      const name = vault.BackupVaultName;
      if (!name) continue;
      let recoveryPointCount: number | null = null;
      try {
        // DescribeBackupVault reports the exact recovery-point count.
        const described = await backup.send(new DescribeBackupVaultCommand({
          BackupVaultName: name,
        })) as { RecoveryPoints?: number };
        recoveryPointCount = described.RecoveryPoints ?? null;
      } catch (error) {
        errors.push(`backup:DescribeBackupVault(${name}) failed: ${errorMessage(error)}`);
      }
      vaults.push({ name, recoveryPointCount });
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return vaults;
}

async function collectDynamoTables(
  dynamo: Pick<DynamoDBDocumentClient, 'send'>,
  errors: string[],
): Promise<AwsLeftoversDynamoTables | null> {
  const allTables = new Set<string>();
  let exclusiveStartTableName: string | undefined;
  do {
    let response: { TableNames?: string[]; LastEvaluatedTableName?: string };
    try {
      response = await dynamo.send(new ListTablesCommand(
        exclusiveStartTableName ? { ExclusiveStartTableName: exclusiveStartTableName } : {},
      )) as { TableNames?: string[]; LastEvaluatedTableName?: string };
    } catch (error) {
      errors.push(`dynamodb:ListTables failed: ${errorMessage(error)}`);
      return null;
    }
    for (const name of response.TableNames || []) allTables.add(name);
    exclusiveStartTableName = response.LastEvaluatedTableName;
  } while (exclusiveStartTableName);

  const stackTables = new Set(DATAOPS_TABLES);
  const unmanagedTables = [...allTables].filter((name) => !stackTables.has(name)).sort();
  return {
    unmanagedTables,
    restoreDrillTables: unmanagedTables.filter((name) => name.includes(RESTORE_DRILL_TABLE_MARKER)),
    stackTableCount: [...allTables].filter((name) => stackTables.has(name)).length,
  };
}

/**
 * Collect the read-only leftovers inventory. Each AWS section fails
 * independently: a denied or unreachable section is recorded in `errors`
 * while the remaining sections are still collected.
 */
async function collectLeftoversInventory(deps: AwsLeftoversDeps = {}): Promise<AwsLeftoversInventory> {
  const generatedAt = (deps.now || new Date()).toISOString();
  const errors: string[] = [];

  const rds = deps.rds || new RDSClient({});
  const backup = deps.backup || new BackupClient({});

  const rdsInstances = await collectRdsInstances(rds, errors);
  const rdsClusters = await collectRdsClusters(rds, errors);
  const backupVaults = await collectBackupVaults(backup, errors);
  const dynamo = deps.dynamo
    ? await collectDynamoTables(deps.dynamo, errors)
    : null;

  return {
    generatedAt,
    rdsInstances,
    rdsClusters,
    backupVaults,
    dynamo,
    errors,
  };
}

function markdownSummary(inventory: AwsLeftoversInventory): string {
  const lines: string[] = [
    `# AWS leftovers inventory (read-only) — ${inventory.generatedAt}`,
    '',
    `## RDS instances (${inventory.rdsInstances.length})`,
    ...inventory.rdsInstances.map((i) =>
      `- ${i.identifier}: engine=${i.engine} status=${i.status} createdAt=${i.createdAt ?? 'unknown'} multiAz=${i.multiAz ?? 'unknown'}`),
    '',
    `## RDS clusters (${inventory.rdsClusters.length})`,
    ...inventory.rdsClusters.map((c) =>
      `- ${c.identifier}: engine=${c.engine} status=${c.status} createdAt=${c.createdAt ?? 'unknown'}`),
    '',
    `## AWS Backup vaults (${inventory.backupVaults.length})`,
    ...inventory.backupVaults.map((v) =>
      `- ${v.name}: recovery points ${v.recoveryPointCount === null ? 'not counted' : v.recoveryPointCount}`),
  ];
  if (inventory.dynamo) {
    lines.push(
      '',
      `## DynamoDB tables outside the stack list (${inventory.dynamo.unmanagedTables.length}; stack-managed: ${inventory.dynamo.stackTableCount})`,
      ...inventory.dynamo.unmanagedTables.map((t) =>
        `- ${t}${t.includes(RESTORE_DRILL_TABLE_MARKER) ? ' (restore-drill leftover)' : ''}`),
    );
  } else {
    lines.push('', '## DynamoDB tables (not read)');
  }
  if (inventory.errors.length > 0) {
    lines.push('', '## Read errors (sections were skipped, nothing was written)', ...inventory.errors.map((e) => `- ${e}`));
  }
  lines.push(
    '',
    'The runtime has no RDS instances or clusters: any listed RDS resource is',
    'a leftover to delete. The `Default` AWS Backup vault exists in every',
    'account. DynamoDB restore-drill tables are leftover drill targets.',
  );
  return lines.join('\n');
}

export { collectLeftoversInventory, markdownSummary, RESTORE_DRILL_TABLE_MARKER };
