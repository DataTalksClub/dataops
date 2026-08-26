import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_NOTIFICATIONS } from './tableNames';
import { readCollectionPage } from './collectionPage';
import { listIntakeItems } from './intake';
import { listTasksByStatus } from './tasks';
import type { IntakeItem, Notification, Task } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Notification | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as Notification;
}

/**
 * Create a new notification. Generates a UUID, sets createdAt.
 */
async function createNotification(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Notification> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `NOTIFICATION#${id}`,
    SK: `NOTIFICATION#${id}`,
    id,
    dismissed: false,
    createdAt: now,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_NOTIFICATIONS,
      Item: item,
    })
  );

  return cleanItem(item) as Notification;
}

function isDueWaitingTask(task: Task, nowIso: string): boolean {
  return (
    task.status === 'waiting' &&
    typeof task.followUpAt === 'string' &&
    task.followUpAt.trim().length > 0 &&
    task.followUpAt <= nowIso
  );
}

function followUpMessage(task: Task): string {
  const waitingFor = task.waitingFor ? ` — waiting for ${task.waitingFor}` : '';
  return `Follow up: ${task.description}${waitingFor}`;
}

function isDueBlockedIntake(item: IntakeItem, nowIso: string): boolean {
  return (
    item.status === 'blocked'
    && (!item.taskIds || item.taskIds.length === 0)
    && typeof item.followUpAt === 'string'
    && item.followUpAt.trim().length > 0
    && item.followUpAt <= nowIso
  );
}

function intakeFollowUpMessage(item: IntakeItem): string {
  const waitingFor = item.waitingFor ? ` — waiting for ${item.waitingFor}` : '';
  return `Intake follow-up due: ${item.title}${waitingFor}`;
}

/**
 * Create one follow-up notification for each due waiting task or standalone blocked
 * Intake item and followUpAt value.
 * Dismissed reminders are still considered generated, so dismissing a reminder does
 * not recreate it until the task/Intake gets a new followUpAt value.
 */
async function createDueFollowUpNotifications(
  client: DynamoDBDocumentClient,
  options: { now?: string } = {}
): Promise<Notification[]> {
  const now = options.now || new Date().toISOString();
  const waitingTasks = await listTasksByStatus(client, 'waiting');
  const blockedIntake = await listIntakeItems(client, { status: 'blocked', standaloneOnly: 'true', dueFollowUpAt: now });
  const existing = await listAllNotifications(client);
  const existingKeys = new Set(
    existing
      .filter((notification) => notification.type === 'follow-up-due' && (notification.taskId || notification.intakeItemId) && notification.dueAt)
      .map((notification) => `${notification.taskId ? `task#${notification.taskId}` : `intake#${notification.intakeItemId}`}#${notification.dueAt}`)
  );

  const created: Notification[] = [];
  for (const task of waitingTasks) {
    if (!isDueWaitingTask(task, now)) continue;
    const key = `task#${task.id}#${task.followUpAt}`;
    if (existingKeys.has(key)) continue;

    const notification = await createNotification(client, {
      type: 'follow-up-due',
      message: followUpMessage(task),
      taskId: task.id,
      cardId: task.cardId,
      dueAt: task.followUpAt,
    });
    existingKeys.add(key);
    created.push(notification);
  }

  for (const item of blockedIntake) {
    if (!isDueBlockedIntake(item, now)) continue;
    const key = `intake#${item.id}#${item.followUpAt}`;
    if (existingKeys.has(key)) continue;

    const notification = await createNotification(client, {
      type: 'follow-up-due',
      message: intakeFollowUpMessage(item),
      intakeItemId: item.id,
      dueAt: item.followUpAt,
      metadata: {
        kind: 'intake-follow-up-due',
        source: item.source,
        title: item.title,
        waitingFor: item.waitingFor,
      },
    });
    existingKeys.add(key);
    created.push(notification);
  }

  return created;
}

async function dismissIntakeFollowUpNotifications(
  client: DynamoDBDocumentClient,
  intakeItemId: string,
  dueAt?: string
): Promise<number> {
  const notifications = await listAllNotifications(client);
  const matches = notifications.filter((notification) => (
    notification.type === 'follow-up-due'
    && notification.intakeItemId === intakeItemId
    && notification.dismissed === false
    && (!dueAt || notification.dueAt === dueAt)
  ));

  await Promise.all(matches.map((notification) => (
    client.send(new UpdateCommand({
      TableName: TABLE_NOTIFICATIONS,
      Key: { PK: `NOTIFICATION#${notification.id}`, SK: `NOTIFICATION#${notification.id}` },
      UpdateExpression: 'SET dismissed = :dismissed',
      ExpressionAttributeValues: { ':dismissed': true },
    }))
  )));

  return matches.length;
}

/**
 * Get a notification by id.
 */
async function getNotification(client: DynamoDBDocumentClient, id: string): Promise<Notification | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NOTIFICATIONS,
      Key: { PK: `NOTIFICATION#${id}`, SK: `NOTIFICATION#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Dismiss a notification by setting dismissed to true.
 */
async function dismissNotification(client: DynamoDBDocumentClient, id: string): Promise<Notification | null> {
  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NOTIFICATIONS,
      Key: { PK: `NOTIFICATION#${id}`, SK: `NOTIFICATION#${id}` },
      UpdateExpression: 'SET dismissed = :dismissed',
      ExpressionAttributeValues: { ':dismissed': true },
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * List undismissed notifications, sorted by most recent first.
 * If userId is provided, returns notifications where userId matches OR userId is absent (global).
 */
async function listUndismissedNotifications(client: DynamoDBDocumentClient, userId?: string): Promise<Notification[]> {
  return scanNotifications(client, 'begins_with(PK, :prefix) AND dismissed = :dismissed', {
    ':prefix': 'NOTIFICATION#',
    ':dismissed': false,
  }, userId).then((items) => {
    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return items;
  });
}

/**
 * List ALL notifications (dismissed and undismissed), undismissed first, then by createdAt descending.
 * If userId is provided, returns notifications where userId matches OR userId is absent (global).
 */
async function listAllNotifications(client: DynamoDBDocumentClient, userId?: string): Promise<Notification[]> {
  return scanNotifications(client, 'begins_with(PK, :prefix)', {
    ':prefix': 'NOTIFICATION#',
  }, userId).then((items) => {
    items.sort((left, right) => {
      if (left.dismissed !== right.dismissed) return left.dismissed ? 1 : -1;
      return right.createdAt.localeCompare(left.createdAt);
    });
    return items;
  });
}

/**
 * Collect a bounded-complete repository set. Client-facing API reads use
 * `list*NotificationsPage`; dismissal must never stop at an API logical page.
 */
async function scanNotifications(
  client: DynamoDBDocumentClient,
  filterExpression: string,
  values: Record<string, unknown>,
  userId?: string,
): Promise<Notification[]> {
  const items: Notification[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let pageIndex = 0; pageIndex < MAX_NOTIFICATION_SCAN_PAGES; pageIndex += 1) {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NOTIFICATIONS,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: values,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const rawItem of result.Items || []) {
      const notification = cleanItem(rawItem as Record<string, unknown>);
      if (!notification) continue;
      if (!userId || !notification.userId || notification.userId === userId) {
        items.push(notification);
      }
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return items;
  }
  throw new Error('Notification listing exceeded its bounded page limit');
}

type NotificationBinding = Parameters<typeof readCollectionPage<Notification>>[0]['binding'];

function listNotificationsPage(
  client: DynamoDBDocumentClient,
  all: boolean,
  viewerId: string,
  binding: NotificationBinding,
  pagination: Record<string, unknown>,
) {
  // The router resolves the portal-admin placeholder to an empty viewer for
  // its deliberately unscoped operator read.
  const visible = (item: Notification): boolean =>
    viewerId === '' || !item.userId || item.userId === viewerId;
  return readCollectionPage<Notification>({
    client,
    tableName: TABLE_NOTIFICATIONS,
    kind: 'scan',
    command: {
      FilterExpression: all ? 'begins_with(PK, :prefix)' : 'begins_with(PK, :prefix) AND dismissed = :dismissed',
      ExpressionAttributeValues: all
        ? { ':prefix': 'NOTIFICATION#' }
        : { ':prefix': 'NOTIFICATION#', ':dismissed': false },
    },
    binding,
    input: pagination,
    keyFor: (notification) => ({
      PK: `NOTIFICATION#${notification.id}`,
      SK: `NOTIFICATION#${notification.id}`,
    }),
    matches: visible,
    cleanItem: (item) => {
      const notification = cleanItem(item);
      if (!notification) throw new Error('Canonical Notification was absent');
      return notification;
    },
  });
}

const MAX_NOTIFICATION_SCAN_PAGES = 200;

/**
 * Dismiss all undismissed notifications. Returns the count of notifications dismissed.
 */
async function dismissAllNotifications(client: DynamoDBDocumentClient): Promise<number> {
  // First scan for all undismissed notifications
  const undismissed = await listUndismissedNotifications(client);

  if (undismissed.length === 0) {
    return 0;
  }

  // Update each one to dismissed
  await Promise.all(
    undismissed.map((n) =>
      client.send(
        new UpdateCommand({
          TableName: TABLE_NOTIFICATIONS,
          Key: { PK: `NOTIFICATION#${n.id}`, SK: `NOTIFICATION#${n.id}` },
          UpdateExpression: 'SET dismissed = :dismissed',
          ExpressionAttributeValues: { ':dismissed': true },
        })
      )
    )
  );

  return undismissed.length;
}

export {
  createNotification,
  createDueFollowUpNotifications,
  dismissIntakeFollowUpNotifications,
  getNotification,
  dismissNotification,
  listUndismissedNotifications,
  listAllNotifications,
  listNotificationsPage,
  dismissAllNotifications,
};
