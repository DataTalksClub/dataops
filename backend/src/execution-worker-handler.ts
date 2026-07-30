import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from './db/client';
import { defaultExecutionRegistry } from './conversation/executionDefaults';
import { processAttempt, runRecovery, workerConfig } from './conversation/executionWorker';

let client: DynamoDBDocumentClient | null = null;

function stringAttribute(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const text = (value as { S?: unknown }).S;
  return typeof text === 'string' ? text : null;
}

function configFromEnv() {
  return workerConfig({
    leaseSeconds: Number(process.env.CONVERSATIONAL_EXECUTION_LEASE_SECONDS || 60),
    deadlineMs: Number(process.env.CONVERSATIONAL_EXECUTION_DEADLINE_MS || 20_000),
    maxPreDispatchLeases: Number(process.env.CONVERSATIONAL_EXECUTION_MAX_PRE_DISPATCH_LEASES || 5),
    recoveryLimit: Number(process.env.CONVERSATIONAL_EXECUTION_RECOVERY_LIMIT || 50),
  });
}

async function handler(event: Record<string, unknown>): Promise<unknown> {
  client ||= await getClient();
  const dependencies = {
    client,
    registry: defaultExecutionRegistry(client),
    config: configFromEnv(),
  };
  const detail = event.detail as Record<string, unknown> | undefined;
  if (detail?.dataopsAction === 'conversational-execution-recovery') {
    return runRecovery(dependencies);
  }
  const records = Array.isArray(event.Records) ? event.Records as Array<Record<string, unknown>> : [];
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    const dynamodb = record.dynamodb as Record<string, unknown> | undefined;
    const newImage = dynamodb?.NewImage as Record<string, unknown> | undefined;
    const attemptId = stringAttribute(newImage?.id);
    const status = stringAttribute(newImage?.status);
    if (!attemptId || status !== 'queued') continue;
    try {
      await processAttempt(attemptId, dependencies);
    } catch {
      failures.push({ itemIdentifier: String(record.eventID || attemptId) });
    }
  }
  return { batchItemFailures: failures };
}

export { configFromEnv, handler };
