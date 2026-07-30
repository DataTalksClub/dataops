import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from '@aws-sdk/client-secrets-manager';
import {
  emitConversationalMetric,
  logConversationalEvent,
} from './observability';
import { conversationalRolloutSnapshot } from './rollout';

interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  toolChoice?: { type: 'auto' } | { type: 'tool'; name: string };
  expectedTool: string;
  allowText: boolean;
  maxTokens?: number;
}

type ModelResponse =
  | { kind: 'text'; text: string; inputTokens?: number; outputTokens?: number }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; inputTokens?: number; outputTokens?: number };

interface ConversationalModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

interface ModelTransportRequest {
  url: string;
  init: RequestInit;
}

type ModelTransport = (request: ModelTransportRequest) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

interface SecretReader {
  getSecretValue(secretArn: string): Promise<string>;
}

interface ZaiClientConfig {
  enabled: boolean;
  secretArn?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maximumOutput?: number;
  maximumResponseBytes?: number;
  transport?: ModelTransport;
  secretReader?: SecretReader;
  allowTestHost?: boolean;
}

type ModelErrorCode =
  | 'model_timeout'
  | 'model_rate_limited'
  | 'model_unavailable'
  | 'model_invalid_output'
  | 'model_policy_rejected'
  | 'model_config_error';

const DEFAULT_ZAI_CONVERSATIONAL_BASE_URL = 'https://api.z.ai/api/anthropic';
const DEFAULT_ZAI_CONVERSATIONAL_MODEL = 'glm-5.2';
const DEFAULT_ZAI_TIMEOUT_MS = 20_000;
const DEFAULT_ZAI_MAXIMUM_OUTPUT = 4_096;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_000_000;
const ANTHROPIC_VERSION = '2023-06-01';
const SECRET_KEY = /(secret|token|password|credential|cookie|authorization|api[_-]?key)/i;
const SECRET_VALUE = /(?:bearer\s+\S+|(?:api[_-]?key|secret|token|password|credential|cookie|authorization)\s*[:=]\s*\S+|X-Amz-(?:Signature|Credential|Security-Token)=\S+|arn:[a-z0-9-]+:secretsmanager:[^\s,}"']+|sk-[a-z0-9_-]+)/ig;

class ConversationalModelError extends Error {
  constructor(readonly code: ModelErrorCode, message: string) {
    super(message.slice(0, 300));
    this.name = 'ConversationalModelError';
  }
}

function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]').slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, child]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redactSensitive(child)]));
  }
  return value;
}

function messagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

class AwsSecretReader implements SecretReader {
  private readonly client: SecretsManagerClient;

  constructor(config: SecretsManagerClientConfig = {}) {
    this.client = new SecretsManagerClient(config);
  }

  async getSecretValue(secretArn: string): Promise<string> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!result.SecretString) throw new Error('secret value is unavailable');
    return result.SecretString;
  }
}

class ZaiConversationalClient implements ConversationalModel {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maximumOutput: number;
  private readonly maximumResponseBytes: number;
  private readonly transport: ModelTransport;
  private readonly secretReader: SecretReader;
  private apiKey?: string;

  constructor(private readonly config: ZaiClientConfig) {
    this.baseUrl = config.baseUrl || DEFAULT_ZAI_CONVERSATIONAL_BASE_URL;
    this.model = config.model || DEFAULT_ZAI_CONVERSATIONAL_MODEL;
    this.timeoutMs = config.timeoutMs || DEFAULT_ZAI_TIMEOUT_MS;
    this.maximumOutput = config.maximumOutput || DEFAULT_ZAI_MAXIMUM_OUTPUT;
    this.maximumResponseBytes = config.maximumResponseBytes || DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (!config.enabled) throw new ConversationalModelError('model_config_error', 'Conversational model is disabled');
    if (!config.secretArn) throw new ConversationalModelError('model_config_error', 'Conversational model secret is not configured');
    let parsed: URL;
    try {
      parsed = new URL(this.baseUrl);
    } catch {
      throw new ConversationalModelError('model_config_error', 'Conversational model endpoint is invalid');
    }
    if (parsed.protocol !== 'https:' || (!config.allowTestHost && parsed.hostname !== 'api.z.ai')) {
      throw new ConversationalModelError('model_config_error', 'Conversational model endpoint is not permitted');
    }
    if (
      !Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000
      || !Number.isInteger(this.maximumOutput) || this.maximumOutput <= 0 || this.maximumOutput > 16_384
      || !Number.isInteger(this.maximumResponseBytes) || this.maximumResponseBytes <= 0
    ) throw new ConversationalModelError('model_config_error', 'Conversational model limits are invalid');
    this.transport = config.transport || (async ({ url, init }) => fetch(url, init));
    this.secretReader = config.secretReader || new AwsSecretReader();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const maxTokens = request.maxTokens || this.maximumOutput;
    if (maxTokens > this.maximumOutput || request.tools.length !== 1) {
      throw new ConversationalModelError('model_config_error', 'Conversational model request limits are invalid');
    }
    const apiKey = await this.loadApiKey();
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new ConversationalModelError(
          'model_timeout',
          'The assistant took too long. Please try again.'
        ));
      }, this.timeoutMs);
    });
    try {
      const operation = (async (): Promise<ModelResponse> => {
        const response = await this.transport({
          url: messagesUrl(this.baseUrl),
          init: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: this.model,
              max_tokens: maxTokens,
              system: request.system,
              messages: request.messages,
              tools: request.tools,
              tool_choice: request.toolChoice || { type: 'auto' },
            }),
          },
        });
        if (response.status === 429) {
          throw new ConversationalModelError('model_rate_limited', 'The assistant is busy. Please try again shortly.');
        }
        if (response.status === 401 || response.status === 403) {
          throw new ConversationalModelError('model_policy_rejected', 'The assistant provider rejected the request.');
        }
        if (response.status < 200 || response.status >= 300) {
          throw new ConversationalModelError('model_unavailable', 'The assistant is temporarily unavailable. Please try again.');
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > this.maximumResponseBytes) {
          throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
        }
        if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
          throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
        }
        return this.parseResponse(parsedBody as Record<string, unknown>, request, maxTokens);
      })();
      return await Promise.race([operation, timeout]);
    } catch (error) {
      emitConversationalMetric('ModelFailures', 1, 'model');
      logConversationalEvent('model_failed', 'model');
      if (error instanceof ConversationalModelError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new ConversationalModelError('model_timeout', 'The assistant took too long. Please try again.');
      }
      throw new ConversationalModelError('model_unavailable', 'The assistant is temporarily unavailable. Please try again.');
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private parseResponse(
    body: Record<string, unknown>,
    request: ModelRequest,
    maximumOutput: number
  ): ModelResponse {
    const content = body.content;
    if (
      body.usage !== undefined
      && (!body.usage || typeof body.usage !== 'object' || Array.isArray(body.usage))
    ) {
      throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
    }
    const usage = (body.usage || {}) as Record<string, unknown>;
    for (const value of [usage.input_tokens, usage.output_tokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
        throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
      }
    }
    const tokens = {
      ...(Number.isInteger(usage.input_tokens) ? { inputTokens: Number(usage.input_tokens) } : {}),
      ...(Number.isInteger(usage.output_tokens) ? { outputTokens: Number(usage.output_tokens) } : {}),
    };
    if (
      body.type !== 'message'
      || !Array.isArray(content)
      || content.length !== 1
      || (tokens.outputTokens !== undefined && tokens.outputTokens > maximumOutput)
    ) {
      throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
    }
    const rawBlock = content[0];
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
      throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
    }
    const block = rawBlock as Record<string, unknown>;
    if (
      body.stop_reason === 'tool_use'
      && block.type === 'tool_use'
      && block.name === request.expectedTool
      && block.input
      && typeof block.input === 'object'
      && !Array.isArray(block.input)
    ) {
      return { kind: 'tool', name: request.expectedTool, input: block.input as Record<string, unknown>, ...tokens };
    }
    if (
      request.allowText
      && body.stop_reason === 'end_turn'
      && block.type === 'text'
      && typeof block.text === 'string'
      && block.text.length > 0
      && Buffer.byteLength(block.text, 'utf8') <= 16_384
    ) {
      return { kind: 'text', text: block.text, ...tokens };
    }
    throw new ConversationalModelError('model_invalid_output', 'The assistant returned an invalid response.');
  }

  private async loadApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    let raw: string;
    try {
      raw = await this.secretReader.getSecretValue(this.config.secretArn!);
    } catch {
      throw new ConversationalModelError('model_config_error', 'Conversational model credentials are unavailable');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ConversationalModelError('model_config_error', 'Conversational model credentials are invalid');
    }
    const apiKey = value && typeof value === 'object' ? (value as Record<string, unknown>).apiKey : undefined;
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 1_000) {
      throw new ConversationalModelError('model_config_error', 'Conversational model credentials are invalid');
    }
    this.apiKey = apiKey;
    return apiKey;
  }
}

function conversationalModelConfigFromEnv(): ZaiClientConfig {
  const enabled = conversationalRolloutSnapshot().eligibility.runtimeAvailable;
  const secretArn = process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN || undefined;
  if (enabled && !secretArn) {
    throw new ConversationalModelError('model_config_error', 'Conversational model secret is not configured');
  }
  return {
    enabled,
    secretArn,
    baseUrl: process.env.ZAI_CONVERSATIONAL_BASE_URL,
    model: process.env.ZAI_CONVERSATIONAL_MODEL,
    timeoutMs: process.env.ZAI_CONVERSATIONAL_TIMEOUT_MS
      ? Number(process.env.ZAI_CONVERSATIONAL_TIMEOUT_MS)
      : undefined,
    maximumOutput: process.env.ZAI_CONVERSATIONAL_MAX_OUTPUT
      ? Number(process.env.ZAI_CONVERSATIONAL_MAX_OUTPUT)
      : undefined,
  };
}

function createConversationalModelFromEnv(): ZaiConversationalClient | null {
  const config = conversationalModelConfigFromEnv();
  return config.enabled ? new ZaiConversationalClient(config) : null;
}

export {
  ANTHROPIC_VERSION,
  AwsSecretReader,
  ConversationalModelError,
  DEFAULT_ZAI_CONVERSATIONAL_BASE_URL,
  DEFAULT_ZAI_CONVERSATIONAL_MODEL,
  DEFAULT_ZAI_MAXIMUM_OUTPUT,
  DEFAULT_ZAI_TIMEOUT_MS,
  ZaiConversationalClient,
  conversationalModelConfigFromEnv,
  createConversationalModelFromEnv,
  messagesUrl,
  redactSensitive,
};
export type {
  ConversationalModel,
  ModelErrorCode,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelTransport,
  SecretReader,
  ZaiClientConfig,
};
