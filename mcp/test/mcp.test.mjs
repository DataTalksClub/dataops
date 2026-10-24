import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';

import { GUIDE, POCKETSHELL_PARITY, TOOL_DEFINITIONS, validateRoute } from '../src/tools.mjs';
import { createProxyHandler, validateCaller } from '../src/proxy.mjs';

describe('DataOps MCP tools', () => {
  it('exposes exactly read, write and guide', () => {
    assert.deepStrictEqual(
      TOOL_DEFINITIONS.map((t) => t.name).sort(),
      ['dataops_guide', 'dataops_read', 'dataops_write'],
    );
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
    for (const route of [
      '/api/auth/device',
      '/api/auth/device/token',
      '/api/tokens',
      '/api/users/tokens/x',
      '/api/../secrets',
      '/api/%2e%2e/tasks',
      'https://example.com/api/tasks',
      '/other',
      '',
    ]) {
      assert.throws(() => validateRoute(route), /Invalid|refused|not tools/, route);
    }
  });

  it('covers every pocketshell-mcp DataOps command family', () => {
    const commands = Object.keys(POCKETSHELL_PARITY);
    assert.strictEqual(commands.length, 24);
    for (const command of commands) {
      const family = POCKETSHELL_PARITY[command];
      const probe = family === '/api/team-members' ? '/api/team-members' : `${family}/probe`;
      assert.doesNotThrow(() => validateRoute(probe), command);
    }
  });

  it('guide names the domain vocabulary', () => {
    assert.match(GUIDE.portal, /Template.*Card.*Task/s);
  });
});

function startFakeUpstream(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function rpc(handler, body, headers = {}) {
  const req = {
    url: '/mcp',
    method: 'POST',
    headers: { authorization: 'Bearer test-token', ...headers },
  };
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code, responseHeaders) {
      status = code;
      this.responseHeaders = responseHeaders;
    },
    end(data) {
      payload = data || '';
      this.finished = true;
    },
  };
  const chunks = [Buffer.from(JSON.stringify(body))];
  const fakeReq = Object.assign(req, {
    on(event, fn) {
      if (event === 'data') chunks.forEach((c) => fn(c));
      if (event === 'end') queueMicrotask(fn);
      return this;
    },
    destroy() {},
  });
  await handler(fakeReq, res);
  return { status, json: payload ? JSON.parse(payload) : null };
}

describe('DataOps MCP proxy protocol', () => {
  it('authenticates initialize and tools/list with the DataOps credential', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 'u1' } }));
    });
    try {
      const handler = createProxyHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}` });
      const init = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      assert.strictEqual(init.status, 200);
      assert.strictEqual(init.json.result.serverInfo.name, 'dataops-mcp');
      assert.strictEqual(init.json.result.protocolVersion, '2025-06-18');
      const list = await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.deepStrictEqual(list.json.result.tools.map((t) => t.name).sort(), ['dataops_guide', 'dataops_read', 'dataops_write']);
      for (const method of ['initialize', 'tools/list']) {
        const denied = await rpc(handler, { jsonrpc: '2.0', id: 2, method }, { authorization: '' });
        assert.strictEqual(denied.status, 401);
      }
    } finally {
      upstream.close();
    }
  });

  it('refuses tool calls without a valid upstream session', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    });
    try {
      const handler = createProxyHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}` });
      const out = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dataops_read', arguments: { route: '/api/tasks' } } });
      assert.strictEqual(out.status, 401);
    } finally {
      upstream.close();
    }
  });

  it('proxies read and guide calls with the caller token', async () => {
    const seen = [];
    const upstream = await startFakeUpstream((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
        if (req.url === '/api/me') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ user: { id: 'u1' } }));
        } else if (req.url === '/api/tasks?owner=me') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tasks: [{ id: 't1' }] }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });
    try {
      const handler = createProxyHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}` });
      const guide = await rpc(handler, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dataops_guide', arguments: {} } });
      assert.match(guide.json.result.content[0].text, /Template/);
      const read = await rpc(handler, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'dataops_read', arguments: { route: '/api/tasks?owner=me' } },
      });
      assert.match(read.json.result.content[0].text, /t1/);
      assert.ok(seen.every((s) => s.auth === 'Bearer test-token'), 'caller token forwarded unchanged');
      const bad = await rpc(handler, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'dataops_read', arguments: { route: '/api/auth/device' } },
      });
      assert.strictEqual(bad.json.result.isError, true);
    } finally {
      upstream.close();
    }
  });

  it('rejects unknown protocol methods', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    try {
      const handler = createProxyHandler({ upstreamBase: `http://127.0.0.1:${upstream.address().port}` });
      const out = await rpc(handler, { jsonrpc: '2.0', id: 7, method: 'nope', params: {} });
      assert.strictEqual(out.json.error.code, -32601);
    } finally {
      upstream.close();
    }
  });

  it('validateCaller returns null without a bearer token', async () => {
    assert.strictEqual(await validateCaller('http://127.0.0.1:1', ''), null);
    assert.strictEqual(await validateCaller('http://127.0.0.1:1', 'Token x'), null);
  });
});
