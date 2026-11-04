import { createHash } from "crypto";
import { isReportExemptTransaction } from "../db/bookkeeping";
import type { MonthRow } from "../reconcile/month";

export type InvoiceDisposition = {
  reportPeriod: string;
  kind: "verified-unpaid" | "deferred";
  reason: string;
  evidence: string;
  targetPeriod?: string;
  rowDigest: string;
  by: string;
  at: string;
};
export type PaymentReadinessBlocker = {
  reportPeriod: string; period: string; rowId: string; date: string; counterparty: string;
  amount: string; currency: string; status: string; reason: string; rowDigest: string;
};

/** Bind an operator decision to the exact invoice/payment facts reviewed. */
export function paymentRowDigest(row: MonthRow, reportPeriod: string): string {
  return createHash("sha256").update(JSON.stringify({
    reportPeriod, id: row.id, date: row.date, amount: row.amount, currency: row.currency,
    counterparty: row.counterparty, ledger: row.ledger, bank: row.bank,
    invoiceReview: row.invoiceReview, documents: row.documents, paymentProof: row.paymentProof, status: row.status,
  })).digest("hex");
}

export function validUnpaidDisposition(row: MonthRow, disposition: InvoiceDisposition | undefined, reportPeriod: string): boolean {
  return Boolean(disposition && ["verified-unpaid", "deferred"].includes(disposition.kind)
    && String(disposition.reason || "").trim() && String(disposition.evidence || "").trim() && disposition.by && disposition.at
    && (disposition.kind !== "deferred" || (/^\d{4}-(0[1-9]|1[0-2])$/.test(disposition.targetPeriod || "") && disposition.targetPeriod! > reportPeriod))
    && disposition.reportPeriod === reportPeriod
    && ["payment-proof-missing", "needs-review"].includes(row.status) && !row.bank && !row.paymentProof
    && disposition.rowDigest === paymentRowDigest(row, reportPeriod));
}

function needsCashAttribution(row: MonthRow) {
  return !row.bank && !row.paymentProof
    && (Boolean(row.invoiceReview) || ["issued-invoice", "invoice-document", "document"].includes(row.ledger?.sourceType || ""));
}

export function accountantPaymentBlockers(period: string, rows: MonthRow[], dispositions: Record<string, InvoiceDisposition> = {}) {
  return rows.filter((row) => !row.tax && !isReportExemptTransaction(row.ledger || row)
    && (row.status !== "matched" || (Number(row.amountDifference || 0) !== 0 && row.bank?.currency === row.ledger?.currency))
    && !validUnpaidDisposition(row, dispositions[row.id], period))
    .map((row): PaymentReadinessBlocker => {
      const attribution = needsCashAttribution(row);
      const reason = Number(row.amountDifference || 0) !== 0 ? "Bank and invoice amounts do not match"
        : row.invoiceReview ? `Invoice source amount/currency is incomplete or unverified for ${period}; ${row.missing || "review the source and cash-month attribution"}`
        : attribution ? `Cash-month attribution unresolved for ${period}; verify payment in this month or record an evidenced unpaid/deferred disposition. Invoice issue date alone does not confirm payment.`
        : row.missing || "Payment and required evidence have not been verified";
      return {
        reportPeriod: period, period, rowId: row.id, date: row.date, counterparty: row.counterparty,
        amount: row.amount, currency: row.currency, status: attribution ? "needs-attribution" : row.status,
        reason, rowDigest: paymentRowDigest(row, period),
      };
    });
}
