/**
 * Browser evidence for the canonical `/content/*` asset contract (#205).
 *
 * The backend suites prove which repository paths the byte route accepts. This
 * spec proves the other half in a real browser: that the rendered document
 * editor turns a relative SOP screenshot reference and a repository-absolute
 * uploaded screenshot path into the matching `/content/images/**` routes, that
 * both images actually decode, and that the result is a readable page rather
 * than a broken layout. It runs its own offline server against a synthetic,
 * public-safe content root so no real operational document is involved.
 */

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot, REPO_ROOT } = require('./helpers/docs-content-root');
const {
  assertOwnedServerResponse,
  installServerExitDiagnostics,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');
const {
  CANONICAL_SHOT_WEBP,
  UPLOADED_SHOT_WEBP,
  CANONICAL_SHOT_SIZE,
  UPLOADED_SHOT_SIZE,
} = require('./helpers/issue-205-media-fixtures');

const SCREENSHOT_DIR = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-205');
const DOCUMENT_PATH = '/processes/media.md';

const FIXTURE_DOC_TITLE = 'Synthetic Editor Screenshots';
const FIXTURE_DOCUMENT = [
  '---',
  `title: ${FIXTURE_DOC_TITLE}`,
  'doc_type: reference',
  'summary: Synthetic public-safe fixtures for editor media resolution.',
  '---',
  '',
  `# ${FIXTURE_DOC_TITLE}`,
  '',
  'Both screenshots below exercise supported canonical image routes.',
  '',
  '![Canonical relative screenshot](../images/canonical-shot.webp)',
  '',
  '![Uploaded repository screenshot](content/images/processes/uploaded-shot.webp)',
  '',
].join('\n');

const server = {};
let ownedServer;

async function startServer() {
  ownedServer = await startOwnedTestServer({
    environment: {
      AUTH_BASE_URL: 'https://auth.example.test',
      AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
      AUTH_CLIENT_ID: 'synthetic-client',
      AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
      AUTH_LOGOUT_URL: 'http://127.0.0.1/',
      DTC_CACHE_ROOT: createDocsCacheRoot('issue-205-editor-media', {
        [`content${DOCUMENT_PATH}`]: FIXTURE_DOCUMENT,
        'content/images/canonical-shot.webp': CANONICAL_SHOT_WEBP,
        'content/images/processes/uploaded-shot.webp': UPLOADED_SHOT_WEBP,
      }),
      E2E_BROWSER_SESSION_USER_ID: '20500000-0000-4000-8000-000000000205',
      E2E_BROWSER_SESSION_USER_ROLE: 'admin',
      SKIP_AUTH: 'false',
      WORK_ENGINE_AUTH_MODE: 'portal',
    },
  });
  Object.assign(server, ownedServer);
}

async function stopServer() {
  await stopOwnedTestServer(ownedServer);
}

test.describe('issue 205 editor screenshots', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await startServer();
  });

  test.afterAll(stopServer);

  test('renders relative and uploaded screenshots through canonical content routes', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: server.baseURL,
      // Tall enough that both fixtures and the sticky editor footer fit in one
      // readable capture; the editor scrolls an inner container, so `fullPage`
      // alone cannot grow the screenshot.
      viewport: { width: 1440, height: 1500 },
    });
    const session = await context.request.get('/__e2e__/browser-session');
    expect(session.status()).toBe(200);
    assertOwnedServerResponse(ownedServer, session, 'editor media browser session');

    const page = await context.newPage();
    installServerExitDiagnostics(context, ownedServer, testInfo);
    const failures = [];
    page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console error: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      failures.push(`${request.method()} ${request.url()} failed: ${request.failure()?.errorText || 'unknown'}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.request().method()} ${response.url()} returned ${response.status()}`);
    });

    const canonicalLoaded = page.waitForResponse((response) =>
      response.url().endsWith('/content/images/canonical-shot.webp') && response.status() === 200);
    const uploadedLoaded = page.waitForResponse((response) =>
      response.url().endsWith('/content/images/processes/uploaded-shot.webp') && response.status() === 200);

    await page.goto(DOCUMENT_PATH);
    await expect(page.locator('#document-title')).toHaveValue(FIXTURE_DOC_TITLE);
    await expect(page.locator('#rendered-view')).toBeVisible();
    await expect(page.locator('#doc-state')).toBeHidden();

    const canonicalImage = page.getByRole('img', { name: 'Canonical relative screenshot' });
    const uploadedImage = page.getByRole('img', { name: 'Uploaded repository screenshot' });
    await expect(canonicalImage).toBeVisible();
    await expect(uploadedImage).toBeVisible();
    await expect(canonicalImage).toHaveAttribute('src', '/content/images/canonical-shot.webp');
    await expect(uploadedImage).toHaveAttribute('src', '/content/images/processes/uploaded-shot.webp');

    const imageBoxes = await page.locator('#rendered-view img').evaluateAll((images) =>
      images.map((image) => {
        const box = image.getBoundingClientRect();
        return {
          bottom: box.bottom,
          height: box.height,
          left: box.left,
          right: box.right,
          top: box.top,
          width: box.width,
        };
      }));
    expect(imageBoxes).toHaveLength(2);
    expect(imageBoxes.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
    const [canonicalBox, uploadedBox] = imageBoxes;
    expect(
      canonicalBox.bottom <= uploadedBox.top
        || uploadedBox.bottom <= canonicalBox.top
        || canonicalBox.right <= uploadedBox.left
        || uploadedBox.right <= canonicalBox.left,
    ).toBe(true);
    await expect(page.locator('#doc-state [data-docs-state="unavailable"]')).toHaveCount(0);
    await expect(page.locator('#editor-inline-status')).toBeHidden();

    const [canonicalResponse, uploadedResponse] = await Promise.all([
      canonicalLoaded,
      uploadedLoaded,
    ]);
    expect(new URL(canonicalResponse.url()).pathname).toBe('/content/images/canonical-shot.webp');
    expect(new URL(uploadedResponse.url()).pathname).toBe('/content/images/processes/uploaded-shot.webp');
    expect(canonicalResponse.headers()['content-type']).toBe('image/webp');
    expect(uploadedResponse.headers()['content-type']).toBe('image/webp');

    await expect.poll(async () => Promise.all([
      canonicalImage.evaluate((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      })),
      uploadedImage.evaluate((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      })),
    ])).toEqual([
      { complete: true, naturalWidth: CANONICAL_SHOT_SIZE.width, naturalHeight: CANONICAL_SHOT_SIZE.height },
      { complete: true, naturalWidth: UPLOADED_SHOT_SIZE.width, naturalHeight: UPLOADED_SHOT_SIZE.height },
    ]);

    // Both images must render at a readable size, stack in document order, and
    // stay fully inside the capture and clear of the sticky editor footer, so
    // the screenshot is usable evidence rather than a cropped or overlapped view.
    expect(canonicalBox.width).toBeGreaterThanOrEqual(240);
    expect(canonicalBox.height).toBeGreaterThanOrEqual(120);
    expect(uploadedBox.width).toBeGreaterThanOrEqual(240);
    expect(uploadedBox.height).toBeGreaterThanOrEqual(120);
    expect(uploadedBox.top).toBeGreaterThan(canonicalBox.bottom);

    const footerBox = await page.locator('.document-editor-footer').boundingBox();
    const viewport = page.viewportSize();
    for (const box of [canonicalBox, uploadedBox]) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(footerBox.y);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.bottom).toBeLessThanOrEqual(viewport.height);
    }

    const metrics = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'editor-canonical-and-uploaded-screenshots.png'),
      fullPage: true,
    });
    expect(failures).toEqual([]);
    await context.close();
  });
});
