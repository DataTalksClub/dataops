import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { createUserWithId } from '../src/db/users';
import { createBrowserSession } from '../src/db/sessions';
import { createApiToken } from '../src/db/cliAuth';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import type { LambdaResponse } from '../src/types';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp';
import { TOOL_DEFINITIONS as SHARED_DEFINITIONS } from '../../mcp/src/tools.mjs';

describe('API — DataOps MCP (POST /mcp)', () => {
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    const port = await startLocal();
    await createTables(await getClient(port));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function mcp(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res: LambdaResponse = await handler(
      { httpMethod: 'POST', path: '/mcp', headers, body: JSON.stringify(body) },
      {},
    );
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  }

  it('keeps the in-Lambda tools in sync with the mcp/ package', () => {
    assert.deepStrictEqual(
      MCP_TOOL_DEFINITIONS.map((t) => t.name),
      (SHARED_DEFINITIONS as Array<{ name: string }>).map((t) => t.name),
    );
    const shared = Object.fromEntries((SHARED_DEFINITIONS as any[]).map((t) => [t.name, t.description]));
    for (const tool of MCP_TOOL_DEFINITIONS) {
      assert.strictEqual(tool.description, shared[tool.name], tool.name);
    }
  });

  it('answers initialize with the dataops-mcp server identity', async () => {
    const out = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.json.result.serverInfo.name, 'dataops-mcp');
    assert.strictEqual(out.json.result.protocolVersion, '2025-06-18');
    assert.ok(out.json.result.capabilities.tools);
  });

  it('lists exactly read, write and guide', async () => {
    const out = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepStrictEqual(
      out.json.result.tools.map((t: any) => t.name).sort(),
      ['dataops_guide', 'dataops_read', 'dataops_write'],
    );
  });

  it('serves the guide without touching the database', async () => {
    const out = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dataops_guide', arguments: {} } });
    assert.match(out.json.result.content[0].text, /Template/);
  });

  it('reads through the same route handlers as the portal', async () => {
    const out = await mcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'dataops_read', arguments: { route: '/api/health' } },
    });
    assert.match(out.json.result.content[0].text, /"ok"/);
  });

  it('refuses auth, token and traversal routes as tool errors', async () => {
    for (const route of ['/api/auth/device', '/api/users/tokens/x', '/api/../tasks']) {
      const out = await mcp({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'dataops_read', arguments: { route } },
      });
      assert.strictEqual(out.json.result?.isError, true, route);
    }
  });

  it('rejects unknown tools and methods with JSON-RPC errors', async () => {
    const unknownTool = await mcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'pocketshell', arguments: {} },
    });
    assert.strictEqual(unknownTool.json.error.code, -32602);
    const unknownMethod = await mcp({ jsonrpc: '2.0', id: 7, method: 'completion/complete', params: {} });
    assert.strictEqual(unknownMethod.json.error.code, -32601);
  });

  it('answers GET with 405 and accepts notifications with 202', async () => {
    const get: LambdaResponse = await handler({ httpMethod: 'GET', path: '/mcp', headers: {}, body: null }, {});
    assert.strictEqual(get.statusCode, 405);
    const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    assert.strictEqual(note.status, 202);
  });

  it('refuses unauthenticated MCP calls outside the test auth bypass', async () => {
    const saved = process.env.SKIP_AUTH;
    delete process.env.SKIP_AUTH;
    try {
      const res: LambdaResponse = await handler(
        {
          httpMethod: 'POST',
          path: '/mcp',
          headers: {},
          body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
        },
        {},
      );
      assert.strictEqual(res.statusCode, 401);
    } finally {
      if (saved !== undefined) process.env.SKIP_AUTH = saved;
    }
  });

  it('keeps service credential route restrictions on every MCP call', async () => {
    const savedSkip = process.env.SKIP_AUTH;
    const savedDigest = process.env.INVOICE_READER_TOKEN_SHA256;
    const token = `dops_svc_${'a'.repeat(64)}`;
    delete process.env.SKIP_AUTH;
    process.env.INVOICE_READER_TOKEN_SHA256 = createHash('sha256').update(token).digest('hex');
    const headers = { Authorization: `Bearer ${token}`, 'x-user-id': 'spoofed-admin' };
    const call = (name: string, args: Record<string, unknown>) => mcp({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args },
    }, headers);
    try {
      const list = await mcp({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, headers);
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.json.result.tools.length, 3);
      for (const route of ['/api/tasks?status=todo', '/api/bookkeeping/invoices']) {
        const read = await call('dataops_read', { route });
        assert.strictEqual(read.status, 200);
        assert.ok(!read.json.result.isError, `${route}: ${read.json.result.content[0].text}`);
        assert.doesNotThrow(() => JSON.parse(read.json.result.content[0].text));
      }
      for (const [name, args] of [
        ['dataops_read', { route: '/api/users' }],
        ['dataops_read', { route: '/api/templates' }],
        ['dataops_write', { method: 'POST', route: '/api/bookkeeping/invoices', body: {} }],
      ] as const) {
        const denied = await call(name, args);
        assert.strictEqual(denied.json.result.isError, true);
        assert.match(denied.json.result.content[0].text, /refused the credential/);
      }
      // Revocation applies to MCP as soon as it applies to the direct API.
      delete process.env.INVOICE_READER_TOKEN_SHA256;
      assert.strictEqual((await call('dataops_read', { route: '/api/tasks' })).status, 401);
    } finally {
      if (savedSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = savedSkip;
      if (savedDigest === undefined) delete process.env.INVOICE_READER_TOKEN_SHA256;
      else process.env.INVOICE_READER_TOKEN_SHA256 = savedDigest;
    }
  });

  it('retains API token and browser session identity through nested reads', async () => {
    const config = {
      SKIP_AUTH: 'false', DATAOPS_DOCS_DOMAIN: 'true', WORK_ENGINE_AUTH_MODE: 'portal',
      AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
      AUTH_CLIENT_ID: 'synthetic', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
      AUTH_LOGOUT_URL: 'https://ops.example.test/',
    };
    const saved = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
    Object.assign(process.env, config);
    try {
      const client = await getClient();
      await createUserWithId(client, 'mcp-operator', { name: 'MCP Operator', email: 'mcp@example.test', role: 'operator' });
      const api = await createApiToken(client, { userId: 'mcp-operator', label: 'MCP test', source: 'manual' });
      const session = await createBrowserSession(client, 'mcp-operator', { lifetimeSeconds: 3600 });
      for (const headers of [
        { Authorization: `Bearer ${api.token}` },
        { cookie: `dataops_session=${session.token}` },
      ]) {
        const read = await mcp({
          jsonrpc: '2.0', id: 11, method: 'tools/call',
          params: { name: 'dataops_read', arguments: { route: '/api/me' } },
        }, headers as Record<string, string>);
        assert.strictEqual(read.status, 200);
        assert.ok(!read.json.result.isError, read.json.result.content[0].text);
        assert.match(read.json.result.content[0].text, /mcp-operator/);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
