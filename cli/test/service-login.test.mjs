import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(root, '.tmp');
mkdirSync(scratch, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'svc-test', alg: 'RS256', use: 'sig' };
const mintServiceJwt = (clientId, scope) => {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const t = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', kid: 'svc-test', typ: 'JWT' });
  const body = enc({ iss: 'http://issuer', aud: 'https://portal', sub: `service:${clientId}`, client_id: clientId, scope, email: null, exp: t + 900 });
  const signature = signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
};

const secret = 'svcsecret_0123456789abcdef';
const principal = { service: { id: 'invoice-reader', scopes: ['invoice:read'] } };

async function cli(args, dir, input = '') {
  const child = spawn(process.execPath, [path.join(root, 'cli/bin/dataops.mjs'), ...args], {
    env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: '', DATAOPS_URL: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!output.includes(secret), 'the client secret is never echoed');
  return { code, output };
}

test('real CLI configures a verified service profile, identifies it, and removes only the local copy', async () => {
  const dir = mkdtempSync(path.join(scratch, 'service-cli-'));
  const calls = [];
  let issued = 0;
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/oauth/token') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const form = new URLSearchParams(body);
        const valid = form.get('grant_type') === 'client_credentials'
          && form.get('client_id') === 'dataops-invoice-reader'
          && form.get('client_secret') === secret;
        if (!valid) {
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        issued += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          access_token: mintServiceJwt('dataops-invoice-reader', 'invoice:read'),
          token_type: 'Bearer', expires_in: 900, scope: 'invoice:read',
        }));
      });
      return;
    }
    const auth = request.headers.authorization || '';
    const ok = auth.startsWith('Bearer ') && auth.length > 40;
    response.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(ok ? principal : { error: 'Unauthorized' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const savedIssuer = process.env.DTC_OAUTH_ISSUER;
  process.env.DTC_OAUTH_ISSUER = url;
  try {
    const login = await cli(['login', '--service-token-stdin', '--url', url], dir, JSON.stringify({ clientId: 'dataops-invoice-reader', clientSecret: secret }));
    assert.equal(login.code, 0, login.output);
    const file = path.join(dir, 'credentials.json');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(store.defaultUrl, url);
    assert.equal(store.profiles[url].kind, 'service');
    assert.equal(store.profiles[url].clientId, 'dataops-invoice-reader');
    assert.equal(store.profiles[url].clientSecret, secret);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);

    // whoami mints a fresh token and presents the service principal.
    const me = await cli(['whoami'], dir);
    assert.equal(me.code, 0, me.output);
    assert.ok(me.output.includes('invoice-reader (invoice:read)'), me.output);
    assert.equal(issued, 2, 'one mint at login, one per whoami run');

    // Service credentials carry no revocable refresh family: logout only
    // forgets the local copy; server-side revocation is rotating the client.
    const before = calls.length;
    const out = await cli(['logout'], dir);
    assert.equal(out.code, 0, out.output);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profiles[url], undefined);
    assert.ok(calls.slice(before).every((call) => !call.includes('/oauth/revoke')), 'no revoke call for client credentials');

    // A refused client leaves no profile behind (exit code 3, auth).
    const failedDir = path.join(dir, 'failed');
    const bad = await cli(['login', '--service-token-stdin', '--url', url], failedDir, JSON.stringify({ clientId: 'other', clientSecret: 'nope' }));
    assert.equal(bad.code, 3, bad.output);
    assert.equal(existsSync(path.join(failedDir, 'credentials.json')), false);
    const insecure = await cli(['login', '--service-token-stdin', '--url', 'http://remote.example.test'], failedDir, JSON.stringify({ clientId: 'a', clientSecret: 'b' }));
    assert.equal(insecure.code, 1);
  } finally {
    if (savedIssuer === undefined) delete process.env.DTC_OAUTH_ISSUER; else process.env.DTC_OAUTH_ISSUER = savedIssuer;
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
