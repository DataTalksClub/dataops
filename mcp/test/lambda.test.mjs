import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLambdaHandler } from '../src/lambda.mjs';

describe('dedicated MCP Lambda Function URL transport', () => {
  let upstream;
  let invoke;
  let revoked = false;
  const seen = [];
  before(async () => {
    upstream = createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization, userId: req.headers['x-user-id'] });
      res.setHeader('Content-Type', 'application/json');
      if (revoked || req.headers.authorization !== 'Bearer synthetic-service-token') {
        res.writeHead(401);
        return res.end('{"error":"Unauthorized"}');
      }
      if (req.url === '/api/me') return res.end('{"service":{"id":"test-service"}}');
      if (req.url === '/api/tasks?status=todo&limit=1') return res.end('{"tasks":[{"id":"synthetic-task"}]}');
      res.writeHead(403);
      res.end('{"error":"Forbidden"}');
    });
    await new Promise((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    invoke = createLambdaHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}` });
  });
  after(async () => {
    if (upstream) await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  beforeEach(() => { seen.length = 0; revoked = false; });

  function event(message, overrides = {}) {
    return {
      version: '2.0', rawPath: '/mcp', requestContext: { http: { method: 'POST' } },
      headers: { Authorization: 'Bearer synthetic-service-token', 'x-user-id': 'spoofed-admin' },
      body: JSON.stringify(message), ...overrides,
    };
  }
  const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

  it('serves initialization and tools only after upstream authentication', async () => {
    const init = await invoke(event(rpc('initialize', { protocolVersion: '2025-06-18' })));
    assert.equal(init.statusCode, 200);
    assert.equal(JSON.parse(init.body).result.serverInfo.name, 'dataops-mcp');
    const list = await invoke(event(rpc('tools/list')));
    assert.equal(JSON.parse(list.body).result.tools.length, 3);
    assert.equal((await invoke(event(rpc('tools/list'), { headers: {} }))).statusCode, 401);
    revoked = true;
    assert.equal((await invoke(event(rpc('initialize')))).statusCode, 401);
  });

  it('forwards a real read with the caller token and preserves upstream restrictions', async () => {
    const read = await invoke(event(rpc('tools/call', {
      name: 'dataops_read', arguments: { route: '/api/tasks?status=todo&limit=1' },
    })));
    const result = JSON.parse(read.body).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { tasks: [{ id: 'synthetic-task' }] });
    assert.deepEqual(seen.map((r) => r.path), ['/api/me', '/api/tasks?status=todo&limit=1']);
    assert.ok(seen.every((r) => r.auth === 'Bearer synthetic-service-token' && r.userId === undefined));
    const denied = await invoke(event(rpc('tools/call', { name: 'dataops_read', arguments: { route: '/api/users' } })));
    assert.equal(JSON.parse(denied.body).result.isError, true);
  });

  it('decodes base64 request bodies and returns empty notification responses', async () => {
    const list = await invoke(event(null, {
      isBase64Encoded: true, body: Buffer.from(JSON.stringify(rpc('tools/list'))).toString('base64'),
    }));
    assert.equal(JSON.parse(list.body).result.tools.length, 3);
    const note = await invoke(event({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(note.statusCode, 202);
    assert.equal(note.body, '');
  });

  it('rejects malformed or oversized requests and never exposes portal routes', async () => {
    const malformed = await invoke(event(null, { body: '{' }));
    assert.equal(malformed.statusCode, 400);
    assert.equal(JSON.parse(malformed.body).error.code, -32700);
    assert.equal((await invoke(event(null, { body: 'x'.repeat(256 * 1024 + 1) }))).statusCode, 413);
    assert.equal((await invoke(event(rpc('tools/list'), { rawPath: '/api/tasks' }))).statusCode, 404);
    const get = await invoke(event(null, { requestContext: { http: { method: 'GET' } } }));
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.Allow, 'POST');
  });
});
