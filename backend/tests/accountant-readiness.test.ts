import assert from "node:assert/strict";
import { it } from "node:test";
import { accountantPaymentBlockers, paymentRowDigest, validUnpaidDisposition, type InvoiceDisposition } from "../src/finance/accountantReadiness";
import type { MonthRow } from "../src/reconcile/month";

const invoice = (): MonthRow => ({
  id: "ledger:invented-invoice", date: "2031-07-04", counterparty: "Invented Cloud Service", amount: "-41.00", currency: "EUR",
  ledger: { id: "invented-invoice", date: "2031-07-04", counterparty: "Invented Cloud Service", amount: "-41.00", currency: "EUR", sourceType: "invoice-document" },
  documents: [{ id: "invented-receipt" }], status: "payment-proof-missing", missing: "Payment unconfirmed",
});
const disposition = (row: MonthRow): InvoiceDisposition => ({ reportPeriod: "2031-07", kind: "verified-unpaid", reason: "Operator verified outstanding receivable", evidence: "Invented receivables register reference", rowDigest: paymentRowDigest(row, "2031-07"), by: "invented-operator", at: "2031-07-31T10:00:00Z" });

it("requires explicit current audited unpaid evidence and keeps the unresolved source row intact", () => {
  const row = invoice();
  assert.equal(accountantPaymentBlockers("2031-07", [row]).length, 1);
  const decision = disposition(row);
  assert.notEqual(paymentRowDigest(row, "2031-07"), paymentRowDigest(row, "2031-08"));
  assert.equal(validUnpaidDisposition(row, decision, "2031-08"), false);
  assert.deepEqual(accountantPaymentBlockers("2031-07", [row], { [row.id]: decision }), []);
  assert.equal(row.status, "payment-proof-missing");
  assert.equal(validUnpaidDisposition({ ...row, amount: "-42.00" }, decision, "2031-07"), false);
  assert.equal(validUnpaidDisposition({ ...row, currency: "USD" }, decision, "2031-07"), false);
  assert.equal(validUnpaidDisposition(row, { ...decision, evidence: "" }, "2031-07"), false);
  assert.equal(validUnpaidDisposition(row, { ...decision, kind: "deferred" }, "2031-07"), false);
  assert.equal(validUnpaidDisposition(row, { ...decision, kind: "deferred", targetPeriod: "2031-08" }, "2031-07"), true);
});

it("blocks amount discrepancies, missing invoices and unconfirmed proofs even after a manual bank pair", () => {
  const row = invoice();
  const bank = { key: "invented-bank", accountId: "finom", date: row.date, amount: "-43.00", currency: "EUR", counterparty: row.counterparty };
  const mismatch = { ...row, bank, status: "matched" as const, amountDifference: "2.00", pairBasis: "manual" as const };
  assert.match(accountantPaymentBlockers("2031-07", [mismatch])[0].reason, /amounts do not match/);
  for (const status of ["amount-mismatch", "needs-review", "no-invoice"] as const) {
    const changed = { ...row, status };
    assert.equal(accountantPaymentBlockers("2031-07", [changed], { [row.id]: disposition(row) }).length, 1);
  }
});

it("accepts confirmed personal payment evidence and preserves tax/owner exclusions", () => {
  const row = invoice();
  const paid = { ...row, status: "matched" as const, paymentProof: { documentId: "invented-personal-card-proof", by: "invented-operator", at: "2031-07-31" } };
  const tax = { ...row, id: "invented-tax", tax: true };
  const owner = { ...row, id: "invented-owner", ledger: { ...row.ledger!, category: "Owner pay", ownerPayType: "draw" } };
  assert.deepEqual(accountantPaymentBlockers("2031-07", [paid, tax, owner]), []);
});
