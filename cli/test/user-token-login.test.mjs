import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const bin = fileURLToPath(new URL('../bin/dataops.mjs', import.meta.url));
const token = `dops_${'a'.repeat(64)}`; // Synthetic; never a real credential.
const tokenId = createHash('sha256').update(token).digest('hex');
const user = { id: 'user-1', email: 'user@example.test', name: 'Test User', disabled: false };
const entry = { id: tokenId, userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' };
async function cli(args, dir, input = `${token}\n`, env = {}) {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: '', DATAOPS_URL: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.stdin.on('error', () => {}); // Early rejection can close stdin before the bounded input is sent.
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!output.includes(token), 'must never output the token');
  return { code, output };
}
async function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dataops-user-import-'));
  const calls = [];
  let handler = (request, response) => response.end(JSON.stringify(request.url.endsWith('/me') ? { user } : { tokens: [entry] }));
  const server = createServer((request, response) => {
    calls.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(dir, 'credentials.json');
  const original = JSON.stringify({ defaultUrl: url, profiles: { [url]: { token: 'existing-token' }, 'https://other.test': { token: 'other-token' } } });
  writeFileSync(file, original, { mode: 0o600 });
  try { await run({ dir, file, original, url, calls, setHandler: value => { handler = value; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
}

test('imports validated user token, persists revocation metadata, preserves other profiles, and emits safe JSON', async () => {
  await fixture(async ({ dir, file, url, calls, setHandler }) => {
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
    const result = await cli(['login', '--token-stdin', '--url', `${url}/`, '--json'], dir, `${token}\r\n`, { DATAOPS_TOKEN: 'ignored-env-token', DATAOPS_URL: 'https://ignored.test' });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(result.output), { status: 'signed-in', kind: 'user' });
    const store = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(store.defaultUrl, url);
    assert.deepEqual(store.profiles[url], { token, tokenId, kind: 'user', expiresAt: entry.expiresAt, user: { id: user.id, email: user.email, name: user.name } });
    assert.deepEqual(store.profiles['https://other.test'], { token: 'other-token' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(calls.map(call => call.url), ['/work/api/me', '/work/api/tokens']);
    assert.ok(calls.every(call => call.authorization === `Bearer ${token}`));
    setHandler((request, response) => response.end(JSON.stringify(request.method === 'DELETE' ? {} : { tokens: [entry] })));
    assert.equal((await cli(['logout'], dir)).code, 0);
    assert.equal(calls.at(-1).url, `/work/api/tokens/${tokenId}`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profiles[url], undefined);
  });
});

test('uses DATAOPS_URL then saved default when no explicit portal is supplied', async () => {
  await fixture(async ({ dir, url, calls }) => {
    assert.equal((await cli(['login', '--token-stdin'], dir, token, { DATAOPS_URL: url })).code, 0);
    assert.equal((await cli(['login', '--token-stdin'], dir)).code, 0);
    assert.equal(calls.length, 4);
  });
});

for (const status of [401, 403, 500]) test(`HTTP ${status} rejects without echoing body or changing credentials`, async () => {
  await fixture(async ({ dir, file, original, url, setHandler }) => {
    setHandler((_request, response) => { response.statusCode = status; response.end(JSON.stringify({ error: token })); });
    const result = await cli(['login', '--token-stdin', '--url', url, '--json'], dir);
    assert.equal(result.code, 1);
    assert.match(result.output, /Stored credentials unchanged/);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

const badIdentities = [null, 'not JSON', {}, { user: {} }, { user: { ...user, disabled: true } }, { user, service: { id: 'invoice-reader' } }];
for (const [index, identity] of badIdentities.entries()) test(`rejects malformed or service identity ${index}`, async () => {
  await fixture(async ({ dir, file, original, setHandler }) => {
    setHandler((request, response) => response.end(JSON.stringify(request.url.endsWith('/me') ? identity : { tokens: [entry] })));
    assert.equal((await cli(['login', '--token-stdin'], dir)).code, 1);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

for (const [name, tokens] of Object.entries({ revoked: [], expired: [{ ...entry, expiresAt: '2000-01-01' }], wrongOwner: [{ ...entry, userId: 'another-user' }], invalidExpiry: [{ ...entry, expiresAt: 'invalid' }], missingMetadata: null })) test(`rejects ${name} token metadata`, async () => {
  await fixture(async ({ dir, file, original, setHandler }) => {
    setHandler((request, response) => response.end(JSON.stringify(request.url.endsWith('/me') ? { user } : { tokens })));
    assert.equal((await cli(['login', '--token-stdin'], dir)).code, 1);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

for (const input of ['', 'malformed', `dops_svc_${'b'.repeat(64)}`, `${token}\n${token}`, 'x'.repeat(10000)]) test(`rejects invalid stdin of length ${input.length} before network use`, async () => {
  await fixture(async ({ dir, file, original, calls }) => {
    assert.equal((await cli(['login', '--token-stdin'], dir, input)).code, 1);
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

for (const args of [ ['--token-stdin', token], [`--token-stdin=${token}`], ['--token-stdin', '--service-token-stdin'], ['--token-stdin', '--url', 'http://remote.example.test'], ['--token-stdin', '--url', 'https://user:password@example.test'], ['--token-stdin', '--url', 'https://example.test/?secret=value'], ['--token-stdin', '--url', 'invalid'] ]) test(`rejects unsafe invocation with ${args.length} arguments`, async () => {
  await fixture(async ({ dir, file, original, calls }) => {
    assert.equal((await cli(['login', ...args], dir)).code, 1);
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

for (const mode of ['network', 'redirect', 'invalid-json', 'echo-success']) test(`${mode} cannot leak a secret or overwrite working credentials`, async () => {
  await fixture(async ({ dir, file, original, calls, url, setHandler }) => {
    setHandler((request, response) => {
      if (mode === 'network') { request.socket.destroy(); return; }
      if (mode === 'redirect') { response.writeHead(302, { Location: `${url}/leak` }); response.end(); return; }
      response.end(mode === 'invalid-json' ? token : JSON.stringify({ token, user: { id: token } }));
    });
    assert.equal((await cli(['login', '--token-stdin', '--json'], dir)).code, 1);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.ok(calls.every(call => call.url !== '/leak'));
  });
});

test('refuses terminal stdin before trying to read or send a credential', async () => {
  await fixture(async ({ dir, file, original, calls }) => {
    const script = `
      import tty from 'node:tty';
      import { syncBuiltinESMExports } from 'node:module';
      tty.isatty = () => true;
      syncBuiltinESMExports();
      const { run } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
      process.exitCode = await run(['login', '--token-stdin']);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: '', DATAOPS_URL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 1);
    assert.match(output, /terminal input could echo/);
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

test('times out a stalled validation request and preserves the working profile', { timeout: 20_000 }, async () => {
  await fixture(async ({ dir, file, original, setHandler }) => {
    setHandler(() => {});
    const result = await cli(['login', '--token-stdin'], dir);
    assert.equal(result.code, 1);
    assert.match(result.output, /timeout/);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

test('supports a bare backend using the existing API seam fallback', async () => {
  await fixture(async ({ dir, calls, setHandler }) => {
    setHandler((request, response) => {
      if (request.url.startsWith('/work/')) { response.statusCode = 404; response.end('Not found'); return; }
      response.end(JSON.stringify(request.url === '/api/me' ? { user } : { tokens: [entry] }));
    });
    assert.equal((await cli(['login', '--token-stdin'], dir)).code, 0);
    assert.deepEqual(calls.map(call => call.url), ['/work/api/me', '/api/me', '/work/api/tokens', '/api/tokens']);
  });
});

test('a failed credential replacement leaves the original file intact and cleans up temporary files', async () => {
  await fixture(async ({ dir, file, original }) => {
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      fs.renameSync = () => { throw new Error('Synthetic disk failure'); };
      syncBuiltinESMExports();
      const { saveProfile } = await import(${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)});
      assert.throws(() => saveProfile('https://portal.test', { token: 'synthetic-only' }), /Synthetic disk failure/);
      assert.deepEqual(fs.readdirSync(process.env.DATAOPS_CONFIG_DIR), ['credentials.json']);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DATAOPS_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 0, output);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});
