import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';

import {
  API_TELEMETRY_NAMESPACE,
  apiRequestMethod,
  apiStatusClass,
  classifyApiRouteFamily,
  emitApiRequestMetrics,
} from '../src/apiRequestTelemetry';
import { handler, withApiRequestTelemetry } from '../src/handler';
import { setDeploymentTemplateLoaderForTest } from '../src/deploymentSeeds';
import { parseAuthoredTemplateFiles } from '../src/templates/authoredTemplates';
import { sanitizeJsonResponse } from '../src/responsePrivacy';
import type { ApiErrorClass, ApiRequestMetricInput } from '../src/apiRequestTelemetry';
import type { LambdaEvent, LambdaResponse } from '../src/types';
import { useTestDatabase } from './helpers/db';
import { stopLocal } from '../scripts/local-dynamodb';

const CONTEXT = { awsRequestId: 'lambda-request-id-209' };

type CapturedConsole = { lines: string[]; restore(): void };

function captureConsoleLog(): CapturedConsole {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '));
  };
  return { lines, restore() { console.log = original; } };
}

function jsonRecords(lines: string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value !== null && typeof value === 'object'
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function portalRecords(lines: string[]): Record<string, unknown>[] {
  return jsonRecords(lines).filter((record) => {
    const aws = record._aws as {
      CloudWatchMetrics?: Array<{ Namespace?: unknown }>;
    } | undefined;
    return aws?.CloudWatchMetrics?.[0]?.Namespace === API_TELEMETRY_NAMESPACE;
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

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const OPERATIONAL_API_ALIASES: ReadonlyArray<readonly [
  canonicalPath: string,
  workAliasPath: string,
  family: ReturnType<typeof classifyApiRouteFamily>,
]> = [
  ['/api', '/work/api', 'other'],
  ['/api/artifacts', '/work/api/artifacts', 'artifacts'],
  ['/api/assistant-jobs', '/work/api/assistant-jobs', 'assistant_jobs_social_drafts'],
  ['/api/assistant-social-drafts', '/work/api/assistant-social-drafts', 'assistant_jobs_social_drafts'],
  ['/api/auth', '/work/api/auth', 'health_auth_team'],
  ['/api/bookkeeping', '/work/api/bookkeeping', 'bookkeeping'],
  ['/api/cards', '/work/api/cards', 'cards'],
  ['/api/conversational', '/work/api/conversational', 'conversational_telegram'],
  ['/api/cron', '/work/api/cron', 'recurring'],
  ['/api/files', '/work/api/files', 'files'],
  ['/api/health', '/work/api/health', 'health_auth_team'],
  ['/api/intake', '/work/api/intake', 'intake'],
  ['/api/mailing-exports', '/work/api/mailing-exports', 'mailing_exports'],
  ['/api/me', '/work/api/me', 'health_auth_team'],
  ['/api/newsletter-slots', '/work/api/newsletter-slots', 'calendar_newsletter'],
  ['/api/notifications', '/work/api/notifications', 'notifications'],
  ['/api/recurring', '/work/api/recurring', 'recurring'],
  ['/api/sponsor-crm', '/work/api/sponsor-crm', 'sponsor_crm'],
  ['/api/tasks', '/work/api/tasks', 'tasks'],
  ['/api/team-members', '/work/api/team-members', 'health_auth_team'],
  ['/api/templates', '/work/api/templates', 'templates'],
  ['/api/tokens', '/work/api/tokens', 'users_tokens'],
  ['/api/users', '/work/api/users', 'users_tokens'],
  ['/api/v1/intake/email-documents', '/work/api/v1/intake/email-documents', 'email_documents'],
  ['/api/webhook/email', '/work/api/webhook/email', 'email_documents'],
  ['/api/webhook/telegram', '/work/api/webhook/telegram', 'conversational_telegram'],
  ['/api/calendar-items', '/work/api/calendar-items', 'calendar_newsletter'],
];

type MetricCollector = ApiRequestMetricInput[] & {
  emit(input: ApiRequestMetricInput): void;
};

function collector(): MetricCollector {
  const metrics: ApiRequestMetricInput[] = [];
  return Object.assign(metrics, {
    emit(input: ApiRequestMetricInput) {
      metrics.push(input);
    },
  });
}

function assertEmfRecord(
  record: Record<string, unknown>,
  expected: Pick<ApiRequestMetricInput, 'routeFamily' | 'method' | 'statusCode'> & {
    requestId?: string;
    coldStart?: boolean;
    errorClass?: ApiErrorClass;
  }
): void {
  const aws = record._aws as {
    Timestamp: unknown;
    CloudWatchMetrics: Array<{
      Namespace: unknown;
      Dimensions: unknown;
      Metrics: Array<{ Name: unknown; Unit: unknown }>;
    }>;
  };
  const expectedKeys = [
    '_aws',
    'ColdStart',
    'HandledApiFailures',
    'Method',
    'RequestCount',
    'RequestDurationMs',
    'RequestId',
    'RouteFamily',
    'StatusClass',
  ];
  if (expected.errorClass) expectedKeys.push('ErrorClass');

  assert.deepStrictEqual(Object.keys(record).sort(), expectedKeys.sort());
  assert.strictEqual(aws.CloudWatchMetrics.length, 1);
  assert.strictEqual(aws.CloudWatchMetrics[0].Namespace, API_TELEMETRY_NAMESPACE);
  assert.deepStrictEqual(
    aws.CloudWatchMetrics[0].Dimensions,
    [['RouteFamily', 'Method', 'StatusClass']]
  );
  assert.deepStrictEqual(aws.CloudWatchMetrics[0].Metrics, [
    { Name: 'RequestCount', Unit: 'Count' },
    { Name: 'RequestDurationMs', Unit: 'Milliseconds' },
    { Name: 'HandledApiFailures', Unit: 'Count' },
  ]);
  assert.strictEqual(Number.isSafeInteger(aws.Timestamp), true);
  assert.strictEqual(record.RouteFamily, expected.routeFamily);
  assert.strictEqual(record.Method, expected.method);
  assert.strictEqual(record.StatusClass, apiStatusClass(expected.statusCode));
  assert.strictEqual(record.RequestCount, 1);
  assert.strictEqual(record.HandledApiFailures, expected.statusCode >= 500 ? 1 : 0);
  assert.strictEqual(typeof record.RequestDurationMs, 'number');
  assert.ok(record.RequestDurationMs >= 0);
  assert.strictEqual(typeof record.ColdStart, 'boolean');
  assert.strictEqual(typeof record.RequestId, 'string');
  if (expected.requestId !== undefined) {
    assert.strictEqual(record.RequestId, expected.requestId);
  }
  if (expected.coldStart !== undefined) {
    assert.strictEqual(record.ColdStart, expected.coldStart);
  }
  if (expected.errorClass !== undefined) {
    assert.strictEqual(record.ErrorClass, expected.errorClass);
  } else {
    assert.strictEqual(Object.hasOwn(record, 'ErrorClass'), false);
  }
}

describe('portal API request telemetry', () => {
  before(async () => {
    await useTestDatabase();
  });

  after(async () => {
    await stopLocal();
  });

  it('emits one bounded success record and keeps non-error JSON unchanged', async () => {
    const captured = captureConsoleLog();
    let response: LambdaResponse | undefined;
    try {
      response = await handler(httpEvent({
        queryStringParameters: { secret: 'query-secret-marker-209' },
        headers: {
          cookie: 'session=cookie-secret-marker-209',
          'x-amzn-trace-id': 'client-trace-marker-209',
          'x-request-id': 'untrusted-client-id-209',
        },
      }), CONTEXT);
    } finally {
      captured.restore();
    }

    assert.strictEqual(response?.statusCode, 200);
    assert.strictEqual(response.body, '{"status":"ok"}');
    assert.strictEqual(response.headers!['x-dataops-request-id'], CONTEXT.awsRequestId);
    assert.strictEqual(JSON.parse(response.body).requestId, undefined);

    const records = portalRecords(captured.lines);
    assert.strictEqual(records.length, 1);
    assertEmfRecord(records[0], {
      routeFamily: 'health_auth_team',
      method: 'GET',
      statusCode: 200,
      requestId: CONTEXT.awsRequestId,
      coldStart: true,
    });
    assert.ok(!JSON.stringify(records).includes('query-secret-marker-209'));
    assert.ok(!JSON.stringify(records).includes('cookie-secret-marker-209'));
    assert.ok(!JSON.stringify(records).includes('client-trace-marker-209'));
  });

  it('classifies equivalent API Gateway and Function URL route-caught 500s identically', async () => {
    const previousSecret = process.env.WEBHOOK_EMAIL_SECRET;
    delete process.env.WEBHOOK_EMAIL_SECRET;
    const common = {
      body: '{"payload":"payload-secret-marker-209","documentName":"document-name-secret-209"}',
      headers: {
        authorization: 'Bearer bearer-secret-marker-209',
        cookie: 'session=cookie-secret-marker-209',
        'x-amzn-trace-id': 'client-trace-marker-209',
        'x-request-id': 'another-client-id-209',
      },
      queryStringParameters: { secret: 'query-secret-marker-209' },
    };
    const apiGateway = httpEvent({
      httpMethod: 'POST',
      path: '/api/webhook/email',
      ...common,
    });
    const functionUrl = {
      requestContext: { http: { method: 'POST', path: '/api/webhook/email' } },
      rawPath: '/api/webhook/email',
      ...common,
    };

    try {
      const apiCapture = captureConsoleLog();
      let apiResponse: LambdaResponse | undefined;
      try {
        apiResponse = await handler(apiGateway, CONTEXT);
      } finally {
        apiCapture.restore();
      }

      const urlCapture = captureConsoleLog();
      let urlResponse: LambdaResponse | undefined;
      try {
        urlResponse = await handler(functionUrl, CONTEXT);
      } finally {
        urlCapture.restore();
      }

      const apiRecords = portalRecords(apiCapture.lines);
      const urlRecords = portalRecords(urlCapture.lines);
      assert.strictEqual(apiRecords.length, 1);
      assert.strictEqual(urlRecords.length, 1);
      for (const record of [...apiRecords, ...urlRecords]) {
        assertEmfRecord(record, {
          routeFamily: 'email_documents',
          method: 'POST',
          statusCode: 500,
          requestId: CONTEXT.awsRequestId,
          errorClass: 'route_handled',
        });
        assert.strictEqual(typeof record.ColdStart, 'boolean');
      }
      for (const key of ['RouteFamily', 'Method', 'StatusClass', 'RequestId', 'ErrorClass']) {
        assert.strictEqual(urlRecords[0][key], apiRecords[0][key]);
      }

      for (const response of [apiResponse!, urlResponse!]) {
        assert.strictEqual(response.statusCode, 500);
        assert.strictEqual(response.headers!['x-dataops-request-id'], CONTEXT.awsRequestId);
        assert.deepStrictEqual(JSON.parse(response.body), {
          error: 'Webhook not configured',
          requestId: CONTEXT.awsRequestId,
        });
      }

      const telemetry = JSON.stringify([...apiRecords, ...urlRecords]);
      for (const forbidden of [
        'bearer-secret-marker-209',
        'cookie-secret-marker-209',
        'payload-secret-marker-209',
        'document-name-secret-209',
        'query-secret-marker-209',
        'client-trace-marker-209',
      ]) {
        assert.ok(!telemetry.includes(forbidden));
      }
    } finally {
      if (previousSecret === undefined) delete process.env.WEBHOOK_EMAIL_SECRET;
      else process.env.WEBHOOK_EMAIL_SECRET = previousSecret;
    }
  });

  it('sanitizes and labels an exception that escapes the HTTP boundary', async () => {
    const metrics = collector();
    let reads = 0;
    const clock = () => (reads++ === 0 ? 100 : 137.25);
    const longError = `${'raw-error-text-'.repeat(100)}209`;
    const response = await withApiRequestTelemetry(
      httpEvent({ httpMethod: 'PUT', path: '/api/users/private-user-209' }),
      CONTEXT,
      async () => {
        throw new Error(longError);
      },
      {
        monotonicClock: clock,
        wallClock: () => 123456789,
        emit: metrics.emit,
        coldStart: false,
      }
    );

    assert.strictEqual(response.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: 'Internal server error',
      requestId: CONTEXT.awsRequestId,
    });
    assert.strictEqual(metrics.length, 1);
    assert.strictEqual(metrics[0].errorClass, 'unhandled_exception');
    assert.strictEqual(metrics[0].durationMs, 37.25);
    assert.strictEqual(metrics[0].timestamp, 123456789);
    assert.strictEqual(metrics[0].routeFamily, 'users_tokens');
    assert.ok(!JSON.stringify(metrics).includes(longError));
    assert.ok(!JSON.stringify(metrics).includes('private-user-209'));
  });

  it('maps representative statuses while injecting duration and timestamp clocks', async () => {
    const cases = [
      { statusCode: 201, errorClass: undefined },
      { statusCode: 302, errorClass: undefined },
      { statusCode: 404, errorClass: undefined },
      { statusCode: 500, errorClass: 'route_handled' },
    ] as const;

    for (const expected of cases) {
      const metrics = collector();
      let reads = 0;
      const response = await withApiRequestTelemetry(
        httpEvent({ path: '/api/tasks/task-outcome-209' }),
        CONTEXT,
        async () => jsonResponse(expected.statusCode, { outcome: expected.statusCode }),
        {
          monotonicClock: () => (reads++ === 0 ? 20 : 63.5),
          wallClock: () => 42_000_000,
          emit: metrics.emit,
          coldStart: false,
        }
      );

      assert.strictEqual(response.statusCode, expected.statusCode);
      assert.strictEqual(metrics.length, 1);
      assert.strictEqual(metrics[0].routeFamily, 'tasks');
      assert.strictEqual(metrics[0].statusCode, expected.statusCode);
      assert.strictEqual(metrics[0].durationMs, 43.5);
      assert.strictEqual(metrics[0].timestamp, 42_000_000);
      assert.strictEqual(metrics[0].errorClass, expected.errorClass);
    }
  });

  it('emits one structurally valid record with clamped duration and injected timestamp', () => {
    const captured = captureConsoleLog();
    try {
      emitApiRequestMetrics({
        routeFamily: 'other',
        method: 'OTHER',
        statusCode: 204,
        durationMs: -12,
        requestId: randomUUID(),
        coldStart: false,
        timestamp: 123456789,
      });
    } finally {
      captured.restore();
    }

    const records = portalRecords(captured.lines);
    assert.strictEqual(records.length, 1);
    assertEmfRecord(records[0], {
      routeFamily: 'other',
      method: 'OTHER',
      statusCode: 204,
    });
    assert.strictEqual((records[0]._aws as { Timestamp: number }).Timestamp, 123456789);
    assert.strictEqual(records[0].RequestDurationMs, 0);
  });

  it('maps parameterized normalized paths to the closed family table', () => {
    const cases: Array<[string, ReturnType<typeof classifyApiRouteFamily>]> = [
      ['/api/health', 'health_auth_team'],
      ['/api/auth/device/token', 'health_auth_team'],
      ['/api/me', 'health_auth_team'],
      ['/api/team-members/member-one', 'health_auth_team'],
      ['/api/tasks/task-one/actions/complete', 'tasks'],
      ['/api/cards/card-two', 'cards'],
      ['/api/templates/template-three', 'templates'],
      ['/api/recurring/config-four', 'recurring'],
      ['/api/cron/run', 'recurring'],
      ['/api/cron/export', 'recurring'],
      ['/api/files/file-five', 'files'],
      ['/api/artifacts/artifact-six', 'artifacts'],
      ['/api/assistant-jobs/job-seven', 'assistant_jobs_social_drafts'],
      ['/api/assistant-social-drafts/draft-eight', 'assistant_jobs_social_drafts'],
      ['/api/intake/item-nine', 'intake'],
      ['/api/v1/intake/email-documents', 'email_documents'],
      ['/api/users/user-ten', 'users_tokens'],
      ['/api/tokens/token-eleven', 'users_tokens'],
      ['/api/notifications/notification-twelve', 'notifications'],
      ['/api/calendar-items/event-thirteen', 'calendar_newsletter'],
      ['/api/newsletter-slots/slot-fourteen', 'calendar_newsletter'],
      ['/api/bookkeeping/entry-fifteen', 'bookkeeping'],
      ['/api/sponsor-crm/bookings/booking-sixteen/communications', 'sponsor_crm'],
      ['/api/mailing-exports/export-seventeen', 'mailing_exports'],
      ['/api/conversational/readiness', 'conversational_telegram'],
      ['/api/webhook/telegram', 'conversational_telegram'],
      ['/api/webhook/email', 'email_documents'],
      ['/docs/document-name-secret-209.md', 'docs_content_search'],
      ['/search', 'docs_content_search'],
      ['/content/images/image-eighteen.png', 'docs_content_search'],
      ['/work/api/tasks/task-nineteen', 'tasks'],
      ['/', 'static_frontend'],
      ['/work/operator-dashboard', 'static_frontend'],
      ['/favicon.ico', 'static_frontend'],
      ['/browser-deep-link', 'static_frontend'],
      ['/api', 'other'],
      ['/api/not-a-route/route-twenty', 'other'],
    ];
    for (const [path, family] of cases) {
      assert.strictEqual(classifyApiRouteFamily(path), family);
    }
  });

  it('maps every operational work API alias to its canonical route family', () => {
    assert.strictEqual(OPERATIONAL_API_ALIASES.length, 27);
    for (const [canonicalPath, workAliasPath, family] of OPERATIONAL_API_ALIASES) {
      assert.strictEqual(classifyApiRouteFamily(canonicalPath), family, canonicalPath);
      assert.strictEqual(classifyApiRouteFamily(workAliasPath), family, workAliasPath);
    }

    assert.strictEqual(classifyApiRouteFamily('/work/health'), 'health_auth_team');
  });

  it('correlates representative work aliases through both HTTP shapes and docs modes', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of [
      'DATAOPS_DOCS_DOMAIN',
      'WORK_ENGINE_AUTH_MODE',
      'AUTH_BASE_URL',
      'AUTH_ISSUER',
      'AUTH_JWKS_URL',
      'AUTH_CLIENT_ID',
      'AUTH_CALLBACK_URL',
      'AUTH_LOGOUT_URL',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    const invokeWorkAlias = async (
      path: string,
      shape: 'api-gateway' | 'function-url'
    ): Promise<{ response: LambdaResponse; records: Record<string, unknown>[] }> => {
      const captured = captureConsoleLog();
      try {
        const event = shape === 'api-gateway'
          ? httpEvent({ path })
          : {
              requestContext: { http: { method: 'GET', path } },
              rawPath: path,
              headers: {},
              body: null,
              isBase64Encoded: false,
              queryStringParameters: null,
            };
        const response = await handler(event, CONTEXT) as LambdaResponse;
        return { response, records: portalRecords(captured.lines) };
      } finally {
        captured.restore();
      }
    };

    try {
      const cases = [
        { path: '/work/api/health', family: 'health_auth_team', statusCode: 200 },
        { path: '/work/api/tasks/task-telemetry-missing-209', family: 'tasks', statusCode: 404 },
      ] as const;

      for (const docsEnabled of [false, true]) {
        process.env.DATAOPS_DOCS_DOMAIN = docsEnabled ? '1' : '0';
        for (const expected of cases) {
          const apiGateway = await invokeWorkAlias(expected.path, 'api-gateway');
          const functionUrl = await invokeWorkAlias(expected.path, 'function-url');

          for (const invocation of [apiGateway, functionUrl]) {
            assert.strictEqual(invocation.response.statusCode, expected.statusCode);
            assert.strictEqual(
              invocation.response.headers!['x-dataops-request-id'],
              CONTEXT.awsRequestId
            );
            if (expected.statusCode < 500) {
              assert.strictEqual(JSON.parse(invocation.response.body).requestId, undefined);
            }
            assert.strictEqual(invocation.records.length, 1);
            assertEmfRecord(invocation.records[0], {
              routeFamily: expected.family,
              method: 'GET',
              statusCode: expected.statusCode,
              requestId: CONTEXT.awsRequestId,
            });
          }

          for (const key of ['RouteFamily', 'Method', 'StatusClass', 'RequestId']) {
            assert.strictEqual(functionUrl.records[0][key], apiGateway.records[0][key]);
          }
        }
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('bounds methods and status classes to their allowlists', () => {
    assert.strictEqual(apiRequestMethod('get'), 'GET');
    assert.strictEqual(apiRequestMethod(' post '), 'POST');
    assert.strictEqual(apiRequestMethod(undefined), 'GET');
    assert.strictEqual(apiRequestMethod('TRACE'), 'OTHER');
    assert.deepStrictEqual(
      [199, 201, 299, 302, 399, 404, 499, 500, 599, 601].map(apiStatusClass),
      ['2xx', '2xx', '2xx', '3xx', '3xx', '4xx', '4xx', '5xx', '5xx', '2xx']
    );
  });

  it('keeps payloads, identities, and storage locations out of telemetry', async () => {
    const metrics = collector();
    const event = httpEvent({
      path: '/api/tasks/task-id-private-209',
      headers: {
        authorization: 'Bearer bearer-secret-marker-209',
        cookie: 'session=cookie-secret-marker-209',
      },
      body: '{"payload":"payload-secret-marker-209"}',
      queryStringParameters: { secret: 'query-secret-marker-209' },
    });
    const response = await withApiRequestTelemetry(
      event,
      CONTEXT,
      async () => sanitizeJsonResponse(jsonResponse(200, {
        storageUri: 's3://private-bucket/private-object-marker-209',
      })),
      { emit: metrics.emit, coldStart: false }
    );

    assert.ok(!response.body.includes('private-object-marker-209'));
    assert.strictEqual(metrics.length, 1);
    assert.strictEqual(metrics[0].routeFamily, 'tasks');
    const telemetry = JSON.stringify(metrics);
    for (const forbidden of [
      'task-id-private-209',
      'bearer-secret-marker-209',
      'cookie-secret-marker-209',
      'payload-secret-marker-209',
      'query-secret-marker-209',
      'private-bucket',
      'private-object-marker-209',
    ]) {
      assert.ok(!telemetry.includes(forbidden));
    }
  });

  it('contains injected telemetry faults and preserves the response contract', async () => {
    const sanitizedResponse = sanitizeJsonResponse(jsonResponse(200, {
      storageUri: 's3://private-bucket/private-object-marker-209',
    }));
    const healthyCollector = collector();
    const healthy = await withApiRequestTelemetry(
      httpEvent(),
      CONTEXT,
      async () => sanitizedResponse,
      { emit: healthyCollector.emit, coldStart: false }
    );
    const faultyCalls: ApiRequestMetricInput[] = [];
    const faulty = await withApiRequestTelemetry(
      httpEvent(),
      CONTEXT,
      async () => sanitizedResponse,
      {
        coldStart: false,
        emit(input) {
          faultyCalls.push(input);
          throw new Error('injected telemetry failure');
        },
      }
    );
    assert.deepStrictEqual(faulty, healthy);
    assert.ok(!healthy.body.includes('private-object-marker-209'));

    const failingOperation = async (): Promise<LambdaResponse> => {
      throw new Error('long raw-error-text-209'.repeat(20));
    };
    const failingHealthy = await withApiRequestTelemetry(
      httpEvent(), CONTEXT, failingOperation,
      { emit: collector().emit, coldStart: false }
    );
    const failingFaulty = await withApiRequestTelemetry(
      httpEvent(), CONTEXT, failingOperation,
      {
        coldStart: false,
        emit() { throw new Error('injected telemetry failure'); },
      }
    );
    assert.deepStrictEqual(failingFaulty, failingHealthy);
  });

  it('contains a failing correlation write without replacing the business response', async () => {
    const metrics = collector();
    const healthy = sanitizeJsonResponse(jsonResponse(200, {
      storageUri: 's3://private-bucket/private-correlation-marker-209',
    }));
    let correlationHeaderReads = 0;
    const faulty = await withApiRequestTelemetry(
      httpEvent(),
      CONTEXT,
      async () => ({
        ...healthy,
        get headers() {
          correlationHeaderReads += 1;
          if (correlationHeaderReads === 1) {
            throw new Error('injected correlation failure');
          }
          return healthy.headers;
        },
      }),
      { emit: metrics.emit, coldStart: false }
    );

    assert.strictEqual(correlationHeaderReads, 1);
    assert.strictEqual(faulty.statusCode, 200);
    assert.strictEqual(faulty.body, healthy.body);
    assert.strictEqual(faulty.headers, healthy.headers);
    assert.ok(!healthy.body.includes('private-correlation-marker-209'));
    assert.strictEqual(metrics.length, 1);
    assert.strictEqual(metrics[0].statusCode, 200);
  });

  it('contains a failing injected monotonic clock', async () => {
    const metrics = collector();
    const response = await withApiRequestTelemetry(
      httpEvent({ path: '/api/cards/card-clock-209' }),
      CONTEXT,
      async () => jsonResponse(201, { status: 'created' }),
      {
        emit: metrics.emit,
        coldStart: false,
        monotonicClock() {
          throw new Error('injected clock failure');
        },
      }
    );

    assert.strictEqual(response.statusCode, 201);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'created' });
    assert.strictEqual(metrics.length, 1);
    assert.strictEqual(metrics[0].durationMs, 0);
  });

  it('emits from the real clock when an injected wall clock fails', async () => {
    const captured = captureConsoleLog();
    try {
      await withApiRequestTelemetry(
        httpEvent({ path: '/api/templates/template-clock-209' }),
        CONTEXT,
        async () => jsonResponse(200, { status: 'ok' }),
        {
          coldStart: false,
          monotonicClock: () => 10,
          wallClock() {
            throw new Error('injected wall-clock failure');
          },
        }
      );
    } finally {
      captured.restore();
    }

    const records = portalRecords(captured.lines);
    assert.strictEqual(records.length, 1);
    assertEmfRecord(records[0], {
      routeFamily: 'templates',
      method: 'GET',
      statusCode: 200,
      requestId: CONTEXT.awsRequestId,
    });
    assert.ok((records[0]._aws as { Timestamp: number }).Timestamp > 1_000_000_000_000);
  });

  it('correlates every response but adds a body ID only to JSON 5xx contracts', async () => {
    const metrics = collector();
    const invoke = (
      response: LambdaResponse,
      event: Partial<LambdaEvent> = {}
    ) => withApiRequestTelemetry(httpEvent(event), CONTEXT, async () => response, {
      emit: metrics.emit,
      coldStart: false,
    });

    const accepted = await invoke(jsonResponse(202, { status: 'accepted' }));
    assert.ok(accepted.headers!['x-dataops-request-id']);
    assert.strictEqual(JSON.parse(accepted.body).requestId, undefined);

    const replacedLegacyCasing = await invoke({
      statusCode: 200,
      headers: { 'X-DataOps-Request-ID': 'untrusted-response-id' },
      body: '',
    });
    assert.deepStrictEqual(
      Object.keys(replacedLegacyCasing.headers || {}),
      ['x-dataops-request-id']
    );
    assert.strictEqual(
      replacedLegacyCasing.headers!['x-dataops-request-id'],
      CONTEXT.awsRequestId
    );

    const nonJson = await invoke({
      statusCode: 503,
      headers: { 'Content-Type': 'text/plain' },
      body: '{"private":"private-error-page-209"}',
    }, { path: '/api/webhook/telegram', httpMethod: 'POST' });
    assert.strictEqual(nonJson.headers!['x-dataops-request-id'], CONTEXT.awsRequestId);
    assert.strictEqual(nonJson.body, '{"private":"private-error-page-209"}');

    const undeclaredJson = await invoke({
      statusCode: 503,
      headers: {},
      body: '{"error":"legacy-json-contract"}',
    }, { path: '/api/webhook/telegram', httpMethod: 'POST' });
    assert.strictEqual(undeclaredJson.headers!['x-dataops-request-id'], CONTEXT.awsRequestId);
    assert.strictEqual(JSON.parse(undeclaredJson.body).requestId, CONTEXT.awsRequestId);
    assert.strictEqual(metrics.filter((metric) => metric.statusCode >= 500).length, 2);
  });

  it('falls back to a UUID when Lambda context is absent or unsafe', async () => {
    for (const context of [undefined, null, {}, { awsRequestId: 42 }]) {
      const metrics = collector();
      const response = await withApiRequestTelemetry(
        httpEvent(),
        context,
        async () => jsonResponse(204, ''),
        { emit: metrics.emit, coldStart: false }
      );
      const requestId = response.headers!['x-dataops-request-id'];
      assert.doesNotMatch(requestId, /[^0-9a-f-]/i);
      assert.strictEqual(requestId.split('-').length, 5);
      assert.strictEqual(metrics[0].requestId, requestId);
    }
  });

  it('does not emit portal API metrics for non-API invocation kinds', async () => {
    setDeploymentTemplateLoaderForTest(async () => parseAuthoredTemplateFiles([{
      path: 'workflow-templates/telemetry-isolation.yaml',
      revision: 'revision-209',
      content: [
        'type: telemetry-isolation',
        'name: Telemetry isolation',
        'trigger:',
        '  mode: manual',
        'tasks:',
        '  - id: first',
        '    name: Isolation task',
        '    schedule:',
        '      offset_days: 0',
        '',
      ].join('\n'),
    }]));
    const captures: CapturedConsole[] = [];
    const invokeNonApi = async (event: unknown): Promise<unknown> => {
      const captured = captureConsoleLog();
      captures.push(captured);
      try {
        return await handler(event as Record<string, unknown>);
      } finally {
        captured.restore();
      }
    };

    try {
      const seed = await invokeNonApi({
        source: 'dataops.deploy',
        'detail-type': 'Runtime Seed',
        detail: { dataopsAction: 'sync-runtime-seeds' },
      });
      const deployment = await invokeNonApi({
        source: 'dataops.deploy',
        'detail-type': 'Unknown Control',
      });
      const scheduled = await invokeNonApi({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: {},
      });
      const workerOnly = await invokeNonApi({ Records: [] });
      const rawPathOnly = await invokeNonApi({ rawPath: '/api/health' });

      assert.ok(typeof seed === 'object' && seed !== null && 'statusCode' in seed);
      assert.strictEqual((seed as LambdaResponse).statusCode, 200);
      assert.strictEqual((deployment as LambdaResponse).statusCode, 400);
      assert.strictEqual((deployment as LambdaResponse).headers?.['x-dataops-request-id'], undefined);
      assert.ok(typeof scheduled === 'object' && scheduled !== null && 'created' in scheduled);
      assert.ok(workerOnly !== undefined);
      assert.ok(rawPathOnly !== undefined);
      assert.ok(captures.every((captured) => portalRecords(captured.lines).length === 0));
    } finally {
      setDeploymentTemplateLoaderForTest(null);
    }
  });

  it('correlates an HTTP request rejected by invalid rollout configuration', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of [
      'CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED',
      'CONVERSATIONAL_EXECUTION_ENABLED',
      'CONVERSATIONAL_ENABLED_PLUGINS',
      'CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED',
      'CONVERSATIONAL_TELEGRAM_VOICE_ENABLED',
      'CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED',
    ]) {
      saved[key] = process.env[key];
    }

    const captured = captureConsoleLog();
    let response: LambdaResponse | undefined;
    try {
      process.env.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED = 'invalid';
      response = await handler(httpEvent({ path: '/work/api/health' }), CONTEXT) as LambdaResponse;
    } finally {
      captured.restore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.strictEqual(response?.statusCode, 503);
    assert.strictEqual(response.headers!['x-dataops-request-id'], CONTEXT.awsRequestId);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: 'Conversational rollout configuration is invalid',
      requestId: CONTEXT.awsRequestId,
    });
    const records = portalRecords(captured.lines);
    assert.strictEqual(records.length, 1);
    assertEmfRecord(records[0], {
      routeFamily: 'health_auth_team',
      method: 'GET',
      statusCode: 503,
      requestId: CONTEXT.awsRequestId,
      errorClass: 'route_handled',
    });
  });
});
