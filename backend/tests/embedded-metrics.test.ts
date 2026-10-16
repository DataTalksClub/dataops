import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitRecurringCronMetrics } from '../src/cron/recurringMetrics';
import { emitApiRequestMetrics } from '../src/apiRequestTelemetry';

/**
 * The backend Lambda logs in JSON format, which wraps every console.log line
 * in a {"message": ...} envelope. CloudWatch only extracts an EMF record that
 * is the whole log line, so metrics must bypass console.log entirely.
 */
function captureOutput() {
  const consoleLines: string[] = [];
  const stdoutLines: string[] = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(' '));
  };
  process.stdout.write = ((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    consoleLines,
    stdoutLines,
    restore() {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    },
  };
}

describe('Embedded metrics', () => {
  it('writes the daily pass metric as a bare stdout line, never through console.log', () => {
    const output = captureOutput();
    try {
      emitRecurringCronMetrics({ passes: 1, failures: 0, timestamp: 1792137643295 });
    } finally {
      output.restore();
    }
    assert.deepStrictEqual(output.consoleLines, []);
    assert.strictEqual(output.stdoutLines.length, 1);
    assert.ok(output.stdoutLines[0].endsWith('\n'));
    const record = JSON.parse(output.stdoutLines[0]);
    assert.strictEqual(record._aws.CloudWatchMetrics[0].Namespace, 'DataOps/Recurring');
    assert.strictEqual(record.CronPass, 1);
  });

  it('writes the portal API metric as a bare stdout line, never through console.log', () => {
    const output = captureOutput();
    try {
      emitApiRequestMetrics({
        routeFamily: 'tasks',
        method: 'GET',
        statusCode: 200,
        durationMs: 12,
        requestId: 'request-1',
        coldStart: false,
        timestamp: 1792137643295,
      });
    } finally {
      output.restore();
    }
    assert.deepStrictEqual(output.consoleLines, []);
    assert.strictEqual(output.stdoutLines.length, 1);
    assert.strictEqual(JSON.parse(output.stdoutLines[0])._aws.CloudWatchMetrics[0].Namespace, 'DataOps/PortalAPI');
  });
});
