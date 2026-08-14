/**
 * Issue #192 — a docs outage must read as an outage, not as an empty corpus.
 *
 * Both journeys run against real servers. The outage server points
 * `DTC_CACHE_ROOT` at a genuinely missing directory so `GET /docs`,
 * `GET /docs/process-quality` and `GET /search` answer with #190's real 503;
 * browser request interception is forbidden by `frontend-capabilities.json`
 * (`evidencePolicy.browserInterceptionAllowed: false`).
 *
 * The deliberate 503 collides with #190's "any response >= 400 is a failure"
 * observer. It is resolved by partitioning the collected entries, never by
 * relaxing the collector: entries attributable to the deliberate docs outage
 * are separated out, everything else must be empty, and at least one docs 503
 * must have been observed so the spec cannot pass against a healthy server.
 */
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { recordCapabilityEvidence } = require('./helpers/capability-evidence');
const { createDocsCacheRoot, missingDocsCacheRoot } = require('./helpers/docs-content-root');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const SCREENSHOT_DIR = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-192');
const OUTAGE_MESSAGE_PREFIX = 'Docs content root is unavailable:';
// `buildOperationsReferenceLinks` indexes this exact repository path, so the
// healthy corpus can be proven from the Docs surface itself.
const DEEP_LINK_PATH = '/overview/reference/schedule.md';
const FIXTURE_DOC_TITLE = 'Synthetic Outage Fixture Schedule';
const FIXTURE_DOC = [
  '---',
  'id: ref.synthetic.outage-fixture-schedule',
  `title: ${FIXTURE_DOC_TITLE}`,
  'summary: Synthetic reference used only by the docs outage spec.',
  'doc_type: reference',
  'tags: [synthetic]',
  'systems: [dataops]',
  '---',
  '',
  `# ${FIXTURE_DOC_TITLE}`,
  '',
  'Synthetic public-safe content for the docs outage spec.',
  '',
].join('\n');

const servers = {
  outage: {
    userId: '19200000-0000-4000-8000-000000000011',
    role: 'admin',
    cacheRoot: () => missingDocsCacheRoot('issue-192-docs-outage'),
  },
  empty: {
    userId: '19200000-0000-4000-8000-000000000012',
    role: 'admin',
    cacheRoot: () => createDocsCacheRoot('issue-192-docs-empty'),
  },
  healthy: {
    userId: '19200000-0000-4000-8000-000000000013',
    role: 'admin',
    cacheRoot: () => createDocsCacheRoot('issue-192-docs-healthy', {
      [`content${DEEP_LINK_PATH}`]: FIXTURE_DOC,
    }),
  },
};

/**
 * Reserve `count` distinct free ports.
 *
 * Every listener stays open until all ports are chosen, so two servers in the
 * same run cannot be handed the same port.
 */
async function reserveFreePorts(count) {
  const listeners = [];
  for (let index = 0; index < count; index += 1) {
    listeners.push(await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.once('error', reject);
      listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve(listener));
    }));
  }
  const ports = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  })));
  return ports;
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      try {
        const response = await fetch(`${server.baseURL}/api/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() >= deadline) {
        return reject(new Error(`docs-outage server did not start\n${server.stderr}`));
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function startServer(server, port) {
  server.port = port;
  server.baseURL = `http://127.0.0.1:${port}`;
  server.stderr = '';
  server.process = spawn('npx', ['tsx', 'scripts/test-server.ts'], {
    cwd: BACKEND_ROOT,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      IS_LOCAL: 'true',
      SKIP_AUTH: 'false',
      WORK_ENGINE_AUTH_MODE: 'portal',
      DATAOPS_DOCS_DOMAIN: '1',
      DTC_OFFLINE: '1',
      DTC_CACHE_ROOT: server.cacheRoot(),
      FRONTEND_ROOT: path.join(REPO_ROOT, 'frontend'),
      AUTH_BASE_URL: 'https://auth.example.test',
      AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
      AUTH_CLIENT_ID: 'synthetic-client',
      AUTH_CALLBACK_URL: `${server.baseURL}/auth/callback`,
      AUTH_LOGOUT_URL: `${server.baseURL}/`,
      E2E_BROWSER_SESSION_USER_ID: server.userId,
      E2E_BROWSER_SESSION_USER_ROLE: server.role,
      GITHUB_TOKEN: '',
      GITHUB_TOKEN_SECRET_NAME: '',
      AWS_EC2_METADATA_DISABLED: 'true',
      CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
      CONVERSATIONAL_EXECUTION_ENABLED: 'false',
      CONVERSATIONAL_ENABLED_PLUGINS: 'none',
      CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
      CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
      CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.process.stderr.on('data', (data) => {
    server.stderr += data.toString();
  });
  await waitForServer(server);
}

async function stopServer(server) {
  if (!server.process) return;
  const child = server.process;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  server.process = null;
}

/** The docs endpoints that go down together when the content root is missing. */
function isDocsUrl(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === '/docs' || pathname.startsWith('/docs/') || pathname === '/search';
  } catch {
    return false;
  }
}

function describeEntry(entry) {
  if (entry.kind === 'pageerror') return `pageerror url=${entry.url} message=${entry.message}`;
  if (entry.kind === 'console') {
    return `console url=${entry.url} line=${entry.line} column=${entry.column} message=${entry.message}`;
  }
  if (entry.kind === 'requestfailed') {
    return `requestfailed method=${entry.method} url=${entry.url} resource=${entry.resource} failure=${entry.failure}`;
  }
  return `response method=${entry.method} url=${entry.url} resource=${entry.resource} status=${entry.status}`;
}

/**
 * Same observer shape as #190: page errors, console errors, failed requests,
 * and every response >= 400. Entries are structured so a journey can partition
 * them; nothing is filtered away at collection time.
 */
function observeErrors(page) {
  const entries = [];
  page.on('pageerror', (error) => entries.push({ kind: 'pageerror', url: page.url(), message: error.message }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    entries.push({
      kind: 'console',
      url: location.url || page.url(),
      line: location.lineNumber ?? 'unknown',
      column: location.columnNumber ?? 'unknown',
      message: message.text(),
    });
  });
  page.on('requestfailed', (request) => entries.push({
    kind: 'requestfailed',
    method: request.method(),
    url: request.url(),
    resource: request.resourceType(),
    failure: request.failure()?.errorText || 'unknown',
  }));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    entries.push({
      kind: 'response',
      method: request.method(),
      url: response.url(),
      resource: request.resourceType(),
      status: response.status(),
    });
  });
  return entries;
}

/**
 * Assert that the only observed failures are the deliberate docs outage.
 *
 * Attributable entries are the docs-domain 503 responses themselves, any
 * response a journey explicitly declares as another consequence of the same
 * outage, and the browser's own resource-failure console lines for exactly
 * those URLs. Everything else must be empty, and the outage must really have
 * happened, so this cannot pass against a healthy server.
 *
 * @param {Array<object>} entries collected observer entries
 * @param {(entry: object) => boolean} [alsoAttributable] extra declared responses
 */
function expectOnlyDeliberateDocsOutage(entries, alsoAttributable = () => false) {
  const docs503s = entries.filter(
    (entry) => entry.kind === 'response' && entry.status === 503 && isDocsUrl(entry.url),
  );
  const outageResponses = new Set([
    ...docs503s,
    ...entries.filter((entry) => entry.kind === 'response' && alsoAttributable(entry)),
  ]);
  const outageUrls = new Set([...outageResponses].map((entry) => entry.url));
  const attributable = new Set([
    ...outageResponses,
    ...entries.filter((entry) => entry.kind === 'console' && outageUrls.has(entry.url)),
  ]);
  const unexpected = entries.filter((entry) => !attributable.has(entry)).map(describeEntry);
  expect(unexpected).toEqual([]);
  expect(docs503s.length).toBeGreaterThan(0);
  expect(entries.filter((entry) => entry.kind === 'pageerror').map(describeEntry)).toEqual([]);
  expect(entries.filter((entry) => entry.kind === 'requestfailed').map(describeEntry)).toEqual([]);
}

async function portalContext(browser, server, options = {}) {
  const context = await browser.newContext({ baseURL: server.baseURL, ...options });
  const response = await context.request.get('/__e2e__/browser-session');
  expect(response.status()).toBe(200);
  return context;
}

test.describe('issue 192 docs outage versus empty corpus', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const entries = Object.values(servers);
    const ports = await reserveFreePorts(entries.length);
    await Promise.all(entries.map((server, index) => startServer(server, ports[index])));
  });

  test.afterAll(async () => {
    await Promise.all(Object.values(servers).map(stopServer));
  });

  test('Docs reports an unreachable corpus as an outage with the server message', async ({ browser }, testInfo) => {
    const context = await portalContext(browser, servers.outage, { viewport: { width: 1440, height: 900 } });
    const identity = await context.request.get('/api/me');
    expect(identity.status()).toBe(200);
    expect((await identity.json()).user.role).toBe('admin');

    const page = await context.newPage();
    const entries = observeErrors(page);
    await page.goto('/#/processes');
    const outage = page.locator('.ops-surface-docs [data-docs-state="unavailable"]');
    await expect(outage).toBeVisible();
    await expect(outage.locator('strong')).toHaveText('Process documents are unavailable');
    await expect(outage).toContainText(OUTAGE_MESSAGE_PREFIX);
    await expect(outage).toContainText('issue-192-docs-outage');
    await expect(outage).toContainText('DTC_CACHE_ROOT');
    await expect(page.locator('[data-docs-state="empty"]')).toHaveCount(0);
    await expect(page.getByText('No process documents yet')).toHaveCount(0);
    // The outage state precedes the quality panel an operator would otherwise
    // misread as the only problem.
    const order = await page.locator('.ops-processes-surface > *').evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.docsState || node.className));
    expect(order.indexOf('unavailable')).toBeLessThan(
      order.findIndex((value) => String(value).includes('ops-quality-drilldown')),
    );
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'processes-outage.png'), fullPage: true });

    expectOnlyDeliberateDocsOutage(entries);
    await context.close();
    recordCapabilityEvidence(testInfo, [
      { route: '/#/processes', roleId: 'admin', stateIds: ['process-docs.unavailable'] },
    ]);
  });

  test('Home and search attribute the outage to process documents', async ({ browser }) => {
    const context = await portalContext(browser, servers.outage, { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const entries = observeErrors(page);

    await page.goto('/#/');
    await expect(page.locator('.operations-home-daily')).toBeVisible();
    const banner = page.locator('.operations-home-daily [data-docs-state="unavailable"]');
    await expect(banner).toHaveCount(1);
    await expect(banner.locator('strong')).toHaveText('Process documents are unavailable');
    await expect(banner).toContainText(OUTAGE_MESSAGE_PREFIX);
    // Work content keeps its own independent state next to the docs banner.
    await expect(page.locator('.home-status-strip')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'home-outage.png'), fullPage: true });

    await page.locator('#search-input').fill('schedule');
    const sourceState = page.locator('.search-source-state');
    await expect(sourceState).toBeVisible();
    await expect(sourceState).toContainText('Process documents could not load.');
    await expect(sourceState).not.toContainText('Some work sources could not load');
    await expect(sourceState.locator('li')).toContainText(
      `process documents: ${OUTAGE_MESSAGE_PREFIX}`,
    );

    expectOnlyDeliberateDocsOutage(entries);
    await context.close();
  });

  test('a bookmarked document URL shows the outage instead of silently rendering Home', async ({ browser }) => {
    const context = await portalContext(browser, servers.outage, { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const entries = observeErrors(page);

    await page.goto(DEEP_LINK_PATH);
    const outage = page.locator('#doc-state [data-docs-state="unavailable"]');
    await expect(outage).toBeVisible();
    await expect(outage.locator('strong')).toHaveText('Process documents are unavailable');
    await expect(outage).toContainText(OUTAGE_MESSAGE_PREFIX);
    await expect(page).toHaveURL(`${servers.outage.baseURL}${DEEP_LINK_PATH}`);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'editor');
    // The operator is looking at the document view, not silently at Home.
    await expect(page.locator('.operations-home-daily')).toBeHidden();
    await expect(page.locator('#editor')).toBeDisabled();
    await expect(page.locator('#save-button')).toBeDisabled();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'editor-outage.png'), fullPage: true });

    // The single-document route still answers 404 while the whole content root
    // is missing; #190 made only the collection routes honest, and changing
    // that is out of scope here. The frontend therefore reports this document
    // failure from the shared snapshot, and the spec declares that one 404 as
    // another consequence of the same deliberate outage.
    expectOnlyDeliberateDocsOutage(entries, (entry) => {
      if (entry.status !== 404) return false;
      const url = new URL(entry.url);
      return url.pathname === '/docs' && url.searchParams.get('path') === `content${DEEP_LINK_PATH}`;
    });
    await context.close();
  });

  test('the outage stays readable at mobile width', async ({ browser }) => {
    const context = await portalContext(browser, servers.outage, { viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const entries = observeErrors(page);

    await page.goto('/#/processes');
    const outage = page.locator('.ops-surface-docs [data-docs-state="unavailable"]');
    await expect(outage).toBeVisible();
    await expect(outage).toContainText(OUTAGE_MESSAGE_PREFIX);
    const metrics = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'processes-outage-mobile.png'), fullPage: true });

    expectOnlyDeliberateDocsOutage(entries);
    await context.close();
  });

  test('a reachable but empty corpus reads as empty and produces no HTTP failures', async ({ browser }) => {
    const context = await portalContext(browser, servers.empty, { viewport: { width: 1440, height: 900 } });

    const docs = await context.request.get('/docs');
    expect(docs.status()).toBe(200);
    expect((await docs.json()).documents).toEqual([]);

    // One route per page: every journey ends on the document it opened, so no
    // navigation can abort another page's still-pending bootstrap requests.
    const docsPage = await context.newPage();
    const docsErrors = observeErrors(docsPage);
    await docsPage.goto('/#/processes');
    const empty = docsPage.locator('.ops-surface-docs [data-docs-state="empty"]');
    await expect(empty).toBeVisible();
    await expect(empty.locator('strong')).toHaveText('No process documents yet');
    await expect(empty).toContainText('the process-document corpus contains no documents');
    await expect(docsPage.locator('[data-docs-state="unavailable"]')).toHaveCount(0);
    await expect(docsPage.getByText('Process documents are unavailable')).toHaveCount(0);
    await expect(docsPage.getByText(OUTAGE_MESSAGE_PREFIX)).toHaveCount(0);
    await docsPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'processes-empty.png'), fullPage: true });
    // An empty corpus is not a failure: the plain #190 assertion must hold.
    expect(docsErrors.map(describeEntry)).toEqual([]);

    const homePage = await context.newPage();
    const homeErrors = observeErrors(homePage);
    // Gate the Home check on the real bootstrap response, armed before the
    // navigation. The sidebar skeleton cannot gate anything: its section is
    // unconditionally display:none, so waiting for it to hide is a tautology.
    const homeCatalogLoaded = homePage.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET'
          && url.pathname === '/docs'
          && !url.searchParams.has('path')
          && response.status() === 200;
      },
    );
    await homePage.goto('/#/');
    await homeCatalogLoaded;
    await expect(homePage.locator('.operations-home-daily')).toBeVisible();
    // Home repaints after its own bootstrap resolves, so this marker proves a
    // post-bootstrap render happened before absence is asserted.
    await expect(
      homePage.locator('.operations-home-daily[data-operations-work-loaded="true"]'),
    ).toBeVisible();
    await expect(homePage.locator('[data-docs-state]')).toHaveCount(0);
    expect(homeErrors.map(describeEntry)).toEqual([]);

    await context.close();
  });

  test('a healthy corpus renders neither state and still opens a bookmarked document', async ({ browser }) => {
    const context = await portalContext(browser, servers.healthy, { viewport: { width: 1440, height: 900 } });

    const docsPage = await context.newPage();
    const docsErrors = observeErrors(docsPage);
    await docsPage.goto('/#/processes');
    // The surface must list this run's own corpus first. Without that proof
    // "neither state renders" would also be true before the catalog loaded.
    await expect(
      docsPage.locator('.ops-surface-docs .ops-reference-link', { hasText: FIXTURE_DOC_TITLE }),
    ).toBeVisible();
    await expect(docsPage.locator('[data-docs-state]')).toHaveCount(0);
    expect(docsErrors.map(describeEntry)).toEqual([]);

    // The bookmarked URL is opened on a fresh page. Reusing the page above
    // would be a cross-document navigation away from its in-flight work
    // bootstrap, and Chromium reports those aborts as failed requests.
    const deepLinkPage = await context.newPage();
    const deepLinkErrors = observeErrors(deepLinkPage);
    await deepLinkPage.goto(DEEP_LINK_PATH);
    await expect(deepLinkPage.locator('#document-title')).toHaveValue(FIXTURE_DOC_TITLE);
    await expect(deepLinkPage.locator('#doc-state')).toBeHidden();
    expect(deepLinkErrors.map(describeEntry)).toEqual([]);

    await context.close();
  });
});
