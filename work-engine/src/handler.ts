import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from './router';
import { getClient } from './db/client';
import { createTables } from './db/setup';
import { runCron } from './cron/runner';
import type { CronRunnerResult } from './cron/runner';
import type { LambdaEvent, LambdaResponse } from './types';

let client: DynamoDBDocumentClient | null = null;
let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    client = await getClient();
    await createTables(client);
    initialized = true;
  }
}

/**
 * Check if this is an EventBridge scheduled event.
 */
function isScheduledEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    e.source === 'aws.events' ||
    e['detail-type'] === 'Scheduled Event'
  );
}

async function handler(event: LambdaEvent | Record<string, unknown>, _context?: unknown): Promise<LambdaResponse | CronRunnerResult> {
  await ensureInitialized();

  // Handle EventBridge scheduled events
  if (isScheduledEvent(event)) {
    return runCron(client!);
  }

  return route(event as LambdaEvent, client!);
}

export { handler };
