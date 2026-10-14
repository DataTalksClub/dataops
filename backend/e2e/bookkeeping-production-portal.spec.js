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
    await expect(page.getByText("No bookkeeping entries")).toBeVisible();
    await expect(page.locator(".bookkeeping-documents")).toContainText(
      "No private documents uploaded",
    );

    await page.getByRole("button", { name: "Add entry" }).click();
    const entryForm = page.locator(".bookkeeping-entry-dialog");
    await entryForm.getByRole("button", { name: "Save" }).click();
    // Quick capture presets the transaction date to the lens month, so the
    // first missing field is the provider.
    await expect(entryForm.getByRole("alert")).toHaveText(
      "Provider / payee is required.",
    );
    await expect(entryForm.getByLabel("Provider / payee")).toBeFocused();
    await expect(entryForm.getByLabel("Provider / payee")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await entryForm.getByLabel("Transaction date").fill("2026-10-03");
    await entryForm
      .getByLabel("Provider / payee")
      .fill("Synthetic Portal Vendor");
    await entryForm
      .getByLabel("Description")
      .fill("Synthetic browser evidence");
    // The first failed save leaves per-field notes that change accessible
    // names; address the control directly.
    await entryForm.locator("[name=amount]").fill("20.00");
    // Category lives behind the "Optional details" disclosure now.
    await entryForm.getByText("Optional details").click();
    await entryForm.getByLabel("Category").fill("synthetic-testing");
    await entryForm.getByRole("button", { name: "Save" }).click();
    const createdRow = page.getByRole("row").filter({
      hasText: "Synthetic Portal Vendor",
    });
    await expect(createdRow).toContainText("-€20.00");
    await page.reload();
    await expect(createdRow).toContainText("Synthetic browser evidence");

    await page.getByRole("button", { name: "Set up business accounts" }).click();
    await expect(page.getByRole("status")).toContainText(
      "2 business accounts ready",
    );
    // The upload form lives collapsed behind its summary; open it.
    await page.locator(".bookkeeping-upload-panel > summary").click();
    await page.getByRole("button", { name: "Upload PDF" }).click();
    await expect(page.getByRole("status")).toContainText("Choose a PDF first");
    const transactionId = await page
      .getByLabel("Link to transaction")
      .locator("option")
      .nth(1)
      .getAttribute("value");
    expect(transactionId).toBeTruthy();
    await page.getByLabel("Document type").selectOption("receipt");
    await page.getByLabel("Link to transaction").selectOption(transactionId);
    await page.getByLabel("PDF evidence").setInputFiles({
      name: "synthetic-upload.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nsynthetic real evidence\n%%EOF"),
    });
    await page.getByRole("button", { name: "Upload PDF" }).click();
    await expect(page.getByRole("status")).toContainText(
      "PDF uploaded and verified",
    );
    await expect(page.locator(".bookkeeping-documents")).toContainText(
      "Private PDF",
    );
    await expect(page.getByRole("button", { name: /Unlink/ })).toBeVisible();
    const linksResponse = await context.request.get(
      `${server.baseURL}/api/bookkeeping/links`,
    );
    expect(linksResponse.status()).toBe(200);
    assertOwnedServerResponse(server, linksResponse, "bookkeeping links");
    const links = await linksResponse.json();
    expect(links.items).toHaveLength(1);
    expect(links.items[0].transactionId).toBe(transactionId);

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
    const year = page.getByRole("combobox", { name: "Select year", exact: true });
    const month = page.getByRole("combobox", { name: "Select month", exact: true });
    await expect(year).toBeVisible();
    await expect(month.locator("option")).toHaveText([
      "All months (full year)",
      "01 - January", "02 - February", "03 - March", "04 - April",
      "05 - May", "06 - June", "07 - July", "08 - August",
      "09 - September", "10 - October", "11 - November", "12 - December",
    ]);
    await month.selectOption("all");
    await year.selectOption("2024");
    const ledger = page.locator(".bookkeeping-ledger");
    await expect(ledger).toContainText("January Export Vendor");
    await expect(ledger).toContainText('December, "Export" Vendor');
    await expect(ledger).not.toContainText("Next Year Export Vendor");
    await expect(page.locator("[data-package-review]")).toContainText("Choose a month to review");
    await expect(page.locator("[data-report]")).toBeDisabled();

    const reportDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export report CSV", exact: true }).click();
    const report = await reportDownload;
    expect(report.suggestedFilename()).toBe("datatalksclub-2024.csv");
    const reportText = await fs.readFile(await report.path(), "utf8");
    expect(reportText).toContain('"-100.1234"');
    expect(reportText).toContain('"December, ""Export"" Vendor","Export browser fixture","","25.4321","USD"');
    expect(reportText).not.toContain("Excluded Export Tax");
    expect(reportText).not.toContain("Next Year Export Vendor");

    const fullDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Full CSV", exact: true }).click();
    const full = await fullDownload;
    expect(full.suggestedFilename()).toBe("datatalksclub-2024-full.csv");
    expect(await fs.readFile(await full.path(), "utf8")).toContain("Excluded Export Tax");

    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copiedReport = text; } } }));
    await page.getByRole("button", { name: "Copy for report", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Copied report table for 2024 (2 transactions)");
    const copied = await page.evaluate(() => window.__copiedReport);
    expect(copied).toContain("VAT\tVAT Currency");
    expect(copied).toContain("January Export Vendor");
    expect(copied).not.toContain("Excluded Export Tax");

    await month.selectOption("12");
    await expect(ledger).not.toContainText("January Export Vendor");
    await expect(page.locator("[data-report]")).toBeEnabled();
    await page.getByRole("button", { name: "Next month", exact: true }).click();
    await expect(year).toHaveValue("2025");
    await expect(month).toHaveValue("01");
    await expect(ledger).toContainText("Next Year Export Vendor");
    await month.selectOption("all");
    await page.getByRole("button", { name: "Previous year", exact: true }).click();
    await expect(year).toHaveValue("2024");
    await page.getByRole("button", { name: "Previous year", exact: true }).click();
    await expect(year).toHaveValue("2023");
    await expect(ledger).toContainText("No bookkeeping entries in 2023");
    await year.selectOption("all");
    await expect(month).toBeDisabled();
    await expect(ledger).toContainText("Next Year Export Vendor");
    await context.close();
  });

});
