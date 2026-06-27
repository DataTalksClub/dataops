import { getClient } from '../db/client';
import { runCron } from '../cron/runner';
import type { LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/**
 * Handle POST /api/cron/run route.
 */
async function handleCronRoutes(path: string, method: string): Promise<LambdaResponse | null> {
  if (path !== '/api/cron/run') {
    return null;
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const client = await getClient();
    const result = await runCron(client);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (err: unknown) {
    console.error('Cron route error:', err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

export { handleCronRoutes };
