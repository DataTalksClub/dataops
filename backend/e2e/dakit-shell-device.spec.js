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
async function signedIn(browser, viewport, options = {}) {
  const context = await browser.newContext({ baseURL: server.baseURL, viewport, reducedMotion: 'reduce', isMobile: viewport.width <= 820, hasTouch: viewport.width <= 820, ...options });
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
    const fontToken = name => page.evaluate(token => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name);
    await expect(page.locator('h1.dk-page-header__title')).toHaveCSS('font-size', await fontToken('--dk-text-xl'));
    await page.locator('#sidebar-collapse-button').click();
    await expect(page.locator('.dk-shell')).toHaveAttribute('data-sidebar', 'collapsed');
    expect((await page.locator('#sidebar').boundingBox()).width).toBe(56);
    await page.locator('#sidebar a[href="/tasks"]').hover();
    await expect(page.locator('.dk-tooltip')).toHaveText('Queue');
    await expect(page.locator('.dk-tooltip')).toHaveCSS('font-size', await fontToken('--dk-text-sm'));
    await expect(page.locator('[data-workspace-view="admin"]')).toBeVisible();
    await expect(page.locator('#settings-button')).toBeVisible();
    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-menu')).toBeFocused();
    const menuBox = await page.locator('#settings-menu').boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(64);
    await expect(page.locator('#settings-menu [data-workspace-view]')).toHaveCount(0);
    for (const name of ['Dark mode', 'Keyboard shortcuts', 'Help', 'CLI sessions', 'Sign out']) {
      const icon = page.locator('#settings-menu .dk-menu__item').filter({ hasText: name }).locator('svg');
      await expect(icon).toHaveCount(1);
      expect((await icon.boundingBox()).width).toBe(16);
    }
    const themeSwitch = page.getByRole('switch', { name: 'Dark mode' });
    await themeSwitch.click();
    await expect(themeSwitch).toHaveAttribute('aria-checked', String(theme === 'light'));
    await expect(page.locator('#settings-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-button')).toBeFocused();
    await page.locator('#work-bell-button').click();
    await expect(page.locator('#work-bell-title')).toHaveCSS('font-size', await fontToken('--dk-text-md'));
    await page.keyboard.press('Escape');
    await page.locator('.dk-search__rail').click();
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('.dk-shell')).toHaveAttribute('data-sidebar', 'expanded');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#mobile-title')).toHaveText('DataOps');
    await expect(page.getByRole('heading', { name: 'Work Queue', exact: true })).toBeVisible();
    await expect(page.locator('.dk-topbar #settings-button')).toHaveCount(1);
    await expect(page.locator('.dk-topbar #work-bell-button')).toHaveCount(1);
    await page.locator('#mobile-menu-button').click();
    await expect(page.locator('#sidebar')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#main-content')).toHaveAttribute('inert', '');
    const destination = page.locator('#sidebar a[href="/tasks"]');
    await expect(destination).toBeVisible();
    await expect(destination).toHaveCSS('opacity', '1');
    await expect(destination).toHaveCSS('visibility', 'visible');
    const destinationBox = await destination.boundingBox();
    expect(destinationBox.width).toBeGreaterThan(0);
    expect(destinationBox.height).toBeGreaterThan(0);
    expect(destinationBox.x).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#sidebar .dk-brand__name')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
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
  await expect(page.locator('.dk-auth-page__bar .dk-brand')).toHaveCSS('text-decoration-line', 'none');
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
  await expect(page.locator('.dk-auth-card__foot a')).toHaveText('Switch account');
  await expect(page.getByText('<untrusted machine>', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Authorize', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I started this login on that machine' }).check();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Device authorized' })).toBeFocused();
  expect(decisions).toBe(1);
  await context.close();
});

async function touchControls(page, selector) {
  const measurements = await page.locator(selector).evaluate(root => [...root.querySelectorAll('button,a,input,select,textarea,summary')].map(node => {
    // A field wrapped in its <label> is hit anywhere in the label.
    const target = node.matches('input,select,textarea') ? node.closest('label') || node : node;
    const style = getComputedStyle(target), box = target.getBoundingClientRect();
    return { name: `${node.tagName.toLowerCase()}.${node.className} ${node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40) || node.id}`, height: box.height,
      width: box.width, visible: style.display !== 'none' && style.visibility === 'visible' && box.width > 0 && box.height > 0 };
  }).filter(item => item.visible));
  expect(measurements.length).toBeGreaterThan(0);
  for (const item of measurements) expect(item.height, `${item.name}: touch height`).toBeGreaterThanOrEqual(44);
}
for (const theme of ['light', 'dark']) {
  test(`touch controls, main scrolling, drawer trapping and copy feedback in ${theme}`, async ({ browser }) => {
    const { context, page } = await signedIn(browser, { width: 390, height: 844 }, { permissions: ['clipboard-read', 'clipboard-write'] });
    await page.evaluate(t => { localStorage.setItem('dakit-theme', t); document.documentElement.dataset.theme = t; }, theme);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('#mobile-menu-button').click();
    await expect(page.locator('#sidebar')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#sidebar [aria-current="page"]')).toBeFocused();
    await page.locator('.dk-sidebar__nav').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const users = page.locator('#sidebar a[href="/users"]');
    await expect(users).toBeInViewport();
    await expect(users).toBeVisible();
    await users.focus(); await expect(users).toBeFocused(); await page.keyboard.press('Tab');
    await expect(page.locator('#sidebar .dk-brand')).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(users).toBeFocused();
    await touchControls(page, '#sidebar');
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-menu-button')).toBeFocused();
    await touchControls(page, '.dk-topbar');
    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-menu')).toBeVisible();
    await page.locator('#work-bell-button').click();
    await expect(page.locator('#settings-menu')).toBeHidden();
    await expect(page.locator('#work-bell-panel')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#work-bell-button')).toBeFocused();
    const seeded = await context.request.post('/api/bookkeeping/transactions', { data: {
      transactionDate: new Date().toISOString().slice(0, 10), counterparty: 'Synthetic touch review', amount: '45.00', currency: 'EUR', description: 'Synthetic touch geometry', category: 'events',
    } });
    expect(seeded.ok()).toBe(true);
    for (const [route, ready] of [['/bookkeeping', '.bookkeeping-ledger tbody tr'], ['/processes', '.ops-docs-create'], ['/tasks', '.ops-work-queue']]) {
      await page.goto(route); await expect(page.locator(ready).first()).toBeVisible();
      await expect(page.locator('#main-content')).toHaveCSS('overflow-y', 'auto');
      await expect(page.locator('#main-content')).toHaveCSS('padding-left', '16px');
      await expect(page.locator('#library-view')).toHaveCSS('overflow-y', 'visible');
      await touchControls(page, '#main-content');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.route('**/work/api/auth/device/pending?**', route => route.fulfill({ json: {
      label: 'synthetic-machine', requestIp: '203.0.113.7', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    } }));
    await page.route('**/work/api/auth/device/approve', route => route.fulfill({ json: { status: 'approved' } }));
    await page.goto('/device?userCode=bcdfghjk');
    await expect(page.getByLabel('Device code', { exact: true })).toHaveValue('BCDF-GHJK');
    await expect(page).toHaveURL(/\/device$/);
    await touchControls(page, '.dk-auth-page');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Authorize this device?' })).toBeFocused();
    await touchControls(page, '.dk-auth-page');
    await page.getByRole('button', { name: 'Authorize', exact: true }).click();
    await expect(page.locator('.dk-code-block pre code')).toHaveText('dataops logout');
    await touchControls(page, '.dk-auth-page');
    const copy = page.locator('.dk-code-block [data-dk-copy]');
    await expect(copy).toHaveAccessibleName('Copy');
    const initialBox = await copy.boundingBox();
    await copy.click();
    await expect(copy).toHaveText('Copied');
    const feedbackBox = await copy.boundingBox();
    await expect(copy).toHaveText('Copy');
    expect((await copy.boundingBox()).width).toBe(feedbackBox.width);
    expect(feedbackBox.width).toBe(initialBox.width);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('dataops logout');
    await context.close();
  });
}

test('long identity and machine labels wrap on touch without clipping Switch account', async ({ browser }) => {
  const { context, page } = await signedIn(browser, { width: 390, height: 844 });
  const email = 'operations.long-address.for-wrapping-checks@engineering.datatalks.club';
  await page.route('**/api/me', route => route.fulfill({ json: { user: { email, name: 'Synthetic Operator', role: 'admin' } } }));
  await page.route('**/work/api/auth/device/pending?**', route => route.fulfill({ json: {
    label: 'build-runner-with-a-very-long-unbroken-hostname-0123456789abcdef.internal', requestIp: '203.0.113.7',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
  } }));
  await page.goto('/device?userCode=bcdfghjk');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Authorize this device?' })).toBeFocused();
  await expect(page.locator('.dk-auth-page__identity')).toContainText(email);
  const layout = await page.evaluate(() => {
    const identity = document.querySelector('.dk-auth-page__identity'), link = identity.querySelector('a');
    const card = document.querySelector('.dk-auth-card');
    return { identityClipped: identity.scrollWidth > identity.clientWidth, linkLines: link.getClientRects().length,
      linkRight: link.getBoundingClientRect().right, cardOverflow: card.scrollWidth > card.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth, width: innerWidth,
      brandClipped: (n => n.scrollWidth > n.clientWidth)(document.querySelector('.dk-auth-page__bar .dk-brand__name')),
      separated: identity.textContent.includes(' · ') };
  });
  expect(layout.identityClipped).toBe(false);
  expect(layout.linkLines).toBe(1);
  expect(layout.linkRight).toBeLessThanOrEqual(layout.width);
  expect(layout.cardOverflow).toBe(false);
  expect(layout.pageOverflow).toBe(false);
  expect(layout.brandClipped).toBe(false);
  expect(layout.separated).toBe(true);
  await touchControls(page, '.dk-auth-page');
  await context.close();
});

test('coarse-pointer desktop keeps the 56px rail with 44px controls', async ({ browser }) => {
  const { context, page } = await signedIn(browser, { width: 1280, height: 800 }, { hasTouch: true });
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await touchControls(page, '#sidebar');
  await page.locator('#sidebar-collapse-button').click();
  await expect(page.locator('.dk-shell')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect.poll(() => page.locator('#sidebar').evaluate(node => node.getBoundingClientRect().width)).toBe(56);
  await touchControls(page, '#sidebar');
  await context.close();
});
