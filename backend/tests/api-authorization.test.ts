/**
 * Authorization contract for the `/api/*` surface, with authentication ENABLED.
 *
 * The rest of the unit suite runs with `SKIP_AUTH=true` (see the `test` script
 * in `package.json`), so almost nothing proves that a route rejects an
 * unauthenticated or under-privileged caller. This file sets
 * `SKIP_AUTH=false` for its own process and drives the real bearer-session
 * middleware in `src/router.ts`.
 *
 * It is deliberately table-driven over the route surface rather than
 * per-feature: the risk the tables guard is a mistake in the exemption list
 * (`AUTH_EXEMPT_PATHS` / `isAuthExempt`) or a new route registered above the
 * middleware, both of which are invisible to a per-feature test. Adding a
 * route to either table is a one-line, reviewable act.
 *
 * It uses real users and sessions with assertions on response codes.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import type { LambdaResponse } from '../src/types';

const ADMIN_ID = 'authz-admin';
const OPERATOR_ID = 'authz-operator';

interface RouteCase {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Every `/api/*` prefix reachable through `route()` in `src/router.ts`, with a
 * representative method per prefix. None of these is exempt, so all of them
 * must be refused before any handler work happens.
 */
const AUTHENTICATED_ROUTES: RouteCase[] = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/tasks?date=2026-08-13' },
  { method: 'POST', path: '/api/tasks', body: { description: 'x', date: '2026-08-13' } },
  { method: 'GET', path: '/api/tasks/some-task' },
  { method: 'PUT', path: '/api/tasks/some-task', body: { description: 'x' } },
  { method: 'DELETE', path: '/api/tasks/some-task' },
  { method: 'POST', path: '/api/tasks/some-task/actions/complete', body: {} },
  { method: 'GET', path: '/api/cards' },
  { method: 'POST', path: '/api/cards', body: { name: 'x' } },
  { method: 'GET', path: '/api/templates' },
  { method: 'POST', path: '/api/templates', body: { name: 'x', type: 'workflow' } },
  { method: 'GET', path: '/api/recurring' },
  { method: 'POST', path: '/api/recurring', body: { description: 'x', cronExpression: '0 9 * * 1' } },
  { method: 'GET', path: '/api/users' },
  { method: 'POST', path: '/api/users', body: { name: 'x', email: 'x@example.test' } },
  { method: 'GET', path: '/api/tokens' },
  { method: 'POST', path: '/api/tokens', body: { name: 'x' } },
  { method: 'GET', path: '/api/notifications' },
  { method: 'GET', path: '/api/files?taskId=some-task' },
  { method: 'POST', path: '/api/files', body: {} },
  { method: 'GET', path: '/api/artifacts' },
  { method: 'POST', path: '/api/artifacts', body: {} },
  { method: 'GET', path: '/api/assistant-jobs' },
  { method: 'POST', path: '/api/assistant-jobs', body: {} },
  { method: 'GET', path: '/api/assistant-social-drafts' },
  { method: 'POST', path: '/api/assistant-social-drafts', body: {} },
  { method: 'GET', path: '/api/intake' },
  { method: 'POST', path: '/api/intake', body: {} },
  { method: 'GET', path: '/api/bookkeeping' },
  { method: 'GET', path: '/api/sponsor-crm/sponsors' },
  { method: 'POST', path: '/api/sponsor-crm/sponsors', body: {} },
  { method: 'GET', path: '/api/newsletter-slots' },
  { method: 'POST', path: '/api/newsletter-slots', body: {} },
  { method: 'GET', path: '/api/calendar-items' },
  { method: 'POST', path: '/api/calendar-items', body: {} },
  { method: 'GET', path: '/api/mailing-exports' },
  { method: 'POST', path: '/api/mailing-exports', body: {} },
  { method: 'GET', path: '/api/conversational/execution-attempts/some-attempt' },
  { method: 'GET', path: '/api/conversational/identity-bindings?channel=telegram' },
  { method: 'POST', path: '/api/conversational/identity-bindings', body: {} },
  { method: 'GET', path: '/api/conversational/readiness' },
  { method: 'POST', path: '/api/cron/run', body: {} },
  { method: 'POST', path: '/api/cron/export', body: {} },
  { method: 'POST', path: '/api/webhook/email', body: {} },
  // A path with no handler must still be refused before the router can reveal
  // whether it exists.
  { method: 'GET', path: '/api/definitely-not-a-route' },
];

/**
 * The complete documented exemption list: `AUTH_EXEMPT_PATHS` plus the two
 * machine-authenticated `isAuthExempt` carve-outs. These carry their own
 * credential (shared secret, rotated webhook secret, or a bounded grant), so
 * the assertion is that they are NOT refused by the session middleware — which
 * is what makes an accidental addition to that list visible here.
 */
const EXEMPT_ROUTES: RouteCase[] = [
  { method: 'GET', path: '/api/health' },
  { method: 'POST', path: '/api/auth/login', body: { email: 'nobody@example.test', password: 'wrong' } },
  { method: 'POST', path: '/api/auth/device', body: {} },
  { method: 'POST', path: '/api/auth/device/token', body: {} },
  { method: 'POST', path: '/api/v1/intake/email-documents', body: {} },
  { method: 'POST', path: '/api/webhook/telegram', body: {} },
];

/** Mutations an operator must not be able to perform. */
const ADMIN_ONLY_MUTATIONS: RouteCase[] = [
  { method: 'POST', path: '/api/users', body: { name: 'New', email: 'new@example.test' } },
  { method: 'PATCH', path: `/api/users/${OPERATOR_ID}`, body: { role: 'admin' } },
  { method: 'PUT', path: `/api/users/${OPERATOR_ID}`, body: { role: 'admin' } },
  { method: 'POST', path: '/api/recurring', body: { description: 'x', cronExpression: '0 9 * * 1' } },
  { method: 'PUT', path: '/api/recurring/some-config', body: { description: 'x' } },
  { method: 'DELETE', path: '/api/recurring/some-config' },
  { method: 'POST', path: '/api/conversational/identity-bindings', body: { userId: ADMIN_ID, channel: 'telegram', channelUserId: '1' } },
  { method: 'GET', path: '/api/conversational/readiness' },
];

/** The exact shape the session middleware in `src/router.ts` refuses with. */
function isSessionMiddlewareRefusal(response: LambdaResponse): boolean {
  if (response.statusCode !== 401) return false;
  try {
    return JSON.parse(response.body)?.error === 'Unauthorized';
  } catch {
    return false;
  }
}

describe('/api/* authorization with authentication enabled', () => {
  let client: DynamoDBDocumentClient;
  let operatorToken: string;
  const priorSkipAuth = process.env.SKIP_AUTH;

  before(async () => {
    process.env.SKIP_AUTH = 'false';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Authz admin', email: 'authz-admin@example.test', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Authz operator', email: 'authz-operator@example.test', role: 'operator' });
    operatorToken = (await createSession(client, OPERATOR_ID)).token;
  });

  after(async () => {
    if (priorSkipAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = priorSkipAuth;
    await stopLocal();
  });

  function invoke(route: RouteCase, headers: Record<string, string> = {}): Promise<LambdaResponse> {
    const [path, queryString] = route.path.split('?');
    const queryStringParameters = queryString
      ? Object.fromEntries(new URLSearchParams(queryString).entries())
      : null;
    return handler({
      httpMethod: route.method,
      path,
      queryStringParameters,
      headers,
      body: route.body === undefined ? null : JSON.stringify(route.body),
    }, {});
  }

  for (const route of AUTHENTICATED_ROUTES) {
    it(`refuses an unauthenticated ${route.method} ${route.path} with 401`, async () => {
      const response = await invoke(route);
      assert.strictEqual(response.statusCode, 401, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
      // The refusal must not leak resource state, validation detail, or
      // whether the route exists.
      assert.deepStrictEqual(Object.keys(JSON.parse(response.body)), ['error']);
    });
  }

  for (const route of AUTHENTICATED_ROUTES) {
    it(`refuses a bogus bearer token on ${route.method} ${route.path} with 401`, async () => {
      const response = await invoke(route, { Authorization: 'Bearer not-a-real-session-token' });
      assert.strictEqual(response.statusCode, 401, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
    });
  }

  it('does not let a client forge an identity with x-user-id alone', async () => {
    for (const route of AUTHENTICATED_ROUTES) {
      const response = await invoke(route, { 'x-user-id': ADMIN_ID, 'x-user-role': 'admin' });
      assert.strictEqual(response.statusCode, 401, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
    }
  });

  it('does not let a client forge portal trust with x-portal-auth alone', async () => {
    for (const route of AUTHENTICATED_ROUTES) {
      const response = await invoke(route, {
        'x-portal-auth': 'true',
        'x-portal-secret': 'guessed',
        'x-user-id': ADMIN_ID,
      });
      assert.strictEqual(response.statusCode, 401, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
    }
  });

  for (const route of EXEMPT_ROUTES) {
    it(`keeps ${route.method} ${route.path} on the documented exemption list`, async () => {
      const response = await invoke(route);
      // These routes reach their own handler, which may still refuse the call
      // on its own credential (`POST /api/auth/login` answers "Invalid email or
      // password"). What must not happen is the generic session-middleware
      // refusal, which is exactly 401 `{ error: 'Unauthorized' }`.
      assert.ok(
        !isSessionMiddlewareRefusal(response),
        `${route.method} ${route.path} is expected to carry its own credential, not a session, got ${response.statusCode} ${response.body}`,
      );
    });
  }

  for (const route of ADMIN_ONLY_MUTATIONS) {
    it(`refuses an operator on ${route.method} ${route.path} with 403`, async () => {
      const response = await invoke(route, { Authorization: `Bearer ${operatorToken}` });
      assert.strictEqual(response.statusCode, 403, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
      assert.deepStrictEqual(Object.keys(JSON.parse(response.body)), ['error']);
    });
  }

  for (const route of [
    { method: 'POST', path: '/api/templates', body: { name: 'Must not persist' } },
    { method: 'PUT', path: '/api/templates/some-template', body: { name: 'Must not persist' } },
    { method: 'DELETE', path: '/api/templates/some-template' },
  ]) {
    it(`keeps retired ${route.method} ${route.path} unavailable to an authenticated operator`, async () => {
      const response = await invoke(route, { Authorization: `Bearer ${operatorToken}` });
      assert.strictEqual(response.statusCode, 405);
      assert.strictEqual(JSON.parse(response.body).authority, 'git-authored-workflow-templates');
    });
  }

  it('refuses an operator who also sends admin role and portal headers', async () => {
    for (const route of ADMIN_ONLY_MUTATIONS) {
      const response = await invoke(route, {
        Authorization: `Bearer ${operatorToken}`,
        'x-user-id': ADMIN_ID,
        'x-user-role': 'admin',
        'x-portal-auth': 'true',
      });
      assert.strictEqual(response.statusCode, 403, `${route.method} ${route.path} -> ${response.statusCode} ${response.body}`);
    }
  });
});
