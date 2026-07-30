type ConversationalPluginId = 'todo' | 'typefully';

interface ConversationalRolloutControls {
  telegramIngress: boolean;
  executionLeasing: boolean;
  enabledPlugins: readonly ConversationalPluginId[];
  typefullyExternalExecution: boolean;
  voice: boolean;
  photo: boolean;
}

interface ConversationalRolloutEligibility {
  runtimeAvailable: boolean;
  todoVisible: boolean;
  todoApprovalAndDispatch: boolean;
  typefullyVisible: boolean;
  typefullyApprovalAndDispatch: boolean;
  resultDelivery: boolean;
  voiceAvailable: boolean;
  photoAvailable: boolean;
}

interface ConversationalRolloutSnapshot {
  controls: Readonly<ConversationalRolloutControls>;
  eligibility: Readonly<ConversationalRolloutEligibility>;
  pluginEnabled(pluginId: ConversationalPluginId): boolean;
  proposalApprovalEnabled(pluginId: ConversationalPluginId): boolean;
  executionAttemptEnabled(permissionRef: string): boolean;
}

type RolloutEnvironment = Record<string, string | undefined>;

const ROLLOUT_ENVIRONMENT_KEYS = Object.freeze({
  telegramIngress: 'CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED',
  executionLeasing: 'CONVERSATIONAL_EXECUTION_ENABLED',
  enabledPlugins: 'CONVERSATIONAL_ENABLED_PLUGINS',
  typefullyExternalExecution: 'CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED',
  voice: 'CONVERSATIONAL_TELEGRAM_VOICE_ENABLED',
  photo: 'CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED',
} as const);

const RETIRED_INDEPENDENT_FLAGS = Object.freeze([
  'CONVERSATIONAL_AGENT_ENABLED',
  'CONVERSATIONAL_TODO_PLUGIN_ENABLED',
  'CONVERSATIONAL_TODO_EXECUTOR_ENABLED',
  'CONVERSATIONAL_TYPEFULLY_PLUGIN_ENABLED',
  'CONVERSATIONAL_TYPEFULLY_EXECUTION_ENABLED',
  'CONVERSATIONAL_RESULT_DELIVERY_ENABLED',
  'CONVERSATIONAL_TELEGRAM_ENABLED',
] as const);

const PLUGIN_VALUES = Object.freeze([
  'none',
  'todo',
  'typefully',
  'todo,typefully',
] as const);

class ConversationalRolloutConfigurationError extends Error {
  constructor(message = 'Conversational rollout configuration is invalid') {
    super(message);
    this.name = 'ConversationalRolloutConfigurationError';
  }
}

function strictBoolean(value: string | undefined, key: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConversationalRolloutConfigurationError(`${key} must be exactly true or false`);
}

function strictPlugins(value: string | undefined): readonly ConversationalPluginId[] {
  if (!value || !PLUGIN_VALUES.includes(value as typeof PLUGIN_VALUES[number])) {
    throw new ConversationalRolloutConfigurationError(
      `${ROLLOUT_ENVIRONMENT_KEYS.enabledPlugins} must be a canonical plugin subset`
    );
  }
  if (value === 'none') return Object.freeze([]);
  return Object.freeze(value.split(',') as ConversationalPluginId[]);
}

function parseConversationalRolloutSnapshot(
  environment: RolloutEnvironment
): ConversationalRolloutSnapshot {
  for (const key of RETIRED_INDEPENDENT_FLAGS) {
    if (environment[key] !== undefined) {
      throw new ConversationalRolloutConfigurationError(`${key} is retired`);
    }
  }
  const controls = Object.freeze({
    telegramIngress: strictBoolean(
      environment[ROLLOUT_ENVIRONMENT_KEYS.telegramIngress],
      ROLLOUT_ENVIRONMENT_KEYS.telegramIngress
    ),
    executionLeasing: strictBoolean(
      environment[ROLLOUT_ENVIRONMENT_KEYS.executionLeasing],
      ROLLOUT_ENVIRONMENT_KEYS.executionLeasing
    ),
    enabledPlugins: strictPlugins(environment[ROLLOUT_ENVIRONMENT_KEYS.enabledPlugins]),
    typefullyExternalExecution: strictBoolean(
      environment[ROLLOUT_ENVIRONMENT_KEYS.typefullyExternalExecution],
      ROLLOUT_ENVIRONMENT_KEYS.typefullyExternalExecution
    ),
    voice: strictBoolean(
      environment[ROLLOUT_ENVIRONMENT_KEYS.voice],
      ROLLOUT_ENVIRONMENT_KEYS.voice
    ),
    photo: strictBoolean(
      environment[ROLLOUT_ENVIRONMENT_KEYS.photo],
      ROLLOUT_ENVIRONMENT_KEYS.photo
    ),
  });
  const pluginIds = new Set(controls.enabledPlugins);
  if (controls.voice && !controls.telegramIngress) {
    throw new ConversationalRolloutConfigurationError('voice requires Telegram ingress');
  }
  if (controls.photo && !controls.telegramIngress) {
    throw new ConversationalRolloutConfigurationError('photo requires Telegram ingress');
  }
  if (
    controls.typefullyExternalExecution
    && (!controls.executionLeasing || !pluginIds.has('typefully'))
  ) {
    throw new ConversationalRolloutConfigurationError(
      'Typefully external execution requires execution leasing and the Typefully plugin'
    );
  }
  const eligibility = Object.freeze({
    runtimeAvailable: controls.telegramIngress,
    todoVisible: pluginIds.has('todo'),
    todoApprovalAndDispatch: controls.executionLeasing && pluginIds.has('todo'),
    typefullyVisible: pluginIds.has('typefully'),
    typefullyApprovalAndDispatch:
      controls.executionLeasing
      && pluginIds.has('typefully')
      && controls.typefullyExternalExecution,
    resultDelivery: controls.telegramIngress,
    voiceAvailable: controls.telegramIngress && controls.voice,
    photoAvailable: controls.telegramIngress && controls.photo,
  });
  return Object.freeze({
    controls,
    eligibility,
    pluginEnabled(pluginId: ConversationalPluginId): boolean {
      return pluginIds.has(pluginId);
    },
    proposalApprovalEnabled(pluginId: ConversationalPluginId): boolean {
      return pluginId === 'todo'
        ? eligibility.todoApprovalAndDispatch
        : eligibility.typefullyApprovalAndDispatch;
    },
    executionAttemptEnabled(permissionRef: string): boolean {
      if (permissionRef === 'todo:create:self') return eligibility.todoApprovalAndDispatch;
      if (permissionRef === 'typefully:create-saved-draft') {
        return eligibility.typefullyApprovalAndDispatch;
      }
      return false;
    },
  });
}

function conversationalRolloutSnapshot(): ConversationalRolloutSnapshot {
  return parseConversationalRolloutSnapshot(process.env);
}

export {
  ConversationalRolloutConfigurationError,
  PLUGIN_VALUES,
  RETIRED_INDEPENDENT_FLAGS,
  ROLLOUT_ENVIRONMENT_KEYS,
  conversationalRolloutSnapshot,
  parseConversationalRolloutSnapshot,
};
export type {
  ConversationalPluginId,
  ConversationalRolloutControls,
  ConversationalRolloutEligibility,
  ConversationalRolloutSnapshot,
  RolloutEnvironment,
};
