import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { approvalScopeDigest } from '../src/conversation/executionRepository';
import {
  canonicalProposalSpec,
  proposalHashesAreValid,
  renderDeterministically,
  sha256,
} from '../src/conversation/execution';
import {
  TypefullyProposalAdapter,
} from '../src/conversation/proposalCoordinator';
import {
  TypefullySavedDraftExecutor,
  serializeTypefullyRequest,
  typefullyAccountConfigDigest,
  validateSuccess,
} from '../src/conversation/typefullyExecutor';
import {
  TYPEFULLY_DELIVERY_MODE,
  TYPEFULLY_DELIVERY_MODE_DIGEST,
  TYPEFULLY_EFFECT,
  TYPEFULLY_PERMISSION,
  TYPEFULLY_POLICY_DIGEST,
  typefullyMetadata,
  validateTypefullyCandidate,
  validateTypefullyProposalInput,
} from '../src/conversation/typefullyPlugin';
import {
  expiryFrom,
  type ExecutionAttempt,
  type PluginDraft,
  type ProposalSpec,
  type ProposalVersion,
} from '../src/conversation/types';
import { CONVERSATIONAL_ENTITY_SPECS } from '../src/conversation/portable';
import {
  TypefullyProposalRenderExecutor,
  candidateFromTypefullySpec,
  renderTypefullySpec,
  typefullyImmutableBindingDigest,
} from '../src/conversation/typefullySpec';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const CONFIG_REVISION = 'sandbox-v1';
const BASE_URL = 'https://api.typefully.test';
const MAPPINGS = { alexey: 188312, datatalksclub: 182343 };
const CONFIG_DIGEST = typefullyAccountConfigDigest(CONFIG_REVISION, MAPPINGS, BASE_URL);
const SCOPE_DIGEST = approvalScopeDigest(['typefully:account:alexey']);
const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:typefully-test';
const publicSourceGuard = async () => ({
  kind: 'typefully_public_source' as const,
  conversationId: 'conversation-typefully',
  actorId: 'operator-1',
  draftId: 'draft-typefully',
  draftRevision: 1,
  draftData: {},
  pluginBuild: typefullyMetadata.buildDigest,
  payloadId: 'payload-typefully',
  payloadContent: {},
});

const candidate = {
  account: 'alexey' as const,
  platforms: ['x', 'linkedin'] as const,
  xPosts: ['First X post', 'Second X post'],
  linkedinPosts: ['LinkedIn post'],
  draftTitle: 'Draft title',
  scratchpadText: 'Private working note',
};

function spec(overrides: Partial<ProposalSpec> = {}): ProposalSpec {
  return {
    pluginId: 'typefully',
    pluginBuildDigest: typefullyMetadata.buildDigest,
    schemaDigest: typefullyMetadata.schemaDigest,
    policyDigest: TYPEFULLY_POLICY_DIGEST,
    action: 'propose_draft',
    operation: 'create',
    effect: TYPEFULLY_EFFECT,
    destinationRef: 'typefully.saved_drafts',
    proposedContent: candidate,
    sourceRefs: [{
      ref: `public-source:sha256:${'1'.repeat(64)}`,
      revision: `${TYPEFULLY_POLICY_DIGEST}:4`,
      classification: 'public',
    }],
    permissionRef: TYPEFULLY_PERMISSION,
    permissionRevision: 7,
    actorId: 'operator-1',
    conversationId: 'conversation-typefully',
    draftRef: 'draft-1',
    proposalId: 'proposal-typefully',
    proposalVersion: 1,
    resourceKey: 'typefully:account:alexey',
    accountConfigDigest: CONFIG_DIGEST,
    accountScopeDigest: SCOPE_DIGEST,
    deliveryMode: TYPEFULLY_DELIVERY_MODE,
    deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
    expiresAt: '2026-07-30T12:30:00.000Z',
    ...overrides,
  };
}

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    id: 'attempt-typefully-1',
    recordType: 'execution_attempt',
    schemaVersion: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...expiryFrom(NOW.toISOString(), 365),
    proposalId: 'proposal-typefully',
    proposalVersion: 1,
    conversationId: 'conversation-typefully',
    status: 'executing',
    deliveryMode: TYPEFULLY_DELIVERY_MODE,
    actorId: 'operator-1',
    identityChannel: 'telegram',
    identityChannelUserId: 'operator-channel-1',
    identityBindingId: 'identity-1',
    identityBindingRevision: 1,
    channelBindingId: 'channel-1',
    channelConversationKey: 'operator-channel-1',
    permissionRef: TYPEFULLY_PERMISSION,
    permissionRevision: 7,
    resourceKey: 'typefully:account:alexey',
    accountConfigDigest: CONFIG_DIGEST,
    accountScopeDigest: SCOPE_DIGEST,
    deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
    draftRef: 'draft-1',
    canonicalPayloadHash: `sha256:${'3'.repeat(64)}`,
    renderedViewHash: `sha256:${'4'.repeat(64)}`,
    executorBuildDigest: typefullyMetadata.buildDigest,
    attemptNumber: 1,
    readyAt: NOW.toISOString(),
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-07-30T12:01:00.000Z',
    leaseGeneration: 1,
    recoveryBlocked: false,
    revision: 2,
    ...overrides,
  };
}

function permissionClient(overrides: Record<string, unknown> = {}): DynamoDBDocumentClient {
  return {
    async send() {
      return {
        Item: {
          userId: 'operator-1',
          permissionRef: TYPEFULLY_PERMISSION,
          enabled: true,
          revision: 7,
          allowedResourceKeys: ['typefully:account:alexey'],
          accountScopeDigest: SCOPE_DIGEST,
          accountConfigDigest: CONFIG_DIGEST,
          deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
          ...overrides,
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
}

function env(enabled = true): NodeJS.ProcessEnv {
  return {
    CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
    CONVERSATIONAL_EXECUTION_ENABLED: enabled ? 'true' : 'false',
    CONVERSATIONAL_ENABLED_PLUGINS: 'typefully',
    CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: enabled ? 'true' : 'false',
    CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
    CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST: CONFIG_DIGEST,
    TYPEFULLY_ACCOUNT_CONFIG_REVISION: CONFIG_REVISION,
    TYPEFULLY_BASE_URL: BASE_URL,
    TYPEFULLY_API_KEY_SECRET_NAME: SECRET_ARN,
    TYPEFULLY_SOCIAL_SET_ALEXEY: String(MAPPINGS.alexey),
    TYPEFULLY_SOCIAL_SET_DATATALKSCLUB: String(MAPPINGS.datatalksclub),
  };
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-123',
    social_set_id: MAPPINGS.alexey,
    status: 'draft',
    publish_state: null,
    scheduled_date: null,
    published_at: null,
    share_url: null,
    private_url: 'https://typefully.com/?d=draft-123',
    draft_title: candidate.draftTitle,
    scratchpad_text: candidate.scratchpadText,
    platforms: {
      x: {
        enabled: true,
        posts: candidate.xPosts.map((text) => ({ text, published_url: null })),
      },
      linkedin: {
        enabled: true,
        posts: candidate.linkedinPosts.map((text) => ({ text, published_url: null })),
      },
    },
    ...overrides,
  };
}

describe('Typefully exact candidate and proposal adapter', () => {
  it('accepts exact boundary shape without truncation and rejects every lossy variant', () => {
    assert.deepStrictEqual(validateTypefullyCandidate(candidate), candidate);
    assert.strictEqual(
      validateTypefullyProposalInput('propose_draft', candidate).kind,
      'proposal_candidate'
    );
    assert.notStrictEqual(
      validateTypefullyCandidate({ ...candidate, xPosts: ['😀'.repeat(4_000)] }),
      null
    );
    assert.deepStrictEqual(
      validateTypefullyCandidate({ ...candidate, xPosts: ['  Ａ  '] }),
      { ...candidate, xPosts: ['A'] }
    );
    assert.notEqual(validateTypefullyCandidate({
      account: 'alexey',
      platforms: ['x', 'linkedin'],
      xPosts: Array.from({ length: 25 }, (_, index) => `bounded-x-${index}`),
      linkedinPosts: ['l'.repeat(8_000)],
      draftTitle: 't'.repeat(120),
      scratchpadText: 's'.repeat(1_000),
    }), null);
    const invalid: unknown[] = [
      { ...candidate, account: undefined },
      { ...candidate, account: 'unknown' },
      { ...candidate, platforms: [] },
      { ...candidate, platforms: ['mastodon'] },
      { ...candidate, xPosts: undefined },
      { ...candidate, xPosts: [] },
      { ...candidate, xPosts: 'not-an-array' },
      { ...candidate, xPosts: [{ text: 'object' }] },
      { ...candidate, xPosts: ['ascii\u001fcontrol'] },
      { ...candidate, draftTitle: '   ' },
      { ...candidate, scratchpadText: '' },
      { ...candidate, extra: true },
      { ...candidate, xPosts: Array.from({ length: 26 }, (_, index) => `x-${index}`) },
      { ...candidate, linkedinPosts: ['linkedin-one', 'linkedin-two'] },
      { ...candidate, xPosts: ['x'.repeat(4_001)] },
      { ...candidate, linkedinPosts: ['x'.repeat(8_001)] },
      { ...candidate, draftTitle: 'x'.repeat(121) },
      { ...candidate, scratchpadText: 'x'.repeat(1_001) },
      { ...candidate, platforms: ['x'], linkedinPosts: ['unexpected'] },
      { ...candidate, platforms: ['linkedin'], xPosts: ['unexpected'] },
      { ...candidate, platforms: ['x', 'x'] },
      { ...candidate, xPosts: ['duplicate', 'duplicate'] },
      { ...candidate, xPosts: ['zero\u200bwidth'] },
      { ...candidate, xPosts: ['\ud800'] },
      { ...candidate, nested: { publish_at: 'now' } },
      { ...candidate, targetDraftId: 'old-draft' },
      { ...candidate, sourceRefs: ['model-must-not-supply-refs'] },
      { ...candidate, classification: 'public' },
      {
        ...candidate,
        platforms: ['x'],
        linkedinPosts: undefined,
        xPosts: Array.from(
          { length: 25 },
          (_, index) => `${String(index).padStart(2, '0')}-${'x'.repeat(3_997)}`
        ),
      },
    ];
    for (const value of invalid) assert.strictEqual(validateTypefullyCandidate(value), null);
    const tooManySources = Array.from({ length: 9 }, (_, index) => ({
      ref: `public-source:sha256:${index.toString(16).padStart(64, '0')}`,
      revision: `${TYPEFULLY_POLICY_DIGEST}:1`,
      classification: 'public',
    }));
    assert.equal(candidateFromTypefullySpec(spec({
      sourceRefs: tooManySources,
    })), null);
    for (const sourceRefs of [
      [],
      [tooManySources[0], tooManySources[0]],
      [{ ...tooManySources[0], classification: 'private' }],
      [{ ...tooManySources[0], ref: 'private-source:1' }],
      [{ ...tooManySources[0], revision: 'bad-revision' }],
    ]) assert.equal(candidateFromTypefullySpec(spec({
      sourceRefs,
    })), null);
  });

  it('binds scope/config/delivery/source proof and renders every approved field', () => {
    const adapter = new TypefullyProposalAdapter();
    const draft: PluginDraft = {
      id: 'draft-1',
      recordType: 'plugin_draft',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: 'conversation-typefully',
      pluginId: 'typefully',
      pluginBuild: typefullyMetadata.buildDigest,
      status: 'ready',
      data: {
        kind: 'typefully_candidate_with_source_grant',
        candidate,
        proof: {
          kind: 'typefully_public_source_grant',
          actorId: 'operator-1',
          payloadRef: 'private-source-1',
          sourceDigest: `sha256:${'1'.repeat(64)}`,
          classification: 'public',
          policyDigest: TYPEFULLY_POLICY_DIGEST,
          sourceRevision: 3,
          confirmationRevision: 4,
        },
      },
      revision: 2,
    };
    const beforeDigest = process.env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST;
    process.env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST = CONFIG_DIGEST;
    try {
      const built = adapter.buildSpec(candidate, {
        actorId: 'operator-1',
        conversationId: draft.conversationId,
        draft,
        proposalId: 'proposal-typefully',
        proposalVersion: 1,
        permission: {
          userId: 'operator-1',
          permissionRef: TYPEFULLY_PERMISSION,
          enabled: true,
          revision: 7,
          allowedResourceKeys: ['typefully:account:alexey'],
          accountScopeDigest: SCOPE_DIGEST,
          accountConfigDigest: CONFIG_DIGEST,
          deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
        },
        permissionRevision: 7,
        expiresAt: '2026-07-30T12:30:00.000Z',
      });
      assert.strictEqual(built.resourceKey, 'typefully:account:alexey');
      assert.strictEqual(built.accountConfigDigest, CONFIG_DIGEST);
      assert.strictEqual(built.deliveryMode, TYPEFULLY_DELIVERY_MODE);
      assert.deepStrictEqual(built.proposedContent, candidate);
      assert.ok(built.sourceRefs.every((source) => source.classification === 'public'));
      assert.throws(() => adapter.buildSpec({
        ...candidate,
        account: 'datatalksclub',
      }, {
        actorId: 'operator-1',
        conversationId: draft.conversationId,
        draft,
        proposalId: 'proposal-unauthorized-account',
        proposalVersion: 1,
        permission: {
          userId: 'operator-1',
          permissionRef: TYPEFULLY_PERMISSION,
          enabled: true,
          revision: 7,
          allowedResourceKeys: ['typefully:account:alexey'],
          accountScopeDigest: SCOPE_DIGEST,
          accountConfigDigest: CONFIG_DIGEST,
          deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
        },
        permissionRevision: 7,
        expiresAt: '2026-07-30T12:30:00.000Z',
      }), /authorization|scope/i);
      const preview = adapter.presentation(candidate).message;
      for (const text of [
        ...candidate.xPosts,
        ...candidate.linkedinPosts,
        candidate.draftTitle,
        candidate.scratchpadText,
        candidate.account,
        TYPEFULLY_DELIVERY_MODE,
        'unscheduled, unpublished, unshared',
      ]) assert.match(preview, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      if (beforeDigest === undefined) delete process.env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST;
      else process.env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST = beforeDigest;
    }
  });

  it('exports only safe hashes instead of Typefully copy, edit URLs, or Telegram bindings', () => {
    const map = (name: string, value: Record<string, unknown>) => {
      const entity = CONVERSATIONAL_ENTITY_SPECS.find((entry) => entry.name === name);
      assert.ok(entity);
      return entity!.map(value);
    };
    const rawCopy = 'portable-social-copy-sentinel';
    const rawUrl = 'https://typefully.com/?d=portable-private-draft';
    const telegramId = 'telegram-binding-sentinel';
    const exported = [
      map('plugin_drafts', {
        recordType: 'plugin_draft',
        pluginId: 'typefully',
        data: { candidate: { xPosts: [rawCopy] } },
      }),
      map('proposal_versions', {
        recordType: 'proposal_version',
        spec: { pluginId: 'typefully', proposedContent: { xPosts: [rawCopy] } },
      }),
      map('conversational_private_payloads', {
        recordType: 'conversational_private_payload',
        content: {
          kind: 'execution_result',
          result: { kind: 'typefully_saved_draft', editUrl: rawUrl },
        },
      }),
      map('execution_attempts', {
        recordType: 'execution_attempt',
        identityChannel: 'telegram',
        identityChannelUserId: telegramId,
        identityBindingId: telegramId,
        channelBindingId: telegramId,
        channelConversationKey: telegramId,
      }),
      map('conversation_events', {
        recordType: 'conversation_event',
        channel: 'telegram',
        idempotencyKey: `telegram:${telegramId}:message`,
        provenance: `telegram-update:${telegramId}`,
      }),
    ];
    const serialized = JSON.stringify(exported);
    assert.doesNotMatch(serialized, new RegExp(rawCopy));
    assert.doesNotMatch(serialized, /typefully\.com/);
    assert.doesNotMatch(serialized, new RegExp(telegramId));
    assert.match(serialized, /sha256:[a-f0-9]{64}/);
  });

  it('rejects malformed immutable binding fields at stored-spec load', () => {
    assert.equal(candidateFromTypefullySpec(spec({ expiresAt: 'invalid-expiry' })), null);
    for (const field of ['actorId', 'conversationId', 'draftRef', 'proposalId'] as const) {
      assert.equal(candidateFromTypefullySpec(spec({ [field]: '' })), null);
    }
    assert.equal(candidateFromTypefullySpec(spec({ proposalVersion: 0 })), null);
  });

  it('binds every immutable spec field into the rendered view and rejects one-field tampering', () => {
    const baseSpec = spec();
    const executor = new TypefullyProposalRenderExecutor();
    const baseRender = renderDeterministically(executor, baseSpec);
    const directRender = renderTypefullySpec(baseSpec) as Record<string, unknown>;
    const directBinding = directRender.binding as Record<string, unknown>;
    assert.equal(directBinding.immutableSpecDigest, typefullyImmutableBindingDigest(baseSpec));
    assert.doesNotMatch(
      JSON.stringify(directRender),
      /188312|182343|worker-only-token|transaction-worker-token/
    );
    const baseProposal = {
      spec: baseSpec,
      canonicalPayloadHash: sha256(canonicalProposalSpec(baseSpec)),
      renderedViewHash: baseRender.hash,
    } as ProposalVersion;
    const mutateContent = (field: string, value: unknown) => (changed: ProposalSpec) => {
      changed.proposedContent = {
        ...(changed.proposedContent as Record<string, unknown>),
        [field]: value,
      } as ProposalSpec['proposedContent'];
    };
    const mutations: Array<[string, (changed: ProposalSpec) => void]> = [
      ['pluginId', (changed) => { changed.pluginId = 'tampered-plugin'; }],
      ['action', (changed) => { changed.action = 'tampered_action'; }],
      ['operation', (changed) => { changed.operation = 'update'; }],
      ['effect', (changed) => { changed.effect = 'typefully.saved_draft.update'; }],
      ['destinationRef', (changed) => { changed.destinationRef = 'typefully.other'; }],
      ['pluginBuildDigest', (changed) => { changed.pluginBuildDigest = `sha256:${'a'.repeat(64)}`; }],
      ['schemaDigest', (changed) => { changed.schemaDigest = `sha256:${'b'.repeat(64)}`; }],
      ['policyDigest', (changed) => { changed.policyDigest = `sha256:${'c'.repeat(64)}`; }],
      ['permissionRef', (changed) => { changed.permissionRef = 'todo:create:self'; }],
      ['permissionRevision', (changed) => { changed.permissionRevision = 8; }],
      ['resourceKey', (changed) => { changed.resourceKey = 'typefully:account:datatalksclub'; }],
      ['accountConfigDigest', (changed) => { changed.accountConfigDigest = `sha256:${'d'.repeat(64)}`; }],
      ['accountScopeDigest', (changed) => { changed.accountScopeDigest = `sha256:${'e'.repeat(64)}`; }],
      ['deliveryMode', (changed) => { changed.deliveryMode = 'provider_idempotency'; }],
      ['deliveryModeDigest', (changed) => { changed.deliveryModeDigest = `sha256:${'f'.repeat(64)}`; }],
      ['actorId', (changed) => { changed.actorId = 'operator-2'; }],
      ['conversationId', (changed) => { changed.conversationId = 'conversation-other'; }],
      ['draftRef', (changed) => { changed.draftRef = 'draft-other'; }],
      ['proposalId', (changed) => { changed.proposalId = 'proposal-other'; }],
      ['proposalVersion', (changed) => { changed.proposalVersion = 2; }],
      ['expiresAt', (changed) => { changed.expiresAt = '2026-07-30T12:31:00.000Z'; }],
      ['content.account', mutateContent('account', 'datatalksclub')],
      ['content.platforms', mutateContent('platforms', ['x'])],
      ['content.xPosts', mutateContent('xPosts', ['Changed X post'])],
      ['content.linkedinPosts', mutateContent('linkedinPosts', ['Changed LinkedIn post'])],
      ['content.draftTitle', mutateContent('draftTitle', 'Changed title')],
      ['content.scratchpadText', mutateContent('scratchpadText', 'Changed scratchpad')],
      ['sourceRefs.ref', (changed) => {
        changed.sourceRefs[0].ref = `public-source:sha256:${'2'.repeat(64)}`;
      }],
      ['sourceRefs.revision', (changed) => {
        changed.sourceRefs[0].revision = `${TYPEFULLY_POLICY_DIGEST}:5`;
      }],
      ['sourceRefs.classification', (changed) => {
        changed.sourceRefs[0].classification = 'private';
      }],
    ];
    for (const [field, mutate] of mutations) {
      const changed = structuredClone(baseSpec);
      mutate(changed);
      assert.notEqual(
        typefullyImmutableBindingDigest(changed),
        typefullyImmutableBindingDigest(baseSpec),
        `${field} must change the immutable render binding`
      );
      const tamperedProposal = {
        ...baseProposal,
        spec: changed,
        canonicalPayloadHash: sha256(canonicalProposalSpec(changed)),
      };
      assert.equal(
        proposalHashesAreValid(tamperedProposal, executor),
        false,
        `${field} tamper must fail approval-time presentation validation`
      );
      if (candidateFromTypefullySpec(changed)) {
        assert.notEqual(
          renderDeterministically(executor, changed).hash,
          baseRender.hash,
          `${field} must change renderedViewHash`
        );
        assert.notDeepEqual(renderTypefullySpec(changed), directRender);
      } else {
        assert.throws(() => renderTypefullySpec(changed), /typefully_spec_invalid/);
      }
    }
  });
});

describe('Typefully worker-only preflight and exact one-call classifier', () => {
  it('serializes byte-exact selected content and no forbidden effect field', () => {
    const request = serializeTypefullyRequest(spec());
    assert.deepStrictEqual(request, {
      draft_title: candidate.draftTitle,
      scratchpad_text: candidate.scratchpadText,
      share: false,
      platforms: {
        x: { enabled: true, posts: candidate.xPosts.map((text) => ({ text })) },
        linkedin: {
          enabled: true,
          posts: candidate.linkedinPosts.map((text) => ({ text })),
        },
      },
    });
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /publish_at|schedule|media|target|draft_id|social_set/i);
  });

  it('fails safely before dispatch when disabled, drifted, unmapped, or secretless', async () => {
    const cases = [
      { env: env(false), client: permissionClient(), secret: 'token' },
      { env: { ...env(), TYPEFULLY_SOCIAL_SET_ALEXEY: '0' }, client: permissionClient(), secret: 'token' },
      { env: { ...env(), TYPEFULLY_SOCIAL_SET_ALEXEY: String(MAPPINGS.alexey + 1) }, client: permissionClient(), secret: 'token' },
      { env: { ...env(), TYPEFULLY_ACCOUNT_CONFIG_REVISION: 'drifted-v2' }, client: permissionClient(), secret: 'token' },
      { env: { ...env(), TYPEFULLY_BASE_URL: 'https://drifted.typefully.test' }, client: permissionClient(), secret: 'token' },
      { env: env(), client: permissionClient({ revision: 8 }), secret: 'token' },
      { env: env(), client: permissionClient({ accountConfigDigest: `sha256:${'8'.repeat(64)}` }), secret: 'token' },
      { env: env(), client: permissionClient({ accountScopeDigest: `sha256:${'8'.repeat(64)}` }), secret: 'token' },
      { env: env(), client: permissionClient({ deliveryModeDigest: `sha256:${'8'.repeat(64)}` }), secret: 'token' },
      { env: env(), client: permissionClient(), secret: null },
      { env: env(), client: permissionClient(), secret: '{malformed' },
      { env: env(), client: permissionClient(), secret: JSON.stringify({ unrelated: 'value' }) },
      { env: env(), client: permissionClient(), secret: 'x'.repeat(8_193) },
    ];
    for (const entry of cases) {
      let providerCalls = 0;
      const executor = new TypefullySavedDraftExecutor(entry.client, {
        env: entry.env,
        publicSourceGuard,
        secretLoader: async () => entry.secret,
        fetcher: (async () => {
          providerCalls += 1;
          throw new Error('must not dispatch');
        }) as typeof fetch,
      });
      const result = await executor.preflight({ spec: spec(), attempt: attempt(), now: NOW });
      assert.strictEqual(result.kind, 'failed_safe');
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(attempt().dispatchStartedAt, undefined);
    }
    const unreadableSecret = new TypefullySavedDraftExecutor(permissionClient(), {
      env: env(),
      publicSourceGuard,
      secretLoader: async () => {
        throw new Error('secret manager unavailable');
      },
      fetcher: (async () => {
        throw new Error('must not dispatch');
      }) as typeof fetch,
    });
    assert.deepStrictEqual(
      await unreadableSecret.preflight({ spec: spec(), attempt: attempt(), now: NOW }),
      { kind: 'failed_safe', reasonCode: 'typefully_secret_unavailable' }
    );
    const executor = new TypefullySavedDraftExecutor(permissionClient(), {
      env: env(),
      publicSourceGuard,
      secretLoader: async () => 'token',
      fetcher: (async () => {
        throw new Error('must not dispatch');
      }) as typeof fetch,
    });
    for (const missing of [
      'resourceKey',
      'accountConfigDigest',
      'accountScopeDigest',
      'deliveryModeDigest',
    ] as const) {
      assert.strictEqual(
        (await executor.preflight({
          spec: spec(),
          attempt: attempt({ [missing]: undefined }),
          now: NOW,
        })).kind,
        'failed_safe'
      );
    }
    for (const changed of [
      spec({ actorId: 'other-actor' }),
      spec({ conversationId: 'other-conversation' }),
      spec({ draftRef: 'other-draft' }),
      spec({ proposalId: 'other-proposal' }),
      spec({ proposalVersion: 2 }),
    ]) {
      assert.strictEqual(
        (await executor.preflight({ spec: changed, attempt: attempt(), now: NOW })).kind,
        'failed_safe'
      );
    }
    assert.strictEqual(
      (await executor.preflight({
        spec: spec(),
        attempt: attempt({ leaseExpiresAt: NOW.toISOString() }),
        now: NOW,
      })).kind,
      'failed_safe'
    );
  });

  it('enforces Alexey, DataTalksClub, both-account, and neither-account scopes', async () => {
    const dtcCandidate = {
      ...candidate,
      account: 'datatalksclub' as const,
    };
    for (const testCase of [
      {
        name: 'alexey',
        candidate,
        allowed: ['typefully:account:alexey'],
        expected: 'ready',
      },
      {
        name: 'datatalksclub',
        candidate: dtcCandidate,
        allowed: ['typefully:account:datatalksclub'],
        expected: 'ready',
      },
      {
        name: 'both',
        candidate,
        allowed: ['typefully:account:alexey', 'typefully:account:datatalksclub'],
        expected: 'ready',
      },
      {
        name: 'neither',
        candidate,
        allowed: [],
        expected: 'failed_safe',
      },
    ]) {
      const scopeDigest = approvalScopeDigest(testCase.allowed);
      const resourceKey = `typefully:account:${testCase.candidate.account}`;
      const scopedSpec = spec({
        proposedContent: testCase.candidate,
        resourceKey,
        accountScopeDigest: scopeDigest,
      });
      const scopedAttempt = attempt({
        resourceKey,
        accountScopeDigest: scopeDigest,
      });
      const executor = new TypefullySavedDraftExecutor(permissionClient({
        allowedResourceKeys: testCase.allowed,
        accountScopeDigest: scopeDigest,
      }), {
        env: env(),
        publicSourceGuard,
        secretLoader: async () => 'token',
      });
      assert.equal(
        (await executor.preflight({
          spec: scopedSpec,
          attempt: scopedAttempt,
          now: NOW,
        })).kind,
        testCase.expected,
        testCase.name
      );
    }
  });

  it('uses one POST, validates exact 201, and keeps the edit URL private', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const executor = new TypefullySavedDraftExecutor(permissionClient(), {
      env: env(),
      publicSourceGuard,
      secretLoader: async (id) => {
        assert.strictEqual(id, SECRET_ARN);
        return JSON.stringify({ apiKey: 'worker-only-token' });
      },
      fetcher: (async (url, init) => {
        requests.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify(successBody()), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
      now: () => NOW,
    });
    assert.strictEqual(
      (await executor.preflight({ spec: spec(), attempt: attempt(), now: NOW })).kind,
      'ready'
    );
    const result = await executor.execute({
      spec: spec(),
      attemptId: attempt().id,
      idempotencyKey: 'ignored-by-operator-reconciliation-only',
      signal: AbortSignal.timeout(1_000),
    });
    assert.strictEqual(result.outcome, 'succeeded');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(
      requests[0].url,
      `${BASE_URL}/v2/social-sets/${MAPPINGS.alexey}/drafts`
    );
    const headers = requests[0].init.headers as Record<string, string>;
    assert.strictEqual(headers.Authorization, 'Bearer worker-only-token');
    assert.ok(!('Idempotency-Key' in headers));
    assert.deepStrictEqual(JSON.parse(String(requests[0].init.body)), serializeTypefullyRequest(spec()));
    if (result.outcome === 'succeeded') {
      assert.doesNotMatch(JSON.stringify(result.receipt), /typefully\.com|worker-only-token|188312/);
      assert.match(JSON.stringify(result.privateResult), /https:\/\/typefully\.com/);
    }
  });

  it('classifies documented 4xx safe and every ambiguous/mismatched case unknown by throwing', async () => {
    for (const status of [400, 401, 402, 403, 404, 422, 429]) {
      const executor = new TypefullySavedDraftExecutor(permissionClient(), {
        env: env(),
        publicSourceGuard,
        secretLoader: async () => 'token',
        fetcher: (async () => new Response(JSON.stringify({ error: 'rejected' }), { status })) as typeof fetch,
      });
      assert.strictEqual(
        (await executor.preflight({ spec: spec(), attempt: attempt(), now: NOW })).kind,
        'ready'
      );
      assert.deepStrictEqual(await executor.execute({
        spec: spec(),
        attemptId: attempt().id,
        idempotencyKey: 'unused',
        signal: AbortSignal.timeout(1_000),
      }), { outcome: 'failed_safe', reasonCode: `typefully_rejected_${status}` });
    }
    for (const response of [
      new Response(JSON.stringify(successBody()), { status: 200 }),
      new Response(JSON.stringify(successBody()), { status: 202 }),
      new Response(JSON.stringify({ error: 'server' }), { status: 500 }),
      new Response(JSON.stringify({ error: 'unlisted' }), { status: 418 }),
      new Response(JSON.stringify({ oversized: 'x'.repeat(65_537) }), { status: 201 }),
      new Response(null, { status: 201 }),
      new Response(JSON.stringify([]), { status: 201 }),
      new Response('{not-json', { status: 201 }),
      new Response(JSON.stringify(successBody({ status: 'published' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ id: undefined })), { status: 201 }),
      new Response(JSON.stringify(successBody({ social_set_id: MAPPINGS.alexey + 1 })), { status: 201 }),
      new Response(JSON.stringify(successBody({ publish_state: undefined })), { status: 201 }),
      new Response(JSON.stringify(successBody({ scheduled_date: '2026-08-01T12:00:00Z' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ published_at: '2026-07-30T12:00:00Z' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ share_url: 'https://typefully.com/shared/draft-123' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ private_url: undefined })), { status: 201 }),
      new Response(JSON.stringify(successBody({ private_url: 'http://typefully.com/?d=draft-123' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ private_url: 'https://example.com/?d=draft-123' })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          linkedin: successBody().platforms.linkedin,
        },
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          ...successBody().platforms,
          x: { enabled: false, posts: candidate.xPosts.map((text) => ({ text, published_url: null })) },
        },
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          ...successBody().platforms,
          x: {
            enabled: true,
            posts: [...candidate.xPosts].reverse().map((text) => ({ text, published_url: null })),
          },
        },
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          ...successBody().platforms,
          x: {
            enabled: true,
            posts: candidate.xPosts.map((text) => ({
              text,
              published_url: 'https://x.com/example/status/1',
            })),
          },
        },
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({ id: 'x'.repeat(201) })), { status: 201 }),
      new Response(JSON.stringify(successBody({ id: 'sk-secret-looking-draft' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ draft_id: 'contradictory-draft' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ socialSetId: MAPPINGS.alexey + 1 })), { status: 201 }),
      new Response(JSON.stringify(successBody({ publishState: 'published' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ draftTitle: 'conflicting title' })), { status: 201 }),
      new Response(JSON.stringify(successBody({ scratchpadText: 'conflicting scratchpad' })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        private_url: 'https://typefully.com/?d=draft-123#access_token=secret',
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        private_url: 'https://typefully.com/credential/draft-123',
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          ...successBody().platforms as object,
          mastodon: { enabled: false, posts: [] },
        },
      })), { status: 201 }),
      new Response(JSON.stringify(successBody({
        platforms: {
          ...successBody().platforms as object,
          x: {
            enabled: true,
            posts: [{
              text: 'changed',
              published_url: null,
              unexpected_publish_effect: true,
            }],
          },
        },
      })), { status: 201 }),
    ]) {
      const executor = new TypefullySavedDraftExecutor(permissionClient(), {
        env: env(),
        publicSourceGuard,
        secretLoader: async () => 'token',
        fetcher: (async () => response) as typeof fetch,
      });
      await executor.preflight({ spec: spec(), attempt: attempt(), now: NOW });
      await assert.rejects(() => executor.execute({
        spec: spec(),
        attemptId: attempt().id,
        idempotencyKey: 'unused',
        signal: AbortSignal.timeout(1_000),
      }));
    }
    for (const transportError of [
      new Error('connection lost'),
      new DOMException('request aborted', 'AbortError'),
      new DOMException('request timed out', 'TimeoutError'),
    ]) {
      const executor = new TypefullySavedDraftExecutor(permissionClient(), {
        env: env(),
        publicSourceGuard,
        secretLoader: async () => 'token',
        fetcher: (async () => {
          throw transportError;
        }) as typeof fetch,
      });
      await executor.preflight({ spec: spec(), attempt: attempt(), now: NOW });
      await assert.rejects(() => executor.execute({
        spec: spec(),
        attemptId: attempt().id,
        idempotencyKey: 'unused',
        signal: AbortSignal.timeout(1_000),
      }));
    }
  });

  it('rejects malformed or effectful unselected known platforms', () => {
    const xOnly = {
      account: 'alexey' as const,
      platforms: ['x'] as const,
      xPosts: ['Only X'],
    };
    const base = {
      id: 'draft-x-only',
      social_set_id: MAPPINGS.alexey,
      status: 'draft',
      publish_state: null,
      private_url: 'https://typefully.com/?d=draft-x-only',
      platforms: {
        x: { enabled: true, posts: [{ text: 'Only X', published_url: null }] },
      },
    };
    assert.ok(validateSuccess(base, xOnly, MAPPINGS.alexey));
    for (const linkedin of [
      { enabled: true, posts: [] },
      { enabled: false, posts: 'not-an-array' },
      { enabled: false, posts: [{ text: 'unexpected' }] },
    ]) {
      assert.equal(validateSuccess({
        ...base,
        platforms: { ...base.platforms, linkedin },
      }, xOnly, MAPPINGS.alexey), null);
    }
  });
});
