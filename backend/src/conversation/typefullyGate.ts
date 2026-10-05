import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { sha256 } from './execution';
import { getApprovalPermission } from './executionPermissions';
import { canonicalJson } from './pluginRegistry';
import { getProposalVersion } from './proposalTransactions';
import type { ProposalAdapter, StaticProposalCoordinator } from './proposalCoordinator';
import {
  getPluginDraft,
  savePluginDraft,
} from './conversationEvents';
import { getPresentationByTokenHash } from './proposalRecords';
import {
  getConversationalPrivatePayload,
  putConversationalPrivatePayload,
} from './privatePayloads';
import type {
  CoreInput,
  CoreInteraction,
} from './telegramProtocol';
import {
  expiryFrom,
  type JsonValue,
  type PluginDraft,
} from './types';
import {
  TYPEFULLY_PLUGIN_ID,
  TYPEFULLY_POLICY_DIGEST,
  TYPEFULLY_PUBLIC_CONFIRMATION,
  isTypefullyIntent,
} from './typefullyPlugin';

export interface TypefullyGateContext {
  client: DynamoDBDocumentClient;
  now: () => Date;
  coordinator: StaticProposalCoordinator;
  error: () => CoreInteraction;
}

export interface TypefullyModelGate {
  modelEvents: Array<{ sequence: number; id: string; text: string }>;
  sourceProof: JsonValue;
  sourceProofDigest?: string;
  previousCandidate?: JsonValue;
  continuationExpiresAt?: string;
  coreChoices?: { account?: string; platforms?: string[] };
  continuationKind?: 'clarification' | 'request_changes';
  basedOnProposalId?: string;
  basedOnProposalVersion?: number;
  basedOnPresentationHash?: string;
}

interface ValidatedTypefullyContinuation {
  proofs: JsonValue[];
  sources: string[];
  previousCandidate?: JsonValue;
  coreChoices?: TypefullyModelGate['coreChoices'];
  continuationKind: 'clarification' | 'request_changes';
  basedOnProposalId?: string;
  basedOnProposalVersion?: number;
  basedOnPresentationHash?: string;
}

const TYPEFULLY_CONTINUATION_MS = 20 * 60_000;
const TYPEFULLY_AMENDMENT_MAX_BYTES = 4_096;

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateTypefullyCoreChoices(
  value: unknown
): { valid: boolean; choices?: TypefullyModelGate['coreChoices'] } {
  if (value === undefined) return { valid: true };
  const candidate = object(value);
  if (!candidate) return { valid: false };
  const keys = Object.keys(candidate);
  if (
    keys.length < 1
    || keys.some((key) => key !== 'account' && key !== 'platforms')
    || (
      candidate.account !== undefined
      && candidate.account !== 'alexey'
      && candidate.account !== 'datatalksclub'
    )
  ) return { valid: false };
  const platforms = candidate.platforms;
  if (
    platforms !== undefined
    && (
      !Array.isArray(platforms)
      || ![
        canonicalJson(['x']),
        canonicalJson(['linkedin']),
        canonicalJson(['x', 'linkedin']),
      ].includes(canonicalJson(platforms))
    )
  ) return { valid: false };
  return {
    valid: true,
    choices: {
      ...(candidate.account !== undefined ? { account: candidate.account as string } : {}),
      ...(platforms !== undefined ? { platforms: platforms as string[] } : {}),
    },
  };
}

async function validateTypefullyContinuation(
  ctx: TypefullyGateContext,
  input: CoreInput,
  adapter: ProposalAdapter,
  data: Record<string, unknown>,
  proofs: JsonValue[]
): Promise<ValidatedTypefullyContinuation | null> {
  if (data.mode !== 'clarification' && data.mode !== 'request_changes') return null;
  const choicesResult = validateTypefullyCoreChoices(data.coreChoices);
  if (!choicesResult.valid) return null;
  const sources = await resolveTypefullyProofs(ctx, input, proofs);
  if (!sources) return null;
  const hasBasedOn = data.basedOnProposalId !== undefined
    || data.basedOnProposalVersion !== undefined
    || data.basedOnPresentationHash !== undefined;
  if (data.mode === 'clarification') {
    if (hasBasedOn || data.previousCandidate !== undefined) return null;
    return {
      proofs,
      sources,
      continuationKind: 'clarification',
      ...(choicesResult.choices ? { coreChoices: choicesResult.choices } : {}),
    };
  }
  if (
    typeof data.basedOnProposalId !== 'string'
    || !Number.isSafeInteger(data.basedOnProposalVersion)
    || typeof data.basedOnPresentationHash !== 'string'
  ) return null;
  const [presentation, proposal] = await Promise.all([
    getPresentationByTokenHash(
      ctx.client,
      data.basedOnPresentationHash,
      ctx.now()
    ),
    getProposalVersion(
      ctx.client,
      data.basedOnProposalId,
      Number(data.basedOnProposalVersion)
    ),
  ]);
  const previousCandidate = adapter.validateCandidate(data.previousCandidate);
  const previousObject = object(previousCandidate);
  const sourceRefs = proofs.map((value) => {
    const proof = object(value)!;
    return {
      ref: `public-source:${String(proof.sourceDigest)}`,
      revision: `${String(proof.policyDigest)}:${String(proof.confirmationRevision)}`,
      classification: String(proof.classification),
    };
  });
  const proofDigest = data.sourceProof !== undefined
    ? data.sourceProofDigest
    : data.priorProofsDigest;
  if (
    presentation?.status !== 'revoked'
    || presentation.actorId !== input.actor.id
    || presentation.conversationId !== input.conversationId
    || presentation.proposalId !== data.basedOnProposalId
    || presentation.proposalVersion !== data.basedOnProposalVersion
    || proposal?.status !== 'superseded'
    || proposal.actorId !== input.actor.id
    || proposal.conversationId !== input.conversationId
    || !previousCandidate
    || canonicalJson(previousCandidate) !== canonicalJson(proposal.spec.proposedContent)
    || proofDigest !== sha256(canonicalJson(proofs))
    || sourceRefs.length < proposal.spec.sourceRefs.length
    || canonicalJson(sourceRefs.slice(0, proposal.spec.sourceRefs.length))
      !== canonicalJson(proposal.spec.sourceRefs)
    || (
      choicesResult.choices?.account !== undefined
      && previousObject?.account !== choicesResult.choices.account
    )
    || (
      choicesResult.choices?.platforms !== undefined
      && canonicalJson(previousObject?.platforms)
        !== canonicalJson(choicesResult.choices.platforms)
    )
  ) return null;
  return {
    proofs,
    sources,
    previousCandidate,
    continuationKind: 'request_changes',
    basedOnProposalId: data.basedOnProposalId,
    basedOnProposalVersion: Number(data.basedOnProposalVersion),
    basedOnPresentationHash: data.basedOnPresentationHash,
    ...(choicesResult.choices ? { coreChoices: choicesResult.choices } : {}),
  };
}

export async function typefullyPublicSourceGate(
  ctx: TypefullyGateContext,
  input: CoreInput
): Promise<{ gate?: TypefullyModelGate } | { interaction: CoreInteraction }> {
  const adapter = ctx.coordinator.getByPlugin(TYPEFULLY_PLUGIN_ID);
  if (!adapter || !adapter.isEnabled()) return {};
  const permission = await getApprovalPermission(
    ctx.client,
    input.actor.id,
    adapter.permissionRef
  );
  if (!permission?.enabled) return {};
  const text = input.text!.normalize('NFKC').trim();
  const isConfirmation = text.toLocaleLowerCase('en-US') === TYPEFULLY_PUBLIC_CONFIRMATION;
  const intent = isTypefullyIntent(text);
  const draftId = adapter.draftId(input.conversationId, input.actor.id);
  const existing = await getPluginDraft(
    ctx.client,
    input.conversationId,
    draftId,
    input.actor.id,
    ctx.now()
  );
  const data = object(existing?.data);
  const isContinuation = data?.kind === 'typefully_continuation';
  if (input.inputTrust !== 'operator_authored') {
    return intent || isContinuation
      ? {
        interaction: {
          kind: 'clarification',
          message: 'Typefully needs a new typed public-safe summary. Voice, photo, file, and fetched content are not eligible.',
        },
      }
      : {};
  }
  if (isConfirmation) {
    const continuationPending = data?.pendingMode === 'continuation';
    const initialPending = data?.pendingMode === 'initial';
    const hasContinuationMaterial = Boolean(
      data?.priorProofs !== undefined
      || data?.previousCandidate !== undefined
      || data?.coreChoices !== undefined
      || data?.continuationExpiresAt !== undefined
      || data?.continuationKind !== undefined
      || data?.priorProofsDigest !== undefined
      || data?.basedOnProposalId !== undefined
      || data?.basedOnProposalVersion !== undefined
      || data?.basedOnPresentationHash !== undefined
    );
    const continuationKind = data?.continuationKind;
    const completeBasedOn = typeof data?.basedOnProposalId === 'string'
      && Number.isSafeInteger(data?.basedOnProposalVersion)
      && typeof data?.basedOnPresentationHash === 'string';
    const anyBasedOn = data?.basedOnProposalId !== undefined
      || data?.basedOnProposalVersion !== undefined
      || data?.basedOnPresentationHash !== undefined;
    const strictVariant = (
      initialPending
      && !hasContinuationMaterial
    ) || (
      continuationPending
      && (continuationKind === 'clarification' || continuationKind === 'request_changes')
      && typeof data?.continuationExpiresAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.continuationExpiresAt)
      && Date.parse(data.continuationExpiresAt) > ctx.now().getTime()
      && Array.isArray(data?.priorProofs)
      && data.priorProofs.length >= 1
      && typeof data?.priorProofsDigest === 'string'
      && data.priorProofsDigest === sha256(canonicalJson(data.priorProofs))
      && (
        continuationKind === 'request_changes'
          ? completeBasedOn && data?.previousCandidate !== undefined
          : !anyBasedOn && data?.previousCandidate === undefined
      )
    );
    if (
      !existing
      || data?.kind !== 'typefully_public_source_pending'
      || !strictVariant
      || data.actorId !== input.actor.id
      || data.conversationId !== input.conversationId
      || data.pluginBuild !== adapter.buildDigest
      || data.classification !== 'private'
      || data.policyDigest !== TYPEFULLY_POLICY_DIGEST
      || typeof data.payloadRef !== 'string'
      || typeof data.sourceDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(data.sourceDigest)
    ) {
      return {
        interaction: {
          kind: 'clarification',
          message: 'There is no current typed Typefully source to confirm. Please type the social request again.',
        },
      };
    }
    const priorProofs = continuationPending
      && Array.isArray(data.priorProofs)
      ? data.priorProofs as JsonValue[]
      : [];
    const continuationValidation = continuationPending
      ? await validateTypefullyContinuation(ctx, input, adapter, {
        ...data,
        mode: continuationKind,
      }, priorProofs)
      : null;
    if (continuationPending && !continuationValidation) {
      return { interaction: ctx.error() };
    }
    const payload = await getConversationalPrivatePayload(
      ctx.client,
      input.conversationId,
      data.payloadRef,
      input.actor.id,
      ctx.now()
    );
    const rawSourceText = object(payload?.content)?.text;
    const sourceText = typeof rawSourceText === 'string' ? rawSourceText : null;
    if (!sourceText || sha256(sourceText.normalize('NFKC')) !== data.sourceDigest) {
      return {
        interaction: {
          kind: 'clarification',
          message: 'That public-source confirmation expired. Please type the social request again.',
        },
      };
    }
    const grant: JsonValue = {
      kind: 'typefully_public_source_grant',
      actorId: input.actor.id,
      payloadRef: data.payloadRef,
      sourceDigest: data.sourceDigest,
      classification: 'public',
      policyDigest: TYPEFULLY_POLICY_DIGEST,
      sourceRevision: Number(data.sourceRevision),
      confirmationRevision: input.conversationRevision,
    };
    const proofs = [...priorProofs, grant];
    if (proofs.length > 8) return { interaction: ctx.error() };
    const proofGrants: JsonValue = {
      kind: 'typefully_public_source_grants',
      proofs,
    };
    const resolved = await resolveTypefullyProofs(ctx, input, proofs);
    if (!resolved) {
      return {
        interaction: {
          kind: 'clarification',
          message: 'That public-source confirmation expired. Please type the social request again.',
        },
      };
    }
    const nowIso = ctx.now().toISOString();
    await savePluginDraft(ctx.client, {
      ...existing,
      updatedAt: nowIso,
      ...expiryFrom(nowIso, 30),
      data: proofGrants,
      revision: existing.revision + 1,
    }, existing.revision);
    const previousCandidate = continuationValidation?.previousCandidate;
    const coreChoices = continuationValidation?.coreChoices;
    const modelEvents = resolved.map((source, index) => ({
      sequence: input.conversationRevision + index,
      id: `confirmed-public-${index}-${input.provenance.updateId}`,
      text: `Owner-confirmed public source ${index + 1}:\n${source}`,
    }));
    if (previousCandidate !== undefined) {
      modelEvents.push({
        sequence: input.conversationRevision + modelEvents.length,
        id: `prior-typefully-candidate-${input.provenance.updateId}`,
        text: `Exact prior Typefully candidate to revise into a complete replacement:\n${JSON.stringify(previousCandidate)}`,
      });
    }
    if (coreChoices && Object.keys(coreChoices).length > 0) {
      modelEvents.push({
        sequence: input.conversationRevision + modelEvents.length,
        id: `typefully-core-choices-${input.provenance.updateId}`,
        text: `Core-validated Typefully choices (not source text):\n${JSON.stringify(coreChoices)}`,
      });
    }
    if (
      modelEvents.reduce(
        (total, event) => total + Buffer.byteLength(event.text, 'utf8'),
        0
      ) > 18_000
    ) {
      return {
        interaction: {
          kind: 'clarification',
          message: 'That confirmed Typefully context is too large for an exact, untruncated revision. Start a smaller typed request.',
        },
      };
    }
    return {
      gate: {
        modelEvents,
        sourceProof: proofGrants,
        ...(previousCandidate !== undefined ? { previousCandidate } : {}),
        ...(coreChoices ? { coreChoices } : {}),
        ...(continuationValidation ? {
          continuationKind: continuationValidation.continuationKind,
          ...(continuationValidation.basedOnProposalId ? {
            basedOnProposalId: continuationValidation.basedOnProposalId,
            basedOnProposalVersion: continuationValidation.basedOnProposalVersion!,
            basedOnPresentationHash: continuationValidation.basedOnPresentationHash!,
          } : {}),
        } : {}),
        ...(typeof data.continuationExpiresAt === 'string'
          ? { continuationExpiresAt: data.continuationExpiresAt }
          : {}),
      },
    };
  }
  if (isContinuation) {
    const expiresAt = typeof data.continuationExpiresAt === 'string'
      ? data.continuationExpiresAt
      : '';
    const proofs = object(data.sourceProof)?.kind === 'typefully_public_source_grants'
      && Array.isArray(object(data.sourceProof)?.proofs)
      ? object(data.sourceProof)!.proofs as JsonValue[]
      : [];
    const validEnvelope = data.actorId === input.actor.id
      && data.conversationId === input.conversationId
      && data.pluginBuild === adapter.buildDigest
      && data.policyDigest === TYPEFULLY_POLICY_DIGEST
      && Date.parse(expiresAt) > ctx.now().getTime()
      && proofs.length >= 1
      && proofs.length < 8;
    const continuationValidation = validEnvelope
      ? await validateTypefullyContinuation(ctx, input, adapter, data, proofs)
      : null;
    if (!continuationValidation) {
      if (!intent) {
        return {
          interaction: {
            kind: 'clarification',
            message: 'That Typefully continuation is stale or expired. Type a new Typefully request.',
          },
        };
      }
    } else if (data.awaitingField === 'account' || data.awaitingField === 'platforms') {
      const normalized = text.toLocaleLowerCase('en-US').replace(/[^a-z]/g, '');
      const nextChoices = { ...(continuationValidation.coreChoices || {}) };
      if (data.awaitingField === 'account') {
        if (normalized === 'alexey') nextChoices.account = 'alexey';
        else if (normalized === 'datatalksclub' || normalized === 'dtc') {
          nextChoices.account = 'datatalksclub';
        } else {
          return {
            interaction: {
              kind: 'clarification',
              message: 'Choose exactly Alexey or DataTalksClub for the Typefully account.',
            },
          };
        }
      } else {
        if (normalized === 'x' || normalized === 'twitter') nextChoices.platforms = ['x'];
        else if (normalized === 'linkedin') nextChoices.platforms = ['linkedin'];
        else if (
          ['both', 'xandlinkedin', 'twitterandlinkedin'].includes(normalized)
        ) nextChoices.platforms = ['x', 'linkedin'];
        else {
          return {
            interaction: {
              kind: 'clarification',
              message: 'Choose exactly X, LinkedIn, or both for Typefully platforms.',
            },
          };
        }
      }
      const sources = continuationValidation.sources;
      const modelEvents = sources.map((source, index) => ({
        sequence: input.conversationRevision + index,
        id: `confirmed-public-${index}-${input.provenance.updateId}`,
        text: `Owner-confirmed public source ${index + 1}:\n${source}`,
      }));
      if (continuationValidation.previousCandidate !== undefined) {
        modelEvents.push({
          sequence: input.conversationRevision + modelEvents.length,
          id: `prior-typefully-candidate-${input.provenance.updateId}`,
          text: `Exact prior Typefully candidate to revise into a complete replacement:\n${JSON.stringify(continuationValidation.previousCandidate)}`,
        });
      }
      modelEvents.push({
        sequence: input.conversationRevision + modelEvents.length,
        id: `typefully-core-choices-${input.provenance.updateId}`,
        text: `Core-validated Typefully choices (not source text):\n${JSON.stringify(nextChoices)}`,
      });
      return {
        gate: {
          sourceProof: data.sourceProof as JsonValue,
          sourceProofDigest: sha256(canonicalJson(proofs)),
          coreChoices: nextChoices,
          continuationExpiresAt: expiresAt,
          modelEvents,
          continuationKind: continuationValidation.continuationKind,
          ...(continuationValidation.previousCandidate !== undefined
            ? { previousCandidate: continuationValidation.previousCandidate }
            : {}),
          ...(continuationValidation.basedOnProposalId ? {
            basedOnProposalId: continuationValidation.basedOnProposalId,
            basedOnProposalVersion: continuationValidation.basedOnProposalVersion!,
            basedOnPresentationHash: continuationValidation.basedOnPresentationHash!,
          } : {}),
        },
      };
    } else {
      if (
        input.source?.kind !== 'telegram_text'
        || text.length === 0
        || Buffer.byteLength(text, 'utf8') > TYPEFULLY_AMENDMENT_MAX_BYTES
      ) {
        return {
          interaction: {
            kind: 'clarification',
            message: 'Please type one bounded public-safe answer or replacement directly in this private chat.',
          },
        };
      }
      return {
        interaction: await saveTypefullyPending(ctx, input, adapter, existing, text, {
          priorProofs: continuationValidation.proofs,
          ...(continuationValidation.coreChoices
            ? { coreChoices: continuationValidation.coreChoices }
            : {}),
          ...(continuationValidation.previousCandidate !== undefined
            ? { previousCandidate: continuationValidation.previousCandidate }
            : {}),
          continuationExpiresAt: expiresAt,
          continuationKind: data.mode === 'request_changes'
            ? 'request_changes'
            : 'clarification',
          ...(typeof data.basedOnProposalId === 'string' ? {
            basedOnProposalId: data.basedOnProposalId,
            basedOnProposalVersion: Number(data.basedOnProposalVersion),
            basedOnPresentationHash: String(data.basedOnPresentationHash),
          } : {}),
        }),
      };
    }
  }
  if (!intent) return {};
  if (
    input.source?.kind !== 'telegram_text'
    || Buffer.byteLength(text, 'utf8') > 16_384
    || text.length === 0
  ) {
    return {
      interaction: {
        kind: 'clarification',
        message: 'Please type a new bounded public-safe social request directly in this private chat.',
      },
    };
  }
  return {
    interaction: await saveTypefullyPending(ctx, input, adapter, existing, text),
  };
}

async function saveTypefullyPending(
  ctx: TypefullyGateContext,
  input: CoreInput,
  adapter: ProposalAdapter,
  existing: PluginDraft | null,
  text: string,
  continuation: {
    priorProofs?: JsonValue[];
    previousCandidate?: JsonValue;
    coreChoices?: TypefullyModelGate['coreChoices'];
    continuationExpiresAt?: string;
    continuationKind?: 'clarification' | 'request_changes';
    basedOnProposalId?: string;
    basedOnProposalVersion?: number;
    basedOnPresentationHash?: string;
  } = {}
): Promise<CoreInteraction> {
  const nowIso = ctx.now().toISOString();
  const sourceDigest = sha256(text);
  const payloadId = input.source?.payloadRef
    || `typefully-public-source-${sourceDigest.slice(7, 31)}-${input.conversationRevision}`;
  if (input.source?.payloadRef) {
    const payload = await getConversationalPrivatePayload(
      ctx.client,
      input.conversationId,
      payloadId,
      input.actor.id,
      ctx.now()
    );
    const content = object(payload?.content);
    if (
      content?.source !== 'telegram_text'
      || typeof content.text !== 'string'
      || content.text.normalize('NFKC').trim() !== text
    ) {
      return {
        kind: 'clarification',
        message: 'Please type a new bounded public-safe social request directly in this private chat.',
      };
    }
  } else {
    await putConversationalPrivatePayload(ctx.client, {
      id: payloadId,
      recordType: 'conversational_private_payload',
      schemaVersion: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...expiryFrom(nowIso, 30),
      conversationId: input.conversationId,
      classification: 'private',
      content: {
        kind: 'typed_public_source_candidate',
        text,
        sourceDigest,
      },
    });
  }
  const draftId = adapter.draftId(input.conversationId, input.actor.id);
  const pending: PluginDraft = {
    id: draftId,
    recordType: 'plugin_draft',
    schemaVersion: 1,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    ...expiryFrom(nowIso, 30),
    conversationId: input.conversationId,
    pluginId: adapter.pluginId,
    pluginBuild: adapter.buildDigest,
    status: 'collecting',
    data: {
      kind: 'typefully_public_source_pending',
      pendingMode: continuation.priorProofs?.length ? 'continuation' : 'initial',
      actorId: input.actor.id,
      conversationId: input.conversationId,
      pluginBuild: adapter.buildDigest,
      payloadRef: payloadId,
      sourceDigest,
      classification: 'private',
      policyDigest: TYPEFULLY_POLICY_DIGEST,
      sourceRevision: input.conversationRevision,
      ...(continuation.priorProofs?.length
        ? {
          priorProofs: continuation.priorProofs,
          priorProofsDigest: sha256(canonicalJson(continuation.priorProofs)),
        }
        : {}),
      ...(continuation.previousCandidate !== undefined
        ? { previousCandidate: continuation.previousCandidate }
        : {}),
      ...(continuation.coreChoices ? { coreChoices: continuation.coreChoices } : {}),
      ...(continuation.continuationExpiresAt
        ? { continuationExpiresAt: continuation.continuationExpiresAt }
        : {}),
      ...(continuation.continuationKind
        ? { continuationKind: continuation.continuationKind }
        : {}),
      ...(continuation.basedOnProposalId ? {
        basedOnProposalId: continuation.basedOnProposalId,
        basedOnProposalVersion: continuation.basedOnProposalVersion!,
        basedOnPresentationHash: continuation.basedOnPresentationHash!,
      } : {}),
    },
    revision: (existing?.revision || 0) + 1,
  };
  await savePluginDraft(
    ctx.client,
    pending,
    existing?.revision ?? null
  );
  return {
    kind: 'clarification',
    message: `Typefully can use only this exact typed text as public source. Reply exactly "${TYPEFULLY_PUBLIC_CONFIRMATION}" to confirm, or type a replacement.`,
  };
}

export async function resolveTypefullyProofs(
  ctx: TypefullyGateContext,
  input: CoreInput,
  proofs: JsonValue[]
): Promise<string[] | null> {
  if (proofs.length < 1 || proofs.length > 8) return null;
  const result: string[] = [];
  for (const value of proofs) {
    const proof = object(value);
    if (
      proof?.kind !== 'typefully_public_source_grant'
      || proof.actorId !== input.actor.id
      || proof.classification !== 'public'
      || proof.policyDigest !== TYPEFULLY_POLICY_DIGEST
      || typeof proof.payloadRef !== 'string'
      || typeof proof.sourceDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(proof.sourceDigest)
      || !Number.isSafeInteger(proof.sourceRevision)
      || Number(proof.sourceRevision) < 1
      || !Number.isSafeInteger(proof.confirmationRevision)
      || Number(proof.confirmationRevision) < 1
    ) return null;
    const payload = await getConversationalPrivatePayload(
      ctx.client,
      input.conversationId,
      proof.payloadRef,
      input.actor.id,
      ctx.now()
    );
    const source = object(payload?.content)?.text;
    if (
      payload?.classification !== 'private'
      ||
      typeof source !== 'string'
      || sha256(source.normalize('NFKC').trim()) !== proof.sourceDigest
    ) return null;
    result.push(source);
  }
  return result;
}

export async function saveTypefullyContinuation(
  ctx: TypefullyGateContext,
  input: CoreInput,
  gate: TypefullyModelGate,
  mode: 'clarification' | 'request_changes',
  question = ''
): Promise<void> {
  const adapter = ctx.coordinator.getByPlugin(TYPEFULLY_PLUGIN_ID);
  if (!adapter) throw new Error('typefully_adapter_unavailable');
  const draftId = adapter.draftId(input.conversationId, input.actor.id);
  const draft = await getPluginDraft(
    ctx.client,
    input.conversationId,
    draftId,
    input.actor.id,
    ctx.now()
  );
  if (!draft || draft.pluginBuild !== adapter.buildDigest) {
    throw new Error('typefully_draft_unavailable');
  }
  const nowIso = ctx.now().toISOString();
  await savePluginDraft(ctx.client, {
    ...draft,
    status: 'collecting',
    updatedAt: nowIso,
    ...expiryFrom(nowIso, 30),
    data: {
      kind: 'typefully_continuation',
      mode,
      actorId: input.actor.id,
      conversationId: input.conversationId,
      pluginBuild: adapter.buildDigest,
      policyDigest: TYPEFULLY_POLICY_DIGEST,
      sourceProof: gate.sourceProof,
      sourceProofDigest: gate.sourceProofDigest
        || sha256(canonicalJson(object(gate.sourceProof)?.proofs || [])),
      awaitingField: /\baccount\b/i.test(question)
        ? 'account'
        : /\bplatform/i.test(question)
          ? 'platforms'
          : 'purpose',
      ...(gate.coreChoices ? { coreChoices: gate.coreChoices } : {}),
      continuationExpiresAt: gate.continuationExpiresAt
        || new Date(ctx.now().getTime() + TYPEFULLY_CONTINUATION_MS).toISOString(),
      ...(gate.previousCandidate !== undefined
        ? { previousCandidate: gate.previousCandidate }
        : {}),
      ...(mode === 'request_changes' && gate.basedOnProposalId ? {
        basedOnProposalId: gate.basedOnProposalId,
        basedOnProposalVersion: gate.basedOnProposalVersion!,
        basedOnPresentationHash: gate.basedOnPresentationHash!,
      } : {}),
    },
    revision: draft.revision + 1,
  }, draft.revision);
}

export { TYPEFULLY_CONTINUATION_MS };
