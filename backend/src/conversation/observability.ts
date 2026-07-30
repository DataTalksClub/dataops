type ConversationalMetricName =
  | 'ExecutionOutcomeUnknown'
  | 'RecoveryOldestDueAgeSeconds'
  | 'ExecutionWorkerHeartbeatAgeSeconds'
  | 'RecoveryHeartbeatAgeSeconds'
  | 'ResultDeliverySucceeded'
  | 'ResultDeliveryFailed'
  | 'ResultDeliveryOutcomeUnknown'
  | 'ResultDeliveryOldestPendingAgeSeconds'
  | 'ResultDispatcherHeartbeatAgeSeconds'
  | 'TelegramWebhookFailures'
  | 'ModelFailures'
  | 'VoiceFailures'
  | 'PhotoFailures'
  | 'TypefullyDraftFailed'
  | 'MediaCleanupFailed'
  | 'RetentionCleanupFailed'
  | 'ExecutionFailedSafe';

type ConversationalComponent =
  | 'execution-worker'
  | 'recovery'
  | 'result-dispatcher'
  | 'telegram'
  | 'model'
  | 'voice'
  | 'photo'
  | 'typefully'
  | 'media-cleanup'
  | 'retention-cleanup';

const METRIC_NAMESPACE = 'DataOps/ConversationalAgent';
const METRIC_NAMES = new Set<ConversationalMetricName>([
  'ExecutionOutcomeUnknown',
  'RecoveryOldestDueAgeSeconds',
  'ExecutionWorkerHeartbeatAgeSeconds',
  'RecoveryHeartbeatAgeSeconds',
  'ResultDeliverySucceeded',
  'ResultDeliveryFailed',
  'ResultDeliveryOutcomeUnknown',
  'ResultDeliveryOldestPendingAgeSeconds',
  'ResultDispatcherHeartbeatAgeSeconds',
  'TelegramWebhookFailures',
  'ModelFailures',
  'VoiceFailures',
  'PhotoFailures',
  'TypefullyDraftFailed',
  'MediaCleanupFailed',
  'RetentionCleanupFailed',
  'ExecutionFailedSafe',
]);
const COMPONENTS = new Set<ConversationalComponent>([
  'execution-worker',
  'recovery',
  'result-dispatcher',
  'telegram',
  'model',
  'voice',
  'photo',
  'typefully',
  'media-cleanup',
  'retention-cleanup',
]);
const SAFE_EVENT_CODES = new Set([
  'configuration_rejected',
  'maintenance_reply_failed',
  'webhook_failed',
  'model_failed',
  'media_failed',
  'cleanup_failed',
  'execution_failed_safe',
  'execution_outcome_unknown',
  'result_delivery_failed',
  'result_delivery_outcome_unknown',
]);

function emitConversationalMetric(
  metricName: ConversationalMetricName,
  value: number,
  component: ConversationalComponent,
  timestamp = Date.now()
): void {
  try {
    if (
      !METRIC_NAMES.has(metricName)
      || !COMPONENTS.has(component)
      || !Number.isFinite(value)
      || value < 0
      || !Number.isSafeInteger(timestamp)
    ) return;
    console.log(JSON.stringify({
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [{
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Component']],
          Metrics: [{
            Name: metricName,
            Unit: metricName.endsWith('Seconds') ? 'Seconds' : 'Count',
          }],
        }],
      },
      Component: component,
      [metricName]: value,
    }));
  } catch {
    // Telemetry must never break the business operation.
  }
}

function logConversationalEvent(code: string, component: ConversationalComponent): void {
  try {
    if (!SAFE_EVENT_CODES.has(code) || !COMPONENTS.has(component)) return;
    console.log(JSON.stringify({
      namespace: METRIC_NAMESPACE,
      component,
      event: code,
    }));
  } catch {
    // Logging must never break the business operation.
  }
}

export {
  METRIC_NAMESPACE,
  emitConversationalMetric,
  logConversationalEvent,
};
export type {
  ConversationalComponent,
  ConversationalMetricName,
};
