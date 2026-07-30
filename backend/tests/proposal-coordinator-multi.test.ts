import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal, stopLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createUserWithId } from '../src/db/users';
import {
  createChannelBinding,
  createConversation,
  createIdentityBinding,
  listProposalVersions,
} from '../src/conversation/repository';
import { putApprovalPermission } from '../src/conversation/executionRepository';
import { ExecutorRegistry } from '../src/conversation/execution';
import { FakeCapabilityExecutor } from '../src/conversation/executionWorker';
import {
  StaticPluginRegistry,
  generateRegistryMetadata,
  type PluginDefinition,
  type PluginResult,
} from '../src/conversation/pluginRegistry';
import {
  StaticProposalCoordinator,
  TodoProposalAdapter,
  type ProposalAdapter,
  type ProposalAdapterContext,
  type ProposalPresentationCopy,
  type ProposalSourcePreflight,
} from '../src/conversation/proposalCoordinator';
import { ConversationalProposalCore } from '../src/conversation/todoCore';
import {
  TODO_ACTION,
  TODO_PERMISSION,
  TODO_PLUGIN_ID,
  loadTodoPluginArtifact,
  todoPluginDefinition,
} from '../src/conversation/todoPlugin';
import { ActorTodoExecutor } from '../src/conversation/todoWriter';
import { expiryFrom, type JsonValue, type PluginDraft, type ProposalSpec } from '../src/conversation/types';
import type {
  ConversationalModel,
  ModelRequest,
  ModelResponse,
} from '../src/conversation/zaiClient';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const ACTOR_ID = 'actor-multi-adapter';
const CONVERSATION_ID = 'conversation-multi-adapter';
const CHAT_ID = '9301';
const SYNTHETIC_PLUGIN_ID = 'synthetic.typefully';
const SYNTHETIC_ACTION = 'propose_saved_draft';
const SYNTHETIC_PERMISSION = 'typefully:create-saved-draft';
const SYNTHETIC_EFFECT = 'synthetic.typefully.saved_draft';
const SYNTHETIC_POLICY_DIGEST = `sha256:${'c'.repeat(64)}`;
const SYNTHETIC_ARTIFACT_ID = 'test-build/synthetic-typefully.js';
const SYNTHETIC_COMPILED_MODULE = 'synthetic-typefully-v1';

function syntheticValidator(action: string, input: unknown): PluginResult {
  if (
    action !== SYNTHETIC_ACTION
    || !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).length !== 1
    || typeof (input as Record<string, unknown>).draftText !== 'string'
  ) return { kind: 'clarification', message: 'A saved draft needs text.' };
  return { kind: 'proposal_candidate', value: input };
}

const syntheticManifest: Omit<PluginDefinition, 'buildDigest' | 'schemaDigest'> = {
  id: SYNTHETIC_PLUGIN_ID,
  version: 'test-v1',
  displayName: 'Synthetic Typefully',
  summary: 'Prepare a synthetic saved social draft for coordinator testing.',
  activationHints: ['prepare a social post', 'save a draft'],
  skillInstructions: 'Prepare one saved draft. Never publish or execute directly.',
  actions: [{
    name: SYNTHETIC_ACTION,
    description: 'Prepare one saved social draft.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draftText: { type: 'string', minLength: 1, maxLength: 280 },
      },
      required: ['draftText'],
    },
    effect: 'proposal',
    corePermission: SYNTHETIC_PERMISSION,
    externalEffect: false,
    reconciliationMode: 'provider_idempotency',
    executorDeclaration: 'SyntheticTypefullyExecutor.test',
  }],
  validator: syntheticValidator,
  validatorDeclaration: 'syntheticValidator.test-v1',
  proposalRenderer: (_action, input) => input,
  proposalRendererDeclaration: 'syntheticRenderer.test-v1',
  enabled: true,
  roles: ['admin', 'operator'],
  channels: ['telegram'],
  buildArtifactId: SYNTHETIC_ARTIFACT_ID,
};
const syntheticMetadata = generateRegistryMetadata(
  syntheticManifest,
  SYNTHETIC_COMPILED_MODULE
);
const syntheticPlugin: PluginDefinition = {
  ...syntheticManifest,
  ...syntheticMetadata,
};

class TrackingTodoAdapter extends TodoProposalAdapter {
  constructor(private readonly order: string[]) {
    super();
  }

  override preflightSource(
    text: string,
    conversationRevision: number,
    existingDraft: PluginDraft | null
  ): ProposalSourcePreflight {
    this.order.push(`preflight:${TODO_PLUGIN_ID}`);
    return super.preflightSource(text, conversationRevision, existingDraft);
  }
}

class SyntheticProposalAdapter implements ProposalAdapter {
  readonly pluginId = SYNTHETIC_PLUGIN_ID;
  readonly action = SYNTHETIC_ACTION;
  readonly permissionRef = SYNTHETIC_PERMISSION;
  readonly buildDigest = syntheticMetadata.buildDigest;
  readonly schemaDigest = syntheticMetadata.schemaDigest;
  readonly policyDigest = SYNTHETIC_POLICY_DIGEST;

  constructor(private readonly order: string[]) {}

  isEnabled(): boolean {
    return true;
  }

  preflightSource(
    text: string,
    conversationRevision: number
  ): ProposalSourcePreflight {
    this.order.push(`preflight:${this.pluginId}`);
    return {
      kind: 'ready',
      proof: {
        kind: 'synthetic_typefully_source_proof',
        sourceRevision: conversationRevision,
        selectedTextLength: text.length,
      },
    };
  }

  draftData(candidate: JsonValue, proof: JsonValue): JsonValue {
    return {
      kind: 'synthetic_typefully_candidate',
      candidate,
      proof,
    };
  }

  validateCandidate(value: unknown): JsonValue | null {
    const validated = syntheticValidator(this.action, value);
    return validated.kind === 'proposal_candidate'
      ? validated.value as JsonValue
      : null;
  }

  draftId(_conversationId: string, actorId: string): string {
    return `synthetic-typefully-draft-${actorId}`;
  }

  proposalId(draftId: string): string {
    return `synthetic-typefully-proposal-${draftId}`;
  }

  buildSpec(candidate: JsonValue, context: ProposalAdapterContext): ProposalSpec {
    const draft = context.draft.data as Record<string, JsonValue>;
    const proof = draft.proof as Record<string, JsonValue>;
    if (
      draft.kind !== 'synthetic_typefully_candidate'
      || proof?.kind !== 'synthetic_typefully_source_proof'
    ) throw new Error('Synthetic source proof is unavailable');
    return {
      pluginId: this.pluginId,
      pluginBuildDigest: this.buildDigest,
      schemaDigest: this.schemaDigest,
      policyDigest: this.policyDigest,
      action: this.action,
      operation: 'create',
      effect: SYNTHETIC_EFFECT,
      destinationRef: 'synthetic.typefully.saved_drafts',
      proposedContent: {
        draftText: (candidate as Record<string, JsonValue>).draftText,
        actorId: context.actorId,
      },
      sourceRefs: [{
        ref: `plugin-draft:${context.draft.id}`,
        revision: String(context.draft.revision),
        classification: 'private',
      }, {
        ref: `synthetic-typefully-proof:${proof.sourceRevision}`,
        revision: String(proof.sourceRevision),
        classification: 'internal',
      }],
      permissionRef: this.permissionRef,
      permissionRevision: context.permissionRevision,
      expiresAt: context.expiresAt,
    };
  }

  presentation(candidate: JsonValue): ProposalPresentationCopy {
    const draftText = String((candidate as Record<string, JsonValue>).draftText);
    return {
      message: `Saved social draft\nDraft: ${draftText}`,
      approveLabel: 'Approve saved draft',
      requestChangesLabel: 'Request changes',
      cancelLabel: 'Cancel proposal',
      discardLabel: 'Discard draft',
      changePrompt: 'What should I change in the saved draft?',
      canceledMessage: 'Saved draft proposal canceled.',
      discardedMessage: 'Saved draft discarded.',
      pendingMessage: (attemptId) => `Saved draft approved and queued: ${attemptId}`,
    };
  }
}

function registry(): StaticPluginRegistry {
  return new StaticPluginRegistry([
    { ...todoPluginDefinition, enabled: true },
    syntheticPlugin,
  ], (artifactId) => {
    if (artifactId === SYNTHETIC_ARTIFACT_ID) {
      return {
        compiledModule: SYNTHETIC_COMPILED_MODULE,
        validator: syntheticValidator,
        proposalRenderer: syntheticManifest.proposalRenderer,
      };
    }
    return loadTodoPluginArtifact(artifactId);
  });
}

describe('generic proposal coordinator with two enabled adapters', {
  skip: !process.env.DYNAMODB_ENDPOINT,
}, () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'todo,typefully';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'true';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'true';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'none';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
  });

  it('selects, preflights, revises, and approves each adapter without cross-plugin context or proof', async () => {
    await createUserWithId(client, ACTOR_ID, {
      name: 'Multi adapter operator',
      email: 'multi-adapter@example.test',
      role: 'operator',
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
      id: 'identity-multi-adapter',
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
      id: 'channel-multi-adapter',
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
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: TODO_PERMISSION,
      enabled: true,
      revision: 1,
    });
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: SYNTHETIC_PERMISSION,
      enabled: true,
      revision: 1,
    });

    const order: string[] = [];
    const coordinator = new StaticProposalCoordinator([
      new TrackingTodoAdapter(order),
      new SyntheticProposalAdapter(order),
    ]);
    const syntheticExecutor = new FakeCapabilityExecutor(
      SYNTHETIC_EFFECT,
      syntheticMetadata.buildDigest,
      SYNTHETIC_PERMISSION,
      'provider_idempotency',
      () => NOW
    );
    const executionRegistry = new ExecutorRegistry([
      new ActorTodoExecutor(client),
      syntheticExecutor,
    ]);
    let selectedPlugin = TODO_PLUGIN_ID;
    let todoDescription = 'Prepare the agenda';
    let socialDraft = 'First social draft';
    let crossPluginInvoke = false;
    let expectBothCatalog = true;
    const requests: ModelRequest[] = [];
    const model: ConversationalModel = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request);
        if (request.expectedTool === 'skill_load') {
          assert.match(request.system, /"id":"todo"/);
          if (expectBothCatalog) {
            assert.match(request.system, /"id":"synthetic.typefully"/);
          } else {
            assert.doesNotMatch(request.system, /"id":"synthetic.typefully"/);
          }
          assert.doesNotMatch(JSON.stringify(request), /private-(?:todo|social)-context/);
          return {
            kind: 'tool',
            name: 'skill_load',
            input: { plugin: selectedPlugin },
          };
        }
        const nonce = request.system.match(/"loadNonce":"([^"]+)"/)?.[1];
        assert.ok(nonce);
        assert.match(
          JSON.stringify(request.messages),
          new RegExp(`private-${selectedPlugin === TODO_PLUGIN_ID ? 'todo' : 'social'}-context`)
        );
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          new RegExp(`private-${selectedPlugin === TODO_PLUGIN_ID ? 'social' : 'todo'}-context`)
        );
        const invokePlugin = crossPluginInvoke ? TODO_PLUGIN_ID : selectedPlugin;
        return {
          kind: 'tool',
          name: 'skill_invoke',
          input: {
            plugin: invokePlugin,
            action: invokePlugin === TODO_PLUGIN_ID ? TODO_ACTION : SYNTHETIC_ACTION,
            input: invokePlugin === TODO_PLUGIN_ID
              ? { description: todoDescription, date: '2026-08-06' }
              : { draftText: socialDraft },
            load_nonce: nonce,
          },
        };
      },
    };
    const selectedContextCounts = new Map<string, number>();
    const core = new ConversationalProposalCore({
      client,
      model,
      now: () => NOW,
      coordinator,
      registry: registry(),
      executionRegistry,
      selectedContextProvider: async (_input, selection) => {
        order.push(`context:${selection.pluginId}`);
        selectedContextCounts.set(
          selection.pluginId,
          (selectedContextCounts.get(selection.pluginId) || 0) + 1
        );
        return {
          sourceExcerpts: [{
            reference: `private-${selection.pluginId}-source`,
            revision: '1',
            text: selection.pluginId === TODO_PLUGIN_ID
              ? 'private-todo-context'
              : 'private-social-context',
          }],
        };
      },
    });
    const input = (text: string, updateId: string) => ({
      kind: 'message' as const,
      conversationId: CONVERSATION_ID,
      conversationRevision: 1,
      actor: { id: ACTOR_ID, role: 'operator' as const, channel: 'telegram' as const },
      text,
      inputTrust: 'operator_authored' as const,
      provenance: { updateId, chatId: CHAT_ID, channelUserId: CHAT_ID },
    });
    const click = (action: JsonValue, updateId: string) => core.handle({
      ...input('', updateId),
      kind: 'button_action',
      action,
    });

    const todoPreview = await core.handle(input('Prepare the agenda on 2026-08-06', 'multi-todo-1'));
    assert.match(todoPreview.message, /Prepare the agenda/);
    const oldTodoApproval = todoPreview.buttons?.find(
      (button) => button.text === 'Approve todo'
    )?.action;
    const todoChanges = todoPreview.buttons?.find(
      (button) => button.text === 'Request changes'
    )?.action;
    assert.ok(oldTodoApproval && todoChanges);
    await click(todoChanges, 'multi-todo-change');
    todoDescription = 'Prepare the revised agenda';
    const revisedTodo = await core.handle(input('Use the revised agenda wording', 'multi-todo-2'));
    assert.match(revisedTodo.message, /Prepare the revised agenda/);
    assert.match((await click(oldTodoApproval, 'multi-todo-stale')).message, /stale or expired/i);
    const revisedTodoApproval = revisedTodo.buttons?.find(
      (button) => button.text === 'Approve todo'
    )?.action;
    assert.ok(revisedTodoApproval);
    assert.match((await click(revisedTodoApproval, 'multi-todo-approve')).message, /queued safely/i);

    selectedPlugin = SYNTHETIC_PLUGIN_ID;
    const socialPreview = await core.handle(input('Prepare a saved social post', 'multi-social-1'));
    assert.match(socialPreview.message, /First social draft/);
    const oldSocialApproval = socialPreview.buttons?.find(
      (button) => button.text === 'Approve saved draft'
    )?.action;
    const socialChanges = socialPreview.buttons?.find(
      (button) => button.text === 'Request changes'
    )?.action;
    assert.ok(oldSocialApproval && socialChanges);
    await click(socialChanges, 'multi-social-change');
    socialDraft = 'Revised social draft';
    const revisedSocial = await core.handle(input('Revise the saved social draft', 'multi-social-2'));
    assert.match(revisedSocial.message, /Revised social draft/);
    assert.match((await click(oldSocialApproval, 'multi-social-stale')).message, /stale or expired/i);
    const revisedSocialApproval = revisedSocial.buttons?.find(
      (button) => button.text === 'Approve saved draft'
    )?.action;
    assert.ok(revisedSocialApproval);
    assert.match((await click(revisedSocialApproval, 'multi-social-approve')).message, /approved and queued/i);

    const todoVersions = await listProposalVersions(
      client,
      new TrackingTodoAdapter([]).proposalId(
        new TrackingTodoAdapter([]).draftId(CONVERSATION_ID, ACTOR_ID)
      )
    );
    const socialAdapter = new SyntheticProposalAdapter([]);
    const socialVersions = await listProposalVersions(
      client,
      socialAdapter.proposalId(socialAdapter.draftId(CONVERSATION_ID, ACTOR_ID))
    );
    assert.equal(todoVersions.items.length, 2);
    assert.equal(socialVersions.items.length, 2);
    for (const version of todoVersions.items) {
      assert.equal(version.spec.pluginId, TODO_PLUGIN_ID);
      assert.equal(version.spec.schemaDigest, todoPluginDefinition.schemaDigest);
      assert.ok(version.spec.sourceRefs.some((ref) => ref.ref.startsWith('todo-source-proof:')));
      assert.ok(version.spec.sourceRefs.every((ref) => !ref.ref.startsWith('synthetic-typefully-proof:')));
    }
    for (const version of socialVersions.items) {
      assert.equal(version.spec.pluginId, SYNTHETIC_PLUGIN_ID);
      assert.equal(version.spec.schemaDigest, syntheticMetadata.schemaDigest);
      assert.ok(version.spec.sourceRefs.some((ref) => ref.ref.startsWith('synthetic-typefully-proof:')));
      assert.ok(version.spec.sourceRefs.every((ref) => !ref.ref.startsWith('todo-source-proof:')));
    }
    assert.deepEqual(order.slice(0, 4), [
      'preflight:todo',
      'context:todo',
      'preflight:todo',
      'context:todo',
    ]);
    assert.equal(selectedContextCounts.get(TODO_PLUGIN_ID), 2);
    assert.equal(selectedContextCounts.get(SYNTHETIC_PLUGIN_ID), 2);

    const syntheticPreflightsBefore = order.filter(
      (entry) => entry === `preflight:${SYNTHETIC_PLUGIN_ID}`
    ).length;
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: SYNTHETIC_PERMISSION,
      enabled: false,
      revision: 2,
    });
    expectBothCatalog = false;
    const unauthorized = await core.handle(input('Prepare another social post', 'multi-social-unauthorized'));
    assert.equal(unauthorized.kind, 'error');
    assert.equal(order.filter(
      (entry) => entry === `preflight:${SYNTHETIC_PLUGIN_ID}`
    ).length, syntheticPreflightsBefore);
    await putApprovalPermission(client, {
      userId: ACTOR_ID,
      permissionRef: SYNTHETIC_PERMISSION,
      enabled: true,
      revision: 3,
    });
    expectBothCatalog = true;

    selectedPlugin = 'unknown.plugin';
    const unknown = await core.handle(input('Unknown action', 'multi-unknown'));
    assert.equal(unknown.kind, 'error');
    assert.equal(order.filter((entry) => entry.startsWith('preflight:')).length, 4);

    selectedPlugin = SYNTHETIC_PLUGIN_ID;
    crossPluginInvoke = true;
    const confused = await core.handle(input('Cross the plugin schemas', 'multi-confused'));
    assert.equal(confused.kind, 'error');
    assert.equal((await listProposalVersions(
      client,
      socialAdapter.proposalId(socialAdapter.draftId(CONVERSATION_ID, ACTOR_ID))
    )).items.length, 2);
    assert.equal(requests.filter((request) => request.expectedTool === 'skill_load').length, 7);
  });
});
