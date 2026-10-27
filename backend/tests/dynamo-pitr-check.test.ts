import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';

import { checkDynamoPitrStatus } from '../src/export/dynamoPitrCheck';
import { DATAOPS_TABLES } from '../src/db/tableNames';
import { handler } from '../src/handler';
import { stopLocal } from '../scripts/local-dynamodb';
import { useTestDatabase } from './helpers/db';

function pitrResponse(status: string) {
  return {
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: 'ENABLED',
      PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: status,
        EarliestRestorableDateTime: new Date('2025-10-26T07:00:00.000Z'),
        LatestRestorableDateTime: new Date('2025-10-27T07:00:00.000Z'),
      },
    },
  };
}

function fakeDocClient(statusByTable: Record<string, string>, failing: string[] = []) {
  return {
    send: async (command: unknown) => {
      assert.ok(command instanceof DescribeContinuousBackupsCommand);
      const table = (command as unknown as { input: { TableName: string } }).input.TableName;
      if (failing.includes(table)) throw new Error(`boom on ${table}`);
      return pitrResponse(statusByTable[table] || 'ENABLED');
    },
  };
}

describe('DynamoDB PITR guard', () => {
  it('reports no disabled tables and publishes a zero metric when PITR is on everywhere', async () => {
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };

    const result = await checkDynamoPitrStatus(fakeDocClient({}), { cloudWatch: cloudWatch as never });

    assert.strictEqual(result.tableCount, DATAOPS_TABLES.length);
    assert.deepStrictEqual(result.disabledTables, []);
    assert.deepStrictEqual(result.unknownTables, []);
    assert.strictEqual(result.tables[0].earliestRestorable, '2025-10-26T07:00:00.000Z');
    assert.strictEqual(result.tables[0].latestRestorable, '2025-10-27T07:00:00.000Z');
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0] instanceof PutMetricDataCommand);
    const input = (sent[0] as unknown as { input: { Namespace: string; MetricData: { MetricName: string; Value: number }[] } }).input;
    assert.strictEqual(input.Namespace, 'DataOps/DynamoBackup');
    assert.strictEqual(input.MetricData[0].MetricName, 'PitrDisabledTables');
    assert.strictEqual(input.MetricData[0].Value, 0);
  });

  it('lists tables with PITR disabled and publishes their count', async () => {
    const [first, second] = DATAOPS_TABLES;
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };

    const result = await checkDynamoPitrStatus(
      fakeDocClient({ [first]: 'DISABLED', [second]: 'DISABLED' }),
      { cloudWatch: cloudWatch as never },
    );

    assert.deepStrictEqual(result.disabledTables, [first, second]);
    assert.deepStrictEqual(result.unknownTables, []);
    const input = (sent[0] as unknown as { input: { MetricData: { Value: number }[] } }).input;
    assert.strictEqual(input.MetricData[0].Value, 2);
  });

  it('treats unreadable tables as unknown without failing the check', async () => {
    const [first] = DATAOPS_TABLES;
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };
    const result = await checkDynamoPitrStatus(
      fakeDocClient({}, [first]),
      { cloudWatch: cloudWatch as never },
    );

    assert.deepStrictEqual(result.disabledTables, []);
    assert.deepStrictEqual(result.unknownTables, [first]);
    assert.match(result.tables.find((t) => t.table === first)?.error || '', /boom/);
    assert.strictEqual(sent.length, 1);
  });

  it('skips the metric publish when no table could be verified', async () => {
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };
    const result = await checkDynamoPitrStatus(
      fakeDocClient({}, [...DATAOPS_TABLES]),
      { cloudWatch: cloudWatch as never },
    );

    assert.strictEqual(result.unknownTables.length, DATAOPS_TABLES.length);
    assert.deepStrictEqual(result.disabledTables, []);
    assert.strictEqual(sent.length, 0);
  });

  it('still returns a result when metric publishing fails', async () => {
    const cloudWatch = { send: async () => { throw new Error('no cloudwatch here'); } };
    const result = await checkDynamoPitrStatus(fakeDocClient({}), { cloudWatch: cloudWatch as never });
    assert.strictEqual(result.tableCount, DATAOPS_TABLES.length);
    assert.deepStrictEqual(result.disabledTables, []);
  });

  describe('scheduled handler', () => {
    const previousEnv = process.env.DATAOPS_ENV;
    before(async () => {
      await useTestDatabase();
      process.env.DATAOPS_ENV = 'test';
    });

    after(async () => {
      if (previousEnv === undefined) delete process.env.DATAOPS_ENV;
      else process.env.DATAOPS_ENV = previousEnv;
      await stopLocal();
    });

    it('answers dynamo-pitr-check scheduled events with table counts (dynalite has no PITR)', async () => {
      const result = await handler({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: { dataopsAction: 'dynamo-pitr-check' },
      });

      assert.ok('statusCode' in result, 'should return an HTTP-style summary');
      assert.strictEqual((result as Record<string, unknown>).statusCode, 200);
      const body = JSON.parse((result as { body: string }).body);
      assert.strictEqual(body.table_count, DATAOPS_TABLES.length);
      assert.deepStrictEqual(body.disabled_tables, []);
      assert.strictEqual(body.unknown_tables.length, DATAOPS_TABLES.length);
    });
  });
});
