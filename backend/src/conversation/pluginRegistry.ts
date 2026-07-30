import { createHash } from 'crypto';

type CorePermission = 'todo:create:self' | 'typefully:create-saved-draft';
type PluginRole = 'admin' | 'operator';
type PluginChannel = 'telegram' | 'web';
type ActionEffect = 'read' | 'proposal';
type ReconciliationMode =
  | 'provider_idempotency'
  | 'correlation_lookup'
  | 'operator_reconciliation_only';

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
} & Record<string, unknown>;

interface PluginAction {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: ActionEffect;
  corePermission?: CorePermission;
  externalEffect?: boolean;
  reconciliationMode?: ReconciliationMode;
  executorDeclaration?: string;
  reconcilerDeclaration?: string;
}

interface PluginDefinition {
  id: string;
  version: string;
  displayName: string;
  summary: string;
  activationHints: string[];
  skillInstructions: string;
  actions: PluginAction[];
  validator: (action: string, input: unknown) => PluginResult;
  validatorDeclaration: string;
  proposalRenderer?: (action: string, input: unknown) => unknown;
  proposalRendererDeclaration?: string;
  enabled?: boolean;
  roles?: PluginRole[];
  channels?: PluginChannel[];
  buildArtifactId: string;
  buildDigest: string;
  schemaDigest: string;
}

type PluginResult =
  | { kind: 'clarification'; message: string }
  | { kind: 'draft'; value: unknown }
  | { kind: 'proposal_candidate'; value: unknown };

interface PluginCatalogEntry {
  id: string;
  displayName: string;
  summary: string;
  activationHints: string[];
}

interface RegistryMetadata {
  buildDigest: string;
  schemaDigest: string;
}

interface CompiledPluginArtifact {
  compiledModule: string;
  validator: PluginDefinition['validator'];
  proposalRenderer?: PluginDefinition['proposalRenderer'];
}

type CompiledPluginLoader = (buildArtifactId: string) => CompiledPluginArtifact;

const CORE_PERMISSION_VALUES = Object.freeze([
  'todo:create:self',
  'typefully:create-saved-draft',
] as const);
const CORE_PERMISSIONS = new Set<CorePermission>(CORE_PERMISSION_VALUES);
const ROLES = new Set<PluginRole>(['admin', 'operator']);
const CHANNELS = new Set<PluginChannel>(['telegram', 'web']);
const RECONCILIATION_MODES = new Set<ReconciliationMode>([
  'provider_idempotency',
  'correlation_lookup',
  'operator_reconciliation_only',
]);
const CANONICAL_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_SUMMARY_BYTES = 300;
const MAX_HINTS = 8;
const MAX_HINT_BYTES = 100;

class PluginConfigurationError extends Error {
  constructor(message = 'Conversational plugin configuration is invalid') {
    super(message);
    this.name = 'PluginConfigurationError';
  }
}

function canonicalJson(value: unknown): string {
  if (!isStrictJsonValue(value)) throw new TypeError('Value is not strict JSON');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function isStrictJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  try {
    return isStrictJsonValueUnsafe(value, ancestors);
  } catch {
    return false;
  }
}

function isStrictJsonValueUnsafe(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).some((key) => (
      typeof key === 'symbol'
      || (
        key !== 'length'
        && (
          !/^(?:0|[1-9]\d*)$/.test(key)
          || Number(key) >= value.length
        )
      )
    ))) return false;
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor
        || !('value' in descriptor)
        || !isStrictJsonValue(descriptor.value, ancestors)
      ) {
        ancestors.delete(value);
        return false;
      }
    }
    ancestors.delete(value);
    return true;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) return false;
  ancestors.add(value);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !isStrictJsonValue(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function strictJsonEqual(left: unknown, right: unknown): boolean {
  return isStrictJsonValue(left)
    && isStrictJsonValue(right)
    && canonicalJson(left) === canonicalJson(right);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(
    typeof value === 'string' ? value : canonicalJson(value)
  ).digest('hex')}`;
}

function actionSchemaIdentity(plugin: Pick<PluginDefinition, 'actions'>): unknown {
  return plugin.actions.map((action) => ({
    name: action.name,
    effect: action.effect,
    corePermission: action.corePermission || null,
    reconciliationMode: action.reconciliationMode || null,
    inputSchema: action.inputSchema,
  }));
}

function buildIdentity(
  plugin: Omit<PluginDefinition, 'buildDigest' | 'schemaDigest'>,
  compiledModule: string
): unknown {
  return {
    id: plugin.id,
    version: plugin.version,
    displayName: plugin.displayName,
    summary: plugin.summary,
    activationHints: plugin.activationHints,
    skillInstructions: plugin.skillInstructions,
    actions: plugin.actions.map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
      effect: action.effect,
      corePermission: action.corePermission || null,
      externalEffect: action.externalEffect === true,
      reconciliationMode: action.reconciliationMode || null,
      executorDeclaration: action.executorDeclaration || null,
      reconcilerDeclaration: action.reconcilerDeclaration || null,
    })),
    roles: plugin.roles || [],
    channels: plugin.channels || [],
    compiledModuleDigest: digest(compiledModule),
    validatorDeclaration: plugin.validatorDeclaration,
    proposalRendererDeclaration: plugin.proposalRendererDeclaration || null,
  };
}

// This helper belongs in the build step: callers hash the compiled module and
// canonical manifest before constructing the runtime definition. Registry
// startup independently recomputes both digests and rejects stale metadata.
function generateRegistryMetadata(
  plugin: Omit<PluginDefinition, 'buildDigest' | 'schemaDigest'>,
  compiledModule: string
): RegistryMetadata {
  return {
    schemaDigest: digest(actionSchemaIdentity(plugin)),
    buildDigest: digest(buildIdentity(plugin, compiledModule)),
  };
}

function assertStrictSchema(schema: unknown, path: string): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new PluginConfigurationError(`${path} must be a schema object`);
  }
  const candidate = schema as Record<string, unknown>;
  const universal = new Set(['type', 'enum', 'const', 'oneOf', 'anyOf', 'allOf']);
  const byType: Record<string, Set<string>> = {
    object: new Set(['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']),
    array: new Set(['items', 'minItems', 'maxItems', 'uniqueItems']),
    string: new Set(['minLength', 'maxLength', 'pattern']),
    number: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
    integer: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
    boolean: new Set(),
    null: new Set(),
  };
  const type = String(candidate.type);
  if (!byType[type]) throw new PluginConfigurationError(`${path}.type is unsupported`);
  for (const key of Object.keys(candidate)) {
    if (!universal.has(key) && !byType[type].has(key)) {
      throw new PluginConfigurationError(`${path}.${key} is unsupported`);
    }
  }
  if (candidate.enum !== undefined && (!Array.isArray(candidate.enum) || candidate.enum.length === 0)) {
    throw new PluginConfigurationError(`${path}.enum is invalid`);
  }
  if (Array.isArray(candidate.enum)) {
    candidate.enum.forEach((value, index) => assertJsonSchemaLiteral(value, `${path}.enum[${index}]`));
  }
  if ('const' in candidate) assertJsonSchemaLiteral(candidate.const, `${path}.const`);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (candidate[keyword] !== undefined) {
      if (!Array.isArray(candidate[keyword]) || (candidate[keyword] as unknown[]).length === 0) {
        throw new PluginConfigurationError(`${path}.${keyword} is invalid`);
      }
      (candidate[keyword] as unknown[]).forEach((child, index) => (
        assertStrictSchema(child, `${path}.${keyword}[${index}]`)
      ));
    }
  }
  if (candidate.type === 'object') {
    if (candidate.additionalProperties !== false) {
      throw new PluginConfigurationError(`${path} must reject unknown properties`);
    }
    if (!candidate.properties || typeof candidate.properties !== 'object' || Array.isArray(candidate.properties)) {
      throw new PluginConfigurationError(`${path}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(candidate.properties as Record<string, unknown>)) {
      assertStrictSchema(child, `${path}.properties.${name}`);
    }
    if (
      candidate.required !== undefined
      && (
        !Array.isArray(candidate.required)
        || candidate.required.some((name) => (
          typeof name !== 'string'
          || !(name in (candidate.properties as Record<string, unknown>))
        ))
      )
    ) throw new PluginConfigurationError(`${path}.required is invalid`);
    assertNonNegativeIntegerKeywords(candidate, path, ['minProperties', 'maxProperties']);
    assertOrderedBounds(candidate, path, 'minProperties', 'maxProperties');
  } else if (candidate.type === 'array') {
    assertStrictSchema(candidate.items, `${path}.items`);
    assertNonNegativeIntegerKeywords(candidate, path, ['minItems', 'maxItems']);
    assertOrderedBounds(candidate, path, 'minItems', 'maxItems');
    if (candidate.uniqueItems !== undefined && typeof candidate.uniqueItems !== 'boolean') {
      throw new PluginConfigurationError(`${path}.uniqueItems is invalid`);
    }
  } else if (candidate.type === 'string') {
    assertNonNegativeIntegerKeywords(candidate, path, ['minLength', 'maxLength']);
    assertOrderedBounds(candidate, path, 'minLength', 'maxLength');
    if (candidate.pattern !== undefined) {
      if (typeof candidate.pattern !== 'string') throw new PluginConfigurationError(`${path}.pattern is invalid`);
      try { new RegExp(candidate.pattern); } catch { throw new PluginConfigurationError(`${path}.pattern is invalid`); }
    }
  } else if (candidate.type === 'number' || candidate.type === 'integer') {
    for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
      if (candidate[keyword] !== undefined && (
        typeof candidate[keyword] !== 'number'
        || !Number.isFinite(candidate[keyword])
        || (keyword === 'multipleOf' && Number(candidate[keyword]) <= 0)
      )) throw new PluginConfigurationError(`${path}.${keyword} is invalid`);
    }
  }
}

function assertJsonSchemaLiteral(value: unknown, path: string): void {
  if (!isStrictJsonValue(value)) throw new PluginConfigurationError(`${path} is not strict JSON`);
}

function assertOrderedBounds(
  candidate: Record<string, unknown>,
  path: string,
  minimum: string,
  maximum: string
): void {
  if (
    candidate[minimum] !== undefined
    && candidate[maximum] !== undefined
    && Number(candidate[minimum]) > Number(candidate[maximum])
  ) throw new PluginConfigurationError(`${path} has contradictory bounds`);
}

function assertNonNegativeIntegerKeywords(
  candidate: Record<string, unknown>,
  path: string,
  keywords: string[]
): void {
  for (const keyword of keywords) {
    if (
      candidate[keyword] !== undefined
      && (!Number.isInteger(candidate[keyword]) || Number(candidate[keyword]) < 0)
    ) throw new PluginConfigurationError(`${path}.${keyword} is invalid`);
  }
}

function validatePlugin(plugin: PluginDefinition, compiledModule: string): void {
  if (!plugin || typeof plugin !== 'object') throw new PluginConfigurationError();
  if (!CANONICAL_ID.test(plugin.id) || !CANONICAL_ID.test(plugin.version)) {
    throw new PluginConfigurationError('Plugin ID and version must be canonical');
  }
  for (const [name, value] of [
    ['displayName', plugin.displayName],
    ['summary', plugin.summary],
    ['skillInstructions', plugin.skillInstructions],
    ['buildArtifactId', plugin.buildArtifactId],
    ['validatorDeclaration', plugin.validatorDeclaration],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new PluginConfigurationError(`${name} is required`);
    }
  }
  if (typeof compiledModule !== 'string' || compiledModule.length === 0) {
    throw new PluginConfigurationError('Compiled plugin artifact is unavailable');
  }
  if (Buffer.byteLength(plugin.summary, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new PluginConfigurationError('Plugin summary is too long');
  }
  if (!Array.isArray(plugin.activationHints) || plugin.activationHints.length > MAX_HINTS) {
    throw new PluginConfigurationError('Activation hints are invalid');
  }
  if (plugin.activationHints.some((hint) => (
    typeof hint !== 'string' || !hint || Buffer.byteLength(hint, 'utf8') > MAX_HINT_BYTES
  ))) throw new PluginConfigurationError('Activation hints are invalid');
  if (typeof plugin.validator !== 'function') throw new PluginConfigurationError('Plugin validator is required');
  if (plugin.proposalRenderer !== undefined && typeof plugin.proposalRenderer !== 'function') {
    throw new PluginConfigurationError('Plugin proposal renderer is invalid');
  }
  if (
    plugin.proposalRenderer !== undefined
    && (typeof plugin.proposalRendererDeclaration !== 'string' || !plugin.proposalRendererDeclaration)
  ) throw new PluginConfigurationError('Plugin proposal renderer declaration is required');
  if (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean') {
    throw new PluginConfigurationError('Plugin enabled flag is invalid');
  }
  if (!Array.isArray(plugin.actions) || plugin.actions.length === 0) {
    throw new PluginConfigurationError('Plugin actions are required');
  }
  if (plugin.roles !== undefined && !Array.isArray(plugin.roles)) {
    throw new PluginConfigurationError('Plugin roles are invalid');
  }
  for (const role of plugin.roles || []) {
    if (!ROLES.has(role)) throw new PluginConfigurationError('Plugin role is not recognized');
  }
  if (plugin.channels !== undefined && !Array.isArray(plugin.channels)) {
    throw new PluginConfigurationError('Plugin channels are invalid');
  }
  for (const channel of plugin.channels || []) {
    if (!CHANNELS.has(channel)) throw new PluginConfigurationError('Plugin channel is not recognized');
  }
  const names = new Set<string>();
  for (const action of plugin.actions) {
    if (!CANONICAL_ID.test(action.name) || names.has(action.name)) {
      throw new PluginConfigurationError('Plugin action names must be unique and canonical');
    }
    names.add(action.name);
    if (!action.description) throw new PluginConfigurationError('Action description is required');
    if (!['read', 'proposal'].includes(action.effect)) {
      throw new PluginConfigurationError('Action effect is not recognized');
    }
    for (const declaration of [action.executorDeclaration, action.reconcilerDeclaration]) {
      if (declaration !== undefined && (typeof declaration !== 'string' || !declaration)) {
        throw new PluginConfigurationError('Action handler declaration is invalid');
      }
    }
    if (
      action.reconciliationMode !== undefined
      && !RECONCILIATION_MODES.has(action.reconciliationMode)
    ) throw new PluginConfigurationError('Action reconciliation mode is not recognized');
    assertStrictSchema(action.inputSchema, `${plugin.id}.${action.name}.inputSchema`);
    if (action.corePermission && !CORE_PERMISSIONS.has(action.corePermission)) {
      throw new PluginConfigurationError('Action core permission is not recognized');
    }
    if (action.effect === 'read' && action.executorDeclaration) {
      throw new PluginConfigurationError('Read actions cannot declare mutation executors');
    }
    if (
      action.effect === 'proposal'
      && (!action.corePermission || !plugin.proposalRenderer || !action.executorDeclaration)
    ) {
      throw new PluginConfigurationError('Proposal actions require renderer, executor, and core permission declarations');
    }
    if (
      action.effect === 'proposal'
      && action.externalEffect
      && (
        !action.reconciliationMode
        || !RECONCILIATION_MODES.has(action.reconciliationMode)
        || !action.reconcilerDeclaration
      )
    ) {
      throw new PluginConfigurationError('External proposal action requires reconciliation metadata');
    }
  }
  if (!DIGEST.test(plugin.buildDigest) || !DIGEST.test(plugin.schemaDigest)) {
    throw new PluginConfigurationError('Plugin digests are invalid');
  }
  const generated = generateRegistryMetadata(plugin, compiledModule);
  if (generated.buildDigest !== plugin.buildDigest || generated.schemaDigest !== plugin.schemaDigest) {
    throw new PluginConfigurationError('Plugin generated metadata does not match its build');
  }
}

class StaticPluginRegistry {
  private readonly plugins = new Map<string, PluginDefinition>();

  constructor(plugins: PluginDefinition[], loadCompiledPlugin?: CompiledPluginLoader) {
    if (plugins.length > 0 && !loadCompiledPlugin) {
      throw new PluginConfigurationError('A compiled plugin artifact loader is required');
    }
    for (const plugin of plugins) {
      let artifact: CompiledPluginArtifact;
      try {
        artifact = loadCompiledPlugin!(plugin.buildArtifactId);
      } catch {
        throw new PluginConfigurationError('Compiled plugin artifact is unavailable');
      }
      if (
        !artifact
        || typeof artifact.compiledModule !== 'string'
        || typeof artifact.validator !== 'function'
        || (
          plugin.proposalRendererDeclaration
          && typeof artifact.proposalRenderer !== 'function'
        )
      ) throw new PluginConfigurationError('Compiled plugin artifact is invalid');
      const loadedPlugin: PluginDefinition = {
        ...plugin,
        validator: artifact.validator,
        proposalRenderer: artifact.proposalRenderer,
      };
      validatePlugin(loadedPlugin, artifact.compiledModule);
      if (this.plugins.has(loadedPlugin.id)) throw new PluginConfigurationError('Duplicate plugin ID');
      this.plugins.set(loadedPlugin.id, deepFreeze(loadedPlugin));
    }
  }

  catalog(role: PluginRole, channel: PluginChannel): PluginCatalogEntry[] {
    assertActorScope(role, channel);
    return [...this.plugins.values()]
      .filter((plugin) => this.available(plugin, role, channel))
      .map(({ id, displayName, summary, activationHints }) => ({
        id, displayName, summary, activationHints: [...activationHints],
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getAvailable(id: string, role: PluginRole, channel: PluginChannel): PluginDefinition | null {
    if (!ROLES.has(role) || !CHANNELS.has(channel)) return null;
    const plugin = this.plugins.get(id);
    return plugin && this.available(plugin, role, channel) ? plugin : null;
  }

  private available(plugin: PluginDefinition, role: PluginRole, channel: PluginChannel): boolean {
    return plugin.enabled !== false
      && (!plugin.roles?.length || plugin.roles.includes(role))
      && (!plugin.channels?.length || plugin.channels.includes(channel));
  }
}

function assertActorScope(role: PluginRole, channel: PluginChannel): void {
  if (!ROLES.has(role) || !CHANNELS.has(channel)) {
    throw new PluginConfigurationError('Actor role or channel is not recognized');
  }
}

function isPluginRole(value: unknown): value is PluginRole {
  return typeof value === 'string' && ROLES.has(value as PluginRole);
}

function isPluginChannel(value: unknown): value is PluginChannel {
  return typeof value === 'string' && CHANNELS.has(value as PluginChannel);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export {
  CORE_PERMISSION_VALUES,
  PluginConfigurationError,
  StaticPluginRegistry,
  canonicalJson,
  generateRegistryMetadata,
  isPluginChannel,
  isPluginRole,
  isStrictJsonValue,
  strictJsonEqual,
};
export type {
  ActionEffect,
  CorePermission,
  JsonSchema,
  PluginAction,
  PluginCatalogEntry,
  PluginChannel,
  PluginDefinition,
  PluginResult,
  PluginRole,
  ReconciliationMode,
  RegistryMetadata,
  CompiledPluginArtifact,
  CompiledPluginLoader,
};
