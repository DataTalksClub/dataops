/**
 * Write one CloudWatch embedded-metric (EMF) record to the function log.
 *
 * It goes straight to stdout, not through `console.log`: with the Lambda
 * JSON log format, `console.log` wraps every line in a `{"message": ...}`
 * envelope, CloudWatch no longer sees an EMF record, and the metric is never
 * created. Raw stdout lines reach the log unwrapped in either log format.
 */
export function writeEmbeddedMetric(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
