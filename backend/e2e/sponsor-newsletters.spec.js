const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const { setupPageWithAuth } = require("./helpers/auth");
const {
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;
const INTAKE_SECRET = "sponsor-newsletters-e2e-secret";
const SCREENSHOTS = process.env.SPONSOR_SCREENSHOT_DIR || "";

async function api(path, options = {}) {
  const response = await fetch(`${server.baseURL}/api/sponsor-crm${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBeTruthy();
  return body;
}

test.describe("sponsor newsletter catalog", () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot("sponsor-newsletters"),
        EMAIL_DOCUMENT_INTAKE_SECRET: INTAKE_SECRET,
      },
    });
    await api("/newsletters", {
      method: "POST",
      body: JSON.stringify({
        name: "Data Engineering Weekly",
        url: "https://www.dataengineeringweekly.com/archive",
        senders: ["dataengineeringweekly@substack.com"],
        cadence: "Weekly",
        expectedIntervalDays: 7,
        subscriptionStatus: "subscribed",
        subscribedAt: "2026-09-01",
      }),
    });
    await api("/newsletters", {
      method: "POST",
      body: JSON.stringify({
        name: "Import AI — Jack Clark",
        url: "https://importai.substack.com/archive",
        cadence: "Weekly",
        expectedIntervalDays: 7,
        subscriptionStatus: "pending",
      }),
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test("lists delivery health, filters attention, and adds a title", async ({ page }) => {
    test.setTimeout(60_000);
    await setupPageWithAuth(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseURL}/sponsors`);
    await expect(page.locator("[data-crm-message]")).toBeHidden({ timeout: 20_000 });
    await page.locator("[data-crm-nav-more] > summary").click();
    await expect(page.locator("[data-crm-nav-tab='newsletters']")).toBeVisible();
    await expect(page.locator(".crm-newsletters")).toBeHidden();

    await page.locator("[data-crm-nav-tab='newsletters']").click();
    await expect(page.locator(".crm-newsletters")).toBeVisible();
    await expect(page.locator(".crm-layout")).toBeHidden();
    await expect(page.locator(".crm-leads")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    const newslettersTab = page.locator("[data-crm-nav-tab='newsletters']");
    await newslettersTab.scrollIntoViewIfNeeded();
    await expect(newslettersTab).toHaveText("Newsletter sources");
    await expect(page.locator(".crm-newsletters")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    const weekly = page.locator(".crm-newsletter-row").filter({ hasText: "Data Engineering Weekly" });
    const pending = page.locator(".crm-newsletter-row").filter({ hasText: "Import AI" });
    await expect(weekly).toBeVisible();
    await expect(weekly.locator("[data-health='missing']")).toHaveText("No issues yet");
    await expect(pending.locator("[data-health='pending']")).toHaveText("Signup pending");

    await page.locator("[data-crm-newsletter-health]").selectOption("attention");
    await expect(weekly).toBeVisible();
    await expect(pending).toBeVisible();
    await page.locator("[data-crm-newsletter-health]").selectOption("current");
    await expect(page.getByText("No newsletters match this filter")).toBeVisible();
    await page.locator("[data-crm-newsletter-health]").selectOption("");

    await page.locator("[data-add-newsletter]").click();
    const dialog = page.locator("[data-newsletter-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[name='name']").fill("Data Elixir");
    await dialog.locator("[name='url']").fill("https://dataelixir.com/");
    await dialog.locator("[name='senders']").fill("lon@dataelixir.com");
    await dialog.locator("[name='cadence']").fill("Weekly");
    await dialog.locator("[data-newsletter-save]").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".crm-newsletter-row").filter({ hasText: "Data Elixir" })).toBeVisible();

    // Dapier reports every inbox issue through lead intake, sponsors or not.
    const intake = await fetch(`${server.baseURL}/api/v1/intake/leads`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dataops-intake-secret": INTAKE_SECRET },
      body: JSON.stringify({
        version: "2026-10-10",
        messageId: "e2e-dew-290",
        newsletter: {
          name: "Data Engineering Weekly",
          sender: "dataengineeringweekly@substack.com",
          subject: "Data Engineering Weekly #290",
          receivedAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
        sponsors: [],
      }),
    });
    expect(intake.status, await intake.text()).toBe(201);
    await page.reload();
    await expect(page).toHaveURL(/\/sponsors\/newsletters$/);
    await expect(page.locator("[data-crm-message]")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator(".crm-newsletters")).toBeVisible();
    await expect(weekly.locator("[data-health='current']")).toHaveText("Current");
    await expect(weekly).toContainText("Data Engineering Weekly #290");
    await expect(weekly.locator("[data-newsletter-issues]")).toContainText("1 issue");
    await expect(weekly.locator("[data-newsletter-issues]")).toContainText("no sponsors found");
  });

  test("gives every tab and newsletter its own URL with working history", async ({ page }) => {
    test.setTimeout(300_000);
    const newsletters = (await api("/newsletters?search=data-engineering-weekly")).items;
    const weekly = newsletters.find((item) => item.slug === "data-engineering-weekly");
    await api(`/newsletters/${weekly.id}/issues`, {
      method: "POST",
      body: JSON.stringify({
        issueKey: "dataengineeringweekly.example.invalid/p/289",
        title: "Data Engineering Weekly #289",
        publishedAt: "2026-10-05",
        url: "https://dataengineeringweekly.example.invalid/p/289",
        source: "public-archive",
        sponsors: [{ name: "Example Orchestrator", url: "https://orchestrator.example.invalid" }],
      }),
    });
    await setupPageWithAuth(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${server.baseURL}/sponsors`);
    await expect(page).toHaveURL(/\/sponsors\/pipeline$/);
    const tabs = { pipeline: "[data-crm-bookings]", companies: "[data-dir-root='companies']", leads: ".crm-leads", newsletters: ".crm-newsletters" };
    for (const [tab, visible] of Object.entries(tabs)) {
      await page.goto(`${server.baseURL}/sponsors/${tab}`);
      await expect(page.locator("[data-crm-message]")).toBeHidden({ timeout: 20_000 });
      await expect(page).toHaveURL(new RegExp(`/sponsors/${tab}(?:\\?|$)`));
      await expect(page.locator(`[data-crm-nav-tab='${tab}']`)).toHaveAttribute("aria-current", "page");
      await expect(page.locator(visible).first()).toBeVisible();
      await expect(page.locator("#sponsors-nav-button")).toHaveAttribute("aria-current", "page");
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/sponsors-${tab}.png` });
    }

    // Tabs push history in place; Back and Forward restore them.
    await page.goto(`${server.baseURL}/sponsors/pipeline`);
    await expect(page.locator("[data-crm-message]")).toBeHidden({ timeout: 20_000 });
    await page.locator("[data-crm-nav-more] > summary").click();
    await page.locator("[data-crm-nav-tab='leads']").click();
    await expect(page).toHaveURL(/\/sponsors\/leads$/);
    await page.locator("[data-crm-nav-tab='newsletters']").click();
    await expect(page).toHaveURL(/\/sponsors\/newsletters$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/sponsors\/leads$/);
    await expect(page.locator(".crm-leads")).toBeVisible();
    await expect(page.locator("[data-crm-nav-tab='leads']")).toHaveAttribute("aria-current", "page");
    await page.goForward();
    await expect(page.locator(".crm-newsletters")).toBeVisible();

    // A newsletter opens its issues and their sponsors at its own path.
    const row = page.locator(".crm-newsletter-row").filter({ hasText: "Data Engineering Weekly" });
    await expect(row.locator("[data-newsletter-issues]")).toContainText("2 issues");
    await expect(row.locator("[data-newsletter-issues]")).toContainText("Example Orchestrator");
    await row.locator("[data-open-newsletter]").click();
    await expect(page).toHaveURL(new RegExp(`/sponsors/newsletters/${weekly.id}$`));
    const detail = page.locator(".crm-newsletter-detail");
    await expect(detail.locator(".crm-issue-row")).toHaveCount(2);
    await expect(detail.locator(".crm-issue-row").filter({ hasText: "#290" })).toContainText("No sponsor found");
    const sponsored = detail.locator(".crm-issue-row").filter({ hasText: "#289" });
    await expect(sponsored.locator(".crm-issue-sponsor")).toContainText("Example Orchestrator");
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/sponsors-newsletter-detail.png` });

    await page.reload();
    await expect(page.locator(".crm-newsletter-detail .crm-issue-row")).toHaveCount(2);
    await page.locator("[data-close-newsletter]").click();
    await expect(page).toHaveURL(/\/sponsors\/newsletters$/);
    await expect(page.locator("[data-crm-newsletters]")).toBeVisible();

    // A sponsor links to its lead.
    await page.goto(`${server.baseURL}/sponsors/newsletters/${weekly.id}`);
    await page.locator(".crm-issue-sponsor a").filter({ hasText: "Example Orchestrator" }).click();
    await expect(page).toHaveURL(/\/sponsors\/leads\/[0-9a-f]+$/);
    await expect(page.locator(".crm-lead-row[aria-current='true']")).toContainText("Example Orchestrator");

    await page.goto(`${server.baseURL}/sponsors/newsletters/missing-newsletter`);
    await expect(page.locator(".entity-route-not-found:visible")).toContainText("missing-newsletter");
  });

  test("sponsor newsletter content form keeps structured Opening / Bullets / Closing fields and updates live preview on typing and visual upload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const issueRes = await fetch(`${server.baseURL}/api/newsletter-issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "standalone",
        publicationDate: "2026-12-14",
        status: "planned",
        slots: {
          primary: { sponsor: "Estuary" },
        },
      }),
    });
    expect(issueRes.ok).toBeTruthy();
    const issue = await issueRes.json();

    const docRes = await fetch(`${server.baseURL}/api/sponsor-docs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardId: issue.id,
        standalone: true,
      }),
    });
    expect(docRes.ok).toBeTruthy();
    const { doc } = await docRes.json();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseURL}/sponsor-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}`);

    const preview = page.locator("[data-sponsor-live-preview]");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Live Preview");
    await expect(preview).toContainText("Stand-Alone Blast");

    // Structured fields remain distinct (Opening, Bulleted List, Closing)
    const openingField = page.locator("#sponsor-field-mainBodyOpening");
    const bulletsField = page.locator('[data-sponsor-bullets="bullets"]');
    const closingField = page.locator("#sponsor-field-closing");
    await expect(openingField).toBeVisible();
    await expect(bulletsField).toBeVisible();
    await expect(closingField).toBeVisible();

    // Bullets field renders 3 structured list inputs + "+ Add bullet" button
    await expect(bulletsField.locator("[data-sponsor-bullet-input]")).toHaveCount(3);
    await page.locator("#sponsor-field-title").fill("Real-Time CDC Pipelines Without Ops Overhead");
    await expect(preview.locator("[data-sponsor-preview-title]")).toHaveText(
      "Real-Time CDC Pipelines Without Ops Overhead",
    );

    await openingField.fill("See how engineering teams unify streaming and batch in one declarative pipeline:");
    await expect(preview.locator("[data-sponsor-preview-opening]")).toHaveText(
      "See how engineering teams unify streaming and batch in one declarative pipeline:",
    );

    await bulletsField.locator('[data-sponsor-bullet-input="0"]').fill("Sub-second Postgres and MySQL CDC");
    await bulletsField.locator('[data-sponsor-bullet-input="1"]').fill("Automatic schema evolution");
    await bulletsField.locator('[data-sponsor-bullet-input="2"]').fill("Exactly-once delivery to Snowflake and BigQuery");
    await bulletsField.locator('[data-sponsor-action="add-bullet"]').click();
    await expect(bulletsField.locator("[data-sponsor-bullet-input]")).toHaveCount(4);
    await bulletsField.locator('[data-sponsor-bullet-input="3"]').fill("Deploy in cloud or BYOC in 5 minutes");

    await expect(preview.locator("[data-sponsor-preview-bullet]")).toHaveCount(4);
    await expect(preview.locator("[data-sponsor-preview-bullets]")).toContainText(
      "Deploy in cloud or BYOC in 5 minutes",
    );

    await closingField.fill("Join our live engineering workshop this Thursday.");
    await expect(preview.locator("[data-sponsor-preview-closing]")).toHaveText(
      "Join our live engineering workshop this Thursday.",
    );

    // Upload a 1x1 PNG visual and verify live preview renders the uploaded image immediately
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.locator('[data-sponsor-visual-upload="graphicsUrl"]').setInputFiles({
      name: "estuary-banner.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });

    const previewImg = preview.locator("img[data-sponsor-preview-image]");
    await expect(previewImg).toBeVisible();
    await expect(previewImg).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(preview.locator("[data-sponsor-preview-visual-caption]")).toContainText("estuary-banner.png");

    await page.locator('[data-sponsor-action="submit-ready"]').click();
    await expect(page.locator('[data-sponsor-doc-status="submitted"]')).toHaveText("Submitted / Ready");
  });
});
