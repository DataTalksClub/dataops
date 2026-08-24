const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const { resolveTestServerCommand } = require("./helpers/tsx-launcher");

const PORT = 3014;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let processHandle;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = () => {
      const request = http.get(`${BASE_URL}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else if (Date.now() >= deadline) reject(new Error("portal server timeout"));
        else setTimeout(poll, 250);
      });
      request.on("error", () => {
        if (Date.now() >= deadline) reject(new Error("portal server timeout"));
        else setTimeout(poll, 250);
      });
    };
    poll();
  });
}

test.describe("production portal bookkeeping", () => {
  test.beforeAll(async () => {
    processHandle = spawn(...resolveTestServerCommand(), {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        IS_LOCAL: "true",
        SKIP_AUTH: "true",
        DATAOPS_DOCS_DOMAIN: "1",
        DTC_OFFLINE: "1",
        DTC_CACHE_ROOT: createDocsCacheRoot("issue-190-docs-cache/bookkeeping-production-portal"),
        FRONTEND_ROOT: path.resolve(__dirname, "..", "..", "frontend"),
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await waitForServer();
  });

  test.afterAll(() => {
    if (processHandle) {
      try {
        process.kill(-processHandle.pid, "SIGTERM");
      } catch {}
    }
  });

  test("loads the real frontend Bookkeeping surface and operator states", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();

    await page.goto("/#/bookkeeping");
    await expect(page.getByRole("heading", { name: "Bookkeeping" })).toBeVisible();
    await expect(page.getByText("No bookkeeping entries")).toBeVisible();
    await expect(page.locator(".bookkeeping-documents")).toContainText(
      "No private documents uploaded",
    );

    await page.getByRole("button", { name: "Add entry" }).click();
    const entryForm = page.locator(".bookkeeping-entry-dialog");
    await entryForm.getByRole("button", { name: "Save" }).click();
    await expect(entryForm.getByRole("alert")).toHaveText(
      "Transaction date is required.",
    );
    await expect(entryForm.getByLabel("Transaction date")).toBeFocused();
    await expect(entryForm.getByLabel("Transaction date")).toHaveAttribute(
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
    await entryForm.getByLabel("Amount").fill("20.00");
    await entryForm.getByLabel("Category").fill("synthetic-testing");
    await entryForm.getByRole("button", { name: "Save" }).click();
    const createdRow = page.getByRole("row").filter({
      hasText: "Synthetic Portal Vendor",
    });
    await expect(createdRow).toContainText("20.00 EUR");
    await page.reload();
    await expect(createdRow).toContainText("Synthetic browser evidence");

    await page.getByRole("button", { name: "Set up business accounts" }).click();
    await expect(page.getByRole("status")).toContainText(
      "2 business accounts ready",
    );
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
      `${BASE_URL}/work/api/bookkeeping/links`,
    );
    expect(linksResponse.status()).toBe(200);
    const links = await linksResponse.json();
    expect(links.items).toHaveLength(1);
    expect(links.items[0].transactionId).toBe(transactionId);

    const faultResponse = await context.request.post(
      `${BASE_URL}/__e2e__/route-faults`,
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
      `${BASE_URL}/__e2e__/route-faults`,
    );
    expect(clearFaults.ok()).toBe(true);
    await page.reload();
    await expect(createdRow).toContainText("Synthetic Portal Vendor");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.body.classList.remove("sidebar-open"));
    const topbarGeometry = await page.locator(".mobile-topbar").evaluate((bar) => {
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
    expect(topbarGeometry.children).toHaveLength(5);
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
});
