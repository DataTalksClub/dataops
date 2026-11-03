import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dataops-tokens-'));
const configDir = path.join(tempRoot, 'admin');
const targetDir = path.join(tempRoot, 'hub-shared', 'dataops');
const previousConfigDir = process.env.DATAOPS_CONFIG_DIR;
const previousUrl = process.env.DATAOPS_URL;
const previousToken = process.env.DATAOPS_TOKEN;
process.env.DATAOPS_CONFIG_DIR = configDir;
process.env.DATAOPS_URL = '';
delete process.env.DATAOPS_TOKEN;

const { resolveProfile, resolveProfileFromDir, saveProfile } = await import('../src/config.mjs');
const tokens = await import('../src/commands/tokens.mjs');
const auth = await import('../src/commands/auth.mjs');
const { run } = await import('../src/cli.mjs');
const PORTAL = 'https://portal.test';
const RAW_TOKEN = 'dops_synthetic_token_value_never_printed';

function ioCapture() {
  const output = [];
  const print = (line) => output.push(String(line));
  return { output, print, log: print, error: print, text: () => output.join('\n') };
}

function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    let body = options.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* leave it as text */ }
    }
    const call = { method: options.method || 'GET', path: parsed.pathname, body, headers: options.headers || {} };
    calls.push(call);
    const response = await routes[`${call.method} ${call.path}`]?.(call);
    if (!response) return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 });
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status || 200 });
  };
  return calls;
}

describe('headless scoped agent tokens', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    rmSync(path.join(tempRoot, 'hub-shared'), { recursive: true, force: true });
    saveProfile(PORTAL, { token: 'synthetic-admin-credential', kind: 'user' });
    globalThis.fetch = originalFetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    if (previousConfigDir === undefined) delete process.env.DATAOPS_CONFIG_DIR;
    else process.env.DATAOPS_CONFIG_DIR = previousConfigDir;
    if (previousUrl === undefined) delete process.env.DATAOPS_URL;
    else process.env.DATAOPS_URL = previousUrl;
    if (previousToken === undefined) delete process.env.DATAOPS_TOKEN;
    else process.env.DATAOPS_TOKEN = previousToken;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('creates a token into a separate owner-only credential file without returning or printing the bearer', async () => {
    const calls = fakeFetch({
      'POST /api/tokens': (call) => ({
        status: 201,
        body: {
          token: RAW_TOKEN,
          apiToken: {
            id: 'agent-token-id', userId: 'admin-id', issuedBy: 'admin-id',
            label: call.body.label, scopes: call.body.scopes,
            createdAt: '2026-11-03T00:00:00.000Z', expiresAt: '2027-02-01T00:00:00.000Z', lastUsedAt: null,
          },
        },
      }),
    });
    const io = ioCapture();
    const result = await tokens.commands.create({
      label: 'hub-sessions@hetzner',
      adminConfigDir: configDir,
      configDir: targetDir,
      url: PORTAL,
    }, io);

    assert.equal(JSON.stringify(result).includes(RAW_TOKEN), false);
    assert.equal(io.text().includes(RAW_TOKEN), false);
    assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-admin-credential');
    assert.deepEqual(calls[0].body.scopes, ['kb:write', 'templates:write', 'cards:write', 'newsletter:write']);
    const stored = resolveProfileFromDir(targetDir, { url: PORTAL });
    assert.equal(stored.token, RAW_TOKEN);
    assert.equal(stored.tokenId, 'agent-token-id');
    assert.equal(stored.kind, 'agent');
    assert.equal(stored.label, 'hub-sessions@hetzner');
    assert.equal(path.dirname(result.credentialsPath), targetDir);
    if (process.platform !== 'win32') {
      assert.equal(statSync(targetDir).mode & 0o777, 0o700);
      assert.equal(statSync(result.credentialsPath).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(readFileSync(result.credentialsPath, 'utf8')).includes(RAW_TOKEN), true);
  });

  test('exposes token creation through the DataOps CLI and keeps --json output safe', async () => {
    fakeFetch({
      'POST /api/tokens': (call) => ({
        status: 201,
        body: {
          token: RAW_TOKEN,
          apiToken: {
            id: 'cli-agent-id', userId: 'admin-id', issuedBy: 'admin-id',
            label: call.body.label, scopes: call.body.scopes,
            createdAt: '2026-11-03T00:00:00.000Z', expiresAt: '2027-02-01T00:00:00.000Z', lastUsedAt: null,
          },
        },
      }),
    });
    const io = ioCapture();
    const exitCode = await run([
      'tokens', 'create', '--label', 'hub-sessions@hetzner',
      '--scope', 'kb:write,templates:write,cards:write,newsletter:write',
      '--admin-config-dir', configDir, '--config-dir', targetDir, '--url', PORTAL, '--json',
    ], io);
    assert.equal(exitCode, 0);
    assert.equal(io.text().includes(RAW_TOKEN), false);
    assert.equal(JSON.parse(io.text()).apiToken.id, 'cli-agent-id');
    assert.equal(resolveProfileFromDir(targetDir, { url: PORTAL }).token, RAW_TOKEN);
  });

  test('revokes a newly issued token if safe credential storage is refused', async () => {
    const calls = fakeFetch({
      'POST /api/tokens': () => ({ body: { token: RAW_TOKEN, apiToken: { id: 'unsafe-target-token', label: 'unsafe', scopes: [] } } }),
      'DELETE /api/tokens/unsafe-target-token': () => ({ body: { revoked: true } }),
    });
    const io = ioCapture();
    await assert.rejects(() => tokens.commands.create({
      label: 'unsafe-target', adminConfigDir: configDir, configDir: process.cwd(), url: PORTAL,
    }, io), /could not be stored outside the repository/);
    assert.deepEqual(calls.map(({ method, path: route }) => `${method} ${route}`), [
      'POST /api/tokens', 'DELETE /api/tokens/unsafe-target-token',
    ]);
    assert.equal(io.text().includes(RAW_TOKEN), false);
  });

  test('whoami names the agent and logout self-revokes without displaying its token', async () => {
    saveProfile(PORTAL, {
      token: RAW_TOKEN, tokenId: 'agent-token-id', kind: 'agent', label: 'hub-sessions@hetzner',
      scopes: ['kb:write', 'templates:write', 'cards:write', 'newsletter:write'],
    });
    const calls = fakeFetch({
      'GET /api/me': () => ({ body: {
        user: { id: 'admin-id', name: 'Admin', email: 'admin@example.test', role: 'admin' },
        apiToken: { id: 'agent-token-id', label: 'hub-sessions@hetzner', scopes: ['cards:write'] },
      } }),
      'DELETE /api/tokens/self': () => ({ body: { revoked: true } }),
    });
    const whoamiIo = ioCapture();
    await auth.whoami({}, whoamiIo);
    assert.match(whoamiIo.text(), /token: hub-sessions@hetzner \(agent-to\)/);
    assert.match(whoamiIo.text(), /scopes: cards:write/);
    assert.equal(whoamiIo.text().includes(RAW_TOKEN), false);

    const logoutIo = ioCapture();
    await auth.logout({}, logoutIo);
    assert.equal(calls.some((call) => call.method === 'DELETE' && call.path === '/api/tokens/self'), true);
    assert.equal(logoutIo.text().includes(RAW_TOKEN), false);
    assert.equal(resolveProfile({ url: PORTAL }).token, '');
  });

  test('lists and revokes safe token metadata using the host admin credential', async () => {
    const calls = fakeFetch({
      'GET /api/tokens': () => ({ body: { tokens: [{ id: 'agent-id', label: 'agent', scopes: ['kb:write'], expiresAt: '2027-01-01T00:00:00.000Z' }] } }),
      'DELETE /api/tokens/agent-id': () => ({ body: { revoked: true } }),
    });
    const listIo = ioCapture();
    const listed = await tokens.commands.list({ adminConfigDir: configDir, url: PORTAL }, listIo);
    assert.equal(JSON.stringify(listed).includes(RAW_TOKEN), false);
    assert.match(listIo.text(), /agent-id  agent  kb:write/);
    const revokeIo = ioCapture();
    const revoked = await tokens.commands.revoke({ _: ['agent-id'], adminConfigDir: configDir, url: PORTAL }, revokeIo);
    assert.deepEqual(revoked, { revoked: true });
    assert.deepEqual(calls.map(({ method, path: route }) => `${method} ${route}`), [
      'GET /api/tokens', 'DELETE /api/tokens/agent-id',
    ]);
  });
});
