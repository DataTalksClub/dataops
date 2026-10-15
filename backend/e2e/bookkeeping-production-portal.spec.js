const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;

async function gotoOwnedBookkeepingPage(page) {
  const response = await page.goto("/bookkeeping");
  assertOwnedServerResponse(server, response, "bookkeeping browser session");
  return response;
}

test.describe("production portal bookkeeping", () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot(
          "issue-190-docs-cache/bookkeeping-production-portal",
        ),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test("loads the real frontend Bookkeeping surface and operator states", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const page = await context.newPage();

    await gotoOwnedBookkeepingPage(page);
    await expect(page.getByRole("heading", { name: "Bookkeeping" })).toBeVisible();
    await expect(page.getByText("No transactions recorded for")).toBeVisible();

    await page.locator("[data-bookkeeping-add]").click();
    const entryForm = page.locator(".bookkeeping-entry-dialog");
    const addButton = entryForm.getByRole("button", { name: "Add transaction" });
    await addButton.click();
    // The date presets to the lens month, so the first missing field is the
    // counterparty.
    await expect(entryForm.getByRole("alert")).toHaveText("Counterparty is required.");
    await expect(entryForm.getByLabel("Counterparty")).toBeFocused();
    await expect(entryForm.getByLabel("Counterparty")).toHaveAttribute("aria-invalid", "true");
    await entryForm.locator("[name=transactionDate]").fill("2026-10-03");
    await entryForm.locator("[name=counterparty]").fill("Synthetic Portal Vendor");
    await entryForm.locator("[name=description]").fill("Synthetic browser evidence");
    await entryForm.locator("[name=amount]").fill("20.00");
    await addButton.click();
    const createdRow = page.locator(".bk-row").filter({ hasText: "Synthetic Portal Vendor" });
    await expect(createdRow).toContainText("−€20.00");
    // A new transaction opens in the details pane, ready to finish.
    const detail = page.locator(".bk-detail");
    await expect(detail.locator("[name=counterparty]")).toHaveValue("Synthetic Portal Vendor");
    await detail.locator("[name=category]").fill("synthetic-testing");
    await detail.locator("[name=category]").press("Tab");
    await expect(page.getByRole("status")).toContainText("Saved Category");
    await page.reload();
    await expect(createdRow).toContainText("Synthetic browser evidence");
    await expect(createdRow.locator('[data-inline-field="category"]')).toHaveValue("synthetic-testing");

    // The receipt is attached from the transaction itself.
    await createdRow.locator(".bk-col-date").click();
    await expect(detail).toContainText("No receipt attached.");
    await detail.locator("[data-attach-type]").selectOption("receipt");
    await detail.locator("[data-attach-file]").setInputFiles({
      name: "synthetic-upload.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nsynthetic real evidence\n%%EOF"),
    });
    await expect(page.getByRole("status")).toContainText("PDF attached.");
    await expect(detail.locator(".bk-receipts")).toContainText("Receipt PDF");
    const transactionId = await createdRow.getAttribute("data-tx");
    const linksResponse = await context.request.get(
      `${server.baseURL}/api/bookkeeping/links`,
    );
    expect(linksResponse.status()).toBe(200);
    assertOwnedServerResponse(server, linksResponse, "bookkeeping links");
    const links = await linksResponse.json();
    expect(links.items).toHaveLength(1);
    expect(links.items[0].transactionId).toBe(transactionId);

    // Statements and unmatched files live in a secondary view.
    await page.locator(".bk-more > summary").click();
    await page.getByRole("menuitem", { name: /Files & statements/ }).click();
    await expect(page).toHaveURL(/view=files/);
    await expect(page.locator(".bookkeeping-documents")).toContainText("Private PDF");
    await page.getByRole("button", { name: "Set up business accounts" }).click();
    await expect(page.getByRole("status")).toContainText("2 business accounts ready");
    await page.locator(".bookkeeping-upload-panel > summary").click();
    await page.getByRole("button", { name: "Upload PDF" }).click();
    await expect(page.getByRole("status")).toContainText("Choose a PDF first");
    await page.locator("#bookkeeping-evidence").getByRole("button", { name: "← Transactions" }).click();
    await expect(createdRow).toBeVisible();

    const faultResponse = await context.request.post(
      `${server.baseURL}/__e2e__/route-faults`,
      {
        data: {
          faults: [
            {
              method: "GET",
              path: "/api/bookkeeping/transactions",
              status: 503,
              remaining: 10,
            },
          ],
        },
      },
    );
    expect(faultResponse.ok()).toBe(true);
    await page.reload();
    await expect(page.locator(".bookkeeping-ledger")).toContainText(
      "Could not load bookkeeping: Synthetic route failure (503)",
    );
    await expect(page.getByRole("status")).toContainText(
      "Retry by reopening Bookkeeping",
    );
    const clearFaults = await context.request.delete(
      `${server.baseURL}/__e2e__/route-faults`,
    );
    expect(clearFaults.ok()).toBe(true);
    await page.reload();
    await expect(createdRow).toContainText("Synthetic Portal Vendor");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => dakitShell.toggleDrawer(document.querySelector(".dk-shell"), false));
    await expect(
      page.locator(".dk-topbar").getByRole("button", { name: "New" }),
    ).toHaveCount(0);
    const topbarGeometry = await page.locator(".dk-topbar").evaluate((bar) => {
      const bounds = bar.getBoundingClientRect();
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        children: [...bar.children].map((child) => {
          const rect = child.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          };
        }),
      };
    });
    expect(topbarGeometry.children).toHaveLength(3);
    for (const child of topbarGeometry.children) {
      expect(child.top).toBeGreaterThanOrEqual(topbarGeometry.top);
      expect(child.bottom).toBeLessThanOrEqual(topbarGeometry.bottom);
      expect(child.left).toBeGreaterThanOrEqual(0);
      expect(child.right).toBeLessThanOrEqual(390);
    }
    const dimensions = await page.locator(".bookkeeping-surface").evaluate(
      (element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        page: document.documentElement.scrollWidth,
      }),
    );
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
    expect(dimensions.page).toBeLessThanOrEqual(390);
    await context.close();
  });

  test("year/month navigation exports only the selected period and copies report data", async ({ browser }) => {
    const fs = require("fs/promises");
    const context = await browser.newContext({ baseURL: server.baseURL, acceptDownloads: true });
    const page = await context.newPage();
    const samples = [
      { transactionDate: "2024-01-02", counterparty: "January Export Vendor", amount: "100.1234", currency: "EUR", entryType: "expense" },
      { transactionDate: "2024-12-02", counterparty: 'December, "Export" Vendor', amount: "25.4321", currency: "USD", entryType: "income" },
      { transactionDate: "2024-12-03", counterparty: "Excluded Export Tax", amount: "10.00", currency: "EUR", entryType: "expense", category: "Taxes" },
      { transactionDate: "2025-01-02", counterparty: "Next Year Export Vendor", amount: "20.00", currency: "EUR", entryType: "expense" },
    ];
    for (const entry of samples) {
      const response = await context.request.post("/api/bookkeeping/transactions", { data: { description: "Export browser fixture", ...entry } });
      expect(response.ok(), await response.text()).toBe(true);
    }
    await gotoOwnedBookkeepingPage(page);
    const period = page.locator("[data-period-toolbar]");
    await period.locator("[data-picker-toggle]").click();
    await expect(period.locator("[data-picker-month]")).toHaveText([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
    const pickerYear = period.locator("[data-picker-year]");
    for (let step = 0; step < 20 && (await pickerYear.textContent()) !== "2024"; step += 1) {
      const shown = Number(await pickerYear.textContent());
      await period.locator(shown > 2024 ? "[data-picker-prev-year]" : "[data-picker-next-year]").click();
    }
    await expect(pickerYear).toHaveText("2024");
    await period.getByRole("button", { name: "Whole year", exact: true }).click();
    await expect(period.locator("[data-period-heading]")).toHaveText("2024 (whole year)");
    const ledger = page.locator(".bookkeeping-ledger");
    await expect(ledger).toContainText("January Export Vendor");
    await expect(ledger).toContainText('December, "Export" Vendor');
    await expect(ledger).not.toContainText("Next Year Export Vendor");
    const more = page.locator(".bk-more > summary");
    await more.click();
    await page.getByRole("menuitem", { name: "Accountant package & VAT" }).click();
    await expect(page.locator("[data-package-review]")).toContainText("Choose a month");
    await expect(page.locator("[data-report]")).toBeDisabled();
    await page.locator("#bookkeeping-package").getByRole("button", { name: "← Transactions" }).click();

    const reportDownload = page.waitForEvent("download");
    await more.click();
    await page.getByRole("menuitem", { name: "Export accountant CSV", exact: true }).click();
    const report = await reportDownload;
    expect(report.suggestedFilename()).toBe("datatalksclub-2024.csv");
    const reportText = await fs.readFile(await report.path(), "utf8");
    expect(reportText).toContain('"-100.1234"');
    expect(reportText).toContain('"December, ""Export"" Vendor","Export browser fixture","","25.4321","USD"');
    expect(reportText).not.toContain("Excluded Export Tax");
    expect(reportText).not.toContain("Next Year Export Vendor");

    const fullDownload = page.waitForEvent("download");
    await more.click();
    await page.getByRole("menuitem", { name: "Export all fields (CSV)", exact: true }).click();
    const full = await fullDownload;
    expect(full.suggestedFilename()).toBe("datatalksclub-2024-full.csv");
    expect(await fs.readFile(await full.path(), "utf8")).toContain("Excluded Export Tax");

    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copiedReport = text; } } }));
    await more.click();
    await page.getByRole("menuitem", { name: "Copy accountant table", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Copied report table for 2024 (2 transactions)");
    const copied = await page.evaluate(() => window.__copiedReport);
    expect(copied).toContain("VAT\tVAT Currency");
    expect(copied).toContain("January Export Vendor");
    expect(copied).not.toContain("Excluded Export Tax");

    const heading = period.locator("[data-period-heading]");
    await period.locator("[data-picker-toggle]").click();
    await expect(pickerYear).toHaveText("2024");
    await period.locator('[data-picker-month="11"]').click();
    await expect(heading).toHaveText("December 2024");
    await expect(ledger).not.toContainText("January Export Vendor");
    await period.getByRole("button", { name: "Next month", exact: true }).click();
    await expect(heading).toHaveText("January 2025");
    await expect(ledger).toContainText("Next Year Export Vendor");
    await period.locator("[data-picker-toggle]").click();
    await period.getByRole("button", { name: "Whole year", exact: true }).click();
    await expect(heading).toHaveText("2025 (whole year)");
    await period.locator("[data-prev]").click();
    await expect(heading).toHaveText("2024 (whole year)");
    await expect(period.locator("[data-prev]")).toHaveAttribute("aria-label", "Previous year");
    await period.locator("[data-prev]").click();
    await expect(heading).toHaveText("2023 (whole year)");
    await expect(ledger).toContainText("No transactions recorded for 2023");
    await period.locator("[data-picker-toggle]").click();
    await period.getByRole("button", { name: "All records", exact: true }).click();
    await expect(heading).toHaveText("All records");
    await expect(period.locator("[data-prev]")).toBeDisabled();
    await expect(ledger).toContainText("Next Year Export Vendor");
    await context.close();
  });

});
