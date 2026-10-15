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
    DTC_CACHE_ROOT: createDocsCacheRoot('dakit-shell-device', {
      'content/processes/event-review.md': '---\ntitle: Event review\ntype: reference\nsummary: Synthetic process reference\n---\n# Event review\n\nCheck the agenda.\n',
    }),
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
for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`section jumps keep the document pinned in ${theme} at ${viewport.width}`, async ({ browser }) => {
    const { context, page } = await signedIn(browser, viewport);
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.goto('/bookkeeping?view=package');
    await expect(page.locator('#bookkeeping-package')).toBeVisible();
    await page.locator('#dk-live').evaluate(node => { node.textContent = '2 new notifications'; });
    await page.locator('#bookkeeping-vat-heading').evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => ({ height: document.scrollingElement.scrollHeight, viewport: innerHeight, top: scrollY })))
      .toEqual({ height: viewport.height, viewport: viewport.height, top: 0 });
    await expect(page.locator('.dk-shell')).toHaveJSProperty('offsetTop', 0);
    await context.close();
  });
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
  await page.goto('/device?code=bcdfghjk');
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

// Every interactive element under `selector` must be a 44px target in both
// dimensions. The hit area is what a finger lands on: a checkbox or radio is
// hit through its label (the input itself may be 16px or visually hidden);
// any other control is measured itself, not a label that stacks a caption
// over it.
async function touchControls(page, selector) {
  const measurements = await page.locator(selector).evaluate(root => {
    const interactive = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,label,'
      + '[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])';
    const hitArea = (node) => {
      if (node.matches('input[type="checkbox"],input[type="radio"]')) {
        return node.closest('label') || (node.id && root.ownerDocument.querySelector(`label[for="${node.id}"]`)) || node;
      }
      // A wrapping label that is only the field's box (the kit search field)
      // is hit anywhere; a label that stacks a caption over the control is not.
      const box = node.matches('input,select,textarea') && node.closest('label');
      if (box && box.getBoundingClientRect().height - node.getBoundingClientRect().height <= 4) return box;
      return node;
    };
    const targets = new Map();
    for (const node of root.querySelectorAll(interactive)) {
      // A label is a target only when it is a checkbox or radio's hit area.
      if (node.matches('label') && !(node.control && node.control.matches('input[type="checkbox"],input[type="radio"]'))) continue;
      const target = hitArea(node);
      if (!targets.has(target)) targets.set(target, node);
    }
    return [...targets].map(([target, node]) => {
      const style = getComputedStyle(target), box = target.getBoundingClientRect();
      return {
        name: `${node.tagName.toLowerCase()}.${String(node.className).trim().replace(/\s+/g, '.')} ${node.getAttribute('aria-label') || node.textContent.trim().slice(0, 40) || node.id}`,
        height: box.height, width: box.width,
        visible: target.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0
          && style.pointerEvents !== 'none',
      };
    }).filter(item => item.visible);
  });
  expect(measurements.length).toBeGreaterThan(0);
  const small = measurements.filter(item => item.height < 44 || item.width < 44)
    .map(item => `${item.name}: ${Math.round(item.width)}x${Math.round(item.height)}`);
  expect(small, `${selector}: targets under 44x44`).toEqual([]);
  return measurements.length;
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
    await touchControls(page, '#settings-menu');
    await page.locator('#work-bell-button').click();
    await expect(page.locator('#settings-menu')).toBeHidden();
    await expect(page.locator('#work-bell-panel')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#work-bell-button')).toBeFocused();
    const seeded = await context.request.post('/api/bookkeeping/transactions', { data: {
      transactionDate: new Date().toISOString().slice(0, 10), counterparty: 'Synthetic touch review', amount: '45.00', currency: 'EUR', description: 'Synthetic touch geometry', category: 'events',
    } });
    expect(seeded.ok()).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    for (const description of ['Synthetic overdue touch task', 'Synthetic touch task due today']) {
      const task = await context.request.post('/api/tasks', { data: { description, date: description.includes('overdue') ? '2020-01-01' : today, status: 'todo' } });
      expect(task.ok(), await task.text()).toBe(true);
    }
    // Pilot routes, plus the Docs Filters popover open: every interactive
    // element in main is measured, the Queue completion tick included.
    for (const [route, ready, open] of [
      ['/bookkeeping', '.bk-row'],
      ['/processes', '.ops-docs-tree-row'],
      ['/processes', '.ops-docs-tree-row', '#filters-section > summary'],
      ['/tasks', '.ops-queue-row .ops-queue-check'],
    ]) {
      await page.goto(route); await expect(page.locator(ready).first()).toBeVisible();
      if (open) { await page.locator(open).click(); await expect(page.locator('#filter-row')).toBeVisible(); }
      await expect(page.locator('#main-content')).toHaveCSS('overflow-y', 'auto');
      await expect(page.locator('#main-content')).toHaveCSS('padding-left', '16px');
      await expect(page.locator('#library-view')).toHaveCSS('overflow-y', 'visible');
      expect(await touchControls(page, '#main-content')).toBeGreaterThan(open ? 8 : 4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.route('**/work/api/auth/device/pending?**', route => route.fulfill({ json: {
      label: 'synthetic-machine', requestIp: '203.0.113.7', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    } }));
    await page.route('**/work/api/auth/device/approve', route => route.fulfill({ json: { status: 'approved' } }));
    await page.goto('/device?code=bcdfghjk');
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
  await page.goto('/device?code=bcdfghjk');
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

for (const theme of ['light', 'dark']) {
  test(`Queue uses workspace people by id and one urgency tint in ${theme}`, async ({ browser }) => {
    const { context, page } = await signedIn(browser, { width: 1440, height: 900 });
    const actorId = '00000000-0000-0000-0000-000000000001';
    const otherId = '00000000-0000-0000-0000-000000000002';
    const people = [
      { id: actorId, name: 'Alexey', email: 'actor@example.test' },
      { id: otherId, name: 'Alexeyette', email: 'other@example.test' },
    ];
    await page.route('**/api/users', route => route.fulfill({ json: { users: people } }));
    const created = [];
    for (const [description, assigneeId, status] of [
      ['Exact owner overdue task', actorId, 'todo'],
      ['Similar name overdue task', otherId, 'todo'],
      ['Blocked overdue task', actorId, 'waiting'],
    ]) {
      const response = await context.request.post('/work/api/tasks', { data: {
        description, assigneeId, status, date: '2020-01-01',
        ...(status === 'waiting' ? { waitingFor: 'Synthetic reply', followUpAt: '2020-01-01T09:00:00Z', comment: 'Synthetic waiting fixture' } : {}),
      } });
      expect(response.ok(), await response.text()).toBe(true);
      const payload = await response.json(); created.push(payload.task || payload);
    }
    await page.addInitScript(t => localStorage.setItem('dakit-theme', t), theme);
    // The signed-in operator here is neither fixture person, so Mine is
    // empty; the teammates are listed and filtered by id, never by name.
    await page.goto('/tasks');
    const filter = page.getByRole('combobox', { name: 'Filter queue by assignee' });
    await expect(filter).toHaveValue('me');
    await expect(filter.locator('optgroup option')).toHaveText(['Alexey (2)', 'Alexeyette (1)']);
    await filter.selectOption(actorId);
    await expect(page).toHaveURL(new RegExp(`/tasks\\?assignee=${actorId}$`));
    await page.locator('#settings-button').click();
    const scope = page.getByRole('radiogroup', { name: 'Viewing work for', exact: true });
    await expect(scope.getByRole('radio')).toHaveCount(2);
    await expect(scope.getByRole('radio', { name: /work for Alexeyette$/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ops-queue-row').filter({ hasText: 'Similar name overdue task' })).toHaveCount(0);
    const boxes = page.locator('.ops-queue-row[data-urgency="overdue"] .ops-queue-box');
    await expect(boxes).toHaveCount(2);
    const fills = await boxes.evaluateAll(nodes => nodes.map(node => ({ fill: getComputedStyle(node).backgroundColor, opacity: getComputedStyle(node).opacity })));
    expect(fills[0]).toEqual(fills[1]);
    expect(fills[0].opacity).toBe('1');
    for (const task of created) {
      const removed = await context.request.delete('/work/api/tasks/' + task.id, { data: { expectedVersion: task.version } });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
    await context.close();
  });
}
