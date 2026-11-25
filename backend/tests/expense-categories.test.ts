import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { putBookkeepingItem } from "../src/db/bookkeeping";
import {
  CANONICAL_EXPENSE_CATEGORIES,
  SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES,
  validateExpenseCategoryAssignment,
} from "../src/finance/expenseCategories";

const invoke = (method: string, path: string, body?: unknown) =>
  handler(
    {
      httpMethod: method,
      path,
      headers: {},
      body: body === undefined ? null : JSON.stringify(body),
      queryStringParameters: null,
    },
    {},
  );

describe("expense category vocabulary", () => {
  it("matches the frontend canonical expense category list", async () => {
    const frontendPath = path.resolve(import.meta.dirname, "../../frontend/src/surfaces/finance/expense-categories.js");
    const mod = await import(frontendPath);
    assert.deepEqual([...mod.CANONICAL_EXPENSE_CATEGORIES], [...CANONICAL_EXPENSE_CATEGORIES]);
    assert.deepEqual([...mod.SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES], [...SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES]);
  });

  it("accepts canonical expense categories and rejects non-canonical ones with a clear message", () => {
    for (const cat of CANONICAL_EXPENSE_CATEGORIES) {
      const ok = validateExpenseCategoryAssignment({ category: cat, entryType: "expense" });
      assert.deepEqual(ok, { ok: true, category: cat });
    }

    const bad = validateExpenseCategoryAssignment({ category: "Work-related", entryType: "expense" });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.match(bad.error, /Invalid expense category "Work-related"/);
      assert.match(bad.error, /Business Software/);
    }
  });

  it("preserves income categories and special VAT/tax/health/owner-pay categories", () => {
    const income = validateExpenseCategoryAssignment({ category: "Sponsorship", entryType: "income" });
    assert.deepEqual(income, { ok: true, category: "Sponsorship" });

    for (const special of SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES) {
      const res = validateExpenseCategoryAssignment({ category: special, entryType: "expense" });
      assert.deepEqual(res, { ok: true, category: special });
    }
  });
});

describe("bookkeeping expense category enforcement API", () => {
  let client: Awaited<ReturnType<typeof getClient>>;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(stopLocal);

  it("returns canonical and special expense categories from GET /api/bookkeeping/categories", async () => {
    const res = await invoke("GET", "/api/bookkeeping/categories");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.categories, CANONICAL_EXPENSE_CATEGORIES);
    assert.deepEqual(body.specialCategories, SPECIAL_NON_OPERATING_EXPENSE_CATEGORIES);
  });

  it("rejects non-canonical expense categories on POST and PUT /api/bookkeeping/transactions", async () => {
    const badPost = await invoke("POST", "/api/bookkeeping/transactions", {
      transactionDate: "2026-10-01",
      counterparty: "Synthetic Vendor",
      description: "Test expense",
      amount: "12.00",
      currency: "EUR",
      entryType: "expense",
      category: "Misc Stuff",
    });
    assert.equal(badPost.statusCode, 400);
    const postErr = JSON.parse(badPost.body);
    assert.match(postErr.error, /Invalid expense category "Misc Stuff"/);
    assert.deepEqual(postErr.fields, ["category"]);

    const okPost = await invoke("POST", "/api/bookkeeping/transactions", {
      transactionDate: "2026-10-01",
      counterparty: "Synthetic Vendor",
      description: "Test expense",
      amount: "12.00",
      currency: "EUR",
      entryType: "expense",
      category: "AI Tools",
    });
    assert.equal(okPost.statusCode, 201);
    const created = JSON.parse(okPost.body);

    const badPut = await invoke("PUT", `/api/bookkeeping/transactions/${created.id}`, {
      category: "Unknown Bucket",
    });
    assert.equal(badPut.statusCode, 400);
    assert.match(JSON.parse(badPut.body).error, /Invalid expense category "Unknown Bucket"/);
  });

  it("allows unrelated edits to legacy rows with non-canonical categories without losing evidence", async () => {
    const legacy = (
      await putBookkeepingItem(client, "bookkeeping", {
        transactionDate: "2024-05-10",
        counterparty: "Legacy Vendor",
        description: "Legacy expense",
        amount: "50.00",
        currency: "USD",
        entryType: "expense",
        category: "Work-related",
      })
    ).item;

    const editRes = await invoke("PUT", `/api/bookkeeping/transactions/${legacy.id}`, {
      amountEur: "46.50",
      rateSource: "ECB 10 May 2024",
    });
    assert.equal(editRes.statusCode, 200);
    const updated = JSON.parse(editRes.body);
    assert.equal(updated.category, "Work-related");
    assert.equal(updated.amountEur, "46.50");
  });

  it("allows income categories on income transactions", async () => {
    const res = await invoke("POST", "/api/bookkeeping/transactions", {
      transactionDate: "2026-10-05",
      counterparty: "Sponsor Co",
      description: "Sponsorship",
      amount: "1000.00",
      currency: "EUR",
      entryType: "income",
      category: "Sponsor Income",
    });
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).category, "Sponsor Income");
  });

  it("allows invoice drafts with no category and rejects non-canonical categories on invoice edits", async () => {
    const draftId = "a".repeat(64);
    await putBookkeepingItem(client, "invoice", {
      id: draftId,
      revision: 1,
      status: "pending",
      fields: { counterparty: "Vendor", description: "Subscription", amount: "20.00", currency: "EUR" },
      extraction: { method: "manual", evidence: [], issues: [], direction: "expense" },
      source: { intakeItemIds: [], artifactId: "art-1", checksum: "sum-1" },
      destinations: { dropbox: { state: "pending", operationId: "op-1" }, sheets: { state: "pending", operationId: "op-2" } },
      audit: [],
    }, `invoice-draft#${draftId}`);

    const emptyOk = await invoke("PUT", `/api/bookkeeping/invoices/${draftId}`, {
      revision: 1,
      fields: { category: "" },
    });
    assert.equal(emptyOk.statusCode, 200);

    const badEdit = await invoke("PUT", `/api/bookkeeping/invoices/${draftId}`, {
      revision: 2,
      fields: { category: "Not A Category" },
    });
    assert.equal(badEdit.statusCode, 400);
    assert.match(JSON.parse(badEdit.body).error, /Invalid expense category "Not A Category"/);

    const okEdit = await invoke("PUT", `/api/bookkeeping/invoices/${draftId}`, {
      revision: 2,
      fields: { category: "AI Tools" },
    });
    assert.equal(okEdit.statusCode, 200);
    assert.equal(JSON.parse(okEdit.body).fields.category, "AI Tools");
  });
});
