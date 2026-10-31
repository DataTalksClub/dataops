/**
 * Month reconciliation: every bank transaction and every ledger row of a
 * month in one table, each with the other side it was paired with, its
 * invoice/receipt documents and a status. Pure: inputs in, table out.
 *
 * Pairing is deterministic and global (all months at once, so a payment
 * booked on the 30th and debited on the 2nd pairs the same way whichever
 * month is looked at). Candidates are scored on amount (exact, FX via the
 * bank's original amount or the ledger's EUR amount, fee tolerance), date
 * lag and counterparty/reference text; a row whose two best candidates
 * score alike is left for review rather than guessed.
 *
 * Rows a rule classifies as a known no-invoice kind (bank fee, internal
 * transfer, tax or health-insurance debit, platform payout, owner
 * withdrawal) need that kind's proof instead of a document.
 */
import { createHash } from "crypto";

const DAY = 86_400_000;

export type ExceptionKind =
  | "tax_debit"
  | "tk_debit"
  | "platform_payout"
  | "internal_transfer"
  | "bank_fee"
  | "owner_withdrawal";

/** What stands in for the invoice/receipt document for each no-invoice kind. */
export type ExceptionProof = "tax-schedule" | "ledger-row" | "counter-row" | "bank-row" | "category";

export type ExceptionPolicy = { kind: ExceptionKind; proof: ExceptionProof; label: string };

export const EXCEPTION_POLICIES: ExceptionPolicy[] = [
  { kind: "tax_debit", proof: "tax-schedule", label: "Tax debit (ESt/Soli, GewSt, VAT)" },
  { kind: "tk_debit", proof: "tax-schedule", label: "TK health insurance debit" },
  { kind: "platform_payout", proof: "ledger-row", label: "Platform payout" },
  { kind: "internal_transfer", proof: "counter-row", label: "Transfer between own accounts" },
  { kind: "bank_fee", proof: "bank-row", label: "Bank fee" },
  { kind: "owner_withdrawal", proof: "category", label: "Owner withdrawal" },
];
export const EXCEPTION_KINDS = EXCEPTION_POLICIES.map((policy) => policy.kind);

/** A classification rule: every given condition must hold; patterns are case-insensitive regexes. */
export type ClassificationRule = {
  id: string;
  kind: ExceptionKind | "known_vendor";
  /** Category written to a ledger row created from a matching bank row. */
  category?: string;
  vendor?: string;
  direction?: "in" | "out";
  accounts?: string[];
  counterparty?: string;
  reference?: string;
  bankType?: string[];
};

export type ReconcileTolerances = {
  /** Days a bank booking may trail or lead the ledger date. */
  dateLagDays: number;
  /** Relative gap allowed between a bank EUR amount and the ledger's EUR amount of a foreign-currency row. */
  fxSpreadPct: number;
  /** Absolute gap (same currency) that still pairs, flagged as an amount mismatch. */
  feeTolerance: number;
};

export const DEFAULT_TOLERANCES: ReconcileTolerances = { dateLagDays: 7, fxSpreadPct: 0.03, feeTolerance: 2 };

export type BankTx = {
  key: string;
  accountId: string;
  wallet?: string;
  statementId: string;
  date: string;
  /** Signed: credits positive. */
  amount: string;
  currency: string;
  counterparty: string;
  reference?: string;
  bankId?: string;
  bankType?: string;
  origAmount?: string;
  origCurrency?: string;
  fee?: string;
  relatedBankId?: string;
};

export type LedgerDocument = { id: string; label?: string };

export type LedgerRow = {
  id: string;
  date: string;
  /** Signed like the bank: income positive, expense negative. */
  amount: string;
  currency: string;
  amountEur?: string;
  counterparty: string;
  description?: string;
  category?: string;
  statementRef?: string;
  invoiceNumber?: string;
  sourceType?: string;
  documents: LedgerDocument[];
};

export type ManualPair = { bankKey: string; transactionId: string; by: string; at: string; note?: string };
export type RowException = { kind: ExceptionKind; proof?: string; note?: string; by: string; at: string };

/**
 * A separate payment proof for one ledger row the bank statements do not
 * show (personal card, PayPal, another bank): a stored document, parsed
 * when its format is known. It stands in for the bank side of that row.
 */
export type PaymentProof = { documentId: string; filename?: string; by: string; at: string; parsed?: { date?: string; amount?: string; currency?: string } };

export type ManualDecisions = {
  pairs: ManualPair[];
  /** "bankKey|transactionId" pairs a person ruled out; automatic pairing skips them. */
  rejected: string[];
  /** Keyed "bank:<key>" or "ledger:<id>". */
  exceptions: Record<string, RowException>;
  /** Keyed by ledger row id. */
  proofs: Record<string, PaymentProof>;
};

export type RowStatus = "matched" | "no-invoice" | "payment-proof-missing" | "amount-mismatch" | "needs-review";
export type PairBasis = "manual" | "exact" | "fx" | "fee" | "proposed";

export type MonthRow = {
  /** Stable row id: the bank key, else "ledger:<id>". */
  id: string;
  date: string;
  counterparty: string;
  description?: string;
  amount: string;
  currency: string;
  bank?: BankTx;
  ledger?: Omit<LedgerRow, "documents">;
  documents: LedgerDocument[];
  paymentProof?: PaymentProof;
  pairBasis?: PairBasis;
  confidence?: "exact" | "strong" | "proposed";
  amountDifference?: string;
  classification?: { kind: ExceptionPolicy["kind"] | "known_vendor"; ruleId?: string; vendor?: string; category?: string };
  exception?: { kind: ExceptionKind; proof: ExceptionProof; satisfied: boolean; evidence?: string; recorded?: RowException };
  candidates?: Array<{ transactionId?: string; bankKey?: string; score: number }>;
  status: RowStatus;
  /** What is missing, in words, for a row that is not matched. */
  missing?: string;
};

export type MonthCounters = {
  rows: number;
  matched: number;
  bankWithoutInvoice: number;
  ledgerWithoutBank: number;
  amountMismatch: number;
  needsReview: number;
  exceptions: number;
};

export type MonthTable = { period: string; rows: MonthRow[]; counters: MonthCounters };

const amountNumber = (value: string | undefined) => Number(value || 0);
const cents = (value: number) => Math.round(value * 100) / 100;
const dayOf = (value: string) => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
const daysApart = (left: string, right: string) => Math.abs(dayOf(left) - dayOf(right)) / DAY;

const STOP_WORDS = new Set(["the", "and", "gmbh", "inc", "ltd", "llc", "bv", "oü", "ou", "payment", "from", "to", "transfer", "card", "sepa", "ag", "co", "com", "www", "eur", "usd"]);
export function textTokens(...values: Array<string | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of String(value || "").toLowerCase().split(/[^a-z0-9äöüß]+/)) {
      if (token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)) tokens.add(token);
    }
  }
  return tokens;
}
const digitsOnly = (value: string | undefined) => String(value || "").replace(/[^0-9]/g, "");

export function bankKeyFor(accountId: string, rowKey: string): string {
  return createHash("sha256").update(`${accountId}|${rowKey}`).digest("hex").slice(0, 20);
}

type AmountFit = { basis: Exclude<PairBasis, "manual" | "proposed"> | "unknown"; score: number; difference?: number };

/** How well a ledger amount explains a bank amount; null when it cannot be the same payment. */
export function amountFit(bank: BankTx, ledger: LedgerRow, tolerances: ReconcileTolerances): AmountFit | null {
  const bankAmount = amountNumber(bank.amount), ledgerAmount = amountNumber(ledger.amount);
  if (Math.sign(bankAmount) !== Math.sign(ledgerAmount)) return null;
  if (bank.currency === ledger.currency) {
    const difference = cents(Math.abs(bankAmount) - Math.abs(ledgerAmount));
    if (Math.abs(difference) < 0.005) return { basis: "exact", score: 6 };
    const fee = Math.abs(amountNumber(bank.fee));
    if (fee && Math.abs(cents(Math.abs(bankAmount) + fee - Math.abs(ledgerAmount))) < 0.005) return { basis: "exact", score: 5 };
    if (Math.abs(difference) <= tolerances.feeTolerance) return { basis: "fee", score: 2, difference };
    return null;
  }
  if (bank.origCurrency === ledger.currency && bank.origAmount !== undefined) {
    if (Math.abs(Math.abs(amountNumber(bank.origAmount)) - Math.abs(ledgerAmount)) < 0.005) return { basis: "fx", score: 5 };
  }
  if (bank.currency === "EUR" && ledger.amountEur) {
    const eur = Math.abs(amountNumber(ledger.amountEur));
    const gap = Math.abs(Math.abs(bankAmount) - eur);
    if (eur && gap / eur <= tolerances.fxSpreadPct) return { basis: "fx", score: gap < 0.005 ? 5 : 4, difference: cents(Math.abs(bankAmount) - eur) };
    return null;
  }
  // Foreign currency with nothing to convert by: only text and date can tell.
  return { basis: "unknown", score: 0 };
}

type Edge = { bank: BankTx; ledger: LedgerRow; score: number; fit: AmountFit; textHit: boolean };

function scoreEdge(bank: BankTx, ledger: LedgerRow, tolerances: ReconcileTolerances): Edge | null {
  const lag = daysApart(bank.date, ledger.date);
  if (lag > tolerances.dateLagDays) return null;
  const fit = amountFit(bank, ledger, tolerances);
  if (!fit) return null;
  const bankText = textTokens(bank.counterparty, bank.reference);
  const ledgerText = textTokens(ledger.counterparty, ledger.description);
  const shared = [...bankText].some((token) => ledgerText.has(token));
  const invoice = digitsOnly(ledger.invoiceNumber);
  const invoiceHit = invoice.length >= 4 && digitsOnly(`${bank.reference} ${bank.counterparty}`).includes(invoice);
  const textHit = shared || invoiceHit;
  if (fit.basis === "unknown" && !textHit) return null;
  const dateScore = lag <= 1 ? 2 : lag <= 3 ? 1 : 0;
  return { bank, ledger, fit, textHit, score: fit.score + dateScore + (invoiceHit ? 3 : shared ? 2 : 0) };
}

function confidenceOf(edge: Edge): "exact" | "strong" | "proposed" {
  if (edge.fit.basis === "unknown") return "proposed";
  if (edge.fit.score >= 5 && edge.textHit && daysApart(edge.bank.date, edge.ledger.date) <= 3) return "exact";
  if (edge.fit.score >= 4 && (edge.textHit || daysApart(edge.bank.date, edge.ledger.date) <= 3)) return "strong";
  return "proposed";
}

export type PairingResult = {
  pairs: Map<string, { ledger: LedgerRow; basis: PairBasis; confidence: "exact" | "strong" | "proposed"; difference?: number }>;
  ambiguous: Map<string, Array<{ transactionId: string; score: number }>>;
  ambiguousLedger: Map<string, Array<{ bankKey: string; score: number }>>;
};

/**
 * Global one-to-one pairing. Manual pairs first; then edges strongest
 * first. A bank row (or ledger row) whose two best open candidates tie is
 * not paired automatically.
 */
export function pairAll(bank: BankTx[], ledger: LedgerRow[], decisions: ManualDecisions, tolerances: ReconcileTolerances): PairingResult {
  const pairs: PairingResult["pairs"] = new Map();
  const ambiguous: PairingResult["ambiguous"] = new Map();
  const ambiguousLedger: PairingResult["ambiguousLedger"] = new Map();
  const ledgerById = new Map(ledger.map((row) => [row.id, row]));
  const usedLedger = new Set<string>();
  for (const pair of decisions.pairs) {
    const row = ledgerById.get(pair.transactionId);
    if (!row || pairs.has(pair.bankKey) || usedLedger.has(row.id)) continue;
    const bankRow = bank.find((item) => item.key === pair.bankKey);
    const difference = bankRow && bankRow.currency === row.currency ? cents(Math.abs(amountNumber(bankRow.amount)) - Math.abs(amountNumber(row.amount))) : undefined;
    pairs.set(pair.bankKey, { ledger: row, basis: "manual", confidence: "exact", ...(difference ? { difference } : {}) });
    usedLedger.add(row.id);
  }
  const rejected = new Set(decisions.rejected);
  const edges: Edge[] = [];
  // Bucket ledger rows by day so each bank row only scores rows inside the lag window.
  const byDay = new Map<number, LedgerRow[]>();
  for (const row of ledger) {
    if (usedLedger.has(row.id) || !Number.isFinite(dayOf(row.date))) continue;
    const day = dayOf(row.date) / DAY;
    byDay.set(day, [...(byDay.get(day) || []), row]);
  }
  for (const bankRow of bank) {
    if (pairs.has(bankRow.key) || !Number.isFinite(dayOf(bankRow.date))) continue;
    const day = dayOf(bankRow.date) / DAY;
    for (let offset = -tolerances.dateLagDays; offset <= tolerances.dateLagDays; offset++) {
      for (const row of byDay.get(day + offset) || []) {
        if (rejected.has(`${bankRow.key}|${row.id}`)) continue;
        const edge = scoreEdge(bankRow, row, tolerances);
        if (edge) edges.push(edge);
      }
    }
  }
  const byBank = new Map<string, Edge[]>(), byLedger = new Map<string, Edge[]>();
  for (const edge of edges) {
    byBank.set(edge.bank.key, [...(byBank.get(edge.bank.key) || []), edge]);
    byLedger.set(edge.ledger.id, [...(byLedger.get(edge.ledger.id) || []), edge]);
  }
  const sortEdges = (list: Edge[]) => list.sort((left, right) => right.score - left.score || left.bank.key.localeCompare(right.bank.key) || left.ledger.id.localeCompare(right.ledger.id));
  sortEdges(edges);
  const open = (edge: Edge) => !pairs.has(edge.bank.key) && !usedLedger.has(edge.ledger.id);
  // Two candidates that are the same payment twice (same amount, date, text) are interchangeable, not ambiguous.
  const twins = (left: Edge, right: Edge, side: "bank" | "ledger") => side === "bank"
    ? left.ledger.amount === right.ledger.amount && left.ledger.date === right.ledger.date && left.ledger.counterparty === right.ledger.counterparty
    : left.bank.amount === right.bank.amount && left.bank.date === right.bank.date && left.bank.counterparty === right.bank.counterparty;
  for (const edge of edges) {
    if (!open(edge) || ambiguous.has(edge.bank.key) || ambiguousLedger.has(edge.ledger.id)) continue;
    const bankRivals = sortEdges((byBank.get(edge.bank.key) || []).filter(open));
    const ledgerRivals = sortEdges((byLedger.get(edge.ledger.id) || []).filter(open));
    const bankTie = bankRivals.length > 1 && bankRivals[1].score === bankRivals[0].score && !twins(bankRivals[0], bankRivals[1], "bank");
    const ledgerTie = ledgerRivals.length > 1 && ledgerRivals[1].score === ledgerRivals[0].score && !twins(ledgerRivals[0], ledgerRivals[1], "ledger");
    if (bankTie) {
      ambiguous.set(edge.bank.key, bankRivals.filter((rival) => rival.score === bankRivals[0].score).map((rival) => ({ transactionId: rival.ledger.id, score: rival.score })));
      continue;
    }
    if (ledgerTie) {
      ambiguousLedger.set(edge.ledger.id, ledgerRivals.filter((rival) => rival.score === ledgerRivals[0].score).map((rival) => ({ bankKey: rival.bank.key, score: rival.score })));
      continue;
    }
    const basis: PairBasis = edge.fit.basis === "unknown" ? "proposed" : edge.fit.basis;
    pairs.set(edge.bank.key, { ledger: edge.ledger, basis, confidence: confidenceOf(edge), ...(edge.fit.difference ? { difference: edge.fit.difference } : {}) });
    usedLedger.add(edge.ledger.id);
  }
  return { pairs, ambiguous, ambiguousLedger };
}

export function classify(bank: BankTx, rules: ClassificationRule[]): MonthRow["classification"] | undefined {
  const direction = amountNumber(bank.amount) > 0 ? "in" : "out";
  for (const rule of rules) {
    if (rule.direction && rule.direction !== direction) continue;
    if (rule.accounts && !rule.accounts.includes(bank.accountId)) continue;
    if (rule.bankType && !rule.bankType.map((type) => type.toUpperCase()).includes(String(bank.bankType || "").toUpperCase())) continue;
    if (rule.counterparty && !new RegExp(rule.counterparty, "i").test(bank.counterparty)) continue;
    if (rule.reference && !new RegExp(rule.reference, "i").test(bank.reference || "")) continue;
    return { kind: rule.kind, ruleId: rule.id, ...(rule.vendor ? { vendor: rule.vendor } : {}), ...(rule.category ? { category: rule.category } : {}) };
  }
  return undefined;
}

/**
 * Both legs of a move between own accounts: opposite amounts in two
 * different accounts or wallets inside the lag window, or Revolut rows that
 * name each other as related.
 */
export function internalTransferLegs(bank: BankTx[], tolerances: ReconcileTolerances): Map<string, string> {
  const legs = new Map<string, string>();
  const byBankId = new Map(bank.filter((row) => row.bankId).map((row) => [`${row.accountId}|${row.bankId}`, row]));
  for (const row of bank) {
    if (legs.has(row.key) || !row.relatedBankId) continue;
    const other = byBankId.get(`${row.accountId}|${row.relatedBankId}`);
    if (other && !legs.has(other.key) && other.key !== row.key) { legs.set(row.key, other.key); legs.set(other.key, row.key); }
  }
  const sorted = [...bank].sort((left, right) => left.date.localeCompare(right.date) || left.key.localeCompare(right.key));
  for (const row of sorted) {
    if (legs.has(row.key) || amountNumber(row.amount) >= 0) continue;
    const match = sorted.find((other) => !legs.has(other.key) && other.key !== row.key
      && amountNumber(other.amount) > 0
      && other.currency === row.currency
      && Math.abs(amountNumber(other.amount) + amountNumber(row.amount)) < 0.005
      && (other.accountId !== row.accountId || (other.wallet || "") !== (row.wallet || ""))
      && daysApart(other.date, row.date) <= Math.min(tolerances.dateLagDays, 3));
    if (match) { legs.set(row.key, match.key); legs.set(match.key, row.key); }
  }
  return legs;
}

const policyOf = (kind: ExceptionKind) => EXCEPTION_POLICIES.find((policy) => policy.kind === kind)!;

export type MonthInput = {
  period: string;
  bank: BankTx[];
  ledger: LedgerRow[];
  decisions: ManualDecisions;
  rules: ClassificationRule[];
  tolerances?: ReconcileTolerances;
  /** Pairing computed once over all months, reused per month. */
  pairing?: PairingResult;
};

export function buildMonthTable(input: MonthInput): MonthTable {
  const tolerances = input.tolerances || DEFAULT_TOLERANCES;
  const pairing = input.pairing || pairAll(input.bank, input.ledger, input.decisions, tolerances);
  const legs = internalTransferLegs(input.bank, tolerances);
  const inPeriod = (date: string) => date.startsWith(input.period);
  const pairedLedger = new Map<string, string>();
  for (const [bankKey, pair] of pairing.pairs) pairedLedger.set(pair.ledger.id, bankKey);
  const bankByKey = new Map(input.bank.map((row) => [row.key, row]));
  const rows: MonthRow[] = [];

  const stripDocs = ({ documents: _documents, ...rest }: LedgerRow) => rest;

  for (const bankRow of input.bank) {
    if (!inPeriod(bankRow.date)) continue;
    const pair = pairing.pairs.get(bankRow.key);
    const documents = pair?.ledger.documents || [];
    let classification = classify(bankRow, input.rules);
    if (!classification && legs.has(bankRow.key)) classification = { kind: "internal_transfer" };
    const recorded = input.decisions.exceptions[`bank:${bankRow.key}`] || (pair ? input.decisions.exceptions[`ledger:${pair.ledger.id}`] : undefined);
    const kind = recorded?.kind || (classification && classification.kind !== "known_vendor" ? classification.kind : undefined);
    const row: MonthRow = {
      id: bankRow.key,
      date: bankRow.date,
      counterparty: bankRow.counterparty,
      ...(pair?.ledger.description ? { description: pair.ledger.description } : {}),
      amount: bankRow.amount,
      currency: bankRow.currency,
      bank: bankRow,
      ...(pair ? { ledger: stripDocs(pair.ledger), pairBasis: pair.basis, confidence: pair.confidence } : {}),
      ...(pair?.difference ? { amountDifference: pair.difference.toFixed(2) } : {}),
      documents,
      ...(classification ? { classification } : {}),
      status: "matched",
    };
    if (kind) {
      const policy = policyOf(kind);
      const counter = legs.get(bankRow.key);
      const satisfied =
        policy.proof === "bank-row" ? true
        : policy.proof === "counter-row" ? Boolean(counter)
        : policy.proof === "ledger-row" ? Boolean(pair)
        : policy.proof === "category" ? Boolean(classification?.category || pair?.ledger.category || recorded?.proof)
        : Boolean(recorded?.proof);
      row.exception = {
        kind,
        proof: policy.proof,
        satisfied,
        ...(counter ? { evidence: `counter-row ${counter} (${bankByKey.get(counter)?.accountId}${bankByKey.get(counter)?.wallet ? ` ${bankByKey.get(counter)?.wallet}` : ""})` } : {}),
        ...(recorded ? { recorded } : {}),
      };
    }
    const ambiguous = pairing.ambiguous.get(bankRow.key);
    if (ambiguous) {
      row.candidates = ambiguous.map((candidate) => ({ transactionId: candidate.transactionId, score: candidate.score }));
      row.status = "needs-review";
      row.missing = `${ambiguous.length} ledger rows fit equally; pick one`;
    } else if (row.exception) {
      if (!row.exception.satisfied) { row.status = "needs-review"; row.missing = `${row.exception.kind} needs proof: ${row.exception.proof}`; }
    } else if (!pair) {
      row.status = "no-invoice";
      row.missing = "no ledger row or invoice for this bank transaction";
    } else if (pair.basis === "fee") {
      row.status = "amount-mismatch";
      row.missing = `bank and ledger differ by ${pair.difference?.toFixed(2)} ${bankRow.currency}; confirm the pair or fix the ledger amount`;
    } else if (pair.confidence === "proposed") {
      row.status = "needs-review";
      row.missing = "weak pairing; confirm or unmatch";
    } else if (!documents.length) {
      row.status = "no-invoice";
      row.missing = "ledger row has no invoice/receipt document";
    }
    rows.push(row);
  }

  for (const ledgerRow of input.ledger) {
    if (!inPeriod(ledgerRow.date) || pairedLedger.has(ledgerRow.id)) continue;
    const recorded = input.decisions.exceptions[`ledger:${ledgerRow.id}`];
    const ambiguous = pairing.ambiguousLedger.get(ledgerRow.id);
    const row: MonthRow = {
      id: `ledger:${ledgerRow.id}`,
      date: ledgerRow.date,
      counterparty: ledgerRow.counterparty,
      ...(ledgerRow.description ? { description: ledgerRow.description } : {}),
      amount: ledgerRow.amount,
      currency: ledgerRow.currency,
      ledger: stripDocs(ledgerRow),
      documents: ledgerRow.documents,
      status: "payment-proof-missing",
      missing: "no bank transaction in the uploaded statements; upload a payment proof for this row (PayPal or other statement, card receipt)",
    };
    const proof = input.decisions.proofs[ledgerRow.id];
    if (proof) {
      row.paymentProof = proof;
      if (ledgerRow.documents.length) { row.status = "matched"; delete row.missing; }
      else { row.status = "no-invoice"; row.missing = "payment proof attached; ledger row has no invoice/receipt document"; }
    }
    if (recorded) {
      const policy = policyOf(recorded.kind);
      row.exception = { kind: recorded.kind, proof: policy.proof, satisfied: Boolean(recorded.proof), recorded };
      // A no-invoice kind waives the document, never the payment: a proof or bank row is still needed.
      if (proof) { row.status = row.exception.satisfied ? "matched" : "needs-review"; row.missing = row.exception.satisfied ? undefined : `${recorded.kind} needs proof: ${policy.proof}`; if (!row.missing) delete row.missing; }
    }
    if (ambiguous) {
      row.candidates = ambiguous.map((candidate) => ({ bankKey: candidate.bankKey, score: candidate.score }));
      row.status = "needs-review";
      row.missing = `${ambiguous.length} bank transactions fit equally; pick one`;
    }
    rows.push(row);
  }

  rows.sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const count = (status: RowStatus) => rows.filter((row) => row.status === status).length;
  return {
    period: input.period,
    rows,
    counters: {
      rows: rows.length,
      matched: count("matched"),
      bankWithoutInvoice: rows.filter((row) => row.status === "no-invoice").length,
      ledgerWithoutBank: count("payment-proof-missing"),
      amountMismatch: count("amount-mismatch"),
      needsReview: count("needs-review"),
      exceptions: rows.filter((row) => row.exception).length,
    },
  };
}

/** Rows that keep a month from closing, and the exception rows the approver confirms. */
export function closeBlockers(table: MonthTable): MonthRow[] {
  return table.rows.filter((row) => row.status !== "matched");
}

/** Fingerprint of a month's exception list; a confirmation covers exactly this list. */
export function exceptionDigest(table: MonthTable): string {
  const items = table.rows
    .filter((row) => row.exception)
    .map((row) => `${row.id}|${row.exception!.kind}|${row.amount}|${row.currency}`)
    .sort();
  return createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 24);
}

export function tableCsv(table: MonthTable): string {
  const header = ["date", "status", "counterparty", "description", "amount", "currency", "bank_account", "bank_date", "bank_amount", "bank_reference", "ledger_id", "ledger_date", "ledger_amount", "ledger_category", "documents", "pair_basis", "confidence", "exception", "missing"];
  const quote = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = table.rows.map((row) => [
    row.date, row.status, row.counterparty, row.description, row.amount, row.currency,
    row.bank ? `${row.bank.accountId}${row.bank.wallet ? ` ${row.bank.wallet}` : ""}` : "", row.bank?.date, row.bank ? `${row.bank.amount} ${row.bank.currency}` : "", row.bank?.reference,
    row.ledger?.id, row.ledger?.date, row.ledger ? `${row.ledger.amount} ${row.ledger.currency}` : "", row.ledger?.category,
    [...row.documents.map((document) => document.id), ...(row.paymentProof ? [`proof:${row.paymentProof.documentId}`] : [])].join(" "), row.pairBasis, row.confidence,
    row.exception ? `${row.exception.kind}${row.exception.satisfied ? "" : " (proof missing)"}` : "", row.missing,
  ].map(quote).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
