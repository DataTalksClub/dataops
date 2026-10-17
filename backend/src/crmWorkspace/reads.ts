import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { scanCrmPrefix } from '../db/sponsorCrm';
import { StoragePaginationError, type StoragePaginationLimits } from '../db/boundedPagination';

/**
 * Bounded direct reads for CRM kinds the per-request snapshot does not cover
 * (`MESSAGE#`, `NOTE#`, `SAVEDVIEW#`). Snapshot-covered kinds keep using
 * `listCrmRecords`; these helpers scan their own prefix with explicit limits
 * and fail loudly instead of truncating silently.
 */
export const WORKSPACE_SCAN_LIMITS: StoragePaginationLimits = {
  maxPages: 50,
  maxItems: 2_000,
  maxBytes: 8 * 1024 * 1024,
  deadlineMs: 10_000,
};

/** History events per booking are small; the cap is a guardrail, never a trim. */
export const MAX_HISTORY_EVENTS = 500;
/** Deal-history events across one organization's deals. */
export const MAX_ORG_DEAL_HISTORY = 1_000;

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

const clean = (item: Record<string, unknown>): Record<string, unknown> => {
  const { PK, SK, ...record } = item;
  void PK;
  void SK;
  return record;
};

/**
 * All raw items under one PK prefix, newest SK first where the SK sorts that
 * way. Bounded: throws `workspace_source_too_large` past the limits.
 */
export async function scanPrefixNewest(
  client: DynamoDBDocumentClient,
  prefix: string,
  source: string,
): Promise<{ items: Record<string, unknown>[]; itemsRead: number }> {
  let items: Record<string, unknown>[];
  try {
    items = await scanCrmPrefix(client, prefix, WORKSPACE_SCAN_LIMITS);
  } catch (error) {
    throw workspaceErrorOf(error, source);
  }
  return { items, itemsRead: items.length };
}

export async function listKindRecords(
  client: DynamoDBDocumentClient,
  kind: string,
  source: string,
): Promise<{ items: Record<string, unknown>[]; itemsRead: number }> {
  const { items, itemsRead } = await scanPrefixNewest(client, `${kind.toUpperCase()}#`, source);
  return { items: items.map(clean), itemsRead };
}

/**
 * Owned paginated history read: Query by PK (HISTORY#booking) instead of the
 * shared single-page Scan helper, which this package must not modify. Returns
 * oldest-first (SK order); callers sort for display. Throws
 * `workspace_source_too_large` past MAX_HISTORY_EVENTS while pages remain.
 */
export async function queryHistoryEvents(
  client: DynamoDBDocumentClient,
  bookingId: string,
  source: string,
): Promise<{ items: Record<string, unknown>[]; itemsRead: number }> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  for (;;) {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `HISTORY#${bookingId}` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    for (const item of result.Items || []) items.push(clean(item as Record<string, unknown>));
    if (!result.LastEvaluatedKey) return { items, itemsRead: items.length };
    if (items.length >= MAX_HISTORY_EVENTS) throw sourceTooLarge(source);
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown>;
  }
}
