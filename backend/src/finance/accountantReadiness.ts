import { createHash } from "crypto";
import { isReportExemptTransaction } from "../db/bookkeeping";
import type { MonthRow } from "../reconcile/month";

export type InvoiceDisposition = {
  kind: "verified-unpaid" | "deferred";
  reason: string;
  evidence: string;
  targetPeriod?: string;
  rowDigest: string;
  by: string;
  at: string;
};
export type PaymentReadinessBlocker = {
  period: string; rowId: string; date: string; counterparty: string;
  amount: string; currency: string; status: string; reason: string; rowDigest: string;
};

/** Bind an operator decision to the exact invoice/payment facts reviewed. */
export function paymentRowDigest(row: MonthRow): string {
  return createHash("sha256").update(JSON.stringify({
    id: row.id, date: row.date, amount: row.amount, currency: row.currency,
    counterparty: row.counterparty, ledger: row.ledger, bank: row.bank,
    documents: row.documents, paymentProof: row.paymentProof, status: row.status,
  })).digest("hex");
}

export function validUnpaidDisposition(row: MonthRow, disposition?: InvoiceDisposition): boolean {
  return Boolean(disposition && ["verified-unpaid", "deferred"].includes(disposition.kind)
    && String(disposition.reason || "").trim() && String(disposition.evidence || "").trim() && disposition.by && disposition.at
    && (disposition.kind !== "deferred" || /^\d{4}-(0[1-9]|1[0-2])$/.test(disposition.targetPeriod || ""))
    && row.status === "payment-proof-missing" && !row.bank && !row.paymentProof
    && disposition.rowDigest === paymentRowDigest(row));
}

export function accountantPaymentBlockers(period: string, rows: MonthRow[], dispositions: Record<string, InvoiceDisposition> = {}) {
  return rows.filter((row) => !row.tax && !isReportExemptTransaction(row.ledger || row)
    && (row.status !== "matched" || (Number(row.amountDifference || 0) !== 0 && row.bank?.currency === row.ledger?.currency)) && !validUnpaidDisposition(row, dispositions[row.id]))
    .map((row): PaymentReadinessBlocker => ({
      period, rowId: row.id, date: row.date, counterparty: row.counterparty,
      amount: row.amount, currency: row.currency, status: row.status,
      reason: Number(row.amountDifference || 0) !== 0 ? "Bank and invoice amounts do not match" : row.missing || "Payment and required evidence have not been verified", rowDigest: paymentRowDigest(row),
    }));
}
