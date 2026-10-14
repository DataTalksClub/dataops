const { test, expect } = require('@playwright/test');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: {
    SKIP_AUTH: 'false', WORK_ENGINE_AUTH_MODE: 'portal',
    AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
    AUTH_CLIENT_ID: 'synthetic-device-client', AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback', AUTH_LOGOUT_URL: 'http://127.0.0.1/',
    E2E_BROWSER_SESSION_USER_ID: 'synthetic-shell-operator', E2E_BROWSER_SESSION_USER_ROLE: 'admin',
    DTC_CACHE_ROOT: createDocsCacheRoot('dakit-shell-device'),
  } });
});
test.afterAll(async () => stopOwnedTestServer(server));
async function signedIn(browser, viewport) {
  const context = await browser.newContext({ baseURL: server.baseURL, viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/__e2e__/browser-session');
  await expect(page.locator('#account-identity')).toHaveAttribute('data-state', 'ready');
  return { context, page };
}
for (const theme of ['light', 'dark']) {
  test(`dakit shell keeps a working rail, menus and mobile drawer in ${theme}`, async ({ browser }) => {
    const { context, page } = await signedIn(browser, { width: 1440, height: 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(t => { document.documentElement.dataset.theme = t; localStorage.setItem('dakit-theme', t); }, theme);
    await page.locator('#sidebar-collapse-button').click();
    await expect(page.locator('.dk-shell')).toHaveAttribute('data-sidebar', 'collapsed');
    expect((await page.locator('#sidebar').boundingBox()).width).toBe(56);
    await expect(page.locator('[data-workspace-view="admin"]')).toBeVisible();
    await expect(page.locator('#settings-button')).toBeVisible();
    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-menu')).toBeFocused();
    const menuBox = await page.locator('#settings-menu').boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(64);
    await expect(page.locator('#settings-menu [data-workspace-view]')).toHaveCount(0);
    const themeSwitch = page.getByRole('switch', { name: 'Dark mode' });
    await themeSwitch.click();
    await expect(themeSwitch).toHaveAttribute('aria-checked', String(theme === 'light'));
    await expect(page.locator('#settings-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-button')).toBeFocused();
    await page.locator('.dk-search__rail').click();
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('.dk-shell')).toHaveAttribute('data-sidebar', 'expanded');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.dk-topbar #settings-button')).toHaveCount(1);
    await expect(page.locator('.dk-topbar #work-bell-button')).toHaveCount(1);
    await page.locator('#mobile-menu-button').click();
    await expect(page.locator('#sidebar')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#main-content')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-menu-button')).toBeFocused();
    await expect(page.locator('#sidebar')).not.toHaveAttribute('role', 'dialog');
    expect(errors).toEqual([]);
    await context.close();
  });
}
test('standalone device consent requires Continue, preserves overflow input, and gates different-network approval', async ({ browser }) => {
  const { context, page } = await signedIn(browser, { width: 390, height: 844 });
  let lookups = 0, decisions = 0;
  await page.route('**/work/api/auth/device/pending?**', route => {
    lookups++;
    return route.fulfill({ json: { label: '<untrusted machine>', requestIp: '203.0.113.7', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), same_network: false } });
  });
  await page.route('**/work/api/auth/device/approve', route => { decisions++; return route.fulfill({ json: { status: 'approved' } }); });
  await page.goto('/device?userCode=bcdfghjk');
  await expect(page.getByRole('heading', { name: 'Authorize a device', exact: true })).toBeFocused();
  await expect(page.locator('.dk-shell')).toHaveCount(0);
  expect(lookups).toBe(0);
  const input = page.getByLabel('Device code', { exact: true });
  await input.fill('bcdfghjkx');
  await expect(input).toHaveValue('BCDF-GHJK-X');
  await expect(page.getByRole('alert')).toContainText('extra character');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await input.fill('bcdfghjk'); await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Authorize this device?' })).toBeFocused();
  await expect(page.getByText('<untrusted machine>', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I started this login on that machine' }).check();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Device authorized' })).toBeFocused();
  expect(decisions).toBe(1);
  await context.close();
});
