import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR } from './tableNames';
import {
  isHoldExpired,
  releaseHoldRecord,
  type CalendarHold,
  type CalendarHoldStatus,
} from '../calendar/holds';

const PREFIX = 'CALHOLD#';
const key = (id: string) => ({ PK: `${PREFIX}${id}`, SK: `${PREFIX}${id}` });

function clean(item: Record<string, unknown> | undefined): CalendarHold | null {
  if (!item) return null;
  const { PK, SK, ...data } = item;
  if (typeof data.id !== 'string') return null;
  return data as unknown as CalendarHold;
}

export async function getCalendarHold(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<CalendarHold | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: key(id) }));
  return clean(result.Item as Record<string, unknown> | undefined);
}

export async function putCalendarHold(client: DynamoDBDocumentClient, hold: CalendarHold): Promise<void> {
  await client.send(new PutCommand({ TableName: TABLE_CALENDAR, Item: { ...hold, ...key(hold.id) } }));
}

export interface CalendarHoldFilter {
  from?: string;
  to?: string;
  status?: CalendarHoldStatus;
  activeOnly?: boolean;
}

function inRange(hold: CalendarHold, from?: string, to?: string): boolean {
  if (from && hold.date < from) return false;
  if (to && hold.date > to) return false;
  return true;
}

/** Holds are low-volume (one row each), so listing scans the CALHOLD prefix. */
export async function listCalendarHolds(
  client: DynamoDBDocumentClient,
  filter: CalendarHoldFilter = {},
): Promise<CalendarHold[]> {
  const items: CalendarHold[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_CALENDAR,
        FilterExpression: 'begins_with(PK,:prefix)',
        ExpressionAttributeValues: { ':prefix': PREFIX },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    for (const raw of page.Items || []) {
      const hold = clean(raw as Record<string, unknown>);
      if (hold && inRange(hold, filter.from, filter.to)) items.push(hold);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  let out = items.sort((a, b) => a.date.localeCompare(b.date) || a.proposedAt.localeCompare(b.proposedAt));
  if (filter.status) out = out.filter((h) => h.status === filter.status);
  if (filter.activeOnly) out = out.filter((h) => h.status === 'tentative' || h.status === 'confirmed');
  return out;
}

export interface ExpireCalendarHoldsResult {
  expired: CalendarHold[];
  /** Follow-up entries for Orin: a released hold that still needs a human decision. Never a guest email. */
  followUps: Array<{ holdId: string; title: string; date: string; expiredAt: string; note: string }>;
}

/**
 * Release every tentative hold whose TTL has passed. The caller surfaces
 * `followUps` to Orin (task/surface event); this function sends no email and
 * touches no guest channel.
 */
export async function expireCalendarHolds(
  client: DynamoDBDocumentClient,
  nowIso?: string,
): Promise<ExpireCalendarHoldsResult> {
  const now = nowIso || new Date().toISOString();
  const holds = await listCalendarHolds(client, { activeOnly: true });
  const expired: CalendarHold[] = [];
  for (const hold of holds) {
    if (!isHoldExpired(hold, now)) continue;
    const next = releaseHoldRecord(hold, 'expired', now);
    await putCalendarHold(client, next);
    expired.push(next);
  }
  return {
    expired,
    followUps: expired.map((h) => ({
      holdId: h.id,
      title: h.title,
      date: h.date,
      expiredAt: h.releasedAt || now,
      note: `Tentative hold expired without confirmation; DataOps and Google Proposal events released. Orin follow-up needed — do not auto-email the guest.`,
    })),
  };
}
