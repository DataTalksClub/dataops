import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { usesLocalTransactionEmulation } from './client';
import type { TransactionItem } from './plannedWrite';

type Dict = Record<string, unknown>;

/**
 * Write `items` atomically with DynamoDB TransactWriteItems.
 *
 * Dynalite has no TransactWriteItems, so when local test tooling has enabled
 * emulation the items run one at a time instead, each as its own Put, Update
 * or Delete with its own condition. Emulated transactions are serialized, and
 * a failed item restores every row the earlier items changed. A failed
 * condition surfaces the way DynamoDB reports it, as a
 * TransactionCanceledException whose CancellationReasons name the item, so
 * callers handle one error shape on both paths.
 */
export async function transactWrite(
  client: DynamoDBDocumentClient,
  items: TransactionItem[],
  token?: string,
): Promise<void> {
  if (usesLocalTransactionEmulation()) {
    await emulateSerialized(client, items);
    return;
  }
  await client.send(new TransactWriteCommand({
    ...(token ? { ClientRequestToken: token } : {}),
    TransactItems: items,
  }));
}

let emulationTail: Promise<void> = Promise.resolve();

async function emulateSerialized(client: DynamoDBDocumentClient, items: TransactionItem[]): Promise<void> {
  const previous = emulationTail;
  let release!: () => void;
  emulationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await emulate(client, items);
  } finally {
    release();
  }
}

function itemTarget(item: TransactionItem): { tableName: string; key: Dict } {
  if (item.Put) {
    const row = item.Put.Item as Dict;
    return { tableName: item.Put.TableName!, key: { PK: row.PK, SK: row.SK } };
  }
  if (item.Update) return { tableName: item.Update.TableName!, key: item.Update.Key as Dict };
  if (item.Delete) return { tableName: item.Delete.TableName!, key: item.Delete.Key as Dict };
  throw new Error('Local transaction emulation supports only Put, Update and Delete items');
}

function cancellation(failedIndex: number, count: number): Error {
  const reasons = Array.from({ length: count }, (_, index) => (
    { Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None' }
  ));
  const error = new Error(
    `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map(({ Code }) => Code).join(', ')}]`,
  ) as Error & { CancellationReasons: typeof reasons };
  error.name = 'TransactionCanceledException';
  error.CancellationReasons = reasons;
  return error;
}

async function emulate(client: DynamoDBDocumentClient, items: TransactionItem[]): Promise<void> {
  const snapshots: Array<{ tableName: string; key: Dict; before: Dict | undefined }> = [];
  for (const item of items) {
    const { tableName, key } = itemTarget(item);
    const current = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    snapshots.push({ tableName, key, before: current.Item as Dict | undefined });
  }

  // Test-only fault injection: fail after this many items have been applied.
  const failAfter = Number(process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER || 0);
  let applied = 0;
  try {
    for (const item of items) {
      if (item.Put) await client.send(new PutCommand(item.Put));
      else if (item.Update) await client.send(new UpdateCommand(item.Update));
      else await client.send(new DeleteCommand(item.Delete!));
      applied += 1;
      if (failAfter === applied) throw new Error('Injected local transaction failure');
    }
  } catch (error) {
    for (const { tableName, key, before } of snapshots.slice(0, applied).reverse()) {
      if (before) await client.send(new PutCommand({ TableName: tableName, Item: before }));
      else await client.send(new DeleteCommand({ TableName: tableName, Key: key }));
    }
    if ((error as Error).name === 'ConditionalCheckFailedException') throw cancellation(applied, items.length);
    throw error;
  }
}
