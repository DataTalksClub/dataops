import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR } from './tableNames';
import {
  isHoldExpired,
  parseHoldCalendars,
  releaseHoldRecord,
  type CalendarHold,
  type CalendarHoldStatus,
} from '../calendar/holds';
import {
  deleteHoldGoogleEvents,
  type HoldGoogleDeps,
} from '../calendar/holdGoogleSync';
import { getCalendarOverlaySettings } from './calendar';
import { getCardConsistent } from './cards';
import { createNotification, listAllNotifications } from './notifications';
import { createTask, getTask } from './tasks';
import { resolveDefaultAssigneeId } from './workspaceSettings';
import { berlinDate } from '../sponsorFinance/core';

let googleDeps: HoldGoogleDeps = {};
export function setCalendarHoldGoogleDepsForTests(deps: HoldGoogleDeps): void {
  googleDeps = deps;
}

/**
 * Resolve hold Google deps: calendars from the request (optional), Dapier
 * connectionId from DataOps calendar settings (Orin-picked). Explicit
 * googleDeps.connectionId (tests) wins over settings.
 */
export async function calendarInviteDeps(body: any, client: DynamoDBDocumentClient): Promise<HoldGoogleDeps> {
  const calendars = (() => {
    try {
      return parseHoldCalendars(body?.googleCalendars);
    } catch {
      return undefined;
    }
  })();
  let connectionId = googleDeps.connectionId;
  if (!connectionId) {
    const settings = await getCalendarOverlaySettings(client);
    const picked = (settings.connectionId || '').trim();
    connectionId = picked;
  }
  // Machine credential resolution lives in holdGoogleSync via dapierBroker
  // (SM personal-scheduler/dapier-api-token). Tests inject googleDeps.credential.
  return {
    ...googleDeps,
    connectionId,
    ...(calendars ? { calendarIds: calendars } : {}),
  };
}

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

export interface ExpireCalendarHoldFollowUp {
  holdId: string;
  title: string;
  date: string;
  expiredAt: string;
  note: string;
  taskId?: string;
  notificationId?: string;
}

export interface ExpireCalendarHoldsResult {
  expired: CalendarHold[];
  /** Follow-up entries for Orin: a released hold that still needs a human decision. Never a guest email. */
  followUps: ExpireCalendarHoldFollowUp[];
  activeCount: number;
  dryRun: boolean;
}

export interface ExpireCalendarHoldsOptions {
  dryRun?: boolean;
  googleDeps?: HoldGoogleDeps;
}

const EXPIRY_FOLLOW_UP_NOTE =
  'Tentative hold expired without confirmation; DataOps and Google Proposal events released. Orin follow-up needed — do not auto-email the guest.';

/**
 * Release every tentative hold whose TTL has passed, cancel its Google
 * (Proposal) events, and surface a follow-up Task + Notification for Orin.
 * Sends no email and touches no guest channel.
 */
export async function expireCalendarHolds(
  client: DynamoDBDocumentClient,
  nowIso?: string,
  options: ExpireCalendarHoldsOptions = {},
): Promise<ExpireCalendarHoldsResult> {
  const now = nowIso || new Date().toISOString();
  const dryRun = options.dryRun === true;
  const holds = await listCalendarHolds(client, { activeOnly: true });
  const candidates = holds.filter((hold) => isHoldExpired(hold, now));

  if (dryRun) {
    const previews = candidates.map((hold) => releaseHoldRecord(hold, 'expired', now));
    return {
      expired: previews,
      followUps: previews.map((h) => ({
        holdId: h.id,
        title: h.title,
        date: h.date,
        expiredAt: h.releasedAt || now,
        note: EXPIRY_FOLLOW_UP_NOTE,
      })),
      activeCount: holds.length,
      dryRun: true,
    };
  }

  if (candidates.length === 0) {
    return {
      expired: [],
      followUps: [],
      activeCount: holds.length,
      dryRun: false,
    };
  }

  const deps = options.googleDeps ?? await calendarInviteDeps({}, client);
  const dueDate = berlinDate(new Date(now));
  const assigneeId = await resolveDefaultAssigneeId(client);
  const existingNotifications = await listAllNotifications(client);
  const expired: CalendarHold[] = [];
  const followUps: ExpireCalendarHoldFollowUp[] = [];

  for (const hold of candidates) {
    const sync = await deleteHoldGoogleEvents(hold.googleEventIds, { ...deps, sendUpdates: 'none' });
    const released = releaseHoldRecord(hold, 'expired', now);
    const next: CalendarHold = {
      ...released,
      ...(sync.state === 'synced'
        ? { googleSync: { state: 'synced' as const } }
        : { googleSync: { state: 'deferred' as const, reason: sync.reason } }),
    };
    await putCalendarHold(client, next);
    expired.push(next);

    const expiredAt = next.releasedAt || now;
    const taskId = `calendar-hold-expired-${next.id}`;
    let task = await getTask(client, taskId);
    if (!task) {
      const card = next.cardId ? await getCardConsistent(client, next.cardId) : null;
      const activeCardId = card && card.status === 'active' ? card.id : undefined;
      task = await createTask(client, {
        id: taskId,
        description: `Follow up on expired tentative calendar hold "${next.title}" (${next.date}): slot released after ${next.expiresDays}d without confirmation; follow up with guest if needed (do not auto-email).`,
        date: dueDate,
        status: 'todo',
        source: 'calendar-hold-expiry',
        tags: ['calendar-hold', 'follow-up'],
        comment: EXPIRY_FOLLOW_UP_NOTE,
        ...(assigneeId ? { assigneeId } : {}),
        ...(activeCardId ? { cardId: activeCardId } : {}),
      });
    }

    let notification = existingNotifications.find(
      (n) => n.type === 'follow-up-due' && n.taskId === task!.id,
    );
    if (!notification) {
      notification = await createNotification(client, {
        type: 'follow-up-due',
        message: `Tentative calendar hold "${next.title}" (${next.date}) expired and was released — Orin follow-up needed (no guest email sent)`,
        taskId: task.id,
        ...(task.cardId ? { cardId: task.cardId } : {}),
        dueAt: dueDate,
        metadata: {
          holdId: next.id,
          holdTitle: next.title,
          holdDate: next.date,
          expiredAt,
        },
      });
      existingNotifications.push(notification);
    }

    followUps.push({
      holdId: next.id,
      title: next.title,
      date: next.date,
      expiredAt,
      note: EXPIRY_FOLLOW_UP_NOTE,
      taskId: task.id,
      notificationId: notification.id,
    });
  }

  return {
    expired,
    followUps,
    activeCount: holds.length,
    dryRun: false,
  };
}
