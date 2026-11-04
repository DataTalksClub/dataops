import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DescribeBackupVaultCommand, ListBackupVaultsCommand } from '@aws-sdk/client-backup';
import { DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { BackupClient } from '@aws-sdk/client-backup';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { collectLeftoversInventory, markdownSummary } from '../src/export/awsLeftoversInventory';
import { DATAOPS_TABLES } from '../src/db/tableNames';

interface FakeRoute {
  match: (command: unknown) => boolean;
  respond: (command: unknown) => unknown;
  fail?: string;
}

function fakeSender(routes: FakeRoute[]) {
  return {
    send: async (command: unknown) => {
      const route = routes.find((candidate) => candidate.match(command));
      if (!route) throw new Error(`unexpected command: ${(command as object)?.constructor?.name}`);
      if (route.fail) throw new Error(route.fail);
      return route.respond(command);
    },
  };
}

function fakeRds(routes: FakeRoute[]) {
  return fakeSender(routes) as unknown as Pick<RDSClient, 'send'>;
}

function fakeBackup(routes: FakeRoute[]) {
  return fakeSender(routes) as unknown as Pick<BackupClient, 'send'>;
}

function fakeDynamo(routes: FakeRoute[]) {
  return fakeSender(routes) as unknown as Pick<DynamoDBDocumentClient, 'send'>;
}

function paginatedListTables(pages: string[][]): { match: (command: unknown) => boolean; respond: (command: unknown) => unknown } {
  return {
    match: (command: unknown) => command instanceof ListTablesCommand,
    respond: (command: unknown) => {
      const start = (command as unknown as { input: { ExclusiveStartTableName?: string } }).input.ExclusiveStartTableName;
      const pageIndex = start ? pages.findIndex((page) => page[page.length - 1] === start) + 1 : 0;
      const page = pages[pageIndex];
      const next = pages[pageIndex + 1];
      return {
        TableNames: page || [],
        // ListTables reports the current page's last name; the next call
        // resumes strictly after it.
        LastEvaluatedTableName: next && page ? page[page.length - 1] : undefined,
      };
    },
  };
}

describe('AWS leftovers inventory', () => {
  it('collects RDS instances, clusters, backup vaults and unmanaged DynamoDB tables', async () => {
    const rds = fakeRds([
      {
        match: (c) => c instanceof DescribeDBInstancesCommand,
        respond: () => ({
          DBInstances: [
            {
              DBInstanceIdentifier: 'old-dtc-postgres',
              Engine: 'postgres',
              DBInstanceStatus: 'available',
              InstanceCreateTime: new Date('2024-01-01T00:00:00.000Z'),
              MultiAZ: false,
            },
          ],
        }),
      },
      {
        match: (c) => c instanceof DescribeDBClustersCommand,
        respond: () => ({
          DBClusters: [{
            DBClusterIdentifier: 'old-aurora',
            Engine: 'aurora-mysql',
            Status: 'available',
          }],
        }),
      },
    ]);
    const backup = fakeBackup([
      {
        match: (c) => c instanceof ListBackupVaultsCommand,
        respond: () => ({ BackupVaultList: [{ BackupVaultName: 'Default' }, { BackupVaultName: 'dtc-old-vault' }] }),
      },
      {
        match: (c) => c instanceof DescribeBackupVaultCommand
          && (c as unknown as { input: { BackupVaultName: string } }).input.BackupVaultName === 'Default',
        respond: () => ({ RecoveryPoints: 0 }),
      },
      {
        match: (c) => c instanceof DescribeBackupVaultCommand
          && (c as unknown as { input: { BackupVaultName: string } }).input.BackupVaultName === 'dtc-old-vault',
        respond: () => ({ RecoveryPoints: 41 }),
      },
    ]);
    const dynamo = fakeDynamo([
      paginatedListTables([[DATAOPS_TABLES[0], 'dapier-prod-users'], ['dataops-v1-tasks-restore-drill-20260628']]),
    ]);

    const inventory = await collectLeftoversInventory({
      rds,
      backup,
      dynamo,
      now: new Date('2026-11-05T10:00:00.000Z'),
    });

    assert.strictEqual(inventory.generatedAt, '2026-11-05T10:00:00.000Z');
    assert.strictEqual(inventory.rdsInstances.length, 1);
    assert.strictEqual(inventory.rdsInstances[0].identifier, 'old-dtc-postgres');
    assert.strictEqual(inventory.rdsClusters.length, 1);
    assert.deepStrictEqual(inventory.backupVaults, [
      { name: 'Default', recoveryPointCount: 0 },
      { name: 'dtc-old-vault', recoveryPointCount: 41 },
    ]);
    assert.ok(inventory.dynamo);
    assert.deepStrictEqual(
      inventory.dynamo.unmanagedTables,
      ['dapier-prod-users', 'dataops-v1-tasks-restore-drill-20260628'],
    );
    assert.deepStrictEqual(inventory.dynamo.restoreDrillTables, ['dataops-v1-tasks-restore-drill-20260628']);
    assert.strictEqual(inventory.dynamo.stackTableCount, 1);
    assert.deepStrictEqual(inventory.errors, []);
  });

  it('records a denied section in errors while still collecting the other sections', async () => {
    const rds = fakeRds([
      {
        match: (c) => c instanceof DescribeDBInstancesCommand,
        respond: () => ({}),
        fail: 'User is not authorized to perform: rds:DescribeDBInstances',
      },
      { match: (c) => c instanceof DescribeDBClustersCommand, respond: () => ({}) },
    ]);
    const backup = fakeBackup([
      {
        match: (c) => c instanceof ListBackupVaultsCommand,
        respond: () => ({ BackupVaultList: [{ BackupVaultName: 'Default' }] }),
      },
      {
        match: (c) => c instanceof DescribeBackupVaultCommand,
        respond: () => ({}),
        fail: 'User is not authorized to perform: backup:DescribeBackupVault',
      },
    ]);
    const dynamo = fakeDynamo([
      { match: (c) => c instanceof ListTablesCommand, respond: () => ({ TableNames: DATAOPS_TABLES.slice(0, 2) }) },
    ]);

    const inventory = await collectLeftoversInventory({ rds, backup, dynamo });

    assert.deepStrictEqual(inventory.rdsInstances, []);
    assert.deepStrictEqual(inventory.rdsClusters, []);
    assert.deepStrictEqual(inventory.backupVaults, [{ name: 'Default', recoveryPointCount: null }]);
    assert.strictEqual(inventory.dynamo?.unmanagedTables.length, 0);
    assert.strictEqual(inventory.errors.length, 2);
    assert.ok(inventory.errors.some((e) => e.startsWith('rds:DescribeDBInstances failed')));
    assert.ok(inventory.errors.some((e) => e.startsWith('backup:DescribeBackupVault(Default) failed')));
  });

  it('renders a markdown summary that marks leftovers and read errors', async () => {
    const inventory = await collectLeftoversInventory({
      rds: fakeRds([
        {
          match: (c) => c instanceof DescribeDBInstancesCommand,
          respond: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'old-dtc-postgres', Engine: 'postgres', DBInstanceStatus: 'available' }],
          }),
        },
        { match: (c) => c instanceof DescribeDBClustersCommand, respond: () => ({}) },
      ]),
      backup: fakeBackup([
        {
          match: (c) => c instanceof ListBackupVaultsCommand,
          respond: () => ({ BackupVaultList: [{ BackupVaultName: 'dtc-old-vault' }] }),
        },
        {
          match: (c) => c instanceof DescribeBackupVaultCommand,
          respond: () => ({ RecoveryPoints: 7 }),
        },
      ]),
      dynamo: fakeDynamo([
        { match: (c) => c instanceof ListTablesCommand, respond: () => ({ TableNames: ['dataops-v1-cards-restore-drill-20261031'] }) },
      ]),
    });

    const summary = markdownSummary(inventory);
    assert.ok(summary.includes('# AWS leftovers inventory (read-only)'));
    assert.ok(summary.includes('- old-dtc-postgres: engine=postgres status=available'));
    assert.ok(summary.includes('- dtc-old-vault: recovery points 7'));
    assert.ok(summary.includes('- dataops-v1-cards-restore-drill-20261031 (restore-drill leftover)'));
    assert.ok(summary.includes('any listed RDS resource'));
  });

  it('collects nothing without credentials failures when no client is reachable at all', async () => {
    const inventory = await collectLeftoversInventory({
      rds: fakeRds([{ match: () => true, respond: () => ({}), fail: 'ENOTFOUND' }]),
      backup: fakeBackup([{ match: () => true, respond: () => ({}), fail: 'ENOTFOUND' }]),
      dynamo: fakeDynamo([{ match: () => true, respond: () => ({}), fail: 'ENOTFOUND' }]),
    });

    assert.deepStrictEqual(inventory.rdsInstances, []);
    assert.deepStrictEqual(inventory.backupVaults, []);
    assert.strictEqual(inventory.dynamo, null);
    // Two RDS reads, one vault listing and one table listing failed.
    assert.strictEqual(inventory.errors.length, 4);
  });
});
