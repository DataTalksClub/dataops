import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeContinuousBackupsCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';

import { checkDynamoPitrStatus, publishPitrGuardAlert } from '../src/export/dynamoPitrCheck';
import { DATAOPS_TABLES, TABLE_SESSIONS } from '../src/db/tableNames';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { listUndismissedNotifications } from '../src/db/notifications';
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

function fakeDocClient(
  statusByTable: Record<string, string>,
  failing: string[] = [],
  listedTables: string[] = [],
) {
  return {
    send: async (command: unknown) => {
      if (command instanceof ListTablesCommand) {
        return { TableNames: listedTables };
      }
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

  it('treats the sessions table as expected-disabled and publishes zero', async () => {
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };

    const result = await checkDynamoPitrStatus(
      fakeDocClient({ [TABLE_SESSIONS]: 'DISABLED' }),
      { cloudWatch: cloudWatch as never },
    );

    assert.deepStrictEqual(result.disabledTables, []);
    assert.deepStrictEqual(result.expectedDisabledTables, [TABLE_SESSIONS]);
    assert.deepStrictEqual(result.unknownTables, []);
    const input = (sent[0] as unknown as { input: { MetricData: { Value: number }[] } }).input;
    assert.strictEqual(input.MetricData[0].Value, 0);
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

  it('discovers extra prefix tables (dapier-*) and skips restore-drill tables', async () => {
    const sent: unknown[] = [];
    const cloudWatch = { send: async (command: unknown) => { sent.push(command); return {}; } };
    const result = await checkDynamoPitrStatus(
      fakeDocClient(
        { 'dapier-ExecutionsTable-1979GG3M1G3ON': 'DISABLED' },
        [],
        [
          'dapier-ExecutionsTable-1979GG3M1G3ON',
          'dapier-ExecutionsTable-1979GG3M1G3ON-restore-drill-20261027',
          'unrelated-table',
        ],
      ),
      { cloudWatch: cloudWatch as never, extraTablePrefixes: ['dapier-'] },
    );

    assert.strictEqual(result.tableCount, DATAOPS_TABLES.length + 1);
    assert.deepStrictEqual(result.disabledTables, ['dapier-ExecutionsTable-1979GG3M1G3ON']);
  });

  it('publishes a signed SNS alarm notification targeting dev@dtcdev.click when PITR is disabled', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const outcome = await publishPitrGuardAlert(
      {
        generatedAt: '2026-10-30T07:00:00.000Z',
        tableCount: 18,
        disabledTables: ['dataops-v1-tasks'],
        expectedDisabledTables: [TABLE_SESSIONS],
        unknownTables: [],
        tables: [],
      },
      {
        topicArn: 'arn:aws:sns:eu-west-1:817685572750:dapier-AlarmTopic-6LjEWSJwA6Ya',
        alertEmail: 'dev@dtcdev.click',
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          sessionToken: 'AQoDYXdzEJr1',
        },
        now: new Date('2026-10-30T07:00:05.000Z'),
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init: init || {} });
          return new Response('<PublishResponse/>', { status: 200 });
        }) as typeof fetch,
      },
    );

    assert.strictEqual(outcome.published, true);
    assert.strictEqual(outcome.alertEmail, 'dev@dtcdev.click');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://sns.eu-west-1.amazonaws.com/');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261030\/eu-west-1\/sns\/aws4_request/);
    assert.strictEqual(headers['x-amz-security-token'], 'AQoDYXdzEJr1');
    const params = new URLSearchParams(String(calls[0].init.body));
    assert.strictEqual(params.get('Action'), 'Publish');
    assert.strictEqual(params.get('TopicArn'), 'arn:aws:sns:eu-west-1:817685572750:dapier-AlarmTopic-6LjEWSJwA6Ya');
    const payload = JSON.parse(params.get('Message') || '{}');
    assert.strictEqual(payload.AlarmName, 'dataops-v1-dynamo-pitr-disabled');
    assert.strictEqual(payload.AlertRecipient, 'dev@dtcdev.click');
    assert.deepStrictEqual(payload.DisabledTables, ['dataops-v1-tasks']);
    assert.match(payload.NewStateReason, /dataops-v1-tasks/);
    assert.match(payload.NewStateReason, /dev@dtcdev\.click/);
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

    it('raises one undismissed notification when nothing could be verified, without duplicating it', async () => {
      const event = {
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: { dataopsAction: 'dynamo-pitr-check' },
      };
      await handler(event);
      await handler(event);

      const guardNotes = (await listUndismissedNotifications(await getClient())).filter(
        (notification) => notification.type === 'automation-failure'
          && notification.metadata?.guard === 'dynamo-pitr-check',
      );
      assert.strictEqual(guardNotes.length, 1);
      assert.match(guardNotes[0].message, /unknown/);
    });
  });
});
