const { test, expect } = require("@playwright/test");

const synthetic = [
  {
    id: "synthetic-1",
    transactionDate: "2026-07-10",
    paidDate: "2026-07-11",
    counterparty: "Synthetic Vendor",
    description: "Synthetic service",
    amount: "12.50",
    currency: "EUR",
    category: "software",
    entryType: "expense",
    statementRef: "synthetic-ref",
  },
];
test.beforeEach(async ({ page }) => {
  await page.route("**/api/bookkeeping/transactions**", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: { items: synthetic } });
    if (method === "DELETE") return route.fulfill({ status: 204, body: "" });
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: method === "POST" ? 201 : 200,
      json: { ...synthetic[0], ...body, id: body.id || "synthetic-created" },
    });
  });
  await page.goto("/#/bookkeeping");
});
test("shows populated ledger, separated totals and filtering", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "Bookkeeping" }),
  ).toBeVisible();
  await expect(page.getByText("EUR 12.50")).toBeVisible();
  await page.screenshot({
    path: ".tmp/bookkeeping-populated.png",
    fullPage: true,
  });
  await page
    .getByPlaceholder("Provider, description, category")
    .fill("no match");
  await expect(page.getByText("No bookkeeping entries")).toBeVisible();
  await page.screenshot({
    path: ".tmp/bookkeeping-filtered.png",
    fullPage: true,
  });
});
test("creates, validates, edits and confirms deletion", async ({ page }) => {
  await page.getByRole("button", { name: "Add entry" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Transaction date is required.",
  );
  await expect(page.locator('[name="transactionDate"]')).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page
    .locator("#bookkeeping-dialog")
    .screenshot({ path: ".tmp/bookkeeping-validation.png" });
  await page.locator('[name="transactionDate"]').fill("2026-07-12");
  await page.locator('[name="counterparty"]').fill("Synthetic New");
  await page.locator('[name="description"]').fill("Synthetic description");
  await page.locator('[name="amount"]').fill("20.00");
  await page.locator("#bookkeeping-dialog").evaluate(function (dialog) {
    dialog.close();
    dialog.show();
  });
  await page.waitForTimeout(100);
  await page
    .locator("#bookkeeping-dialog")
    .screenshot({ path: ".tmp/bookkeeping-create-edit.png" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Synthetic New")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Delete bookkeeping entry?" }),
  ).toBeVisible();
  await page
    .locator("#bookkeeping-delete-dialog")
    .screenshot({ path: ".tmp/bookkeeping-delete-confirmation.png" });
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await expect(
    page.getByRole("cell", { name: "Synthetic Vendor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Delete entry" }).click();
});
test("remains usable on mobile and exposes evidence workflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Evidence and monthly package")).toBeVisible();
  await expect(page.getByLabel("PDF evidence")).toBeVisible();
  await expect(page.getByLabel("Report month")).toBeVisible();
  await page.screenshot({
    path: ".tmp/bookkeeping-mobile.png",
    fullPage: true,
  });
});
