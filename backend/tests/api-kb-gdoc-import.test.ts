import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import { truncateTestTables } from './helpers/db';
import { setDapierBrokerClientsForTests } from '../src/calendar/dapierBroker';
import { setKbGdocFetchForTests, GDOC_CONNECTION_ENV, gdocSourceUrl } from '../src/knowledgeGdoc';
import type { LambdaResponse } from '../src/types';

function invoke(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
    queryStringParameters: null,
  };
  return handler(event, {});
}

const ADMIN_ID = 'gdoc-admin-0001';
const OPERATOR_ID = 'gdoc-operator-01';
const adminHeaders = { 'x-user-id': ADMIN_ID };
const operatorHeaders = { 'x-user-id': OPERATOR_ID };
const BROKER_TOKEN = 'dapier-machine-token-for-tests';
const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWx';

type Route = { pattern: RegExp; status: number; body: string | ((url: string, init: RequestInit) => string) };

/**
 * Minimal fetch mock standing in for both the Dapier broker (token mint) and
 * the Google Drive export endpoint; records every request for assertions.
 */
function fakeGoogleFetch(routes: Route[]): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init || {} });
    const route = routes.find((candidate) => candidate.pattern.test(url));
    if (!route) return new Response('no route', { status: 500 });
    const payload = typeof route.body === 'function' ? route.body(url, init || {}) : route.body;
    return new Response(payload, {
      status: route.status,
      headers: { 'content-type': url.includes('/api/agent/token') ? 'application/json' : 'text/plain' },
    });
  }) as typeof fetch;
  setKbGdocFetchForTests(impl);
  return { calls, restore: () => setKbGdocFetchForTests(undefined) };
}

const tokenRoute = (): Route => ({
  pattern: /\/api\/agent\/token$/,
  status: 200,
  body: JSON.stringify({ access_token: 'google-access-token', scope: ['https://www.googleapis.com/auth/drive.readonly'] }),
});

describe('API — KB Google Docs import (/api/kb/import-gdoc)', () => {
  let client: DynamoDBDocumentClient;
  let restoreSecret: (() => void) | undefined;
  let savedEnv: string | undefined;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
    savedEnv = process.env[GDOC_CONNECTION_ENV];
    setDapierBrokerClientsForTests({ readSecret: async (name: string) => {
      if (name === 'personal-scheduler.dapier-api-token') return BROKER_TOKEN;
      throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
    } });
    restoreSecret = () => setDapierBrokerClientsForTests({ readSecret: async () => {
      throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
    } });
  });

  afterEach(async () => {
    delete process.env[GDOC_CONNECTION_ENV];
    if (savedEnv !== undefined) process.env[GDOC_CONNECTION_ENV] = savedEnv;
    await truncateTestTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
  });

  after(async () => {
    if (restoreSecret) restoreSecret();
    await stopLocal();
  });

  it('refuses non-admin actors before any external call', async () => {
    const google = fakeGoogleFetch([]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID, connectionId: 'gdrive-x' }, operatorHeaders);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(google.calls, []);
    } finally {
      google.restore();
    }
  });

  it('validates the document id without any external call', async () => {
    const google = fakeGoogleFetch([]);
    try {
      const bad = await invoke('POST', '/api/kb/import-gdoc', { docId: 'not a doc id!' }, adminHeaders);
      assert.equal(bad.statusCode, 400);
      const absent = await invoke('POST', '/api/kb/import-gdoc', {}, adminHeaders);
      assert.equal(absent.statusCode, 400);
      assert.deepEqual(google.calls, []);
    } finally {
      google.restore();
    }
  });

  it('reports a missing connection configuration as a fetch failure', async () => {
    const google = fakeGoogleFetch([]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 502);
      const payload = JSON.parse(res.body);
      assert.equal(payload.code, 'gdoc-fetch-failed');
      assert.match(payload.error, /No Dapier Google connection configured/);
      assert.deepEqual(google.calls, []);
    } finally {
      google.restore();
    }
  });

  it('mints a broker token and returns the plain-text export', async () => {
    process.env[GDOC_CONNECTION_ENV] = 'gdrive-main';
    const docText = 'Hello <NAME>,\n\nBody of the Google doc.\n';
    const google = fakeGoogleFetch([
      tokenRoute(),
      {
        pattern: /drive\.google\.com|googleapis\.com\/drive\/v3\/files\/[^/]+\/export/,
        status: 200,
        body: docText,
      },
    ]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.docId, DOC_ID);
      assert.equal(payload.source, gdocSourceUrl(DOC_ID));
      assert.equal(payload.content, docText);
      assert.equal(payload.sizeBytes, Buffer.byteLength(docText, 'utf8'));
      assert.match(payload.sha256, /^[0-9a-f]{64}$/);
      assert.equal(google.calls.length, 2);
      assert.match(google.calls[0].url, /\/api\/agent\/token$/);
      const tokenInit = google.calls[0].init as { headers: Record<string, string>; body: string };
      assert.equal(tokenInit.headers.Authorization, `Bearer ${BROKER_TOKEN}`);
      assert.deepEqual(JSON.parse(tokenInit.body), { connection_id: 'gdrive-main', agent: 'personal-scheduler' });
      assert.match(google.calls[1].url, new RegExp(`/drive/v3/files/${DOC_ID}/export`));
      assert.equal((google.calls[1].init as { headers: Record<string, string> }).headers.Authorization, 'Bearer google-access-token');
      // The Google access token never appears in the response.
      assert.equal(res.body.includes('google-access-token'), false);
    } finally {
      google.restore();
    }
  });

  it('accepts a docs.google.com URL in place of a bare id', async () => {
    process.env[GDOC_CONNECTION_ENV] = 'gdrive-main';
    const google = fakeGoogleFetch([
      tokenRoute(),
      { pattern: /\/export/, status: 200, body: 'Doc body.' },
    ]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', {
        docId: `https://docs.google.com/document/d/${DOC_ID}/edit`,
      }, adminHeaders);
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).docId, DOC_ID);
    } finally {
      google.restore();
    }
  });

  it('maps broker refusals and export failures to a fetch-failure code', async () => {
    process.env[GDOC_CONNECTION_ENV] = 'gdrive-main';

    const denied = fakeGoogleFetch([{ pattern: /\/api\/agent\/token$/, status: 403, body: '{}' }]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 502);
      assert.match(JSON.parse(res.body).error, /Dapier denied access/);
    } finally {
      denied.restore();
    }

    const narrowScope = fakeGoogleFetch([{
      pattern: /\/api\/agent\/token$/,
      status: 200,
      body: JSON.stringify({ access_token: 't', scope: ['https://www.googleapis.com/auth/calendar'] }),
    }]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 502);
      assert.match(JSON.parse(res.body).error, /Drive read scope/);
    } finally {
      narrowScope.restore();
    }

    const notShared = fakeGoogleFetch([
      tokenRoute(),
      { pattern: /\/export/, status: 404, body: 'not found' },
    ]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 502);
      assert.match(JSON.parse(res.body).error, /no document/);
    } finally {
      notShared.restore();
    }

    const empty = fakeGoogleFetch([
      tokenRoute(),
      { pattern: /\/export/, status: 200, body: '   \n' },
    ]);
    try {
      const res = await invoke('POST', '/api/kb/import-gdoc', { docId: DOC_ID }, adminHeaders);
      assert.equal(res.statusCode, 502);
      assert.match(JSON.parse(res.body).error, /empty/);
    } finally {
      empty.restore();
    }
  });
});
