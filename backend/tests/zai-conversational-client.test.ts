import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANTHROPIC_VERSION,
  ConversationalModelError,
  DEFAULT_ZAI_CONVERSATIONAL_BASE_URL,
  DEFAULT_ZAI_CONVERSATIONAL_MODEL,
  ZaiConversationalClient,
  conversationalModelConfigFromEnv,
  createConversationalModelFromEnv,
  messagesUrl,
  redactSensitive,
  type ModelTransport,
} from '../src/conversation/zaiClient';

const request = {
  system: 'core rules',
  messages: [{ role: 'user' as const, content: 'select a plugin' }],
  tools: [{
    name: 'skill_load',
    description: 'load one skill',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { plugin: { type: 'string' } },
      required: ['plugin'],
    },
  }],
  expectedTool: 'skill_load',
  allowText: true,
};

function response(status: number, body: unknown) {
  return { status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
}

function client(transport: ModelTransport) {
  return new ZaiConversationalClient({
    enabled: true,
    secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
    transport,
    secretReader: { async getSecretValue() { return JSON.stringify({ apiKey: 'test-key-value' }); } },
  });
}

test('z.ai client sends the exact Anthropic-compatible defaults and one tool', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const result = await client(async (value) => {
    captured = value;
    return response(200, {
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: { plugin: 'fake.todo' } }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  }).complete(request);
  assert.equal(captured!.url, messagesUrl(DEFAULT_ZAI_CONVERSATIONAL_BASE_URL));
  const headers = captured!.init.headers as Record<string, string>;
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(headers['x-api-key'], 'test-key-value');
  const body = JSON.parse(String(captured!.init.body));
  assert.equal(body.model, DEFAULT_ZAI_CONVERSATIONAL_MODEL);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ['skill_load']);
  assert.deepEqual(result, {
    kind: 'tool',
    name: 'skill_load',
    input: { plugin: 'fake.todo' },
    inputTokens: 12,
    outputTokens: 4,
  });
});

test('z.ai client accepts bounded clarification text only with end_turn', async () => {
  const result = await client(async () => response(200, {
    type: 'message',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'What should I create?' }],
  })).complete(request);
  assert.deepEqual(result, { kind: 'text', text: 'What should I create?' });
});

test('z.ai client rejects mixed, multiple, unknown, malformed, and oversized output', async () => {
  const bodies = [
    { type: 'message', stop_reason: 'tool_use', content: [
      { type: 'text', text: 'also' },
      { type: 'tool_use', name: 'skill_load', input: { plugin: 'fake.todo' } },
    ] },
    { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'skill_invoke', input: {} }] },
    { type: 'message', stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'skill_load', input: {} }] },
    {
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: {} }],
      usage: { output_tokens: 4097 },
    },
    { type: 'message', stop_reason: 'tool_use', content: [null] },
    { type: 'message', stop_reason: 'tool_use', content: [7] },
    { type: 'message', stop_reason: 'tool_use', content: [[]] },
    {
      type: 'message', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: [] }],
    },
    {
      type: 'message', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: {} }],
      usage: { input_tokens: -1 },
    },
    {
      type: 'message', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: {} }],
      usage: { output_tokens: 1.5 },
    },
    {
      type: 'message', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'skill_load', input: {} }],
      usage: 'not-an-object',
    },
    null,
    7,
    [],
    '{not json',
  ];
  for (const body of bodies) {
    await assert.rejects(
      () => client(async () => response(200, body)).complete(request),
      (error: unknown) => error instanceof ConversationalModelError && error.code === 'model_invalid_output'
    );
  }
  await assert.rejects(
    () => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
      maximumResponseBytes: 10,
      transport: async () => response(200, 'x'.repeat(11)),
      secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
    }).complete(request),
    (error: unknown) => error instanceof ConversationalModelError && error.code === 'model_invalid_output'
  );
  await assert.rejects(
    () => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
      maximumResponseBytes: 200,
      transport: async () => response(200, {
        type: 'message',
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          name: 'skill_load',
          input: { nested: { value: 'x'.repeat(500) } },
        }],
      }),
      secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
    }).complete(request),
    (error: unknown) => error instanceof ConversationalModelError && error.code === 'model_invalid_output'
  );
});

test('z.ai client maps HTTP failures without exposing provider bodies or retrying', async () => {
  const cases: Array<[number, string]> = [
    [401, 'model_policy_rejected'],
    [403, 'model_policy_rejected'],
    [429, 'model_rate_limited'],
    [500, 'model_unavailable'],
  ];
  for (const [status, code] of cases) {
    let calls = 0;
    await assert.rejects(
      () => client(async () => {
        calls += 1;
        return response(status, { authorization: 'Bearer leaked-value', apiKey: 'leaked-value' });
      }).complete(request),
      (error: unknown) => (
        error instanceof ConversationalModelError
        && error.code === code
        && !error.message.includes('leaked-value')
      )
    );
    assert.equal(calls, 1);
  }
});

test('z.ai client aborts at its deadline and maps ambiguous network failures safely', async () => {
  await assert.rejects(
    () => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
      timeoutMs: 5,
      secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
      transport: async ({ init }) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }).complete(request),
    (error: unknown) => error instanceof ConversationalModelError && error.code === 'model_timeout'
  );
  await assert.rejects(
    () => client(async () => { throw new Error('network ambiguous apiKey=leak'); }).complete(request),
    (error: unknown) => (
      error instanceof ConversationalModelError
      && error.code === 'model_unavailable'
      && !error.message.includes('leak')
    )
  );
});

test('z.ai deadline covers body reads, redacts stream failures, and cleans up its timer', async () => {
  let stalledCalls = 0;
  let stalledSignal: AbortSignal | undefined;
  await assert.rejects(
    () => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
      timeoutMs: 10,
      secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
      transport: async ({ init }) => {
        stalledCalls += 1;
        stalledSignal = init.signal || undefined;
        return {
          status: 200,
          text: async () => new Promise<string>(() => {}),
        };
      },
    }).complete(request),
    (error: unknown) => (
      error instanceof ConversationalModelError
      && error.code === 'model_timeout'
      && !error.message.includes('test-key')
    )
  );
  assert.equal(stalledCalls, 1);
  assert.equal(stalledSignal?.aborted, true);

  let throwingCalls = 0;
  await assert.rejects(
    () => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
      timeoutMs: 100,
      secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
      transport: async () => {
        throwingCalls += 1;
        return {
          status: 200,
          async text() {
            throw new Error('body-marker authorization=Bearer body-stream-secret');
          },
        };
      },
    }).complete(request),
    (error: unknown) => (
      error instanceof ConversationalModelError
      && error.code === 'model_unavailable'
      && !error.message.includes('body-marker')
      && !error.message.includes('body-stream-secret')
    )
  );
  assert.equal(throwingCalls, 1);

  let completedSignal: AbortSignal | undefined;
  await new ZaiConversationalClient({
    enabled: true,
    secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:zai-test',
    timeoutMs: 20,
    secretReader: { async getSecretValue() { return '{"apiKey":"test"}'; } },
    transport: async ({ init }) => {
      completedSignal = init.signal || undefined;
      return response(200, {
        type: 'message',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'skill_load', input: { plugin: 'fake.todo' } }],
      });
    },
  }).complete(request);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(completedSignal?.aborted, false);
});

test('production configuration is disabled by default and fails closed when enabled without a secret', () => {
  const beforeEnabled = process.env.CONVERSATIONAL_AGENT_ENABLED;
  const beforeSecret = process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN;
  try {
    delete process.env.CONVERSATIONAL_AGENT_ENABLED;
    delete process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN;
    assert.deepEqual(conversationalModelConfigFromEnv(), {
      enabled: false,
      secretArn: undefined,
      baseUrl: undefined,
      model: undefined,
      timeoutMs: undefined,
      maximumOutput: undefined,
    });
    assert.equal(createConversationalModelFromEnv(), null);
    process.env.CONVERSATIONAL_AGENT_ENABLED = 'true';
    assert.throws(() => conversationalModelConfigFromEnv(), (error: unknown) => (
      error instanceof ConversationalModelError && error.code === 'model_config_error'
    ));
    assert.throws(() => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:test',
      baseUrl: 'http://api.z.ai',
    }), ConversationalModelError);
    assert.throws(() => new ZaiConversationalClient({
      enabled: true,
      secretArn: 'arn:test',
      baseUrl: 'https://evil.example',
    }), ConversationalModelError);
  } finally {
    if (beforeEnabled === undefined) delete process.env.CONVERSATIONAL_AGENT_ENABLED;
    else process.env.CONVERSATIONAL_AGENT_ENABLED = beforeEnabled;
    if (beforeSecret === undefined) delete process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN;
    else process.env.ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN = beforeSecret;
  }
});

test('recursive redaction removes sensitive keys and values', () => {
  const redacted = JSON.stringify(redactSensitive({
    nested: {
      authorization: 'Bearer very-secret',
      safe: 'token=another-secret',
      reference: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:private-name',
      values: [{ password: 'bad' }],
    },
  }));
  assert.equal(redacted.includes('very-secret'), false);
  assert.equal(redacted.includes('another-secret'), false);
  assert.equal(redacted.includes('"bad"'), false);
  assert.equal(redacted.includes('private-name'), false);
});
