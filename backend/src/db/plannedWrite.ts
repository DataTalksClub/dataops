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
