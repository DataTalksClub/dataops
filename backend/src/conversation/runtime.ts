import { createHash, randomBytes, randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  consumeSkillLoadReceipt,
  createSkillLoadReceipt,
  getConversation,
  getSkillLoadReceipt,
  saveContextReceipt,
  storeSkillLoadResult,
} from './repository';
import { expiryFrom, type JsonValue, type SkillLoadReceipt, type StoredContextReceipt } from './types';
import {
  ContextAssembler,
  type ContextInput,
  type ContextReceipt,
} from './context';
import {
  StaticPluginRegistry,
  canonicalJson,
  isPluginChannel,
  isPluginRole,
  isStrictJsonValue,
  strictJsonEqual,
  type JsonSchema,
  type PluginChannel,
  type PluginResult,
  type PluginRole,
} from './pluginRegistry';
import type { ConversationalModel, ModelTool } from './zaiClient';

interface RuntimeActor {
  id: string;
  role: PluginRole;
  channel: PluginChannel;
}

interface RuntimeInput {
  conversationId: string;
  conversationRevision: number;
  actor: RuntimeActor;
  context: Omit<ContextInput, 'conversationId' | 'conversationRevision' | 'catalog' | 'pluginContract'>;
}

type RuntimeResult =
  | { kind: 'clarification'; message: string; providerCalls: 1 }
  | { kind: 'invocation'; pluginId: string; action: string; result: PluginResult; providerCalls: 2; duplicate: boolean }
  | { kind: 'rejected'; code: RuntimeErrorCode; message: string; providerCalls: 1 | 2 };

type RuntimeErrorCode =
  | 'invalid_model_output'
  | 'plugin_unavailable'
  | 'stale_conversation'
  | 'stale_skill_load'
  | 'invalid_plugin_input'
  | 'invocation_replayed';

interface RuntimePersistence {
  currentRevision(conversationId: string): Promise<number | null>;
  saveContextReceipt(receipt: ContextReceipt, now: Date): Promise<void>;
  saveSkillLoad(receipt: SkillLoadReceipt): Promise<void>;
  getSkillLoad(conversationId: string, nonceHash: string): Promise<SkillLoadReceipt | null>;
  consumeSkillLoad(
    conversationId: string,
    nonceHash: string,
    revision: number,
    now: Date
  ): Promise<{ claimed: boolean; result?: unknown }>;
  storeSkillLoadResult(
    conversationId: string,
    nonceHash: string,
    result: PluginResult,
    now: Date
  ): Promise<void>;
}

class RuntimeProtocolError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

function nonceHash(nonce: string): string {
  return `sha256:${createHash('sha256').update(nonce).digest('hex')}`;
}

function onlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validateSchema(schema: Record<string, unknown>, value: unknown): boolean {
  if (!isStrictJsonValue(value)) return false;
  if ('const' in schema && !strictJsonEqual(value, schema.const)) return false;
  if (
    Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => strictJsonEqual(candidate, value))
  ) return false;
  if (
    Array.isArray(schema.allOf)
    && !schema.allOf.every((child) => validateSchema(child as Record<string, unknown>, value))
  ) return false;
  if (
    Array.isArray(schema.anyOf)
    && !schema.anyOf.some((child) => validateSchema(child as Record<string, unknown>, value))
  ) return false;
  if (
    Array.isArray(schema.oneOf)
    && schema.oneOf.filter((child) => validateSchema(child as Record<string, unknown>, value)).length !== 1
  ) return false;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      const required = Array.isArray(schema.required) ? schema.required as string[] : [];
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.some((key) => !(key in properties))) return false;
      if (required.some((key) => !(key in (value as Record<string, unknown>)))) return false;
      if (schema.minProperties !== undefined && keys.length < Number(schema.minProperties)) return false;
      if (schema.maxProperties !== undefined && keys.length > Number(schema.maxProperties)) return false;
      return Object.entries(value as Record<string, unknown>)
        .every(([key, child]) => validateSchema(properties[key], child));
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (schema.minItems !== undefined && value.length < Number(schema.minItems)) return false;
      if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) return false;
      if (
        schema.uniqueItems === true
        && new Set(value.map((child) => canonicalJson(child))).size !== value.length
      ) return false;
      return value.every((child) => validateSchema(schema.items as Record<string, unknown>, child));
    }
    case 'string':
      return typeof value === 'string'
        && (schema.minLength === undefined || value.length >= Number(schema.minLength))
        && (schema.maxLength === undefined || value.length <= Number(schema.maxLength))
        && (schema.pattern === undefined || new RegExp(String(schema.pattern)).test(value));
    case 'integer':
      return Number.isInteger(value) && validateNumberConstraints(schema, value as number);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && validateNumberConstraints(schema, value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function validateNumberConstraints(schema: Record<string, unknown>, value: number): boolean {
  return (schema.minimum === undefined || value >= Number(schema.minimum))
    && (schema.maximum === undefined || value <= Number(schema.maximum))
    && (schema.exclusiveMinimum === undefined || value > Number(schema.exclusiveMinimum))
    && (schema.exclusiveMaximum === undefined || value < Number(schema.exclusiveMaximum))
    && (
      schema.multipleOf === undefined
      || Math.abs(value / Number(schema.multipleOf) - Math.round(value / Number(schema.multipleOf))) < 1e-10
    );
}

function skillLoadTool(): ModelTool {
  return {
    name: 'skill_load',
    description: 'Load exactly one available plugin for this request.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { plugin: { type: 'string' } },
      required: ['plugin'],
    },
  };
}

function skillInvokeTool(pluginId: string, actions: Array<{ name: string; inputSchema: JsonSchema }>): ModelTool {
  return {
    name: 'skill_invoke',
    description: `Validate one action from the loaded ${pluginId} plugin.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plugin: { type: 'string', const: pluginId },
        action: { type: 'string', enum: actions.map((action) => action.name) },
        input: {
          oneOf: actions.map((action) => action.inputSchema),
        },
        load_nonce: { type: 'string' },
      },
      required: ['plugin', 'action', 'input', 'load_nonce'],
    },
  };
}

class DynamoRuntimePersistence implements RuntimePersistence {
  constructor(private readonly client: DynamoDBDocumentClient) {}

  async currentRevision(conversationId: string): Promise<number | null> {
    return (await getConversation(this.client, conversationId))?.revision || null;
  }

  async saveContextReceipt(receipt: ContextReceipt, now: Date): Promise<void> {
    const retention = expiryFrom(now.toISOString(), 30);
    const record: StoredContextReceipt = {
      id: randomUUID(),
      recordType: 'context_receipt',
      schemaVersion: 1,
      conversationId: receipt.conversationId,
      conversationRevision: receipt.sourceRevision,
      algorithmVersion: receipt.algorithmVersion,
      receipt: receipt as unknown as JsonValue,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...retention,
    };
    await saveContextReceipt(this.client, record);
  }

  saveSkillLoad(receipt: SkillLoadReceipt): Promise<void> {
    return createSkillLoadReceipt(this.client, receipt);
  }

  getSkillLoad(conversationId: string, hash: string): Promise<SkillLoadReceipt | null> {
    return getSkillLoadReceipt(this.client, conversationId, hash);
  }

  consumeSkillLoad(
    conversationId: string,
    hash: string,
    revision: number,
    now: Date
  ): Promise<{ claimed: boolean; result?: unknown }> {
    return consumeSkillLoadReceipt(this.client, conversationId, hash, revision, now.toISOString());
  }

  storeSkillLoadResult(
    conversationId: string,
    hash: string,
    result: PluginResult,
    now: Date
  ): Promise<void> {
    return storeSkillLoadResult(this.client, conversationId, hash, result, now.toISOString());
  }
}

class ConversationalRuntime {
  constructor(
    private readonly registry: StaticPluginRegistry,
    private readonly model: ConversationalModel,
    private readonly persistence: RuntimePersistence,
    private readonly contextAssembler = new ContextAssembler(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async handle(input: RuntimeInput): Promise<RuntimeResult> {
    if (!isPluginRole(input.actor.role) || !isPluginChannel(input.actor.channel)) {
      return this.rejected('plugin_unavailable', 1);
    }
    if (await this.persistence.currentRevision(input.conversationId) !== input.conversationRevision) {
      return this.rejected('stale_conversation', 1);
    }
    const catalog = this.registry.catalog(input.actor.role, input.actor.channel);
    const turnOneContext = this.contextAssembler.assemble({
      ...input.context,
      conversationId: input.conversationId,
      conversationRevision: input.conversationRevision,
      catalog,
    });
    await this.persistence.saveContextReceipt(turnOneContext.receipt, this.now());
    const load = await this.model.complete({
      system: turnOneContext.system,
      messages: turnOneContext.messages,
      tools: [skillLoadTool()],
      expectedTool: 'skill_load',
      allowText: true,
    });
    if (load.kind === 'text') return { kind: 'clarification', message: load.text, providerCalls: 1 };
    if (load.name !== 'skill_load') return this.rejected('invalid_model_output', 1);
    if (!onlyKeys(load.input, ['plugin']) || typeof load.input.plugin !== 'string') {
      return this.rejected('invalid_model_output', 1);
    }
    const plugin = this.registry.getAvailable(load.input.plugin, input.actor.role, input.actor.channel);
    if (!plugin) return this.rejected('plugin_unavailable', 1);
    if (await this.persistence.currentRevision(input.conversationId) !== input.conversationRevision) {
      return this.rejected('stale_conversation', 1);
    }

    const nonce = randomBytes(32).toString('base64url');
    const hash = nonceHash(nonce);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 5 * 60_000);
    await this.persistence.saveSkillLoad({
      id: randomUUID(),
      recordType: 'skill_load_receipt',
      schemaVersion: 1,
      conversationId: input.conversationId,
      conversationRevision: input.conversationRevision,
      actorId: input.actor.id,
      role: input.actor.role,
      channel: input.actor.channel,
      pluginId: plugin.id,
      pluginBuildDigest: plugin.buildDigest,
      schemaDigest: plugin.schemaDigest,
      loadNonceHash: hash,
      status: 'active',
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttl: Math.floor(expiresAt.getTime() / 1000),
    });

    const turnTwoContext = this.contextAssembler.assemble({
      ...input.context,
      conversationId: input.conversationId,
      conversationRevision: input.conversationRevision,
      catalog,
      pluginContract: {
        id: plugin.id,
        buildDigest: plugin.buildDigest,
        schemaDigest: plugin.schemaDigest,
        content: {
          instructions: plugin.skillInstructions,
          actions: plugin.actions.map(({ name, description, inputSchema, effect, corePermission }) => ({
            name, description, inputSchema, effect, corePermission,
          })),
          identity: {
            plugin: plugin.id,
            buildDigest: plugin.buildDigest,
            schemaDigest: plugin.schemaDigest,
            loadNonce: nonce,
          },
        },
      },
    });
    await this.persistence.saveContextReceipt(turnTwoContext.receipt, this.now());
    const invocation = await this.model.complete({
      system: turnTwoContext.system,
      messages: turnTwoContext.messages,
      tools: [skillInvokeTool(plugin.id, plugin.actions)],
      toolChoice: { type: 'tool', name: 'skill_invoke' },
      expectedTool: 'skill_invoke',
      allowText: false,
    });
    if (invocation.kind !== 'tool' || invocation.name !== 'skill_invoke') {
      return this.rejected('invalid_model_output', 2);
    }
    try {
      return await this.invokeLoaded(
        input,
        plugin.id,
        plugin.buildDigest,
        plugin.schemaDigest,
        invocation.input,
        2
      );
    } catch (error) {
      if (error instanceof RuntimeProtocolError) return this.rejected(error.code, 2);
      throw error;
    }
  }

  async invokeLoaded(
    input: RuntimeInput,
    expectedPluginId: string,
    expectedBuildDigest: string,
    expectedSchemaDigest: string,
    invocation: Record<string, unknown>,
    providerCalls: 2
  ): Promise<RuntimeResult> {
    if (!isPluginRole(input.actor.role) || !isPluginChannel(input.actor.channel)) {
      throw new RuntimeProtocolError('plugin_unavailable', 'That action is not available.');
    }
    if (
      !onlyKeys(invocation, ['plugin', 'action', 'input', 'load_nonce'])
      || typeof invocation.plugin !== 'string'
      || typeof invocation.action !== 'string'
      || !invocation.input
      || typeof invocation.input !== 'object'
      || Array.isArray(invocation.input)
      || typeof invocation.load_nonce !== 'string'
    ) throw new RuntimeProtocolError('invalid_model_output', 'The assistant returned an invalid action.');
    const plugin = this.registry.getAvailable(invocation.plugin, input.actor.role, input.actor.channel);
    if (
      !plugin
      || plugin.id !== expectedPluginId
      || plugin.buildDigest !== expectedBuildDigest
      || plugin.schemaDigest !== expectedSchemaDigest
    ) throw new RuntimeProtocolError('plugin_unavailable', 'That action is no longer available.');
    const action = plugin.actions.find((candidate) => candidate.name === invocation.action);
    if (!action) throw new RuntimeProtocolError('invalid_plugin_input', 'That action is not available.');
    const hash = nonceHash(invocation.load_nonce);
    const receipt = await this.persistence.getSkillLoad(input.conversationId, hash);
    const now = this.now();
    if (
      !receipt
      || receipt.conversationRevision !== input.conversationRevision
      || receipt.actorId !== input.actor.id
      || receipt.role !== input.actor.role
      || receipt.channel !== input.actor.channel
      || receipt.pluginId !== plugin.id
      || receipt.pluginBuildDigest !== plugin.buildDigest
      || receipt.schemaDigest !== plugin.schemaDigest
      || Date.parse(receipt.expiresAt!) <= now.getTime()
      || await this.persistence.currentRevision(input.conversationId) !== input.conversationRevision
    ) throw new RuntimeProtocolError('stale_skill_load', 'That action is stale. Please try again.');
    if (!validateSchema(action.inputSchema, invocation.input)) {
      throw new RuntimeProtocolError('invalid_plugin_input', 'I need corrected action details before continuing.');
    }
    const consumed = await this.persistence.consumeSkillLoad(
      input.conversationId,
      hash,
      input.conversationRevision,
      now
    );
    if (!consumed.claimed) {
      if (consumed.result) {
        return {
          kind: 'invocation',
          pluginId: plugin.id,
          action: action.name,
          result: consumed.result as PluginResult,
          providerCalls,
          duplicate: true,
        };
      }
      throw new RuntimeProtocolError('invocation_replayed', 'That action is already being processed.');
    }
    const result = plugin.validator(action.name, invocation.input);
    await this.persistence.storeSkillLoadResult(input.conversationId, hash, result, now);
    return {
      kind: 'invocation',
      pluginId: plugin.id,
      action: action.name,
      result,
      providerCalls,
      duplicate: false,
    };
  }

  private rejected(code: RuntimeErrorCode, providerCalls: 1 | 2): RuntimeResult {
    const message = code === 'invalid_plugin_input'
      ? 'I need corrected action details before continuing.'
      : 'I could not safely continue that action. Please try again.';
    return { kind: 'rejected', code, message, providerCalls };
  }
}

export {
  ConversationalRuntime,
  DynamoRuntimePersistence,
  RuntimeProtocolError,
  nonceHash,
  validateSchema,
};
export type {
  RuntimeActor,
  RuntimeErrorCode,
  RuntimeInput,
  RuntimePersistence,
  RuntimeResult,
};
