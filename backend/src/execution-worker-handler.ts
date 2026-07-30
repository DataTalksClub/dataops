import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient as getDbClient } from './db/client';
import { defaultWorkerExecutionRegistry } from './conversation/executionWorkerDefaults';
import { processAttempt, runRecovery, workerConfig } from './conversation/executionWorker';
import { conversationalRolloutSnapshot } from './conversation/rollout';
import { emitConversationalMetric } from './conversation/observability';
import {
  oldestDueExecutionAgeSeconds,
  writeRolloutHeartbeat,
} from './conversation/rolloutState';

let client: DynamoDBDocumentClient | null = null;

interface ExecutionWorkerHandlerOverrides {
  client?: DynamoDBDocumentClient;
  now?: () => Date;
  registry?: ReturnType<typeof defaultWorkerExecutionRegistry>;
  processAttempt?: typeof processAttempt;
  runRecovery?: typeof runRecovery;
  oldestDueExecutionAgeSeconds?: typeof oldestDueExecutionAgeSeconds;
  writeRolloutHeartbeat?: typeof writeRolloutHeartbeat;
  emitConversationalMetric?: typeof emitConversationalMetric;
}

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

async function handleExecutionWorkerEvent(
  event: Record<string, unknown>,
  overrides: ExecutionWorkerHandlerOverrides = {}
): Promise<unknown> {
  const rollout = conversationalRolloutSnapshot();
  const detail = event.detail as Record<string, unknown> | undefined;
  const action = detail?.dataopsAction;
  const now = overrides.now || (() => new Date());
  const writeHeartbeat = overrides.writeRolloutHeartbeat || writeRolloutHeartbeat;
  const emitMetric = overrides.emitConversationalMetric || emitConversationalMetric;
  const resolveClient = async (): Promise<DynamoDBDocumentClient> => {
    if (overrides.client) return overrides.client;
    client ||= await getDbClient();
    return client;
  };

  if (action === 'conversational-execution-health-pulse') {
    if (!rollout.controls.executionLeasing) return { disabled: true };
    const currentClient = await resolveClient();
    const completedAt = now();
    await writeHeartbeat(currentClient, 'execution_worker', completedAt);
    emitMetric(
      'ExecutionWorkerHeartbeatAgeSeconds',
      0,
      'execution-worker',
      completedAt.getTime()
    );
    return { pulsed: true, component: 'execution_worker' };
  }

  if (action === 'conversational-execution-recovery' && !rollout.controls.executionLeasing) {
    return { disabled: true };
  }

  const currentClient = await resolveClient();
  const dependencies = {
    client: currentClient,
    registry: overrides.registry || defaultWorkerExecutionRegistry(currentClient),
    config: configFromEnv(),
    attemptEnabled: (attempt: { permissionRef?: string }) => (
      Boolean(attempt.permissionRef)
      && rollout.executionAttemptEnabled(attempt.permissionRef!)
    ),
    ...(overrides.now ? { now: overrides.now } : {}),
  };
  if (action === 'conversational-execution-recovery') {
    const result = await (overrides.runRecovery || runRecovery)(dependencies);
    const completedAt = now();
    const oldestDue = await (
      overrides.oldestDueExecutionAgeSeconds || oldestDueExecutionAgeSeconds
    )(currentClient, completedAt);
    if (oldestDue !== null) {
      emitMetric(
        'RecoveryOldestDueAgeSeconds',
        oldestDue,
        'recovery',
        completedAt.getTime()
      );
    }
    await writeHeartbeat(currentClient, 'recovery', completedAt);
    emitMetric('RecoveryHeartbeatAgeSeconds', 0, 'recovery', completedAt.getTime());
    return result;
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
      const result = await (overrides.processAttempt || processAttempt)(attemptId, dependencies);
      if (result?.status === 'failed_safe') {
        emitMetric('ExecutionFailedSafe', 1, 'execution-worker');
        if (result.permissionRef === 'typefully:create-saved-draft') {
          emitMetric('TypefullyDraftFailed', 1, 'typefully');
        }
      } else if (result?.status === 'outcome_unknown') {
        emitMetric('ExecutionOutcomeUnknown', 1, 'execution-worker');
      }
    } catch {
      failures.push({ itemIdentifier: String(record.eventID || attemptId) });
    }
  }
  return { batchItemFailures: failures };
}

async function handler(event: Record<string, unknown>): Promise<unknown> {
  return handleExecutionWorkerEvent(event);
}

export { configFromEnv, handleExecutionWorkerEvent, handler };
export type { ExecutionWorkerHandlerOverrides };
