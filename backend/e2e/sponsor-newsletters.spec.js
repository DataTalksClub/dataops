const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const { setupPageWithAuth } = require("./helpers/auth");
const {
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;

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
    await expect(page.locator("[data-crm-message]")).toBeHidden();
    await expect(page.locator("[data-crm-view='newsletters']")).toBeVisible();
    await expect(page.locator(".crm-newsletters")).toBeHidden();

    await page.locator("[data-crm-view='newsletters']").click();
    await expect(page.locator(".crm-newsletters")).toBeVisible();
    await expect(page.locator(".crm-layout")).toBeHidden();
    await expect(page.locator(".crm-leads")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    const newslettersTab = page.locator("[data-crm-view='newsletters']");
    await newslettersTab.scrollIntoViewIfNeeded();
    await expect(newslettersTab).toHaveText("Newsletters");
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

    await api("/newsletters/receipts", {
      method: "POST",
      body: JSON.stringify({
        sender: "dataengineeringweekly@substack.com",
        subject: "Data Engineering Weekly #290",
        receivedAt: new Date().toISOString(),
        messageId: "e2e-dew-290",
      }),
    });
    await page.reload();
    await expect(page.locator("[data-crm-message]")).toBeHidden();
    await page.locator("[data-crm-view='newsletters']").click();
    await expect(weekly.locator("[data-health='current']")).toHaveText("Current");
    await expect(weekly).toContainText("Data Engineering Weekly #290");
  });
});
