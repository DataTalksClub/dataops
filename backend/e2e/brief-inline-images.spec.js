const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// 1x1 PNG (67 bytes)
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

let server;
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('brief-inline-images') },
  });
});

test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

test('sponsor and guest brief editors upload images durably and render them inline immediately, with visible errors for broken/filename images', async ({ page, request }) => {
  test.setTimeout(90_000);

  // 1. Sponsor brief (newsletter-primary)
  const nlTplRes = await request.post(`${server.baseURL}/__e2e__/template-fixtures`, {
    data: {
      name: 'Synthetic newsletter',
      type: 'newsletter',
      sourcePath: 'workflow-templates/synthetic-newsletter.yaml',
      taskDefinitions: [],
    },
  });
  expect(nlTplRes.status()).toBe(201);
  const { template: nlTpl } = await nlTplRes.json();

  const nlCardRes = await request.post(`${server.baseURL}/api/cards`, {
    data: { templateId: nlTpl.id, title: 'Sponsor brief image test', anchorDate: '2026-12-01' },
  });
  expect(nlCardRes.status()).toBe(201);
  const { card: nlCard } = await nlCardRes.json();

  const sDocRes = await request.post(`${server.baseURL}/api/sponsor-docs`, {
    data: {
      cardId: nlCard.id,
      template: 'newsletter-main',
      sponsorName: 'Acme Corp',
      autoSendEmail: false,
    },
  });
  expect(sDocRes.status()).toBe(201);
  const { doc: sponsorDoc } = await sDocRes.json();

  await page.setExtraHTTPHeaders({ 'x-sponsor-doc-anonymous': 'true' });
  await page.goto(`${server.baseURL}/sponsor-docs/${sponsorDoc.id}?code=${encodeURIComponent(sponsorDoc.accessCode)}`);
  await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();

  await page.locator('[data-sponsor-visual-upload="graphicsUrl"]').setInputFiles({
    name: 'sponsor-banner.png',
    mimeType: 'image/png',
    buffer: VALID_PNG,
  });

  const sponsorInlineImg = page.locator('img[data-sponsor-visual-image="graphicsUrl"]');
  await expect(sponsorInlineImg).toBeVisible();
  await expect.poll(() => sponsorInlineImg.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);

  const previewImg = page.locator('img[data-sponsor-preview-image]');
  await expect(previewImg).toBeVisible();
  await expect.poll(() => previewImg.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);

  const hostedSponsorUrl = await page.locator('#sponsor-field-graphicsUrl').inputValue();
  expect(hostedSponsorUrl).toMatch(/\/api\/public-images\/[0-9a-f-]+\.png$/);

  await page.locator('[data-sponsor-action="save-draft"]').click();
  await expect(page.locator('[data-sponsor-feedback]')).toContainText('Saved draft');

  await page.reload();
  await expect(sponsorInlineImg).toBeVisible();
  await expect.poll(() => sponsorInlineImg.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);

  // Broken image URL shows visible error, not a silent blank
  await page.locator('#sponsor-field-graphicsUrl').fill('/api/public-images/00000000-0000-4000-8000-000000000000.png');
  await expect(page.locator('[data-sponsor-visual-error="graphicsUrl"]')).toBeVisible();
  await expect(page.locator('[data-sponsor-visual-error="graphicsUrl"]')).toContainText('Could not load image');

  // 2. Guest brief (webinar)
  await page.setExtraHTTPHeaders({});
  const webTplRes = await request.post(`${server.baseURL}/__e2e__/template-fixtures`, {
    data: {
      name: 'Synthetic webinar',
      type: 'webinar',
      sourcePath: 'workflow-templates/synthetic-webinar.yaml',
      taskDefinitions: [],
    },
  });
  expect(webTplRes.status()).toBe(201);
  const { template: webTpl } = await webTplRes.json();

  const webCardRes = await request.post(`${server.baseURL}/api/cards`, {
    data: { templateId: webTpl.id, title: 'Guest brief image test', anchorDate: '2026-12-08', people: ['Ada'] },
  });
  expect(webCardRes.status()).toBe(201);
  const { card: webCard } = await webCardRes.json();

  const gDocRes = await request.post(`${server.baseURL}/api/sponsor-docs`, {
    data: {
      cardId: webCard.id,
      template: 'webinar',
      autoSendEmail: false,
    },
  });
  expect(gDocRes.status()).toBe(201);
  const { doc: guestDoc } = await gDocRes.json();

  await page.setExtraHTTPHeaders({ 'x-sponsor-doc-anonymous': 'true' });
  await page.goto(`${server.baseURL}/webinar-docs/${guestDoc.id}?code=${encodeURIComponent(guestDoc.accessCode)}`);
  await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();

  await page.locator('[data-sponsor-visual-upload="photoUrl"]').setInputFiles({
    name: 'guest-portrait.png',
    mimeType: 'image/png',
    buffer: VALID_PNG,
  });

  const guestInlineImg = page.locator('img[data-sponsor-visual-image="photoUrl"]');
  await expect(guestInlineImg).toBeVisible();
  await expect.poll(() => guestInlineImg.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);

  const hostedGuestUrl = await page.locator('#sponsor-field-photoUrl').inputValue();
  expect(hostedGuestUrl).toMatch(/\/api\/public-images\/[0-9a-f-]+\.png$/);

  await page.locator('[data-sponsor-action="save-draft"]').click();
  await expect(page.locator('[data-sponsor-feedback]')).toContainText('Saved draft');
  await page.reload();
  await expect(guestInlineImg).toBeVisible();
  await expect.poll(() => guestInlineImg.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);

  // Bare filename shows visible error instead of silent blank
  await page.locator('#sponsor-field-photoUrl').fill('portrait-only-filename.jpg');
  await expect(page.locator('[data-sponsor-visual-error="photoUrl"]')).toBeVisible();
  await expect(page.locator('[data-sponsor-visual-error="photoUrl"]')).toContainText('portrait-only-filename.jpg');
});
