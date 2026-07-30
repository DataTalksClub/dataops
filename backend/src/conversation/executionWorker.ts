import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  claimQueuedAttempt,
  finalizeAttempt,
  getApprovalPermission,
  getCanonicalTarget,
  getProposalVersion,
  markDispatchStarted,
  queryDueAttempts,
  reclaimDispatchedAttempt,
  reconcileUnknownAttempt,
  requeueUndispatchedAttempt,
} from './executionRepository';
import {
  ExecutorRegistry,
  proposalHashesAreValid,
  type CapabilityExecutor,
  type ExecutorRequest,
  type ExecutorResult,
  type ReconciliationResult,
} from './execution';
import {
  appendConversationAuditEvent,
  getChannelBinding,
  getExecutionAttempt,
  getIdentityBinding,
} from './repository';
import {
  expiryFrom,
  validateSafeExecutionReceipt,
  type ExecutionAttempt,
  type ProposalVersion,
  type SafeExecutionReceipt,
} from './types';
import { getUser } from '../db/users';

interface WorkerConfig {
  leaseSeconds: number;
  deadlineMs: number;
  maxPreDispatchLeases: number;
  recoveryLimit: number;
}

interface WorkerDependencies {
  client: DynamoDBDocumentClient;
  registry: ExecutorRegistry;
  now?: () => Date;
  leaseOwner?: () => string;
  config?: Partial<WorkerConfig>;
  crashAfter?: 'lease' | 'dispatch_marker' | 'executor_response';
}

interface WorkerResult {
  attempted: number;
  completed: number;
  deferred: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  leaseSeconds: 60,
  deadlineMs: 20_000,
  maxPreDispatchLeases: 5,
  recoveryLimit: 50,
};

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside allowed bounds`);
  }
  return value;
}

function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  boundedInteger(config.leaseSeconds, 5, 900, 'leaseSeconds');
  boundedInteger(config.deadlineMs, 100, 120_000, 'deadlineMs');
  boundedInteger(config.maxPreDispatchLeases, 1, 20, 'maxPreDispatchLeases');
  boundedInteger(config.recoveryLimit, 1, 100, 'recoveryLimit');
  return config;
}

function leaseExpiry(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function safeReasonCode(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  if (!/^[a-z][a-z0-9_.-]{0,99}$/i.test(text)) return fallback;
  return text;
}

async function auditAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  action: string,
  outcome: string,
  now: string
): Promise<void> {
  try {
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
      actorId: attempt.actorId || 'execution-worker',
      payloadHash: attempt.canonicalPayloadHash,
      outcome,
    });
  } catch {
    // State transitions remain authoritative if an idempotent audit already exists.
  }
}

async function preDispatchCheck(
  attempt: ExecutionAttempt,
  dependencies: WorkerDependencies
): Promise<{ proposal: ProposalVersion; executor: CapabilityExecutor } | null> {
  if (
    !attempt.actorId
    || !attempt.permissionRef
    || !attempt.identityBindingId
    || !attempt.identityChannel
    || !attempt.identityChannelUserId
    || !attempt.channelBindingId
    || !attempt.channelConversationKey
    || !attempt.executorBuildDigest
    || !attempt.canonicalPayloadHash
    || !attempt.renderedViewHash
  ) return null;
  const proposal = await getProposalVersion(
    dependencies.client,
    attempt.proposalId,
    attempt.proposalVersion
  );
  if (
    !proposal
    || proposal.status !== 'claimed'
    || proposal.conversationId !== attempt.conversationId
    || proposal.actorId !== attempt.actorId
    || proposal.spec.permissionRef !== attempt.permissionRef
    || proposal.canonicalPayloadHash !== attempt.canonicalPayloadHash
    || proposal.renderedViewHash !== attempt.renderedViewHash
  ) return null;
  const executor = dependencies.registry.get(proposal.spec.effect, attempt.executorBuildDigest);
  if (!executor || executor.permissionRef !== attempt.permissionRef || !proposalHashesAreValid(proposal, executor)) {
    return null;
  }
  const [identity, channelBinding, actor] = await Promise.all([
    getIdentityBinding(dependencies.client, attempt.identityChannel, attempt.identityChannelUserId),
    getChannelBinding(
      dependencies.client,
      attempt.identityChannel,
      attempt.channelConversationKey,
      dependencies.now ? dependencies.now() : new Date()
    ),
    getUser(dependencies.client, attempt.actorId),
  ]);
  if (
    !actor
    || actor.disabled === true
    || !['admin', 'operator'].includes(actor.role || '')
  ) return null;
  if (
    !identity
    || identity.id !== attempt.identityBindingId
    || identity.userId !== attempt.actorId
    || identity.status !== 'active'
    || !channelBinding
    || channelBinding.id !== attempt.channelBindingId
    || channelBinding.conversationId !== attempt.conversationId
    || channelBinding.ownerUserId !== attempt.actorId
  ) return null;
  const permission = await getApprovalPermission(dependencies.client, attempt.actorId, attempt.permissionRef);
  if (!permission?.enabled) return null;
  if (proposal.spec.targetRef && proposal.spec.baseRevision) {
    const target = await getCanonicalTarget(dependencies.client, proposal.spec.targetRef);
    if (!target || target.revision !== proposal.spec.baseRevision) return null;
  }
  const now = (dependencies.now || (() => new Date()))();
  if (Date.parse(proposal.spec.expiresAt) <= now.getTime()) return null;
  return { proposal, executor };
}

async function executeLeasedAttempt(
  leased: ExecutionAttempt,
  dependencies: WorkerDependencies,
  options: { dispatchAlreadyStarted?: boolean } = {}
): Promise<ExecutionAttempt | null> {
  const config = workerConfig(dependencies.config);
  const now = (dependencies.now || (() => new Date()))();
  const checked = await preDispatchCheck(leased, dependencies);
  if (!checked) {
    const failed = await finalizeAttempt(
      dependencies.client,
      leased,
      'failed_safe',
      now.toISOString(),
      {
        errorCode: 'pre_dispatch_check_failed',
        resultNotification: {},
      }
    );
    if (failed) await auditAttempt(dependencies.client, failed, 'execution_failed_safe', 'pre_dispatch_check_failed', now.toISOString());
    return failed;
  }
  let dispatched = leased;
  if (!options.dispatchAlreadyStarted) {
    const marked = await markDispatchStarted(dependencies.client, leased, now.toISOString());
    if (!marked) return null;
    dispatched = marked;
    await auditAttempt(dependencies.client, dispatched, 'dispatch_started', 'executing', now.toISOString());
  }
  if (dependencies.crashAfter === 'dispatch_marker') throw new Error('synthetic crash after dispatch marker');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.deadlineMs);
  try {
    const result = await checked.executor.execute({
      spec: checked.proposal.spec,
      attemptId: dispatched.id,
      idempotencyKey: dispatched.idempotencyRef!,
      signal: controller.signal,
    });
    if (dependencies.crashAfter === 'executor_response') throw new Error('synthetic crash after executor response');
    if (result.outcome === 'succeeded') {
      try {
        validateSafeExecutionReceipt(result.receipt);
      } catch {
        return finalizeAttempt(
          dependencies.client,
          dispatched,
          'outcome_unknown',
          (dependencies.now || (() => new Date()))().toISOString(),
          { errorCode: 'unsafe_executor_receipt', resultNotification: {} }
        );
      }
    }
    const finalized = await finalizeAttempt(
      dependencies.client,
      dispatched,
      result.outcome,
      (dependencies.now || (() => new Date()))().toISOString(),
      result.outcome === 'succeeded'
        ? {
          receipt: result.receipt,
          resultNotification: { privateResult: result.privateResult },
        }
        : {
          errorCode: safeReasonCode(result.reasonCode, 'executor_failed_safe'),
          resultNotification: {},
        }
    );
    if (finalized) {
      await auditAttempt(
        dependencies.client,
        finalized,
        result.outcome === 'succeeded' ? 'execution_succeeded' : 'execution_failed_safe',
        result.outcome,
        finalized.updatedAt
      );
    }
    return finalized;
  } catch {
    // A response lost after the durable dispatch boundary is uncertain. The
    // lease is left executing so scheduled recovery applies the delivery mode.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function processAttempt(
  attemptId: string,
  dependencies: WorkerDependencies
): Promise<ExecutionAttempt | null> {
  const config = workerConfig(dependencies.config);
  const now = (dependencies.now || (() => new Date()))();
  const owner = (dependencies.leaseOwner || (() => `worker-${crypto.randomUUID()}`))();
  const leased = await claimQueuedAttempt(
    dependencies.client,
    attemptId,
    owner,
    now.toISOString(),
    leaseExpiry(now, config.leaseSeconds)
  );
  if (!leased) return getExecutionAttempt(dependencies.client, attemptId, now);
  await auditAttempt(dependencies.client, leased, 'lease_claimed', 'executing', now.toISOString());
  if (dependencies.crashAfter === 'lease') throw new Error('synthetic crash after lease');
  return executeLeasedAttempt(leased, dependencies);
}

async function recoverExecutingAttempt(
  attempt: ExecutionAttempt,
  dependencies: WorkerDependencies
): Promise<ExecutionAttempt | null> {
  const config = workerConfig(dependencies.config);
  const now = (dependencies.now || (() => new Date()))();
  const nowIso = now.toISOString();
  if (!attempt.dispatchStartedAt) {
    if (attempt.attemptNumber >= config.maxPreDispatchLeases) {
      const failed = await finalizeAttempt(
        dependencies.client,
        attempt,
        'failed_safe',
        nowIso,
        { errorCode: 'pre_dispatch_retry_exhausted', resultNotification: {} }
      );
      if (failed) await auditAttempt(dependencies.client, failed, 'execution_failed_safe', 'pre_dispatch_retry_exhausted', nowIso);
      return failed;
    }
    const backoffSeconds = Math.min(2 ** Math.max(attempt.attemptNumber - 1, 0), 300);
    const readyAt = new Date(now.getTime() + backoffSeconds * 1_000).toISOString();
    return requeueUndispatchedAttempt(dependencies.client, attempt, nowIso, readyAt);
  }
  const owner = (dependencies.leaseOwner || (() => `recovery-${crypto.randomUUID()}`))();
  const reclaimed = await reclaimDispatchedAttempt(
    dependencies.client,
    attempt.id,
    attempt.revision,
    owner,
    nowIso,
    leaseExpiry(now, config.leaseSeconds)
  );
  if (!reclaimed) return getExecutionAttempt(dependencies.client, attempt.id, now);
  if (attempt.deliveryMode === 'operator_reconciliation_only') {
    const unknown = await finalizeAttempt(
      dependencies.client,
      reclaimed,
      'outcome_unknown',
      nowIso,
      { errorCode: 'operator_reconciliation_required', resultNotification: {} }
    );
    if (unknown) await auditAttempt(dependencies.client, unknown, 'outcome_unknown', 'operator_reconciliation_required', nowIso);
    return unknown;
  }
  if (attempt.deliveryMode === 'correlation_lookup') {
    const checked = await preDispatchCheck(reclaimed, dependencies);
    if (!checked?.executor.reconcile) {
      return finalizeAttempt(
        dependencies.client,
        reclaimed,
        'outcome_unknown',
        nowIso,
        { errorCode: 'reconciler_unavailable', resultNotification: {} }
      );
    }
    let reconciled: ReconciliationResult;
    try {
      reconciled = await checked.executor.reconcile({
        spec: checked.proposal.spec,
        attemptId: reclaimed.id,
        idempotencyKey: reclaimed.idempotencyRef!,
      });
    } catch {
      reconciled = { outcome: 'unknown', reasonCode: 'reconciliation_failed' };
    }
    const status = reconciled.outcome === 'applied'
      ? 'succeeded'
      : reconciled.outcome === 'not_applied' ? 'failed_safe' : 'outcome_unknown';
    if (reconciled.outcome === 'applied') {
      try {
        validateSafeExecutionReceipt(reconciled.receipt);
      } catch {
        return finalizeAttempt(
          dependencies.client,
          reclaimed,
          'outcome_unknown',
          nowIso,
          { errorCode: 'unsafe_reconciliation_receipt', resultNotification: {} }
        );
      }
    }
    return finalizeAttempt(
      dependencies.client,
      reclaimed,
      status,
      nowIso,
      reconciled.outcome === 'applied'
        ? {
          receipt: reconciled.receipt,
          resultNotification: { privateResult: reconciled.privateResult },
        }
        : {
          errorCode: safeReasonCode(reconciled.reasonCode, 'reconciliation_unknown'),
          resultNotification: {},
        }
    );
  }
  return executeLeasedAttempt(reclaimed, dependencies, { dispatchAlreadyStarted: true });
}

async function runRecovery(dependencies: WorkerDependencies): Promise<WorkerResult> {
  const config = workerConfig(dependencies.config);
  const now = (dependencies.now || (() => new Date()))();
  const [queued, executing] = await Promise.all([
    queryDueAttempts(dependencies.client, 'queued', now.toISOString(), config.recoveryLimit),
    queryDueAttempts(dependencies.client, 'executing', now.toISOString(), config.recoveryLimit),
  ]);
  let completed = 0;
  let deferred = 0;
  for (const attempt of queued) {
    const result = await processAttempt(attempt.id, dependencies);
    if (result && ['succeeded', 'failed_safe', 'manually_resolved'].includes(result.status)) completed += 1;
    else deferred += 1;
  }
  for (const attempt of executing) {
    const result = await recoverExecutingAttempt(attempt, dependencies);
    if (result && ['succeeded', 'failed_safe', 'manually_resolved'].includes(result.status)) completed += 1;
    else deferred += 1;
  }
  return { attempted: queued.length + executing.length, completed, deferred };
}

async function reconcileAttempt(
  attempt: ExecutionAttempt,
  expectedRevision: number,
  dependencies: WorkerDependencies
): Promise<ExecutionAttempt> {
  if (attempt.status !== 'outcome_unknown') return attempt;
  const checked = await preDispatchCheck(attempt, dependencies);
  if (!checked?.executor.reconcile) throw new Error('Reconciler unavailable');
  const result = await checked.executor.reconcile({
    spec: checked.proposal.spec,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyRef!,
  });
  const status = result.outcome === 'applied'
    ? 'succeeded'
    : result.outcome === 'not_applied' ? 'failed_safe' : 'outcome_unknown';
  if (result.outcome === 'applied') validateSafeExecutionReceipt(result.receipt);
  const updated = await reconcileUnknownAttempt(
    dependencies.client,
    attempt.id,
    expectedRevision,
    status,
    (dependencies.now || (() => new Date()))().toISOString(),
    result.outcome === 'applied' ? result.receipt : undefined
  );
  if (updated) return updated;
  return (await getExecutionAttempt(dependencies.client, attempt.id)) || attempt;
}

type FakeBehavior =
  | 'success'
  | 'failed_safe'
  | 'lost_before_effect'
  | 'lost_after_effect';

class FakeCapabilityExecutor implements CapabilityExecutor {
  readonly calls: Array<{ attemptId: string; idempotencyKey: string }> = [];
  readonly effects = new Map<string, SafeExecutionReceipt>();
  behavior: FakeBehavior = 'success';
  reconciliationOutcome: ReconciliationResult['outcome'] = 'unknown';

  constructor(
    readonly effect: string,
    readonly buildDigest: string,
    readonly permissionRef: string,
    readonly deliveryMode: ExecutionAttempt['deliveryMode'],
    private readonly clock: () => Date = () => new Date()
  ) {}

  render(spec: ProposalVersion['spec']): unknown {
    return {
      effect: spec.effect,
      operation: spec.operation,
      destinationRef: spec.destinationRef || null,
      targetRef: spec.targetRef || null,
      proposedContent: spec.proposedContent ?? null,
      permissionRef: spec.permissionRef,
      baseRevision: spec.baseRevision || null,
    };
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    this.calls.push({ attemptId: request.attemptId, idempotencyKey: request.idempotencyKey });
    if (this.behavior === 'lost_before_effect') throw new Error('synthetic lost response');
    const receipt = this.effects.get(request.idempotencyKey) || {
      receiptId: `receipt-${request.attemptId}`,
      effectHash: `sha256:${'e'.repeat(64)}`,
      recordedAt: this.clock().toISOString(),
      metadata: { providerId: `fake-${request.attemptId}` },
    };
    if (this.behavior !== 'failed_safe') this.effects.set(request.idempotencyKey, receipt);
    if (this.behavior === 'lost_after_effect') throw new Error('synthetic lost response');
    if (this.behavior === 'failed_safe') return { outcome: 'failed_safe', reasonCode: 'fake_no_write' };
    return { outcome: 'succeeded', receipt };
  }

  async reconcile(request: Omit<ExecutorRequest, 'signal'>): Promise<ReconciliationResult> {
    const existing = this.effects.get(request.idempotencyKey);
    if (existing) return { outcome: 'applied', receipt: existing };
    if (this.reconciliationOutcome === 'not_applied') {
      return { outcome: 'not_applied', reasonCode: 'fake_not_applied' };
    }
    return { outcome: 'unknown', reasonCode: 'fake_unknown' };
  }
}

export {
  FakeCapabilityExecutor,
  executeLeasedAttempt,
  preDispatchCheck,
  processAttempt,
  reconcileAttempt,
  recoverExecutingAttempt,
  runRecovery,
  workerConfig,
};
export type { FakeBehavior, WorkerConfig, WorkerDependencies, WorkerResult };
