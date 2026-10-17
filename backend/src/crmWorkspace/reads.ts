import { PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { collectBoundedPages, StoragePaginationError, type StoragePaginationLimits } from '../db/boundedPagination';

/**
 * Owned bounded reads. Nothing here scans a whole kind and filters in memory:
 * notes and views live under target-/owner-keyed PKs and are read by Query;
 * messages (an existing kind this package must not rekey) are read by an
 * owned Scan with a server-side FilterExpression. Every bound fails loudly
 * instead of truncating silently.
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
 * first (SK order); callers sort for display. The bound applies to every page
 * including the last: one event past MAX_HISTORY_EVENTS fails, never trims.
 */
export async function queryHistoryEvents(
  client: DynamoDBDocumentClient,
  bookingId: string,
  source: string,
): Promise<{ items: Record<string, unknown>[]; itemsRead: number }> {
  let items: Record<string, unknown>[];
  try {
    items = await collectBoundedPages<Record<string, unknown>>({
      limits: HISTORY_LIMITS,
      loadPage: async (ExclusiveStartKey, abortSignal) =>
        client.send(
          new QueryCommand({
            TableName: TABLE_SPONSOR_CRM,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `HISTORY#${bookingId}` },
            ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
          }),
          { abortSignal },
        ),
    });
  } catch (error) {
    throw workspaceErrorOf(error, source);
  }
  return { items: items.map(clean), itemsRead: items.length };
}

export type MessageScanTarget =
  | { targetType: 'organization' | 'deal'; targetId: string }
  | { targetType: 'contact'; targetId: string; organizationId: string; emails: string[] };

export type ScanLimits = { maxScanned: number; maxMatched: number; deadlineMs: number; pageSize: number };
const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxScanned: MAX_MESSAGE_SCANNED,
  maxMatched: MAX_MESSAGE_MATCHED,
  deadlineMs: READ_DEADLINE_MS,
  pageSize: 200,
};

/**
 * Messages for one record, filtered server-side (never "scan the table, keep
 * one org"). Reports both scanned (rows evaluated) and matched (rows kept) so
 * responses count evidence truthfully. Runs through repo `collectBoundedPages`
 * (page/abort/timeout/repeated-cursor guards); exceeding the scanned/matched
 * caps fails loudly; `limits` override exists for tests to prove the bound
 * against real storage.
 */
export async function scanTargetMessages(
  client: DynamoDBDocumentClient,
  target: MessageScanTarget,
  source: string,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<{ items: Record<string, unknown>[]; scanned: number; matched: number }> {
  const values: Record<string, unknown> = { ':pfx': 'MESSAGE#' };
  let targetFilter: string;
  if (target.targetType === 'contact') {
    // Provably linked person mail only: explicit contact link, or an address
    // the contact owns at the same organization. No company-wide inheritance.
    // :org binds ONLY when an email predicate emits it (Dynamo rejects unused
    // values; phone-only people have no emails and must not 500).
    const ors = ['contactId = :cid'];
    values[':cid'] = target.targetId;
    const emails = target.emails.slice(0, 10);
    if (emails.length > 0) {
      values[':org'] = target.organizationId;
      emails.forEach((address, index) => {
        ors.push(`(organizationId = :org AND personEmail = :em${index})`);
        values[`:em${index}`] = address;
      });
    }
    targetFilter = `(${ors.join(' OR ')})`;
  } else if (target.targetType === 'deal') {
    values[':id'] = target.targetId;
    targetFilter = 'dealId = :id';
  } else {
    values[':id'] = target.targetId;
    targetFilter = 'organizationId = :id';
  }
  let scanned = 0;
  let items: Record<string, unknown>[];
  try {
    items = await collectBoundedPages<Record<string, unknown>>({
      limits: { maxPages: 50, maxItems: limits.maxMatched, maxBytes: 8 * 1024 * 1024, deadlineMs: limits.deadlineMs },
      loadPage: async (ExclusiveStartKey, abortSignal) => {
        const result = await client.send(
          new ScanCommand({
            TableName: TABLE_SPONSOR_CRM,
            ConsistentRead: true,
            FilterExpression: `begins_with(PK, :pfx) AND ${targetFilter}`,
            ExpressionAttributeValues: values,
            Limit: limits.pageSize,
            ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
          }),
          { abortSignal },
        );
        scanned += typeof result.ScannedCount === 'number' ? result.ScannedCount : (result.Items || []).length;
        if (scanned > limits.maxScanned) throw sourceTooLarge(source);
        return result;
      },
    });
  } catch (error) {
    // sourceTooLarge already carries its code; storage guard failures map to it.
    if ((error as { code?: string }).code === 'workspace_source_too_large') throw error;
    throw workspaceErrorOf(error, source);
  }
  return { items: items.map(clean), scanned, matched: items.length };
}
