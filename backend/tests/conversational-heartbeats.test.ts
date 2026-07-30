import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { ExecutorRegistry } from '../src/conversation/execution';
import { handleExecutionWorkerEvent } from '../src/execution-worker-handler';
import { handleResultNotification } from '../src/result-notification-handler';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const EXECUTION_PULSE = {
  source: 'aws.events',
  'detail-type': 'Scheduled Event',
  detail: { dataopsAction: 'conversational-execution-health-pulse' },
};
const RECOVERY_PULSE = {
  source: 'aws.events',
  'detail-type': 'Scheduled Event',
  detail: { dataopsAction: 'conversational-execution-recovery' },
};

function fakeClient(commands: unknown[] = []): DynamoDBDocumentClient {
  return {
    async send(command: unknown) {
      commands.push(command);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
}

describe('scheduled conversational heartbeat pulses', () => {
  before(() => {
    process.env.NODE_ENV = 'test';
    process.env.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED = 'true';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'true';
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'todo';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED = 'false';
  });

  after(() => {
    delete process.env.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED;
    delete process.env.CONVERSATIONAL_EXECUTION_ENABLED;
    delete process.env.CONVERSATIONAL_ENABLED_PLUGINS;
    delete process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED;
    delete process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED;
    delete process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED;
  });

  it('handles the worker pulse before stream/recovery work with one fixed heartbeat put', async () => {
    const commands: Array<{ constructor?: { name?: string }; input?: Record<string, unknown> }> = [];
    const metrics: Array<{ name: string; value: number; component: string; timestamp?: number }> = [];
    let processCalls = 0;
    let recoveryCalls = 0;
    const result = await handleExecutionWorkerEvent(EXECUTION_PULSE, {
      client: fakeClient(commands),
      now: () => NOW,
      async processAttempt() {
        processCalls += 1;
        throw new Error('pulse must not process an attempt');
      },
      async runRecovery() {
        recoveryCalls += 1;
        throw new Error('pulse must not run recovery');
      },
      emitConversationalMetric(name, value, component, timestamp) {
        metrics.push({ name, value, component, timestamp });
      },
    });

    assert.deepEqual(result, { pulsed: true, component: 'execution_worker' });
    assert.equal(processCalls, 0);
    assert.equal(recoveryCalls, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].constructor?.name, 'PutCommand');
    assert.deepEqual(commands[0].input?.Item, {
      PK: 'ROLLOUT#HEARTBEAT',
      SK: 'COMPONENT#execution_worker',
      recordType: 'rollout_heartbeat',
      schemaVersion: 1,
      component: 'execution_worker',
      updatedAt: NOW.toISOString(),
    });
    assert.deepEqual(metrics, [{
      name: 'ExecutionWorkerHeartbeatAgeSeconds',
      value: 0,
      component: 'execution-worker',
      timestamp: NOW.getTime(),
    }]);
  });

  it('does not pulse from stream traffic or when execution is disabled', async () => {
    const writes: string[] = [];
    const metrics: string[] = [];
    await handleExecutionWorkerEvent({ Records: [] }, {
      client: fakeClient(),
      registry: new ExecutorRegistry([]),
      writeRolloutHeartbeat: async (_client, component) => {
        writes.push(component);
      },
      emitConversationalMetric: (name) => {
        metrics.push(name);
      },
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(metrics, []);

    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'false';
    try {
      const disabled = await handleExecutionWorkerEvent(EXECUTION_PULSE, {
        client: {
          async send() {
            throw new Error('disabled pulse must not touch DynamoDB');
          },
        } as unknown as DynamoDBDocumentClient,
        emitConversationalMetric: (name) => {
          metrics.push(name);
        },
      });
      assert.deepEqual(disabled, { disabled: true });
      assert.deepEqual(metrics, []);
    } finally {
      process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'true';
    }
  });

  it('emits the recovery fixed-zero pulse only after an idle successful run', async () => {
    const sequence: string[] = [];
    const result = await handleExecutionWorkerEvent(RECOVERY_PULSE, {
      client: fakeClient(),
      registry: new ExecutorRegistry([]),
      now: () => NOW,
      runRecovery: async () => {
        sequence.push('recovery');
        return { attempted: 0, completed: 0, deferred: 0 };
      },
      oldestDueExecutionAgeSeconds: async () => {
        sequence.push('oldest');
        return null;
      },
      writeRolloutHeartbeat: async (_client, component) => {
        sequence.push(`write:${component}`);
      },
      emitConversationalMetric: (name, value) => {
        sequence.push(`metric:${name}:${value}`);
      },
    });
    assert.deepEqual(result, { attempted: 0, completed: 0, deferred: 0 });
    assert.deepEqual(sequence, [
      'recovery',
      'oldest',
      'write:recovery',
      'metric:RecoveryHeartbeatAgeSeconds:0',
    ]);
  });

  it('emits no worker or recovery success pulse when its handler path fails', async () => {
    const metrics: string[] = [];
    await assert.rejects(
      handleExecutionWorkerEvent(EXECUTION_PULSE, {
        client: fakeClient(),
        writeRolloutHeartbeat: async () => {
          throw new Error('heartbeat write failed');
        },
        emitConversationalMetric: (name) => {
          metrics.push(name);
        },
      }),
      /heartbeat write failed/
    );
    assert.deepEqual(metrics, []);

    let recoveryHeartbeatWrites = 0;
    await assert.rejects(
      handleExecutionWorkerEvent(RECOVERY_PULSE, {
        client: fakeClient(),
        registry: new ExecutorRegistry([]),
        runRecovery: async () => ({ attempted: 0, completed: 0, deferred: 0 }),
        oldestDueExecutionAgeSeconds: async () => {
          throw new Error('recovery inspection failed');
        },
        writeRolloutHeartbeat: async () => {
          recoveryHeartbeatWrites += 1;
        },
        emitConversationalMetric: (name) => {
          metrics.push(name);
        },
      }),
      /recovery inspection failed/
    );
    assert.equal(recoveryHeartbeatWrites, 0);
    assert.deepEqual(metrics, []);
  });

  it('treats an empty result outbox as a successful dispatcher pulse', async () => {
    const sequence: string[] = [];
    const result = await handleResultNotification({
      client: fakeClient(),
      now: () => NOW,
      transport: { async sendPrivateMessage() {} },
      runResultDispatcher: async () => {
        sequence.push('dispatcher');
        return { attempted: 0, delivered: 0, outcomeUnknown: 0, rejected: 0 };
      },
      oldestPendingResultAgeSeconds: async () => {
        sequence.push('oldest');
        return null;
      },
      writeRolloutHeartbeat: async (_client, component) => {
        sequence.push(`write:${component}`);
      },
      emitConversationalMetric: (name, value) => {
        sequence.push(`metric:${name}:${value}`);
      },
    });
    assert.deepEqual(result, {
      attempted: 0,
      delivered: 0,
      outcomeUnknown: 0,
      rejected: 0,
    });
    assert.deepEqual(sequence, [
      'dispatcher',
      'oldest',
      'metric:ResultDeliveryOldestPendingAgeSeconds:0',
      'write:result_dispatcher',
      'metric:ResultDispatcherHeartbeatAgeSeconds:0',
    ]);
  });

  it('emits no dispatcher success pulse when its bounded run fails', async () => {
    const metrics: string[] = [];
    let heartbeatWrites = 0;
    await assert.rejects(
      handleResultNotification({
        client: fakeClient(),
        transport: { async sendPrivateMessage() {} },
        runResultDispatcher: async () => ({
          attempted: 0,
          delivered: 0,
          outcomeUnknown: 0,
          rejected: 0,
        }),
        oldestPendingResultAgeSeconds: async () => {
          throw new Error('dispatcher inspection failed');
        },
        writeRolloutHeartbeat: async () => {
          heartbeatWrites += 1;
        },
        emitConversationalMetric: (name) => {
          metrics.push(name);
        },
      }),
      /dispatcher inspection failed/
    );
    assert.equal(heartbeatWrites, 0);
    assert.deepEqual(metrics, []);
  });
});
