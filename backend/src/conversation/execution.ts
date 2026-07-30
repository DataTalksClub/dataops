import { createHash, randomBytes } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { CORE_PERMISSION_VALUES, canonicalJson, isStrictJsonValue } from './pluginRegistry';
import {
  atomicApproval,
  atomicStorePresentedProposal,
  getApprovalPermission,
  getCanonicalTarget,
  getProposalVersion,
  markProposalConflicted,
} from './executionRepository';
import {
  compareAndSetPresentation,
  getChannelBinding,
  getExecutionAttempt,
  getIdentityBinding,
  getPresentationByTokenHash,
  listProposalRelationships,
  listProposalVersions,
} from './repository';
import {
  expiryFrom,
  validateConversationalRecord,
  type ExecutionAttempt,
  type ProposalPresentation,
  type ProposalSpec,
  type ProposalVersion,
  type SafeExecutionReceipt,
} from './types';
import { getUser } from '../db/users';

type DeliveryMode = ExecutionAttempt['deliveryMode'];
type ReconciliationResult =
  | { outcome: 'applied'; receipt: SafeExecutionReceipt }
  | { outcome: 'not_applied'; reasonCode: string }
  | { outcome: 'unknown'; reasonCode: string };

interface ExecutorRequest {
  spec: ProposalSpec;
  attemptId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

type ExecutorResult =
  | { outcome: 'succeeded'; receipt: SafeExecutionReceipt }
  | { outcome: 'failed_safe'; reasonCode: string };

interface CapabilityExecutor {
  effect: string;
  buildDigest: string;
  permissionRef: string;
  deliveryMode: DeliveryMode;
  render(spec: ProposalSpec): unknown;
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
  reconcile?(request: Omit<ExecutorRequest, 'signal'>): Promise<ReconciliationResult>;
}

class ExecutorRegistry {
  private readonly executors = new Map<string, CapabilityExecutor>();

  constructor(executors: CapabilityExecutor[]) {
    const knownPermissions = new Set<string>(CORE_PERMISSION_VALUES);
    for (const executor of executors) {
      if (!/^sha256:[a-f0-9]{64}$/.test(executor.buildDigest)) throw new Error('Executor build digest is invalid');
      if (!knownPermissions.has(executor.permissionRef)) throw new Error('Executor permission is unknown');
      if (this.executors.has(this.key(executor.effect, executor.buildDigest))) throw new Error('Duplicate executor build');
      this.executors.set(this.key(executor.effect, executor.buildDigest), executor);
    }
  }

  get(effect: string, buildDigest: string): CapabilityExecutor | null {
    return this.executors.get(this.key(effect, buildDigest)) || null;
  }

  private key(effect: string, buildDigest: string): string {
    return `${effect}\0${buildDigest}`;
  }
}

interface ProposalPresentationInput {
  proposalId: string;
  version: number;
  conversationId: string;
  actorId: string;
  identityBindingId: string;
  channelBindingId: string;
  channel: string;
  channelConversationKey: string;
  spec: ProposalSpec;
  revision?: number;
}

interface ProposalPresentationDependencies {
  client: DynamoDBDocumentClient;
  registry: ExecutorRegistry;
  now?: () => Date;
  token?: () => Buffer;
  presentationTtlSeconds?: number;
}

interface PresentedProposal {
  proposal: ProposalVersion;
  presentation: ProposalPresentation;
  preview: unknown;
  actionToken: string;
}

interface TrustedApprovalProvenance {
  actorId: string;
  channel: string;
  channelUserId: string;
  channelConversationKey: string;
}

interface ApprovalDependencies {
  client: DynamoDBDocumentClient;
  registry: ExecutorRegistry;
  now?: () => Date;
}

class ApprovalUnavailableError extends Error {
  constructor() {
    super('Approval is unavailable');
    this.name = 'ApprovalUnavailableError';
  }
}

class ProposalConflictError extends Error {
  constructor() {
    super('Proposal target changed; create a new proposal');
    this.name = 'ProposalConflictError';
  }
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalProposalSpec(spec: ProposalSpec): string {
  if (!isStrictJsonValue(spec)) throw new Error('Proposal spec must be strict JSON');
  const normalized = JSON.parse(canonicalJson(spec)) as ProposalSpec;
  validateConversationalRecord({
    id: 'validation-proposal',
    recordType: 'proposal_version',
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...expiryFrom('2026-01-01T00:00:00.000Z', 30),
    proposalId: 'validation-proposal',
    version: 1,
    conversationId: 'validation-conversation',
    status: 'presented',
    spec: normalized,
    canonicalPayloadHash: sha256(canonicalJson(normalized)),
    renderedViewHash: sha256('{}'),
    actorId: 'validation-actor',
    channel: 'web',
    revision: 1,
  });
  return canonicalJson(normalized);
}

function renderDeterministically(executor: CapabilityExecutor, spec: ProposalSpec): { preview: unknown; hash: string } {
  const first = executor.render(spec);
  const second = executor.render(spec);
  if (!isStrictJsonValue(first) || canonicalJson(first) !== canonicalJson(second)) {
    throw new Error('Proposal renderer is nondeterministic or invalid');
  }
  const envelope = {
    canonicalPayloadHash: sha256(canonicalProposalSpec(spec)),
    rendererBuildDigest: executor.buildDigest,
    rendered: first,
  };
  return { preview: envelope, hash: sha256(canonicalJson(envelope)) };
}

function boundedSeconds(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error('Execution configuration is outside allowed bounds');
  }
  return candidate;
}

async function presentProposal(
  input: ProposalPresentationInput,
  dependencies: ProposalPresentationDependencies
): Promise<PresentedProposal> {
  const now = (dependencies.now || (() => new Date()))();
  const nowIso = now.toISOString();
  const executor = dependencies.registry.get(input.spec.effect, input.spec.pluginBuildDigest);
  if (
    !executor
    || executor.permissionRef !== input.spec.permissionRef
    || executor.deliveryMode.length === 0
  ) {
    throw new Error('Proposal executor or permission is unavailable');
  }
  const canonical = canonicalProposalSpec(input.spec);
  if (Date.parse(input.spec.expiresAt) <= now.getTime()) throw new Error('Proposal expiry must be in the future');
  const normalizedSpec = JSON.parse(canonical) as ProposalSpec;
  const rendered = renderDeterministically(executor, normalizedSpec);
  const canonicalPayloadHash = sha256(canonical);
  const tokenBytes = (dependencies.token || (() => randomBytes(32)))();
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length < 32) throw new Error('Presentation token must contain at least 256 random bits');
  const actionToken = tokenBytes.toString('base64url');
  const actionTokenHash = sha256(actionToken);
  const retention = expiryFrom(nowIso, 30);
  const actionTtlSeconds = boundedSeconds(dependencies.presentationTtlSeconds, 1_800, 60, 86_400);
  const proposal: ProposalVersion = {
    id: `${input.proposalId}-v${input.version}`,
    recordType: 'proposal_version',
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...retention,
    proposalId: input.proposalId,
    version: input.version,
    conversationId: input.conversationId,
    status: 'presented',
    spec: normalizedSpec,
    canonicalPayloadHash,
    renderedViewHash: rendered.hash,
    actorId: input.actorId,
    channel: input.channel,
    revision: input.revision || 1,
  };
  const presentation: ProposalPresentation = {
    id: `presentation-${sha256(`${input.proposalId}:${input.version}:${actionTokenHash}`).slice(7, 31)}`,
    recordType: 'proposal_presentation',
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...retention,
    proposalId: input.proposalId,
    proposalVersion: input.version,
    conversationId: input.conversationId,
    actorId: input.actorId,
    channel: input.channel,
    channelConversationKey: input.channelConversationKey,
    identityBindingId: input.identityBindingId,
    channelBindingId: input.channelBindingId,
    renderedViewHash: rendered.hash,
    actionExpiresAt: new Date(now.getTime() + actionTtlSeconds * 1_000).toISOString(),
    status: 'active',
    actionTokenHash,
    revision: 1,
  };
  validateConversationalRecord(proposal);
  validateConversationalRecord(presentation);
  const versions = await listProposalVersions(dependencies.client, input.proposalId);
  const supersededProposals = versions.items.filter((candidate) => candidate.version < input.version);
  const supersededPresentations: ProposalPresentation[] = [];
  for (const previous of supersededProposals) {
    const relationships = await listProposalRelationships(dependencies.client, input.proposalId, previous.version);
    for (const sibling of relationships.items) {
      if (sibling.recordType === 'proposal_presentation' && sibling.status === 'active') {
        supersededPresentations.push(sibling);
      }
    }
  }
  await atomicStorePresentedProposal(dependencies.client, {
    proposal,
    presentation,
    supersededProposals,
    supersededPresentations,
  });
  return { proposal, presentation, preview: rendered.preview, actionToken };
}

function deterministicAttemptIdentity(proposal: ProposalVersion): { id: string; idempotencyKey: string } {
  const identity = `${proposal.proposalId}:${proposal.version}:${proposal.canonicalPayloadHash}`;
  const digest = sha256(identity).slice(7);
  return {
    id: `attempt-${digest}`,
    idempotencyKey: `execution-${digest}`,
  };
}

function proposalHashesAreValid(proposal: ProposalVersion, executor: CapabilityExecutor): boolean {
  try {
    const canonical = canonicalProposalSpec(proposal.spec);
    const rendered = renderDeterministically(executor, proposal.spec);
    return sha256(canonical) === proposal.canonicalPayloadHash && rendered.hash === proposal.renderedViewHash;
  } catch {
    return false;
  }
}

async function approvePresentation(
  actionToken: string,
  provenance: TrustedApprovalProvenance,
  dependencies: ApprovalDependencies
): Promise<{ interaction: 'execution_pending'; attempt: ExecutionAttempt }> {
  if (!/^[A-Za-z0-9_-]{43,200}$/.test(actionToken)) throw new ApprovalUnavailableError();
  const now = (dependencies.now || (() => new Date()))();
  const nowIso = now.toISOString();
  const presentation = await getPresentationByTokenHash(dependencies.client, sha256(actionToken), now);
  if (!presentation) throw new ApprovalUnavailableError();
  const proposal = await getProposalVersion(
    dependencies.client,
    presentation.proposalId,
    presentation.proposalVersion
  );
  if (!proposal) throw new ApprovalUnavailableError();
  const identity = deterministicAttemptIdentity(proposal);
  if (
    presentation.actorId !== provenance.actorId
    || presentation.channel !== provenance.channel
    || presentation.channelConversationKey !== provenance.channelConversationKey
    || presentation.conversationId !== proposal.conversationId
  ) {
    throw new ApprovalUnavailableError();
  }
  if (presentation.status === 'consumed') {
    const existing = await getExecutionAttempt(dependencies.client, identity.id, now);
    if (
      existing
      && existing.proposalId === proposal.proposalId
      && existing.proposalVersion === proposal.version
    ) {
      return { interaction: 'execution_pending', attempt: existing };
    }
    throw new ApprovalUnavailableError();
  }
  if (proposal.status === 'claimed') throw new ApprovalUnavailableError();
  if (
    presentation.status !== 'active'
    || proposal.status !== 'presented'
    || presentation.renderedViewHash !== proposal.renderedViewHash
    || !presentation.actionExpiresAt
    || Date.parse(presentation.actionExpiresAt) <= now.getTime()
  ) {
    throw new ApprovalUnavailableError();
  }
  const [binding, channelBinding, permission, actor] = await Promise.all([
    getIdentityBinding(dependencies.client, provenance.channel, provenance.channelUserId),
    getChannelBinding(dependencies.client, provenance.channel, provenance.channelConversationKey, now),
    getApprovalPermission(dependencies.client, provenance.actorId, proposal.spec.permissionRef),
    getUser(dependencies.client, provenance.actorId),
  ]);
  const executor = dependencies.registry.get(proposal.spec.effect, proposal.spec.pluginBuildDigest);
  if (
    !binding
    || !actor
    || actor.disabled === true
    || binding.id !== presentation.identityBindingId
    || binding.userId !== provenance.actorId
    || binding.status !== 'active'
    || !channelBinding
    || channelBinding.id !== presentation.channelBindingId
    || channelBinding.conversationId !== proposal.conversationId
    || channelBinding.ownerUserId !== provenance.actorId
    || !permission?.enabled
    || !executor
    || executor.permissionRef !== proposal.spec.permissionRef
    || !proposalHashesAreValid(proposal, executor)
    || Date.parse(proposal.spec.expiresAt) <= now.getTime()
  ) {
    throw new ApprovalUnavailableError();
  }
  if (proposal.spec.targetRef && proposal.spec.baseRevision) {
    const target = await getCanonicalTarget(dependencies.client, proposal.spec.targetRef);
    if (!target || target.revision !== proposal.spec.baseRevision) {
      try {
        await markProposalConflicted(dependencies.client, proposal, presentation, nowIso);
      } catch {
        // A concurrent action already changed the proposal; it remains unusable.
      }
      const relationships = await listProposalRelationships(
        dependencies.client,
        proposal.proposalId,
        proposal.version
      );
      for (const sibling of relationships.items) {
        if (
          sibling.recordType === 'proposal_presentation'
          && sibling.actionTokenHash !== presentation.actionTokenHash
          && sibling.status === 'active'
        ) {
          try {
            await compareAndSetPresentation(
              dependencies.client,
              sibling.actionTokenHash,
              'active',
              'revoked',
              sibling.revision,
              nowIso
            );
          } catch {
            // Concurrent consumption/revocation already made the control unusable.
          }
        }
      }
      throw new ProposalConflictError();
    }
  }
  const attempt: ExecutionAttempt = {
    id: identity.id,
    recordType: 'execution_attempt',
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...expiryFrom(nowIso, 365),
    proposalId: proposal.proposalId,
    proposalVersion: proposal.version,
    conversationId: proposal.conversationId,
    actorId: proposal.actorId,
    identityBindingId: presentation.identityBindingId,
    identityChannel: provenance.channel,
    identityChannelUserId: provenance.channelUserId,
    channelBindingId: presentation.channelBindingId,
    channelConversationKey: provenance.channelConversationKey,
    permissionRef: proposal.spec.permissionRef,
    canonicalPayloadHash: proposal.canonicalPayloadHash,
    renderedViewHash: proposal.renderedViewHash,
    executorBuildDigest: proposal.spec.pluginBuildDigest,
    status: 'queued',
    deliveryMode: executor.deliveryMode,
    idempotencyRef: identity.idempotencyKey,
    attemptNumber: 1,
    readyAt: nowIso,
    leaseGeneration: 0,
    recoveryBlocked: false,
    revision: 1,
  };
  const approvalRelationships = await listProposalRelationships(
    dependencies.client,
    proposal.proposalId,
    proposal.version
  );
  const siblingPresentations = approvalRelationships.items.filter(
    (item): item is ProposalPresentation => (
      item.recordType === 'proposal_presentation'
      && item.actionTokenHash !== presentation.actionTokenHash
      && item.status === 'active'
    )
  );
  if (siblingPresentations.length > 20) throw new ApprovalUnavailableError();
  try {
    await atomicApproval(dependencies.client, {
      presentation,
      proposal,
      identity: binding,
      channelUserId: provenance.channelUserId,
      channelConversationKey: provenance.channelConversationKey,
      attempt,
      siblingPresentations,
      auditId: `audit-${identity.id.slice(8, 32)}`,
      now: nowIso,
    });
    return { interaction: 'execution_pending', attempt };
  } catch (error) {
    if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
    const existing = await getExecutionAttempt(dependencies.client, identity.id, now);
    if (
      existing
      && existing.proposalId === proposal.proposalId
      && existing.proposalVersion === proposal.version
    ) {
      return { interaction: 'execution_pending', attempt: existing };
    }
    throw new ApprovalUnavailableError();
  }
}

export {
  ApprovalUnavailableError,
  ExecutorRegistry,
  ProposalConflictError,
  approvePresentation,
  canonicalProposalSpec,
  deterministicAttemptIdentity,
  presentProposal,
  proposalHashesAreValid,
  renderDeterministically,
  sha256,
};
export type {
  ApprovalDependencies,
  CapabilityExecutor,
  ExecutorRequest,
  ExecutorResult,
  PresentedProposal,
  ProposalPresentationDependencies,
  ProposalPresentationInput,
  ReconciliationResult,
  TrustedApprovalProvenance,
};
