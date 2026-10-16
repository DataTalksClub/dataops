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
  test("shows loading, slot ticks, alerts, editing, error and mobile states", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ baseURL: server.baseURL }),
      page = await context.newPage();
    let release;
    const gate = new Promise((r) => (release = r)),
      summary = (id, title, anchorDate, openTaskCount = 5) => ({
        id, title, stage: "preparation", status: "active", anchorDate, taskCount: 6, openTaskCount,
      }),
      items = [
        {
          id: "issue-1",
          kind: "weekly",
          label: "Weekly #99",
          issueNumber: 99,
          publicationDate: "2026-12-31",
          status: "planned",
          slots: { primary: { ticked: true, sponsor: "Synthetic Booker" }, secondary: { ticked: false } },
          version: 1,
          cardId: "card-linked",
          card: summary("card-linked", "31 Dec · #99 · Synthetic Booker", "2026-12-30", 4),
        },
        {
          id: "issue-2",
          kind: "weekly",
          label: "Weekly #100",
          issueNumber: 100,
          publicationDate: "2027-01-01",
          status: "planned",
          slots: { primary: { ticked: true }, secondary: { ticked: false } },
          version: 1,
          cardId: "card-2",
          card: summary("card-2", "1 Jan · #100", "2027-01-01"),
        },
      ];
    let conflict = false;
    await page.route("**/api/newsletter-issues**", async (route) => {
      await gate;
      const request = route.request(),
        method = request.method();
      if (method === "POST") {
        const value = request.postDataJSON();
        const created = {
          id: "issue-created", version: 1, label: `Weekly #${value.issueNumber}`, ...value,
          cardId: "card-created", card: summary("card-created", "Created card", value.publicationDate),
        };
        items.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      if (method === "PUT") {
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { error: "Issue changed; reload and retry" },
          });
        const value = request.postDataJSON(),
          id = request.url().split("/").at(-1),
          item = items.find((entry) => entry.id === id);
        const slots = { ...item.slots, ...(value.slots || {}) };
        Object.assign(item, value, { slots, version: item.version + 1 });
        if (value.slots?.secondary?.ticked) item.card = { ...item.card, taskCount: 14, openTaskCount: 12 };
        if (value.status === "cancelled") Object.assign(item, { cardId: undefined, card: null });
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
              reasonCode: "near-term-open-slot",
              severity: "warning",
              issueId: "issue-2",
            },
          ],
        },
      });
    });
    await gotoOwnedNewsletterPage(page);
    await page.getByRole("link", { name: "Newsletter" }).click();
    await expect(page.getByText("Loading newsletter issues…")).toBeVisible();
    await page.screenshot({ path: ".tmp/newsletter-production-loading.png" });
    release();
    await expect(page.getByRole("heading", { name: "Weekly #99" })).toBeVisible();
    await expect(page.getByText("A slot needs a sponsor soon")).toBeVisible();
    const linkedRow = page.locator('article[data-issue-id="issue-1"]');
    await expect(linkedRow.locator(".newsletter-slot-ticks")).toContainText("Primary: Synthetic Booker");
    await expect(linkedRow.locator(".newsletter-slot-ticks")).toContainText("Secondary: open");
    await expect(linkedRow.locator(".newsletter-card-chip")).toContainText("31 Dec · #99 · Synthetic Booker");
    await expect(linkedRow.locator(".newsletter-card-chip")).toContainText("4/6");
    await expect(linkedRow.locator(".newsletter-card-chip")).toHaveAttribute("href", "/cards?cardId=card-linked");
    await expect(linkedRow.locator("[data-card-date-mismatch]")).toHaveText("Card dated 30 Dec");
    const openRow = page.locator('article[data-issue-id="issue-2"]');
    await expect(openRow.locator(".newsletter-slot-ticks")).toContainText("Primary: sponsor TBD");
    await expect(page.getByRole("button", { name: /Create card|Link card/ })).toHaveCount(0);
    await openRow.getByRole("checkbox", { name: /Secondary slot in Weekly #100/ }).check();
    await expect(openRow.locator(".newsletter-card-chip")).toContainText("12/14");
    await expect(openRow.getByRole("checkbox", { name: /Secondary slot in Weekly #100/ })).toBeChecked();
    await page
      .locator(".newsletter-surface")
      .screenshot({ path: ".tmp/newsletter-production-populated-alert.png" });
    await page.locator(".newsletter-filters summary").click();
    await page.locator("select[data-view]").selectOption("week");
    const weekSections = page.locator("[data-slots] > section");
    await expect(weekSections).toHaveCount(1);
    await expect(weekSections.locator("h3")).toHaveText("2026 · week 53");
    await expect(weekSections).toContainText("Weekly #99");
    await expect(weekSections).toContainText("Weekly #100");
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
    await expect(page.getByText("No newsletter issues")).toBeVisible();
    await page
      .locator(".newsletter-surface")
      .screenshot({ path: ".tmp/newsletter-production-empty.png" });
    await page.locator("[data-status]").selectOption("");
    await page.getByRole("button", { name: "Add issue" }).click();
    await page.getByLabel("Publication date").fill("2027-01-08");
    await page.getByLabel("Issue number").fill("101");
    await page.locator("dialog [name=primarySponsor]").fill("Synthetic Created Sponsor");
    await page.getByRole("button", { name: "Save issue" }).click();
    await expect(page.getByRole("heading", { name: "Weekly #101" })).toBeVisible();
    await expect(page.locator('article[data-issue-id="issue-created"]')).toContainText("Primary: Synthetic Created Sponsor");
    await page.locator("[data-slots] button[data-edit]").first().click();
    await expect(
      page.getByRole("heading", { name: "Weekly #99" }).last(),
    ).toBeVisible();
    await page
      .locator(".newsletter-surface dialog")
      .screenshot({ path: ".tmp/newsletter-production-edit.png" });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.locator("[data-slots] button[data-edit]").first().click();
    await page.locator("dialog [name=status]").selectOption("cancelled");
    await page.getByRole("button", { name: "Save issue" }).click();
    await expect(page.locator("[data-slots]")).toContainText("Cancelled");
    await page.locator("[data-slots] button[data-edit]").first().click();
    conflict = true;
    await page.getByRole("button", { name: "Save issue" }).click();
    await expect(page.getByRole("alert")).toContainText("reload and retry");
    await page
      .locator(".newsletter-surface dialog")
      .screenshot({ path: ".tmp/newsletter-production-conflict.png" });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => dakitShell.toggleDrawer(document.querySelector(".dk-shell"), false));
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
    await errorPage.route("**/api/newsletter-issues**", (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Synthetic permission denied" },
      }),
    );
    await gotoOwnedNewsletterPage(errorPage);
    await errorPage.getByRole("link", { name: "Newsletter" }).click();
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
