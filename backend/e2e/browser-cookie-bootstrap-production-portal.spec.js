const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3018;
const BASE_URL = `http://localhost:${PORT}`;
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
let processHandle;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    (function poll() {
      const req = http.get(`${BASE_URL}/api/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => Date.now() > deadline
        ? reject(new Error('browser-cookie portal server timeout'))
        : setTimeout(poll, 250));
    })();
  });
}

test.describe('production portal browser-cookie bootstrap', () => {
  test.beforeAll(async () => {
    processHandle = spawn('npx', ['tsx', 'scripts/test-server.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'false',
        DATAOPS_DOCS_DOMAIN: '1',
        WORK_ENGINE_AUTH_MODE: 'portal',
        DTC_OFFLINE: '1',
        // Match the deployed artifact, where the separate source frontend is
        // absent and the packaged backend SPA is the fallback workspace.
        FRONTEND_ROOT: path.resolve(__dirname, '..', '.tmp', 'not-packaged-frontend'),
        AUTH_BASE_URL: 'https://auth.example.test',
        AUTH_ISSUER: 'https://issuer.example.test/pool',
        AUTH_CLIENT_ID: 'dataops-client',
        AUTH_CALLBACK_URL: `${BASE_URL}/auth/callback`,
        AUTH_LOGOUT_URL: `${BASE_URL}/`,
        E2E_BROWSER_SESSION_USER_ID: GRACE_ID,
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitForServer();
  });

  test.afterAll(() => {
    if (processHandle) {
      try { process.kill(-processHandle.pid, 'SIGTERM'); } catch {}
    }
  });

  test('loads the workspace from an HttpOnly cookie via /api/me without a browser bearer', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    const meResponse = page.waitForResponse((response) => response.url() === `${BASE_URL}/api/me`);

    await page.goto('/__e2e__/browser-session');
    const response = await meResponse;
    const requestHeaders = await response.request().allHeaders();

    expect(response.status()).toBe(200);
    expect(requestHeaders.authorization).toBeUndefined();
    expect(requestHeaders.cookie).toContain('dataops_session=');
    await expect(page).toHaveURL(`${BASE_URL}/#/`);
    await expect(page.getByRole('heading', { name: 'Active Bundles' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Daily Queue' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

    const browserState = await page.evaluate(() => ({
      token: localStorage.getItem('dataops_token'),
      user: localStorage.getItem('dataops_user'),
      legacyToken: localStorage.getItem('datatasks_token'),
      legacyUser: localStorage.getItem('datatasks_user'),
      authMode: document.querySelector('meta[name="dataops-auth-mode"]')?.content,
    }));
    expect(browserState).toEqual({ token: null, user: null, legacyToken: null, legacyUser: null, authMode: 'browser-cookie' });
    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'dataops_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.httpOnly).toBe(true);
    await context.close();
  });

  test('keeps signed-out production navigation on the backend/shared login path', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const root = await context.request.get('/', { maxRedirects: 0 });
    expect(root.status()).toBe(302);
    expect(root.headers().location).toBe('/login');
    expect(await root.text()).not.toContain('Sign in');

    const login = await context.request.get('/login', { maxRedirects: 0 });
    expect(login.status()).toBe(302);
    expect(new URL(login.headers().location).origin).toBe('https://auth.example.test');
    expect(await login.text()).not.toContain('password');
    await context.close();
  });
});
