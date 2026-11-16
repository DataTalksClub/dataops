import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  createDueFollowUpNotifications,
  createDueTaskNotifications,
  getNotification,
  dismissNotification,
  listUndismissedNotifications,
  listAllNotifications,
  listNotificationsPage,
  dismissAllNotifications,
} from '../db/notifications';
import { CollectionCursorError, encodeCollectionCursor } from '../db/collectionPagination';
import { berlinDate } from '../sponsorFinance/core';
import type { LambdaEvent, LambdaResponse } from '../types';
import { recordRequestError } from '../requestErrorLog';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Handle all /api/notifications routes.
 *
 * The router resolves the interactive actor before dispatch and passes the
 * viewer id and whether it carries admin authority; `dismiss-all` clears
 * every user's notifications and is therefore admin-only.
 */
async function handleNotificationRoutes(path: string, method: string, rawBody: string | null, queryParams?: Record<string, string> | null, userId?: string, isAdmin?: boolean): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/notifications')) {
    return null;
  }

  const client = await getClient();

  try {
    const suffix = path.slice('/api/notifications'.length);

    // Route: GET /api/notifications (with optional ?all=true)
    if ((suffix === '' || suffix === '/') && method === 'GET') {
      await createDueFollowUpNotifications(client);
      const all = Boolean(queryParams && queryParams['all'] === 'true');
      const binding = {
        collection: 'notifications',
        filters: { all },
        principal: userId || 'account-viewer',
      };
      const page = await listNotificationsPage(client, all, userId || '', binding, queryParams || {});
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          notifications: {
            items: page.items,
            ...(page.nextExclusiveStartKey ? {
              nextCursor: await encodeCollectionCursor(binding, page.nextExclusiveStartKey),
            } : {}),
          },
        }),
      };
    }

    // Route: POST /api/notifications/due-tasks
    if (suffix === '/due-tasks' && method === 'POST') {
      let body: Record<string, unknown> = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          return {
            statusCode: 400,
            headers: JSON_HEADERS,
            body: JSON.stringify({ error: 'Invalid JSON body' }),
          };
        }
      }
      const dryRun = body.dryRun === true;
      if (!dryRun && !isAdmin) {
        return {
          statusCode: 403,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Creating due task notifications requires an admin' }),
        };
      }
      const requestedDate = typeof body.date === 'string' ? body.date.trim() : '';
      if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'date must be YYYY-MM-DD' }),
        };
      }
      const todayDate = requestedDate || berlinDate(new Date());
      const result = await createDueTaskNotifications(client, { todayDate, dryRun });
      const items = dryRun ? result.candidates : result.created;
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          date: todayDate,
          dryRun,
          count: items.length,
          items,
        }),
      };
    }

    // Route: PUT /api/notifications/dismiss-all
    if (suffix === '/dismiss-all' && method === 'PUT') {
      if (!isAdmin) {
        return {
          statusCode: 403,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Dismissing all notifications requires an admin' }),
        };
      }
      const count = await dismissAllNotifications(client);
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ count }),
      };
    }

    // Route: PUT /api/notifications/:id/dismiss
    const dismissMatch = suffix.match(/^\/([^/]+)\/dismiss\/?$/);
    if (dismissMatch && method === 'PUT') {
      const id = dismissMatch[1];
      const existing = await getNotification(client, id);
      if (!existing) {
        return {
          statusCode: 404,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: 'Notification not found' }),
        };
      }

      const notification = await dismissNotification(client, id);
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ notification }),
      };
    }

    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error: unknown) {
    if (error instanceof CollectionCursorError) {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: 'Invalid pagination input', code: 'invalid_pagination_input' }),
      };
    }
    recordRequestError(error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleNotificationRoutes };
