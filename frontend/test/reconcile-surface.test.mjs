import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { escapeHtml as e } from "../src/core/html.js";
import { createReconcileClient, gateErrorOf } from "../src/surfaces/reconcile/index.js";
import {
  blockersMarkup,
  confirmationMarkup,
  headerActionsMarkup,
  logMarkup,
  monthBodyMarkup,
  stateBadgeMarkup,
  statsMarkup,
  tableMarkup,
} from "../src/surfaces/reconcile/markup.js";
import {
  matchOptions,
  periodFromPath,
  previousMonth,
  reconcilePath,
  rowActions,
  shiftMonth,
  visibleRows,
} from "../src/surfaces/reconcile/model.js";

const bank = (key, fields = {}) => ({ key, accountId: "revolut", statementId: "st-1", date: "2026-09-03", amount: "-120.00", currency: "EUR", counterparty: "Vendor", ...fields });
const ledger = (id, fields = {}) => ({ id, date: "2026-09-03", amount: "-120.00", currency: "EUR", counterparty: "Vendor", ...fields });

const MONTH = {
  period: "2026-09",
  state: "open",
  counters: { rows: 5, matched: 1, bankWithoutInvoice: 1, ledgerWithoutBank: 1, amountMismatch: 1, needsReview: 1, exceptions: 1 },
  blockers: 4,
  exceptionDigest: "abc",
  statements: [{ id: "st-1", accountId: "revolut", from: "2026-09-01", to: "2026-09-30" }],
  exceptionPolicies: [
    { kind: "tax_debit", proof: "tax-schedule", label: "Tax debit (ESt/Soli, GewSt, VAT)" },
    { kind: "bank_fee", proof: "bank-row", label: "Bank fee" },
  ],
  log: [{ at: "2026-10-01T09:00:00.000Z", by: "alexey", action: "pair", detail: { bankKey: "revolut:m1", transactionId: "tx-matched" } }],
  rows: [
    {
      id: "revolut:m1", date: "2026-09-01", counterparty: "Hosting Co", amount: "-50.00", currency: "EUR",
      bank: bank("revolut:m1", { date: "2026-09-01", amount: "-50.00", reference: "INV-77" }),
      ledger: ledger("tx-matched", { date: "2026-09-01", amount: "-50.00", category: "Hosting" }),
      documents: [{ id: "doc-1", label: "INV-77.pdf" }], pairBasis: "exact", confidence: "exact", status: "matched",
    },
    {
      id: "revolut:b1", date: "2026-09-05", counterparty: "<Unknown & Co>", amount: "-120.00", currency: "EUR",
      bank: bank("revolut:b1", { date: "2026-09-05", wallet: "EUR" }), documents: [],
      candidates: [{ transactionId: "tx-ledger-only", score: 0.6 }],
      status: "no-invoice", missing: "no ledger row or invoice for this bank transaction",
    },
    {
      id: "ledger:tx-ledger-only", date: "2026-09-07", counterparty: "Card shop", amount: "-80.00", currency: "USD",
      ledger: ledger("tx-ledger-only", { date: "2026-09-07", amount: "-80.00", currency: "USD" }), documents: [{ id: "doc-2" }],
      status: "payment-proof-missing", missing: "no bank transaction in the uploaded statements; upload a payment proof for this row",
    },
    {
      id: "revolut:mm", date: "2026-09-10", counterparty: "Printer", amount: "-101.50", currency: "EUR",
      bank: bank("revolut:mm", { amount: "-101.50" }), ledger: ledger("tx-mm", { amount: "-100.00" }), documents: [{ id: "doc-3" }],
      pairBasis: "fee", amountDifference: "1.50", status: "amount-mismatch", missing: "bank and ledger differ by 1.50 EUR; confirm the pair or fix the ledger amount",
    },
    {
      id: "revolut:tax", date: "2026-09-12", counterparty: "Finanzamt", amount: "-900.00", currency: "EUR",
      bank: bank("revolut:tax", { amount: "-900.00" }), documents: [],
      exception: { kind: "tax_debit", proof: "tax-schedule", satisfied: false, recorded: { kind: "tax_debit", by: "alexey", at: "2026-10-01T00:00:00Z" } },
      status: "needs-review", missing: "tax_debit needs proof: tax-schedule",
    },
  ],
};

const rowById = (id) => MONTH.rows.find((row) => row.id === id);

describe("reconciliation periods", () => {
  test("defaults to the previous month and reads the month from the path", () => {
    assert.equal(previousMonth("2026-10-31"), "2026-09");
    assert.equal(previousMonth("2026-01-15"), "2025-12");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(periodFromPath("/finance/reconcile/2026-09"), "2026-09");
    assert.equal(periodFromPath("/finance/reconcile"), null);
    assert.equal(periodFromPath("/finance/reconcile/2026-13"), null);
    assert.equal(reconcilePath("2026-09"), "/finance/reconcile/2026-09");
  });
});

describe("reconciliation table", () => {
  test("lists rows that are not matched first, the matched row last", () => {
    assert.deepEqual(visibleRows(MONTH.rows, "all").map((row) => row.status),
      ["no-invoice", "payment-proof-missing", "amount-mismatch", "needs-review", "matched"]);
    assert.deepEqual(visibleRows(MONTH.rows, "open").map((row) => row.id).includes("revolut:m1"), false);
    assert.deepEqual(visibleRows(MONTH.rows, "exceptions").map((row) => row.id), ["revolut:tax"]);
  });

  test("colours each status and highlights the missing side with the row's missing text", () => {
    const markup = tableMarkup(MONTH, "all", e);
    const row = (id) => markup.slice(markup.indexOf(`data-recon-row-id="${id}"`)).split("</tr>")[0];

    const bankOnly = row("revolut:b1");
    assert.match(bankOnly, /dk-badge--danger" data-recon-status="no-invoice">No invoice/);
    assert.match(bankOnly, /data-recon-missing="ledger">No ledger row/);
    assert.match(bankOnly, /data-recon-missing="documents">No invoice/);
    assert.match(bankOnly, /no ledger row or invoice for this bank transaction/);
    assert.match(bankOnly, /revolut · EUR/);
    assert.match(bankOnly, /&lt;Unknown &amp; Co&gt;/);

    const ledgerOnly = row("ledger:tx-ledger-only");
    assert.match(ledgerOnly, /data-recon-status="payment-proof-missing">No payment proof/);
    assert.match(ledgerOnly, /data-recon-missing="bank">No bank transaction/);
    assert.match(ledgerOnly, /data-recon-missing="proof">Missing/);
    assert.match(ledgerOnly, /href="\/bookkeeping\?tx=tx-ledger-only"/);
    assert.match(ledgerOnly, /−80\.00 <span class="recon-currency">USD/);

    const mismatch = row("revolut:mm");
    assert.match(mismatch, /dk-badge--warning" data-recon-status="amount-mismatch"/);
    assert.match(mismatch, /paired: fee, Δ 1\.50/);
    assert.doesNotMatch(mismatch, /data-recon-missing=/);

    const matched = row("revolut:m1");
    assert.match(matched, /dk-badge--success" data-recon-status="matched"/);
    assert.match(matched, /data-recon-doc="doc-1">INV-77\.pdf/);
    assert.match(matched, /INV-77<\/span>/);

    const exception = row("revolut:tax");
    assert.match(exception, /data-recon-exception="tax_debit"/);
    assert.match(exception, /needs: tax-schedule/);
    assert.match(exception, /data-recon-action="clear-exception"/);
  });

  test("offers per-row actions by side, and none once the month is closed", () => {
    assert.deepEqual(rowActions(rowById("revolut:b1")), ["attach-invoice", "create-ledger", "match", "exception"]);
    assert.deepEqual(rowActions(rowById("ledger:tx-ledger-only")), ["attach-proof", "match", "exception"]);
    assert.deepEqual(rowActions(rowById("revolut:mm")), ["confirm-pair", "unmatch", "exception"]);
    assert.deepEqual(rowActions(rowById("revolut:m1")), ["unmatch", "exception"]);
    const closed = { ...MONTH, state: "closed", closed: { by: "alexey", at: "2026-10-05T10:00:00.000Z" } };
    assert.doesNotMatch(tableMarkup(closed, "all", e), /data-recon-action=/);
    assert.match(headerActionsMarkup(closed), /data-recon-reopen/);
    assert.doesNotMatch(headerActionsMarkup(closed), /data-recon-close/);
    assert.match(stateBadgeMarkup(closed, e), /Closed by alexey · 2026-10-05 10:00/);
  });

  test("counters, confirmation state and the activity log", () => {
    const stats = statsMarkup(MONTH, "all", e);
    assert.match(stats, /data-recon-counter="bankWithoutInvoice">1</);
    assert.match(stats, /recon-stat--attention" data-recon-filter="payment-proof-missing"/);
    assert.match(confirmationMarkup(MONTH, e), /Exceptions not confirmed/);
    const stale = { ...MONTH, exceptionConfirmation: { digest: "x", by: "admin", at: "2026-10-01T00:00:00Z", count: 1, current: false } };
    assert.match(confirmationMarkup(stale, e), /re-confirm/);
    const current = { ...stale, exceptionConfirmation: { ...stale.exceptionConfirmation, current: true } };
    assert.match(confirmationMarkup(current, e), /1 exceptions confirmed by admin/);
    assert.match(headerActionsMarkup(MONTH), /data-recon-confirm/);
    const log = logMarkup(MONTH, e);
    assert.match(log, /<details class="recon-log"/);
    assert.match(log, /<strong>alexey<\/strong> pair/);
    assert.match(log, /transactionId: tx-matched/);
    assert.match(monthBodyMarkup(MONTH, "open", e), /role="radio"\s+aria-checked="true" data-recon-filter="open"/);
  });

  test("the match picker offers suggested candidates first", () => {
    const options = matchOptions(MONTH, rowById("revolut:b1"));
    assert.equal(options[0].id, "tx-ledger-only");
    assert.equal(options[0].score, 0.6);
    assert.deepEqual(matchOptions(MONTH, rowById("ledger:tx-ledger-only")).map((option) => option.id), ["revolut:b1", "revolut:tax"]);
  });
});

describe("close gate", () => {
  test("a blocked close renders every blocker from the 409", () => {
    const error = Object.assign(new Error("Month 2026-09 cannot close: 2 rows lack a side"), {
      status: 409,
      payload: {
        error: "Month 2026-09 cannot close: 2 rows lack a side",
        blockers: [
          { id: "revolut:b1", date: "2026-09-05", counterparty: "<Unknown & Co>", amount: "-120.00", currency: "EUR", status: "no-invoice",
            missing: "no ledger row or invoice for this bank transaction" },
          { id: "revolut:tax", kind: "tax_debit", proof: "tax-schedule" },
        ],
      },
    });
    const markup = blockersMarkup(gateErrorOf(error), e);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /Month 2026-09 cannot close: 2 rows lack a side/);
    assert.equal((markup.match(/data-recon-blocker=/g) || []).length, 2);
    assert.match(markup, /&lt;Unknown &amp; Co&gt;/);
    assert.match(markup, /−120\.00/);
    assert.match(markup, /dk-badge--danger">No invoice/);
    assert.match(markup, /tax_debit<\/span> needs tax-schedule/);
  });

  test("a non-admin confirm says who may confirm", () => {
    const denied = gateErrorOf(Object.assign(new Error("Forbidden"), { status: 403, payload: { error: "Forbidden" } }));
    assert.match(blockersMarkup(denied, e), /Only an admin confirms/);
  });
});

function fakeClient() {
  const calls = [];
  const puts = [];
  const request = async (url, options = {}) => {
    const path = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method || "GET", body });
    if (path.endsWith("/documents/prepare")) return { outcome: "created", uploadUrl: "https://s3.test/put", uploadHeaders: { "content-type": "application/pdf" }, document: { id: "doc-new" } };
    if (path.endsWith("/complete")) return { document: { id: "doc-new" } };
    return { month: MONTH };
  };
  const client = createReconcileClient({
    request,
    workApiUrl: (path) => `https://portal.test${path}`,
    fetchImpl: async (url, options) => { puts.push({ url, method: options.method }); return { ok: true }; },
    cryptoRef: globalThis.crypto,
  });
  const posts = () => calls.filter((call) => call.path.includes("/api/reconcile/")).map((call) => [call.path.replace("https://portal.test", ""), call.body]);
  return { client, calls, puts, posts };
}

const pdf = () => new File(["%PDF-1.4 receipt"], "receipt.pdf", { type: "application/pdf" });

describe("reconciliation actions", () => {
  test("attach proof uploads a receipt document, then posts it as the ledger row's payment proof", async () => {
    const { client, calls, puts, posts } = fakeClient();
    await client.attachProof("2026-09", rowById("ledger:tx-ledger-only"), pdf());
    const prepare = calls.find((call) => call.path.endsWith("/api/bookkeeping/documents/prepare"));
    assert.equal(prepare.body.documentType, "receipt");
    assert.equal(prepare.body.byteSize, 16);
    assert.match(prepare.body.sha256, /^[a-f0-9]{64}$/);
    assert.equal(prepare.body.accountId, undefined);
    assert.deepEqual(puts, [{ url: "https://s3.test/put", method: "PUT" }]);
    assert.ok(calls.some((call) => call.path.endsWith("/api/bookkeeping/documents/doc-new/complete")));
    assert.deepEqual(posts(), [["/api/reconcile/months/2026-09/proof", { transactionId: "tx-ledger-only", documentId: "doc-new" }]]);
  });

  test("an invoice for a bank-only row creates its ledger row with the document; for a ledger row it links the document", async () => {
    const bankSide = fakeClient();
    await bankSide.client.attachInvoice("2026-09", rowById("revolut:b1"), pdf(), { category: " Software " });
    assert.deepEqual(bankSide.posts(), [["/api/reconcile/months/2026-09/ledger", { bankKey: "revolut:b1", category: "Software", documentId: "doc-new" }]]);
    const ledgerSide = fakeClient();
    await ledgerSide.client.attachInvoice("2026-09", { ...rowById("ledger:tx-ledger-only"), documents: [] }, pdf());
    assert.deepEqual(ledgerSide.posts(), [["/api/reconcile/months/2026-09/document", { transactionId: "tx-ledger-only", documentId: "doc-new" }]]);
  });

  test("create ledger, exception, match and unmatch post the API's bodies", async () => {
    const { client, posts } = fakeClient();
    await client.createLedger("2026-09", rowById("revolut:b1"), { category: "Bank fees", description: "" });
    await client.markException("2026-09", rowById("revolut:tax"), { kind: "tax_debit", proof: "ESt Q3 schedule", note: " " });
    await client.markException("2026-09", rowById("ledger:tx-ledger-only"), { kind: "bank_fee" });
    await client.clearException("2026-09", rowById("revolut:tax"));
    await client.match("2026-09", rowById("revolut:b1"), "tx-ledger-only", "same invoice");
    await client.match("2026-09", rowById("ledger:tx-ledger-only"), "revolut:b1");
    await client.unmatch("2026-09", rowById("revolut:mm"));
    await client.confirmPair("2026-09", rowById("revolut:mm"));
    await client.close("2026-09");
    await client.reopen("2026-09", "late invoice");
    assert.deepEqual(posts(), [
      ["/api/reconcile/months/2026-09/ledger", { bankKey: "revolut:b1", category: "Bank fees" }],
      ["/api/reconcile/months/2026-09/exception", { row: "revolut:tax", kind: "tax_debit", proof: "ESt Q3 schedule" }],
      ["/api/reconcile/months/2026-09/exception", { row: "ledger:tx-ledger-only", kind: "bank_fee" }],
      ["/api/reconcile/months/2026-09/clear-exception", { row: "revolut:tax" }],
      ["/api/reconcile/months/2026-09/pair", { bankKey: "revolut:b1", transactionId: "tx-ledger-only", note: "same invoice" }],
      ["/api/reconcile/months/2026-09/pair", { bankKey: "revolut:b1", transactionId: "tx-ledger-only" }],
      ["/api/reconcile/months/2026-09/unpair", { bankKey: "revolut:mm", transactionId: "tx-mm" }],
      ["/api/reconcile/months/2026-09/pair", { bankKey: "revolut:mm", transactionId: "tx-mm" }],
      ["/api/reconcile/months/2026-09/close", {}],
      ["/api/reconcile/months/2026-09/reopen", { reason: "late invoice" }],
    ]);
  });

  test("rejects a non-PDF before uploading anything", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(client.attachProof("2026-09", rowById("ledger:tx-ledger-only"), new File(["x,y"], "a.csv", { type: "text/csv" })), /Only PDF/);
    assert.equal(calls.length, 0);
  });
});
