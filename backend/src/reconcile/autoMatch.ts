/**
 * Automatic matching after a statement upload: the pairing of every bank row
 * of the touched months against the ledger (amount, date window, canonical
 * vendor, FX by the bank's original amount, the ledger's EUR amount or a
 * dated ECB reference rate) is persisted as auto-matches. Exact and strong
 * pairs become matches; proposed, fee-differing and ambiguous ones stay open
 * for a person. `matchesOf` is the reviewer's view of the result.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { loadEcbRates } from "../finance/rates";
import { pairAll, type FxLookup, type ManualPair, type MonthRow } from "./month";
import { getMonth, mergedDecisions, MonthConflictError, mutateMonth, snapshot, type MonthView } from "./monthService";

export const AUTO_MATCH_ACTOR = "auto-match";

export type AutoMatchResult = { attached: number; byPeriod: Record<string, number>; skippedClosedMonths: string[] };

const shiftMonth = (period: string, delta: number) => {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
};

export async function autoMatchMonths(client: DynamoDBDocumentClient, periods: string[], options: { fx?: FxLookup } = {}): Promise<AutoMatchResult> {
  const result: AutoMatchResult = { attached: 0, byPeriod: {}, skippedClosedMonths: [] };
  const touched = new Set(periods);
  if (!touched.size) return result;
  const data = await snapshot(client);
  let fx = options.fx;
  if (!fx) {
    const near = new Set([...touched].flatMap((period) => [shiftMonth(period, -1), period, shiftMonth(period, 1)]));
    const needs = [
      ...data.bank.filter((row) => touched.has(row.date.slice(0, 7)) && row.currency !== "EUR" && !row.origAmount).map((row) => ({ currency: row.currency, date: row.date })),
      ...data.ledger.filter((row) => near.has(row.date.slice(0, 7)) && row.currency !== "EUR" && !row.amountEur).map((row) => ({ currency: row.currency, date: row.date })),
    ];
    if (needs.length) {
      const rates = await loadEcbRates(needs);
      fx = (currency, date) => rates.lookup(currency, date)?.rate ?? null;
    }
  }
  const pairing = pairAll(data.bank, data.ledger, mergedDecisions(data.months), data.config.tolerances, fx);
  const bankByKey = new Map(data.bank.map((row) => [row.key, row]));
  const byPeriod = new Map<string, ManualPair[]>();
  for (const [bankKey, pair] of pairing.pairs) {
    if (pair.basis !== "exact" && pair.basis !== "fx") continue;
    if (pair.confidence === "proposed") continue;
    const period = bankByKey.get(bankKey)!.date.slice(0, 7);
    if (!touched.has(period)) continue;
    byPeriod.set(period, [...(byPeriod.get(period) || []), {
      bankKey, transactionId: pair.ledger.id, by: AUTO_MATCH_ACTOR, at: new Date().toISOString(),
      auto: { basis: pair.basis, confidence: pair.confidence },
    }]);
  }
  for (const [period, pairs] of [...byPeriod].sort(([left], [right]) => left.localeCompare(right))) {
    if ((await getMonth(client, period)).state === "closed") { result.skippedClosedMonths.push(period); continue; }
    let added = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await mutateMonth(client, period, AUTO_MATCH_ACTOR, "auto-match", { pairs: pairs.length }, (record) => {
          const fresh = pairs.filter((pair) => !record.decisions.pairs.some((existing) => existing.bankKey === pair.bankKey || existing.transactionId === pair.transactionId));
          record.decisions.pairs.push(...fresh);
          added = fresh.length;
        });
        break;
      } catch (error) {
        if (!(error instanceof MonthConflictError) || attempt >= 4) throw error;
      }
    }
    result.byPeriod[period] = added;
    result.attached += added;
  }
  return result;
}

export type MatchedRow = {
  bankKey: string;
  date: string;
  amount: string;
  currency: string;
  counterparty: string;
  invoice: { transactionId: string; date: string; counterparty: string; amount: string; currency: string; invoiceNumber?: string; documents: number };
  basis: string;
  confidence: string;
  /** Bank minus ledger amount in the bank currency, when they differ. */
  difference?: string;
  auto: boolean;
  status: string;
};
export type UnmatchedBankRow = { bankKey: string; date: string; amount: string; currency: string; counterparty: string; reference?: string; status: string; classification?: string; missing?: string; candidates?: number };
export type InvoiceWithoutBank = { transactionId: string; date: string; counterparty: string; amount: string; currency: string; invoiceNumber?: string; documents: number; status: string; missing?: string };
export type MatchesView = {
  period: string;
  counts: { matched: number; autoMatched: number; needsReview: number; unmatchedBank: number; invoicesWithoutBank: number };
  matched: MatchedRow[];
  unmatchedBank: UnmatchedBankRow[];
  invoicesWithoutBank: InvoiceWithoutBank[];
};

export function matchesOf(view: Pick<MonthView, "period" | "rows">): MatchesView {
  const matched: MatchedRow[] = [];
  const unmatchedBank: UnmatchedBankRow[] = [];
  const invoicesWithoutBank: InvoiceWithoutBank[] = [];
  for (const row of view.rows as MonthRow[]) {
    if (row.bank && row.ledger) {
      matched.push({
        bankKey: row.bank.key, date: row.date, amount: row.amount, currency: row.currency, counterparty: row.counterparty,
        invoice: { transactionId: row.ledger.id, date: row.ledger.date, counterparty: row.ledger.counterparty, amount: row.ledger.amount, currency: row.ledger.currency, ...(row.ledger.invoiceNumber ? { invoiceNumber: row.ledger.invoiceNumber } : {}), documents: row.documents.length },
        basis: row.pairBasis || "manual", confidence: row.confidence || "exact",
        ...(row.amountDifference ? { difference: row.amountDifference } : {}),
        auto: Boolean(row.autoMatched), status: row.status,
      });
    } else if (row.bank) {
      unmatchedBank.push({
        bankKey: row.bank.key, date: row.date, amount: row.amount, currency: row.currency, counterparty: row.counterparty,
        ...(row.bank.reference ? { reference: row.bank.reference } : {}), status: row.status,
        ...(row.classification ? { classification: row.classification.kind } : {}),
        ...(row.missing ? { missing: row.missing } : {}),
        ...(row.candidates?.length ? { candidates: row.candidates.length } : {}),
      });
    } else if (row.ledger) {
      invoicesWithoutBank.push({
        transactionId: row.ledger.id, date: row.date, counterparty: row.counterparty, amount: row.amount, currency: row.currency,
        ...(row.ledger.invoiceNumber ? { invoiceNumber: row.ledger.invoiceNumber } : {}),
        documents: row.documents.length, status: row.status, ...(row.missing ? { missing: row.missing } : {}),
      });
    }
  }
  return {
    period: view.period,
    counts: {
      matched: matched.length,
      autoMatched: matched.filter((row) => row.auto).length,
      needsReview: matched.filter((row) => row.status === "needs-review" || row.status === "amount-mismatch").length,
      unmatchedBank: unmatchedBank.length,
      invoicesWithoutBank: invoicesWithoutBank.length,
    },
    matched, unmatchedBank, invoicesWithoutBank,
  };
}

export const matchCountsText = (counts: MatchesView["counts"]) =>
  `${counts.matched} bank rows matched to invoices (${counts.autoMatched} automatically, ${counts.needsReview} to review), ${counts.unmatchedBank} bank rows unmatched, ${counts.invoicesWithoutBank} invoices without a bank row.`;
