const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
let server;

test.describe('production portal browser-cookie bootstrap', () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        SKIP_AUTH: 'false',
        WORK_ENGINE_AUTH_MODE: 'portal',
        AUTH_BASE_URL: 'https://auth.example.test',
        AUTH_ISSUER: 'https://issuer.example.test/pool',
        AUTH_CLIENT_ID: 'dataops-client',
        // The final loopback port is discovered only after the child binds
        // port zero, and these journeys never perform an OAuth round trip.
        AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
        AUTH_LOGOUT_URL: 'http://127.0.0.1/',
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-190-docs-cache/browser-cookie-bootstrap-production-portal'),
        E2E_BROWSER_SESSION_USER_ID: GRACE_ID,
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('loads the workspace from an HttpOnly cookie via /api/me without a browser bearer', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const page = await context.newPage();
    await page.route('**/docs', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'docs intentionally unavailable for auth bootstrap test' }),
    }));
    const meResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/work/api/me');

    await page.goto('/__e2e__/browser-session');
    const response = await meResponse;
    const requestHeaders = await response.request().allHeaders();

    expect(response.status()).toBe(200);
    expect(requestHeaders.authorization).toBeUndefined();
    expect(requestHeaders.cookie).toContain('dataops_session=');
    await expect(page).toHaveURL(`${server.baseURL}/#/`);
    await expect(page.getByRole('heading', { name: 'Today', exact: true }).first()).toBeVisible();
    const quickActions = page.locator('.home-quick-actions[aria-label="Quick actions"]');
    const creationActions = quickActions.getByRole('button');
    await expect(creationActions).toHaveCount(2);
    for (const action of await creationActions.all()) await expect(action).toBeEnabled();
    await creationActions.first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await creationActions.last().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

    const browserState = await page.evaluate(() => ({
      token: localStorage.getItem('dataops_token'),
      user: localStorage.getItem('dataops_user'),
      legacyToken: localStorage.getItem('datatasks_token'),
      legacyUser: localStorage.getItem('datatasks_user'),
    }));
    expect(browserState).toEqual({ token: null, user: null, legacyToken: null, legacyUser: null });
    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'dataops_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.httpOnly).toBe(true);
    await context.close();
  });

  test('keeps signed-out production navigation on the backend/shared login path', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const root = await context.request.get('/', { maxRedirects: 0 });
    assertOwnedServerResponse(server, root, 'signed-out root');
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
