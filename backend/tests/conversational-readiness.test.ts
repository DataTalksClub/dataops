import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handleConversationalReadiness } from '../src/routes/conversationalReadiness';

function setRollout(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
    CONVERSATIONAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_ENABLED_PLUGINS: 'none',
    CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
    ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN: '',
    GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN: '',
    ZAI_VISION_API_KEY_SECRET_ARN: '',
    CONVERSATIONAL_TYPEFULLY_PROVIDER_CONFIGURED: 'false',
    CONVERSATIONAL_FAILURE_QUEUE_CONFIGURED: 'false',
    CONVERSATIONAL_ALARM_TOPIC_CONFIGURED: 'false',
    CONVERSATIONAL_ALARMS_CONFIGURED: 'false',
    CONVERSATIONAL_LOG_GROUPS_CONFIGURED: 'false',
    CONVERSATIONAL_ALARM_SUBSCRIPTION_CONFIRMED: 'false',
    DATAOPS_DEPLOYMENT_ID: 'candidate-128',
    ...overrides,
  });
}

function fakeClient(role: 'admin' | 'operator' = 'admin') {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name;
      commands.push({ name, input: command.input });
      if (command.input.TableName === 'Users') {
        return {
          Item: {
            PK: 'USER#actor',
            SK: 'USER#actor',
            id: 'actor',
            role,
            disabled: false,
          },
        };
      }
      if (name === 'GetCommand') {
        return {
          Item: {
            component: String((command.input.Key as Record<string, unknown>).SK)
              .replace('COMPONENT#', ''),
            updatedAt: '2026-07-30T12:00:00.000Z',
          },
        };
      }
      if (name === 'QueryCommand') {
        return { Items: [{ readyAt: '2026-07-30T11:59:00.000Z' }] };
      }
      throw new Error(`unexpected ${name}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, commands };
}

describe('conversational readiness', () => {
  it('is admin-only and reports disabled components without state reads', async () => {
    setRollout();
    const { client, commands } = fakeClient('admin');
    const response = await handleConversationalReadiness(
      '/api/conversational/readiness',
      'GET',
      { headers: { 'x-user-id': 'actor' } } as never,
      client,
      new Date('2026-07-30T12:00:00.000Z')
    );
    assert.equal(response?.statusCode, 200);
    const body = JSON.parse(response!.body);
    assert.deepEqual(body.controls, {
      telegramIngress: false,
      executionLeasing: false,
      enabledPlugins: [],
      typefullyExternalExecution: false,
      voice: false,
      photo: false,
    });
    assert.equal(body.freshness.executionWorker.status, 'not_applicable');
    assert.equal(body.freshness.recovery.status, 'not_applicable');
    assert.equal(body.freshness.resultDispatcher.status, 'not_applicable');
    assert.equal(body.freshness.resultOldestPending.status, 'not_applicable');
    assert.deepEqual(commands.map(({ name }) => name), ['GetCommand']);
    assert.ok(commands.every(({ name }) => name !== 'ScanCommand'));
  });

  it('uses three exact heartbeat gets and one limit-one indexed pending query when enabled', async () => {
    setRollout({
      CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'true',
      CONVERSATIONAL_EXECUTION_ENABLED: 'true',
      CONVERSATIONAL_ENABLED_PLUGINS: 'todo',
      ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN: 'private-secret-reference',
      GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN: 'private-secret-reference',
      ZAI_VISION_API_KEY_SECRET_ARN: 'private-secret-reference',
      CONVERSATIONAL_TYPEFULLY_PROVIDER_CONFIGURED: 'true',
      CONVERSATIONAL_FAILURE_QUEUE_CONFIGURED: 'true',
      CONVERSATIONAL_ALARM_TOPIC_CONFIGURED: 'true',
      CONVERSATIONAL_ALARMS_CONFIGURED: 'true',
      CONVERSATIONAL_LOG_GROUPS_CONFIGURED: 'true',
      CONVERSATIONAL_ALARM_SUBSCRIPTION_CONFIRMED: 'true',
    });
    const { client, commands } = fakeClient('admin');
    const response = await handleConversationalReadiness(
      '/api/conversational/readiness',
      'GET',
      { headers: { 'x-user-id': 'actor' } } as never,
      client,
      new Date('2026-07-30T12:00:00.000Z')
    );
    assert.equal(response?.statusCode, 200);
    const heartbeatGets = commands.filter(({ input }) => input.TableName === 'ConversationalState'
      && input.Key !== undefined);
    const queries = commands.filter(({ name }) => name === 'QueryCommand');
    assert.equal(heartbeatGets.length, 3);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].input.IndexName, 'GSI2');
    assert.equal(queries[0].input.Limit, 1);
    assert.equal(queries[0].input.ScanIndexForward, true);
    assert.ok(commands.every(({ name }) => name !== 'ScanCommand'));
    const body = JSON.parse(response!.body);
    assert.equal(body.providers.conversational.configured, true);
    assert.equal(body.providers.voice.configured, true);
    assert.equal(body.providers.photo.configured, true);
    assert.equal(body.providers.typefully.configured, true);
    assert.ok(body.plugins.every((plugin: Record<string, unknown>) => (
      typeof plugin.buildDigest === 'string'
      && typeof plugin.schemaDigest === 'string'
    )));
    assert.deepEqual(body.infrastructure, {
      failureQueue: true,
      alarmTopic: true,
      alarms: true,
      customLogGroups: true,
      subscriptionConfirmed: true,
    });
    assert.equal(body.deploymentId, 'candidate-128');
    assert.doesNotMatch(response!.body, /secret-arn|chat[_-]?id|https?:\/\//i);
  });

  it('rejects non-admin users', async () => {
    setRollout();
    const { client } = fakeClient('operator');
    const response = await handleConversationalReadiness(
      '/api/conversational/readiness',
      'GET',
      { headers: { 'x-user-id': 'actor' } } as never,
      client
    );
    assert.equal(response?.statusCode, 403);
  });
});
