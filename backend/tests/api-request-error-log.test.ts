import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';

import { handler, withApiRequestTelemetry } from '../src/handler';
import {
  API_REQUEST_FAILED_EVENT,
  loggablePath,
  recordRequestError,
  routeTemplate,
} from '../src/requestErrorLog';
import type { LambdaEvent, LambdaResponse } from '../src/types';
import { useTestDatabase } from './helpers/db';
import { stopLocal } from '../scripts/local-dynamodb';

const CONTEXT = { awsRequestId: 'lambda-request-id-5xx' };

function captureConsole(): { errors: string[]; logs: string[]; restore(): void } {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); };
  console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  return {
    errors,
    logs,
    restore() {
      console.error = originalError;
      console.log = originalLog;
    },
  };
}

function failureRecords(lines: string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return value?.event === API_REQUEST_FAILED_EVENT ? [value] : [];
    } catch {
      return [];
    }
  });
}

function httpEvent(overrides: Partial<LambdaEvent> = {}): LambdaEvent {
  return {
    httpMethod: 'GET',
    path: '/api/health',
    headers: {},
    body: null,
    isBase64Encoded: false,
    queryStringParameters: null,
    ...overrides,
  };
}

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function run(
  event: LambdaEvent,
  operation: () => Promise<LambdaResponse>,
): Promise<{ response: LambdaResponse; errors: string[] }> {
  const captured = captureConsole();
  let reads = 0;
  try {
    const response = await withApiRequestTelemetry(event, CONTEXT, operation, {
      monotonicClock: () => (reads++ === 0 ? 1000 : 3133.4),
      coldStart: false,
      emit: () => {},
    });
    return { response, errors: captured.errors };
  } finally {
    captured.restore();
  }
}

const SECRETS = {
  body: '{"note":"body-secret-marker-5xx"}',
  headers: {
    authorization: 'Bearer bearer-secret-marker-5xx',
    cookie: 'session=cookie-secret-marker-5xx',
  },
  queryStringParameters: { token: 'query-secret-marker-5xx' },
};

function assertNoSecrets(text: string): void {
  for (const marker of [
    'body-secret-marker-5xx',
    'bearer-secret-marker-5xx',
    'cookie-secret-marker-5xx',
    'query-secret-marker-5xx',
  ]) {
    assert.ok(!text.includes(marker), `log leaked ${marker}`);
  }
}

describe('5xx API request error log', () => {
  it('logs a route-returned 5xx once with route, path, status, duration and the recorded cause', async () => {
    const dealId = '0b9d2c1e-6f43-4f1a-9a57-3c2e1d4b5a69';
    const { response, errors } = await run(
      httpEvent({ path: `/api/sponsor-crm/deals/${dealId}/finance/candidates/payments`, ...SECRETS }),
      async () => {
        recordRequestError(Object.assign(
          new Error('Candidate discovery incomplete; retry', { cause: new Error('scan deadline') }),
          { statusCode: 503 },
        ));
        return json(503, { error: 'Finance data is temporarily unavailable; retry' });
      },
    );

    assert.strictEqual(response.statusCode, 503);
    const records = failureRecords(errors);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(records.length, 1);
    const [record] = records;
    assert.strictEqual(record.level, 'ERROR');
    assert.strictEqual(record.requestId, CONTEXT.awsRequestId);
    assert.strictEqual(record.method, 'GET');
    assert.strictEqual(record.route, '/api/sponsor-crm/deals/:id/finance/candidates/payments');
    assert.strictEqual(record.path, `/api/sponsor-crm/deals/${dealId}/finance/candidates/payments`);
    assert.strictEqual(record.routeFamily, 'sponsor_crm');
    assert.strictEqual(record.status, 503);
    assert.strictEqual(record.durationMs, 2133);
    assert.strictEqual(record.errorClass, 'route_handled');
    assert.strictEqual(record.responseError, 'Finance data is temporarily unavailable; retry');
    const error = record.error as Record<string, unknown>;
    assert.strictEqual(error.name, 'Error');
    assert.strictEqual(error.message, 'Candidate discovery incomplete; retry');
    assert.strictEqual(error.statusCode, 503);
    assert.ok(Array.isArray(error.stack));
    assert.deepStrictEqual(error.cause, { name: 'Error', message: 'scan deadline' });
    assertNoSecrets(errors.join('\n'));
  });

  it('logs a 5xx a route returned without any exception', async () => {
    const { errors } = await run(
      httpEvent({ httpMethod: 'POST', path: '/api/v1/intake/leads', ...SECRETS }),
      async () => json(503, { status: 'configuration-error', error: { code: 'rate-limit-unavailable', message: 'Request limiting is unavailable' } }),
    );
    const records = failureRecords(errors);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].method, 'POST');
    assert.strictEqual(records[0].status, 503);
    assert.strictEqual(records[0].error, undefined);
    assert.strictEqual(records[0].responseError, 'rate-limit-unavailable: Request limiting is unavailable');
    assertNoSecrets(errors.join('\n'));
  });

  it('logs an escaping exception exactly once, labeled unhandled', async () => {
    const { response, errors } = await run(
      httpEvent({ httpMethod: 'PUT', path: '/api/cards/card-0001-abcdefghijkl', ...SECRETS }),
      async () => { throw new TypeError('boom from route'); },
    );
    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(errors.length, 1);
    const [record] = failureRecords(errors);
    assert.strictEqual(record.errorClass, 'unhandled_exception');
    assert.strictEqual(record.route, '/api/cards/:id');
    assert.deepStrictEqual(
      { name: (record.error as Record<string, unknown>).name, message: (record.error as Record<string, unknown>).message },
      { name: 'TypeError', message: 'boom from route' },
    );
    assertNoSecrets(errors.join('\n'));
  });

  it('writes nothing for non-5xx responses, even when a route recorded an error', async () => {
    for (const statusCode of [200, 404, 409]) {
      const { errors } = await run(httpEvent({ path: '/api/sponsor-crm/deals' }), async () => {
        recordRequestError(new Error('conditional check failed'));
        return json(statusCode, { error: 'Conflict' });
      });
      assert.deepStrictEqual(errors, []);
    }
  });

  it('keeps errors recorded by concurrent requests apart', async () => {
    const captured = captureConsole();
    try {
      const slow = (label: string, delay: number) => withApiRequestTelemetry(
        httpEvent({ path: `/api/${label}` }),
        { awsRequestId: `req-${label}` },
        async () => {
          recordRequestError(new Error(`cause-${label}`));
          await new Promise((resolve) => setTimeout(resolve, delay));
          return json(500, { error: 'Internal server error' });
        },
        { coldStart: false, emit: () => {} },
      );
      await Promise.all([slow('cards', 20), slow('tasks', 1)]);
    } finally {
      captured.restore();
    }
    const records = failureRecords(captured.errors);
    assert.strictEqual(records.length, 2);
    for (const record of records) {
      assert.strictEqual(
        (record.error as Record<string, unknown>).message,
        `cause-${String(record.path).slice('/api/'.length)}`,
      );
    }
  });

  it('redacts email-bearing path segments and groups identifiers into a route', () => {
    assert.strictEqual(loggablePath('/api/users/person%40example.com'), '/api/users/:redacted');
    assert.strictEqual(loggablePath('/api/users/a@b.c?token=x'), '/api/users/:redacted');
    assert.strictEqual(routeTemplate('/api/tasks/42/comments'), '/api/tasks/:id/comments');
    assert.strictEqual(routeTemplate('/api/sponsor-crm/finance/ledger'), '/api/sponsor-crm/finance/ledger');
    assert.strictEqual(routeTemplate('/api/cards/AbCdEf0123456789xyz'), '/api/cards/:id');
  });
});

describe('5xx API request error log through the Lambda handler', () => {
  before(async () => { await useTestDatabase(); });
  after(async () => { await stopLocal(); });

  it('reports a route-handled 5xx from the real router once, without bodies or credentials', async () => {
    const previousSecret = process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    const previousSecretName = process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
    const captured = captureConsole();
    let response: LambdaResponse | undefined;
    try {
      response = await handler({
        requestContext: { http: { method: 'POST', path: '/api/v1/intake/email-documents' } },
        rawPath: '/api/v1/intake/email-documents',
        ...SECRETS,
      }, CONTEXT) as LambdaResponse;
    } finally {
      captured.restore();
      if (previousSecret !== undefined) process.env.EMAIL_DOCUMENT_INTAKE_SECRET = previousSecret;
      if (previousSecretName !== undefined) process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME = previousSecretName;
    }

    assert.strictEqual(response?.statusCode, 503);
    const records = failureRecords(captured.errors);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].path, '/api/v1/intake/email-documents');
    assert.strictEqual(records[0].requestId, CONTEXT.awsRequestId);
    assert.strictEqual(records[0].status, 503);
    assertNoSecrets([...captured.errors, ...captured.logs].join('\n'));
  });
});
