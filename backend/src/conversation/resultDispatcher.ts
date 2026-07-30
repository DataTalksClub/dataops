import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  claimResultNotification,
  expireDispatchingResultNotification,
  finishResultNotification,
  getChannelBinding,
  getConversationalPrivatePayload,
  getIdentityBinding,
  listResultNotifications,
} from './repository';
import type { ResultNotification } from './types';
import { safeTypefullyEditUrl } from './typefullyPlugin';
import { getUser } from '../db/users';

interface ResultTransport {
  sendPrivateMessage(channelConversationKey: string, message: string): Promise<void>;
}

interface ResultDispatcherDependencies {
  client: DynamoDBDocumentClient;
  transport: ResultTransport;
  now?: () => Date;
  limit?: number;
  leaseSeconds?: number;
  crashAfterClaim?: boolean;
}

interface ResultDispatchSummary {
  attempted: number;
  delivered: number;
  outcomeUnknown: number;
  rejected: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function privateResultMessage(notification: ResultNotification, content: unknown): string {
  const body = object(content);
  if (
    body?.kind !== 'execution_result'
    || body.executionAttemptId !== notification.executionAttemptId
    || typeof body.status !== 'string'
  ) throw new Error('Result payload is invalid');
  const result = object(body.result);
  if (typeof result?.message === 'string') {
    const message = result.message.trim();
    if (message && Buffer.byteLength(message, 'utf8') <= 16_384) {
      if (result.kind === 'typefully_saved_draft' && typeof result.editUrl === 'string') {
        const editUrl = safeTypefullyEditUrl(result.editUrl);
        if (editUrl) return `${message}\n${editUrl}`;
        throw new Error('Result payload URL is invalid');
      }
      return message;
    }
  }
  if (body.status === 'failed_safe') return 'The approved action failed safely. No change was made.';
  if (body.status === 'outcome_unknown') {
    return 'The result is uncertain. Do not retry this approval; an authorized operator must reconcile it.';
  }
  return 'The approved action completed.';
}

async function dispatchOne(
  notification: ResultNotification,
  dependencies: ResultDispatcherDependencies
): Promise<'delivered' | 'outcome_unknown' | 'rejected'> {
  const now = (dependencies.now || (() => new Date()))();
  const leaseSeconds = dependencies.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) {
    throw new Error('Result dispatcher lease is invalid');
  }
  const claimed = await claimResultNotification(
    dependencies.client,
    notification,
    now.toISOString(),
    new Date(now.getTime() + leaseSeconds * 1_000).toISOString()
  );
  if (!claimed) return 'rejected';
  if (dependencies.crashAfterClaim) throw new Error('synthetic crash after result claim');
  if (!claimed.channelConversationKey) {
    await finishResultNotification(
      dependencies.client,
      claimed,
      'outcome_unknown',
      now.toISOString()
    );
    return 'rejected';
  }
  if (
    !claimed.identityChannelUserId
    || !claimed.identityBindingId
    || !claimed.identityBindingRevision
    || !claimed.channelBindingId
  ) {
    await finishResultNotification(
      dependencies.client,
      claimed,
      'outcome_unknown',
      now.toISOString()
    );
    return 'rejected';
  }
  const [identity, binding, payload, user] = await Promise.all([
    getIdentityBinding(
      dependencies.client,
      claimed.channel,
      claimed.identityChannelUserId
    ),
    getChannelBinding(
      dependencies.client,
      claimed.channel,
      claimed.channelConversationKey,
      now
    ),
    getConversationalPrivatePayload(
      dependencies.client,
      claimed.conversationId,
      claimed.privatePayloadRef,
      claimed.actorId,
      now
    ),
    getUser(dependencies.client, claimed.actorId),
  ]);
  if (
    claimed.channel !== 'telegram'
    || !user
    || user.disabled === true
    || !['admin', 'operator'].includes(user.role || '')
    || !identity
    || identity.status !== 'active'
    || identity.id !== claimed.identityBindingId
    || identity.revision !== claimed.identityBindingRevision
    || identity.userId !== claimed.actorId
    || !binding
    || binding.id !== claimed.channelBindingId
    || binding.ownerUserId !== claimed.actorId
    || binding.conversationId !== claimed.conversationId
    || !payload
  ) {
    await finishResultNotification(
      dependencies.client,
      claimed,
      'outcome_unknown',
      now.toISOString()
    );
    return 'rejected';
  }
  let message: string;
  try {
    message = privateResultMessage(claimed, payload.content);
  } catch {
    await finishResultNotification(
      dependencies.client,
      claimed,
      'outcome_unknown',
      now.toISOString()
    );
    return 'rejected';
  }
  try {
    await dependencies.transport.sendPrivateMessage(claimed.channelConversationKey, message);
  } catch {
    await finishResultNotification(
      dependencies.client,
      claimed,
      'outcome_unknown',
      now.toISOString()
    );
    return 'outcome_unknown';
  }
  const delivered = await finishResultNotification(
    dependencies.client,
    claimed,
    'delivered',
    now.toISOString()
  );
  return delivered ? 'delivered' : 'outcome_unknown';
}

async function runResultDispatcher(
  dependencies: ResultDispatcherDependencies
): Promise<ResultDispatchSummary> {
  const now = (dependencies.now || (() => new Date()))();
  const limit = dependencies.limit ?? 50;
  const [pending, dispatching] = await Promise.all([
    listResultNotifications(dependencies.client, 'pending', now.toISOString(), limit),
    listResultNotifications(dependencies.client, 'dispatching', now.toISOString(), limit),
  ]);
  for (const stale of dispatching) {
    await expireDispatchingResultNotification(
      dependencies.client,
      stale,
      now.toISOString()
    );
  }
  const summary: ResultDispatchSummary = {
    attempted: pending.length,
    delivered: 0,
    outcomeUnknown: dispatching.length,
    rejected: 0,
  };
  for (const notification of pending) {
    const outcome = await dispatchOne(notification, dependencies);
    if (outcome === 'delivered') summary.delivered += 1;
    else if (outcome === 'outcome_unknown') summary.outcomeUnknown += 1;
    else summary.rejected += 1;
  }
  return summary;
}

export {
  dispatchOne,
  privateResultMessage,
  runResultDispatcher,
};
export type {
  ResultDispatcherDependencies,
  ResultDispatchSummary,
  ResultTransport,
};
