const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3017;
const BASE_URL = `http://127.0.0.1:${PORT}`;
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
        ? reject(new Error('auth error portal server timeout'))
        : setTimeout(poll, 250));
    })();
  });
}

test.describe('production portal authentication error', () => {
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
        FRONTEND_ROOT: path.resolve(__dirname, '..', '..', 'frontend'),
        AUTH_BASE_URL: 'https://auth.example.test',
        AUTH_ISSUER: 'https://issuer.example.test/pool',
        AUTH_CLIENT_ID: 'dataops-client',
        AUTH_CALLBACK_URL: `${BASE_URL}/auth/callback`,
        AUTH_LOGOUT_URL: `${BASE_URL}/`,
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

  test('renders a clean, branded, keyboard-accessible error state', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    const response = await page.goto('/auth/error');

    expect(page.url()).toBe(`${BASE_URL}/auth/error`);
    expect(response.status()).toBe(403);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page).toHaveTitle('Sign-in issue · DataOps');
    await expect(page.getByRole('heading', { name: 'We couldn’t sign you in' })).toBeVisible();
    await expect(page.getByLabel('DataOps by DataTalks.Club')).toBeVisible();
    const retry = page.getByRole('link', { name: 'Try signing in again' });
    await expect(retry).toHaveAttribute('href', '/login');
    await expect(page.locator('#auth-error-title')).toBeFocused();
    expect(await page.locator('body').textContent()).not.toMatch(/code=|state=|token|verifier|session|access_denied/i);

    await page.screenshot({ path: '.tmp/signed-out-auth-error.png', fullPage: true });
    await context.close();
  });
});
