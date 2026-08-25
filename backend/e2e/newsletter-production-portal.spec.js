const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;

async function gotoOwnedNewsletterPage(page) {
  const response = await page.goto("/");
  assertOwnedServerResponse(server, response, "newsletter browser session");
  return response;
}

test.describe("production newsletter planner", () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot(
          "issue-190-docs-cache/newsletter-production-portal",
        ),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });
  test("shows loading, booked/unbooked, alerts, editing, error and mobile states", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: server.baseURL }),
      page = await context.newPage();
    let release;
    const gate = new Promise((r) => (release = r)),
      items = [
        {
          id: "slot-1",
          publicationDate: "2026-12-31",
          campaignLabel: "Synthetic Year End",
          campaignNumber: 99,
          status: "reserved",
          bookedByDisplayName: "Synthetic Booker",
          version: 1,
        },
        {
          id: "slot-2",
          publicationDate: "2027-01-01",
          campaignLabel: "Synthetic New Year",
          status: "open",
          version: 1,
        },
      ];
    let conflict = false;
    await page.route("**/work/api/newsletter-slots**", async (route) => {
      await gate;
      const request = route.request(),
        method = request.method();
      if (method === "POST") {
        const value = request.postDataJSON();
        items.push({ id: "slot-created", version: 1, ...value });
        return route.fulfill({ status: 201, json: items.at(-1) });
      }
      if (method === "PUT") {
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { error: "Slot changed; reload and retry" },
          });
        const value = request.postDataJSON(),
          id = request.url().split("/").at(-1),
          item = items.find((entry) => entry.id === id);
        Object.assign(item, value, { version: item.version + 1 });
        return route.fulfill({ json: item });
      }
      const url = new URL(request.url()),
        status = url.searchParams.get("status");
      return route.fulfill({
        json: {
          items: status
            ? items.filter((item) => item.status === status)
            : items,
          alerts: [
            {
              reasonCode: "near-term-open-unbooked",
              severity: "warning",
              slotId: "slot-2",
            },
          ],
        },
      });
    });
    await gotoOwnedNewsletterPage(page);
    await page.getByRole("button", { name: "Newsletter" }).click();
    await expect(page.getByText("Loading newsletter slots…")).toBeVisible();
    await page.screenshot({ path: ".tmp/newsletter-production-loading.png" });
    release();
    await expect(page.getByText("Synthetic Year End")).toBeVisible();
    await expect(page.locator("[data-slots]")).toContainText(
      "Booked by: Unbooked",
    );
    await expect(page.getByText("An open slot needs booking soon")).toBeVisible();
    await page
      .locator(".newsletter-surface")
      .screenshot({ path: ".tmp/newsletter-production-populated-alert.png" });
    await page.locator("select[data-view]").selectOption("week");
    const weekSections = page.locator("[data-slots] > section");
    await expect(weekSections).toHaveCount(1);
    await expect(weekSections.locator("h3")).toHaveText("2026 · week 53");
    await expect(weekSections).toContainText("Synthetic Year End");
    await expect(weekSections).toContainText("Synthetic New Year");
    await expect(page.getByText("2027 · week 01", { exact: true })).toHaveCount(
      0,
    );
    await page.locator(".newsletter-surface").evaluate((surface) => {
      surface.style.transform = "none";
      surface.style.filter = "none";
      surface.style.contain = "none";
    });
    await page.locator(".newsletter-surface").screenshot({
      path: ".tmp/newsletter-production-week.png",
      animations: "disabled",
    });
    await page.locator("select[data-view]").selectOption("month");
    await page.locator("[data-status]").selectOption("sent");
    await expect(page.getByText("No newsletter slots")).toBeVisible();
    await page
      .locator(".newsletter-surface")
      .screenshot({ path: ".tmp/newsletter-production-empty.png" });
    await page.locator("[data-status]").selectOption("");
    await page.getByRole("button", { name: "Add slot" }).click();
    await page.getByLabel("Publication date").fill("2027-01-08");
    await page.getByLabel("Campaign label").fill("Synthetic Created");
    await page.getByRole("button", { name: "Save slot" }).click();
    await expect(page.getByText(/Synthetic Created/)).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Newsletter slot" }),
    ).toBeVisible();
    await page
      .locator(".newsletter-surface dialog")
      .screenshot({ path: ".tmp/newsletter-production-edit.png" });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.locator("dialog [name=status]").selectOption("cancelled");
    await page.getByRole("button", { name: "Save slot" }).click();
    await expect(page.locator("[data-slots]")).toContainText("Cancelled");
    await page.getByRole("button", { name: "Edit" }).first().click();
    conflict = true;
    await page.getByRole("button", { name: "Save slot" }).click();
    await expect(page.getByRole("alert")).toContainText("reload and retry");
    await page
      .locator(".newsletter-surface dialog")
      .screenshot({ path: ".tmp/newsletter-production-conflict.png" });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.body.classList.remove("sidebar-open"));
    await expect
      .poll(async () => {
        const box = await page.locator("#sidebar").boundingBox();
        return box ? box.x + box.width : 0;
      })
      .toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: ".tmp/newsletter-production-mobile.png",
      fullPage: true,
    });
    await context.close();
    const errorContext = await browser.newContext({ baseURL: server.baseURL }),
      errorPage = await errorContext.newPage();
    await errorPage.route("**/work/api/newsletter-slots**", (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Synthetic permission denied" },
      }),
    );
    await gotoOwnedNewsletterPage(errorPage);
    await errorPage.getByRole("button", { name: "Newsletter" }).click();
    await expect(
      errorPage.locator(".newsletter-surface [role=\"status\"]"),
    ).toContainText("Could not load");
    await errorPage.screenshot({
      path: ".tmp/newsletter-production-error.png",
      animations: "disabled",
    });
    await errorContext.close();
  });
});
