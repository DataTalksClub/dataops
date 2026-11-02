import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createLambdaHandler } from '../src/lambda.mjs';
import { resetJwksCache } from '../src/auth.mjs';
import { generateSigningKey, humanClaims, mintJwt, startJwksServer } from './helpers/issuer-rig.mjs';

const KID = 'lambda-key-1';
const pair = generateSigningKey(KID);

let issuer = '';
let goodToken = '';
let seen = [];
let revoked = false;
let invoke;
let jwksServer;
let upstream;

const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

function event(body, { token = goodToken, base64 = false } = {}) {
  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    requestContext: { http: { method: 'POST' } },
    headers: token === null ? { Host: 'mcp.local' } : { Host: 'mcp.local', Authorization: `Bearer ${token}` },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
  };
}

before(async () => {
  jwksServer = await startJwksServer([pair.jwk]);
  issuer = `http://127.0.0.1:${jwksServer.address().port}`;
  goodToken = mintJwt(humanClaims(issuer, { aud: 'https://mcp.local/mcp' }), { privateKey: pair.privateKey, kid: KID });
  upstream = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, user: req.headers['x-user-id'] });
    if (revoked || req.headers.authorization !== `Bearer ${goodToken}`) {
      res.writeHead(401);
      res.end('{"error":"Unauthorized"}');
      return;
    }
    if (req.url === '/api/tasks?limit=1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"tasks":[{"id":"seed-task"}]}');
      return;
    }
    res.writeHead(403);
    res.end('{"error":"Forbidden"}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  invoke = createLambdaHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}`, issuer });
});

after(async () => {
  if (jwksServer) await new Promise((resolve) => jwksServer.close(resolve));
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

describe('MCP Lambda Function URL transport', () => {
  beforeEach(() => {
    seen = [];
    revoked = false;
    resetJwksCache();
  });

  it('serves initialize and tools/list only with a shared-issuer JWT', async () => {
    const init = await invoke(event(rpc('initialize', { protocolVersion: '2025-06-18' })));
    assert.equal(init.statusCode, 200);
    assert.equal(JSON.parse(init.body).result.serverInfo.name, 'dataops-mcp');
    const list = await invoke(event(rpc('tools/list')));
    assert.equal(JSON.parse(list.body).result.tools.length, 3);
    const noToken = await invoke(event(rpc('tools/list'), { token: null }));
    assert.equal(noToken.statusCode, 401);
    assert.match(String(noToken.headers['WWW-Authenticate'] || ''), /resource_metadata=/);
    const opaque = await invoke(event(rpc('tools/list'), { token: 'dops_opaque' }));
    assert.equal(opaque.statusCode, 401);
    // A revoked upstream no longer breaks the session: the JWT still verifies
    // locally, and the refusal surfaces as a per-tool-call error instead.
    revoked = true;
    const afterRevoke = await invoke(event(rpc('tools/call', { name: 'dataops_read', arguments: { route: '/api/tasks?limit=1' } })));
    assert.equal(afterRevoke.statusCode, 200);
    assert.equal(JSON.parse(afterRevoke.body).result.isError, true);
  });

  it('forwards reads with the caller JWT and drops spoofed identity headers', async () => {
    const call = event(rpc('tools/call', { name: 'dataops_read', arguments: { route: '/api/tasks?limit=1' } }));
    call.headers['X-User-Id'] = 'forged-admin';
    const read = await invoke(call);
    assert.equal(read.statusCode, 200);
    const result = JSON.parse(read.body).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { tasks: [{ id: 'seed-task' }] });
    assert.deepEqual(seen.map((row) => row.url), ['/api/tasks?limit=1']);
    assert.ok(seen.every((row) => row.auth === `Bearer ${goodToken}` && row.user === undefined));
  });

  it('maps upstream refusals into tool errors', async () => {
    const denied = await invoke(event(rpc('tools/call', { name: 'dataops_read', arguments: { route: '/api/users' } })));
    assert.equal(denied.statusCode, 200);
    assert.equal(JSON.parse(denied.body).result.isError, true);
  });

  it('decodes base64 bodies; notifications need a valid JWT and answer empty', async () => {
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const noToken = await invoke(event(note, { token: null }));
    assert.equal(noToken.statusCode, 401);
    const batched = await invoke(event(rpc('tools/list'), { base64: true }));
    assert.equal(JSON.parse(batched.body).result.tools.length, 3);
  });

  it('rejects malformed, oversized and off-route requests', async () => {
    const broken = await invoke(event('{'));
    assert.equal(broken.statusCode, 400);
    assert.equal(JSON.parse(broken.body).error.code, -32700);
    const huge = await invoke(event('x'.repeat(256 * 1024 + 1)));
    assert.equal(huge.statusCode, 413);
    const wrong = event(rpc('tools/list'), { token: null });
    wrong.rawPath = '/api/tasks';
    assert.equal((await invoke(wrong)).statusCode, 404);
    const get = event(rpc('tools/list'));
    get.requestContext.http.method = 'GET';
    get.routeKey = 'GET /mcp';
    const got = await invoke(get);
    assert.equal(got.statusCode, 405);
    assert.equal(got.headers.Allow, 'POST');
  });
});
