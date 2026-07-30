import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CORE_PERMISSION_VALUES,
  PluginConfigurationError,
  StaticPluginRegistry,
  generateRegistryMetadata,
  type PluginDefinition,
  type PluginResult,
} from '../src/conversation/pluginRegistry';
import {
  ContextAssembler,
  ContextConfigurationError,
} from '../src/conversation/context';
import {
  ConversationalRuntime,
  nonceHash,
  validateSchema,
  type RuntimePersistence,
} from '../src/conversation/runtime';
import type { SkillLoadReceipt } from '../src/conversation/types';
import { validateConversationalRecord } from '../src/conversation/types';
import type {
  ConversationalModel,
  ModelRequest,
  ModelResponse,
} from '../src/conversation/zaiClient';

function rawPlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fake.todo',
    version: 'v1',
    displayName: 'Fake Todo',
    summary: 'Collect a todo proposal without executing it.',
    activationHints: ['remember a task'],
    skillInstructions: 'Collect a title and return a validated draft.',
    actions: [{
      name: 'create',
      description: 'Prepare a todo.',
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { title: { type: 'string', maxLength: 200 } },
        required: ['title'],
      },
      effect: 'proposal' as const,
      corePermission: 'todo:create:self' as const,
      executorDeclaration: 'future-todo-executor',
    }],
    validator: (_action: string, input: unknown): PluginResult => ({ kind: 'draft', value: input }),
    validatorDeclaration: 'validate',
    proposalRenderer: (_action: string, input: unknown) => input,
    proposalRendererDeclaration: 'renderProposal',
    enabled: true,
    roles: ['operator' as const],
    channels: ['telegram' as const],
    compiledModule: 'exports.validate = validateV1; exports.renderProposal = renderV1;',
    ...overrides,
  };
}

const compiledArtifacts = new Map<string, {
  compiledModule: string;
  validator: PluginDefinition['validator'];
  proposalRenderer?: PluginDefinition['proposalRenderer'];
}>();
let artifactSequence = 0;

function plugin(overrides: Record<string, unknown> = {}): PluginDefinition {
  const { compiledModule, ...manifest } = rawPlugin(overrides) as ReturnType<typeof rawPlugin>;
  const buildArtifactId = `test-artifact-${artifactSequence += 1}`;
  const definition = {
    ...manifest,
    buildArtifactId,
    ...generateRegistryMetadata({ ...manifest, buildArtifactId }, compiledModule),
  };
  compiledArtifacts.set(buildArtifactId, {
    compiledModule,
    validator: manifest.validator,
    proposalRenderer: manifest.proposalRenderer,
  });
  return definition;
}

function registry(plugins: PluginDefinition[]): StaticPluginRegistry {
  return new StaticPluginRegistry(plugins, (artifactId) => {
    const artifact = compiledArtifacts.get(artifactId);
    if (!artifact) throw new Error('artifact unavailable');
    return artifact;
  });
}

function metadata(raw: ReturnType<typeof rawPlugin>) {
  const { compiledModule, ...manifest } = raw;
  return generateRegistryMetadata(
    { ...manifest, buildArtifactId: 'build-output/fake.todo.js' },
    compiledModule
  );
}

test('registry is static, filtered, compact, and starts empty', () => {
  assert.deepEqual(CORE_PERMISSION_VALUES, [
    'todo:create:self',
    'typefully:create-saved-draft',
  ]);
  assert.equal(Object.isFrozen(CORE_PERMISSION_VALUES), true);
  assert.deepEqual(new StaticPluginRegistry([]).catalog('operator', 'telegram'), []);
  const catalogRegistry = registry([
    plugin(),
    plugin({ id: 'admin.only', roles: ['admin'], channels: ['web'] }),
    plugin({ id: 'disabled.plugin', enabled: false }),
  ]);
  assert.deepEqual(catalogRegistry.catalog('operator', 'telegram'), [{
    id: 'fake.todo',
    displayName: 'Fake Todo',
    summary: 'Collect a todo proposal without executing it.',
    activationHints: ['remember a task'],
  }]);
  assert.equal(catalogRegistry.getAvailable('admin.only', 'operator', 'telegram'), null);
  assert.throws(
    () => catalogRegistry.catalog('owner' as never, 'telegram'),
    PluginConfigurationError
  );
  assert.throws(
    () => catalogRegistry.catalog('operator', 'email' as never),
    PluginConfigurationError
  );
  assert.equal(catalogRegistry.getAvailable('fake.todo', 'owner' as never, 'telegram'), null);
  const loaded = catalogRegistry.getAvailable('fake.todo', 'operator', 'telegram')!;
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.actions[0]), true);
  loaded.actions[0].name = 'tampered';
  assert.equal(loaded.actions[0].name, 'create');
});

test('registry rejects unsafe or incomplete plugin contracts', () => {
  const invalid: Array<() => unknown> = [
    () => new StaticPluginRegistry([plugin()]),
    () => registry([plugin(), plugin()]),
    () => registry([plugin({ id: 'Not Canonical' })]),
    () => registry([plugin({ validator: undefined })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], inputSchema: {
        type: 'object', properties: {}, additionalProperties: true,
      } }],
    })]),
    () => registry([plugin({
      actions: [rawPlugin().actions[0], rawPlugin().actions[0]],
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], effect: 'execute' }],
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], corePermission: 'root:anything' }],
    })]),
    () => registry([plugin({
      actions: [{
        ...rawPlugin().actions[0], effect: 'read', corePermission: undefined,
        executorDeclaration: 'must-not-run',
      }],
      proposalRenderer: undefined,
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], corePermission: undefined }],
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], executorDeclaration: undefined }],
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], externalEffect: true, reconciliationMode: undefined }],
    })]),
    () => registry([plugin({
      actions: [{
        ...rawPlugin().actions[0],
        externalEffect: true,
        reconciliationMode: 'provider_idempotency',
        reconcilerDeclaration: undefined,
      }],
    })]),
    () => registry([{ ...plugin(), buildDigest: 'sha256:nope' }]),
    () => registry([plugin({ roles: ['owner'] })]),
    () => registry([plugin({ channels: ['email'] })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], reconciliationMode: 'retry-forever' }],
    })]),
    () => registry([plugin({
      actions: [{ ...rawPlugin().actions[0], inputSchema: {
        type: 'object', additionalProperties: false, properties: {},
        unevaluatedProperties: false,
      } }],
    })]),
  ];
  for (const create of invalid) assert.throws(create, PluginConfigurationError);
});

test('registry metadata is deterministic and covers semantic and code inputs', () => {
  const base = rawPlugin();
  assert.deepEqual(metadata(base), metadata(base));
  const baseMetadata = metadata(base);
  assert.notEqual(metadata({ ...base, skillInstructions: 'changed' }).buildDigest, baseMetadata.buildDigest);
  assert.notEqual(metadata({
    ...base,
    actions: [{ ...base.actions[0], inputSchema: {
      ...base.actions[0].inputSchema,
      properties: { title: { type: 'string', maxLength: 20 } },
    } }],
  }).schemaDigest, baseMetadata.schemaDigest);
  assert.notEqual(metadata({
    ...base,
    compiledModule: 'exports.validate = validateV2; exports.renderProposal = renderV1;',
  }).buildDigest, baseMetadata.buildDigest);
  assert.notEqual(metadata({
    ...base,
    compiledModule: 'exports.validate = validateV1; exports.renderProposal = renderV2;',
  }).buildDigest, baseMetadata.buildDigest);
  assert.notEqual(metadata({
    ...base,
    compiledModule: 'different-compiled-module',
  }).buildDigest, baseMetadata.buildDigest);
  assert.notEqual(metadata({
    ...base,
    actions: [{ ...base.actions[0], executorDeclaration: 'different-executor' }],
  }).buildDigest, baseMetadata.buildDigest);
  assert.notEqual(metadata({
    ...base,
    actions: [{ ...base.actions[0], reconcilerDeclaration: 'different-reconciler' }],
  }).buildDigest, baseMetadata.buildDigest);
  assert.throws(
    () => registry([{ ...plugin(), skillInstructions: 'tampered' }]),
    PluginConfigurationError
  );
  const staleBuild = plugin();
  compiledArtifacts.set(staleBuild.buildArtifactId, {
    ...compiledArtifacts.get(staleBuild.buildArtifactId)!,
    compiledModule: 'tampered compiled output',
  });
  assert.throws(
    () => registry([staleBuild]),
    PluginConfigurationError
  );
  const artifactBound = plugin();
  const loaded = registry([{
    ...artifactBound,
    validator: () => ({ kind: 'clarification', message: 'untrusted replacement' }),
  }]).getAvailable('fake.todo', 'operator', 'telegram')!;
  assert.equal(loaded.validator('create', { title: 'kept' }).kind, 'draft');
});

test('strict schema validator enforces every supported constraint and combinator', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    minProperties: 5,
    maxProperties: 5,
    required: ['choice', 'mode', 'count', 'tags', 'code'],
    properties: {
      choice: { type: 'string', enum: ['allowed'] },
      mode: { type: 'string', const: 'fixed' },
      count: {
        type: 'integer', minimum: 2, maximum: 10,
        exclusiveMinimum: 1, exclusiveMaximum: 11, multipleOf: 2,
      },
      tags: {
        type: 'array', minItems: 2, maxItems: 2, uniqueItems: true,
        items: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
      },
      code: {
        type: 'string',
        allOf: [{ type: 'string', minLength: 2 }],
        anyOf: [{ type: 'string', const: 'ok' }, { type: 'string', const: 'go' }],
        oneOf: [{ type: 'string', const: 'ok' }, { type: 'string', const: 'no' }],
      },
    },
  };
  assert.equal(validateSchema(schema, {
    choice: 'allowed', mode: 'fixed', count: 4, tags: ['aa', 'bb'], code: 'ok',
  }), true);
  for (const invalid of [
    { choice: 'forbidden', mode: 'fixed', count: 4, tags: ['aa', 'bb'], code: 'ok' },
    { choice: 'allowed', mode: 'wrong', count: 4, tags: ['aa', 'bb'], code: 'ok' },
    { choice: 'allowed', mode: 'fixed', count: 3, tags: ['aa', 'bb'], code: 'ok' },
    { choice: 'allowed', mode: 'fixed', count: 4, tags: ['aa', 'aa'], code: 'ok' },
    { choice: 'allowed', mode: 'fixed', count: 4, tags: ['A', 'bb'], code: 'ok' },
    { choice: 'allowed', mode: 'fixed', count: 4, tags: ['aa', 'bb'], code: 'bad' },
  ]) assert.equal(validateSchema(schema, invalid), false);
});

test('schema const and enum literals reject every lossy or non-JSON value without aliasing null', () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  class CustomValue { value = 'not-json'; }
  const symbolObject = { valid: true } as Record<PropertyKey, unknown>;
  symbolObject[Symbol('ignored')] = 'lossy';
  const invalidLiterals: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    -0,
    undefined,
    1n,
    () => 'not-json',
    Symbol('not-json'),
    { nested: undefined },
    [null, undefined],
    sparse,
    new Date('2026-07-30T00:00:00.000Z'),
    /not-json/,
    new Map([['not', 'json']]),
    new Set(['not-json']),
    new CustomValue(),
    Buffer.from('binary'),
    symbolObject,
    cyclic,
    new Proxy({}, { getPrototypeOf() { throw new Error('hostile proxy'); } }),
  ];
  for (const literal of invalidLiterals) {
    for (const keyword of ['const', 'enum'] as const) {
      const built = plugin();
      const invalid = {
        ...built,
        actions: [{
          ...built.actions[0],
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false as const,
            properties: {
              value: {
                type: 'null',
                ...(keyword === 'const' ? { const: literal } : { enum: [literal] }),
              },
            },
            required: ['value'],
          },
        }],
      };
      assert.throws(() => registry([invalid]), PluginConfigurationError);
    }
  }

  const validNull = plugin({
    actions: [{
      ...rawPlugin().actions[0],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'null', const: null, enum: [null] } },
        required: ['value'],
      },
    }],
  });
  assert.ok(registry([validNull]).getAvailable('fake.todo', 'operator', 'telegram'));
  assert.equal(validateSchema({ type: 'null', const: null, enum: [null] }, null), true);
  assert.equal(validateSchema({ type: 'null', const: NaN }, null), false);
  assert.equal(validateSchema({ type: 'null', enum: [Infinity] }, null), false);
  assert.equal(validateSchema({ type: 'string', minLength: 4_000, maxLength: 4_000 }, '😀'.repeat(4_000)), true);
});

test('context assembler preserves mandatory policy, bounds optional layers, and stores only hashes', () => {
  const assembler = new ContextAssembler((value) => value.length, {
    maximumInput: 240,
    maximumOutput: 50,
    summary: 30,
    recentEvents: 80,
    sourceExcerpts: 50,
    proposalStateReference: 20,
  });
  const result = assembler.assemble({
    conversationId: 'conversation-1',
    conversationRevision: 4,
    coreRules: 'RULES-MUST-STAY',
    catalog: [{ id: 'fake.todo' }],
    summary: { checkpointId: 'summary-1', revision: 2, text: 's'.repeat(80) },
    recentEvents: [
      { sequence: 1, id: 'e1', text: 'old-' + 'x'.repeat(45) },
      { sequence: 2, id: 'e2', text: 'new-' + 'y'.repeat(35) },
    ],
    sourceExcerpts: [{ reference: 'source-private', revision: 'rev-1', text: 'z'.repeat(70) }],
    proposalStateReference: 'p'.repeat(30),
    provider: 'z.ai',
    model: 'glm-5.2',
  });
  assert.match(result.system, /RULES-MUST-STAY/);
  assert.ok(result.receipt.estimatedInputCount <= 240);
  assert.equal(JSON.stringify(result.receipt).includes('source-private'), false);
  assert.equal(JSON.stringify(result.receipt).includes('RULES-MUST-STAY'), false);
  assert.deepEqual(result.receipt.includedEventSequences.map((range) => range.from), [2]);
  assert.equal(result.receipt.truncation.summary, true);
  assert.equal(result.receipt.truncation.recentEvents, true);
  assert.equal(result.receipt.truncation.sourceExcerpts, true);
});

test('context assembler fails closed when mandatory rules exceed the budget', () => {
  assert.throws(() => new ContextAssembler((value) => value.length, {
    maximumInput: 5,
    maximumOutput: 1,
    summary: 0,
    recentEvents: 0,
    sourceExcerpts: 0,
    proposalStateReference: 0,
  }).assemble({
    conversationId: 'c',
    conversationRevision: 1,
    coreRules: 'mandatory',
    catalog: [],
    provider: 'z.ai',
    model: 'glm-5.2',
  }), ContextConfigurationError);
});

test('stored load/context receipts are five-minute and body-free records', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  validateConversationalRecord({
    id: 'load-1',
    recordType: 'skill_load_receipt',
    schemaVersion: 1,
    conversationId: 'conversation-1',
    conversationRevision: 2,
    actorId: 'user-1',
    role: 'operator',
    channel: 'telegram',
    pluginId: 'fake.todo',
    pluginBuildDigest: 'sha256:' + 'a'.repeat(64),
    schemaDigest: 'sha256:' + 'b'.repeat(64),
    loadNonceHash: 'sha256:' + 'c'.repeat(64),
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    ttl: Math.floor((now.getTime() + 300_000) / 1_000),
  });
  const contextBase = {
    id: 'context-1',
    recordType: 'context_receipt' as const,
    schemaVersion: 1,
    conversationId: 'conversation-1',
    conversationRevision: 2,
    algorithmVersion: 'context-v1',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    ttl: Math.floor((now.getTime() + 30 * 86_400_000) / 1_000),
  };
  validateConversationalRecord({ ...contextBase, receipt: { estimatedInputCount: 12 } });
  assert.throws(
    () => validateConversationalRecord({ ...contextBase, receipt: { prompt: 'private text' } }),
    /prompt is forbidden/
  );
  for (const receipt of [
    { nested: { prompt: 'private-body' } },
    { ranges: [{ body: 'private-body' }] },
    { nested: { content: 'private-body' } },
    { nested: { text: 'private-body' } },
    { nested: { reference: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:hidden' } },
  ]) assert.throws(() => validateConversationalRecord({ ...contextBase, receipt }), /forbidden/);
});

class MemoryPersistence implements RuntimePersistence {
  revision = 3;
  readonly contexts: unknown[] = [];
  readonly loads = new Map<string, SkillLoadReceipt>();

  async currentRevision(): Promise<number> { return this.revision; }
  async saveContextReceipt(receipt: unknown): Promise<void> { this.contexts.push(receipt); }
  async saveSkillLoad(receipt: SkillLoadReceipt): Promise<void> { this.loads.set(receipt.loadNonceHash, receipt); }
  async getSkillLoad(_conversationId: string, hash: string): Promise<SkillLoadReceipt | null> {
    return this.loads.get(hash) || null;
  }
  async consumeSkillLoad(
    _conversationId: string,
    hash: string,
    revision: number,
    now: Date
  ): Promise<{ claimed: boolean; result?: unknown }> {
    const receipt = this.loads.get(hash);
    if (!receipt || receipt.status !== 'active' || receipt.conversationRevision !== revision || Date.parse(receipt.expiresAt!) <= now.getTime()) {
      return { claimed: false, result: receipt?.consumedResult };
    }
    receipt.status = 'consumed';
    return { claimed: true };
  }
  async storeSkillLoadResult(
    _conversationId: string,
    hash: string,
    result: PluginResult
  ): Promise<void> {
    this.loads.get(hash)!.consumedResult = result as never;
  }
}

class RecordingModel implements ConversationalModel {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly reply: (request: ModelRequest, index: number) => ModelResponse) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.reply(request, this.requests.length - 1);
  }
}

function runtimeInput() {
  return {
    conversationId: 'conversation-1',
    conversationRevision: 3,
    actor: { id: 'user-1', role: 'operator' as const, channel: 'telegram' as const },
    context: {
      coreRules: 'Never execute domain mutations.',
      recentEvents: [{ sequence: 1, id: 'event-1', text: 'Create a task called test' }],
      provider: 'z.ai',
      model: 'glm-5.2',
    },
  };
}

test('runtime uses exactly two separate calls and returns a non-executing typed result', async () => {
  let validations = 0;
  const fake = plugin({
    validator: (_action: string, input: unknown) => {
      validations += 1;
      return { kind: 'draft', value: input };
    },
  });
  const persistence = new MemoryPersistence();
  const model = new RecordingModel((request, index) => {
    if (index === 0) return { kind: 'tool', name: 'skill_load', input: { plugin: 'fake.todo' } };
    const match = request.system.match(/"loadNonce":"([^"]+)"/);
    assert.ok(match);
    return {
      kind: 'tool',
      name: 'skill_invoke',
      input: { plugin: 'fake.todo', action: 'create', input: { title: 'test' }, load_nonce: match[1] },
    };
  });
  const runtime = new ConversationalRuntime(
    registry([fake]),
    model,
    persistence
  );
  const result = await runtime.handle(runtimeInput());
  assert.equal(result.kind, 'invocation');
  assert.equal(result.providerCalls, 2);
  assert.equal(validations, 1);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests[0].tools.map((tool) => tool.name), ['skill_load']);
  assert.deepEqual(model.requests[1].tools.map((tool) => tool.name), ['skill_invoke']);
  assert.doesNotMatch(model.requests[0].system, /skillInstructions|Collect a title/);
  assert.match(model.requests[1].system, /Collect a title/);
  assert.equal(persistence.contexts.length, 2);
  assert.equal(JSON.stringify(persistence.contexts).includes('Create a task called test'), false);
});

test('runtime stops after clarification and never makes a second call', async () => {
  const model = new RecordingModel(() => ({ kind: 'text', text: 'Which kind of work do you mean?' }));
  const result = await new ConversationalRuntime(
    registry([plugin()]),
    model,
    new MemoryPersistence()
  ).handle(runtimeInput());
  assert.deepEqual(result, {
    kind: 'clarification',
    message: 'Which kind of work do you mean?',
    providerCalls: 1,
  });
  assert.equal(model.requests.length, 1);
});

test('runtime can gate the visible and loadable plugin catalog per channel-neutral request', async () => {
  const model = new RecordingModel(() => ({
    kind: 'tool',
    name: 'skill_load',
    input: { plugin: 'fake.todo' },
  }));
  const result = await new ConversationalRuntime(
    registry([plugin()]),
    model,
    new MemoryPersistence()
  ).handle({
    ...runtimeInput(),
    availablePluginIds: [],
  });
  assert.equal(result.kind, 'rejected');
  if (result.kind === 'rejected') assert.equal(result.code, 'plugin_unavailable');
  assert.equal(model.requests.length, 1);
  assert.doesNotMatch(model.requests[0].system, /fake\.todo/);
});

test('runtime rejects unknown actor scope and mismatched returned tool names', async () => {
  const persistence = new MemoryPersistence();
  const neverModel = new RecordingModel(() => {
    throw new Error('model must not be called');
  });
  const unknownActor = runtimeInput();
  unknownActor.actor.role = 'owner' as never;
  const rejectedActor = await new ConversationalRuntime(
    registry([plugin()]),
    neverModel,
    persistence
  ).handle(unknownActor);
  assert.equal(rejectedActor.kind, 'rejected');
  assert.equal(neverModel.requests.length, 0);

  const wrongLoad = new RecordingModel(() => ({
    kind: 'tool', name: 'skill_invoke', input: { plugin: 'fake.todo' },
  }));
  const rejectedLoad = await new ConversationalRuntime(
    registry([plugin()]),
    wrongLoad,
    new MemoryPersistence()
  ).handle(runtimeInput());
  assert.deepEqual(rejectedLoad, {
    kind: 'rejected',
    code: 'invalid_model_output',
    message: 'I could not safely continue that action. Please try again.',
    providerCalls: 1,
  });

  const wrongInvoke = new RecordingModel((request, index) => {
    if (index === 0) return { kind: 'tool', name: 'skill_load', input: { plugin: 'fake.todo' } };
    const nonce = request.system.match(/"loadNonce":"([^"]+)"/)![1];
    return {
      kind: 'tool',
      name: 'skill_load',
      input: { plugin: 'fake.todo', action: 'create', input: { title: 'test' }, load_nonce: nonce },
    };
  });
  const rejectedInvoke = await new ConversationalRuntime(
    registry([plugin()]),
    wrongInvoke,
    new MemoryPersistence()
  ).handle(runtimeInput());
  assert.equal(rejectedInvoke.kind, 'rejected');
  if (rejectedInvoke.kind === 'rejected') {
    assert.equal(rejectedInvoke.code, 'invalid_model_output');
    assert.equal(rejectedInvoke.providerCalls, 2);
  }
});

test('runtime rejects stale revision and invalid input before the plugin validator', async () => {
  let validations = 0;
  const persistence = new MemoryPersistence();
  const model = new RecordingModel((request, index) => {
    if (index === 0) return { kind: 'tool', name: 'skill_load', input: { plugin: 'fake.todo' } };
    const nonce = request.system.match(/"loadNonce":"([^"]+)"/)![1];
    return {
      kind: 'tool',
      name: 'skill_invoke',
      input: { plugin: 'fake.todo', action: 'create', input: { title: 'ok', extra: true }, load_nonce: nonce },
    };
  });
  const result = await new ConversationalRuntime(
    registry([plugin({
      validator: () => {
        validations += 1;
        return { kind: 'draft', value: {} };
      },
    })]),
    model,
    persistence
  ).handle(runtimeInput());
  assert.equal(result.kind, 'rejected');
  assert.equal(validations, 0);
  persistence.revision = 4;
  const stale = await new ConversationalRuntime(
    registry([plugin()]),
    model,
    persistence
  ).handle(runtimeInput());
  assert.deepEqual(stale, {
    kind: 'rejected',
    code: 'stale_conversation',
    message: 'I could not safely continue that action. Please try again.',
    providerCalls: 1,
  });
});

test('duplicate loaded invocation returns the stored result and never validates twice', async () => {
  let validations = 0;
  const built = plugin({
    validator: (_action: string, input: unknown) => {
      validations += 1;
      return { kind: 'draft', value: input };
    },
  });
  const persistence = new MemoryPersistence();
  const runtime = new ConversationalRuntime(
    registry([built]),
    new RecordingModel(() => ({ kind: 'text', text: 'unused' })),
    persistence
  );
  const nonce = 'opaque-load-nonce';
  const now = new Date();
  persistence.loads.set(nonceHash(nonce), {
    id: 'load-1',
    recordType: 'skill_load_receipt',
    schemaVersion: 1,
    conversationId: 'conversation-1',
    conversationRevision: 3,
    actorId: 'user-1',
    role: 'operator',
    channel: 'telegram',
    pluginId: built.id,
    pluginBuildDigest: built.buildDigest,
    schemaDigest: built.schemaDigest,
    loadNonceHash: nonceHash(nonce),
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    ttl: Math.floor((now.getTime() + 300_000) / 1_000),
  });
  const invoke = {
    plugin: built.id,
    action: 'create',
    input: { title: 'once' },
    load_nonce: nonce,
  };
  const first = await runtime.invokeLoaded(runtimeInput(), built.id, built.buildDigest, built.schemaDigest, invoke, 2);
  const duplicate = await runtime.invokeLoaded(runtimeInput(), built.id, built.buildDigest, built.schemaDigest, invoke, 2);
  assert.equal(first.kind, 'invocation');
  assert.equal(duplicate.kind, 'invocation');
  if (duplicate.kind === 'invocation') assert.equal(duplicate.duplicate, true);
  assert.equal(validations, 1);
});

test('concurrent replay can claim a loaded skill only once', async () => {
  let validations = 0;
  const built = plugin({
    validator: (_action: string, input: unknown) => {
      validations += 1;
      return { kind: 'draft', value: input };
    },
  });
  const persistence = new MemoryPersistence();
  const runtime = new ConversationalRuntime(
    registry([built]),
    new RecordingModel(() => ({ kind: 'text', text: 'unused' })),
    persistence
  );
  const nonce = 'one-time-nonce';
  const now = new Date();
  persistence.loads.set(nonceHash(nonce), {
    id: 'load-race',
    recordType: 'skill_load_receipt',
    schemaVersion: 1,
    conversationId: 'conversation-1',
    conversationRevision: 3,
    actorId: 'user-1',
    role: 'operator',
    channel: 'telegram',
    pluginId: built.id,
    pluginBuildDigest: built.buildDigest,
    schemaDigest: built.schemaDigest,
    loadNonceHash: nonceHash(nonce),
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    ttl: Math.floor((now.getTime() + 300_000) / 1_000),
  });
  const invoke = {
    plugin: built.id,
    action: 'create',
    input: { title: 'once' },
    load_nonce: nonce,
  };
  const results = await Promise.allSettled([
    runtime.invokeLoaded(runtimeInput(), built.id, built.buildDigest, built.schemaDigest, invoke, 2),
    runtime.invokeLoaded(runtimeInput(), built.id, built.buildDigest, built.schemaDigest, invoke, 2),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(validations, 1);
});
