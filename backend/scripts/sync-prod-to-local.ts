/**
 * Copy production DynamoDB data into the local dynalite instance so the
 * local dev portal shows the same data as prod.
 *
 * Reads prod with the ambient AWS credential chain (read-only: Scan only).
 * Writes only to the explicit loopback endpoint. The secrets table is never
 * copied. Document binaries stay in prod S3; rows referencing them copy over,
 * but local download URLs will not open without prod S3 credentials.
 *
 * Usage: npm run sync:prod-data [-- --endpoint http://127.0.0.1:8000]
 */
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';

import { getClient } from '../src/db/client';
import { DATAOPS_TABLES, TABLE_SECRETS } from '../src/db/tableNames';
import { createTables, deleteTables } from './local-dynamodb';

const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:8000';

const tablesToCopy = (): string[] => DATAOPS_TABLES.filter((table) => table !== TABLE_SECRETS);

/** Wait until every copied table is ACTIVE (want=true) or fully absent (want=false). */
async function waitForTables(
  client: Awaited<ReturnType<typeof getClient>>,
  want: boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const states = await Promise.all(tablesToCopy().map(async (table) => {
      try {
        const described = await client.send(new DescribeTableCommand({ TableName: table }));
        return described.Table?.TableStatus || 'UNKNOWN';
      } catch {
        return 'ABSENT';
      }
    }));
    // A DELETING table is neither ready nor gone: keep waiting either way.
    if (states.every((state) => (want ? state === 'ACTIVE' : state === 'ABSENT'))) return;
    if (attempt >= 120) {
      throw new Error(want
        ? 'Local tables did not become ACTIVE in time'
        : 'Local tables did not finish deleting in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function localEndpoint(): string {
  const flagIndex = process.argv.indexOf('--endpoint');
  const endpoint = (flagIndex === -1 ? undefined : process.argv[flagIndex + 1])
    || process.env.DYNAMODB_ENDPOINT
    || DEFAULT_LOCAL_ENDPOINT;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`Refusing to write to a non-loopback endpoint: ${endpoint}`);
  }
  return endpoint;
}

async function scanAll(client: Awaited<ReturnType<typeof getClient>>, table: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    const page = await client.send(new ScanCommand({
      TableName: table,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const item of page.Items || []) items.push(item as Record<string, unknown>);
    if (!page.LastEvaluatedKey) return items;
    startKey = page.LastEvaluatedKey as Record<string, unknown>;
  }
}

async function batchPutAll(
  client: Awaited<ReturnType<typeof getClient>>,
  table: string,
  items: Record<string, unknown>[],
): Promise<void> {
  for (let index = 0; index < items.length; index += 25) {
    let batch = items.slice(index, index + 25).map((item) => ({ PutRequest: { Item: item } }));
    for (let attempt = 0; batch.length > 0; attempt += 1) {
      const result = await client.send(new BatchWriteCommand({ RequestItems: { [table]: batch } }));
      const unprocessed = result.UnprocessedItems?.[table] || [];
      if (unprocessed.length === 0) break;
      if (attempt >= 8) throw new Error(`Gave up writing ${unprocessed.length} items to local ${table}`);
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      batch = unprocessed as typeof batch;
    }
  }
}

async function main(): Promise<void> {
  const endpoint = localEndpoint();
  delete process.env.DYNAMODB_ENDPOINT;
  const prod = await getClient();
  process.env.DYNAMODB_ENDPOINT = endpoint;
  const local = await getClient();

  await deleteTables(local);
  // Dynalite deletes asynchronously: a recreate issued while a table is
  // still DELETING is skipped as ResourceInUse, and the table ends up gone.
  // Wait until every table is absent before recreating.
  await waitForTables(local, false);
  await createTables(local);

  // createTables issues all creates in parallel and returns once the API
  // calls return; dynalite activates tables asynchronously, so wait until
  // every table reports ACTIVE before writing.
  await waitForTables(local, true);

  const tables = tablesToCopy();
  let total = 0;
  for (const table of tables) {
    const items = await scanAll(prod, table);
    await batchPutAll(local, table, items);
    total += items.length;
    console.log(`${table}: ${items.length} rows copied`);
  }
  console.log(`Skipped ${TABLE_SECRETS} (never copied locally). Total rows: ${total}.`);
}

main().catch((error: unknown) => {
  console.error((error as Error)?.message || 'Prod-to-local sync failed');
  process.exit(1);
});
