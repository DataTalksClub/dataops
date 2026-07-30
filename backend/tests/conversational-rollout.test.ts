import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ConversationalRolloutConfigurationError,
  parseConversationalRolloutSnapshot,
} from '../src/conversation/rollout';
import {
  emitConversationalMetric,
  logConversationalEvent,
  METRIC_NAMESPACE,
} from '../src/conversation/observability';

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
    CONVERSATIONAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_ENABLED_PLUGINS: 'none',
    CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
    CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
    ...overrides,
  };
}

describe('conversational rollout snapshot', () => {
  it('exhaustively accepts exactly the valid six-control matrix and derives eligibility', () => {
    const booleans = ['false', 'true'] as const;
    const plugins = ['none', 'todo', 'typefully', 'todo,typefully'] as const;
    let accepted = 0;
    let rejected = 0;
    for (const ingress of booleans) {
      for (const execution of booleans) {
        for (const enabledPlugins of plugins) {
          for (const external of booleans) {
            for (const voice of booleans) {
              for (const photo of booleans) {
                const expectedValid = (
                  (voice === 'false' || ingress === 'true')
                  && (photo === 'false' || ingress === 'true')
                  && (
                    external === 'false'
                    || (execution === 'true' && enabledPlugins.includes('typefully'))
                  )
                );
                const candidate = environment({
                  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: ingress,
                  CONVERSATIONAL_EXECUTION_ENABLED: execution,
                  CONVERSATIONAL_ENABLED_PLUGINS: enabledPlugins,
                  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: external,
                  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: voice,
                  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: photo,
                });
                if (!expectedValid) {
                  assert.throws(
                    () => parseConversationalRolloutSnapshot(candidate),
                    ConversationalRolloutConfigurationError
                  );
                  rejected += 1;
                  continue;
                }
                const snapshot = parseConversationalRolloutSnapshot(candidate);
                const hasTodo = enabledPlugins === 'todo' || enabledPlugins === 'todo,typefully';
                const hasTypefully = enabledPlugins.includes('typefully');
                assert.equal(snapshot.eligibility.runtimeAvailable, ingress === 'true');
                assert.equal(snapshot.eligibility.todoVisible, hasTodo);
                assert.equal(
                  snapshot.eligibility.todoApprovalAndDispatch,
                  execution === 'true' && hasTodo
                );
                assert.equal(snapshot.eligibility.typefullyVisible, hasTypefully);
                assert.equal(
                  snapshot.eligibility.typefullyApprovalAndDispatch,
                  execution === 'true' && hasTypefully && external === 'true'
                );
                assert.equal(snapshot.eligibility.resultDelivery, ingress === 'true');
                assert.equal(snapshot.eligibility.voiceAvailable, voice === 'true');
                assert.equal(snapshot.eligibility.photoAvailable, photo === 'true');
                accepted += 1;
              }
            }
          }
        }
      }
    }
    assert.equal(accepted + rejected, 128);
    assert.ok(accepted > 0);
    assert.ok(rejected > 0);
  });

  it('rejects missing, whitespace-bearing, duplicate, unsorted, unknown, and retired values', () => {
    const invalid = [
      { CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: undefined },
      { CONVERSATIONAL_EXECUTION_ENABLED: ' true' },
      { CONVERSATIONAL_ENABLED_PLUGINS: '' },
      { CONVERSATIONAL_ENABLED_PLUGINS: 'todo,todo' },
      { CONVERSATIONAL_ENABLED_PLUGINS: 'typefully,todo' },
      { CONVERSATIONAL_ENABLED_PLUGINS: 'podcast' },
      { CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'TRUE' },
      { CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: '0' },
      { CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false ' },
      { CONVERSATIONAL_AGENT_ENABLED: 'false' },
      { CONVERSATIONAL_RESULT_DELIVERY_ENABLED: 'false' },
    ];
    for (const overrides of invalid) {
      assert.throws(
        () => parseConversationalRolloutSnapshot(environment(overrides)),
        ConversationalRolloutConfigurationError
      );
    }
  });

  it('returns a deeply immutable snapshot and static execution decisions', () => {
    const snapshot = parseConversationalRolloutSnapshot(environment({
      CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'true',
      CONVERSATIONAL_EXECUTION_ENABLED: 'true',
      CONVERSATIONAL_ENABLED_PLUGINS: 'todo,typefully',
      CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'true',
    }));
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.controls));
    assert.ok(Object.isFrozen(snapshot.controls.enabledPlugins));
    assert.ok(Object.isFrozen(snapshot.eligibility));
    assert.equal(snapshot.executionAttemptEnabled('todo:create:self'), true);
    assert.equal(snapshot.executionAttemptEnabled('typefully:create-saved-draft'), true);
    assert.equal(snapshot.executionAttemptEnabled('podcast:create'), false);
    assert.throws(() => {
      (snapshot.controls.enabledPlugins as string[]).push('podcast');
    });
  });
});

describe('bounded conversational observability', () => {
  it('emits only allowlisted fixed-cardinality EMF and recursively accepts no payload fields', () => {
    const output: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      emitConversationalMetric('ResultDeliverySucceeded', 1, 'result-dispatcher', 123);
      emitConversationalMetric(
        'ResultDeliverySucceeded',
        Number.NaN,
        'result-dispatcher',
        123
      );
      logConversationalEvent('result_delivery_failed', 'result-dispatcher');
      logConversationalEvent('private-id=123 secret=https://private.example', 'telegram');
    } finally {
      console.log = original;
    }
    assert.equal(output.length, 2);
    const metric = JSON.parse(output[0]);
    assert.equal(metric._aws.CloudWatchMetrics[0].Namespace, METRIC_NAMESPACE);
    assert.deepEqual(metric._aws.CloudWatchMetrics[0].Dimensions, [['Component']]);
    assert.deepEqual(Object.keys(metric).sort(), [
      'Component',
      'ResultDeliverySucceeded',
      '_aws',
    ]);
    const combined = output.join('\n');
    assert.doesNotMatch(combined, /private-id|private\.example|secret=/i);
  });
});
