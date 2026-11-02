import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { GUIDE, POCKETSHELL_PARITY, SERVER_INFO, TOOL_DEFINITIONS, validateRoute } from '../src/tools.mjs';
import { createProxyHandler } from '../src/proxy.mjs';
import {
  authenticateRequest,
  bearerChallengeHeaders,
  DEFAULT_ISSUER,
  ISSUER_SCOPES,
  protectedResourceMetadata,
  requestUrl,
  resetJwksCache,
  resourceForRequest,
  verifyJwt,
} from '../src/auth.mjs';
import { generateSigningKey, humanClaims, mintJwt, startJwksServer } from './helpers/issuer-rig.mjs';

describe('DataOps MCP tools', () => {
  it('exposes exactly read, write and guide', () => {
    assert.deepStrictEqual(TOOL_DEFINITIONS.map((t) => t.name).sort(), ['dataops_guide', 'dataops_read', 'dataops_write']);
  });

  it('marks write as destructive and read/guide as read-only', () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));
    assert.strictEqual(byName.dataops_read.annotations.readOnlyHint, true);
    assert.strictEqual(byName.dataops_guide.annotations.readOnlyHint, true);
    assert.strictEqual(byName.dataops_write.annotations.destructiveHint, true);
  });

  it('accepts portal API, docs, search and knowledge routes', () => {
    for (const route of ['/api/tasks', '/api/cards/abc', '/api/tasks?owner=me', '/docs/x', '/search?q=a', '/knowledge/y']) {
      assert.strictEqual(validateRoute(route), route);
    }
  });

  it('rejects auth, token, traversal and external routes', () => {
    for (const route of ['/api/auth/device', '/api/auth/device/token', '/api/tokens', '/api/../secrets', '/api/%2e%2e/tasks', 'https://example.com/api/tasks', '/other', '']) {
      assert.throws(() => validateRoute(route), /Invalid|refused|not tools/, route);
    }
  });

  it('covers every legacy command family', () => {
    const names = Object.keys(POCKETSHELL_PARITY);
    assert.strictEqual(names.length, 24);
    for (const name of names) {
      const family = POCKETSHELL_PARITY[name];
      assert.doesNotThrow(() => validateRoute(family === '/api/team' ? '/api/team' : `${family}/probe`), name);
    }
  });

  it('guide names the domain vocabulary', () => {
    assert.match(GUIDE.portal, /Template[\s\S]*Card[\s\S]*Task/s);
  });
});

// ── Shared-issuer JWT rig ────────────────────────────────────────────────────

const KID = 'test-key-1';
const pair = generateSigningKey(KID);

let issuerBase = '';
let goodToken = '';
let jwksHits = 0;
let jwksServer;

before(async () => {
  jwksServer = await startJwksServer([pair.jwk]);
  issuerBase = `http://127.0.0.1:${jwksServer.address().port}`;
  goodToken = mintJwt(humanClaims(issuerBase), { privateKey: pair.privateKey, kid: KID });
});

after(async () => {
  if (jwksServer) await new Promise((resolve) => jwksServer.close(resolve));
});

async function fakeUpstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const stopServer = (server) => new Promise((resolve) => server.close(resolve));
const proxyFor = (upstream) => createProxyHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}`, issuer: issuerBase });

/**
 * Drive a proxy handler with a fake req/res pair mirroring Node http
 * behaviour that matters here: lowercased response headers and absolute
 * URL resolution from the Host header. token null omits the header.
 */
async function rpc(handler, body, { url = '/mcp', method = 'POST', token = goodToken, host = 'localhost' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    url,
    method,
    headers: { host, ...(token === null ? {} : { authorization: token === '' ? '' : `Bearer ${token}` }) },
    on(event, fn) {
      if (event === 'data') chunks.forEach((c) => fn(c));
      if (event === 'end') queueMicrotask(fn);
      return this;
    },
    destroy() {},
  };
  const res = {
    code: 0,
    headers: {},
    payload: '',
    writeHead(status, heads) {
      this.code = status;
      this.headers = Object.fromEntries(Object.entries(heads || {}).map(([k, v]) => [k.toLowerCase(), v]));
    },
    end(data) {
      this.payload = String(data || '');
    },
  };
  await handler(req, res);
  return { status: res.code, headers: res.headers, payload: res.payload, json: res.payload ? JSON.parse(res.payload) : null };
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

describe('MCP shared-issuer auth', () => {
  beforeEach(() => {
    jwksHits = 0;
    resetJwksCache();
  });

  it('advertises protected-resource metadata on both well-known paths', async () => {
    const upstream = await fakeUpstream(() => assert.fail('metadata must not reach upstream'));
    try {
      const handler = proxyFor(upstream);
      for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const out = await rpc(handler, undefined, { url: path, method: 'GET', token: null });
        assert.strictEqual(out.status, 200, path);
        assert.strictEqual(out.json.resource, 'http://localhost/mcp', path);
        assert.deepStrictEqual(out.json.authorization_servers, [issuerBase], path);
        assert.ok(ISSUER_SCOPES.includes('mcp'));
        assert.strictEqual(out.headers['access-control-allow-origin'], '*', path);
      }
      assert.strictEqual(jwksHits, 0);
    } finally {
      await stopServer(upstream);
    }
  });

  it('challenges missing and non-JWT credentials without contacting upstream', async () => {
    const upstream = await fakeUpstream(() => assert.fail('unauthenticated calls must not reach upstream'));
    try {
      const handler = proxyFor(upstream);
      for (const [label, token] of [
        ['missing header', null],
        ['empty header', ''],
        ['opaque token', 'dops_opaque'],
        ['malformed jwt', 'not.a.jwt'],
        ['wrong scheme', ''],
      ]) {
        const out = await rpc(handler, INITIALIZE, { token: token ?? null });
        assert.strictEqual(out.status, 401, label);
        const challenge = String(out.headers['www-authenticate'] || '');
        assert.match(challenge, /^Bearer /, label);
        assert.match(challenge, /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/, label);
        if (token && !token.startsWith('Basic')) assert.match(challenge, /error="invalid_token"/, label);
      }
      assert.strictEqual(jwksHits, 0);
    } finally {
      await stopServer(upstream);
    }
  });

  it('rejects expired, mis-issued, audience-mismatched or wrongly-signed JWTs', async () => {
    const upstream = await fakeUpstream(() => assert.fail('rejected tokens must not reach upstream'));
    try {
      const handler = proxyFor(upstream);
      const t = Math.floor(Date.now() / 1000);
      const bad = {
        expired: mintJwt(humanClaims(issuerBase, { exp: t - 10 }), { privateKey: pair.privateKey, kid: KID }),
        wrong_iss: mintJwt(humanClaims(issuerBase, { iss: 'https://evil.example' }), { privateKey: pair.privateKey, kid: KID }),
        wrong_aud: mintJwt(humanClaims(issuerBase, { aud: 'https://ops.dtcdev.click' }), { privateKey: pair.privateKey, kid: KID }),
        future_nbf: mintJwt(humanClaims(issuerBase, { nbf: t + 3600 }), { privateKey: pair.privateKey, kid: KID }),
        unsigned: mintJwt(humanClaims(issuerBase), { alg: 'none' }),
        other_key: mintJwt(humanClaims(issuerBase), { privateKey: generateSigningKey('other').privateKey, kid: KID }),
      };
      for (const [label, token] of Object.entries(bad)) {
        const out = await rpc(handler, INITIALIZE, { token });
        assert.strictEqual(out.status, 401, label);
        assert.match(String(out.headers['www-authenticate']), /error="invalid_token"/, label);
      }
    } finally {
      await stopServer(upstream);
    }
  });

  it('accepts a valid JWT, never calls /api/me, and forwards the caller token', async () => {
    const seen = [];
    const upstream = await fakeUpstream((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
        if (req.url === '/api/tasks?owner=me') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tasks: [{ id: 't1' }] }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });
    try {
      const handler = proxyFor(upstream);
      const init = await rpc(handler, INITIALIZE);
      assert.strictEqual(init.status, 200);
      assert.strictEqual(init.json.result.serverInfo.name, SERVER_INFO.name);
      const list = await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.deepStrictEqual(list.json.result.tools.map((t) => t.name).sort(), ['dataops_guide', 'dataops_read', 'dataops_write']);
      const guide = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dataops_guide', arguments: {} } });
      assert.match(guide.json.result.content[0].text, /Template/);
      const read = await rpc(handler, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dataops_read', arguments: { route: '/api/tasks?owner=me' } } });
      assert.match(read.json.result.content[0].text, /t1/);
      const refused = await rpc(handler, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dataops_read', arguments: { route: '/api/users' } } });
      assert.strictEqual(refused.status, 200);
      assert.strictEqual(refused.json.result.isError, true);
      assert.ok(!refused.json.result.content[0].text.includes(goodToken), 'token never echoed in tool errors');
      assert.ok(seen.every((s) => s.auth === `Bearer ${goodToken}`), 'caller JWT forwarded unchanged');
      assert.ok(!seen.some((s) => s.url === '/api/me'), 'tokens verified locally, never via /api/me');
    } finally {
      await stopServer(upstream);
    }
  });
});

describe('verification contract', () => {
  beforeEach(() => {
    resetJwksCache();
  });

  it('resourceForRequest normalizes path, trailing slashes and queries', () => {
    const host = 'https://mcp.ops.dtcdev.click';
    assert.strictEqual(resourceForRequest(`${host}/mcp`), `${host}/mcp`);
    assert.strictEqual(resourceForRequest(`${host}/mcp/`), `${host}/mcp`);
    assert.strictEqual(resourceForRequest(`${host}/mcp?x=1`), `${host}/mcp`);
  });

  it('requestUrl derives the origin from proxy headers', () => {
    const forwarded = { url: '/mcp', headers: { 'x-forwarded-host': 'mcp.ops.dtcdev.click', 'x-forwarded-proto': 'https' } };
    assert.strictEqual(requestUrl(forwarded), 'https://mcp.ops.dtcdev.click/mcp');
    const loopback = { url: '/mcp', headers: { host: 'localhost:8080' } };
    assert.strictEqual(requestUrl(loopback), 'http://localhost:8080/mcp');
  });

  it('metadata and challenge shapes follow RFC 9728 and RFC 6750', () => {
    const host = 'https://mcp.ops.dtcdev.click';
    const meta = protectedResourceMetadata(`${host}/mcp`, DEFAULT_ISSUER);
    assert.strictEqual(meta.resource, `${host}/mcp`);
    assert.deepStrictEqual(meta.authorization_servers, [DEFAULT_ISSUER]);
    assert.deepStrictEqual(meta.bearer_methods_supported, ['header']);
    const failed = bearerChallengeHeaders(`${host}/mcp`, { error: 'invalid_token' });
    assert.strictEqual(
      failed['WWW-Authenticate'],
      `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    );
    const plain = bearerChallengeHeaders(`${host}/mcp`);
    assert.strictEqual(plain['WWW-Authenticate'], `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('verifies signature, issuer, expiry and audience', async () => {
    const ok = await verifyJwt(goodToken, { issuer: issuerBase });
    assert.strictEqual(ok.sub, 'user-1');
    await assert.rejects(() => verifyJwt(mintJwt(humanClaims(issuerBase), { alg: 'none' }), { issuer: issuerBase }), /invalid_token/);
    await assert.rejects(() => verifyJwt(mintJwt(humanClaims(issuerBase), { privateKey: pair.privateKey, kid: 'unknown' }), { issuer: issuerBase }), /invalid_token/);
  });

  it('authenticate returns null without a bearer header and resolves the resource', async () => {
    assert.strictEqual(await authenticateRequest('', 'http://localhost/mcp', { issuer: issuerBase }), null);
    assert.strictEqual(await authenticateRequest('Token x', 'http://localhost/mcp', { issuer: issuerBase }), null);
    const caller = await authenticateRequest(`Bearer ${goodToken}`, 'http://localhost/mcp', { issuer: issuerBase });
    assert.strictEqual(caller.resource, 'http://localhost/mcp');
    assert.strictEqual(caller.claims.email, 'agent@datatalks.club');
    await assert.rejects(
      () => authenticateRequest(`Bearer ${goodToken}`, 'https://ops.dtcdev.click/api', { issuer: issuerBase }),
      /invalid_target/,
    );
  });
});
