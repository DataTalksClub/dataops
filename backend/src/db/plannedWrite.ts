import type { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

type Dict = Record<string, unknown>;

export type TransactionItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * One write of a multi-row transaction. `item` is what DynamoDB executes;
 * `holds` and `after` mirror its condition and effect for the local
 * transaction emulators (Dynalite has no TransactWriteItems).
 */
export interface PlannedWrite {
  tableName: string;
  key: Dict;
  item: TransactionItem;
  holds: (current: Dict | undefined) => boolean;
  /** The row after the write, or null when the write deletes it. */
  after: (current: Dict) => Dict | null;
}

/** Recursively drop `undefined` fields so a row can be written as a DynamoDB item. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Dict)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, compact(field)]),
    );
  }
  return value;
}

/** Put a row that must not exist yet. */
export function putNew(tableName: string, key: Dict, row: Dict): PlannedWrite {
  const item = { ...key, ...row };
  return {
    tableName,
    key,
    item: { Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
    holds: (current) => !current,
    after: () => item,
  };
}

/** Replace a row whose stored version is still `version`. */
export function putAtVersion(tableName: string, key: Dict, row: Dict, version: number): PlannedWrite {
  const item = { ...key, ...row };
  return {
    tableName,
    key,
    item: {
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': version },
      },
    },
    holds: (current) => Boolean(current) && current!.version === version,
    after: () => item,
  };
}

/** Delete a row whose stored version is still `version`. */
export function deleteAtVersion(tableName: string, key: Dict, version: number): PlannedWrite {
  return {
    tableName,
    key,
    item: {
      Delete: {
        TableName: tableName,
        Key: key,
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': version },
      },
    },
    holds: (current) => Boolean(current) && current!.version === version,
    after: () => null,
  };
}
