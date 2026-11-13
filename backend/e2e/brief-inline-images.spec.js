const { test, expect } = require('@playwright/test');
const { deflateSync } = require('node:zlib');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// 1x1 PNG (67 bytes)
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function buildLargePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 1; x < stride; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      raw[rowStart + x] = (seed >>> 24) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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

test('sponsor graphic >300KB PNG round-trips byte-identical and renders in newsletter preview, while truncated PNG fails loudly', async ({ page, request }) => {
  test.setTimeout(90_000);

  const nlTplRes = await request.post(`${server.baseURL}/__e2e__/template-fixtures`, {
    data: {
      name: 'Synthetic newsletter (>300KB graphic)',
      type: 'newsletter',
      sourcePath: 'workflow-templates/synthetic-newsletter-large-png.yaml',
      taskDefinitions: [],
    },
  });
  expect(nlTplRes.status()).toBe(201);
  const { template: nlTpl } = await nlTplRes.json();

  const nlCardRes = await request.post(`${server.baseURL}/api/cards`, {
    data: { templateId: nlTpl.id, title: 'Large PNG regression test', anchorDate: '2026-12-15' },
  });
  expect(nlCardRes.status()).toBe(201);
  const { card: nlCard } = await nlCardRes.json();

  const sDocRes = await request.post(`${server.baseURL}/api/sponsor-docs`, {
    data: {
      cardId: nlCard.id,
      template: 'newsletter-main',
      sponsorName: 'Astronomer Test',
      autoSendEmail: false,
    },
  });
  expect(sDocRes.status()).toBe(201);
  const { doc: sponsorDoc } = await sDocRes.json();

  const largePng = buildLargePng(400, 300);
  expect(largePng.length).toBeGreaterThan(300_000);

  await page.setExtraHTTPHeaders({ 'x-sponsor-doc-anonymous': 'true' });
  await page.goto(`${server.baseURL}/sponsor-docs/${sponsorDoc.id}?code=${encodeURIComponent(sponsorDoc.accessCode)}`);
  await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();

  await page.locator('[data-sponsor-visual-upload="graphicsUrl"]').setInputFiles({
    name: 'large-sponsor-graphic.png',
    mimeType: 'image/png',
    buffer: largePng,
  });

  const previewImg = page.locator('img[data-sponsor-preview-image]');
  await expect(previewImg).toBeVisible();
  await expect.poll(() => previewImg.evaluate((el) => ({
    complete: el.complete,
    w: el.naturalWidth,
    h: el.naturalHeight,
  }))).toEqual({ complete: true, w: 400, h: 300 });

  const hostedUrl = await page.locator('#sponsor-field-graphicsUrl').inputValue();
  expect(hostedUrl).toMatch(/\/api\/public-images\/[0-9a-f-]+\.png$/);

  await page.locator('[data-sponsor-action="save-draft"]').click();
  await expect(page.locator('[data-sponsor-feedback]')).toContainText('Saved draft');

  // Verify the stored file round-trips byte-identical
  const fetched = await request.get(hostedUrl);
  expect(fetched.status()).toBe(200);
  const fetchedBody = await fetched.body();
  expect(Buffer.compare(fetchedBody, largePng)).toBe(0);

  // Truncated PNG (missing IEND) fails loudly with a visible form error
  const truncatedPng = largePng.subarray(0, 300_000);
  await page.locator('[data-sponsor-visual-upload="graphicsUrl"]').setInputFiles({
    name: 'truncated-graphic.png',
    mimeType: 'image/png',
    buffer: truncatedPng,
  });

  const errorBox = page.locator('[data-sponsor-visual-error="graphicsUrl"]');
  await expect(errorBox).toBeVisible();
  await expect(errorBox).toHaveAttribute('role', 'alert');
  await expect(errorBox).toContainText(/truncated|corrupted|decoded/i);
});
