/**
 * Backtest: replay the month reconciliation on past months and compare it
 * with the report that was actually sent to the accountant. The sent
 * report's "Statement" column says which account paid each row (Finom,
 * Revolut, or a separate proof such as N26/PayPal/Wise); the algorithm
 * agrees when it pairs that ledger row with a bank row of the same account,
 * and finds no Finom/Revolut row for one paid elsewhere. Comparison is by
 * content (date, amount, counterparty), never by file name. Pure.
 */
import { textTokens, type MonthTable, type LedgerRow, type BankTx } from "./month";
import { REPORT_EXEMPT_CATEGORIES } from "../db/bookkeeping";

export type TruthRow = {
  date: string;
  paidDate?: string;
  counterparty: string;
  description?: string;
  amount: number;
  currency: string;
  amountEur?: number | null;
  entryType?: string;
  category?: string;
  statementRef?: string;
  docRef?: string;
};

export type ExpectedSource = "finom" | "revolut" | "separate-proof" | "unknown";

/** What the report's Statement column says paid the row. */
export function expectedSource(statementRef: string | undefined): ExpectedSource {
  const ref = String(statementRef || "").trim().toLowerCase();
  if (!ref) return "unknown";
  if (ref === "finom" || ref.startsWith("finom")) return "finom";
  // "Revolut - statement-…" is the personal Revolut account: a separate proof.
  if (ref === "revolut" || ref.startsWith("revolut:dtc")) return "revolut";
  return "separate-proof";
}

export type RowOutcome =
  | "match"            // paired with a bank row of the account the report names
  | "wrong-account"    // paired, but with another account's bank row
  | "missed"           // report names Finom/Revolut, algorithm found no bank row
  | "agree-no-bank"    // paid elsewhere per report, algorithm found no Finom/Revolut row either
  | "extra-pair"       // paid elsewhere per report, algorithm paired a Finom/Revolut row anyway
  | "unverifiable"     // the report names no account; nothing to compare
  | "only-in-report";  // the ledger has no row for it

export type TruthComparison = {
  truth: TruthRow;
  expected: ExpectedSource;
  outcome: RowOutcome;
  ledgerId?: string;
  bank?: Pick<BankTx, "accountId" | "wallet" | "date" | "amount" | "currency" | "counterparty">;
  ourStatus?: string;
};

export type MonthBacktest = {
  period: string;
  truthRows: number;
  outcomes: Record<RowOutcome, number>;
  precision: number | null;
  recall: number | null;
  /** Ours leaves out the categories the accountant's package never carries (taxes, health insurance), as the sent report did. */
  totals: { reportIncomeEur: number; reportExpenseEur: number; oursIncomeEur: number; oursExpenseEur: number; incomeDiffEur: number; expenseDiffEur: number; oursMissingEur: number; exemptExpenseEur: number };
  rows: TruthComparison[];
  onlyInOurs: Array<{ ledgerId: string; date: string; counterparty: string; amount: string; currency: string; status: string; category?: string; reportExempt: boolean }>;
  bankOnly: Array<{ key: string; accountId: string; wallet?: string; date: string; amount: string; currency: string; counterparty: string; status: string; classification?: string }>;
  calibration: { dateLags: number[]; fxSpreads: number[] };
};

const DAY = 86_400_000;
const dayOf = (value: string) => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
const round2 = (value: number) => Math.round(value * 100) / 100;

function eurOf(row: { amount: string; currency: string; amountEur?: string }): number | null {
  if (row.amountEur !== undefined) return Number(row.amountEur);
  if (row.currency === "EUR") return Number(row.amount);
  return null;
}

/** Pair each report row with the ledger row it describes: same direction, same amount (or EUR amount), close date, shared name. */
export function mapTruthToLedger(truth: TruthRow[], ledger: LedgerRow[], windowDays = 5): Map<number, string> {
  const used = new Set<string>();
  const mapping = new Map<number, string>();
  const scored: Array<{ index: number; id: string; score: number }> = [];
  truth.forEach((row, index) => {
    const date = row.paidDate || row.date;
    const sign = row.entryType === "income" ? 1 : row.entryType === "expense" ? -1 : Math.sign(row.amount) || -1;
    for (const item of ledger) {
      const lag = Math.abs(dayOf(item.date) - dayOf(date)) / DAY;
      if (!(lag <= windowDays)) continue;
      if (Math.sign(Number(item.amount)) !== sign) continue;
      const sameAmount = item.currency === row.currency.toUpperCase() && Math.abs(Math.abs(Number(item.amount)) - Math.abs(row.amount)) < 0.01;
      const sameEur = row.amountEur != null && item.amountEur !== undefined && Math.abs(Math.abs(Number(item.amountEur)) - Math.abs(row.amountEur)) < 0.01;
      if (!sameAmount && !sameEur) continue;
      const names = textTokens(row.counterparty, row.description);
      const shared = [...textTokens(item.counterparty, item.description)].filter((token) => names.has(token)).length;
      scored.push({ index, id: item.id, score: (sameAmount ? 4 : 2) + Math.min(shared, 3) + (lag === 0 ? 2 : lag <= 2 ? 1 : 0) });
    }
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index || left.id.localeCompare(right.id));
  for (const candidate of scored) {
    if (mapping.has(candidate.index) || used.has(candidate.id)) continue;
    mapping.set(candidate.index, candidate.id);
    used.add(candidate.id);
  }
  return mapping;
}

export function backtestMonth(period: string, truth: TruthRow[], table: MonthTable, ledger: LedgerRow[]): MonthBacktest {
  const ledgerInTable = new Map<string, MonthTable["rows"][number]>();
  for (const row of table.rows) if (row.ledger) ledgerInTable.set(row.ledger.id, row);
  // Report rows may sit a few days off the ledger's paid date; map against every ledger row near the month.
  const mapping = mapTruthToLedger(truth, ledger);
  const rows: TruthComparison[] = truth.map((row, index) => {
    const expected = expectedSource(row.statementRef);
    const ledgerId = mapping.get(index);
    if (!ledgerId) return { truth: row, expected, outcome: "only-in-report" };
    const ours = ledgerInTable.get(ledgerId);
    const bank = ours?.bank;
    const base = { truth: row, expected, ledgerId, ...(ours ? { ourStatus: ours.status } : {}), ...(bank ? { bank: { accountId: bank.accountId, ...(bank.wallet ? { wallet: bank.wallet } : {}), date: bank.date, amount: bank.amount, currency: bank.currency, counterparty: bank.counterparty } } : {}) };
    if (expected === "finom" || expected === "revolut") {
      if (!bank) return { ...base, outcome: "missed" };
      return { ...base, outcome: bank.accountId === expected ? "match" : "wrong-account" };
    }
    if (expected === "unknown") return { ...base, outcome: "unverifiable" };
    return { ...base, outcome: bank ? "extra-pair" : "agree-no-bank" };
  });
  const outcomes = { "match": 0, "wrong-account": 0, "missed": 0, "agree-no-bank": 0, "extra-pair": 0, "unverifiable": 0, "only-in-report": 0 } as Record<RowOutcome, number>;
  for (const row of rows) outcomes[row.outcome]++;
  const claimed = outcomes.match + outcomes["wrong-account"] + outcomes["extra-pair"];
  const expectedBank = outcomes.match + outcomes["wrong-account"] + outcomes.missed;

  const mappedLedger = new Set([...mapping.values()]);
  const onlyInOurs = table.rows
    .filter((row) => row.ledger && !mappedLedger.has(row.ledger.id))
    .map((row) => ({ ledgerId: row.ledger!.id, date: row.ledger!.date, counterparty: row.ledger!.counterparty, amount: row.ledger!.amount, currency: row.ledger!.currency, status: row.status, ...(row.ledger!.category ? { category: row.ledger!.category } : {}), reportExempt: REPORT_EXEMPT_CATEGORIES.has(row.ledger!.category || "") }));
  const bankOnly = table.rows
    .filter((row) => row.bank && !row.ledger)
    .map((row) => ({ key: row.bank!.key, accountId: row.bank!.accountId, ...(row.bank!.wallet ? { wallet: row.bank!.wallet } : {}), date: row.bank!.date, amount: row.bank!.amount, currency: row.bank!.currency, counterparty: row.bank!.counterparty, status: row.status, ...(row.classification ? { classification: row.classification.kind } : {}) }));

  const signOf = (row: TruthRow) => row.entryType === "income" ? 1 : row.entryType === "expense" ? -1 : Math.sign(row.amount) || -1;
  const sumTruth = (sign: number) => round2(truth.filter((row) => signOf(row) === sign).reduce((total, row) => total + Math.abs(Number(row.amountEur ?? (row.currency === "EUR" ? row.amount : 0))), 0));
  let oursIncome = 0, oursExpense = 0, oursMissing = 0, exemptExpense = 0;
  for (const row of table.rows) {
    if (!row.ledger) continue;
    const eur = eurOf(row.ledger);
    if (eur === null) { oursMissing++; continue; }
    if (REPORT_EXEMPT_CATEGORIES.has(row.ledger.category || "")) { exemptExpense += Math.abs(eur); continue; }
    if (eur > 0) oursIncome += eur; else oursExpense += Math.abs(eur);
  }
  const reportIncomeEur = sumTruth(1), reportExpenseEur = sumTruth(-1);

  const dateLags: number[] = [], fxSpreads: number[] = [];
  for (const row of table.rows) {
    if (!row.bank || !row.ledger) continue;
    dateLags.push(Math.round((dayOf(row.bank.date) - dayOf(row.ledger.date)) / DAY));
    if (row.ledger.currency !== row.bank.currency && row.ledger.amountEur && row.bank.currency === "EUR") {
      fxSpreads.push(round2(((Math.abs(Number(row.bank.amount)) - Math.abs(Number(row.ledger.amountEur))) / Math.abs(Number(row.ledger.amountEur))) * 10000) / 100);
    }
  }

  return {
    period,
    truthRows: truth.length,
    outcomes,
    precision: claimed ? round2(outcomes.match / claimed) : null,
    recall: expectedBank ? round2(outcomes.match / expectedBank) : null,
    totals: {
      reportIncomeEur, reportExpenseEur,
      oursIncomeEur: round2(oursIncome), oursExpenseEur: round2(oursExpense),
      incomeDiffEur: round2(oursIncome - reportIncomeEur), expenseDiffEur: round2(oursExpense - reportExpenseEur),
      oursMissingEur: oursMissing,
      exemptExpenseEur: round2(exemptExpense),
    },
    rows,
    onlyInOurs,
    bankOnly,
    calibration: { dateLags, fxSpreads },
  };
}
