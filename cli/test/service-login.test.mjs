import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(root, '.tmp');
mkdirSync(scratch, { recursive: true });
const token = `dops_svc_${'a'.repeat(64)}`;
const principal = { service: { id: 'invoice-reader', scopes: ['invoices:read'], expiresAt: null } };
async function cli(args, dir, input = '') {
  const child = spawn(process.execPath, [path.join(root, 'cli/bin/dataops.mjs'), ...args], {
    env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: '', DATAOPS_URL: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!output.includes(token));
  return { code, output };
}

test('real CLI configures a verified service profile, identifies it, and removes only the local copy', async () => {
  const dir = mkdtempSync(path.join(scratch, 'service-cli-'));
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    const ok = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(ok ? principal : { error: 'Unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await cli(['login', '--service-token-stdin', '--url', url], dir, `${token}\n`)).code, 0);
    const file = path.join(dir, 'credentials.json');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(store.defaultUrl, url);
    assert.equal(store.profiles[url].kind, 'service');
    assert.equal(store.profiles[url].expiresAt, null);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await cli(['whoami'], dir)).output.includes('invoice-reader (invoices:read)'), true);
    const count = calls.length;
    assert.equal((await cli(['logout'], dir)).code, 0);
    assert.equal(calls.length, count);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profiles[url], undefined);
    assert.deepEqual(calls, ['/work/api/me', '/work/api/me']);
    const failedDir = path.join(dir, 'failed');
    assert.equal((await cli(['login', '--service-token-stdin', '--url', url], failedDir, `dops_svc_${'b'.repeat(64)}`)).code, 1);
    assert.equal(existsSync(path.join(failedDir, 'credentials.json')), false);
    assert.equal((await cli(['login', '--service-token-stdin', '--url', 'http://remote.example.test'], failedDir, token)).code, 1);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
