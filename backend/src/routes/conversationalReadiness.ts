import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import { createProductionPluginRegistry } from '../conversation/plugins';
import { conversationalRolloutSnapshot } from '../conversation/rollout';
import {
  oldestPendingResultAgeSeconds,
  readRolloutHeartbeat,
  type HeartbeatComponent,
} from '../conversation/rolloutState';
import type { LambdaEvent, LambdaResponse } from '../types';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const FRESH_SECONDS = 300;

function response(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function header(event: LambdaEvent, name: string): string {
  return String(Object.entries(event.headers || {})
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '');
}

function configured(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function deploymentId(): string {
  const value = process.env.DATAOPS_DEPLOYMENT_ID || 'unknown';
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : 'unknown';
}

async function heartbeatStatus(
  client: DynamoDBDocumentClient,
  component: HeartbeatComponent,
  enabled: boolean,
  now: Date
): Promise<Record<string, unknown>> {
  if (!enabled) return { status: 'not_applicable' };
  const heartbeat = await readRolloutHeartbeat(client, component);
  if (!heartbeat) return { status: 'missing' };
  const updatedAt = Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(updatedAt)) return { status: 'missing' };
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - updatedAt) / 1_000));
  return {
    status: ageSeconds <= FRESH_SECONDS ? 'fresh' : 'stale',
    ageSeconds,
  };
}

async function handleConversationalReadiness(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  now = new Date()
): Promise<LambdaResponse | null> {
  if (path !== '/api/conversational/readiness') return null;
  if (method !== 'GET') return response(405, { error: 'Method not allowed' });
  const actorId = header(event, 'x-user-id');
  if (!actorId) return response(401, { error: 'Unauthorized' });
  const actor = await getUser(client, actorId);
  if (!actor || actor.disabled || actor.role !== 'admin') {
    return response(403, { error: 'Admin access required' });
  }
  const rollout = conversationalRolloutSnapshot();
  const registry = createProductionPluginRegistry({
    todoEnabled: rollout.eligibility.todoVisible,
    typefullyEnabled: rollout.eligibility.typefullyVisible,
  });
  const enabledPlugins = registry.catalog('admin', 'telegram').map(({ id }) => {
    const plugin = registry.getAvailable(id, 'admin', 'telegram')!;
    return {
      id,
      buildDigest: plugin.buildDigest,
      schemaDigest: plugin.schemaDigest,
    };
  });
  const [worker, recovery, dispatcher, oldestPending] = await Promise.all([
    heartbeatStatus(client, 'execution_worker', rollout.controls.executionLeasing, now),
    heartbeatStatus(client, 'recovery', rollout.controls.executionLeasing, now),
    heartbeatStatus(client, 'result_dispatcher', rollout.eligibility.resultDelivery, now),
    rollout.eligibility.resultDelivery
      ? oldestPendingResultAgeSeconds(client, now)
      : Promise.resolve(null),
  ]);
  return response(200, {
    controls: {
      telegramIngress: rollout.controls.telegramIngress,
      executionLeasing: rollout.controls.executionLeasing,
      enabledPlugins: [...rollout.controls.enabledPlugins],
      typefullyExternalExecution: rollout.controls.typefullyExternalExecution,
      voice: rollout.controls.voice,
      photo: rollout.controls.photo,
    },
    eligibility: rollout.eligibility,
    plugins: enabledPlugins,
    providers: {
      conversational: {
        provider: 'z.ai',
        model: process.env.ZAI_CONVERSATIONAL_MODEL || 'glm-5.2',
        configured: configured(process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN),
      },
      voice: {
        provider: 'groq',
        model: 'whisper-large-v3',
        configured: configured(process.env.GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN),
      },
      photo: {
        provider: 'z.ai',
        model: process.env.ZAI_VISION_MODEL || 'glm-4.6v',
        configured: configured(process.env.ZAI_VISION_API_KEY_SECRET_ARN),
      },
      typefully: {
        provider: 'typefully',
        configured: process.env.CONVERSATIONAL_TYPEFULLY_PROVIDER_CONFIGURED === 'true',
      },
    },
    deploymentId: deploymentId(),
    freshness: {
      executionWorker: worker,
      recovery,
      resultDispatcher: dispatcher,
      resultOldestPending: rollout.eligibility.resultDelivery
        ? { status: oldestPending === null ? 'empty' : 'present', ageSeconds: oldestPending }
        : { status: 'not_applicable' },
    },
    infrastructure: {
      failureQueue: process.env.CONVERSATIONAL_FAILURE_QUEUE_CONFIGURED === 'true',
      alarmTopic: process.env.CONVERSATIONAL_ALARM_TOPIC_CONFIGURED === 'true',
      alarms: process.env.CONVERSATIONAL_ALARMS_CONFIGURED === 'true',
      customLogGroups: process.env.CONVERSATIONAL_LOG_GROUPS_CONFIGURED === 'true',
      subscriptionConfirmed:
        process.env.CONVERSATIONAL_ALARM_SUBSCRIPTION_CONFIRMED === 'true',
    },
  });
}

export { handleConversationalReadiness };
