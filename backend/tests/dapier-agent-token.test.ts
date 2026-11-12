import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { getDapierAccessToken, setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
import { readRuntimeSecret } from '../src/secrets/reader';

const savedEnv = { token: process.env.DAPIER_API_TOKEN, base: process.env.DAPIER_BASE_URL };
afterEach(() => {
  setDapierBrokerClientsForTests({ readSecret: readRuntimeSecret });
  for (const [key, value] of [['DAPIER_API_TOKEN', savedEnv.token], ['DAPIER_BASE_URL', savedEnv.base]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

test('exchanges the machine credential for an access token on the given connection', async () => {
  process.env.DAPIER_BASE_URL = 'https://broker.test/';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ access_token: 'at', provider_account_id: 'Orin@DataTalks.Club' });
  }) as unknown as typeof fetch;
  const result = await getDapierAccessToken('conn-1', { fetchImpl, credential: 'machine' });
  assert.deepEqual(result, { ok: true, accessToken: 'at', providerAccountId: 'Orin@DataTalks.Club' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://broker.test/api/agent/token');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer machine');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { connection_id: 'conn-1', agent: 'personal-scheduler' });
});

test('falls back to DAPIER_API_TOKEN, then the team store', async () => {
  let seen = '';
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = (init?.headers as Record<string, string>).Authorization;
    return Response.json({ access_token: 'at' });
  }) as unknown as typeof fetch;
  process.env.DAPIER_API_TOKEN = 'from-env';
  assert.equal((await getDapierAccessToken('c', { fetchImpl })).ok, true);
  assert.equal(seen, 'Bearer from-env');
  delete process.env.DAPIER_API_TOKEN;
  setDapierBrokerClientsForTests({ readSecret: async () => JSON.stringify({ api_token: 'from-store' }) });
  assert.equal((await getDapierAccessToken('c', { fetchImpl })).ok, true);
  assert.equal(seen, 'Bearer from-store');
});

test('reports a missing credential without calling the broker', async () => {
  delete process.env.DAPIER_API_TOKEN;
  setDapierBrokerClientsForTests({ readSecret: async () => '' });
  let called = false;
  const fetchImpl = (async () => { called = true; return Response.json({}); }) as unknown as typeof fetch;
  const result = await getDapierAccessToken('c', { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'missing_dapier_credential');
  assert.match(!result.ok ? result.message : '', /is empty/);
  assert.equal(called, false);
});

test('keeps stable failure reasons for HTTP, unreachable, unreadable and empty responses', async () => {
  const notFound = await getDapierAccessToken('gone', { fetchImpl: respond(404, '{}'), credential: 'c' });
  assert.deepEqual(notFound.ok ? null : { reason: notFound.reason, status: 'status' in notFound ? notFound.status : undefined }, { reason: 'dapier_token_http_404', status: 404 });
  assert.match(!notFound.ok ? notFound.message : '', /"gone" no longer exists/);

  const unreachable = await getDapierAccessToken('c', { fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, credential: 'c' });
  assert.equal(!unreachable.ok && unreachable.reason, 'dapier_unreachable');

  const unreadable = await getDapierAccessToken('c', { fetchImpl: respond(200, 'not json'), credential: 'c' });
  assert.equal(!unreadable.ok && unreadable.reason, 'invalid_token_response');

  const empty = await getDapierAccessToken('c', { fetchImpl: respond(200, '{}'), credential: 'c' });
  assert.equal(!empty.ok && empty.reason, 'empty_access_token');
});
