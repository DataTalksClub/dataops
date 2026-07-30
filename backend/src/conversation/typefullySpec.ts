import { createHash } from 'crypto';

import type {
  CapabilityExecutor,
  ExecutorResult,
} from './execution';
import { canonicalJson } from './pluginRegistry';
import type { JsonValue, ProposalSpec } from './types';
import {
  TYPEFULLY_DELIVERY_MODE,
  TYPEFULLY_DELIVERY_MODE_DIGEST,
  TYPEFULLY_EFFECT,
  TYPEFULLY_PERMISSION,
  TYPEFULLY_POLICY_DIGEST,
  typefullyMetadata,
  typefullyResourceKey,
  validateTypefullyCandidate,
  type TypefullyCandidate,
} from './typefullyPlugin';

function typefullyImmutableBindingDigest(spec: ProposalSpec): string {
  const binding = {
    pluginId: spec.pluginId,
    action: spec.action,
    operation: spec.operation,
    effect: spec.effect,
    destinationRef: spec.destinationRef,
    pluginBuildDigest: spec.pluginBuildDigest,
    schemaDigest: spec.schemaDigest,
    policyDigest: spec.policyDigest,
    permissionRef: spec.permissionRef,
    permissionRevision: spec.permissionRevision,
    resourceKey: spec.resourceKey,
    accountConfigDigest: spec.accountConfigDigest,
    accountScopeDigest: spec.accountScopeDigest,
    deliveryMode: spec.deliveryMode,
    deliveryModeDigest: spec.deliveryModeDigest,
    actorId: spec.actorId,
    conversationId: spec.conversationId,
    draftRef: spec.draftRef,
    proposalId: spec.proposalId,
    proposalVersion: spec.proposalVersion,
    expiresAt: spec.expiresAt,
    proposedContent: spec.proposedContent,
    sourceRefs: spec.sourceRefs,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(binding)).digest('hex')}`;
}

function candidateFromTypefullySpec(spec: ProposalSpec): TypefullyCandidate | null {
  const sourceRefs = Array.isArray(spec.sourceRefs) ? spec.sourceRefs : [];
  if (
    spec.pluginId !== 'typefully'
    || spec.action !== 'propose_draft'
    || spec.operation !== 'create'
    || spec.effect !== TYPEFULLY_EFFECT
    || spec.destinationRef !== 'typefully.saved_drafts'
    || spec.targetRef !== undefined
    || spec.baseRevision !== undefined
    || spec.privatePayloadRef !== undefined
    || spec.permissionRef !== TYPEFULLY_PERMISSION
    || spec.pluginBuildDigest !== typefullyMetadata.buildDigest
    || spec.schemaDigest !== typefullyMetadata.schemaDigest
    || spec.policyDigest !== TYPEFULLY_POLICY_DIGEST
    || spec.deliveryMode !== TYPEFULLY_DELIVERY_MODE
    || spec.deliveryModeDigest !== TYPEFULLY_DELIVERY_MODE_DIGEST
    || !spec.accountConfigDigest
    || !spec.accountScopeDigest
    || !spec.actorId
    || !spec.conversationId
    || !spec.draftRef
    || !spec.proposalId
    || !Number.isSafeInteger(spec.proposalVersion)
    || spec.proposalVersion! < 1
    || !Number.isSafeInteger(spec.permissionRevision)
    || spec.permissionRevision! < 1
    || typeof spec.expiresAt !== 'string'
    || Number.isNaN(Date.parse(spec.expiresAt))
    || sourceRefs.length < 1
    || sourceRefs.length > 8
    || new Set(sourceRefs.map((source) => source.ref)).size !== sourceRefs.length
    || sourceRefs.some((source) => (
      source.classification !== 'public'
      || !/^[\x21-\x7e]{1,160}$/.test(source.ref)
      || !/^public-source:sha256:[a-f0-9]{64}$/.test(source.ref)
      || typeof source.revision !== 'string'
      || !new RegExp(`^${TYPEFULLY_POLICY_DIGEST}:[1-9]\\d*$`).test(source.revision)
    ))
  ) return null;
  const candidate = validateTypefullyCandidate(spec.proposedContent);
  if (
    !candidate
    || canonicalJson(candidate) !== canonicalJson(spec.proposedContent)
    || spec.resourceKey !== typefullyResourceKey(candidate.account)
  ) return null;
  return candidate;
}

function renderTypefullySpec(spec: ProposalSpec): JsonValue {
  const candidate = candidateFromTypefullySpec(spec);
  if (!candidate) throw new Error('typefully_spec_invalid');
  return {
    kind: 'typefully_saved_draft_preview',
    account: candidate.account,
    platforms: candidate.platforms,
    ...(candidate.draftTitle ? { draftTitle: candidate.draftTitle } : {}),
    ...(candidate.scratchpadText ? { scratchpadText: candidate.scratchpadText } : {}),
    ...(candidate.xPosts ? { xPosts: candidate.xPosts } : {}),
    ...(candidate.linkedinPosts ? { linkedinPosts: candidate.linkedinPosts } : {}),
    publicSourceProofs: spec.sourceRefs.map((source) => ({
      ref: source.ref,
      revision: source.revision || '',
      classification: source.classification,
    })),
    binding: {
      actorId: spec.actorId!,
      conversationId: spec.conversationId!,
      draftRef: spec.draftRef!,
      proposalId: spec.proposalId!,
      proposalVersion: spec.proposalVersion!,
      expiresAt: spec.expiresAt,
      permissionRevision: spec.permissionRevision!,
      immutableSpecDigest: typefullyImmutableBindingDigest(spec),
    },
    deliveryMode: TYPEFULLY_DELIVERY_MODE,
    effect: 'Create one unscheduled, unpublished, unshared Typefully saved draft.',
  };
}

class TypefullyProposalRenderExecutor implements CapabilityExecutor {
  readonly effect = TYPEFULLY_EFFECT;
  readonly buildDigest = typefullyMetadata.buildDigest;
  readonly permissionRef = TYPEFULLY_PERMISSION;
  readonly deliveryMode = TYPEFULLY_DELIVERY_MODE;

  render(spec: ProposalSpec): JsonValue {
    return renderTypefullySpec(spec);
  }

  async execute(): Promise<ExecutorResult> {
    return { outcome: 'failed_safe', reasonCode: 'typefully_worker_only' };
  }
}

export {
  TypefullyProposalRenderExecutor,
  candidateFromTypefullySpec,
  renderTypefullySpec,
  typefullyImmutableBindingDigest,
};
