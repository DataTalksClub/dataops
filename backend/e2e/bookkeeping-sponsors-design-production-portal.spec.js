const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = 3318;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCREENSHOTS = path.resolve(
  __dirname,
  "..",
  "..",
  ".tmp",
  "screenshots",
  "bookkeeping-sponsors",
);
let server;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = () => {
      const request = http.get(`${BASE_URL}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else if (Date.now() >= deadline) reject(new Error("portal server timeout"));
        else setTimeout(poll, 200);
      });
      request.on("error", () => {
        if (Date.now() >= deadline) reject(new Error("portal server timeout"));
        else setTimeout(poll, 200);
      });
    };
    poll();
  });
}

async function setTheme(page, dark) {
  await page.evaluate((enabled) => {
    localStorage.setItem("dtc-theme", enabled ? "dark" : "light");
    document.body.classList.toggle("dark", enabled);
  }, dark);
}

async function expectPalette(page, dark) {
  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {
      page: style.getPropertyValue("--page-bg").trim(),
      surface: style.getPropertyValue("--surface-bg").trim(),
      border: style.getPropertyValue("--border-muted").trim(),
      text: style.getPropertyValue("--text-primary").trim(),
    };
  });
  expect(palette).toEqual(dark
    ? { page: "#0d1117", surface: "#161b22", border: "#30363d", text: "#e6edf3" }
    : { page: "#ffffff", surface: "#ffffff", border: "#d0d7de", text: "#24292f" });
}

async function expectNoPageOverflow(page, width) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(width);
}

async function routeBookkeeping(page) {
  const transactions = [
    {
      id: "entry-subscription",
      transactionDate: "2026-07-03",
      paidDate: "2026-07-04",
      counterparty: "Example Analytics",
      description: "Monthly reporting subscription",
      amount: "84.00",
      currency: "EUR",
      category: "software",
      entryType: "expense",
      statementRef: "July statement",
    },
    {
      id: "entry-production",
      transactionDate: "2026-07-11",
      counterparty: "Example Studio",
      description: "Workshop production support",
      amount: "320.00",
      currency: "EUR",
      category: "production",
      entryType: "expense",
    },
  ];
  await page.route("**/work/api/bookkeeping/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/transactions")) return route.fulfill({ json: { items: transactions } });
    if (pathname.endsWith("/documents")) return route.fulfill({ json: { items: [{ id: "document-july", originalFilename: "Example Studio invoice.pdf", documentType: "invoice" }] } });
    if (pathname.endsWith("/links")) return route.fulfill({ json: { items: [{ id: "link-july", documentId: "document-july", transactionId: "entry-production" }] } });
    if (pathname.endsWith("/accounts")) return route.fulfill({ json: { items: [{ id: "account-business", displayName: "Business account", kind: "bank" }] } });
    return route.fulfill({ status: 404, json: { error: "Synthetic route unavailable" } });
  });
}

async function routeSponsors(page) {
  let unlinkInvoiceRequests = 0;
  const organization = { id: "organization-example", displayName: "Example Learning Lab", version: 1 };
  const contact = {
    id: "contact-example",
    organizationId: organization.id,
    name: "Example Partner",
    emails: ["partner@example.invalid"],
    primary: true,
    version: 1,
  };
  const booking = {
    id: "booking-example",
    organizationId: organization.id,
    primaryContactId: contact.id,
    slotType: "main",
    status: "materials-pending",
    plannedPublicationDate: "2026-09-18",
    materialDeadline: "2026-09-08",
    nextActionDate: "2026-09-03",
    cardId: "linked-newsletter",
    notes: "Confirm the public campaign link before scheduling.",
    version: 2,
  };
  await page.route("**/work/api/notifications", (route) => route.fulfill({
    json: {
      notifications: [{
        message: "Sponsor materials need review",
        dueAt: "2026-09-03",
        dismissed: false,
        metadata: { sponsorBookingId: booking.id },
      }],
    },
  }));
  await page.route("**/work/api/sponsor-crm/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/organizations")) return route.fulfill({ json: { items: [organization] } });
    if (pathname.endsWith("/contacts")) return route.fulfill({ json: { items: [contact] } });
    if (pathname.endsWith("/bookings")) return route.fulfill({ json: { items: [booking] } });
    if (pathname.endsWith(`/bookings/${booking.id}/history`)) return route.fulfill({ json: { items: [{ oldStatus: "confirmed", newStatus: "materials-pending", createdAt: "2026-08-28T09:00:00Z", note: "Waiting for reviewed copy." }] } });
    if (pathname.endsWith(`/bookings/${booking.id}/finance/invoice/invoice-example`) && request.method() === "DELETE") {
      unlinkInvoiceRequests += 1;
      return route.fulfill({ json: { status: "unlinked" } });
    }
    if (pathname.endsWith(`/bookings/${booking.id}/finance`)) return route.fulfill({ json: {
      enabled: true,
      classified: true,
      role: "admin",
      finance: { version: 3, invoiceRequirement: "required", amountDue: "1200.00", currency: "EUR", taxMode: "included", dueOn: "2026-09-30", invoiceRequestedAt: "2026-08-29T10:00:00Z" },
      invoiceState: "issued",
      paymentState: "partially-paid",
      timingState: "on-track",
      outstanding: "700.00",
      invoice: { id: "invoice-example", label: "September sponsor invoice", uploadedAt: "2026-08-30" },
      payments: [{ id: "payment-example", effectiveDate: "2026-09-01", amount: "500.00", currency: "EUR" }],
      reconciliationStatus: "coherent",
      paymentLinkCount: 1,
      paymentLinkLimit: 20,
    } });
    if (pathname.includes(`/bookings/${booking.id}/communications`)) return route.fulfill({ json: {
      items: [
        { id: "suggestion-example", recordType: "communication-suggestion", communicationType: "materials-reminder", status: "open", safeReason: "Materials are due before the publication slot." },
        { id: "draft-example", recordType: "communication-draft-version", communicationId: "communication-example", version: 2, reviewState: "awaiting_review", reviewable: true },
      ],
      nextCursor: null,
      config: { enabled: true },
      permissions: { role: "admin", canApprove: true, canCancel: true, canReconcile: true },
    } });
    if (pathname.endsWith("/communications/communication-example/presentations") && request.method() === "POST") return route.fulfill({ json: {
      presentationId: "presentation-example",
      token: "one-time-review-token",
      previewHash: "synthetic-review-hash",
      preview: {
        from: "operations@example.invalid",
        replyTo: "operations@example.invalid",
        to: "partner@example.invalid",
        communicationType: "materials-reminder",
        subject: "Materials for the September newsletter",
        body: "Hello Example Partner,\n\nPlease review the public campaign link before the material deadline.",
        publicLinks: ["https://example.org/campaign"],
      },
    } });
    if (pathname.endsWith("/communications/communication-example/presentations/presentation-example/reject") && request.method() === "POST") return route.fulfill({ json: { status: "revoked" } });
    return route.fulfill({ status: 404, json: { error: "Synthetic route unavailable" } });
  });
  return { unlinkInvoiceRequests: () => unlinkInvoiceRequests };
}

test.describe("Bookkeeping and Sponsors design prototype", () => {
  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS, { recursive: true });
    server = spawn("npx", ["tsx", "scripts/test-server.ts"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        IS_LOCAL: "true",
        SKIP_AUTH: "true",
        DATAOPS_DOCS_DOMAIN: "1",
        DTC_OFFLINE: "1",
        CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: "false",
        CONVERSATIONAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_ENABLED_PLUGINS: "none",
        CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: "false",
        FRONTEND_ROOT: path.resolve(__dirname, "..", "..", "frontend"),
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await waitForServer();
  });

  test.afterAll(() => {
    if (!server) return;
    try { process.kill(-server.pid, "SIGTERM"); } catch {}
  });

  test("Bookkeeping reflows jobs and ledger in exact light and dark palettes", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await routeBookkeeping(page);
    await page.goto("/#/bookkeeping");
    await expect(page.getByRole("heading", { name: "Bookkeeping" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Bookkeeping jobs" })).toContainText("Record ledger");
    await expect(page.getByRole("row").filter({ hasText: "Example Studio" })).toContainText("Missing");
    await expectPalette(page, false);
    await expectNoPageOverflow(page, 1440);
    await page.screenshot({ path: path.join(SCREENSHOTS, "bookkeeping-desktop-light.png") });

    await setTheme(page, true);
    await expect(page.getByRole("heading", { name: "Bookkeeping" })).toBeVisible();
    await expectPalette(page, true);
    await page.screenshot({ path: path.join(SCREENSHOTS, "bookkeeping-desktop-dark.png") });

    for (const width of [820, 420]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoPageOverflow(page, width);
      await expect(page.getByRole("row").filter({ hasText: "Example Studio" })).toHaveCSS("display", "block");
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoPageOverflow(page, 390);
    await page.screenshot({ path: path.join(SCREENSHOTS, "bookkeeping-mobile-dark.png") });
    await setTheme(page, false);
    await expectPalette(page, false);
    await page.screenshot({ path: path.join(SCREENSHOTS, "bookkeeping-mobile-light.png") });

    await page.getByRole("button", { name: "Delete" }).first().click();
    const deleteDialog = page.locator(".bookkeeping-delete-dialog");
    await expect(deleteDialog).toContainText("Linked evidence is not deleted");
    await deleteDialog.getByRole("button", { name: "Keep entry" }).click();
    await expect(page.getByRole("button", { name: "Delete" }).first()).toBeFocused();

    const accessibility = await new AxeBuilder({ page }).include(".bookkeeping-surface").analyze();
    expect(accessibility.violations.filter((item) => ["critical", "serious"].includes(item.impact))).toEqual([]);
    await context.close();
  });

  test("Sponsors uses booking master/detail sections and preserves exact review safety", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const sponsorRouteState = await routeSponsors(page);
    await page.goto("/#/sponsors");
    await expect(page.getByRole("heading", { name: "Sponsors" })).toBeVisible();
    await page.getByLabel("Bookings").getByRole("button", { name: "Open booking" }).click();
    await expect(page.getByRole("heading", { name: "Booking detail" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Booking detail sections" })).toContainText("Finance");
    await expect(page.locator('[data-booking-panel="communications"]')).toContainText("Draft version 2");
    await expect(page.locator(".crm-booking-row[aria-current=true]")).toHaveCSS("border-left-width", "0px");
    await expectPalette(page, false);
    await expectNoPageOverflow(page, 1440);
    await page.screenshot({ path: path.join(SCREENSHOTS, "sponsors-desktop-light.png") });

    await setTheme(page, true);
    await expect(page.getByRole("heading", { name: "Booking detail" })).toBeVisible();
    await expectPalette(page, true);
    await page.screenshot({ path: path.join(SCREENSHOTS, "sponsors-desktop-dark.png") });

    await page.getByRole("button", { name: "Review exact draft" }).click();
    const review = page.locator("[data-communication-review-dialog]");
    await expect(review).toContainText("Approval queues exactly this one-recipient plain-text message");
    await expect(review.getByRole("heading", { name: "Materials for the September newsletter" })).toBeVisible();
    await review.getByRole("button", { name: "Reject / close" }).click();
    await expect(review).not.toBeVisible();

    await page.getByRole("button", { name: "Unlink invoice" }).click();
    const confirm = page.locator("[data-sponsor-confirm-dialog]");
    await expect(confirm).toContainText("The file stays in Bookkeeping");
    await confirm.getByRole("button", { name: "Keep current record" }).click();
    await expect(page.getByRole("button", { name: "Unlink invoice" })).toBeFocused();
    await page.getByRole("button", { name: "Unlink invoice" }).click();
    await confirm.getByRole("button", { name: "Unlink invoice" }).click();
    await expect.poll(sponsorRouteState.unlinkInvoiceRequests).toBe(1);

    for (const width of [820, 420]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator(".crm-master")).toBeHidden();
      await expect(page.locator(".crm-detail-pane")).toBeVisible();
      await expectNoPageOverflow(page, width);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoPageOverflow(page, 390);
    await page.screenshot({ path: path.join(SCREENSHOTS, "sponsors-mobile-dark.png") });
    await setTheme(page, false);
    await expect(page.getByRole("heading", { name: "Booking detail" })).toBeVisible();
    await expectPalette(page, false);
    await page.screenshot({ path: path.join(SCREENSHOTS, "sponsors-mobile-light.png") });

    const accessibility = await new AxeBuilder({ page }).include(".sponsor-crm-surface").analyze();
    expect(accessibility.violations.filter((item) => ["critical", "serious"].includes(item.impact))).toEqual([]);
    await context.close();
  });
});
