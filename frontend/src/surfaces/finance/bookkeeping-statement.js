const DAY_MS = 86_400_000;
const MATCH_WINDOW_DAYS = 10;

function asMonthViews(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
}

function asStatement(value) {
  return value?.statement || value || null;
}

function validDate(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysApart(left, right) {
  const a = validDate(left), b = validDate(right);
  return a === null || b === null ? null : Math.round(Math.abs(a - b) / DAY_MS);
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

function signedCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ");
}

function accountLabel(accountId, currency, wallet) {
  const account = String(accountId || "").toLowerCase();
  const code = String(currency || "").toUpperCase();
  const walletName = String(wallet || "").trim();
  const bases = {
    revolut: "Revolut Business",
    finom: "Finom",
    mercury: "Mercury",
    merchant: "Merchant account",
  };
  const base = bases[account] || String(accountId || "Bank account");
  const pieces = [base];
  if (walletName && normalizedText(walletName) !== normalizedText(base) && normalizedText(walletName) !== normalizedText(code) && normalizedText(walletName) !== "business")
    pieces.push(walletName);
  if (code && normalizedText(walletName) !== normalizedText(code)) pieces.push(code);
  return pieces.join(" ");
}

function sourceRowIndex(rows, bank) {
  if (!Array.isArray(rows)) return null;
  const date = String(bank.date || "").slice(0, 10);
  const amount = cents(bank.amount);
  const currency = String(bank.currency || "").toUpperCase();
  const counterparty = normalizedText(bank.counterparty);
  const reference = normalizedText(bank.reference);
  const matches = [];
  rows.forEach((row, index) => {
    if (
      String(row?.date || "").slice(0, 10) === date &&
      signedCents(row?.amount) === signedCents(bank.amount) &&
      String(row?.currency || "").toUpperCase() === currency &&
      normalizedText(row?.counterparty) === counterparty &&
      normalizedText(row?.reference) === reference
    ) matches.push(index);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve the reconciliation row for a transaction. The `monthViews` input is
 * one MonthView or an array of adjacent MonthViews; `statementRecord` may be
 * the API response body ({ statement }) or the StatementRecord itself.
 *
 * Returns null unless there is one unambiguous bank pair and its statement
 * record is loaded. `statementRowIndex` is zero-based and null when the
 * statement line cannot be identified uniquely.
 */
export function statementLinkForTransaction(transaction, monthViews, statementRecord) {
  const transactionId = String(transaction?.id || "");
  if (!transactionId) return null;
  const pairs = new Map();
  for (const view of asMonthViews(monthViews)) {
    for (const row of Array.isArray(view?.rows) ? view.rows : []) {
      if (String(row?.ledger?.id || "") !== transactionId || !row.bank?.statementId) continue;
      const bankKey = String(row.bank.key || row.id || "");
      if (bankKey) pairs.set(bankKey, row.bank);
    }
  }
  if (pairs.size !== 1) return null;
  const bank = [...pairs.values()][0];
  const statement = asStatement(statementRecord);
  if (!statement || String(statement.id || "") !== String(bank.statementId)) return null;
  const currency = String(bank.currency || "").toUpperCase();
  return {
    accountId: String(bank.accountId || statement.accountId || ""),
    accountLabel: accountLabel(bank.accountId || statement.accountId, currency, bank.wallet),
    statementId: String(statement.id),
    statementPeriod: String(statement.period || ""),
    statementDocumentId: statement.documentId ? String(statement.documentId) : "",
    statementArtifactId: statement.artifactId ? String(statement.artifactId) : "",
    statementFilename: statement.filename ? String(statement.filename) : "",
    statementContentType: statement.contentType ? String(statement.contentType) : "",
    bankKey: String(bank.key || ""),
    line: {
      date: String(bank.date || "").slice(0, 10),
      amount: String(bank.amount || ""),
      currency,
      counterparty: String(bank.counterparty || ""),
      reference: String(bank.reference || ""),
    },
    statementRowIndex: sourceRowIndex(statement.rows, bank),
  };
}

function transactionDate(transaction) {
  return transaction?.paidDate || transaction?.transactionDate || "";
}

function periodAt(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function shiftPeriod(period, delta) {
  const [year, month] = period.split("-").map(Number);
  const index = year * 12 + month - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Months that can contain a bank line within `maxDays` of the transaction. */
export function statementPeriodsForTransaction(transaction, maxDays = MATCH_WINDOW_DAYS) {
  const timestamp = validDate(transactionDate(transaction));
  if (timestamp === null || !Number.isSafeInteger(maxDays) || maxDays < 0) return [];
  const first = periodAt(timestamp - maxDays * DAY_MS);
  const last = periodAt(timestamp + maxDays * DAY_MS);
  const periods = [];
  for (let period = first; period <= last; period = shiftPeriod(period, 1)) periods.push(period);
  return periods;
}

function exactStatementAmount(transaction, bank) {
  const bankAmount = cents(bank.amount);
  if (bankAmount === null) return false;
  // A refund is the money coming back: its bank line is a credit.
  const isRefund = String(transaction.subtype || "") === "Refund" || String(transaction.sourceKey || "").startsWith("credit-note:");
  const expectedSign = isRefund || String(transaction.entryType || "expense").toLowerCase() === "income" ? 1 : -1;
  if (Math.sign(Number(bank.amount)) !== expectedSign) return false;
  const sameCurrency = String(transaction.currency || "EUR").toUpperCase() === String(bank.currency || "").toUpperCase();
  if (sameCurrency && cents(transaction.amount) === bankAmount) return true;
  return String(bank.currency || "").toUpperCase() === "EUR" && cents(transaction.amountEur) === bankAmount;
}

/**
 * Return nearby, unpaired bank lines that fit the transaction's exact amount
 * and currency (or exact recorded EUR conversion). These are candidates for
 * the manual reconciliation picker; this helper does not pair or mutate data.
 */
export function unmatchedStatementCandidates(transaction, monthViews, { maxDays = MATCH_WINDOW_DAYS } = {}) {
  if (!transaction?.id || cents(transaction.amount) === null) return [];
  const date = transactionDate(transaction);
  const candidates = new Map();
  for (const view of asMonthViews(monthViews)) {
    for (const row of Array.isArray(view?.rows) ? view.rows : []) {
      const bank = row?.bank;
      if (!bank || row.ledger || !bank.key || !bank.statementId || !exactStatementAmount(transaction, bank)) continue;
      const gapDays = daysApart(date, bank.date);
      if (gapDays === null || gapDays > maxDays) continue;
      const key = String(bank.key);
      const current = candidates.get(key);
      if (!current || gapDays < current.gapDays) {
        candidates.set(key, {
          bankKey: key,
          period: String(view.period || ""),
          statementId: String(bank.statementId),
          accountId: String(bank.accountId || ""),
          accountLabel: accountLabel(bank.accountId, bank.currency, bank.wallet),
          line: {
            date: String(bank.date || "").slice(0, 10),
            amount: String(bank.amount || ""),
            currency: String(bank.currency || "").toUpperCase(),
            counterparty: String(bank.counterparty || ""),
            reference: String(bank.reference || ""),
          },
          gapDays,
        });
      }
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.gapDays - right.gapDays ||
    left.line.date.localeCompare(right.line.date) ||
    left.bankKey.localeCompare(right.bankKey),
  );
}

/**
 * Load real reconciliation views and, when paired, the stored statement record
 * for one transaction. The caller owns caching and display; this function only
 * reads the reconciliation API.
 */
export async function loadTransactionStatementContext(
  transaction,
  { request, workApiUrl, maxDays = MATCH_WINDOW_DAYS } = {},
) {
  if (typeof request !== "function" || typeof workApiUrl !== "function")
    throw new TypeError("request and workApiUrl are required");
  const periods = statementPeriodsForTransaction(transaction, maxDays);
  if (!periods.length) return { monthViews: [], statementLink: null, statementCandidates: [] };

  const monthViews = await Promise.all(periods.map(async (period) => {
    const value = await request(workApiUrl(`/api/reconcile/months/${encodeURIComponent(period)}`));
    return value?.month || value;
  }));
  const matchedBanks = new Map();
  for (const view of monthViews) {
    for (const row of Array.isArray(view?.rows) ? view.rows : []) {
      if (String(row?.ledger?.id || "") !== String(transaction?.id || "") || !row?.bank?.statementId) continue;
      const key = String(row.bank.key || row.id || "");
      if (key) matchedBanks.set(key, String(row.bank.statementId));
    }
  }
  if (matchedBanks.size === 1) {
    const [statementId] = matchedBanks.values();
    const statement = await request(
      workApiUrl(`/api/reconcile/statements/${encodeURIComponent(statementId)}`),
    );
    const statementLink = statementLinkForTransaction(transaction, monthViews, statement);
    if (statementLink) return { monthViews, statementLink, statementCandidates: [] };
  }
  return {
    monthViews,
    statementLink: null,
    statementCandidates: unmatchedStatementCandidates(transaction, monthViews, { maxDays }),
  };
}

/** Manually pair a transaction with a bank line selected from the statement picker. */
export async function pairTransactionWithStatementRow(
  transactionId,
  candidate,
  { request, workApiUrl } = {},
) {
  const id = String(transactionId || "");
  const period = String(candidate?.period || "");
  const bankKey = String(candidate?.bankKey || "");
  if (!id || !bankKey || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new TypeError("A transaction and valid statement candidate are required");
  if (typeof request !== "function" || typeof workApiUrl !== "function")
    throw new TypeError("request and workApiUrl are required");
  return request(workApiUrl(`/api/reconcile/months/${encodeURIComponent(period)}/pair`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bankKey, transactionId: id }),
  });
}
