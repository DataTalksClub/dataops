/**
 * Shared DynamoDB fixture for the unit test suite.
 *
 * This module lives under `tests/` on purpose. The application never creates
 * infrastructure, and the Docker DynamoDB Local transaction scripts run with
 * NODE_ENV=production, so the boundary between "tests may create tables" and
 * "the app may not" is the module location, not an environment variable.
 * Nothing under `src/` may import this file.
 *
 * Node's test runner gives every test file its own process, so "once" here
 * means once per test-file process: the dynalite server and the 16 table
 * definitions are built at most one time no matter how many suites, hooks, or
 * helpers in that file ask for the database.
 *
 * Use `truncateTestTables` when a test needs a clean slate; it deletes rows and
 * leaves the tables in place, which is far cheaper than recreating them.
 *
 * A dynalite server that is never closed keeps its test process alive, and the
 * runner waits for that process forever, so one forgotten teardown used to
 * hang the entire suite. This module always registers the teardown, and the
 * `test` script passes `--test-force-exit` so a future leak costs a stray
 * handle instead of a run that never ends.
 */
import { after } from 'node:test';
import { ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../../src/db/client';
import { startLocal, stopLocal } from '../../scripts/local-dynamodb';
import {
  createTables,
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_USERS,
  TABLE_FILES,
  TABLE_ARTIFACTS,
  TABLE_ASSISTANT_JOBS,
  TABLE_AUDIT_EVENTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
  TABLE_BOOKKEEPING,
  TABLE_SPONSOR_CRM,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_CALENDAR,
  TABLE_CONVERSATIONAL_STATE,
} from '../../scripts/local-dynamodb';

const ALL_TABLES = [
  TABLE_TASKS,
  TABLE_CARDS,
  TABLE_TEMPLATES,
  TABLE_USERS,
  TABLE_FILES,
  TABLE_ARTIFACTS,
  TABLE_ASSISTANT_JOBS,
  TABLE_AUDIT_EVENTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_SESSIONS,
  TABLE_BOOKKEEPING,
  TABLE_SPONSOR_CRM,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_CALENDAR,
  TABLE_CONVERSATIONAL_STATE,
];

type TestDatabase = {
  /** Document client pointed at this process's dynalite server. */
  client: DynamoDBDocumentClient;
  /** Port the in-process dynalite server listens on. */
  port: number;
};

let pending: Promise<TestDatabase> | null = null;

async function start(): Promise<TestDatabase> {
  const port = await startLocal();
  const client = await getClient(port);
  await createTables(client);
  return { client, port };
}

/**
 * Start dynalite and create every application table, once per test process.
 * Repeat calls return the same client without touching DynamoDB again.
 */
async function useTestDatabase(): Promise<TestDatabase> {
  if (!pending) pending = start();
  return pending;
}

// Registered while the importing test file is being evaluated, so it runs even
// when a file forgets its own teardown. A live dynalite server keeps the test
// process alive, and a process that never exits stalls the whole run.
after(async () => {
  if (!pending) return;
  await stopLocal();
});

/**
 * Delete every row from every table, keeping the tables themselves. Use this
 * between tests that must not see each other's data.
 */
async function truncateTestTables(client: DynamoDBDocumentClient): Promise<void> {
  for (const table of ALL_TABLES) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new ScanCommand({
          TableName: table,
          ProjectionExpression: 'PK, SK',
          ExclusiveStartKey: startKey,
        }),
      );
      const keys = (page.Items || []) as { PK: string; SK: string }[];
      for (let i = 0; i < keys.length; i += 25) {
        await client.send(
          new BatchWriteCommand({
            RequestItems: {
              [table]: keys.slice(i, i + 25).map((key) => ({
                DeleteRequest: { Key: { PK: key.PK, SK: key.SK } },
              })),
            },
          }),
        );
      }
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
}

export { useTestDatabase, truncateTestTables, ALL_TABLES };
export type { TestDatabase };
