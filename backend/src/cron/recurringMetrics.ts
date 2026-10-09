const METRIC_NAMESPACE = 'DataOps/Recurring';
const METRIC_COMPONENT = 'recurring-generation';

export interface RecurringCronMetricInput {
  passes: number;
  failures: number;
  timestamp?: number;
  emit?: (record: string) => void;
}

/**
 * The daily pass reports itself as an embedded metric: CloudWatch reads it
 * straight from the function log, so the metric costs the runner no extra
 * permission and no extra dependency. One record carries both metrics, so a
 * pass and a failure share a timestamp and an alarm can read either.
 */
export function emitRecurringCronMetrics(input: RecurringCronMetricInput): void {
  try {
    const timestamp = input.timestamp ?? Date.now();
    const passes = Math.max(0, Math.trunc(Number(input.passes)));
    const failures = Math.max(0, Math.trunc(Number(input.failures)));
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(passes) || !Number.isFinite(failures)) return;
    const emit = input.emit || ((record: string) => console.log(record));
    emit(JSON.stringify({
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [{
          Namespace: METRIC_NAMESPACE,
          Dimensions: [['Component']],
          Metrics: [
            { Name: 'CronPass', Unit: 'Count' },
            { Name: 'CronFailure', Unit: 'Count' },
          ],
        }],
      },
      Component: METRIC_COMPONENT,
      CronPass: passes,
      CronFailure: failures,
    }));
  } catch {
    // Telemetry must never replace the pass's business outcome.
  }
}
