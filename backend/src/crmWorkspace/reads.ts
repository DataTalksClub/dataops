import { PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { collectBoundedPages, StoragePaginationError, type StoragePaginationLimits } from '../db/boundedPagination';

/**
 * Owned bounded reads. Nothing here scans a whole kind and filters in memory:
 * notes, views and messages live under target-/owner-keyed PKs and are read by Query.
 * Reads paginate cleanly with cursor/limit without failing on bounds.
 */

/** History events per booking: a guardrail, never a trim. */
export const MAX_HISTORY_EVENTS = 500;
/** Deal-history events across one organization's deals. */
export const MAX_ORG_DEAL_HISTORY = 1_000;
/** Notes per record target. */
export const MAX_TARGET_NOTES = 500;
/** Message scan bounds: server-side filter, so scanned >> matched is normal. */
export const MAX_MESSAGE_SCANNED = 20_000;
export const MAX_MESSAGE_MATCHED = 1_000;
const READ_DEADLINE_MS = 10_000;

export const HISTORY_LIMITS: StoragePaginationLimits = {
  maxPages: 50,
  maxItems: MAX_HISTORY_EVENTS,
  maxBytes: 4 * 1024 * 1024,
  deadlineMs: READ_DEADLINE_MS,
};

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

/**
 * Owned paginated history read: Query by PK (HISTORY#booking) instead of the
 * shared single-page Scan helper, which this package must not modify. Oldest
 * first (SK order); callers sort for display.
 */
export async function queryHistoryEvents(
  client: DynamoDBDocumentClient,
  bookingId: string,
  source: string,
  limit?: number,
): Promise<{ items: Record<string, unknown>[]; itemsRead: number; hasMore?: boolean }> {
  if (limit !== undefined && limit > 0) {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `HISTORY#${bookingId}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const items = (result.Items || []).map(clean);
    return { items, itemsRead: items.length, hasMore: !!result.LastEvaluatedKey };
  }
  let items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `HISTORY#${bookingId}` },
        ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    items.push(...(result.Items || []).map(clean));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return { items, itemsRead: items.length, hasMore: false };
}

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
  source: string,
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
