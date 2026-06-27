import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import {
  getNotification,
  dismissNotification,
  listUndismissedNotifications,
  listAllNotifications,
  dismissAllNotifications,
} from '../db/notifications';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Handle all /api/notifications routes.
 */
async function handleNotificationRoutes(path: string, method: string, _rawBody: string | null, queryParams?: Record<string, string> | null, userId?: string): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/notifications')) {
    return null;
  }

  const client = await getClient();

  try {
    const suffix = path.slice('/api/notifications'.length);

    // Route: GET /api/notifications (with optional ?all=true)
    if ((suffix === '' || suffix === '/') && method === 'GET') {
      if (queryParams && queryParams['all'] === 'true') {
        const notifications = await listAllNotifications(client, userId);
        return {
          statusCode: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({ notifications }),
        };
      }
      const notifications = await listUndismissedNotifications(client, userId);
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ notifications }),
      };
    }

    // Route: PUT /api/notifications/dismiss-all
    if (suffix === '/dismiss-all' && method === 'PUT') {
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
  } catch (err: unknown) {
    console.error('Notification route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleNotificationRoutes };
