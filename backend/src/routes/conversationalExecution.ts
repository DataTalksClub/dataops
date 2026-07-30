import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { defaultExecutionRegistry } from '../conversation/executionDefaults';
import {
  manuallyResolveAttempt,
} from '../conversation/executionRepository';
import {
  reconcileAttempt,
  type WorkerDependencies,
} from '../conversation/executionWorker';
import {
  appendConversationAuditEvent,
  getConversation,
  getExecutionAttempt,
} from '../conversation/repository';
import { expiryFrom, validateSafeExecutionReceipt, type ExecutionAttempt } from '../conversation/types';
import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SECRET_PATTERN = /(secret|token|password|credential|authorization|cookie|signed[_-]?url|api[_-]?key|bearer\s+\S+)/i;

function response(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function header(event: LambdaEvent, name: string): string {
  const entry = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : '';
}

function body(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function publicAttempt(attempt: ExecutionAttempt): Record<string, unknown> {
  let resultReceipt: ExecutionAttempt['resultReceipt'];
  if (attempt.resultReceipt) {
    try {
      validateSafeExecutionReceipt(attempt.resultReceipt);
      resultReceipt = {
        receiptId: attempt.resultReceipt.receiptId,
        effectHash: attempt.resultReceipt.effectHash,
        recordedAt: attempt.resultReceipt.recordedAt,
        ...(attempt.resultReceipt.metadata ? { metadata: attempt.resultReceipt.metadata } : {}),
      };
    } catch {
      resultReceipt = undefined;
    }
  }
  return {
    id: attempt.id,
    proposalId: attempt.proposalId,
    proposalVersion: attempt.proposalVersion,
    conversationId: attempt.conversationId,
    status: attempt.status,
    deliveryMode: attempt.deliveryMode,
    attemptNumber: attempt.attemptNumber,
    readyAt: attempt.readyAt,
    errorCode: attempt.errorCode,
    resultReceipt,
    manualResolution: attempt.manualResolution,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    revision: attempt.revision,
  };
}

async function authorizedAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  actorId: string,
  adminOnly = false
): Promise<{ attempt: ExecutionAttempt; isAdmin: boolean } | null> {
  const [user, attempt] = await Promise.all([
    getUser(client, actorId),
    getExecutionAttempt(client, attemptId),
  ]);
  if (!user || user.disabled || !attempt) return null;
  const isAdmin = user.role === 'admin';
  if (adminOnly && !isAdmin) return null;
  if (!isAdmin) {
    const conversation = await getConversation(client, attempt.conversationId);
    if (!conversation || conversation.ownerUserId !== actorId) return null;
  }
  return { attempt, isAdmin };
}

async function appendResolutionAudit(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  actorId: string,
  action: string,
  outcome: string,
  now: string
): Promise<void> {
  await appendConversationAuditEvent(client, {
    id: `audit-${action}-${attempt.id}-${attempt.revision}`,
    recordType: 'conversation_audit_event',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...expiryFrom(now, 365),
    conversationId: attempt.conversationId,
    subjectType: 'execution_attempt',
    subjectId: attempt.id,
    action,
    actorId,
    payloadHash: attempt.canonicalPayloadHash,
    outcome,
  });
}

async function handleConversationalExecutionRoutes(
  reqPath: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  dependencies: Partial<WorkerDependencies> = {}
): Promise<LambdaResponse | null> {
  const match = reqPath.match(/^\/api\/conversational\/execution-attempts\/([^/]+)(?:\/(reconcile|resolve))?$/);
  if (!match) return null;
  const attemptId = decodeURIComponent(match[1]);
  const action = match[2] || '';
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(attemptId)) return response(404, { error: 'Not found' });
  const actorId = header(event, 'x-user-id');
  if (!actorId) return response(401, { error: 'Unauthorized' });

  if (method === 'GET' && !action) {
    const authorized = await authorizedAttempt(client, attemptId, actorId);
    return authorized
      ? response(200, { attempt: publicAttempt(authorized.attempt) })
      : response(404, { error: 'Not found' });
  }
  if (method !== 'POST' || !action) return response(405, { error: 'Method not allowed' });
  const authorized = await authorizedAttempt(client, attemptId, actorId, true);
  if (!authorized) return response(404, { error: 'Not found' });
  const request = body(event);
  if (!request || !Number.isSafeInteger(request.revision) || Number(request.revision) < 1) {
    return response(400, { error: 'A current integer revision is required' });
  }

  if (action === 'reconcile') {
    if (Object.keys(request).some((key) => key !== 'revision')) {
      return response(400, { error: 'Reconciliation accepts only the current revision' });
    }
    if (authorized.attempt.status !== 'outcome_unknown') {
      return response(200, { attempt: publicAttempt(authorized.attempt) });
    }
    try {
      const updated = await reconcileAttempt(authorized.attempt, Number(request.revision), {
        client,
        registry: dependencies.registry || defaultExecutionRegistry(client),
        now: dependencies.now,
        config: dependencies.config,
        leaseOwner: dependencies.leaseOwner,
      });
      await appendResolutionAudit(client, updated, actorId, 'execution_reconciled', updated.status, updated.updatedAt);
      return response(200, { attempt: publicAttempt(updated) });
    } catch {
      return response(409, { error: 'Reconciliation is unavailable' });
    }
  }

  const keys = Object.keys(request);
  if (keys.some((key) => !['revision', 'outcome', 'reason'].includes(key))) {
    return response(400, { error: 'Resolution contains unsupported fields' });
  }
  if (!['effect_applied', 'no_effect'].includes(String(request.outcome))) {
    return response(400, { error: 'outcome must be effect_applied or no_effect' });
  }
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (!reason || Buffer.byteLength(reason, 'utf8') > 1_000 || SECRET_PATTERN.test(reason)) {
    return response(400, { error: 'A bounded credential-free reason is required' });
  }
  if (authorized.attempt.status === 'manually_resolved') {
    return response(200, { attempt: publicAttempt(authorized.attempt) });
  }
  if (authorized.attempt.status !== 'outcome_unknown') {
    return response(409, { error: 'Only an uncertain attempt can be resolved' });
  }
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const updated = await manuallyResolveAttempt(client, attemptId, Number(request.revision), {
    outcome: request.outcome as 'effect_applied' | 'no_effect',
    reason,
    actorId,
    resolvedAt: now,
  });
  if (!updated) {
    const existing = await getExecutionAttempt(client, attemptId);
    if (existing?.status === 'manually_resolved') {
      return response(200, { attempt: publicAttempt(existing) });
    }
    return response(409, { error: 'Attempt revision changed' });
  }
  await appendResolutionAudit(client, updated, actorId, 'execution_manually_resolved', String(request.outcome), now);
  return response(200, { attempt: publicAttempt(updated) });
}

export { handleConversationalExecutionRoutes, publicAttempt };
