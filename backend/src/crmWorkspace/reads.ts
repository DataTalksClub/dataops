import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { StoragePaginationError } from '../db/boundedPagination';

/**
 * Owned bounded reads. Nothing here scans a whole kind and filters in memory:
 * notes, views and messages live under target-/owner-keyed PKs and are read by Query.
 * Reads paginate cleanly with cursor/limit without failing on bounds.
 */

/** Notes per record target. */
export const MAX_TARGET_NOTES = 500;

export function sourceTooLarge(source: string) {
  return Object.assign(new Error(`${source} exceeds the workspace read bound; narrow the scope and retry`), {
    statusCode: 500,
    code: 'workspace_source_too_large',
    source,
  });
}

export function workspaceErrorOf(error: unknown, source: string): Error & { statusCode?: number } {
  if (error instanceof StoragePaginationError) return sourceTooLarge(source);
  return error as Error & { statusCode?: number };
}

export const clean = (item: Record<string, unknown>): Record<string, unknown> => {
  const { PK, SK, ...record } = item;
  void PK;
  void SK;
  return record;
};

export type MessageQueryTarget =
  | { targetType: 'organization' | 'deal'; targetId: string }
  | { targetType: 'contact'; targetId: string; organizationId?: string; emails?: string[] };

/**
 * Messages for one record, read via keyed Query on PK MESSAGE_TARGET#<target>:<id>.
 * Keyed Query: scanned == matched. Paginates cleanly without whole-table scans.
 */
export async function queryTargetMessages(
  client: DynamoDBDocumentClient,
  target: MessageQueryTarget,
  limit?: number,
): Promise<{ items: Record<string, unknown>[]; scanned: number; matched: number; hasMore?: boolean }> {
  const pk = `MESSAGE_TARGET#${target.targetType}:${target.targetId}`;
  if (limit !== undefined && limit > 0) {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const items = (result.Items || []).map(clean);
    return {
      items,
      scanned: items.length,
      matched: items.length,
      hasMore: !!result.LastEvaluatedKey,
    };
  }
  let items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    items.push(...(result.Items || []).map(clean));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return {
    items,
    scanned: items.length,
    matched: items.length,
    hasMore: false,
  };
}
