// Regression (t2909u): clicking the "Add UTM" suggestion on a sponsor doc changed
// ctaUrl in the page only; nothing reached the server until a manual Save, so
// the value was lost. The page now autosaves every edit, including
// helper-filled values and image uploads, and a failed save is loud.
const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const { startOwnedTestServer, stopOwnedTestServer } = require("./helpers/isolated-capability-server");

// 1x1 PNG
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=",
  "base64",
);

let server;
test.use({ screenshot: "off", trace: "off", video: "off" });

test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot("sponsor-doc-autosave") } });
});
test.afterAll(async () => { await stopOwnedTestServer(server); });

async function openSponsorDoc(page, request, title) {
  const tplRes = await request.post(`${server.baseURL}/__e2e__/template-fixtures`, {
    data: { name: `Autosave ${title}`, type: "newsletter", sourcePath: `workflow-templates/autosave-${title}.yaml`, taskDefinitions: [] },
  });
  expect(tplRes.status()).toBe(201);
  const { template } = await tplRes.json();
  const cardRes = await request.post(`${server.baseURL}/api/cards`, {
    data: { templateId: template.id, title: `Autosave ${title}`, anchorDate: "2026-12-14" },
  });
  expect(cardRes.status()).toBe(201);
  const { card } = await cardRes.json();
  const docRes = await request.post(`${server.baseURL}/api/sponsor-docs`, {
    data: { cardId: card.id, template: "newsletter-main", sponsorName: "Acme Corp", autoSendEmail: false },
  });
  expect(docRes.status()).toBe(201);
  const { doc } = await docRes.json();
  // Save a plain ctaUrl first, exactly like the reported doc.
  const putRes = await request.put(`${server.baseURL}/api/sponsor-docs/${doc.id}`, {
    data: { content: { ...(doc.content || {}), ctaUrl: "https://maven.com/example/product-shipping" } },
  });
  expect(putRes.status()).toBe(200);
  await page.setExtraHTTPHeaders({ "x-sponsor-doc-anonymous": "true" });
  await page.goto(`${server.baseURL}/sponsor-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}`);
  await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();
  return doc;
}

const status = (page) => page.locator("[data-sponsor-save-status]");

test("clicking the UTM suggestion autosaves ctaUrl; reload shows it", async ({ page, request }) => {
  test.setTimeout(60_000);
  await openSponsorDoc(page, request, "utm");
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "saved");
  const putDone = page.waitForResponse((res) => res.request().method() === "PUT" && /\/api\/sponsor-docs\//.test(res.url()));
  await page.locator('[data-sponsor-action="apply-utm-suggestion"][data-sponsor-utm-field="ctaUrl"]').click();
  expect((await putDone).status()).toBe(200);
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "saved");
  await expect(status(page)).toContainText("All changes saved");
  await page.reload();
  await expect(page.locator("#sponsor-field-ctaUrl")).toHaveValue(/^https:\/\/maven\.com\/example\/product-shipping\?.*utm_source=/);
});

test("typing and an image upload autosave without a Save click", async ({ page, request }) => {
  test.setTimeout(60_000);
  await openSponsorDoc(page, request, "typing");
  await page.locator("#sponsor-field-title").fill("Autosaved headline");
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "saved", { timeout: 10_000 });
  await page.locator('[data-sponsor-visual-upload="graphicsUrl"]').setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: VALID_PNG });
  await expect(page.locator('img[data-sponsor-visual-image="graphicsUrl"]')).toBeVisible();
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "saved", { timeout: 10_000 });
  await page.reload();
  await expect(page.locator("#sponsor-field-title")).toHaveValue("Autosaved headline");
  await expect(page.locator("#sponsor-field-graphicsUrl")).toHaveValue(/\/api\/public-images\/[0-9a-f-]+\.png$/);
});

test("a failed autosave shows a loud NOT SAVED error, reports it, and Retry saves", async ({ page, request }) => {
  test.setTimeout(60_000);
  await openSponsorDoc(page, request, "failure");
  const reports = [];
  page.on("request", (req) => { if (req.url().endsWith("/api/client-errors")) reports.push(req.postDataJSON()); });
  const failPut = (route) => (route.request().method() === "PUT"
    ? route.fulfill({ status: 500, json: { error: "boom" } })
    : route.continue());
  await page.route("**/api/sponsor-docs/*", failPut);
  await page.locator("#sponsor-field-title").fill("Will fail first");
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "error", { timeout: 10_000 });
  await expect(status(page)).toHaveAttribute("role", "alert");
  await expect(status(page)).toContainText("NOT SAVED");
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  await page.unroute("**/api/sponsor-docs/*", failPut);
  await page.locator('[data-sponsor-action="retry-save"]').click();
  await expect(status(page)).toHaveAttribute("data-sponsor-save-state", "saved", { timeout: 10_000 });
  await page.reload();
  await expect(page.locator("#sponsor-field-title")).toHaveValue("Will fail first");
});
