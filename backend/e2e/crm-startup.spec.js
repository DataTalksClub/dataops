/**
 * Package G — CRM cold-start contention.
 *
 * Proves, against real isolated servers with synthetic fixtures only, that a
 * cold CRM load prioritizes the requested surface: the pipeline request fires
 * while the shared work/recurring/quality snapshot fanout stays deferred
 * until a surface that reads it commits (Tasks/Templates/Recurring), an
 * explicit refresh runs, or a docs outage is shown honestly without blocking
 * CRM or work.
 *
 * Request graphs, timings, and screenshots land outside the public repo in
 * ~/tmp/agent-reports/crm-startup/ (DATAOPS_SCREENSHOT_DIR overrides).
 */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const {
  createDocsCacheRoot,
  missingDocsCacheRoot,
} = require('./helpers/docs-content-root');

const OUT_DIR = process.env.DATAOPS_SCREENSHOT_DIR
  || path.join(require('node:os').tmpdir(), 'crm-startup');
const FIXTURE_DOC = [
  '---',
  'id: ref.synthetic.startup-fixture-schedule',
  'title: Synthetic Startup Fixture Schedule',
  'summary: Synthetic reference used only by the CRM startup spec.',
  'doc_type: reference',
  'tags: [synthetic]',
  'systems: [dataops]',
  '---',
  '',
  '# Synthetic Startup Fixture Schedule',
  '',
  'Synthetic public-safe content for the CRM startup spec.',
  '',
].join('\n');

// Work-snapshot endpoints that must stay quiet while a clean self-loading
// route (CRM) is all the operator asked for.
const DEFERRED_PATHS = [
  '/api/tasks',
  '/api/cards',
  '/api/users',
  '/api/templates',
  '/api/resources',
  '/api/recurring',
  '/docs/process-quality',
];

function isDeferredUrl(url) {
  try {
    const { pathname } = new URL(url);
    return DEFERRED_PATHS.some((deferred) => pathname === deferred || pathname.startsWith(`${deferred}/`));
  } catch {
    return false;
  }
}

function isTrackedUrl(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.includes('/api/') || pathname === '/docs' || pathname.startsWith('/docs/');
  } catch {
    return false;
  }
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function watchRequests(page) {
  const t0 = Date.now();
  const started = new Map();
  const finished = [];
  const failed = [];
  const errors = [];
  page.on('request', (request) => {
    if (!isTrackedUrl(request.url())) return;
    started.set(request, Date.now() - t0);
  });
  page.on('response', (response) => {
    const request = response.request();
    if (!started.has(request)) return;
    finished.push({
      method: request.method(),
      path: shortUrl(response.url()),
      startMs: started.get(request),
      endMs: Date.now() - t0,
      status: response.status(),
    });
  });
  page.on('requestfailed', (request) => {
    if (!started.has(request)) return;
    failed.push({
      method: request.method(),
      path: shortUrl(request.url()),
      startMs: started.get(request),
      failure: request.failure()?.errorText || 'unknown',
    });
  });
  page.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
  return { finished, failed, errors };
}

function writeGraph(name, payload) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(payload, null, 2)}\n`);
}

async function seedCrm(baseURL) {
  const api = async (kind, data) => {
    const response = await fetch(`${baseURL}/api/sponsor-crm/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`${kind}: HTTP ${response.status}`);
    return response.json();
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const company = await api('organizations', {
    displayName: 'Synthetic Startup Co',
    domain: 'synthetic-startup.example.test',
    lastInboundAt: today,
    lastOutboundAt: yesterday.toISOString().slice(0, 10),
  });
  await api('contacts', {
    organizationId: company.id,
    name: 'Synthetic Startup Contact',
    emails: ['contact@synthetic-startup.example.test'],
    primary: true,
  });
  for (let index = 0; index < 65; index += 1) {
    await api('deals', {
      organizationId: company.id,
      status: index === 64 ? 'lost' : index < 3 ? 'agreed' : 'open',
      title: `Synthetic startup agreement ${index}`,
      amountEur: 1500,
    });
  }
}

const servers = {
  healthy: {},
  outage: {},
};

test.describe('crm cold-start contention', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    servers.healthy.cacheRoot = createDocsCacheRoot('crm-startup-healthy', {
      'content/reference/synthetic-startup.md': FIXTURE_DOC,
    });
    servers.outage.cacheRoot = missingDocsCacheRoot('crm-startup-outage');
    await Promise.all([
      (async () => {
        await startOwnedTestServer({
          target: servers.healthy,
          environment: { DTC_CACHE_ROOT: servers.healthy.cacheRoot },
        });
        const workSeed = await seedOperationsData(servers.healthy.baseURL);
        await seedCrm(servers.healthy.baseURL);
        servers.healthy.seed = workSeed;
      })(),
      (async () => {
        await startOwnedTestServer({
          target: servers.outage,
          environment: { DTC_CACHE_ROOT: servers.outage.cacheRoot },
        });
        await seedCrm(servers.outage.baseURL);
      })(),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([stopOwnedTestServer(servers.healthy), stopOwnedTestServer(servers.outage)]);
  });

  test('cold CRM loads pipeline rows without the work snapshot fanout', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const { finished, failed, errors } = watchRequests(page);
    const t0 = Date.now();
    await page.goto(`${servers.healthy.baseURL}/sponsors/pipeline`, { waitUntil: 'commit' });
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    const firstRowsMs = Date.now() - t0;
    await expect(page.locator('.crm-funnel-table tbody tr')).toHaveCount(30);

    const early = finished.filter((entry) => entry.endMs <= firstRowsMs + 50);
    const earlyDeferred = early.filter((entry) => isDeferredUrl(entry.path));
    expect(earlyDeferred.map((entry) => `${entry.method} ${entry.path}`)).toEqual([]);
    expect(finished.some((entry) => entry.path.includes('/api/sponsor-crm/pipeline'))).toBe(true);
    expect(failed.map((entry) => `${entry.method} ${entry.path}`)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(OUT_DIR, 'crm-startup-result-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => globalThis.dakitShell?.toggleDrawer(document.querySelector('.dk-shell'), false));
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(OUT_DIR, 'crm-startup-result-mobile.png') });
    writeGraph('crm-startup-result-graph.json', {
      journey: 'cold /sponsors/pipeline',
      seed: servers.healthy.seed,
      firstRowsMs,
      finished,
      failed,
      conditions: 'local owned isolated server, headless Chromium, synthetic data; NOT production',
    });
    await context.close();
    void testInfo;
  });

  test('work surfaces initialize on navigation and CRM stays reachable', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const { finished, failed, errors } = watchRequests(page);
    await page.goto(`${servers.healthy.baseURL}/sponsors/pipeline`, { waitUntil: 'commit' });
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();

    // Cold CRM -> Tasks: the deferred work snapshot must fire now and the
    // queue must render from it.
    await page.getByRole('link', { name: 'Queue', exact: true }).click();
    await expect(page.locator('.ops-work-queue')).toBeVisible();
    await expect.poll(
      () => finished.some((entry) => entry.path.startsWith('/api/tasks?')),
      { timeout: 15000 },
    ).toBe(true);
    await expect.poll(
      () => finished.some((entry) => entry.path.startsWith('/api/cards?')),
      { timeout: 15000 },
    ).toBe(true);

    // Templates and Recurring render through their own sections.
    await page.getByRole('link', { name: 'Templates', exact: true }).click();
    await expect(page.locator('.ops-surface-templates')).toBeVisible();
    await page.getByRole('link', { name: 'Recurring', exact: true }).click();
    await expect(page.locator('.ops-surface-recurring')).toBeVisible();

    // Back to CRM without losing the surface: rows render, filters survive.
    await page.getByRole('link', { name: 'CRM', exact: true }).click();
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    await expect(page).toHaveURL(/\/sponsors\/pipeline/);

    // Explicit refresh still works from a self-loading surface.
    const tasksBefore = finished.filter((entry) => entry.path.startsWith('/api/tasks?')).length;
    await page.evaluate(() => window.__dataopsRefreshWork());
    await expect.poll(
      () => finished.filter((entry) => entry.path.startsWith('/api/tasks?')).length,
      { timeout: 15000 },
    ).toBeGreaterThan(tasksBefore);

    expect(failed.map((entry) => `${entry.method} ${entry.path}`)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(OUT_DIR, 'crm-startup-journey-desktop.png') });
    writeGraph('crm-startup-journey-graph.json', {
      journey: 'cold CRM -> Tasks -> Templates -> Recurring -> CRM + explicit refresh',
      finished,
      failed,
      conditions: 'local owned isolated server, headless Chromium, synthetic data; NOT production',
    });
    await context.close();
  });

  test('rapid CRM/Tasks navigation settles on the requested surface', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const { failed, errors } = watchRequests(page);
    await page.goto(`${servers.healthy.baseURL}/sponsors/pipeline`, { waitUntil: 'commit' });
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    await page.getByRole('link', { name: 'Queue', exact: true }).click();
    await page.getByRole('link', { name: 'CRM', exact: true }).click();
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    await expect(page).toHaveURL(/\/sponsors\/pipeline/);
    // Back/forward still re-render through the committed routes.
    await page.goBack();
    await expect(page.locator('.ops-work-queue')).toBeVisible();
    await page.goForward();
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    expect(failed.map((entry) => `${entry.method} ${entry.path}`)).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  test('a docs outage neither blocks CRM nor work', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const { finished, failed, errors } = watchRequests(page);
    await page.goto(`${servers.outage.baseURL}/sponsors/pipeline`, { waitUntil: 'commit' });
    await expect(page.locator('.crm-funnel-table tbody tr').first()).toBeVisible();
    const docs503s = finished.filter((entry) => entry.status === 503);
    expect(docs503s.length).toBeGreaterThan(0);
    expect(docs503s.every((entry) => {
      try {
        const { pathname } = new URL(entry.path, 'http://localhost');
        return pathname === '/docs' || pathname.startsWith('/docs/') || pathname === '/search';
      } catch {
        return false;
      }
    })).toBe(true);
    // The work queue keeps its own independent state during a docs outage.
    await page.goto(`${servers.outage.baseURL}/`);
    await expect(page.locator('.ops-work-queue')).toBeVisible();
    const nonDocsFailures = [
      ...failed.map((entry) => `${entry.method} ${entry.path}`),
      ...finished
        .filter((entry) => entry.status >= 400 && entry.status !== 503)
        .map((entry) => `${entry.method} ${entry.path} -> ${entry.status}`),
    ];
    expect(nonDocsFailures).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(OUT_DIR, 'crm-startup-outage-desktop.png') });
    writeGraph('crm-startup-outage-graph.json', {
      journey: 'docs outage: cold CRM -> queue',
      finished,
      failed,
      conditions: 'local owned isolated server with missing docs root, headless Chromium; NOT production',
    });
    await context.close();
  });
});
