/**
 * Strict, deterministic invoice-to-transaction matching for automatic
 * evidence attachment. The interactive suggestions scorer intentionally finds
 * plausible candidates; this matcher only returns pairs safe to attach without
 * a person confirming them.
 */

const DAY_MS = 86_400_000;

export const AUTO_MATCH_DATE_WINDOW_DAYS = 10;

export type AutoMatchTransaction = Record<string, unknown> & {
  id: string;
  transactionDate?: string;
  paidDate?: string;
  amount?: string | number;
  amountEur?: string | number;
  currency?: string;
  counterparty?: string;
  entryType?: string;
  sponsorDealId?: string;
};

export type AutoMatchDocument = Record<string, unknown> & {
  id: string;
  status: string;
  documentType: string;
  facts?: Record<string, unknown>;
};

export type AutoMatchEvidenceLink = {
  transactionId?: string;
  documentId?: string;
  coverageType?: string;
};

export type AutoMatchPair = {
  transactionId: string;
  documentId: string;
  dateGapDays: number;
  amount: string;
  currency: string;
};

const LEGAL_SUFFIXES = new Set([
  "ag", "bv", "co", "company", "corp", "corporation", "gmbh", "inc",
  "incorporated", "limited", "llc", "ltd", "plc", "oy", "oyj", "sarl",
  "ulc",
]);

const VENDOR_GROUPS: Array<{ canonical: string; aliases: string[] }> = [
  {
    canonical: "amazon web services",
    aliases: [
      "aws",
      "aws emea",
      "amazon web services",
      "amazon web services emea",
    ],
  },
  {
    canonical: "google",
    aliases: [
      "google",
      "google cloud",
      "google cloud platform",
      "google cloud emea",
      "google workspace",
      "google workspace emea",
      "google one",
    ],
  },
  {
    canonical: "x",
    aliases: [
      "x",
      "twitter",
      "x corp",
      "x corp paid features",
      "x paid features",
      "x corp revenue sharing",
      "x revenue sharing",
      "x internet unlimited company",
      "x internet unlimited",
    ],
  },
  { canonical: "godaddy", aliases: ["go daddy", "godaddy", "godaddy.com"] },
  { canonical: "openai", aliases: ["openai", "chatgpt"] },
];

function vendorCore(value: unknown): string {
  const words = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (words.length && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

const VENDOR_CANONICAL = new Map<string, string>();
for (const group of VENDOR_GROUPS) {
  const canonical = vendorCore(group.canonical);
  VENDOR_CANONICAL.set(canonical, canonical);
  for (const alias of group.aliases) VENDOR_CANONICAL.set(vendorCore(alias), canonical);
}

/** Normalize known trading names while requiring unknown names to match exactly after legal suffix cleanup. */
export function normalizedAutoMatchVendor(value: unknown): string {
  const core = vendorCore(value);
  return VENDOR_CANONICAL.get(core) || core;
}

function amountCents(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const scaled = parsed * 100;
  const cents = Math.round(scaled);
  return Math.abs(scaled - cents) < 0.001 ? cents : null;
}

function normalizedCurrency(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function exactAmountMatch(
  transaction: AutoMatchTransaction,
  facts: Record<string, unknown>,
): { amount: string; currency: string } | null {
  const invoiceAmount = amountCents(facts.amount);
  const invoiceCurrency = normalizedCurrency(facts.currency);
  if (invoiceAmount === null || !invoiceCurrency) return null;

  const transactionCurrency = normalizedCurrency(transaction.currency);
  const originalAmount = amountCents(transaction.amount);
  if (
    invoiceCurrency === transactionCurrency &&
    originalAmount !== null &&
    invoiceAmount === originalAmount
  ) {
    return { amount: (invoiceAmount / 100).toFixed(2), currency: invoiceCurrency };
  }

  const eurAmount = amountCents(transaction.amountEur);
  if (invoiceCurrency === "EUR" && eurAmount !== null && invoiceAmount === eurAmount) {
    return { amount: (invoiceAmount / 100).toFixed(2), currency: "EUR" };
  }
  return null;
}

function isoDay(value: unknown): number | null {
  const date = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return null;
  return parsed / DAY_MS;
}

function dateGap(transaction: AutoMatchTransaction, facts: Record<string, unknown>): number | null {
  const transactionDays = [transaction.transactionDate, transaction.paidDate]
    .map(isoDay)
    .filter((day): day is number => day !== null);
  const documentDays = [facts.transactionDate, facts.paidDate, facts.date]
    .map(isoDay)
    .filter((day): day is number => day !== null);
  if (!transactionDays.length || !documentDays.length) return null;

  let gap = Infinity;
  for (const left of transactionDays) {
    for (const right of documentDays) gap = Math.min(gap, Math.abs(left - right));
  }
  return Number.isFinite(gap) ? gap : null;
}

function extractionNeedsReview(facts: Record<string, unknown>): boolean {
  const extraction = facts.extraction;
  return Boolean(
    extraction &&
      typeof extraction === "object" &&
      !Array.isArray(extraction) &&
      (extraction as Record<string, unknown>).needsReview === true,
  );
}

function isRefundTransaction(transaction: AutoMatchTransaction): boolean {
  return (
    String(transaction.subtype || "").toLowerCase() === "refund" ||
    String(transaction.sourceKey || "").startsWith("credit-note:")
  );
}

function isSupplierCreditNoteDocument(facts: Record<string, unknown>): boolean {
  if (String(facts.subtype || "").toLowerCase() === "refund") return true;
  const extraction = facts.extraction;
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) return false;
  const docType = String((extraction as Record<string, unknown>).documentType || "").toLowerCase();
  const direction = String((extraction as Record<string, unknown>).direction || "").toLowerCase();
  return docType === "credit_note" && direction !== "income";
}

function directionMatches(transaction: AutoMatchTransaction, facts: Record<string, unknown>): boolean {
  const refundTransaction = isRefundTransaction(transaction);
  const refundDocument = isSupplierCreditNoteDocument(facts);
  if (refundTransaction !== refundDocument) return false;
  if (refundTransaction && refundDocument) return true;
  const extraction = facts.extraction;
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) return true;
  const extractedDirection = String((extraction as Record<string, unknown>).direction || "").toLowerCase();
  if (!extractedDirection) return true;
  return extractedDirection === String(transaction.entryType || "").toLowerCase();
}

type Candidate = AutoMatchPair & { transactionKey: string; documentKey: string };

function uniqueClosestBy<T extends Candidate>(
  candidates: Candidate[],
  key: (candidate: Candidate) => string,
): Map<string, Candidate> {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const groupKey = key(candidate);
    grouped.set(groupKey, [...(grouped.get(groupKey) || []), candidate]);
  }

  const best = new Map<string, Candidate>();
  for (const [groupKey, choices] of grouped) {
    const closest = Math.min(...choices.map((choice) => choice.dateGapDays));
    const tied = choices.filter((choice) => choice.dateGapDays === closest);
    if (tied.length === 1) best.set(groupKey, tied[0]);
  }
  return best;
}

/**
 * Return only mutually unique closest matches. A transaction/document tie in
 * either direction stays unattached for a human to resolve.
 */
export function planEvidenceAutoMatches(
  transactions: AutoMatchTransaction[],
  documents: AutoMatchDocument[],
  links: AutoMatchEvidenceLink[],
): AutoMatchPair[] {
  const linkedTransactions = new Set(
    links
      .filter((link) => link.coverageType === "evidence" && link.transactionId)
      .map((link) => String(link.transactionId)),
  );
  const linkedDocuments = new Set(
    links
      .filter((link) => link.coverageType === "evidence" && link.documentId)
      .map((link) => String(link.documentId)),
  );

  const eligibleTransactions = transactions.filter(
    (transaction) =>
      transaction.id &&
      !linkedTransactions.has(transaction.id) &&
      !transaction.sponsorDealId,
  );
  const eligibleDocuments = documents.filter(
    (document) =>
      document.id &&
      document.status === "active" &&
      ["invoice", "receipt"].includes(String(document.documentType)) &&
      !linkedDocuments.has(document.id) &&
      document.facts &&
      !extractionNeedsReview(document.facts),
  );

  const candidates: Candidate[] = [];
  for (const transaction of eligibleTransactions) {
    const transactionVendor = normalizedAutoMatchVendor(transaction.counterparty);
    if (!transactionVendor) continue;
    for (const document of eligibleDocuments) {
      const facts = document.facts!;
      if (!directionMatches(transaction, facts)) continue;
      if (normalizedAutoMatchVendor(facts.counterparty) !== transactionVendor) continue;

      const match = exactAmountMatch(transaction, facts);
      if (!match) continue;

      const gap = dateGap(transaction, facts);
      if (gap === null || gap > AUTO_MATCH_DATE_WINDOW_DAYS) continue;

      candidates.push({
        transactionId: transaction.id,
        documentId: document.id,
        transactionKey: transaction.id,
        documentKey: document.id,
        dateGapDays: gap,
        ...match,
      });
    }
  }

  const closestTransaction = uniqueClosestBy(candidates, (candidate) => candidate.transactionKey);
  const closestDocument = uniqueClosestBy(candidates, (candidate) => candidate.documentKey);
  return candidates
    .filter(
      (candidate) =>
        closestTransaction.get(candidate.transactionKey) === candidate &&
        closestDocument.get(candidate.documentKey) === candidate,
    )
    .map(({ transactionId, documentId, dateGapDays, amount, currency }) => ({
      transactionId,
      documentId,
      dateGapDays,
      amount,
      currency,
    }))
    .sort((left, right) => left.transactionId.localeCompare(right.transactionId));
}
