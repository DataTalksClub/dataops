import { createHash } from 'crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  canonicalJson,
} from './pluginRegistry';
import {
  approvalScopeDigest,
  getApprovalPermission,
  getProposalVersion,
  type DispatchStateGuard,
} from './executionRepository';
import {
  getConversationalPrivatePayload,
  getPluginDraft,
} from './repository';
import type {
  CapabilityExecutor,
  ExecutorPreflightRequest,
  ExecutorPreflightResult,
  ExecutorRequest,
  ExecutorResult,
} from './execution';
import type { JsonValue, ProposalSpec } from './types';
import {
  TYPEFULLY_ACCOUNT_KEYS,
  TYPEFULLY_DELIVERY_MODE,
  TYPEFULLY_DELIVERY_MODE_DIGEST,
  TYPEFULLY_EFFECT,
  TYPEFULLY_PERMISSION,
  TYPEFULLY_POLICY_DIGEST,
  safeTypefullyDraftId,
  safeTypefullyEditUrl,
  typefullyMetadata,
  typefullyResourceKey,
  validateTypefullyCandidate,
  type TypefullyAccount,
  type TypefullyCandidate,
  type TypefullyPlatform,
} from './typefullyPlugin';
import { parseConversationalRolloutSnapshot } from './rollout';
import {
  candidateFromTypefullySpec,
  renderTypefullySpec,
} from './typefullySpec';

const DEFAULT_TYPEFULLY_BASE_URL = 'https://api.typefully.com';
const MAX_PROVIDER_RESPONSE_BYTES = 65_536;
const DEFINITIVE_REJECTIONS = new Set([400, 401, 402, 403, 404, 422, 429]);

interface TypefullyCreateRequest {
  draft_title?: string;
  scratchpad_text?: string;
  share: false;
  platforms: Partial<Record<TypefullyPlatform, {
    enabled: true;
    posts: Array<{ text: string }>;
  }>>;
}

interface TypefullyExecutorDependencies {
  fetcher?: typeof fetch;
  secretLoader?: (secretId: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  publicSourceGuard?: (
    request: ExecutorPreflightRequest,
    candidate: TypefullyCandidate
  ) => Promise<DispatchStateGuard | null>;
}

interface ResolvedExecution {
  token: string;
  socialSetId: number;
  baseUrl: string;
  candidate: TypefullyCandidate;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

function normalizeBaseUrl(value: unknown): string | null {
  const text = typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : DEFAULT_TYPEFULLY_BASE_URL;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString().replace(/\/+$/, '')
      : null;
  } catch {
    return null;
  }
}

function typefullyAccountConfigDigest(
  revision: string,
  mappings: Record<TypefullyAccount, number>,
  baseUrl: string
): string {
  return sha256(canonicalJson({
    revision,
    baseUrl,
    mappings: {
      alexey: mappings.alexey,
      datatalksclub: mappings.datatalksclub,
    },
  }));
}

function serializeTypefullyRequest(spec: ProposalSpec): TypefullyCreateRequest {
  const candidate = candidateFromTypefullySpec(spec);
  if (!candidate) throw new Error('typefully_spec_invalid');
  const platforms: TypefullyCreateRequest['platforms'] = {};
  if (candidate.platforms.includes('x')) {
    platforms.x = {
      enabled: true,
      posts: candidate.xPosts!.map((text) => ({ text })),
    };
  }
  if (candidate.platforms.includes('linkedin')) {
    platforms.linkedin = {
      enabled: true,
      posts: candidate.linkedinPosts!.map((text) => ({ text })),
    };
  }
  return {
    ...(candidate.draftTitle ? { draft_title: candidate.draftTitle } : {}),
    ...(candidate.scratchpadText ? { scratchpad_text: candidate.scratchpadText } : {}),
    share: false,
    platforms,
  };
}

async function readBoundedBody(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('typefully_empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('typefully_response_too_large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('typefully_response_invalid');
  }
}

function nullableOrAbsent(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || value[key] === null;
}

function returnedPosts(
  payload: Record<string, unknown>,
  platform: TypefullyPlatform
): { enabled: boolean; texts: string[] } | null {
  const platforms = object(payload.platforms);
  const entry = object(platforms?.[platform]);
  if (!entry) return null;
  if (Object.keys(entry).some((key) => !['enabled', 'posts'].includes(key))) return null;
  if (typeof entry.enabled !== 'boolean' || !Array.isArray(entry.posts)) return null;
  const texts: string[] = [];
  for (const postValue of entry.posts) {
    const post = object(postValue);
    if (
      !post
      || Object.keys(post).some(
        (key) => !['text', 'published_url', 'publishedUrl', 'url'].includes(key)
      )
      || typeof post.text !== 'string'
      || !nullableOrAbsent(post, 'published_url')
      || !nullableOrAbsent(post, 'publishedUrl')
      || !nullableOrAbsent(post, 'url')
    ) return null;
    texts.push(post.text);
  }
  return { enabled: entry.enabled, texts };
}

function validateSuccess(
  payload: Record<string, unknown>,
  candidate: TypefullyCandidate,
  socialSetId: number
): { draftId: string; editUrl: string } | null {
  const primaryDraftId = safeTypefullyDraftId(payload.id);
  const aliasDraftId = safeTypefullyDraftId(payload.draft_id);
  if (payload.id !== undefined && payload.draft_id !== undefined && primaryDraftId !== aliasDraftId) {
    return null;
  }
  const draftId = primaryDraftId || aliasDraftId;
  if (!draftId) return null;
  const primarySocialSet = positiveInteger(payload.social_set_id);
  const aliasSocialSet = positiveInteger(payload.socialSetId);
  if (
    payload.social_set_id !== undefined
    && payload.socialSetId !== undefined
    && primarySocialSet !== aliasSocialSet
  ) return null;
  if ((primarySocialSet || aliasSocialSet) !== socialSetId) return null;
  if (
    payload.status !== 'draft'
    || payload.publish_state !== null
    || !nullableOrAbsent(payload, 'publishState')
    || !nullableOrAbsent(payload, 'scheduled_date')
    || !nullableOrAbsent(payload, 'scheduledDate')
    || !nullableOrAbsent(payload, 'published_at')
    || !nullableOrAbsent(payload, 'publishedAt')
    || !nullableOrAbsent(payload, 'share_url')
    || !nullableOrAbsent(payload, 'shareUrl')
    || ('share' in payload && payload.share !== false)
  ) return null;
  const returnedPlatforms = object(payload.platforms);
  if (!returnedPlatforms) return null;
  if (Object.keys(returnedPlatforms).some((key) => !['x', 'linkedin'].includes(key))) return null;
  for (const platform of TYPEFULLY_ACCOUNT_KEYS) {
    // Account keys must never appear in provider platform output.
    if (object(payload.platforms)?.[platform] !== undefined) return null;
  }
  for (const platform of ['x', 'linkedin'] as const) {
    const selected = candidate.platforms.includes(platform);
    const returned = returnedPosts(payload, platform);
    const present = platform in returnedPlatforms;
    if (selected) {
      const expected = platform === 'x' ? candidate.xPosts! : candidate.linkedinPosts!;
      if (!returned || returned.enabled !== true || canonicalJson(returned.texts) !== canonicalJson(expected)) {
        return null;
      }
    } else if (present) {
      if (!returned || returned.enabled || returned.texts.length > 0) return null;
    }
  }
  if ('draft_title' in payload && payload.draft_title !== (candidate.draftTitle ?? null)) return null;
  if ('draftTitle' in payload && payload.draftTitle !== (candidate.draftTitle ?? null)) return null;
  if (
    'draft_title' in payload
    && 'draftTitle' in payload
    && payload.draft_title !== payload.draftTitle
  ) return null;
  if (
    'scratchpad_text' in payload
    && payload.scratchpad_text !== (candidate.scratchpadText ?? null)
  ) return null;
  if (
    'scratchpadText' in payload
    && payload.scratchpadText !== (candidate.scratchpadText ?? null)
  ) return null;
  if (
    'scratchpad_text' in payload
    && 'scratchpadText' in payload
    && payload.scratchpad_text !== payload.scratchpadText
  ) return null;
  const primaryEditUrl = safeTypefullyEditUrl(payload.private_url);
  const aliasEditUrl = safeTypefullyEditUrl(payload.edit_url);
  if (
    payload.private_url !== undefined
    && payload.edit_url !== undefined
    && primaryEditUrl !== aliasEditUrl
  ) return null;
  const editUrl = primaryEditUrl || aliasEditUrl;
  return editUrl ? { draftId, editUrl } : null;
}

class TypefullySavedDraftExecutor implements CapabilityExecutor {
  readonly effect = TYPEFULLY_EFFECT;
  readonly buildDigest = typefullyMetadata.buildDigest;
  readonly permissionRef = TYPEFULLY_PERMISSION;
  readonly deliveryMode = TYPEFULLY_DELIVERY_MODE;
  private readonly prepared = new Map<string, ResolvedExecution>();
  private secretsClient: SecretsManagerClient | null = null;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly dependencies: TypefullyExecutorDependencies = {}
  ) {}

  render(spec: ProposalSpec): JsonValue {
    return renderTypefullySpec(spec);
  }

  async preflight(request: ExecutorPreflightRequest): Promise<ExecutorPreflightResult> {
    const env = this.dependencies.env || process.env;
    if (!parseConversationalRolloutSnapshot(env).eligibility.typefullyApprovalAndDispatch) {
      return { kind: 'failed_safe', reasonCode: 'typefully_execution_disabled' };
    }
    const candidate = candidateFromTypefullySpec(request.spec);
    if (
      !candidate
      || request.attempt.status !== 'executing'
      || !request.attempt.leaseOwner
      || !request.attempt.leaseGeneration
      || !request.attempt.leaseExpiresAt
      || Date.parse(request.attempt.leaseExpiresAt) <= request.now.getTime()
      || request.attempt.dispatchStartedAt
      || request.attempt.permissionRef !== request.spec.permissionRef
      || request.attempt.permissionRevision !== request.spec.permissionRevision
      || request.attempt.resourceKey !== request.spec.resourceKey
      || request.attempt.accountConfigDigest !== request.spec.accountConfigDigest
      || request.attempt.accountScopeDigest !== request.spec.accountScopeDigest
      || request.attempt.deliveryModeDigest !== request.spec.deliveryModeDigest
      || request.attempt.actorId !== request.spec.actorId
      || request.attempt.conversationId !== request.spec.conversationId
      || request.attempt.draftRef !== request.spec.draftRef
      || request.attempt.proposalId !== request.spec.proposalId
      || request.attempt.proposalVersion !== request.spec.proposalVersion
      || !request.attempt.actorId
      || !request.attempt.identityChannel
      || !request.attempt.identityChannelUserId
      || !request.attempt.identityBindingId
      || !request.attempt.identityBindingRevision
      || !request.attempt.channelBindingId
      || !request.attempt.channelConversationKey
    ) return { kind: 'failed_safe', reasonCode: 'typefully_preflight_envelope_invalid' };
    const mappings = {
      alexey: positiveInteger(env.TYPEFULLY_SOCIAL_SET_ALEXEY),
      datatalksclub: positiveInteger(env.TYPEFULLY_SOCIAL_SET_DATATALKSCLUB),
    };
    const baseUrl = normalizeBaseUrl(env.TYPEFULLY_BASE_URL);
    const revision = env.TYPEFULLY_ACCOUNT_CONFIG_REVISION;
    if (!mappings.alexey || !mappings.datatalksclub || !baseUrl || !revision) {
      return { kind: 'failed_safe', reasonCode: 'typefully_account_mapping_unavailable' };
    }
    const computedDigest = typefullyAccountConfigDigest(
      revision,
      mappings as Record<TypefullyAccount, number>,
      baseUrl
    );
    if (
      request.spec.accountConfigDigest !== computedDigest
      || env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST !== computedDigest
    ) return { kind: 'failed_safe', reasonCode: 'typefully_account_config_drift' };
    const permission = await getApprovalPermission(
      this.client,
      request.attempt.actorId!,
      TYPEFULLY_PERMISSION
    );
    if (
      !permission?.enabled
      || permission.revision !== request.attempt.permissionRevision
      || permission.accountConfigDigest !== computedDigest
      || permission.accountScopeDigest !== request.spec.accountScopeDigest
      || permission.accountScopeDigest !== approvalScopeDigest(permission.allowedResourceKeys || [])
      || permission.deliveryModeDigest !== TYPEFULLY_DELIVERY_MODE_DIGEST
      || !permission.allowedResourceKeys?.includes(typefullyResourceKey(candidate.account))
    ) return { kind: 'failed_safe', reasonCode: 'typefully_permission_drift' };
    const dispatchGuard = this.dependencies.publicSourceGuard
      ? await this.dependencies.publicSourceGuard(request, candidate)
      : await this.currentPublicSourceGuard(request, candidate);
    if (!dispatchGuard) {
      return { kind: 'failed_safe', reasonCode: 'typefully_public_source_drift' };
    }
    const secretId = env.TYPEFULLY_API_KEY_SECRET_NAME;
    if (!secretId || !/^arn:[a-z0-9-]+:secretsmanager:[^:]+:\d{12}:secret:.+$/i.test(secretId)) {
      return { kind: 'failed_safe', reasonCode: 'typefully_secret_unavailable' };
    }
    const rawSecret = await this.loadSecret(secretId);
    const token = this.tokenFromSecret(rawSecret);
    if (!token) return { kind: 'failed_safe', reasonCode: 'typefully_secret_unavailable' };
    this.prepared.set(request.attempt.id, {
      token,
      socialSetId: mappings[candidate.account]!,
      baseUrl,
      candidate,
    });
    return { kind: 'ready', dispatchGuard };
  }

  private async currentPublicSourceGuard(
    request: ExecutorPreflightRequest,
    candidate: TypefullyCandidate
  ): Promise<DispatchStateGuard | null> {
    try {
      const proposal = await getProposalVersion(
        this.client,
        request.attempt.proposalId,
        request.attempt.proposalVersion
      );
      if (
        !proposal?.draftId
        || proposal.conversationId !== request.attempt.conversationId
        || proposal.actorId !== request.attempt.actorId
        || proposal.proposalId !== request.spec.proposalId
        || proposal.version !== request.spec.proposalVersion
        || proposal.draftId !== request.spec.draftRef
        || proposal.canonicalPayloadHash !== request.attempt.canonicalPayloadHash
      ) return null;
      const draft = await getPluginDraft(
        this.client,
        request.attempt.conversationId,
        proposal.draftId,
        request.attempt.actorId!,
        request.now
      );
      const data = object(draft?.data);
      const proofBundle = object(data?.proof);
      const proofs = Array.isArray(proofBundle?.proofs)
        ? proofBundle.proofs.map((proof) => object(proof))
        : [];
      if (
        !draft
        || draft.pluginId !== 'typefully'
        || draft.pluginBuild !== typefullyMetadata.buildDigest
        || data?.kind !== 'typefully_candidate_with_source_grant'
        || canonicalJson(validateTypefullyCandidate(data.candidate))
          !== canonicalJson(candidate)
        || proofBundle?.kind !== 'typefully_public_source_grants'
        || proofs.length < 1
        || proofs.length > 8
        || request.spec.sourceRefs.length !== proofs.length
      ) return null;
      const payloads: Array<{ id: string; content: JsonValue }> = [];
      for (let index = 0; index < proofs.length; index += 1) {
        const proof = proofs[index];
        const sourceRef = request.spec.sourceRefs[index];
        if (
          !proof
          || proof.kind !== 'typefully_public_source_grant'
          || proof.actorId !== request.attempt.actorId
          || proof.classification !== 'public'
          || proof.policyDigest !== TYPEFULLY_POLICY_DIGEST
          || typeof proof.payloadRef !== 'string'
          || typeof proof.sourceDigest !== 'string'
          || !/^sha256:[a-f0-9]{64}$/.test(proof.sourceDigest)
          || !Number.isSafeInteger(proof.sourceRevision)
          || Number(proof.sourceRevision) < 1
          || !Number.isSafeInteger(proof.confirmationRevision)
          || Number(proof.confirmationRevision) < 1
          || sourceRef?.ref !== `public-source:${proof.sourceDigest}`
          || sourceRef.revision !== `${TYPEFULLY_POLICY_DIGEST}:${proof.confirmationRevision}`
        ) return null;
        const payload = await getConversationalPrivatePayload(
          this.client,
          request.attempt.conversationId,
          proof.payloadRef,
          request.attempt.actorId!,
          request.now
        );
        const content = object(payload?.content);
        if (!(
          payload
          && payload.classification === 'private'
          && typeof content?.text === 'string'
          && sha256(content.text.normalize('NFKC').trim()) === proof.sourceDigest
        )) return null;
        payloads.push({ id: proof.payloadRef, content: payload.content });
      }
      return {
        kind: 'typefully_public_source',
        conversationId: request.attempt.conversationId,
        actorId: request.attempt.actorId!,
        draftId: proposal.draftId,
        draftRevision: draft.revision,
        draftData: draft.data,
        pluginBuild: draft.pluginBuild,
        payloads,
      };
    } catch {
      return null;
    }
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const prepared = this.prepared.get(request.attemptId);
    this.prepared.delete(request.attemptId);
    const candidate = candidateFromTypefullySpec(request.spec);
    if (!prepared || !candidate || canonicalJson(candidate) !== canonicalJson(prepared.candidate)) {
      throw new Error('typefully_preflight_not_current');
    }
    const body = serializeTypefullyRequest(request.spec);
    let response: Response;
    try {
      response = await (this.dependencies.fetcher || fetch)(
        `${prepared.baseUrl}/v2/social-sets/${prepared.socialSetId}/drafts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${prepared.token}`,
          },
          body: canonicalJson(body),
          signal: request.signal,
        }
      );
    } catch {
      throw new Error('typefully_transport_unknown');
    }
    const payload = await readBoundedBody(response);
    if (DEFINITIVE_REJECTIONS.has(response.status)) {
      return { outcome: 'failed_safe', reasonCode: `typefully_rejected_${response.status}` };
    }
    if (response.status !== 201) throw new Error('typefully_response_unknown');
    const result = validateSuccess(payload, candidate, prepared.socialSetId);
    if (!result) throw new Error('typefully_success_mismatch');
    const now = (this.dependencies.now || (() => new Date()))().toISOString();
    const effectHash = sha256(canonicalJson({
      draftId: result.draftId,
      account: candidate.account,
      platforms: candidate.platforms,
      payload: candidate,
    }));
    return {
      outcome: 'succeeded',
      receipt: {
        receiptId: `typefully-${sha256(result.draftId).slice(7, 39)}`,
        effectHash,
        recordedAt: now,
        metadata: {
          draftId: result.draftId,
          logicalAccount: candidate.account,
          platforms: candidate.platforms.join(','),
          payloadHash: sha256(canonicalJson(candidate)),
          responseClassification: 'validated_201_saved_draft',
          status: 'draft',
        },
      },
      privateResult: {
        kind: 'typefully_saved_draft',
        message: 'Typefully saved draft created. It is unscheduled, unpublished, and unshared. Scheduling and publication remain manual in Typefully.',
        editUrl: result.editUrl,
      },
    };
  }

  private async loadSecret(secretId: string): Promise<string | null> {
    try {
      if (this.dependencies.secretLoader) return await this.dependencies.secretLoader(secretId);
      this.secretsClient ||= new SecretsManagerClient({});
      const result = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
      return result.SecretString
        || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf8') : null);
    } catch {
      return null;
    }
  }

  private tokenFromSecret(raw: string | null): string | null {
    if (!raw || Buffer.byteLength(raw, 'utf8') > 16_384) return null;
    let token = raw.trim();
    if (token.startsWith('{')) {
      try {
        const parsed = JSON.parse(token);
        token = typeof parsed.apiKey === 'string'
          ? parsed.apiKey.trim()
          : typeof parsed.token === 'string' ? parsed.token.trim() : '';
      } catch {
        return null;
      }
    }
    return token && Buffer.byteLength(token, 'utf8') <= 8_192 ? token : null;
  }
}

export {
  DEFAULT_TYPEFULLY_BASE_URL,
  TypefullySavedDraftExecutor,
  serializeTypefullyRequest,
  typefullyAccountConfigDigest,
  validateSuccess,
};
export type {
  TypefullyCreateRequest,
  TypefullyExecutorDependencies,
};
