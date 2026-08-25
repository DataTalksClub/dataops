const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

let server;

test.describe('production portal authentication error', () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        SKIP_AUTH: 'false',
        WORK_ENGINE_AUTH_MODE: 'portal',
        AUTH_BASE_URL: 'https://auth.example.test',
        AUTH_ISSUER: 'https://issuer.example.test/pool',
        AUTH_CLIENT_ID: 'dataops-client',
        AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
        AUTH_LOGOUT_URL: 'http://127.0.0.1/',
        DTC_CACHE_ROOT: createDocsCacheRoot(
          'issue-190-docs-cache/auth-error-production-portal',
        ),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('renders a clean, branded, keyboard-accessible error state', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const page = await context.newPage();
    const response = await page.goto('/auth/error');
    assertOwnedServerResponse(server, response, 'authentication-error browser session');

    expect(page.url()).toBe(`${server.baseURL}/auth/error`);
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
