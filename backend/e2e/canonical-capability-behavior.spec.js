const { test, expect } = require('@playwright/test');
const { recordCapabilityEvidence } = require('./helpers/capability-evidence');
const {
  BERLIN_MIDNIGHT_BOUNDARY_INSTANT,
  BERLIN_TIME_ZONE,
  berlinBusinessDate,
  installBerlinBoundaryClock,
} = require('./helpers/business-date');
const {
  assertOwnedServerResponse,
  startIsolatedCapabilityServer,
  stopIsolatedCapabilityServer,
} = require('./helpers/isolated-capability-server');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp', 'issue-159-capability-behavior');
const ISSUE_196_SCREENSHOTS = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-196');
const ISSUE_193_SCREENSHOTS = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-193');
const ISSUE_200_SCREENSHOTS = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-200');
const BOUNDARY_OPERATOR_DATE = berlinBusinessDate(BERLIN_MIDNIGHT_BOUNDARY_INSTANT);
const ADMIN_ID = '15900000-0000-4000-8000-000000000011';
const OPERATOR_ID = '15900000-0000-4000-8000-000000000012';
const servers = {
  admin: { userId: ADMIN_ID, role: 'admin' },
  operator: { userId: OPERATOR_ID, role: 'operator' },
  session: { userId: '15900000-0000-4000-8000-000000000013', role: 'admin' },
  disabled: { userId: '15900000-0000-4000-8000-000000000014', role: 'admin', disabled: true },
  expired: { userId: '15900000-0000-4000-8000-000000000015', role: 'admin', sessionLifetimeSeconds: '-1' },
  noMailingConfig: { userId: '15900000-0000-4000-8000-000000000016', role: 'admin', noMailingConfig: true },
  emptyDocs: { userId: '15900000-0000-4000-8000-000000000018', role: 'admin', noSyntheticDocs: true },
  qualityAdmin: {
    userId: '15900000-0000-4000-8000-000000000019',
    role: 'admin',
    qualityFindings: true,
  },
};

const syntheticSop = `---
id: sop.synthetic.capability
aliases: []
title: Synthetic Capability Procedure
summary: Public-safe procedure used only by browser behavior tests.
doc_type: sop
schema_version: 1
systems:
  - dataops
tags:
  - synthetic
---

# Synthetic Capability Procedure

<!-- sop-section-start: summary -->
## Summary
Exercise a public-safe retained portal surface.
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
Use synthetic records only.
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
<!-- sop-step-start id=1 systems="dataops" -->
1. Verify the synthetic capability.
<!-- sop-step-end -->
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
The visible state is reloadable.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
Retry the local request.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
None.
<!-- sop-section-end -->
`;

function syntheticQualitySop(label) {
  return syntheticSop
    .replace(
      'id: sop.synthetic.capability',
      `id: sop.synthetic.quality.${label}`,
    )
    .replace(
      'title: Synthetic Capability Procedure',
      `title: Synthetic Quality Procedure ${label}`,
    )
    .replace(
      '<!-- sop-step-start id=1 systems="dataops" -->',
      '<!-- sop-step-start id=1 systems="dataops" action="frobnicate" -->',
    );
}

const syntheticQualityDocuments = [
  ['quality-alpha.md', syntheticQualitySop('alpha')],
  ['quality-beta.md', syntheticQualitySop('beta')],
];

function baseUrl(server) {
  return `http://127.0.0.1:${server.port}`;
}

async function startServer(server) {
  const { noSyntheticDocs } = server;
  await startIsolatedCapabilityServer(Object.assign(server, {
    documents: server.noSyntheticDocs ? [] : [
      ['capability.md', syntheticSop],
      ...(server.qualityFindings ? syntheticQualityDocuments : []),
    ],
  }), TMP_ROOT);
}

async function stopServer(server) {
  await stopIsolatedCapabilityServer(server);
}

async function portalContext(browser, server, options = {}) {
  const context = await browser.newContext({
    baseURL: baseUrl(server),
    timezoneId: BERLIN_TIME_ZONE,
    ...options,
  });
  const response = await context.request.get('/__e2e__/browser-session');
  expect(response.status()).toBe(200);
  assertOwnedServerResponse(server, response, 'capability browser session');
  return context;
}

async function portalPage(browser, server = servers.admin) {
  const context = await portalContext(browser, server);
  const page = await context.newPage();
  await page.goto('/#/');
  await expect(page.locator('#library-title')).toHaveText('Home');
  return { context, page };
}

async function json(response) {
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function setFaults(request, faults) {
  const response = await request.post('/__e2e__/route-faults', { data: { faults } });
  expect(response.ok()).toBe(true);
}

async function clearFaults(request) {
  const response = await request.delete('/__e2e__/route-faults');
  expect(response.ok()).toBe(true);
}

async function expectStackedQualityEmptyState(page) {
  const state = page.locator('.ops-quality-list > .ops-honest-state');
  fs.mkdirSync(ISSUE_193_SCREENSHOTS, { recursive: true });
  await expect(state).toHaveCount(1);
  await expect(state.locator('> strong')).toHaveText('No findings match filters');
  await expect(state.locator('> span')).toHaveText(
    'Change filters to inspect other process quality findings.',
  );

  const layout = await state.evaluate((element) => {
    const label = element.querySelector(':scope > strong');
    const guidance = element.querySelector(':scope > span');
    const panel = element.closest('.ops-quality-drilldown');
    const labelRect = label.getBoundingClientRect();
    const guidanceRect = guidance.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      display: style.display,
      rowGap: Number.parseFloat(style.rowGap),
      visualGap: guidanceRect.top - labelRect.bottom,
      labelOverlapsGuidance: guidanceRect.top < labelRect.bottom,
      pageOverflow: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - window.innerWidth,
      stateOverflow: element.scrollWidth - element.clientWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      fitsPanelHorizontally:
        labelRect.left >= panelRect.left - 0.5
        && guidanceRect.left >= panelRect.left - 0.5
        && labelRect.right <= panelRect.right + 0.5
        && guidanceRect.right <= panelRect.right + 0.5,
    };
  });

  expect(layout.display).toBe('grid');
  expect(layout.rowGap).toBeGreaterThanOrEqual(4);
  expect(layout.visualGap).toBeGreaterThanOrEqual(4);
  expect(layout.labelOverlapsGuidance).toBe(false);
  expect(layout.pageOverflow).toBeLessThanOrEqual(0);
  expect(layout.stateOverflow).toBeLessThanOrEqual(0);
  expect(layout.panelOverflow).toBeLessThanOrEqual(0);
  expect(layout.fitsPanelHorizontally).toBe(true);

  await page.screenshot({
    path: path.join(
      ISSUE_193_SCREENSHOTS,
      page.viewportSize()?.width === 390 ? 'mobile.png' : 'desktop.png',
    ),
    animations: 'disabled',
    ...(page.viewportSize()?.width === 390 ? { fullPage: true } : {}),
  });
}

function observeBrowserErrors(page) {
  const entries = [];
  page.on('pageerror', (error) => entries.push({
    kind: 'pageerror',
    url: page.url(),
    message: error.message,
  }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    entries.push({
      kind: 'console',
      url: message.location()?.url || page.url(),
      message: message.text(),
    });
  });
  page.on('requestfailed', (request) => entries.push({
    kind: 'requestfailed',
    url: request.url(),
    failure: request.failure()?.errorText || 'unknown',
  }));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    entries.push({
      kind: 'response',
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    });
  });
  return entries;
}

function expectOnlyDeliberateCatalogFailures(entries) {
  const failures = entries.filter((entry) => entry.kind === 'response'
    && entry.method === 'GET'
    && new URL(entry.url).pathname === '/docs'
    && !new URL(entry.url).searchParams.has('path'));
  const failureUrls = new Set(failures.map((entry) => entry.url));
  const unexpected = entries.filter((entry) => {
    if (entry.kind === 'response') return false;
    if (entry.kind === 'console' && failureUrls.has(entry.url)) return false;
    return true;
  }).map((entry) => `${entry.kind}: ${entry.message || entry.failure || entry.url}`);
  expect(unexpected).toEqual([]);
  expect(failures.length).toBeGreaterThan(0);
  expect(failures.every((entry) => entry.status === 503)).toBe(true);
}

async function captureIssue200Screenshot(page, state) {
  fs.mkdirSync(ISSUE_200_SCREENSHOTS, { recursive: true });
  const viewport = page.viewportSize();
  const dimensions = `${viewport.width}x${viewport.height}`;
  const prefix = viewport.width === 390 ? 'mobile' : 'desktop';
  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    pageOverflow: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - document.documentElement.clientWidth,
    surfaceOverflow: document.querySelector('.ops-surface-docs')
      ? document.querySelector('.ops-surface-docs').scrollWidth
        - document.querySelector('.ops-surface-docs').clientWidth
      : 0,
  }));
  expect(layout.pageOverflow).toBeLessThanOrEqual(0);
  expect(layout.surfaceOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: path.join(ISSUE_200_SCREENSHOTS, `${prefix}-${state}-${dimensions}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

async function captureIssue200State(page, state, readyLocator) {
  await expect(readyLocator).toBeVisible();
  await captureIssue200Screenshot(page, state);
}

async function openMobileProcessDocs(page) {
  await page.locator('#mobile-menu-button').click();
  const sidebar = page.locator('#sidebar');
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: 'Process Docs', exact: true }).click();
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(page.locator('#sidebar-scrim')).toBeHidden();
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function freshHomeWork(page) {
  const exact = (response, predicate) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && predicate(url);
  };
  return Promise.all([
    page.waitForResponse((response) => exact(response, (url) => url.pathname === '/work/api/tasks' && url.searchParams.has('date'))),
    page.waitForResponse((response) => exact(response, (url) => url.pathname === '/work/api/tasks' && url.searchParams.get('status') === 'waiting')),
    page.waitForResponse((response) => exact(response, (url) => url.pathname === '/work/api/cards' && url.searchParams.has('limit'))),
  ]);
}

test.describe('issue 159 retained canonical capability behavior', () => {
  test.beforeEach(async () => {
    await Promise.all(Object.values(servers).map(stopServer));
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    await Promise.all(Object.values(servers).map(startServer));
  });

  test.afterAll(async () => {
    await Promise.all(Object.values(servers).map(stopServer));
  });

  test('session and Settings enforce real cookie roles, denial, focus, close, and logout', async ({ browser }, testInfo) => {
    const { context, page } = await portalPage(browser, servers.session);
    const me = await context.request.get('/work/api/me');
    expect(me.status()).toBe(200);
    expect((await json(me)).user.role).toBe('admin');
    expect(await page.evaluate(() => ({ token: localStorage.getItem('dataops_token'), user: localStorage.getItem('dataops_user') })))
      .toEqual({ token: null, user: null });
    const cookie = (await context.cookies()).find((item) => item.name === 'dataops_session');
    expect(cookie).toMatchObject({ httpOnly: true });

    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-menu')).toBeVisible();
    await expect(page.locator('#settings-menu-close')).toBeFocused();
    await expect(page.locator('#settings-menu')).toContainText('Sign out');
    await expect(page.locator('#settings-admin-button')).toBeVisible();
    await expect(page.locator('#settings-users-button')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-menu')).toBeHidden();
    await expect(page.locator('#settings-button')).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-settings-button').click();
    await expect(page.locator('#settings-menu-close')).toBeFocused();
    await page.locator('#settings-menu-close').click();
    await expect(page.locator('#mobile-settings-button')).toBeFocused();
    await page.locator('#mobile-settings-button').click();
    const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/logout');
    await page.evaluate(() => document.querySelector('#settings-sign-out-button').click());
    expect((await logoutResponse).status()).toBe(302);
    const denied = await context.request.get('/api/me');
    expect(denied.status()).toBe(401);
    expect(denied.headers()['content-type']).toContain('application/json');
    await context.close();

    const signedOut = await browser.newContext({ baseURL: baseUrl(servers.session) });
    const root = await signedOut.request.get('/', { maxRedirects: 0 });
    expect(root.status()).toBe(302);
    expect(root.headers().location).toBe('/login');
    await signedOut.close();

    const operator = await portalContext(browser, servers.operator);
    const operatorPage = await operator.newPage();
    await operatorPage.goto('/#/');
    expect((await json(await operator.request.get('/api/me'))).user.role).toBe('operator');
    await operatorPage.locator('#settings-button').click();
    await expect(operatorPage.locator('#settings-menu-close')).toBeFocused();
    await expect(operatorPage.locator('#settings-sign-out-button')).toBeVisible();
    await operator.close();

    const disabled = await browser.newContext({ baseURL: baseUrl(servers.disabled) });
    expect((await disabled.request.get('/__e2e__/browser-session', { maxRedirects: 0 })).status()).toBe(303);
    expect((await disabled.request.get('/api/me')).status()).toBe(401);
    const disabledWork = await browser.newContext({ baseURL: baseUrl(servers.disabled) });
    expect((await disabledWork.request.get('/__e2e__/browser-session', { maxRedirects: 0 })).status()).toBe(303);
    const disabledWorkMe = await disabledWork.request.get('/work/api/me', { maxRedirects: 0 });
    expect(disabledWorkMe.status()).toBe(401);
    expect(disabledWorkMe.headers()['content-type']).toContain('application/json');
    await disabledWork.close();
    const disabledRoot = await disabled.request.get('/', { maxRedirects: 0 });
    expect(disabledRoot.status()).toBe(302);
    expect(disabledRoot.headers().location).toBe('/login');
    await disabled.close();

    const expired = await browser.newContext({ baseURL: baseUrl(servers.expired) });
    expect((await expired.request.get('/__e2e__/browser-session', { maxRedirects: 0 })).status()).toBe(303);
    const expiredMe = await expired.request.get('/api/me');
    expect(expiredMe.status()).toBe(401);
    expect(expiredMe.headers()['content-type']).toContain('application/json');
    const expiredWork = await browser.newContext({ baseURL: baseUrl(servers.expired) });
    expect((await expiredWork.request.get('/__e2e__/browser-session', { maxRedirects: 0 })).status()).toBe(303);
    const expiredWorkMe = await expiredWork.request.get('/work/api/me', { maxRedirects: 0 });
    expect(expiredWorkMe.status()).toBe(401);
    expect(expiredWorkMe.headers()['content-type']).toContain('application/json');
    await expiredWork.close();
    const expiredRoot = await expired.request.get('/', { maxRedirects: 0 });
    expect(expiredRoot.status()).toBe(302);
    expect(expiredRoot.headers().location).toBe('/login');
    await expired.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/login | /logout', roleId: 'signed-out', stateIds: ['session.signed-out-redirect', 'session.api-json-denial'] },
      { route: '/login | /logout', roleId: 'expired-session', stateIds: ['session.expired-denied', 'session.api-json-denial'] },
      { route: '/login | /logout', roleId: 'disabled-user', stateIds: ['session.disabled-denied', 'session.api-json-denial'] },
      { route: '/login | /logout', roleId: 'operator', stateIds: ['session.operator-cookie-ready', 'session.no-bearer-fallback'] },
      { route: '/login | /logout', roleId: 'admin', stateIds: ['session.admin-cookie-ready', 'session.no-bearer-fallback'] },
      { route: '/#/ (Settings panel)', roleId: 'operator', stateIds: ['settings.operator-ready'] },
      { route: '/#/ (Settings panel)', roleId: 'admin', stateIds: ['settings.admin-ready', 'settings.desktop-focus-close', 'settings.mobile-focus-close'] },
    ]);
  });

  test('Home preserves real ready data and honest partial failure recovery', async ({ browser }, testInfo) => {
    const context = await portalContext(browser, servers.admin);
    await setFaults(context.request, [
      { method: 'GET', path: '/api/tasks', delayMs: 800 },
      { method: 'GET', path: '/api/cards', delayMs: 800 },
    ]);
    const page = await context.newPage();
    const initialToday = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/work/api/tasks' && url.searchParams.has('date');
    });
    const initialCards = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/work/api/cards' && url.searchParams.has('limit');
    });
    await page.goto('/#/');
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Europe/Berlin');
    await expect(page.locator('.operations-home[data-operations-work-loaded="false"]')).toBeVisible();
    await Promise.all([initialToday, initialCards]);
    await expect(page.locator('.operations-home[data-operations-work-loaded="true"]')).toBeVisible();
    await clearFaults(context.request);
    const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()));
    const attention = page.getByRole('region', { name: 'Needs your attention' });
    await expect(attention.locator('.home-attention-empty')).toBeVisible();
    await expect(attention.locator('.home-attention-list')).toHaveCount(0);
    await expect(attention.getByRole('button')).toBeEnabled();
    const dailySummary = page.getByRole('region', { name: 'Daily work summary' });
    await expect(dailySummary.locator('.home-status-item[data-state="ready"]')).toHaveCount(3);
    await expect(dailySummary.locator('.home-status-item > strong')).toHaveText(['0', '0', '0']);
    await expect(page.locator('#work-bell-button .work-bell-count')).toHaveText('0');
    const title = unique('Synthetic home task');
    const created = await context.request.post('/api/tasks', { data: {
      description: title, date: today, assigneeId: ADMIN_ID, instructionDocId: 'sop.synthetic.missing-home',
    } });
    expect(created.status()).toBe(201);
    const notificationTitle = unique('Synthetic home notification');
    const notificationTask = await context.request.post('/api/tasks', { data: {
      description: notificationTitle,
      date: '2026-08-11',
      status: 'waiting',
      assigneeId: ADMIN_ID,
      waitingFor: 'Synthetic reply',
      followUpAt: '2026-08-01T09:00:00.000Z',
      comment: 'Public-safe Home notification',
      instructionDocId: 'sop.synthetic.capability',
    } });
    expect(notificationTask.status()).toBe(201);
    const cardTitle = unique('Synthetic home workflow');
    expect((await context.request.post('/api/cards', { data: { title: cardTitle, anchorDate: '2026-08-12' } })).status()).toBe(201);
    const populatedWork = freshHomeWork(page);
    const populatedRender = page.evaluate(() => window.__dataopsRefreshWork());
    const [todayResponse, waitingResponse, cardsResponse] = await populatedWork;
    expect((await json(todayResponse)).tasks.some((task) => task.description === title)).toBe(true);
    expect((await json(waitingResponse)).tasks.some((task) => task.description === notificationTitle)).toBe(true);
    expect((await json(cardsResponse)).cards.items.some((card) => card.title === cardTitle)).toBe(true);
    await populatedRender;
    const populatedAttention = page.getByRole('region', { name: 'Needs your attention' });
    await expect(populatedAttention.locator('.home-attention-list')).toBeVisible();
    await expect(populatedAttention.locator('.home-attention-row', { hasText: title })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Daily work summary' }).locator('.home-status-item > strong')).toHaveText(['1', '1', '1']);
    await expect(page.locator('#work-bell-button .work-bell-count')).toHaveText('1');
    await page.locator('#work-bell-button').click();
    const bellItem = page.locator('.work-bell-item', { hasText: notificationTitle });
    await expect(bellItem).toBeVisible();
    await bellItem.getByRole('button', { name: 'Open task' }).click();
    await expect(page.locator('#task-panel-title')).toHaveText(notificationTitle);
    await page.locator('#task-panel-close').click();
    await page.goto('/#/');

    await setFaults(context.request, [{ method: 'GET', path: '/api/cards', status: 503, remaining: 10 }]);
    const partialWork = Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/work/api/tasks' && url.searchParams.has('date');
      }),
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/work/api/cards' && response.status() === 503;
      }),
    ]);
    const partialRender = page.evaluate(() => window.__dataopsRefreshWork());
    await partialWork;
    await partialRender;
    await expect(page.locator('.ops-runtime-state')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs your attention' }).getByText(title)).toBeVisible();
    await clearFaults(context.request);
    const recoveredWork = freshHomeWork(page);
    const recoveredRender = page.evaluate(() => window.__dataopsRefreshWork());
    await recoveredWork;
    await recoveredRender;
    await expect(page.locator('.ops-runtime-state')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Needs your attention' }).locator('.home-attention-row', { hasText: title })).toBeVisible();
    await context.close();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/',
      roleId: 'admin',
      stateIds: ['home.loading', 'home.empty', 'home.ready', 'home.partial-failure'],
    }]);
  });

  test('Home resolves a New York browser at the Berlin operator-day seam', async ({ browser }) => {
    fs.mkdirSync(ISSUE_196_SCREENSHOTS, { recursive: true });
    const context = await portalContext(browser, servers.admin, {
      timezoneId: 'America/New_York',
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const observedTodayQueries = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname !== '/work/api/tasks') return;
      const date = url.searchParams.get('date');
      if (date) observedTodayQueries.push(date);
    });

    const initialToday = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/tasks'
        && url.searchParams.get('date') === BOUNDARY_OPERATOR_DATE;
    });
    await installBerlinBoundaryClock(page);
    await page.goto('/#/');
    const initialResponse = await initialToday;
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/New_York');
    expect(await page.evaluate(() => new Date().toISOString())).toBe(BERLIN_MIDNIGHT_BOUNDARY_INSTANT);
    expect(new URL(initialResponse.url()).searchParams.get('date')).toBe(BOUNDARY_OPERATOR_DATE);

    const title = unique('Synthetic New York boundary task');
    expect((await context.request.post('/api/tasks', { data: {
      description: title,
      date: BOUNDARY_OPERATOR_DATE,
      assigneeId: ADMIN_ID,
      instructionDocId: 'sop.synthetic.capability',
    } })).status()).toBe(201);

    const refreshedToday = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/tasks'
        && url.searchParams.get('date') === BOUNDARY_OPERATOR_DATE;
    });
    const refreshedRender = page.evaluate(() => window.__dataopsRefreshWork());
    const refreshedResponse = await refreshedToday;
    await refreshedRender;
    expect(new URL(refreshedResponse.url()).searchParams.get('date')).toBe(BOUNDARY_OPERATOR_DATE);
    expect((await json(refreshedResponse)).tasks.some((task) => task.description === title)).toBe(true);

    const attentionRow = page.getByRole('region', { name: 'Needs your attention' })
      .locator('.home-attention-row', { hasText: title });
    await expect(attentionRow).toBeVisible();
    await expect(attentionRow).toContainText('Due today');
    expect([...new Set(observedTodayQueries)]).toEqual([BOUNDARY_OPERATOR_DATE]);
    await page.screenshot({
      path: path.join(ISSUE_196_SCREENSHOTS, 'operator-day-new-york-desktop.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.locator('#sidebar');
    const mobileMenuButton = page.locator('#mobile-menu-button');
    await mobileMenuButton.click();
    await expect(mobileMenuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toHaveAttribute('role', 'dialog');
    await page.locator('#sidebar-close-button').click();
    await expect(mobileMenuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    await expect(sidebar).toHaveAttribute('inert', '');
    await expect(page.locator('#sidebar-scrim')).toBeHidden();
    await expect(attentionRow).toBeVisible();
    const mobileOverflow = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(mobileOverflow.documentScrollWidth).toBeLessThanOrEqual(mobileOverflow.viewportWidth);
    expect(mobileOverflow.bodyScrollWidth).toBeLessThanOrEqual(mobileOverflow.viewportWidth);
    await page.screenshot({
      path: path.join(ISSUE_196_SCREENSHOTS, 'operator-day-new-york-mobile.png'),
      fullPage: true,
    });
    await context.close();
  });

  test('assistants and artifacts provide non-mutating real list, detail, stale, and relationship behavior', async ({ browser }, testInfo) => {
    const { context, page } = await portalPage(browser);
    await page.goto('/#/assistants');
    await expect(page.getByText('No matching assistant jobs')).toBeVisible();
    await setFaults(context.request, [{ method: 'GET', path: '/api/assistant-jobs', status: 503, remaining: 10 }]);
    await page.reload();
    await expect(page.getByText('Assistant jobs unavailable')).toBeVisible();
    await clearFaults(context.request);
    await page.goto('/#/artifacts');
    await expect(page.getByText('No artifacts registered')).toBeVisible();
    await setFaults(context.request, [{ method: 'GET', path: '/api/artifacts', status: 503, remaining: 10 }]);
    await page.reload();
    await expect(page.getByText('Artifact review index not connected')).toBeVisible();
    await expect(page.locator('.ops-state-list a')).toHaveCount(0);
    await clearFaults(context.request);

    const unavailableArtifactResponse = await context.request.post('/api/artifacts', { data: {
      type: 'report', title: 'Unavailable proof artifact',
      storageUri: 's3://synthetic-artifacts/unavailable-proof.txt', storageProvider: 's3',
      checksum: '0'.repeat(64), dataClass: 'internal', status: 'needs-review', sourceType: 'manual-upload',
    } });
    expect(unavailableArtifactResponse.status()).toBe(201);
    await page.reload();
    const unavailableArtifact = page.locator('.ops-state-list .ops-data-row', { hasText: 'Unavailable proof artifact' });
    await expect(unavailableArtifact).toContainText('needs-review · report · storage missing');
    await expect(unavailableArtifact.getByRole('link')).toHaveCount(0);

    const id = unique('assistant-baseline');
    const cardResponse = await context.request.post('/api/cards', { data: { title: `Synthetic workflow ${id}`, anchorDate: '2026-08-12' } });
    const card = (await json(cardResponse)).card;
    const assistantResponse = await context.request.post('/api/assistant-jobs', { data: {
      assistantType: 'podcast', title: `Synthetic assistant ${id}`, cardId: card.id,
      inputRefs: [{ type: 'card', id: card.id }], approvalRequired: true, maxAttempts: 2,
    } });
    const assistant = (await json(assistantResponse)).job;
    const artifactResponse = await context.request.post('/api/artifacts', { data: {
      type: 'assistant-output', title: `Synthetic artifact ${id}`, storageUri: 'https://example.invalid/synthetic-output',
      storageProvider: 'external-url', dataClass: 'internal', status: 'draft', sourceType: 'assistant-output',
      cardId: card.id, assistantJobId: assistant.id,
    } });
    expect(artifactResponse.status()).toBe(201);
    const before = await json(await context.request.get(`/api/assistant-jobs/${assistant.id}`));

    await setFaults(context.request, [{ method: 'GET', path: `/api/assistant-jobs/${assistant.id}`, delayMs: 800 }]);
    await page.goto(`/#/assistants?assistantJobId=${assistant.id}`);
    await expect(page.getByText('Loading job events and artifacts…')).toBeVisible();
    await expect(page.locator('.assistant-detail h3')).toHaveText(`Synthetic assistant ${id}`);
    await expect(page.locator('.assistant-queue .assistant-job-row', { hasText: `Synthetic assistant ${id}` })).toBeVisible();
    await expect(page.locator('.assistant-ref-list')).toContainText(card.id);
    await page.reload();
    await expect(page.locator('.assistant-detail h3')).toHaveText(`Synthetic assistant ${id}`);
    const after = await json(await context.request.get(`/api/assistant-jobs/${assistant.id}`));
    expect(after.job.status).toBe(before.job.status);
    expect(after.events).toEqual(before.events);

    await page.goto('/#/artifacts');
    const artifactSurface = page.locator('.ops-state-list');
    await expect(artifactSurface).toBeVisible();
    const artifactRow = artifactSurface.locator('.ops-data-row', { hasText: `Synthetic artifact ${id}` });
    await expect(artifactRow).toBeVisible();
    await expect(artifactSurface.locator('.ops-data-row', { hasText: card.id })).toBeVisible();
    const artifactLink = artifactRow.getByRole('link', { name: `Open Synthetic artifact ${id} for card ${card.id}` });
    await expect(artifactLink).toHaveAttribute('href', 'https://example.invalid/synthetic-output');
    await expect(artifactLink).toHaveAttribute('rel', 'noopener');
    await page.goto('/#/assistants?assistantJobId=stale-synthetic-assistant');
    await expect(page.locator('.entity-route-not-found')).toContainText('stale-synthetic-assistant');
    await context.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/assistants?assistantJobId=<id>', roleId: 'admin', stateIds: ['assistants.loading', 'assistants.empty', 'assistants.list', 'assistants.exact-detail', 'assistants.deep-link-reload', 'assistants.unavailable'] },
      { route: '/#/artifacts', roleId: 'admin', stateIds: ['artifacts.empty', 'artifacts.available', 'artifacts.authorized-action', 'artifacts.unavailable', 'artifacts.failure'] },
    ]);
  });

  test('Bookkeeping completes a real synthetic account, transaction, PDF evidence, link, and report journey', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const { context, page } = await portalPage(browser);
    await page.goto('/#/bookkeeping');
    await expect(page.getByText('No bookkeeping entries')).toBeVisible();
    await expect(page.locator('.bookkeeping-documents')).toContainText('No private documents uploaded');
    await setFaults(context.request, [{ method: 'GET', path: '/api/bookkeeping/transactions', status: 503, remaining: 10 }]);
    await page.reload();
    await expect(page.locator('.bookkeeping-ledger')).toContainText('Could not load bookkeeping: Synthetic route failure (503)');
    await expect(page.getByRole('status')).toContainText('Retry by reopening Bookkeeping');
    await clearFaults(context.request);
    await page.reload();
    await expect(page.getByText('No bookkeeping entries')).toBeVisible();
    const setup = await context.request.post('/api/bookkeeping/accounts/setup');
    expect(setup.status()).toBe(200);
    const accounts = (await json(setup)).accounts;
    expect(accounts).toHaveLength(2);
    const counterparty = unique('Synthetic vendor');
    const created = await context.request.post('/api/bookkeeping/transactions', { data: {
      transactionDate: '2026-08-12', counterparty, description: 'Synthetic browser evidence', amount: '18.50', currency: 'EUR',
      category: 'testing', entryType: 'expense', statementRef: 'synthetic-reference',
    } });
    expect(created.status()).toBe(201);
    const transaction = await json(created);
    await page.goto('/#/bookkeeping');
    await expect(page.getByRole('cell', { name: counterparty })).toBeVisible();
    await expect(page.locator('.bookkeeping-totals')).toContainText('EUR 18.50');

    await page.getByRole('button', { name: 'Upload PDF' }).click();
    await expect(page.getByRole('status')).toContainText('Choose a PDF first');
    await page.getByLabel('Link to transaction').selectOption(transaction.id);
    await page.getByLabel('PDF evidence').setInputFiles({
      name: 'synthetic-evidence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic evidence\n%%EOF'),
    });
    await page.getByRole('button', { name: 'Upload PDF' }).click();
    await expect(page.getByRole('status')).toContainText('PDF uploaded and verified');
    await expect(page.locator('.bookkeeping-documents article')).toHaveCount(1);
    await expect(page.locator('.bookkeeping-documents')).toContainText('Private PDF');
    await expect(page.getByRole('button', { name: /Unlink/ })).toBeVisible();
    const links = await json(await context.request.get('/api/bookkeeping/links'));
    expect(links.items.some((link) => link.transactionId === transaction.id)).toBe(true);

    for (const [index] of accounts.entries()) {
      await page.getByLabel('Document type').selectOption('bank-statement');
      const accountSelect = page.locator('[data-account]');
      const renderedAccountId = await accountSelect.locator('option').nth(index + 1).getAttribute('value');
      expect(renderedAccountId).toBeTruthy();
      await accountSelect.selectOption(renderedAccountId);
      await page.getByLabel('Statement month').fill('2026-08');
      await page.getByLabel('Link to transaction').selectOption('');
      await page.getByLabel('PDF evidence').setInputFiles({
        name: `synthetic-statement-${index + 1}.pdf`, mimeType: 'application/pdf',
        buffer: Buffer.from(`%PDF-1.4\nsynthetic statement ${index + 1}\n%%EOF`),
      });
      await page.getByRole('button', { name: 'Upload PDF' }).click();
      await expect(page.getByRole('status')).toContainText('PDF uploaded and verified');
      await expect(page.locator('.bookkeeping-documents article')).toHaveCount(index + 2);
    }
    const retired = await context.request.post('/api/bookkeeping/documents/upload', { data: {
      filename: 'synthetic-evidence.pdf', contentType: 'application/pdf', byteSize: 34, documentType: 'receipt',
    } });
    expect(retired.status()).toBe(404);
    await page.getByLabel('Report month').fill('2026-08');
    await page.getByRole('button', { name: 'Create monthly package' }).click();
    await expect(page.getByRole('status')).toContainText('Snapshot ready');
    await page.reload();
    await expect(page.getByRole('cell', { name: counterparty })).toBeVisible();
    await expect(page.locator('.bookkeeping-documents article')).toHaveCount(4);
    await expect(page.locator('.bookkeeping-documents')).toContainText('datatalksclub-2026-08.zip');
    await context.close();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/bookkeeping',
      roleId: 'admin',
      stateIds: ['bookkeeping.empty', 'bookkeeping.configured', 'bookkeeping.validation', 'bookkeeping.upload-link', 'bookkeeping.report', 'bookkeeping.failure'],
    }]);
  });

  test('Sponsors enforce safe operator projection and admin-only mutation with real records', async ({ browser }, testInfo) => {
    const admin = await portalContext(browser, servers.admin);
    const operator = await portalContext(browser, servers.operator);
    const page = await admin.newPage();
    await page.goto('/#/sponsors');
    await expect(page.getByText('No sponsors found')).toBeVisible();
    await expect(page.getByText('No bookings')).toBeVisible();
    const id = unique('sponsor');
    const organizationResponse = await admin.request.post('/api/sponsor-crm/organizations', { data: {
      displayName: `Synthetic Sponsor ${id}`, notes: 'Synthetic private note', sourceKey: `${id}-org`,
    } });
    const organization = await json(organizationResponse);
    const contactResponse = await admin.request.post('/api/sponsor-crm/contacts', { data: {
      organizationId: organization.id, name: 'Synthetic Contact', emails: ['synthetic-contact@example.invalid'], primary: true, sourceKey: `${id}-contact`,
    } });
    const contact = await json(contactResponse);
    const bookingResponse = await admin.request.post('/api/sponsor-crm/bookings', { data: {
      organizationId: organization.id, primaryContactId: contact.id, slotType: 'main', status: 'inquiry',
      plannedPublicationDate: '2026-09-01', sourceKey: `${id}-booking`,
    } });
    const booking = await json(bookingResponse);
    const adminMutation = await admin.request.put(`/api/sponsor-crm/bookings/${booking.id}`, { data: {
      version: booking.version, status: 'confirmed', historyNote: 'Synthetic permitted update',
    } });
    expect(adminMutation.status()).toBe(200);
    const updatedBooking = await json(adminMutation);
    const conflict = await admin.request.put(`/api/sponsor-crm/bookings/${booking.id}`, { data: {
      version: booking.version, status: 'cancelled',
    } });
    expect(conflict.status()).toBe(409);

    const operatorOrganization = await json(await operator.request.post('/api/sponsor-crm/organizations', { data: {
      displayName: `Synthetic Operator Sponsor ${id}`, notes: 'Operator-private synthetic note', sourceKey: `${id}-operator-org`,
    } }));
    const operatorBooking = await json(await operator.request.post('/api/sponsor-crm/bookings', { data: {
      organizationId: operatorOrganization.id, slotType: 'main', status: 'inquiry', sourceKey: `${id}-operator-booking`,
    } }));
    const operatorProjection = await operator.request.get(`/api/sponsor-crm/bookings/${operatorBooking.id}/finance`);
    expect(operatorProjection.status()).toBe(200);
    expect(await json(operatorProjection)).toMatchObject({ role: 'operator', classified: false });
    const operatorMutation = await operator.request.put(`/api/sponsor-crm/bookings/${operatorBooking.id}/finance`, { data: {
      bookingVersion: operatorBooking.version, invoiceRequirement: 'required', amountDue: '99', currency: 'EUR', taxMode: 'included', taxAmount: '0',
    }, headers: { 'idempotency-key': `${id}-operator-denied` } });
    expect(operatorMutation.status()).toBe(403);

    await page.goto(`/#/sponsors?bookingId=${updatedBooking.id}`);
    await expect(page.locator('[data-crm-detail]')).toContainText(`Synthetic Sponsor ${id}`);
    await expect(page.locator('[data-crm-detail] .status-label')).toHaveText('Confirmed');
    await expect(page.locator('[data-crm-detail]')).not.toContainText('Synthetic private note');
    await page.reload();
    await expect(page.locator('[data-crm-detail]')).toContainText(`Synthetic Sponsor ${id}`);
    await page.goto('/#/sponsors');
    const bookingCard = page.locator('[data-crm-bookings] article', { hasText: `Synthetic Sponsor ${id}` });
    await bookingCard.getByRole('button', { name: 'Edit' }).click();
    const latestBooking = await json(await admin.request.get(`/api/sponsor-crm/bookings/${updatedBooking.id}`));
    expect((await admin.request.put(`/api/sponsor-crm/bookings/${updatedBooking.id}`, { data: {
      version: latestBooking.version, status: 'materials-pending', historyNote: 'Concurrent synthetic change',
    } })).status()).toBe(200);
    const bookingDialog = page.locator('[data-booking-dialog]');
    await bookingDialog.locator('select[name="status"]').selectOption('scheduled');
    await bookingDialog.getByRole('button', { name: 'Save booking' }).click();
    await expect(page.locator('[data-crm-message]')).toContainText('Record was changed; reload and retry');
    await expect(bookingDialog).toBeVisible();
    await bookingDialog.getByRole('button', { name: 'Cancel' }).click();
    await setFaults(admin.request, [{ method: 'GET', path: '/api/sponsor-crm/organizations', status: 503 }]);
    await page.goto('/#/sponsors');
    await expect(page.locator('[data-crm-message]')).toContainText('Synthetic route failure (503)');
    await expect(page.locator('[data-crm-message]')).toContainText('Reopen Sponsors to retry');
    await clearFaults(admin.request);
    await page.reload();
    await expect(page.getByRole('article').filter({ hasText: `Synthetic Sponsor ${id}` }).first()).toBeVisible();
    const operatorPage = await operator.newPage();
    await operatorPage.goto(`/#/sponsors?bookingId=${operatorBooking.id}`);
    await expect(operatorPage.locator('[data-crm-detail]')).toContainText(`Synthetic Operator Sponsor ${id}`);
    await expect(operatorPage.locator('[data-finance-panel]')).toContainText('This booking has not been classified');
    await expect(operatorPage.locator('[data-finance-panel] [data-finance-classify]')).toHaveCount(0);
    await expect(operatorPage.locator('[data-crm-detail]')).not.toContainText('Operator-private synthetic note');
    await admin.close();
    await operator.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/sponsors?bookingId=<id>', roleId: 'admin', stateIds: ['sponsors.empty', 'sponsors.ready-detail', 'sponsors.admin-mutation', 'sponsors.conflict', 'sponsors.failure'] },
      { route: '/#/sponsors?bookingId=<id>', roleId: 'operator', stateIds: ['sponsors.operator-safe-read', 'sponsors.operator-denied'] },
    ]);
  });

  test('Newsletter and Calendar persist real synthetic edits, validation, conflicts, overlays, and recovery', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const { context, page } = await portalPage(browser);
    await page.goto('/#/newsletter');
    await expect(page.getByText('No newsletter slots')).toBeVisible();
    await page.goto('/#/calendar');
    await expect(page.getByText('No matching activities')).toBeVisible();
    const id = unique('schedule');
    const slotResponse = await context.request.post('/api/newsletter-slots', { data: {
      publicationDate: '2026-09-03', campaignLabel: `Synthetic newsletter ${id}`, status: 'open', planningNote: 'Public-safe plan',
    } });
    expect(slotResponse.status()).toBe(201);
    const slot = await json(slotResponse);
    const invalidSlot = await context.request.post('/api/newsletter-slots', { data: { publicationDate: '2026-02-30', campaignLabel: 'Invalid', status: 'open' } });
    expect(invalidSlot.status()).toBe(400);
    const changedSlot = await context.request.put(`/api/newsletter-slots/${slot.id}`, { data: { version: slot.version, status: 'scheduled' } });
    expect(changedSlot.status()).toBe(200);
    const slotConflict = await context.request.put(`/api/newsletter-slots/${slot.id}`, { data: { version: slot.version, status: 'sent' } });
    expect(slotConflict.status()).toBe(409);

    const calendarResponse = await context.request.post('/api/calendar-items', { data: {
      activityType: 'webinar', title: `Synthetic calendar ${id}`, status: 'confirmed', allDay: true,
      startDate: '2026-09-03', endDate: '2026-09-03', notes: 'Synthetic only',
    } });
    expect(calendarResponse.status()).toBe(201);
    const calendar = (await json(calendarResponse)).item || await json(calendarResponse);
    const calendarItem = calendar.item || calendar;
    const invalidCalendar = await context.request.post('/api/calendar-items', { data: {
      activityType: 'invalid', title: 'Invalid', status: 'confirmed', allDay: true, startDate: '2026-09-03', endDate: '2026-09-03',
    } });
    expect(invalidCalendar.status()).toBe(400);
    const changedCalendar = await context.request.put(`/api/calendar-items/${calendarItem.id}`, { data: { version: calendarItem.version, title: `Updated calendar ${id}` } });
    expect(changedCalendar.status()).toBe(200);
    const calendarConflict = await context.request.put(`/api/calendar-items/${calendarItem.id}`, { data: { version: calendarItem.version, title: 'Stale update' } });
    expect(calendarConflict.status()).toBe(409);

    await page.goto('/#/newsletter');
    await page.locator('[data-from]').fill('2026-09-01');
    await page.locator('[data-to]').fill('2026-09-30');
    await page.locator('[data-from]').dispatchEvent('change');
    await expect(page.getByText(`Synthetic newsletter ${id}`)).toBeVisible();
    const scheduledSlot = page.locator('[data-slots] article', { hasText: `Synthetic newsletter ${id}` });
    await expect(scheduledSlot.locator('.planner-status.is-info')).toHaveText('Scheduled');
    await page.getByRole('button', { name: 'Add slot' }).click();
    await page.getByRole('button', { name: 'Save slot' }).click();
    await expect(page.locator('.newsletter-surface dialog [role="alert"]')).toContainText('Invalid publicationDate');
    await page.keyboard.press('Escape');
    await expect(page.locator('.newsletter-surface dialog')).toBeHidden();
    await page.locator('[data-slots] article', { hasText: `Synthetic newsletter ${id}` }).getByRole('button', { name: 'Edit' }).click();
    const serverSlot = await json(await context.request.get(`/api/newsletter-slots/${slot.id}`));
    const concurrentSlot = await context.request.put(`/api/newsletter-slots/${slot.id}`, { data: {
      version: serverSlot.version, campaignLabel: `Server newsletter ${id}`,
    } });
    expect(concurrentSlot.status()).toBe(200);
    await page.getByRole('button', { name: 'Save slot' }).click();
    await expect(page.locator('.newsletter-surface dialog [role="alert"]')).toContainText('Slot changed; reload and retry');
    await page.keyboard.press('Escape');
    await expect(page.locator('.newsletter-surface dialog')).toBeHidden();
    await page.reload();
    await expect(page.getByText(`Server newsletter ${id}`)).toBeVisible();
    await setFaults(context.request, [{ method: 'GET', path: '/api/newsletter-slots', status: 503 }]);
    await page.locator('[data-status]').selectOption('open');
    await expect(page.locator('.newsletter-surface [role="status"]')).toContainText('Could not load newsletter schedule');
    await clearFaults(context.request);
    await page.locator('[data-status]').selectOption('');
    await expect(page.getByText(`Server newsletter ${id}`)).toBeVisible();

    await page.goto('/#/calendar');
    await page.clock.setFixedTime(new Date('2026-09-03T12:00:00Z'));
    await page.locator('[data-today]').click();
    await expect(page.getByText(`Updated calendar ${id}`).first()).toBeVisible();
    const calendarDialog = page.locator('.calendar-surface dialog');
    await page.getByRole('button', { name: 'Add activity' }).click();
    await calendarDialog.getByRole('button', { name: 'Save activity' }).click();
    await expect(calendarDialog).toBeVisible();
    expect(await calendarDialog.getByLabel('Title').evaluate((input) => input.validity.valid)).toBe(false);
    await calendarDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByText(`Updated calendar ${id}`).first().click();
    const currentCalendarPayload = await json(await context.request.get(`/api/calendar-items/${calendarItem.id}`));
    const currentCalendar = currentCalendarPayload.item || currentCalendarPayload;
    expect((await context.request.put(`/api/calendar-items/${calendarItem.id}`, { data: {
      version: currentCalendar.version, title: `Server calendar ${id}`,
    } })).status()).toBe(200);
    await calendarDialog.getByLabel('Title').fill(`Preserved local calendar ${id}`);
    await calendarDialog.getByRole('button', { name: 'Save activity' }).click();
    await expect(calendarDialog.getByRole('alert')).toContainText('Version conflict');
    await expect(calendarDialog.getByLabel('Title')).toHaveValue(`Preserved local calendar ${id}`);
    await calendarDialog.getByRole('button', { name: 'Cancel' }).click();
    await page.reload();
    await page.clock.setFixedTime(new Date('2026-09-03T12:00:00Z'));
    await page.locator('[data-today]').click();
    await page.getByText(`Server calendar ${id}`).first().click();
    await page.locator('.calendar-surface dialog').getByLabel('Title').fill(`Browser calendar ${id}`);
    await page.locator('.calendar-surface dialog').getByRole('button', { name: 'Save activity' }).click();
    await expect(page.getByText(`Browser calendar ${id}`).first()).toBeVisible();
    await expect(page.locator('[data-calendar]')).toContainText(`Server newsletter ${id}`);
    await setFaults(context.request, [{ method: 'GET', path: '/api/calendar-items', status: 503 }]);
    await page.locator('[data-next]').click();
    await expect(page.getByText('Calendar unavailable')).toBeVisible();
    await clearFaults(context.request);
    await page.locator('[data-today]').click();
    await expect(page.getByText(`Browser calendar ${id}`).first()).toBeVisible();
    await context.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/newsletter', roleId: 'admin', stateIds: ['newsletter.empty', 'newsletter.populated', 'newsletter.create-edit-reload', 'newsletter.validation', 'newsletter.conflict', 'newsletter.failure'] },
      { route: '/#/calendar', roleId: 'admin', stateIds: ['calendar.empty', 'calendar.populated', 'calendar.create-edit-reload', 'calendar.overlays-alerts', 'calendar.week-date-navigation', 'calendar.validation', 'calendar.conflict', 'calendar.failure'] },
    ]);
  });

  test('mailing exports run deterministic configured history without an external provider write', async ({ browser }, testInfo) => {
    const noConfig = await portalContext(browser, servers.noMailingConfig);
    const noConfigPage = await noConfig.newPage();
    await noConfigPage.goto('/#/mailing-exports');
    await expect(noConfigPage.locator('[data-export-state="no-config"]')).toContainText('No export configurations');
    await expect(noConfigPage.getByRole('status')).toContainText('No export configurations are enabled');
    await noConfig.close();

    const { context, page } = await portalPage(browser);
    await page.goto('/#/mailing-exports');
    await expect(page.getByText('Synthetic audience account')).toBeVisible();
    await expect(page.locator('.mailing-export-card[data-export-state="empty"]')).toBeVisible();
    await expect(page.getByText('No export runs yet')).toBeVisible();
    await page.getByRole('button', { name: 'Start daily export' }).click();
    await expect(page.locator('.mailing-export-card[data-export-state="pending"]')).toBeVisible();
    await expect(page.locator('.mailing-export-history')).toContainText('Synthetic audience account · pending');

    expect((await context.request.post('/__e2e__/mailing-provider', { data: { mode: 'fail' } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Advance / retry' }).click();
    await expect(page.getByRole('status')).toContainText('Could not advance export: HTTP 502 Bad Gateway');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.mailing-export-card[data-export-state="failed"]')).toBeVisible();
    await expect(page.locator('.mailing-export-error')).toContainText('provider-api · The provider export API failed');
    expect(await page.locator('.mailing-export-card').textContent()).not.toContain('apiKey');

    expect((await context.request.post('/__e2e__/mailing-provider', { data: { mode: 'complete' } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Advance / retry' }).click();
    await expect(page.locator('.mailing-export-card[data-export-state="completed"]')).toBeVisible();
    await expect(page.locator('.mailing-export-card dl div', { hasText: 'Artifact' }).locator('dd')).toContainText('mailing-export-');
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.mailing-export-card[data-export-state="completed"]')).toBeVisible();
    await expect(page.locator('.mailing-export-history')).toContainText('Synthetic audience account · completed');
    await context.close();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/mailing-exports',
      roleId: 'admin',
      stateIds: ['mailing-exports.no-configs', 'mailing-exports.ready', 'mailing-exports.running', 'mailing-exports.completed', 'mailing-exports.failed'],
    }]);
  });

  test('Process Docs search and Admin diagnostics use real synthetic local fixtures and fail safely', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const empty = await portalContext(browser, servers.emptyDocs, {
      viewport: { width: 1440, height: 900 },
    });
    await setFaults(empty.request, [{
      method: 'GET', path: '/docs', delayMs: 1200, remaining: 2,
    }]);
    const emptyPage = await empty.newPage();
    const emptyErrors = observeBrowserErrors(emptyPage);
    const emptyDocsReady = emptyPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/docs';
    });
    await emptyPage.goto('/#/processes', { waitUntil: 'domcontentloaded' });
    await captureIssue200State(
      emptyPage,
      'process-docs-loading',
      emptyPage.locator('.ops-surface-docs'),
    );
    const emptyDocsResponse = await emptyDocsReady;
    expect(emptyDocsResponse.status()).toBe(200);
    expect((await json(emptyDocsResponse)).documents).toEqual([]);

    await emptyPage.setViewportSize({ width: 390, height: 844 });
    const mobileLoadingReady = emptyPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/docs';
    });
    await emptyPage.reload({ waitUntil: 'domcontentloaded' });
    await captureIssue200State(
      emptyPage,
      'process-docs-loading',
      emptyPage.locator('.ops-surface-docs'),
    );
    expect((await mobileLoadingReady).status()).toBe(200);

    await setFaults(empty.request, [{
      method: 'GET', path: '/docs', status: 503, remaining: 2,
    }]);
    await emptyPage.setViewportSize({ width: 1440, height: 900 });
    const desktopOutageReady = emptyPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/docs';
    });
    await emptyPage.reload({ waitUntil: 'domcontentloaded' });
    await captureIssue200State(
      emptyPage,
      'process-docs-unavailable',
      emptyPage.locator('.ops-surface-docs [data-docs-state="unavailable"]'),
    );
    expect((await desktopOutageReady).status()).toBe(503);
    await emptyPage.setViewportSize({ width: 390, height: 844 });
    const mobileOutageReady = emptyPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/docs';
    });
    await emptyPage.reload({ waitUntil: 'domcontentloaded' });
    await captureIssue200State(
      emptyPage,
      'process-docs-unavailable',
      emptyPage.locator('.ops-surface-docs [data-docs-state="unavailable"]'),
    );
    expect((await mobileOutageReady).status()).toBe(503);
    expectOnlyDeliberateCatalogFailures(emptyErrors);
    const outageSearch = emptyPage.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.pathname === '/search';
    });
    await emptyPage.locator('#mobile-menu-button').click();
    await expect(emptyPage.locator('#sidebar')).toBeVisible();
    await emptyPage.locator('#search-input').fill('no synthetic process exists');
    const outageSearchRequest = await outageSearch;
    expect([...new URL(outageSearchRequest.url()).searchParams]).toEqual([
      ['q', 'no synthetic process exists'],
      ['limit', '80'],
      ['source', 'docs'],
    ]);
    await expect(emptyPage.locator('#document-list.is-unified-search')).toBeVisible();
    await emptyPage.locator('#sidebar-close-button').click();
    await expect(emptyPage.locator('#sidebar')).toHaveAttribute('aria-hidden', 'true');
    await expect(emptyPage.locator('#sidebar')).toHaveAttribute('inert', '');
    await expect(emptyPage.locator('#sidebar-scrim')).toBeHidden();
    await expect(emptyPage.getByText('No work or process context matches this search.')).toBeVisible();
    await setFaults(empty.request, [
      { method: 'GET', path: '/docs/process-quality', delayMs: 1200 },
      { method: 'GET', path: '/git/status', delayMs: 1200 },
      { method: 'GET', path: '/git/log', delayMs: 1200 },
    ]);
    await emptyPage.goto('/#/admin', { waitUntil: 'domcontentloaded' });
    const emptyDiagnostics = emptyPage.locator('.ops-admin-diagnostics');
    await expect(emptyDiagnostics.locator('[data-diagnostic="quality"]')).toContainText('Loading local validation');
    await expect(emptyDiagnostics.locator('[data-diagnostic="git-status"]')).toContainText('Loading availability');
    await expect(emptyDiagnostics.locator('[data-diagnostic="git-history"]')).toContainText('Loading availability');
    await expect(emptyDiagnostics.locator('[data-diagnostic="quality"]')).toContainText('0 finding(s); 0 validation error(s)');
    await expect(emptyDiagnostics.locator('[data-diagnostic="git-status"]')).toContainText(/unavailable/i);
    await expect(emptyDiagnostics.locator('[data-diagnostic="git-history"]')).toContainText(/unavailable/i);
    await clearFaults(empty.request);
    await empty.close();

    const { context, page } = await portalPage(browser, servers.qualityAdmin);
    const browserErrors = observeBrowserErrors(page);
    const docs = await context.request.get('/docs');
    expect(docs.status()).toBe(200);
    expect((await json(docs)).documents.some((item) => item.path === 'content/synthetic/capability.md')).toBe(true);
    const search = await context.request.get('/search?q=synthetic%20capability');
    expect(search.status()).toBe(200);
    expect(JSON.stringify(await json(search))).toContain('content/synthetic/capability.md');
    const backlinks = await context.request.get('/docs/backlinks?path=content%2Fsynthetic%2Fcapability.md');
    expect(backlinks.status()).toBe(200);

    await page.goto('/#/processes');
    await expect(page.locator('#library-title')).toHaveText('Docs');
    await expect(page.locator('.ops-surface-docs')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.ops-reference-link').first()).toBeVisible();
    await captureIssue200Screenshot(page, 'process-docs-healthy');
    await page.setViewportSize({ width: 390, height: 844 });
    await captureIssue200Screenshot(page, 'process-docs-healthy');

    await openMobileProcessDocs(page);
    const mobileCreateProcess = page.locator('.ops-docs-create');
    await expect(mobileCreateProcess).toBeVisible();
    await mobileCreateProcess.click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'create');
    await expect(page.locator('#new-doc-path')).toBeVisible();
    await captureIssue200Screenshot(page, 'process-docs-create');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#docs-nav-button').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'library');

    await page.locator('#filters-section summary').click();
    const documentFilters = page.locator('#filter-row .custom-select');
    await expect(documentFilters).toHaveCount(4);
    const chooseDocumentFilter = async (index, label) => {
      const filter = documentFilters.nth(index);
      await filter.getByRole('button').click();
      await filter.getByRole('option', { name: label }).click();
    };
    await chooseDocumentFilter(0, 'Synthetic');
    await chooseDocumentFilter(1, 'Sop');
    await chooseDocumentFilter(2, 'Dataops');
    await chooseDocumentFilter(3, 'Synthetic');
    const canonicalFilterUrl = /\/#\/processes\?domain=synthetic&type=sop&system=dataops&tag=synthetic$/;
    await expect(page).toHaveURL(canonicalFilterUrl);
    await expect(page.locator('.ops-surface-docs')).toBeVisible();
    await expect(page.locator('#filter-count')).toHaveText('4');
    await captureIssue200Screenshot(page, 'process-docs-filtered');
    await page.setViewportSize({ width: 390, height: 844 });
    await captureIssue200Screenshot(page, 'process-docs-filtered');
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.reload();
    await expect(page.locator('.ops-surface-docs')).toBeVisible();
    await expect(page).toHaveURL(canonicalFilterUrl);
    await expect(page.locator('#filter-count')).toHaveText('4');
    await page.locator('#filters-section summary').click();
    await page.locator('#clear-filters-button').click();
    await expect(page).toHaveURL(/\/#\/processes$/);
    await expect(page.locator('#filter-count')).toBeHidden();
    await expect(page.locator('#filter-count')).toHaveText('');
    for (const selector of ['#domain-filter', '#type-filter', '#system-filter', '#tag-filter']) {
      await expect(page.locator(selector)).toHaveValue('');
    }

    await chooseDocumentFilter(0, 'Synthetic');
    await chooseDocumentFilter(1, 'Sop');
    await chooseDocumentFilter(2, 'Dataops');
    await chooseDocumentFilter(3, 'Synthetic');
    await expect(page).toHaveURL(canonicalFilterUrl);
    const filteredSearch = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.pathname === '/search';
    });
    await page.locator('#search-input').fill('synthetic capability');
    const searchRequest = await filteredSearch;
    expect([...new URL(searchRequest.url()).searchParams]).toEqual([
      ['q', 'synthetic capability'],
      ['limit', '80'],
      ['domain', 'synthetic'],
      ['doc_type', 'sop'],
      ['system', 'dataops'],
      ['tag', 'synthetic'],
      ['source', 'docs'],
    ]);
    const docResult = page.locator('.unified-search-row.result-doc', { hasText: 'Synthetic Capability Procedure' });
    await expect(docResult).toBeVisible();
    await docResult.click();
    await expect(page.locator('#document-title')).toHaveValue('Synthetic Capability Procedure');
    await expect(page.locator('#rendered-view')).toContainText('Exercise a public-safe retained portal surface');
    await page.getByRole('button', { name: 'Process Docs', exact: true }).click();
    await expect(page).toHaveURL(/\/#\/processes$/);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'library');
    await expect(page.locator('#library-title')).toHaveText('Docs');
    const createProcess = page.locator('.ops-docs-create');
    await expect(createProcess).toBeVisible();
    await createProcess.click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'create');
    await captureIssue200Screenshot(page, 'process-docs-create');
    expect(browserErrors.map((entry) => `${entry.kind}: ${entry.message || entry.failure || entry.url}`))
      .toEqual([]);

    const createdSlug = unique('browser-process');
    const createdPath = `content/synthetic/${createdSlug}.md`;
    const createdTitle = `Browser process ${createdSlug}`;
    const updatedTitle = `${createdTitle} updated`;
    const createForm = page.locator('#new-doc-form');
    await createForm.getByLabel('Path').fill('');
    await createForm.getByRole('button', { name: 'Create and edit' }).click();
    await expect(page.locator('#status-text')).toContainText('Path is required');
    await createForm.getByLabel('Path').fill(createdPath);
    await createForm.getByLabel('Title', { exact: true }).fill(createdTitle);
    await createForm.getByLabel('Summary').fill('Synthetic browser-created process document.');
    await createForm.getByRole('button', { name: 'Create and edit' }).click();
    await expect(page.locator('#document-title')).toHaveValue(createdTitle);
    expect((await json(await context.request.get(`/docs?path=${encodeURIComponent(createdPath)}`))).path).toBe(createdPath);

    await page.locator('.block-title').click();
    await page.locator('.block-title-editor').fill(updatedTitle);
    await page.locator('.block-title-editor').press('Enter');
    await setFaults(context.request, [{ method: 'PUT', path: '/docs', status: 503 }]);
    const failedSave = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === '/docs'
        && url.searchParams.get('path') === createdPath;
    });
    await page.keyboard.press('Control+s');
    expect((await failedSave).status()).toBe(503);
    await expect(page.locator('#status-text')).toContainText('Synthetic route failure (503)');
    await expect(page.locator('#document-title')).toHaveValue(updatedTitle);
    await clearFaults(context.request);
    const successfulSave = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === '/docs'
        && url.searchParams.get('path') === createdPath;
    });
    await page.keyboard.press('Control+s');
    expect((await successfulSave).status()).toBe(200);
    await page.reload();
    await expect(page.locator('#document-title')).toHaveValue(updatedTitle);

    const draftPhaseErrors = observeBrowserErrors(page);

    const draftPaths = [
      `content/synthetic/${unique('browser-draft')}.md`,
      'content/synthetic/capability.md',
    ];
    await page.evaluate((paths) => {
      for (const [index, draftPath] of paths.entries()) {
        localStorage.setItem(
          `dtc-doc-draft:${draftPath}`,
          `# Synthetic browser draft ${index + 1}\n`,
        );
      }
    }, draftPaths);
    const thirdDraftTitle = `${updatedTitle} draft`;
    await page.locator('.block-title').click();
    await page.locator('.block-title-editor').fill(thirdDraftTitle);
    await page.locator('.block-title-editor').press('Enter');
    const draftRows = page.locator('#changes-list .changes-row-wrap');
    await expect(draftRows).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(draftRows.nth(index).getByRole('button', { name: 'Diff' })).toBeVisible();
      await expect(draftRows.nth(index).getByTitle('Discard this draft')).toBeVisible();
    }
    await captureIssue200Screenshot(page, 'draft-management');
    await page.setViewportSize({ width: 390, height: 844 });
    await captureIssue200Screenshot(page, 'draft-management');
    expect(draftPhaseErrors.map((entry) => `${entry.kind}: ${entry.message || entry.failure || entry.url}`))
      .toEqual([]);

    await setFaults(context.request, [{
      method: 'PUT', path: '/docs', status: 503, remaining: 1,
    }]);
    const partialSaveResponses = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT' && url.pathname === '/docs';
    });
    await page.locator('#changes-save-all').click();
    expect((await partialSaveResponses).status()).toBe(503);
    await expect(page.locator('#changes-status')).toContainText('Saved 2, 1 failed.');
    await expect(draftRows).toHaveCount(1);
    await captureIssue200Screenshot(page, 'draft-partial-failure');
    await clearFaults(context.request);
    await page.locator('#changes-discard-all').click();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#changes-status')).toContainText('Discarded 1 draft.');
    await expect(draftRows).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });

    const referencePath = `content/synthetic/${unique('browser-reference')}.md`;
    const referenceTitle = 'Synthetic browser backlink source';
    const referenceCreate = await context.request.post('/docs', { data: {
      path: referencePath, title: referenceTitle, doc_type: 'reference', summary: 'Backlink fixture', scaffold: 'minimal',
    } });
    expect(referenceCreate.status()).toBe(201);
    const referenceEdit = await context.request.put(`/docs?path=${encodeURIComponent(referencePath)}`, { data: {
      content: `---\ntitle: "${referenceTitle}"\ndoc_type: reference\n---\n\n# ${referenceTitle}\n\n[Created process](./${createdSlug}.md)\n`,
    } });
    expect(referenceEdit.status()).toBe(200);
    await page.reload();
    await expect(page.locator('#backlinks-host')).toContainText('Referenced by (1)');
    await expect(page.locator('.block-backlinks-row')).toHaveText(referenceTitle);
    await page.locator('.block-backlinks-row').click();
    await expect(page.locator('#document-title')).toHaveValue(referenceTitle);

    const quality = await context.request.get('/docs/process-quality');
    expect(quality.status()).toBe(200);
    const qualityPayload = await json(quality);
    expect(qualityPayload.summary.total).toBeGreaterThan(0);
    expect(qualityPayload.findings.length).toBeGreaterThan(0);
    // Access has no document while the local SOP finding has a different
    // category, so these populated dropdown values intersect at zero rows.
    const emptyQualityFilters = {
      category: 'access',
      document: 'content/synthetic/quality-alpha.md',
    };
    expect(new Set(qualityPayload.findings.map((finding) => finding.category)))
      .toEqual(new Set(['access', 'process-doc']));
    expect(qualityPayload.findings.some((finding) => finding.docPath === emptyQualityFilters.document))
      .toBe(true);
    const gitStatus = await context.request.get('/git/status');
    expect(gitStatus.status()).toBe(200);
    expect(await json(gitStatus)).toMatchObject({ available: false, readOnly: true, files: [] });
    const gitHistory = await context.request.get('/git/log');
    expect(gitHistory.status()).toBe(200);
    expect(await json(gitHistory)).toMatchObject({ available: false, readOnly: true, commits: [] });
    const deniedGitMutation = await context.request.post('/git/pull');
    expect(deniedGitMutation.status()).toBe(405);
    await page.goto('/#/processes');
    await expect(page.locator('.ops-surface-docs')).toBeVisible();
    await expect(page.locator('.ops-quality-list .ops-quality-row').first()).toBeVisible();
    const qualityFilters = page.locator('.ops-quality-filters');
    const filterLabels = {
      category: 'Category',
      document: 'Document',
    };
    for (const [field, value] of Object.entries(emptyQualityFilters)) {
      await qualityFilters.getByLabel(filterLabels[field], { exact: true }).selectOption(value);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectStackedQualityEmptyState(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectStackedQualityEmptyState(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/admin');
    await expect(page.locator('.ops-admin-card', { hasText: 'Diagnostics' })).toBeVisible();
    const diagnostics = page.getByRole('region', { name: 'Read-only diagnostics' });
    await expect(diagnostics).toContainText('No pull, commit, publish, or provider action is available here');
    await expect(diagnostics.locator('[data-diagnostic="quality"]')).toContainText(/finding\(s\); \d+ validation error\(s\)/);
    await expect(diagnostics.locator('[data-diagnostic="git-status"]')).toContainText('Git diagnostics are unavailable in the packaged runtime');
    await expect(diagnostics.locator('[data-diagnostic="git-history"]')).toContainText('Git history is unavailable in the packaged runtime');

    await setFaults(context.request, [
      { method: 'GET', path: '/docs/process-quality', status: 503, remaining: 10 },
      { method: 'GET', path: '/git/status', status: 503, remaining: 10 },
      { method: 'GET', path: '/git/log', status: 503, remaining: 10 },
    ]);
    await page.reload();
    await expect(page.locator('.ops-admin-diagnostics')).toContainText('Unavailable: Synthetic route failure (503)');
    await clearFaults(context.request);
    await page.reload();
    await expect(page.locator('[data-diagnostic="quality"]')).toContainText(/finding\(s\); \d+ validation error\(s\)/);
    await context.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/processes', roleId: 'admin', stateIds: ['process-docs.loading', 'process-docs.empty', 'process-docs.filters.url-reload-clear-search', 'process-docs.result-detail', 'process-docs.create-read-edit', 'process-docs.draft-management', 'process-docs.partial-save-failure', 'process-docs.backlinks', 'process-docs.validation', 'process-docs.git-failure'] },
      { route: '/#/admin', roleId: 'admin', stateIds: ['admin.loading', 'admin.empty', 'admin.ready-read-only', 'admin.failure'] },
    ]);
  });

  test('Users derive controls from the server role and deny spoofed or operator mutations', async ({ browser }, testInfo) => {
    const admin = await portalContext(browser, servers.admin);
    const operator = await portalContext(browser, servers.operator);
    const adminPage = await admin.newPage();
    await adminPage.goto('/#/users');
    await expect(adminPage.getByRole('button', { name: 'Add user' })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Add user' }).click();
    await adminPage.getByLabel('Name').fill('Synthetic Capability User');
    await adminPage.getByLabel('Email').fill(`${unique('capability')}@example.invalid`);
    await adminPage.getByLabel('Password').fill('synthetic-password');
    await adminPage.getByRole('button', { name: 'Create user' }).click();
    await expect(adminPage.locator('.ops-user-row', { hasText: 'Synthetic Capability User' })).toBeVisible();
    await adminPage.reload();
    let createdRow = adminPage.locator('.ops-user-row', { hasText: 'Synthetic Capability User' });
    await expect(createdRow).toBeVisible();
    await createdRow.getByRole('button', { name: 'Edit' }).click();
    await adminPage.getByLabel('Name').fill('Synthetic Capability User Updated');
    await adminPage.getByRole('button', { name: 'Save changes' }).click();
    createdRow = adminPage.locator('.ops-user-row', { hasText: 'Synthetic Capability User Updated' });
    await expect(createdRow).toBeVisible();
    await createdRow.getByRole('button', { name: 'Disable' }).click();
    await expect(createdRow).toContainText('disabled');
    await createdRow.getByRole('button', { name: 'Enable' }).click();
    await expect(createdRow).not.toContainText('disabled');

    await adminPage.getByRole('button', { name: 'Add user' }).click();
    await adminPage.getByRole('button', { name: 'Create user' }).click();
    // Validation is owned by the fields it is about (#204 slice 1).
    await expect(adminPage.locator('.ops-user-form .field-error').first()).toContainText('Name is required.');
    await expect(adminPage.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    await adminPage.getByRole('button', { name: 'Cancel' }).click();
    await setFaults(admin.request, [{ method: 'POST', path: '/api/users', status: 503 }]);
    await adminPage.getByRole('button', { name: 'Add user' }).click();
    await adminPage.getByLabel('Name').fill('Synthetic Failed User');
    await adminPage.getByLabel('Email').fill(`${unique('failed')}@example.invalid`);
    await adminPage.getByLabel('Password').fill('synthetic-password');
    await adminPage.getByRole('button', { name: 'Create user' }).click();
    await expect(adminPage.locator('.ops-user-form-result .form-feedback-error')).toContainText('Synthetic route failure (503)');
    await expect(adminPage.getByLabel('Name')).toHaveValue('Synthetic Failed User');
    await clearFaults(admin.request);

    const operatorPage = await operator.newPage();
    await operatorPage.goto('/#/users');
    await expect(operatorPage.getByRole('button', { name: 'Add user' })).toHaveCount(0);
    const before = await json(await operator.request.get('/api/users'));
    const denied = await operator.request.post('/api/users', {
      data: { name: 'Denied User', email: 'denied-user@example.invalid', role: 'admin', password: 'not-created' },
      headers: { 'x-user-id': ADMIN_ID },
    });
    expect(denied.status()).toBe(403);
    const after = await json(await operator.request.get('/api/users'));
    expect(after.users.map((user) => user.id)).toEqual(before.users.map((user) => user.id));
    expect(after.users.some((user) => user.name === 'Denied User')).toBe(false);
    await admin.close();
    await operator.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/users', roleId: 'operator', stateIds: ['users.operator-read-only', 'users.operator-403', 'users.spoof-denial'] },
      { route: '/#/users', roleId: 'admin', stateIds: ['users.admin-create', 'users.admin-edit', 'users.admin-disable', 'users.validation', 'users.failure'] },
    ]);
  });

  test('Inbox persists empty, validation, duplicate, archive, conflict, and failure behavior on the real backend', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const { context, page } = await portalPage(browser);
    await page.goto('/#/inbox');
    await expect(page.getByText('No matching intake')).toBeVisible();
    const capture = page.locator('.intake-panel').filter({ hasText: 'Capture a new intake item' });
    await capture.locator('summary').click();
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(capture.locator('.intake-create-feedback .form-feedback-error'))
      .toContainText('Add a note or title before capturing intake');

    const originalResponse = await context.request.post('/api/intake', { data: {
      source: 'manual', title: unique('Synthetic original intake'), note: 'Original public-safe request', dataClass: 'internal',
    } });
    expect(originalResponse.status()).toBe(201);
    const original = (await json(originalResponse)).item;
    const duplicateTitle = unique('Synthetic duplicate intake');
    await capture.locator('[data-intake-create-title]').fill(duplicateTitle);
    await capture.locator('[data-intake-create-note]').fill('A duplicate public-safe request');
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(page.locator('.intake-row', { hasText: duplicateTitle })).toBeVisible();
    await page.locator('.intake-row', { hasText: duplicateTitle }).click();
    const detail = page.locator('.intake-detail');
    await detail.getByText('Resolution actions').click();
    await detail.locator('summary').filter({ hasText: 'Mark duplicate' }).click();
    const duplicateAction = detail.locator('[data-intake-submit="mark-duplicate"]').locator('xpath=ancestor::details[1]');
    await duplicateAction.getByLabel('Reason').fill('Same synthetic upstream request');
    await duplicateAction.getByRole('button', { name: 'Mark duplicate' }).click();
    await expect(detail.getByRole('alert')).toHaveText('Duplicate of is required.');
    await expect(duplicateAction.getByLabel('Duplicate of')).toBeFocused();
    await expect(duplicateAction.getByLabel('Reason')).toHaveValue('Same synthetic upstream request');
    await duplicateAction.getByLabel('Duplicate of').fill(original.id);
    const duplicateId = new URLSearchParams(new URL(page.url()).hash.split('?')[1] || '').get('intakeId');
    expect(duplicateId).toBeTruthy();
    await setFaults(context.request, [{ method: 'POST', path: `/api/intake/${duplicateId}/mark-duplicate`, status: 409 }]);
    await duplicateAction.getByRole('button', { name: 'Mark duplicate' }).click();
    await expect(detail.getByRole('alert')).toContainText('Synthetic route failure (409)');
    const retryDuplicateAction = detail.locator('[data-intake-submit="mark-duplicate"]').locator('xpath=ancestor::details[1]');
    await expect(retryDuplicateAction.getByLabel('Reason')).toHaveValue('Same synthetic upstream request');
    await clearFaults(context.request);
    await expect(retryDuplicateAction.getByRole('button', { name: 'Mark duplicate' })).toBeVisible();
    await retryDuplicateAction.getByRole('button', { name: 'Mark duplicate' }).click();
    await expect(detail).toContainText('This item is duplicate and read-only');
    await expect(detail.locator('.intake-history')).toContainText('Marked as duplicate');

    const archiveResponse = await context.request.post('/api/intake', { data: {
      source: 'manual', title: unique('Synthetic archive intake'), note: 'Archive-safe request', dataClass: 'internal',
    } });
    const archiveItem = (await json(archiveResponse)).item;
    await page.goto(`/#/inbox?intakeId=${archiveItem.id}`);
    await detail.getByText('Resolution actions').click();
    await detail.locator('summary').filter({ hasText: 'Archive item' }).click();
    const archiveAction = detail.locator('[data-intake-submit="archive"]').locator('xpath=ancestor::details[1]');
    await archiveAction.getByLabel('Reason').fill('Synthetic retention complete');
    await archiveAction.getByRole('button', { name: 'Archive item' }).click();
    await expect(detail).toContainText('This item is archived and read-only');
    await expect(detail.locator('.intake-history')).toContainText('Archived');

    await page.goto('/#/inbox');
    await capture.locator('summary').click();
    const failedTitle = unique('Synthetic retained intake');
    await capture.locator('[data-intake-create-title]').fill(failedTitle);
    await capture.locator('[data-intake-create-note]').fill('Retain this safe input on failure');
    await setFaults(context.request, [{ method: 'POST', path: '/api/intake', status: 503 }]);
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(capture.locator('.intake-create-feedback .form-feedback-error'))
      .toContainText('Synthetic route failure (503)');
    await expect(capture.locator('[data-intake-create-title]')).toHaveValue(failedTitle);
    await clearFaults(context.request);
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(page.locator('.intake-row', { hasText: failedTitle })).toBeVisible();
    await context.close();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/inbox?intakeId=<id>',
      roleId: 'admin',
      stateIds: ['inbox.empty', 'inbox.duplicate', 'inbox.archived', 'inbox.validation', 'inbox.conflict', 'inbox.server-failure'],
    }]);
  });

  test('capability recovery states stay JSON-safe and reloadable across retained routes', async ({ browser }, testInfo) => {
    const { context, page } = await portalPage(browser, servers.noMailingConfig);
    await page.goto('/#/notifications');
    await expect(page.locator('.work-bell-empty')).toHaveText('No active notifications.');
    const notificationTaskResponse = await context.request.post('/api/tasks', { data: {
      description: unique('Synthetic notification retry'), date: '2026-08-11', status: 'waiting',
      waitingFor: 'Synthetic reply', followUpAt: '2026-08-01T09:00:00.000Z', comment: 'Public-safe notification recovery',
    } });
    expect(notificationTaskResponse.status()).toBe(201);
    const notificationTaskPayload = await json(notificationTaskResponse);
    const notificationTask = notificationTaskPayload.task || notificationTaskPayload;
    const notifications = (await json(await context.request.get('/api/notifications'))).notifications.items;
    const notification = notifications.find((item) => item.taskId === notificationTask.id);
    expect(notification).toBeTruthy();
    await page.reload();
    const notificationRow = page.locator('.work-bell-item', {
      has: page.locator(`button[data-dismiss-notification="${notification.id}"]`),
    });
    await expect(notificationRow).toBeVisible();
    await setFaults(context.request, [{ method: 'PUT', path: `/api/notifications/${notification.id}/dismiss`, status: 503 }]);
    await notificationRow.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(notificationRow.getByRole('alert')).toContainText('Select Dismiss to retry');
    await expect(notificationRow.getByRole('button', { name: /Dismiss notification/ })).toBeFocused();
    expect(((await json(await context.request.get('/api/notifications'))).notifications.items).some((item) => item.id === notification.id)).toBe(true);
    await clearFaults(context.request);
    await notificationRow.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(notificationRow).toHaveCount(0);

    for (const endpoint of [
      '/api/assistant-jobs/stale-capability',
      '/api/artifacts/stale-capability',
      '/api/users/stale-capability',
      '/api/newsletter-slots/stale-capability',
      '/api/calendar-items/stale-capability',
    ]) {
      const response = await context.request.get(endpoint);
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(await response.text()).not.toContain('<!doctype html>');
    }
    const workUnknown = await context.request.get('/work/api/not-a-retained-route');
    expect(workUnknown.status()).toBe(404);
    expect(workUnknown.headers()['content-type']).toContain('application/json');

    await setFaults(context.request, [{ method: 'GET', path: '/api/artifacts', status: 503, remaining: 10 }]);
    await page.goto('/#/artifacts');
    await expect(page.getByText('Artifact review index not connected')).toBeVisible();
    await clearFaults(context.request);
    await page.reload();
    await expect(page.getByText('Artifact review index not connected')).toHaveCount(0);
    await expect(page.locator('#library-title')).toHaveText('Tasks - Artifacts');
    await context.close();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/notifications',
      roleId: 'admin',
      stateIds: ['notifications.empty', 'notifications.dismiss-failure'],
    }]);
  });

  test('Git-authored templates stay read-only while recurring retains admin persistence and role denial', async ({ browser }, testInfo) => {
    const admin = await portalContext(browser, servers.admin);
    const operator = await portalContext(browser, servers.operator);
    const page = await admin.newPage();
    await page.goto('/#/recurring');
    await expect(page.getByRole('region', { name: 'Recurring operations' })).toContainText('No recurring configs yet');
    const id = unique('runtime-template');
    const projections = (await json(await admin.request.get('/api/templates'))).templates;
    const projection = projections.find((template) => template.type === 'synthetic-git-workflow');
    expect(projection).toBeTruthy();
    for (const context of [admin, operator]) {
      expect((await context.request.post('/api/templates', { data: { name: 'Retired mutation' } })).status()).toBe(405);
      expect((await context.request.put(`/api/templates/${projection.id}`, { data: { name: 'Retired mutation' } })).status()).toBe(405);
      expect((await context.request.delete(`/api/templates/${projection.id}`)).status()).toBe(405);
    }
    const card = await admin.request.post('/api/cards', { data: {
      title: `Projected ${id}`, anchorDate: '2026-08-12', templateId: projection.id,
    } });
    expect(card.status()).toBe(201);

    const recurringResponse = await admin.request.post('/api/recurring', { data: {
      description: `Synthetic recurring ${id}`, cronExpression: '0 9 * * 1', enabled: true,
    } });
    expect(recurringResponse.status()).toBe(201);
    const recurring = (await json(recurringResponse)).recurringConfig;
    const paused = await admin.request.put(`/api/recurring/${recurring.id}`, { data: { enabled: false } });
    expect(paused.status()).toBe(200);
    expect((await json(paused)).recurringConfig.enabled).toBe(false);
    const resumed = await admin.request.put(`/api/recurring/${recurring.id}`, { data: { enabled: true } });
    expect(resumed.status()).toBe(200);
    const deniedRecurring = await operator.request.post('/api/recurring', { data: {
      description: 'Denied operator recurring', cronExpression: '0 9 * * 1', enabled: true,
    } });
    expect(deniedRecurring.status()).toBe(403);
    expect((await operator.request.get('/api/recurring')).status()).toBe(200);
    expect((await operator.request.post('/api/recurring/generate', { data: { startDate: '2026-08-12', endDate: '2026-08-12' } })).status()).toBe(200);

    await page.goto(`/#/templates?templateId=${projection.id}`);
    const inspector = page.locator('.runtime-template-projection');
    await expect(inspector).toContainText('Synthetic Git-authored workflow');
    await expect(inspector).toContainText('workflow-templates/synthetic-git-workflow.yaml');
    await expect(page.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete template' })).toHaveCount(0);

    await page.goto('/#/recurring');
    await page.reload();
    const recurringSection = page.getByRole('region', { name: 'Recurring operations' });
    const recurringRow = recurringSection.locator('.ops-recurring-item', { hasText: `Synthetic recurring ${id}` });
    await expect(recurringRow).toBeVisible();
    await setFaults(admin.request, [{ method: 'PUT', path: `/api/recurring/${recurring.id}`, status: 503 }]);
    await recurringRow.getByRole('button', { name: 'Pause' }).click();
    // The failure belongs to the row whose control was used, not to a hidden
    // shell status line (#204 slice 1).
    await expect(recurringRow.locator('.recurring-row-error')).toContainText('Could not pause this schedule: Synthetic route failure (503)');
    await expect(recurringRow.locator('.recurring-row-error')).toContainText('Select Pause to retry.');
    await clearFaults(admin.request);
    await recurringRow.getByRole('button', { name: 'Pause' }).click();
    await expect(recurringSection.locator('.ops-recurring-item', { hasText: `Synthetic recurring ${id}` }).getByRole('button', { name: 'Resume' })).toBeVisible();
    await recurringSection.locator('.ops-recurring-item', { hasText: `Synthetic recurring ${id}` }).getByRole('button', { name: 'Resume' }).click();
    await expect(recurringSection.locator('.ops-recurring-item', { hasText: `Synthetic recurring ${id}` }).getByRole('button', { name: 'Pause' })).toBeVisible();

    await setFaults(admin.request, [{ method: 'GET', path: '/api/templates', status: 503, remaining: 10 }]);
    await page.goto('/#/templates');
    await expect(page.getByText('Runtime templates unavailable')).toBeVisible();
    await expect(page.locator('.runtime-template-inspector')).toContainText('Synthetic route failure (503)');
    await clearFaults(admin.request);
    await page.reload();
    await expect(page.locator('.runtime-template-row', { hasText: 'Synthetic Git-authored workflow' })).toBeVisible();

    const operatorPage = await operator.newPage();
    await operatorPage.goto('/#/templates');
    await expect(operatorPage.getByRole('button', { name: 'New runtime template' })).toHaveCount(0);
    await admin.close();
    await operator.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/recurring', roleId: 'admin', stateIds: ['recurring.empty', 'recurring.ready', 'recurring.pause', 'recurring.resume', 'recurring.failure'] },
      { route: '/#/recurring', roleId: 'operator', stateIds: ['recurring.permission-denied'] },
    ]);
  });
});
