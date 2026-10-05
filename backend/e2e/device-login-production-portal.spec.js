const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer, assertOwnedServerResponse } = require('./helpers/isolated-capability-server');

let server;
const root = path.resolve(__dirname, '../..');
const tmp = path.join(root, '.tmp', 'issue-248-cli');
const shots = path.join(root, '.tmp', 'screenshots');
const children = new Set();

function cli(args, configDir, options = {}) {
  // Observe actual HTTP polling without altering requests or responses, or
  // sending device/bearer secrets to test output.
  const observer = `const original = globalThis.fetch; globalThis.fetch = async (...args) => {
    const response = await original(...args);
    if (['/api/auth/device/token', '/work/api/auth/device/token'].includes(new URL(String(args[0])).pathname)) {
      const error = (await response.clone().json()).error || '';
      process.send?.({ status: response.status, error });
      if (${Boolean(options.expireOnPending)} && error === 'authorization_pending') {
        const now = Date.now; Date.now = () => now() + 601000;
      }
    }
    return response;
  };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(observer)}`,
    path.join(root, 'cli/bin/dataops.mjs'), ...args, '--url', options.url || server.baseURL], {
    cwd: root, env: { ...process.env, DATAOPS_CONFIG_DIR: configDir, DATAOPS_URL: '', DATAOPS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  const result = { output: '', errors: '', child, polls: [] };
  child.on('message', message => { result.polls.push(message); });
  child.stdout.on('data', chunk => { result.output += String(chunk); });
  child.stderr.on('data', chunk => { result.errors += String(chunk); });
  result.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve(code); });
  });
  return result;
}

async function command(args, configDir) {
  const run = cli(args, configDir);
  expect(await run.done).toBe(0);
  return run.output;
}

async function signedInPage(browser) {
  const context = await browser.newContext({ baseURL: server.baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/__e2e__/browser-session');
  await expect(page.getByRole('heading', { name: 'Today', exact: true }).first()).toBeVisible();
  return { context, page };
}

async function showGrant(page, run) {
  await expect.poll(() => Boolean(run.output.match(/Confirm this code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/))).toBe(true);
  const code = run.output.match(/Confirm this code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/)[1];
  await page.goto(`${server.baseURL}/#/device?userCode=${encodeURIComponent(code)}`);
  await expect(page.getByRole('heading', { name: 'Authorize this machine?' })).toBeVisible();
  await expect(page.getByText('Synthetic device journey', { exact: true })).toBeVisible();
  return code;
}

async function screenshot(page, name) {
  // Hide the actual generated pairing secret while retaining the rendered state.
  await page.screenshot({ path: path.join(shots, name), fullPage: true, mask: [page.getByLabel('Device code')] });
}

test.describe('real CLI device login through the configured production portal', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    server = await startOwnedTestServer({ environment: {
      SKIP_AUTH: 'false', WORK_ENGINE_AUTH_MODE: 'portal',
      AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
      AUTH_CLIENT_ID: 'synthetic-device-client', AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
      AUTH_LOGOUT_URL: 'http://127.0.0.1/',
      DTC_CACHE_ROOT: createDocsCacheRoot('issue-248-docs-cache/device-login'),
      E2E_BROWSER_SESSION_USER_ID: 'synthetic-device-operator', E2E_BROWSER_SESSION_USER_ROLE: 'operator',
    } });
  });
  test.afterAll(async () => {
    for (const child of children) child.kill('SIGTERM');
    await stopOwnedTestServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('starts anonymously, waits for browser approval, stores a secure URL profile, and uses/revokes its bearer', async ({ browser }) => {
    const configDir = path.join(tmp, 'approved');
    const credentials = path.join(configDir, 'credentials.json');
    const run = cli(['login', '--label', 'Synthetic device journey'], configDir);
    const { context, page } = await signedInPage(browser);
    try {
      const code = await showGrant(page, run);
      await expect.poll(() => run.polls.some(poll => poll.status === 400 && poll.error === 'authorization_pending'), { timeout: 10_000 }).toBe(true);
      expect(fs.existsSync(credentials)).toBe(false);
      const anonymous = await browser.newContext({ baseURL: server.baseURL, storageState: { cookies: [], origins: [] } });
      try {
        const approval = await anonymous.request.post('/work/api/auth/device/approve', { data: { userCode: code } });
        assertOwnedServerResponse(server, approval);
        expect(approval.status()).toBe(401);
      } finally { await anonymous.close(); }
      await screenshot(page, 'issue-248-device-pending.png');
      await page.getByRole('button', { name: 'Authorize', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Device authorized', exact: true })).toBeVisible();
      await screenshot(page, 'issue-248-device-approved.png');
      expect(await run.done).toBe(0);
      const store = JSON.parse(fs.readFileSync(credentials, 'utf8'));
      const profile = store.profiles[server.baseURL];
      expect(profile.user.id).toBe('synthetic-device-operator');
      expect(profile.token).toMatch(/^dops_[0-9a-f]{64}$/);
      expect(fs.statSync(configDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(credentials).mode & 0o777).toBe(0o600);
      expect((run.output + run.errors).includes(profile.token)).toBe(false);
      // Another URL's profile must survive storage and revoke unchanged.
      const other = { token: 'synthetic-other-profile', label: 'Other portal' };
      store.profiles['https://other.example.test'] = other;
      fs.writeFileSync(credentials, JSON.stringify(store), { mode: 0o600 });
      const whoami = await command(['whoami', '--json'], configDir);
      expect(JSON.parse(whoami).user.id).toBe('synthetic-device-operator');
      const tasks = await context.request.get('/api/tasks?date=2026-10-05', { headers: { authorization: `Bearer ${profile.token}` } });
      expect(tasks.status()).toBe(200);
      const noCookie = await browser.newContext({ baseURL: server.baseURL, storageState: { cookies: [], origins: [] } });
      try {
        expect((await noCookie.request.get('/api/tasks?date=2026-10-05', { headers: { authorization: `Bearer ${profile.token}` } })).status()).toBe(200);
        expect((await noCookie.request.get('/api/me', { headers: { authorization: 'Bearer invalid' } })).status()).toBe(401);
      } finally { await noCookie.close(); }
      expect((await command(['tokens', 'list'], configDir))).toContain('Synthetic device journey');
      await command(['logout'], configDir);
      const final = JSON.parse(fs.readFileSync(credentials, 'utf8'));
      expect(final.profiles[server.baseURL]).toBeUndefined();
      expect(final.profiles['https://other.example.test']).toEqual(other);
      // The signed-in browser has an independent cookie, so check revocation without it.
      const request = await browser.newContext({ baseURL: server.baseURL, storageState: { cookies: [], origins: [] } });
      try { expect((await request.request.get('/api/me', { headers: { authorization: `Bearer ${profile.token}` } })).status()).toBe(401); }
      finally { await request.close(); }
    } finally { await context.close(); }
  });

  test('denial in the real browser ends CLI polling without storing a profile', async ({ browser }) => {
    const configDir = path.join(tmp, 'denied');
    const run = cli(['login', '--label', 'Synthetic device journey'], configDir);
    const { context, page } = await signedInPage(browser);
    try {
      await showGrant(page, run);
      await page.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Device denied', exact: true })).toBeVisible();
      await screenshot(page, 'issue-248-device-denied.png');
      expect(await run.done).toBe(1);
      expect(run.output + run.errors).toContain('login was denied');
      expect(fs.existsSync(path.join(configDir, 'credentials.json'))).toBe(false);
    } finally { await context.close(); }
  });

  test('client deadline expiry and rejected login do not save credentials', async () => {
    const expiredDir = path.join(tmp, 'expired');
    // Only the client clock advances after a real pending response; neither
    // grant TTL nor the server response is changed.
    const expired = cli(['login', '--label', 'Synthetic deadline journey'], expiredDir, { expireOnPending: true });
    expect(await expired.done).toBe(1);
    expect(expired.polls).toContainEqual({ status: 400, error: 'authorization_pending' });
    expect(expired.errors).toContain('code expired before it was confirmed');
    expect(fs.existsSync(path.join(expiredDir, 'credentials.json'))).toBe(false);
    const failedDir = path.join(tmp, 'failed');
    const failed = cli(['login'], failedDir, { url: `${server.baseURL}/api` });
    expect(await failed.done).toBe(1);
    expect(failed.errors).toContain('Unauthorized');
    expect(fs.existsSync(path.join(failedDir, 'credentials.json'))).toBe(false);
  });
});
