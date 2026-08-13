import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, TABLE_CONVERSATIONAL_STATE, TABLE_USERS } from '../src/db/setup';
import { createUserWithId } from '../src/db/users';
import {
  createChannelBinding,
  createConversation,
  createIdentityBinding,
  getConversationalPrivatePayload,
  getExecutionAttempt,
  getPluginDraft,
  getPresentationByTokenHash,
  getResultNotification,
  listProposalVersions,
  putConversationalPrivatePayload,
  savePluginDraft,
} from '../src/conversation/repository';
import {
  approvalScopeDigest,
  claimQueuedAttempt,
  getProposalVersion,
  markDispatchStarted,
  putApprovalPermission,
} from '../src/conversation/executionRepository';
import { ExecutorRegistry, sha256 } from '../src/conversation/execution';
import {
  processAttempt,
  runRecovery,
} from '../src/conversation/executionWorker';
import { conversationalRolloutSnapshot } from '../src/conversation/rollout';
import { dispatchOne, runResultDispatcher } from '../src/conversation/resultDispatcher';
import { ConversationalProposalCore } from '../src/conversation/todoCore';
import { TypefullyProposalAdapter } from '../src/conversation/proposalCoordinator';
import { canonicalJson } from '../src/conversation/pluginRegistry';
import { handleConversationalExecutionRoutes } from '../src/routes/conversationalExecution';
import { TypefullySavedDraftExecutor, typefullyAccountConfigDigest } from '../src/conversation/typefullyExecutor';
import { TypefullyProposalRenderExecutor } from '../src/conversation/typefullySpec';
import {
  TYPEFULLY_ACTION,
  TYPEFULLY_DELIVERY_MODE_DIGEST,
  TYPEFULLY_PERMISSION,
  TYPEFULLY_PLUGIN_ID,
  TYPEFULLY_PUBLIC_CONFIRMATION,
} from '../src/conversation/typefullyPlugin';
import { expiryFrom, type JsonValue } from '../src/conversation/types';
import type {
  ConversationalModel,
  ModelRequest,
  ModelResponse,
} from '../src/conversation/zaiClient';
import type { LambdaEvent } from '../src/types';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const LATER = new Date('2026-07-30T12:02:00.000Z');
const AFTER_BACKOFF = new Date('2026-07-30T12:02:02.000Z');
const AFTER_PRIVATE_RETENTION = new Date('2026-08-31T12:00:00.000Z');
const ACTOR_ID = 'typefully-transaction-operator';
const ADMIN_ID = 'typefully-transaction-admin';
const CONVERSATION_ID = 'typefully-transaction-conversation';
const CHAT_ID = '88001';
const CONFIG_REVISION = 'transaction-v1';
const MAPPINGS = { alexey: 188312, datatalksclub: 182343 };
const BASE_URL = 'https://api.typefully.test';
const CONFIG_DIGEST = typefullyAccountConfigDigest(CONFIG_REVISION, MAPPINGS, BASE_URL);
const SCOPE_DIGEST = approvalScopeDigest([
  'typefully:account:alexey',
  'typefully:account:datatalksclub',
]);
const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:typefully-transaction';

describe('production Typefully proposal/approval/worker/outbox transaction', {
  skip: !process.env.DYNAMODB_ENDPOINT,
}, () => {
  let client: DynamoDBDocumentClient;
  let modelCalls = 0;
  let clarificationOnce: string | null = null;
  const modelBodies: string[] = [];
  let providerCalls = 0;
  let responseDraft = 1;
  let conversationRevision = 1;
  let modelCandidate = {
    account: 'alexey',
    platforms: ['x', 'linkedin'],
    xPosts: ['Exact X post one', 'Exact X post two'],
    linkedinPosts: ['Exact LinkedIn post'],
    draftTitle: 'Exact title',
    scratchpadText: 'Exact scratchpad',
  };

  before(async () => {
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'typefully';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'true';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'true';
    process.env.CONVERSATIONAL_TYPEFULLY_ACCOUNT_CONFIG_DIGEST = CONFIG_DIGEST;
    process.env.TYPEFULLY_ACCOUNT_CONFIG_REVISION = CONFIG_REVISION;
    process.env.TYPEFULLY_BASE_URL = BASE_URL;
    process.env.TYPEFULLY_API_KEY_SECRET_NAME = SECRET_ARN;
    process.env.TYPEFULLY_SOCIAL_SET_ALEXEY = String(MAPPINGS.alexey);
    process.env.TYPEFULLY_SOCIAL_SET_DATATALKSCLUB = String(MAPPINGS.datatalksclub);
    client = await getClient();
    await createTables(client);
    await createUserWithId(client, ACTOR_ID, {
      name: 'Typefully Operator',
      email: 'typefully-transaction@example.test',
      role: 'operator',
    });
    await createUserWithId(client, ADMIN_ID, {
      name: 'Typefully Admin',
      email: 'typefully-transaction-admin@example.test',
      role: 'admin',
    });
    await createConversation(client, {
      id: CONVERSATION_ID,
      recordType: 'conversation',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      ownerUserId: ACTOR_ID,
      audience: 'private',
      status: 'active',
      nextEventSequence: 1,
      revision: 1,
    });
    await createIdentityBinding(client, {
      id: 'typefully-transaction-identity',
      recordType: 'identity_binding',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      userId: ACTOR_ID,
      channel: 'telegram',
      channelUserId: CHAT_ID,
      status: 'active',
      provisionedBy: 'admin',
      provisionedAt: NOW.toISOString(),
      revision: 1,
    });
    await createChannelBinding(client, {
      id: 'typefully-transaction-channel',
      recordType: 'channel_binding',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: CONVERSATION_ID,
      ownerUserId: ACTOR_ID,
      channel: 'telegram',
      channelConversationKey: CHAT_ID,
    });
    await authorize(1);
  });

  async function authorize(
    revision: number,
    enabled = true,
    overrides: {
      allowedResourceKeys?: string[];
      accountScopeDigest?: string;
      accountConfigDigest?: string;
      deliveryModeDigest?: string;
    } = {}
  ) {
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: TYPEFULLY_PERMISSION,
      enabled,
      revision,
      allowedResourceKeys: [
        'typefully:account:alexey',
        'typefully:account:datatalksclub',
      ],
      accountScopeDigest: SCOPE_DIGEST,
      accountConfigDigest: CONFIG_DIGEST,
      deliveryModeDigest: TYPEFULLY_DELIVERY_MODE_DIGEST,
      ...overrides,
    });
  }

  const input = (text: string, updateId: string) => ({
    kind: 'message' as const,
    conversationId: CONVERSATION_ID,
    conversationRevision,
    actor: { id: ACTOR_ID, role: 'operator' as const, channel: 'telegram' as const },
    text,
    inputTrust: 'operator_authored' as const,
    source: { kind: 'telegram_text' },
    provenance: { updateId, chatId: CHAT_ID, channelUserId: CHAT_ID },
  });

  function model(): ConversationalModel {
    return {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        modelCalls += 1;
        const body = JSON.stringify(request);
        modelBodies.push(body);
        assert.doesNotMatch(body, /private-history-sentinel|todo context/);
        assert.match(body, /typed public social source/i);
        if (request.expectedTool === 'skill_load') {
          if (clarificationOnce) {
            const text = clarificationOnce;
            clarificationOnce = null;
            return { kind: 'text', text };
          }
          return {
            kind: 'tool',
            name: 'skill_load',
            input: { plugin: TYPEFULLY_PLUGIN_ID },
          };
        }
        const nonce = request.system.match(/"loadNonce":"([^"]+)"/)?.[1];
        assert.ok(nonce);
        return {
          kind: 'tool',
          name: 'skill_invoke',
          input: {
            plugin: TYPEFULLY_PLUGIN_ID,
            action: TYPEFULLY_ACTION,
            input: modelCandidate,
            load_nonce: nonce,
          },
        };
      },
    };
  }

  function resolutionEvent(
    attemptId: string,
    actorId: string,
    request: Record<string, unknown>
  ): LambdaEvent {
    return {
      httpMethod: 'POST',
      path: `/api/conversational/execution-attempts/${attemptId}/resolve`,
      headers: { 'x-user-id': actorId },
      body: JSON.stringify(request),
    };
  }

  function workerExecutor(
    fetcher?: typeof fetch,
    executorClient: DynamoDBDocumentClient = client
  ) {
    return new TypefullySavedDraftExecutor(executorClient, {
      env: process.env,
      now: () => NOW,
      secretLoader: async (secretId) => {
        assert.equal(secretId, SECRET_ARN);
        return JSON.stringify({ apiKey: 'transaction-worker-token' });
      },
      fetcher: fetcher || (async (_url, init) => {
        providerCalls += 1;
        const sent = JSON.parse(String(init?.body));
        assert.deepEqual(sent, {
          draft_title: modelCandidate.draftTitle,
          scratchpad_text: modelCandidate.scratchpadText,
          share: false,
          platforms: {
            x: { enabled: true, posts: modelCandidate.xPosts.map((text) => ({ text })) },
            linkedin: {
              enabled: true,
              posts: modelCandidate.linkedinPosts.map((text) => ({ text })),
            },
          },
        });
        return new Response(JSON.stringify({
          id: `transaction-draft-${responseDraft++}`,
          social_set_id: MAPPINGS.alexey,
          status: 'draft',
          publish_state: null,
          scheduled_date: null,
          published_at: null,
          share_url: null,
          private_url: 'https://typefully.com/?d=transaction-private',
          draft_title: modelCandidate.draftTitle,
          scratchpad_text: modelCandidate.scratchpadText,
          platforms: {
            x: {
              enabled: true,
              posts: modelCandidate.xPosts.map((text) => ({ text, published_url: null })),
            },
            linkedin: {
              enabled: true,
              posts: modelCandidate.linkedinPosts.map((text) => ({ text, published_url: null })),
            },
          },
        }), { status: 201 });
      }) as typeof fetch,
    });
  }

  async function present(core: ConversationalProposalCore, sequence: number) {
    const source = `Typed public social source ${sequence} for an exact Typefully post`;
    const before = modelCalls;
    const gate = await core.handle(input(source, `source-${sequence}`));
    assert.match(gate.message, new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i'));
    assert.equal(modelCalls, before, 'public-source gate must run before either model turn');
    const preview = await core.handle(input(TYPEFULLY_PUBLIC_CONFIRMATION, `confirm-${sequence}`));
    assert.equal(modelCalls, before + 2);
    for (const text of [
      ...modelCandidate.xPosts,
      ...modelCandidate.linkedinPosts,
      modelCandidate.draftTitle,
      modelCandidate.scratchpadText,
      'operator_reconciliation_only',
      'unscheduled, unpublished, unshared',
    ]) assert.match(preview.message, new RegExp(text, 'i'));
    const approval = preview.buttons?.find(
      (button) => button.text === 'Approve and add to Typefully'
    )?.action as Record<string, JsonValue>;
    assert.equal(typeof approval?.presentationAction, 'string');
    return approval;
  }

  async function approvedAttempt(
    core: ConversationalProposalCore,
    sequence: number,
    updateId: string
  ) {
    const approval = await present(core, sequence);
    const approved = await core.handle({
      ...input('', updateId),
      kind: 'button_action' as const,
      action: approval,
    });
    const attemptId = approved.message.match(/attempt-[a-f0-9]+/)?.[0];
    assert.ok(attemptId);
    return attemptId;
  }

  async function currentAttemptDraft(attemptId: string) {
    const executionAttempt = await getExecutionAttempt(client, attemptId, NOW);
    assert.ok(executionAttempt);
    const proposal = await getProposalVersion(
      client,
      executionAttempt!.proposalId,
      executionAttempt!.proposalVersion
    );
    assert.ok(proposal?.draftId);
    const draft = await getPluginDraft(
      client,
      CONVERSATION_ID,
      proposal!.draftId!,
      ACTOR_ID,
      NOW
    );
    assert.ok(draft);
    return { executionAttempt: executionAttempt!, proposal: proposal!, draft: draft! };
  }

  it('proves public gate, 25-way approval/worker concurrency, crash recovery, and private outbox', async () => {
    const historyPayloadId = 'typefully-private-history-payload';
    await putConversationalPrivatePayload(client, {
      id: historyPayloadId,
      recordType: 'conversational_private_payload',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: CONVERSATION_ID,
      classification: 'private',
      content: { text: 'private-history-sentinel todo context' },
    });
    const historyEvent = {
      id: 'typefully-private-history-event',
      recordType: 'conversation_event',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: CONVERSATION_ID,
      sequence: 1,
      channel: 'telegram',
      idempotencyKey: 'typefully-private-history',
      eventType: 'message',
      direction: 'inbound',
      actorId: ACTOR_ID,
      provenance: 'telegram:private-history',
      classification: 'private',
      payloadRef: historyPayloadId,
    };
    await client.send(new PutCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Item: {
        ...historyEvent,
        PK: `CONVERSATION#${CONVERSATION_ID}`,
        SK: `EVENT#${String(historyEvent.sequence).padStart(12, '0')}#${historyEvent.id}`,
        GSI1PK: `CONVERSATION#${CONVERSATION_ID}`,
        GSI1SK: `EVENT#${String(historyEvent.sequence).padStart(12, '0')}#${historyEvent.id}`,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    const presentationRegistry = new ExecutorRegistry([new TypefullyProposalRenderExecutor()]);
    const core = new ConversationalProposalCore({
      client,
      model: model(),
      now: () => NOW,
      executionRegistry: presentationRegistry,
    });
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
    const previewSource = await core.handle(input(
      'Typed public social source 0 for an exact Typefully post',
      'preview-only-source'
    ));
    assert.match(previewSource.message, new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i'));
    const previewOnly = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'preview-only-confirm'
    ));
    assert.equal(
      previewOnly.buttons?.some((button) => button.text === 'Approve and add to Typefully'),
      false
    );
    assert.equal(
      previewOnly.buttons?.some((button) => button.text === 'Request changes'),
      true
    );
    const previewCancel = previewOnly.buttons?.find(
      (button) => button.text === 'Cancel proposal'
    )?.action;
    assert.ok(previewCancel);
    assert.match((await core.handle({
      ...input('', 'preview-only-cancel'),
      kind: 'button_action',
      action: previewCancel,
    })).message, /canceled.*no provider write/i);
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'true';
    const bareConfirmationCalls = modelCalls;
    assert.match(
      (await core.handle(input(TYPEFULLY_PUBLIC_CONFIRMATION, 'bare-confirmation'))).message,
      /no current typed Typefully source/i
    );
    assert.equal(modelCalls, bareConfirmationCalls);
    const typefullyDraftId = new TypefullyProposalAdapter().draftId(
      CONVERSATION_ID,
      ACTOR_ID
    );
    for (const drift of ['cross_owner', 'non_public', 'policy', 'missing_payload', 'expired'] as const) {
      const beforePendingDrift = modelCalls;
      await core.handle(input(
        `Create a Typefully post from pending ${drift} source`,
        `pending-${drift}`
      ));
      let pending = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.ok(pending);
      const pendingData = structuredClone(pending!.data) as Record<string, JsonValue>;
      if (drift === 'cross_owner') pendingData.actorId = 'another-actor';
      if (drift === 'non_public') pendingData.classification = 'internal';
      if (drift === 'policy') pendingData.policyDigest = `sha256:${'8'.repeat(64)}`;
      if (drift === 'expired') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `CONVERSATION#${CONVERSATION_ID}`, SK: `DRAFT#${typefullyDraftId}` },
          UpdateExpression: 'SET expiresAt = :expired, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':expired': '2026-07-29T12:00:00.000Z',
            ':ttl': Math.floor(Date.parse('2026-07-29T12:00:00.000Z') / 1_000),
          },
        }));
      } else if (drift === 'missing_payload') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRIVATE_PAYLOAD#${String(pendingData.payloadRef)}`, SK: 'META' },
          UpdateExpression: 'SET expiresAt = :expired, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':expired': '2026-07-29T12:00:00.000Z',
            ':ttl': Math.floor(Date.parse('2026-07-29T12:00:00.000Z') / 1_000),
          },
        }));
      } else {
        await savePluginDraft(client, {
          ...pending!,
          data: pendingData,
          revision: pending!.revision + 1,
        }, pending!.revision);
      }
      const rejectedConfirmation = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `confirm-pending-${drift}`
      ));
      assert.match(rejectedConfirmation.message, /no current|expired/i);
      assert.equal(modelCalls, beforePendingDrift, `${drift} confirmation must not call the model`);
      if (drift === 'expired') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `CONVERSATION#${CONVERSATION_ID}`, SK: `DRAFT#${typefullyDraftId}` },
          UpdateExpression: 'SET expiresAt = :expiresAt, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':expiresAt': '2026-08-29T12:00:00.000Z',
            ':ttl': Math.floor(Date.parse('2026-08-29T12:00:00.000Z') / 1_000),
          },
        }));
      }
      pending = null;
    }
    await putConversationalPrivatePayload(client, {
      id: 'derived-media-private-payload',
      recordType: 'conversational_private_payload',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: CONVERSATION_ID,
      classification: 'private',
      content: { kind: 'voice_note', text: 'private derived voice transcript' },
    });
    const beforeDerived = modelCalls;
    const derived = await core.handle({
      ...input('Create a Typefully post from this voice note', 'derived-media'),
      inputTrust: 'untrusted_provider_derived',
      source: { kind: 'voice_note', payloadRef: 'derived-media-private-payload' },
    });
    assert.match(derived.message, /new typed public-safe summary/i);
    assert.equal(modelCalls, beforeDerived);
    await putConversationalPrivatePayload(client, {
      id: 'derived-image-private-payload',
      recordType: 'conversational_private_payload',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...expiryFrom(NOW.toISOString(), 30),
      conversationId: CONVERSATION_ID,
      classification: 'private',
      content: {
        kind: 'photo',
        description: 'private derived image description',
        objectKey: 'private/image/object-key',
      },
    });
    const beforeImage = modelCalls;
    const derivedImage = await core.handle({
      ...input('Create a Typefully post from this image', 'derived-image'),
      inputTrust: 'untrusted_provider_derived',
      source: { kind: 'photo', payloadRef: 'derived-image-private-payload' },
    });
    assert.match(derivedImage.message, /new typed public-safe summary/i);
    assert.equal(modelCalls, beforeImage);
    for (const [sourceKind, inputTrust] of [
      ['file', 'untrusted_provider_derived'],
      ['fetched_url', 'untrusted_provider_derived'],
      ['private_ref', 'untrusted_provider_derived'],
      ['restricted_ref', 'operator_authored'],
    ] as const) {
      const beforeRejectedSource = modelCalls;
      const rejectedSource = await core.handle({
        ...input(`Create a Typefully post from this ${sourceKind}`, `derived-${sourceKind}`),
        inputTrust,
        source: { kind: sourceKind, payloadRef: `private-${sourceKind}-payload` },
      });
      assert.match(rejectedSource.message, /typed public-safe|type a new bounded public-safe/i);
      assert.equal(modelCalls, beforeRejectedSource, `${sourceKind} must be rejected before model use`);
    }
    let lastClarificationPreview: Awaited<ReturnType<typeof core.handle>> | null = null;
    for (const [field, answer, sequence] of [
      ['account', 'DataTalksClub', 101],
      ['platform', 'both', 102],
      ['purpose', 'Announce the public DataTalksClub workshop', 103],
    ] as const) {
      modelCandidate = {
        ...modelCandidate,
        account: field === 'account' ? 'datatalksclub' : 'alexey',
      };
      const before = modelCalls;
      const source = `Typed public social source ${sequence} for an exact Typefully post`;
      assert.match(
        (await core.handle(input(source, `clarify-source-${field}`))).message,
        new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i')
      );
      clarificationOnce = `Which ${field} should I use?`;
      const question = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `clarify-first-confirm-${field}`
      ));
      assert.match(question.message, new RegExp(field, 'i'));
      assert.equal(modelCalls, before + 1);
      const amendmentGate = await core.handle(input(answer, `clarify-answer-${field}`));
      const preview = field === 'purpose'
        ? await (async () => {
          assert.match(amendmentGate.message, new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i'));
          assert.equal(modelCalls, before + 1, 'free-form purpose must be confirmed before egress');
          return core.handle(input(
            TYPEFULLY_PUBLIC_CONFIRMATION,
            `clarify-answer-confirm-${field}`
          ));
        })()
        : amendmentGate;
      assert.equal(modelCalls, before + 3);
      assert.match(preview.message, /Typefully saved-draft proposal/i);
      const answerPattern = field === 'platform'
        ? /platforms.*x.*linkedin/i
        : new RegExp(answer, 'i');
      const answerBody = modelBodies.findLast((body) => answerPattern.test(body)) || '';
      assert.match(answerBody, answerPattern);
      assert.doesNotMatch(answerBody, /private-history-sentinel|todo context/);
      lastClarificationPreview = preview;
    }
    const adversarialSource =
      'Typed public social source for clarification pending validation';
    await core.handle(input(adversarialSource, 'clarification-adversarial-source'));
    clarificationOnce = 'What purpose should this public post serve?';
    await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'clarification-adversarial-source-confirm'
    ));
    await core.handle(input(
      'First confirmed public purpose',
      'clarification-adversarial-answer-one'
    ));
    clarificationOnce = 'What additional public detail should it include?';
    await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'clarification-adversarial-answer-one-confirm'
    ));
    await core.handle(input(
      'Second public detail awaiting confirmation',
      'clarification-adversarial-answer-two'
    ));
    const clarificationBaseline = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    assert.ok(clarificationBaseline);
    const baselineData = structuredClone(
      clarificationBaseline!.data
    ) as Record<string, JsonValue>;
    assert.equal(baselineData.continuationKind, 'clarification');
    assert.equal(
      (baselineData.priorProofs as JsonValue[]).length,
      2,
      'clarification adversarial baseline needs ordered multi-grant context'
    );
    for (const mutation of [
      'previous_candidate',
      'based_on',
      'proof_cardinality',
      'proof_order',
      'proof_ref',
      'proof_source_revision',
      'proof_confirmation_revision',
      'proof_classification',
      'proof_digest',
      'proof_payload',
      'choice_unknown',
      'choice_invalid_account',
      'choice_invalid_platform',
      'choice_non_object',
      'choice_array',
      'current_classification',
      'current_digest',
      'current_payload',
    ] as const) {
      const current = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.ok(current);
      const mutated = structuredClone(baselineData) as Record<string, JsonValue>;
      const priorProofs = mutated.priorProofs as Array<Record<string, JsonValue>>;
      if (mutation === 'previous_candidate') {
        mutated.previousCandidate = { privateMaterial: 'must-never-reach-zai' };
      }
      if (mutation === 'based_on') mutated.basedOnProposalId = 'injected-proposal';
      if (mutation === 'proof_cardinality') mutated.priorProofs = [priorProofs[0]];
      if (mutation === 'proof_order') mutated.priorProofs = [...priorProofs].reverse();
      if (mutation === 'proof_ref') priorProofs[0].kind = 'invalid-grant';
      if (mutation === 'proof_digest') {
        priorProofs[0].sourceDigest = `sha256:${'4'.repeat(64)}`;
      }
      if (mutation === 'proof_source_revision') {
        priorProofs[0].sourceRevision = 0;
      }
      if (mutation === 'proof_confirmation_revision') {
        priorProofs[0].confirmationRevision = 0;
      }
      if (mutation === 'proof_classification') priorProofs[0].classification = 'private';
      if (mutation === 'proof_payload') priorProofs[0].payloadRef = 'missing-payload';
      if ([
        'proof_ref',
        'proof_source_revision',
        'proof_confirmation_revision',
        'proof_classification',
        'proof_digest',
        'proof_payload',
      ].includes(mutation)) {
        mutated.priorProofsDigest = sha256(canonicalJson(mutated.priorProofs));
      }
      if (mutation === 'choice_unknown') {
        mutated.coreChoices = { unknown: 'must-never-reach-zai' };
      }
      if (mutation === 'choice_invalid_account') mutated.coreChoices = { account: 'invalid' };
      if (mutation === 'choice_invalid_platform') mutated.coreChoices = { platforms: ['web'] };
      if (mutation === 'choice_non_object') mutated.coreChoices = 'invalid';
      if (mutation === 'choice_array') mutated.coreChoices = ['x'];
      if (mutation === 'current_classification') mutated.classification = 'public';
      if (mutation === 'current_digest') mutated.sourceDigest = `sha256:${'5'.repeat(64)}`;
      if (mutation === 'current_payload') mutated.payloadRef = 'missing-current-payload';
      await savePluginDraft(client, {
        ...current!,
        data: mutated,
        revision: current!.revision + 1,
      }, current!.revision);
      const callsBefore = modelCalls;
      const versionsBefore = (
        await listProposalVersions(client, new TypefullyProposalAdapter().proposalId(typefullyDraftId))
      ).items.length;
      const rejected = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `clarification-adversarial-confirm-${mutation}`
      ));
      assert.notEqual(rejected.kind, 'proposal_presented');
      assert.equal(modelCalls, callsBefore, `${mutation} must fail before model egress`);
      assert.equal(
        (
          await listProposalVersions(
            client,
            new TypefullyProposalAdapter().proposalId(typefullyDraftId)
          )
        ).items.length,
        versionsBefore,
        `${mutation} must not create a proposal`
      );
    }
    const currentAfterMutations = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    assert.ok(currentAfterMutations);
    await savePluginDraft(client, {
      ...currentAfterMutations!,
      data: baselineData,
      revision: currentAfterMutations!.revision + 1,
    }, currentAfterMutations!.revision);
    const validClarification = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'clarification-adversarial-valid-confirm'
    ));
    assert.match(validClarification.message, /Typefully saved-draft proposal/i);
    lastClarificationPreview = validClarification;
    assert.ok(lastClarificationPreview?.buttons);
    const oldApproval = lastClarificationPreview!.buttons!.find(
      (button) => button.text === 'Approve and add to Typefully'
    )!.action;
    const requestChanges = lastClarificationPreview!.buttons!.find(
      (button) => button.text === 'Request changes'
    )!.action;
    const oldPresentation = await getPresentationByTokenHash(
      client,
      sha256(String((oldApproval as Record<string, JsonValue>).presentationAction)),
      NOW
    );
    assert.ok(oldPresentation);
    const beforeChange = modelCalls;
    const changePrompt = await core.handle({
      ...input('', 'request-changes'),
      kind: 'button_action',
      action: requestChanges,
    });
    assert.match(changePrompt.message, /what should I change/i);
    const correctionGate = await core.handle(input(
      'Make the opening hook shorter and keep the complete draft.',
      'change-correction'
    ));
    assert.match(correctionGate.message, new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i'));
    assert.equal(modelCalls, beforeChange);
    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Shorter replacement hook', 'Complete replacement follow-up'],
      linkedinPosts: ['Complete revised LinkedIn post'],
      draftTitle: 'Complete revised title',
      scratchpadText: 'Complete revised scratchpad',
    };
    clarificationOnce = 'Which account should I use for this revised draft?';
    const nestedAccountQuestion = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'change-confirm'
    ));
    assert.match(nestedAccountQuestion.message, /account/i);
    assert.equal(modelCalls, beforeChange + 1);

    async function assertNestedRequestChangeTamperMatrix(
      stage: 'continuation' | 'pending',
      baseline: Awaited<ReturnType<typeof getPluginDraft>>
    ) {
      assert.ok(baseline);
      const baselineData = structuredClone(baseline!.data) as Record<string, JsonValue>;
      for (const mutation of [
        'kind',
        'candidate',
        'based_on_id',
        'based_on_version',
        'based_on_presentation',
        'proof_cardinality',
        'proof_order',
        'proof_ref',
        'proof_revision',
        'proof_classification',
        'proof_digest',
        'proof_payload',
        'choice_unknown',
        'choice_invalid',
        'choice_mismatch',
      ] as const) {
        const current = await getPluginDraft(
          client,
          CONVERSATION_ID,
          typefullyDraftId,
          ACTOR_ID,
          NOW
        );
        assert.ok(current);
        const mutated = structuredClone(baselineData) as Record<string, JsonValue>;
        if (mutation === 'kind') {
          if (stage === 'continuation') mutated.mode = 'clarification';
          else mutated.continuationKind = 'clarification';
        }
        if (mutation === 'candidate') {
          const candidate = structuredClone(
            mutated.previousCandidate
          ) as Record<string, JsonValue>;
          candidate.xPosts = ['Nested carry-forward tamper'];
          mutated.previousCandidate = candidate;
        }
        if (mutation === 'based_on_id') mutated.basedOnProposalId = 'wrong-proposal';
        if (mutation === 'based_on_version') {
          mutated.basedOnProposalVersion = Number(mutated.basedOnProposalVersion) + 1;
        }
        if (mutation === 'based_on_presentation') {
          mutated.basedOnPresentationHash = `sha256:${'7'.repeat(64)}`;
        }
        const proofContainer = stage === 'continuation'
          ? (mutated.sourceProof as Record<string, JsonValue>)
          : mutated;
        const proofs = (
          stage === 'continuation'
            ? proofContainer?.proofs
            : proofContainer?.priorProofs
        ) as Array<Record<string, JsonValue>>;
        if (mutation === 'proof_cardinality') {
          if (stage === 'continuation') proofContainer!.proofs = [proofs[0]];
          else proofContainer!.priorProofs = [proofs[0]];
        }
        if (mutation === 'proof_order') {
          if (stage === 'continuation') proofContainer!.proofs = [...proofs].reverse();
          else proofContainer!.priorProofs = [...proofs].reverse();
        }
        if (mutation === 'proof_ref') proofs[0].kind = 'invalid-grant';
        if (mutation === 'proof_revision') proofs[0].confirmationRevision = 0;
        if (mutation === 'proof_classification') proofs[0].classification = 'private';
        if (mutation === 'proof_digest') {
          proofs[0].sourceDigest = `sha256:${'8'.repeat(64)}`;
        }
        if (mutation === 'proof_payload') proofs[0].payloadRef = 'missing-nested-payload';
        if (stage === 'pending' && mutation.startsWith('proof_')) {
          mutated.priorProofsDigest = sha256(canonicalJson(mutated.priorProofs));
        }
        if (mutation === 'choice_unknown') {
          mutated.coreChoices = { unknown: 'must-not-reach-model' };
        }
        if (mutation === 'choice_invalid') mutated.coreChoices = { account: 'invalid' };
        if (mutation === 'choice_mismatch') {
          mutated.coreChoices = { account: 'datatalksclub' };
        }
        await savePluginDraft(client, {
          ...current!,
          data: mutated,
          revision: current!.revision + 1,
        }, current!.revision);
        const callsBefore = modelCalls;
        const versionsBefore = (
          await listProposalVersions(client, oldPresentation!.proposalId)
        ).items.length;
        const rejected = stage === 'continuation'
          ? await core.handle(input('Alexey', `nested-continuation-${mutation}`))
          : await core.handle(input(
            TYPEFULLY_PUBLIC_CONFIRMATION,
            `nested-pending-${mutation}`
          ));
        assert.equal(modelCalls, callsBefore, `${stage}:${mutation} must not reach model`);
        assert.equal(
          (await listProposalVersions(client, oldPresentation!.proposalId)).items.length,
          versionsBefore,
          `${stage}:${mutation} must not create a proposal`
        );
      }
      const latest = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.ok(latest);
      await savePluginDraft(client, {
        ...latest!,
        data: baselineData,
        revision: latest!.revision + 1,
      }, latest!.revision);
      const restored = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.deepEqual(restored!.data, baselineData);
    }

    const nestedContinuation = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    assert.equal(
      (nestedContinuation!.data as Record<string, JsonValue>).mode,
      'request_changes'
    );
    await assertNestedRequestChangeTamperMatrix('continuation', nestedContinuation);
    const restoredNestedContinuation = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    const restoredNestedData = restoredNestedContinuation!.data as Record<string, JsonValue>;
    const basedOnProposal = await getProposalVersion(
      client,
      String(restoredNestedData.basedOnProposalId),
      Number(restoredNestedData.basedOnProposalVersion)
    );
    assert.equal(basedOnProposal!.status, 'superseded');
    assert.deepEqual(
      restoredNestedData.previousCandidate,
      basedOnProposal!.spec.proposedContent
    );
    const restoredPresentation = await getPresentationByTokenHash(
      client,
      String(restoredNestedData.basedOnPresentationHash),
      NOW
    );
    assert.equal(restoredPresentation!.status, 'revoked');
    const restoredProofs = (
      restoredNestedData.sourceProof as Record<string, JsonValue>
    ).proofs as Array<Record<string, JsonValue>>;
    assert.deepEqual(
      restoredProofs.slice(0, basedOnProposal!.spec.sourceRefs.length).map((proof) => ({
        ref: `public-source:${String(proof.sourceDigest)}`,
        revision: `${String(proof.policyDigest)}:${String(proof.confirmationRevision)}`,
        classification: String(proof.classification),
      })),
      basedOnProposal!.spec.sourceRefs
    );
    for (const proof of restoredProofs) {
      assert.ok(await getConversationalPrivatePayload(
        client,
        CONVERSATION_ID,
        String(proof.payloadRef),
        ACTOR_ID,
        NOW
      ));
    }

    clarificationOnce = 'What additional public detail should the revision include?';
    const nestedPurposeQuestion = await core.handle(input(
      'Alexey',
      'nested-request-account-answer'
    ));
    assert.match(nestedPurposeQuestion.message, /public detail/i);
    assert.equal(modelCalls, beforeChange + 2);
    const carriedContinuation = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    const carriedData = carriedContinuation!.data as Record<string, JsonValue>;
    assert.equal(carriedData.mode, 'request_changes');
    assert.equal(
      carriedData.basedOnPresentationHash,
      oldPresentation!.actionTokenHash
    );
    assert.deepEqual(carriedData.coreChoices, { account: 'alexey' });

    const nestedFreeFormGate = await core.handle(input(
      'Keep the second post focused on the confirmed public workshop benefit.',
      'nested-request-purpose-answer'
    ));
    assert.match(
      nestedFreeFormGate.message,
      new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i')
    );
    assert.equal(modelCalls, beforeChange + 2);
    const nestedPending = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    assert.equal(
      (nestedPending!.data as Record<string, JsonValue>).continuationKind,
      'request_changes'
    );
    await assertNestedRequestChangeTamperMatrix('pending', nestedPending);

    const replacement = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'nested-request-purpose-confirm'
    ));
    assert.equal(modelCalls, beforeChange + 4);
    assert.match(replacement.message, /Typefully saved-draft proposal/i);
    assert.match(modelBodies.at(-2) || '', /Make the opening hook shorter/i);
    assert.match(modelBodies.at(-2) || '', /Exact prior Typefully candidate/i);
    for (const exact of [
      ...modelCandidate.xPosts,
      ...modelCandidate.linkedinPosts,
      modelCandidate.draftTitle,
      modelCandidate.scratchpadText,
    ]) assert.match(replacement.message, new RegExp(exact, 'i'));
    const proposalVersions = await listProposalVersions(
      client,
      oldPresentation!.proposalId
    );
    const oldProposal = proposalVersions.items.find(
      (proposal) => proposal.version === oldPresentation!.proposalVersion
    );
    const newProposal = proposalVersions.items.find(
      (proposal) => proposal.version === oldPresentation!.proposalVersion + 1
    );
    assert.equal(oldProposal?.status, 'superseded');
    assert.equal((await getPresentationByTokenHash(
      client,
      oldPresentation!.actionTokenHash,
      NOW
    ))?.status, 'revoked');
    assert.equal(newProposal?.status, 'presented');
    assert.equal(
      newProposal?.spec.sourceRefs.length,
      (oldProposal?.spec.sourceRefs.length || 0) + 2
    );
    assert.deepEqual(newProposal?.spec.proposedContent, modelCandidate);
    const replacementDraft = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    const replacementProofCard = (
      replacementDraft!.data as Record<string, JsonValue>
    ).proof as Record<string, JsonValue>;
    const replacementProofs = replacementProofCard
      .proofs as Array<Record<string, JsonValue>>;
    assert.deepEqual(
      newProposal?.spec.sourceRefs,
      replacementProofs.map((proof) => ({
        ref: `public-source:${String(proof.sourceDigest)}`,
        revision: `${String(proof.policyDigest)}:${String(proof.confirmationRevision)}`,
        classification: 'public',
      })),
      'revised sourceRefs must preserve the exact confirmed grant order'
    );
    assert.equal(newProposal?.presentationIds?.length, 1);
    assert.ok(replacement.buttons?.some(
      (button) => button.text === 'Approve and add to Typefully'
    ));
    const revisedApproval = replacement.buttons!.find(
      (button) => button.text === 'Approve and add to Typefully'
    )!.action;
    const revisedApproved = await core.handle({
      ...input('', 'approve-revised-multi-grant'),
      kind: 'button_action',
      action: revisedApproval,
    });
    const revisedAttemptId = revisedApproved.message.match(/attempt-[a-f0-9]+/)?.[0];
    assert.ok(revisedAttemptId);
    const revisedResult = await processAttempt(revisedAttemptId!, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'revised-multi-grant-worker',
    });
    assert.equal(revisedResult?.status, 'succeeded');
    assert.equal(providerCalls, 1);

    async function approvedRevisedAttempt(sequence: number) {
      await core.handle(input(
        `Typed public social source ${sequence} for an exact Typefully multi-grant post`,
        `multi-grant-source-${sequence}`
      ));
      const initialPreview = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `multi-grant-confirm-${sequence}`
      ));
      const change = initialPreview.buttons!.find(
        (button) => button.text === 'Request changes'
      )!.action;
      await core.handle({
        ...input('', `multi-grant-change-${sequence}`),
        kind: 'button_action',
        action: change,
      });
      await core.handle(input(
        `Public correction ${sequence} that keeps a complete replacement`,
        `multi-grant-correction-${sequence}`
      ));
      const revisedPreview = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `multi-grant-correction-confirm-${sequence}`
      ));
      const approvalAction = revisedPreview.buttons!.find(
        (button) => button.text === 'Approve and add to Typefully'
      )!.action;
      const approved = await core.handle({
        ...input('', `multi-grant-approve-${sequence}`),
        kind: 'button_action',
        action: approvalAction,
      });
      const id = approved.message.match(/attempt-[a-f0-9]+/)?.[0];
      assert.ok(id);
      return id!;
    }
    for (const sourceIndex of [0, 1]) {
      const tamperAttemptId = await approvedRevisedAttempt(210 + sourceIndex);
      const current = await currentAttemptDraft(tamperAttemptId);
      assert.equal(current.proposal.spec.sourceRefs.length, 2);
      const card = (current.draft.data as Record<string, JsonValue>)
        .proof as Record<string, JsonValue>;
      const proof = (card.proofs as Array<Record<string, JsonValue>>)[sourceIndex];
      const payloadKey = {
        PK: `PRIVATE_PAYLOAD#${String(proof.payloadRef)}`,
        SK: 'META',
      };
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: payloadKey,
        UpdateExpression: 'SET expiresAt = :expired, #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':expired': '2026-07-30T11:59:59.000Z',
          ':ttl': Math.floor(Date.parse('2026-07-30T11:59:59.000Z') / 1_000),
        },
      }));
      const beforeTamperProvider = providerCalls;
      const tampered = await processAttempt(tamperAttemptId, {
        client,
        registry: new ExecutorRegistry([workerExecutor()]),
        now: () => NOW,
        leaseOwner: () => `multi-grant-tamper-${sourceIndex}`,
      });
      assert.equal(tampered?.status, 'failed_safe');
      assert.equal(tampered?.dispatchStartedAt, undefined);
      assert.equal(providerCalls, beforeTamperProvider);
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: payloadKey,
        UpdateExpression: 'SET expiresAt = :future, #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':future': '2026-08-29T12:00:00.000Z',
          ':ttl': Math.floor(Date.parse('2026-08-29T12:00:00.000Z') / 1_000),
        },
      }));
    }
    await core.handle(input(
      'Typed public social source 220 for a Typefully expiring correction',
      'expiring-change-source'
    ));
    const expiringPreview = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'expiring-change-source-confirm'
    ));
    const expiringChange = expiringPreview.buttons!.find(
      (button) => button.text === 'Request changes'
    )!.action;
    await core.handle({
      ...input('', 'expiring-change-click'),
      kind: 'button_action',
      action: expiringChange,
    });
    const expiringPresentationToken = String(
      (expiringChange as Record<string, JsonValue>).presentationAction
    );
    await core.handle(input(
      'Public correction staged just before the continuation expires',
      'expiring-change-correction'
    ));
    const staged = await getPluginDraft(
      client,
      CONVERSATION_ID,
      typefullyDraftId,
      ACTOR_ID,
      NOW
    );
    assert.ok(staged);
    const stagedData = structuredClone(staged!.data) as Record<string, JsonValue>;
    stagedData.continuationExpiresAt = '2026-07-30T11:59:59.000Z';
    await savePluginDraft(client, {
      ...staged!,
      data: stagedData,
      revision: staged!.revision + 1,
    }, staged!.revision);
    const beforeExpiredConfirmationCalls = modelCalls;
    const versionsBeforeExpiredConfirmation = (
      await listProposalVersions(client, oldPresentation!.proposalId)
    ).items.length;
    const expiredConfirmation = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'expiring-change-confirm-after-deadline'
    ));
    assert.match(expiredConfirmation.message, /no current|type again/i);
    assert.equal(modelCalls, beforeExpiredConfirmationCalls);
    assert.equal(
      (await listProposalVersions(client, oldPresentation!.proposalId)).items.length,
      versionsBeforeExpiredConfirmation
    );
    assert.equal((await getPresentationByTokenHash(
      client,
      sha256(expiringPresentationToken),
      NOW
    ))?.status, 'revoked');
    for (const malformed of [
      'missing_expiry',
      'non_string_expiry',
      'missing_based_on',
      'partial_based_on',
      'mismatched_based_on',
      'stripped_marker',
      'candidate_tamper',
      'proof_order',
      'proof_ref',
      'proof_revision',
      'proof_payload',
      'choice_value',
      'choice_unknown',
      'choice_mismatch',
    ] as const) {
      await core.handle(input(
        `Typed public social source malformed continuation ${malformed} for Typefully`,
        `malformed-source-${malformed}`
      ));
      const malformedPreview = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `malformed-source-confirm-${malformed}`
      ));
      const malformedChange = malformedPreview.buttons!.find(
        (button) => button.text === 'Request changes'
      )!.action;
      await core.handle({
        ...input('', `malformed-change-${malformed}`),
        kind: 'button_action',
        action: malformedChange,
      });
      await core.handle(input(
        `Public correction for malformed continuation ${malformed}`,
        `malformed-correction-${malformed}`
      ));
      const pending = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.ok(pending);
      const pendingData = structuredClone(pending!.data) as Record<string, JsonValue>;
      if (malformed === 'missing_expiry') delete pendingData.continuationExpiresAt;
      if (malformed === 'non_string_expiry') pendingData.continuationExpiresAt = 123;
      if (malformed === 'missing_based_on') delete pendingData.basedOnProposalId;
      if (malformed === 'partial_based_on') delete pendingData.basedOnPresentationHash;
      if (malformed === 'mismatched_based_on') {
        pendingData.basedOnProposalId = 'different-proposal';
      }
      if (malformed === 'stripped_marker') delete pendingData.pendingMode;
      if (malformed === 'candidate_tamper') {
        const candidate = structuredClone(
          pendingData.previousCandidate
        ) as Record<string, JsonValue>;
        candidate.xPosts = ['Tampered candidate'];
        pendingData.previousCandidate = candidate;
      }
      const priorProofs = pendingData.priorProofs as Array<Record<string, JsonValue>>;
      if (malformed === 'proof_order') pendingData.priorProofs = [...priorProofs, priorProofs[0]];
      if (malformed === 'proof_ref') priorProofs[0].sourceDigest = `sha256:${'4'.repeat(64)}`;
      if (malformed === 'proof_revision') {
        priorProofs[0].confirmationRevision = Number(priorProofs[0].confirmationRevision) + 1;
      }
      if (malformed === 'proof_payload') priorProofs[0].payloadRef = 'missing-payload';
      if (malformed === 'choice_value') pendingData.coreChoices = { account: 'invalid' };
      if (malformed === 'choice_unknown') pendingData.coreChoices = { unknown: 'value' };
      if (malformed === 'choice_mismatch') {
        pendingData.coreChoices = { account: 'datatalksclub' };
      }
      await savePluginDraft(client, {
        ...pending!,
        data: pendingData,
        revision: pending!.revision + 1,
      }, pending!.revision);
      const beforeMalformedCalls = modelCalls;
      const beforeMalformedVersions = (
        await listProposalVersions(client, oldPresentation!.proposalId)
      ).items.length;
      const rejectedMalformed = await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `malformed-confirm-${malformed}`
      ));
      assert.match(rejectedMalformed.message, /no current|type again|safely continue|confirmation expired/i);
      assert.equal(modelCalls, beforeMalformedCalls);
      assert.equal(
        (await listProposalVersions(client, oldPresentation!.proposalId)).items.length,
        beforeMalformedVersions
      );
    }
    await core.handle(input(
      'Typed public social source 221 for a Typefully bound control-set check',
      'bound-set-source'
    ));
    const boundSetPreview = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'bound-set-confirm'
    ));
    const boundSetChange = boundSetPreview.buttons!.find(
      (button) => button.text === 'Request changes'
    )!.action;
    const boundSetPresentation = await getPresentationByTokenHash(
      client,
      sha256(String((boundSetChange as Record<string, JsonValue>).presentationAction)),
      NOW
    );
    assert.ok(boundSetPresentation);
    await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: {
        PK: `PROPOSAL#${boundSetPresentation!.proposalId}`,
        SK: `VERSION#${String(boundSetPresentation!.proposalVersion).padStart(12, '0')}`,
      },
      UpdateExpression: 'REMOVE presentationIds',
    }));
    const omittedSetResult = await core.handle({
      ...input('', 'bound-set-request-changes'),
      kind: 'button_action',
      action: boundSetChange,
    });
    assert.equal(omittedSetResult.kind, 'error');
    assert.equal((await getPresentationByTokenHash(
      client,
      boundSetPresentation!.actionTokenHash,
      NOW
    ))?.status, 'active', 'missing bound set must fail before revoking any control');

    const staleOldApproval = await core.handle({
      ...input('', 'stale-old-approval'),
      kind: 'button_action',
      action: oldApproval,
    });
    assert.match(staleOldApproval.message, /stale|expired/i);
    const beforeUnrelated = modelCalls;
    const unrelated = await core.handle(input('How is the weather?', 'unrelated-after-preview'));
    assert.equal(modelCalls, beforeUnrelated);
    assert.doesNotMatch(unrelated.message, /Typefully saved-draft proposal/i);
    for (const drift of ['cross_owner', 'cross_conversation', 'expired', 'policy'] as const) {
      const before = modelCalls;
      await core.handle(input(
        `Typed public social source continuation ${drift} for Typefully`,
        `continuation-source-${drift}`
      ));
      clarificationOnce = `Which account should I use for ${drift}?`;
      await core.handle(input(
        TYPEFULLY_PUBLIC_CONFIRMATION,
        `continuation-confirm-${drift}`
      ));
      assert.equal(modelCalls, before + 1);
      const continuation = await getPluginDraft(
        client,
        CONVERSATION_ID,
        typefullyDraftId,
        ACTOR_ID,
        NOW
      );
      assert.ok(continuation);
      const continuationData = structuredClone(
        continuation!.data
      ) as Record<string, JsonValue>;
      if (drift === 'cross_owner') continuationData.actorId = 'another-actor';
      if (drift === 'cross_conversation') {
        continuationData.conversationId = 'another-conversation';
      }
      if (drift === 'expired') {
        continuationData.continuationExpiresAt = '2026-07-30T11:59:59.000Z';
      }
      if (drift === 'policy') continuationData.policyDigest = `sha256:${'5'.repeat(64)}`;
      await savePluginDraft(client, {
        ...continuation!,
        data: continuationData,
        revision: continuation!.revision + 1,
      }, continuation!.revision);
      const rejected = await core.handle(input(
        'DataTalksClub',
        `continuation-answer-${drift}`
      ));
      assert.match(rejected.message, /stale or expired/i);
      assert.equal(modelCalls, before + 1, `${drift} continuation must not reach the model`);
    }

    const approval = await present(core, 1);
    const click = () => core.handle({
      ...input('', 'approve-concurrent'),
      kind: 'button_action' as const,
      action: approval,
    });
    const approvals = await Promise.all(Array.from({ length: 25 }, click));
    const attemptIds = new Set(
      approvals.map((result) => result.message.match(/attempt-[a-f0-9]+/)?.[0]).filter(Boolean)
    );
    assert.equal(attemptIds.size, 1);
    const attemptId = [...attemptIds][0]!;
    const executor = workerExecutor();
    const workerRegistry = new ExecutorRegistry([executor]);
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) => (
      processAttempt(attemptId, {
        client,
        registry: workerRegistry,
        now: () => NOW,
        leaseOwner: () => `worker-${index}`,
      })
    )));
    assert.equal(providerCalls, 2);
    assert.ok(results.some((result) => result?.status === 'succeeded'));
    const stored = await getExecutionAttempt(client, attemptId, NOW);
    assert.equal(stored?.status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(stored?.resultReceipt), /typefully\.com|transaction-worker-token|188312/);
    const notification = await getResultNotification(
      client,
      `result-notification-${attemptId}`,
      NOW
    );
    assert.equal(notification?.status, 'pending');
    const privatePayload = await getConversationalPrivatePayload(
      client,
      CONVERSATION_ID,
      notification!.privatePayloadRef,
      ACTOR_ID,
      NOW
    );
    assert.match(JSON.stringify(privatePayload?.content), /https:\/\/typefully\.com/);
    assert.equal(
      await getConversationalPrivatePayload(
        client,
        CONVERSATION_ID,
        notification!.privatePayloadRef,
        'another-actor',
        NOW
      ).then(() => 'leaked', () => 'not-found'),
      'not-found'
    );
    const delivered: string[] = [];
    const dispatch = await dispatchOne(notification!, {
      client,
      now: () => NOW,
      transport: {
        async sendPrivateMessage(_chatId, message) {
          delivered.push(message);
        },
      },
    });
    assert.equal(dispatch, 'delivered');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /https:\/\/typefully\.com/);
    assert.match(delivered[0], /unscheduled/i);
    assert.match(delivered[0], /unpublished/i);
    assert.match(delivered[0], /unshared/i);
    assert.match(delivered[0], /scheduling and publication remain manual/i);
    assert.equal(
      await dispatchOne(notification!, {
        client,
        now: () => NOW,
        transport: {
          async sendPrivateMessage(_chatId, message) {
            delivered.push(message);
          },
        },
      }),
      'rejected'
    );
    assert.equal(delivered.length, 1, 'outbox delivery must deduplicate');

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Crash-boundary X post'],
      linkedinPosts: ['Crash-boundary LinkedIn post'],
    };
    const crashApproval = await present(core, 2);
    const approvedCrash = await core.handle({
      ...input('', 'approve-crash'),
      kind: 'button_action',
      action: crashApproval,
    });
    const crashAttemptId = approvedCrash.message.match(/attempt-[a-f0-9]+/)?.[0];
    assert.ok(crashAttemptId);
    const beforeCrashCalls = providerCalls;
    await assert.rejects(() => processAttempt(crashAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'crash-worker',
      crashAfter: 'dispatch_marker',
      config: { leaseSeconds: 60 },
    }));
    assert.equal(providerCalls, beforeCrashCalls);
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => LATER,
      leaseOwner: () => 'recovery-worker',
    });
    const unknown = await getExecutionAttempt(client, crashAttemptId, LATER);
    assert.equal(unknown?.status, 'outcome_unknown');
    assert.equal(unknown?.recoveryBlocked, true);
    assert.equal(providerCalls, beforeCrashCalls, 'operator-only unknown must never replay');
    const warning = await getResultNotification(
      client,
      `result-notification-${crashAttemptId}`,
      LATER
    );
    assert.ok(warning);
    const warningMessages: string[] = [];
    assert.equal(await dispatchOne(warning!, {
      client,
      now: () => LATER,
      transport: {
        async sendPrivateMessage(_chatId, message) {
          warningMessages.push(message);
        },
      },
    }), 'delivered');
    assert.deepEqual(warningMessages, [
      'Typefully may have created this draft. Do not retry. An authorized operator must reconcile it in Typefully.',
    ]);

    const nonAdmin = await handleConversationalExecutionRoutes(
      `/api/conversational/execution-attempts/${crashAttemptId}/resolve`,
      'POST',
      resolutionEvent(crashAttemptId, ACTOR_ID, {
        revision: unknown!.revision,
        outcome: 'found',
        proofClassification: 'exact_match',
        draftId: 'operator-found-draft',
      }),
      client,
      { now: () => LATER }
    );
    assert.equal(nonAdmin?.statusCode, 404);
    const stale = await handleConversationalExecutionRoutes(
      `/api/conversational/execution-attempts/${crashAttemptId}/resolve`,
      'POST',
      resolutionEvent(crashAttemptId, ADMIN_ID, {
        revision: unknown!.revision - 1,
        outcome: 'found',
        proofClassification: 'exact_match',
        draftId: 'operator-found-draft',
      }),
      client,
      { now: () => LATER }
    );
    assert.equal(stale?.statusCode, 409);
    const foundRequest = {
      revision: unknown!.revision,
      outcome: 'found',
      proofClassification: 'exact_match',
      draftId: 'operator-found-draft',
      editUrl: 'https://typefully.com/?d=operator-found-draft',
    };
    const found = await handleConversationalExecutionRoutes(
      `/api/conversational/execution-attempts/${crashAttemptId}/resolve`,
      'POST',
      resolutionEvent(crashAttemptId, ADMIN_ID, foundRequest),
      client,
      { now: () => LATER }
    );
    assert.equal(found?.statusCode, 200);
    assert.doesNotMatch(found!.body, /https:\/\/typefully\.com/);
    assert.match(found!.body, /"outcome":"found"/);
    assert.match(found!.body, /"proofClassification":"exact_match"/);
    assert.doesNotMatch(found!.body, /188312|transaction-worker-token/);
    const manualNotification = await getResultNotification(
      client,
      `result-notification-manual-${crashAttemptId}`,
      LATER
    );
    assert.ok(manualNotification);
    const manualPayload = await getConversationalPrivatePayload(
      client,
      CONVERSATION_ID,
      manualNotification!.privatePayloadRef,
      ACTOR_ID,
      LATER
    );
    assert.match(JSON.stringify(manualPayload?.content), /https:\/\/typefully\.com/);
    const duplicateFound = await handleConversationalExecutionRoutes(
      `/api/conversational/execution-attempts/${crashAttemptId}/resolve`,
      'POST',
      resolutionEvent(crashAttemptId, ADMIN_ID, foundRequest),
      client,
      { now: () => LATER }
    );
    assert.equal(duplicateFound?.statusCode, 200);
    assert.equal(providerCalls, beforeCrashCalls, 'manual resolution must never call Typefully');

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Authorization drift X post'],
      linkedinPosts: ['Authorization drift LinkedIn post'],
    };
    const driftApproval = await present(core, 3);
    await authorize(2, false);
    const drifted = await core.handle({
      ...input('', 'approve-drift'),
      kind: 'button_action',
      action: driftApproval,
    });
    assert.match(drifted.message, /stale or expired/i);
    assert.equal(providerCalls, beforeCrashCalls);

    await authorize(3, true);
    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Preflight-disabled X post'],
      linkedinPosts: ['Preflight-disabled LinkedIn post'],
    };
    const disabledApproval = await present(core, 4);
    const approvedDisabled = await core.handle({
      ...input('', 'approve-disabled'),
      kind: 'button_action',
      action: disabledApproval,
    });
    const disabledAttemptId = approvedDisabled.message.match(/attempt-[a-f0-9]+/)?.[0];
    assert.ok(disabledAttemptId);
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
    const disabledResult = await processAttempt(disabledAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'preflight-disabled-worker',
      attemptEnabled: (attempt) => (
        Boolean(attempt.permissionRef)
        && conversationalRolloutSnapshot().executionAttemptEnabled(attempt.permissionRef!)
      ),
    });
    assert.equal(disabledResult?.status, 'queued');
    assert.equal(disabledResult?.attemptNumber, 1);
    assert.equal(disabledResult?.leaseOwner, undefined);
    assert.equal(disabledResult?.dispatchStartedAt, undefined);
    assert.equal(providerCalls, beforeCrashCalls);

    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'true';
    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Revoked actor preflight X post'],
      linkedinPosts: ['Revoked actor preflight LinkedIn post'],
    };
    const revokedAttemptId = await approvedAttempt(core, 18, 'approve-revoked-preflight');
    await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `IDENTITY#telegram#${CHAT_ID}`, SK: 'META' },
      UpdateExpression: 'SET #status = :revoked, revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':revision': 2 },
    }));
    const revokedResult = await processAttempt(revokedAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'revoked-preflight-worker',
    });
    assert.equal(revokedResult?.status, 'failed_safe');
    assert.equal(revokedResult?.dispatchStartedAt, undefined);
    assert.equal(providerCalls, beforeCrashCalls);
    await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `IDENTITY#telegram#${CHAT_ID}`, SK: 'META' },
      UpdateExpression: 'SET #status = :active, revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':revision': 1 },
    }));

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Lease recovery X post'],
      linkedinPosts: ['Lease recovery LinkedIn post'],
    };
    const leaseAttemptId = await approvedAttempt(core, 13, 'approve-lease-recovery');
    const beforeLeaseCalls = providerCalls;
    await assert.rejects(() => processAttempt(leaseAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'lease-crash-worker',
      crashAfter: 'lease',
      config: { leaseSeconds: 60 },
    }));
    assert.equal(providerCalls, beforeLeaseCalls);
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => LATER,
      leaseOwner: () => 'lease-requeue-worker',
    });
    assert.equal((await getExecutionAttempt(client, leaseAttemptId, LATER))?.status, 'queued');
    assert.equal(providerCalls, beforeLeaseCalls);
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => AFTER_BACKOFF,
      leaseOwner: () => 'lease-retry-worker',
    });
    assert.equal(
      (await getExecutionAttempt(client, leaseAttemptId, AFTER_BACKOFF))?.status,
      'succeeded'
    );
    assert.equal(providerCalls, beforeLeaseCalls + 1);
    let postLeaseCalls = providerCalls;

    for (const boundary of ['send', 'response'] as const) {
      modelCandidate = {
        ...modelCandidate,
        xPosts: [`${boundary} boundary X post`],
        linkedinPosts: [`${boundary} boundary LinkedIn post`],
      };
      const boundaryAttemptId = await approvedAttempt(
        core,
        boundary === 'send' ? 14 : 15,
        `approve-${boundary}-boundary`
      );
      const beforeBoundaryCalls = providerCalls;
      const boundaryFetcher = (async () => {
        providerCalls += 1;
        if (boundary === 'send') throw new Error('synthetic transport response loss');
        return new Response(JSON.stringify({ status: 'draft' }), { status: 201 });
      }) as typeof fetch;
      assert.equal(await processAttempt(boundaryAttemptId, {
        client,
        registry: new ExecutorRegistry([workerExecutor(boundaryFetcher)]),
        now: () => NOW,
        leaseOwner: () => `${boundary}-boundary-worker`,
        config: { leaseSeconds: 60 },
      }), null);
      assert.equal(providerCalls, beforeBoundaryCalls + 1);
      await runRecovery({
        client,
        registry: new ExecutorRegistry([workerExecutor(boundaryFetcher)]),
        now: () => LATER,
        leaseOwner: () => `${boundary}-boundary-recovery`,
      });
      const boundaryAttempt = await getExecutionAttempt(client, boundaryAttemptId, LATER);
      assert.equal(boundaryAttempt?.status, 'outcome_unknown');
      assert.equal(boundaryAttempt?.resultReceipt, undefined);
      assert.equal(providerCalls, beforeBoundaryCalls + 1, `${boundary} loss must never replay`);
      const boundaryNotification = await getResultNotification(
        client,
        `result-notification-${boundaryAttemptId}`,
        LATER
      );
      const boundaryPayload = await getConversationalPrivatePayload(
        client,
        CONVERSATION_ID,
        boundaryNotification!.privatePayloadRef,
        ACTOR_ID,
        LATER
      );
      assert.doesNotMatch(JSON.stringify(boundaryPayload?.content), /typefully\.com|transaction-private/);
    }

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Executor response boundary X post'],
      linkedinPosts: ['Executor response boundary LinkedIn post'],
    };
    const responseAttemptId = await approvedAttempt(core, 16, 'approve-executor-response-boundary');
    const beforeResponseCalls = providerCalls;
    assert.equal(await processAttempt(responseAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'executor-response-worker',
      crashAfter: 'executor_response',
      config: { leaseSeconds: 60 },
    }), null);
    assert.equal(providerCalls, beforeResponseCalls + 1);
    assert.equal(
      await getConversationalPrivatePayload(
        client,
        CONVERSATION_ID,
        `execution-result-${responseAttemptId}`,
        ACTOR_ID,
        NOW
      ),
      null
    );
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => LATER,
      leaseOwner: () => 'executor-response-recovery',
    });
    const responseUnknown = await getExecutionAttempt(client, responseAttemptId, LATER);
    assert.equal(responseUnknown?.status, 'outcome_unknown');
    assert.equal(responseUnknown?.resultReceipt, undefined);
    assert.equal(providerCalls, beforeResponseCalls + 1);

    await runResultDispatcher({
      client,
      now: () => LATER,
      transport: {
        async sendPrivateMessage() {
          // Drain earlier terminal notifications so the next outbox crash is isolated.
        },
      },
    });
    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Atomic private result boundary X post'],
      linkedinPosts: ['Atomic private result boundary LinkedIn post'],
    };
    const atomicAttemptId = await approvedAttempt(core, 17, 'approve-atomic-result-boundary');
    let lostFinalizeResponse = false;
    const finalizeLossClient = {
      send: (async (command: unknown) => {
        const result = await client.send(command as never);
        if (
          !lostFinalizeResponse
          && command instanceof TransactWriteCommand
          && command.input.TransactItems?.some(
            (item) => item.Put?.Item?.recordType === 'conversational_private_payload'
          )
        ) {
          lostFinalizeResponse = true;
          throw new Error('synthetic response loss after atomic result commit');
        }
        return result;
      }) as DynamoDBDocumentClient['send'],
    } as DynamoDBDocumentClient;
    const beforeAtomicCalls = providerCalls;
    assert.equal(await processAttempt(atomicAttemptId, {
      client: finalizeLossClient,
      registry: new ExecutorRegistry([workerExecutor(undefined, finalizeLossClient)]),
      now: () => NOW,
      leaseOwner: () => 'atomic-result-worker',
      config: { leaseSeconds: 60 },
    }), null);
    assert.equal(lostFinalizeResponse, true);
    assert.equal(providerCalls, beforeAtomicCalls + 1);
    const atomicAttempt = await getExecutionAttempt(client, atomicAttemptId, NOW);
    assert.equal(atomicAttempt?.status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(atomicAttempt?.resultReceipt), /typefully\.com|transaction-private/);
    const atomicNotification = await getResultNotification(
      client,
      `result-notification-${atomicAttemptId}`,
      NOW
    );
    const atomicPayload = await getConversationalPrivatePayload(
      client,
      CONVERSATION_ID,
      atomicNotification!.privatePayloadRef,
      ACTOR_ID,
      NOW
    );
    assert.match(JSON.stringify(atomicPayload?.content), /https:\/\/typefully\.com/);
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => LATER,
      leaseOwner: () => 'atomic-result-recovery',
    });
    assert.equal(providerCalls, beforeAtomicCalls + 1, 'committed result must not replay');
    const outboxMessages: string[] = [];
    await assert.rejects(() => dispatchOne(atomicNotification!, {
      client,
      now: () => NOW,
      leaseSeconds: 60,
      crashAfterClaim: true,
      transport: {
        async sendPrivateMessage(_chatId, message) {
          outboxMessages.push(message);
        },
      },
    }));
    assert.equal(outboxMessages.length, 0);
    await runResultDispatcher({
      client,
      now: () => LATER,
      transport: {
        async sendPrivateMessage(_chatId, message) {
          outboxMessages.push(message);
        },
      },
    });
    assert.equal(
      (await getResultNotification(
        client,
        `result-notification-${atomicAttemptId}`,
        LATER
      ))?.status,
      'outcome_unknown'
    );
    assert.equal(outboxMessages.length, 0, 'expired outbox claim must never resend');
    for (const payloadFailure of ['missing', 'expired'] as const) {
      modelCandidate = {
        ...modelCandidate,
        xPosts: [`${payloadFailure} result payload X post`],
        linkedinPosts: [`${payloadFailure} result payload LinkedIn post`],
      };
      const failedAttemptId = await approvedAttempt(
        core,
        payloadFailure === 'missing' ? 19 : 20,
        `approve-${payloadFailure}-result-payload`
      );
      const rejectionFetcher = (async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ error: 'rejected' }), { status: 422 });
      }) as typeof fetch;
      const failedAttempt = await processAttempt(failedAttemptId, {
        client,
        registry: new ExecutorRegistry([workerExecutor(rejectionFetcher)]),
        now: () => NOW,
        leaseOwner: () => `${payloadFailure}-result-worker`,
      });
      assert.equal(failedAttempt?.status, 'failed_safe');
      const notificationId = `result-notification-${failedAttemptId}`;
      let failedNotification = await getResultNotification(client, notificationId, NOW);
      assert.equal(failedNotification?.status, 'pending');
      if (payloadFailure === 'missing') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `RESULT_NOTIFICATION#${notificationId}`, SK: 'META' },
          UpdateExpression: 'SET privatePayloadRef = :missing',
          ExpressionAttributeValues: { ':missing': 'guessed-or-deleted-private-payload' },
        }));
      } else {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRIVATE_PAYLOAD#${failedNotification!.privatePayloadRef}`, SK: 'META' },
          UpdateExpression: 'SET expiresAt = :expired, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':expired': '2026-07-29T12:00:00.000Z',
            ':ttl': Math.floor(Date.parse('2026-07-29T12:00:00.000Z') / 1_000),
          },
        }));
      }
      failedNotification = await getResultNotification(client, notificationId, NOW);
      const leakedMessages: string[] = [];
      assert.equal(await dispatchOne(failedNotification!, {
        client,
        now: () => NOW,
        transport: {
          async sendPrivateMessage(_chatId, message) {
            leakedMessages.push(message);
          },
        },
      }), 'outcome_unknown');
      assert.deepEqual(leakedMessages, []);
      assert.equal(
        (await getResultNotification(client, notificationId, NOW))?.status,
        'outcome_unknown'
      );
    }
    postLeaseCalls = providerCalls;

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Not-found reconciliation X post'],
      linkedinPosts: ['Not-found reconciliation LinkedIn post'],
    };
    const notFoundApproval = await present(core, 5);
    const approvedNotFound = await core.handle({
      ...input('', 'approve-not-found'),
      kind: 'button_action',
      action: notFoundApproval,
    });
    const notFoundAttemptId = approvedNotFound.message.match(/attempt-[a-f0-9]+/)?.[0];
    assert.ok(notFoundAttemptId);
    await assert.rejects(() => processAttempt(notFoundAttemptId, {
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => NOW,
      leaseOwner: () => 'not-found-crash-worker',
      crashAfter: 'dispatch_marker',
      config: { leaseSeconds: 60 },
    }));
    await runRecovery({
      client,
      registry: new ExecutorRegistry([workerExecutor()]),
      now: () => LATER,
      leaseOwner: () => 'not-found-recovery-worker',
    });
    const notFoundUnknown = await getExecutionAttempt(client, notFoundAttemptId, LATER);
    assert.equal(notFoundUnknown?.status, 'outcome_unknown');
    const notFound = await handleConversationalExecutionRoutes(
      `/api/conversational/execution-attempts/${notFoundAttemptId}/resolve`,
      'POST',
      resolutionEvent(notFoundAttemptId, ADMIN_ID, {
        revision: notFoundUnknown!.revision,
        outcome: 'not_found',
        proofClassification: 'accepted_search_complete',
      }),
      client,
      { now: () => LATER }
    );
    assert.equal(notFound?.statusCode, 200);
    assert.match(notFound!.body, /"outcome":"not_found"/);
    assert.doesNotMatch(notFound!.body, /typefully\.com|188312|transaction-worker-token/);
    const notFoundNotification = await getResultNotification(
      client,
      `result-notification-manual-${notFoundAttemptId}`,
      LATER
    );
    const notFoundPayload = await getConversationalPrivatePayload(
      client,
      CONVERSATION_ID,
      notFoundNotification!.privatePayloadRef,
      ACTOR_ID,
      LATER
    );
    assert.match(JSON.stringify(notFoundPayload?.content), /Create a new proposal before another attempt/);
    assert.equal(providerCalls, postLeaseCalls, 'not_found reconciliation must never replay');

    for (const drift of ['cross_owner', 'policy', 'expired_payload'] as const) {
      modelCandidate = {
        ...modelCandidate,
        xPosts: [`${drift} source drift X post`],
        linkedinPosts: [`${drift} source drift LinkedIn post`],
      };
      const driftAttemptId = await approvedAttempt(
        core,
        drift === 'cross_owner' ? 6 : drift === 'policy' ? 7 : 8,
        `approve-source-${drift}`
      );
      const current = await currentAttemptDraft(driftAttemptId);
      const draftData = structuredClone(current.draft.data) as Record<string, JsonValue>;
      const proofGrants = structuredClone(draftData.proof) as Record<string, JsonValue>;
      const proof = (proofGrants.proofs as Array<Record<string, JsonValue>>)[0];
      if (drift === 'cross_owner') proof.actorId = 'another-actor';
      if (drift === 'policy') proof.policyDigest = `sha256:${'9'.repeat(64)}`;
      draftData.proof = proofGrants;
      if (drift === 'expired_payload') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRIVATE_PAYLOAD#${String(proof.payloadRef)}`, SK: 'META' },
          UpdateExpression: 'SET expiresAt = :expired, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':expired': '2026-07-29T12:00:00.000Z',
            ':ttl': Math.floor(Date.parse('2026-07-29T12:00:00.000Z') / 1_000),
          },
        }));
      } else {
        await savePluginDraft(client, {
          ...current.draft,
          data: draftData,
          revision: current.draft.revision + 1,
        }, current.draft.revision);
      }
      const driftResult = await processAttempt(driftAttemptId, {
        client,
        registry: new ExecutorRegistry([workerExecutor()]),
        now: () => NOW,
        leaseOwner: () => `source-drift-${drift}`,
      });
      assert.equal(driftResult?.status, 'failed_safe');
      assert.equal(driftResult?.dispatchStartedAt, undefined);
      assert.equal(providerCalls, postLeaseCalls);
    }
    let approvalDriftRevision = 4;
    for (const [name, overrides] of [
      ['scope', {
        allowedResourceKeys: ['typefully:account:datatalksclub'],
        accountScopeDigest: approvalScopeDigest(['typefully:account:datatalksclub']),
      }],
      ['config', { accountConfigDigest: `sha256:${'7'.repeat(64)}` }],
      ['delivery', { deliveryModeDigest: `sha256:${'6'.repeat(64)}` }],
    ] as const) {
      modelCandidate = {
        ...modelCandidate,
        xPosts: [`Approval ${name} drift X post`],
        linkedinPosts: [`Approval ${name} drift LinkedIn post`],
      };
      const driftAction = await present(core, 30 + approvalDriftRevision);
      await authorize(
        approvalDriftRevision,
        true,
        'allowedResourceKeys' in overrides
          ? {
            allowedResourceKeys: [...overrides.allowedResourceKeys],
            accountScopeDigest: overrides.accountScopeDigest,
          }
          : { ...overrides }
      );
      const driftApprovalResult = await core.handle({
        ...input('', `approve-${name}-drift`),
        kind: 'button_action',
        action: driftAction,
      });
      assert.match(driftApprovalResult.message, /stale or expired/i);
      assert.equal(providerCalls, postLeaseCalls);
      approvalDriftRevision += 1;
      await authorize(approvalDriftRevision, true);
      approvalDriftRevision += 1;
    }

    modelCandidate = {
      ...modelCandidate,
      xPosts: ['Marker TOCTOU X post'],
      linkedinPosts: ['Marker TOCTOU LinkedIn post'],
    };
    const toctouAttemptId = await approvedAttempt(core, 9, 'approve-marker-toctou');
    const leased = await claimQueuedAttempt(
      client,
      toctouAttemptId,
      'marker-toctou-worker',
      NOW.toISOString(),
      '2026-07-30T12:01:00.000Z'
    );
    assert.ok(leased);
    const toctouExecutor = workerExecutor();
    const preflight = await toctouExecutor.preflight({
      spec: (await currentAttemptDraft(toctouAttemptId)).proposal.spec,
      attempt: leased!,
      now: NOW,
    });
    assert.equal(preflight.kind, 'ready');
    const currentToctou = await currentAttemptDraft(toctouAttemptId);
    await savePluginDraft(client, {
      ...currentToctou.draft,
      revision: currentToctou.draft.revision + 1,
    }, currentToctou.draft.revision);
    assert.equal(
      await markDispatchStarted(
        client,
        leased!,
        NOW.toISOString(),
        preflight.kind === 'ready' ? preflight.dispatchGuard : undefined
      ),
      null
    );
    assert.equal((await getExecutionAttempt(client, toctouAttemptId, NOW))?.dispatchStartedAt, undefined);
    assert.equal(providerCalls, postLeaseCalls);

    for (const race of ['user_disabled', 'identity_revoked', 'channel_rebound'] as const) {
      modelCandidate = {
        ...modelCandidate,
        xPosts: [`${race} marker race X post`],
        linkedinPosts: [`${race} marker race LinkedIn post`],
      };
      const raceAttemptId = await approvedAttempt(
        core,
        race === 'user_disabled' ? 10 : race === 'identity_revoked' ? 11 : 12,
        `approve-marker-${race}`
      );
      const raceLeased = await claimQueuedAttempt(
        client,
        raceAttemptId,
        `marker-${race}-worker`,
        NOW.toISOString(),
        '2026-07-30T12:01:00.000Z'
      );
      assert.ok(raceLeased);
      const raceExecutor = workerExecutor();
      const raceProposal = (await currentAttemptDraft(raceAttemptId)).proposal;
      const racePreflight = await raceExecutor.preflight({
        spec: raceProposal.spec,
        attempt: raceLeased!,
        now: NOW,
      });
      assert.equal(racePreflight.kind, 'ready');
      if (race === 'user_disabled') {
        await client.send(new UpdateCommand({
          TableName: TABLE_USERS,
          Key: { PK: `USER#${ACTOR_ID}`, SK: `USER#${ACTOR_ID}` },
          UpdateExpression: 'SET disabled = :true',
          ExpressionAttributeValues: { ':true': true },
        }));
      } else if (race === 'identity_revoked') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `IDENTITY#telegram#${CHAT_ID}`, SK: 'META' },
          UpdateExpression: 'SET #status = :revoked, revision = :revision',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':revision': 2 },
        }));
      } else {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `CHANNEL#telegram#${CHAT_ID}`, SK: 'BINDING' },
          UpdateExpression: 'SET id = :rebound',
          ExpressionAttributeValues: { ':rebound': 'rebound-channel-binding' },
        }));
      }
      assert.equal(await markDispatchStarted(
        client,
        raceLeased!,
        NOW.toISOString(),
        racePreflight.kind === 'ready' ? racePreflight.dispatchGuard : undefined
      ), null);
      assert.equal((await getExecutionAttempt(client, raceAttemptId, NOW))?.dispatchStartedAt, undefined);
      if (race === 'user_disabled') {
        await client.send(new UpdateCommand({
          TableName: TABLE_USERS,
          Key: { PK: `USER#${ACTOR_ID}`, SK: `USER#${ACTOR_ID}` },
          UpdateExpression: 'SET disabled = :false',
          ExpressionAttributeValues: { ':false': false },
        }));
      } else if (race === 'identity_revoked') {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `IDENTITY#telegram#${CHAT_ID}`, SK: 'META' },
          UpdateExpression: 'SET #status = :active, revision = :revision',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'active', ':revision': 1 },
        }));
      } else {
        await client.send(new UpdateCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `CHANNEL#telegram#${CHAT_ID}`, SK: 'BINDING' },
          UpdateExpression: 'SET id = :binding',
          ExpressionAttributeValues: { ':binding': 'typefully-transaction-channel' },
        }));
      }
      assert.equal(providerCalls, postLeaseCalls);
    }
    const raceSource = await core.handle(input(
      'Typed public social source 201 for an exact Typefully approval change race',
      'approval-change-race-source'
    ));
    assert.match(raceSource.message, new RegExp(TYPEFULLY_PUBLIC_CONFIRMATION, 'i'));
    const racePreview = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'approval-change-race-confirm'
    ));
    const raceApprove = racePreview.buttons!.find(
      (button) => button.text === 'Approve and add to Typefully'
    )!.action;
    const raceChange = racePreview.buttons!.find(
      (button) => button.text === 'Request changes'
    )!.action;
    const raceResults = await Promise.all([
      core.handle({
        ...input('', 'approval-change-race-approve'),
        kind: 'button_action',
        action: raceApprove,
      }),
      core.handle({
        ...input('', 'approval-change-race-change'),
        kind: 'button_action',
        action: raceChange,
      }),
    ]);
    assert.equal(
      raceResults.filter((result) => (
        /queued safely|what should I change/i.test(result.message)
      )).length,
      1,
      'approve and request changes must have exactly one transaction winner'
    );

    await core.handle(input(
      'Typed public social source 202 for an exact Typefully duplicate change click',
      'duplicate-change-source'
    ));
    const duplicatePreview = await core.handle(input(
      TYPEFULLY_PUBLIC_CONFIRMATION,
      'duplicate-change-confirm'
    ));
    const duplicateChange = duplicatePreview.buttons!.find(
      (button) => button.text === 'Request changes'
    )!.action;
    const firstChange = await core.handle({
      ...input('', 'duplicate-change-first'),
      kind: 'button_action',
      action: duplicateChange,
    });
    const repeatedChange = await core.handle({
      ...input('', 'duplicate-change-second'),
      kind: 'button_action',
      action: duplicateChange,
    });
    assert.match(firstChange.message, /what should I change/i);
    assert.equal(repeatedChange.message, firstChange.message);

    const privateAfterRetention = await getConversationalPrivatePayload(
      client,
      CONVERSATION_ID,
      notification!.privatePayloadRef,
      ACTOR_ID,
      AFTER_PRIVATE_RETENTION
    ).catch(() => null);
    assert.equal(privateAfterRetention, null, 'private Typefully edit URL must expire after 30 days');
    const retainedAttempt = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      ConsistentRead: true,
    }));
    assert.ok(retainedAttempt.Item);
    assert.ok(Date.parse(String(retainedAttempt.Item!.expiresAt)) > AFTER_PRIVATE_RETENTION.getTime());
    assert.match(JSON.stringify(retainedAttempt.Item!.resultReceipt), /typefully-/);
    assert.doesNotMatch(
      JSON.stringify(retainedAttempt.Item!.resultReceipt),
      /typefully\.com|transaction-private|transaction-worker-token|188312/
    );
    await assert.rejects(() => authorize(3, true), /conditional|requested resource/i);
  });
});
