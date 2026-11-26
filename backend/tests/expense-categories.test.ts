import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../src/handler";
import { validateAndNormalizeAllocations } from "../src/bookkeepingAllocations";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { putBookkeepingItem } from "../src/db/bookkeeping";
import {
  CANONICAL_EXPENSE_CATEGORIES,
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
    const frontendUrl = new URL("../../frontend/src/surfaces/finance/expense-categories.js", import.meta.url);
    const mod = await import(frontendUrl.href);
    assert.deepEqual([...mod.CANONICAL_EXPENSE_CATEGORIES], [...CANONICAL_EXPENSE_CATEGORIES]);
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

  it("preserves income categories but rejects out-of-SOP special expense categories", () => {
    const income = validateExpenseCategoryAssignment({ category: "Sponsorship", entryType: "income" });
    assert.deepEqual(income, { ok: true, category: "Sponsorship" });

    for (const special of ["VAT", "Owner pay", "Owner withdrawal"]) {
      const res = validateExpenseCategoryAssignment({ category: special, entryType: "expense" });
      assert.equal(res.ok, false, special);
    }
  });
  it("rejects legacy parent categories in allocation writes, including when child categories are canonical", () => {
    for (const category of [undefined, "AI Tools"]) {
      assert.throws(() => validateAndNormalizeAllocations({
        transaction: { amount: "20.00", currency: "EUR", entryType: "expense", category: "Work-related" },
        rawAllocations: [{ documentId: "synthetic-invoice", amount: "20.00", category }],
        documentsById: new Map([["synthetic-invoice", { id: "synthetic-invoice", status: "active", documentType: "invoice" }]]),
      }), /Invalid expense category "Work-related"/);
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

  it("returns only canonical expense categories from GET /api/bookkeeping/categories", async () => {
    const res = await invoke("GET", "/api/bookkeeping/categories");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.categories, CANONICAL_EXPENSE_CATEGORIES);
    assert.deepEqual(Object.keys(body), ["categories"]);
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

  it("rejects unchanged non-canonical categories on unrelated and explicit edits", async () => {
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
    assert.equal(editRes.statusCode, 400);
    const unchangedCategory = await invoke("PUT", `/api/bookkeeping/transactions/${legacy.id}`, {
      category: "Work-related",
    });
    assert.equal(unchangedCategory.statusCode, 400);
    const stored = JSON.parse((await invoke("GET", `/api/bookkeeping/transactions/${legacy.id}`)).body);
    assert.equal(stored.category, "Work-related");
    assert.equal(stored.amountEur, undefined, "rejected updates must not mutate the row");
    const repaired = await invoke("PUT", `/api/bookkeeping/transactions/${legacy.id}`, { category: "Business Software" });
    assert.equal(repaired.statusCode, 200);
  });

  it("rejects special categories rather than creating out-of-SOP expenses", async () => {
    for (const category of ["VAT", "Owner pay", "Owner withdrawal"]) {
      const response = await invoke("POST", "/api/bookkeeping/transactions", {
        transactionDate: "2026-10-06", counterparty: "Synthetic Vendor", description: "Synthetic expense",
        amount: "10.00", currency: "EUR", entryType: "expense", category,
      });
      assert.equal(response.statusCode, 400, category);
    }
  });

  it("rejects unchanged legacy invoice categories, including omitted category on unrelated edits", async () => {
    const draftId = "b".repeat(64);
    await putBookkeepingItem(client, "invoice", {
      id: draftId, revision: 1, status: "pending",
      fields: { counterparty: "Synthetic Vendor", description: "Synthetic legacy expense", amount: "20.00", currency: "EUR", category: "Work-related" },
      extraction: { method: "manual", evidence: [], issues: [], direction: "expense" },
      source: { intakeItemIds: [], artifactId: "synthetic-artifact", checksum: "synthetic-checksum" },
      destinations: { dropbox: { state: "pending", operationId: "synthetic-op-a" }, sheets: { state: "pending", operationId: "synthetic-op-b" } },
      audit: [],
    }, `invoice-draft#${draftId}`);
    for (const fields of [{ category: "Work-related" }, { description: "Unrelated edit" }]) {
      const response = await invoke("PUT", `/api/bookkeeping/invoices/${draftId}`, { revision: 1, fields });
      assert.equal(response.statusCode, 400);
    }
    const stored = JSON.parse((await invoke("GET", `/api/bookkeeping/invoices/${draftId}`)).body);
    assert.equal(stored.revision, 1);
    assert.equal(stored.fields.description, "Synthetic legacy expense");
    const repaired = await invoke("PUT", `/api/bookkeeping/invoices/${draftId}`, { revision: 1, fields: { category: "Business Software" } });
    assert.equal(repaired.statusCode, 200);
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
