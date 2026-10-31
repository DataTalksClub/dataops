import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { attachThankYouResult, printThankYouHint } from "../thank-you.mjs";

export const summary = "Month-end reconciliation: bank statements, matching, payment confirm";

export const help = `dataops reconcile - month-end reconciliation (the Finance views' command line)

Usage
  dataops reconcile upload --file statement.(csv|pdf|xlsx) [--json]
      Finom and Revolut statements need no flags: the bank comes from the
      file, and its rows are stored as one statement per month, then each
      month is reconciled. A file that is no known statement is refused.
  dataops reconcile upload --file statement.(csv|pdf|xlsx) --account revolut|finom|mercury|merchant --period YYYY-MM [--currency EUR] [--by-month] [--json]
      Stores the raw statement as a verified private bank-statement document,
      parses its rows server-side and saves them for matching. Re-uploading the
      same file for the same account and period replaces the stored rows;
      rows that overlap another statement of the same account (a year export
      next to a month export) are counted once in the report.
      --currency sets the currency of a file without a currency column
      (Finom exports default to EUR). The closing balance of each wallet is
      stored with its as-of date.
      --by-month stores a statement spanning several months (a year export)
      as one statement per calendar month; --period then only labels the
      stored document.
  dataops reconcile balances [--account ACCOUNT] [--json]
      Latest known balance per account wallet, from uploaded statements.
  dataops reconcile statements [--period YYYY-MM] [--json]
  dataops reconcile statement <id> [--json]
  dataops reconcile report --period YYYY-MM [--json]
      Matched payment candidates, ambiguous matches, incoming money without an
      invoice, issued invoices without a payment, and statement coverage gaps.
  dataops reconcile confirm <match-id> [--period YYYY-MM] [--apply] [--json]
      Dry-run by default. --apply records the payment the way
      sponsors link-payment (existing ledger row) or receive-payment (no ledger
      row yet) do. The same match id always replays to the same write.
  dataops reconcile month YYYY-MM [--status STATUS] [--json|--csv]
      The month table: every bank transaction and ledger row with its other
      side, invoice/receipt documents, payment proof and status (matched,
      no-invoice, payment-proof-missing, amount-mismatch, needs-review).
  dataops reconcile months --from YYYY-MM --to YYYY-MM [--json]
      Counters and open/closed state per month.
  dataops reconcile match <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]
  dataops reconcile unmatch <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]
      Pair or unpair by hand; logged on the month. Unmatching an automatic
      pair keeps it from coming back.
  dataops reconcile attach-proof <ledger-id> <file> --period YYYY-MM [--account paypal]
      A separate payment proof for one ledger row the bank statements do not
      show (personal card, PayPal, other bank): PDF receipt/screenshot, or a
      statement CSV (--account names its source).
  dataops reconcile attach-doc <row> <file.pdf> --period YYYY-MM [--category C]
      The invoice/receipt for one row. A bank row without a ledger row gets a
      ledger row created from it, with the document attached.
  dataops reconcile create-ledger <bank-key> --period YYYY-MM [--category C] [--description D]
  dataops reconcile except <row> --kind KIND --period YYYY-MM [--proof TEXT] [--note TEXT]
      Mark a no-invoice row: tax_debit, tk_debit, platform_payout,
      internal_transfer, bank_fee, owner_withdrawal (each still needs its proof).
  dataops reconcile clear-except <row> --period YYYY-MM
  dataops reconcile confirm-exceptions YYYY-MM
      Admin sign-off of the month's exception list (required before close).
  dataops reconcile close YYYY-MM
      Refused, with the blocking rows listed, while any row lacks its
      invoice or its bank side. A closed month is locked.
  dataops reconcile reopen YYYY-MM --reason TEXT
  dataops reconcile config [--set rules.json] [--json]
  dataops reconcile aliases [--json]
  dataops reconcile alias add <alias> --sponsor SPONSOR [--json]
  dataops reconcile alias remove <id> [--json]
`;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const ACCOUNTS = ["revolut", "finom", "mercury", "merchant"];
const CURRENCY = /^[A-Za-z]{3}$/;

function periodOr(args) {
  const period = optionalString(args, "period");
  if (!MONTH.test(period || "")) throw new UsageError("--period must be YYYY-MM");
  return period;
}

function contentTypeFor(file) {
  const suffix = String(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const contentType = CONTENT_TYPES[suffix];
  if (!contentType) throw new UsageError("--file must be .csv, .pdf or .xlsx");
  return contentType;
}

async function storeDocument(api, file, { documentType, accountId, statementMonth, sourceRef }) {
  const contentType = contentTypeFor(file);
  const statement = ["bank-statement", "private-account-statement"].includes(documentType);
  if (!statement && contentType !== "application/pdf") throw new UsageError("invoices, receipts and proof screenshots must be PDF files");
  const bytes = await readFile(String(file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const idempotencyKey = `${documentType}-${sha256}`.slice(0, 120);
  let prepared = await api.post("/api/bookkeeping/documents/prepare", {
    sha256, byteSize: bytes.length, documentType, idempotencyKey, sourceRef,
    ...(statement ? { accountId, statementMonth, contentType } : {}),
  });
  if (prepared.uploadUrl) {
    const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", body: bytes, headers: prepared.uploadHeaders });
    if (!uploaded.ok) throw new Error(`Document upload failed (${uploaded.status}); retry the same file`);
    prepared = await api.post(`/api/bookkeeping/documents/${enc(prepared.document.id)}/complete`, { idempotencyKey });
  }
  return { documentId: prepared.document.id, sha256, reused: prepared.outcome === "existing" };
}

async function autoImport(args, io) {
  const api = apiFor(args);
  const currency = optionalString(args, "currency");
  if (currency !== undefined && !CURRENCY.test(currency)) throw new UsageError("--currency must be a 3-letter ISO code");
  // The stored document is labelled with the upload month; the statements carry their own months.
  const stored = await storeDocument(api, args.file, {
    documentType: "bank-statement", accountId: "auto", statementMonth: new Date().toISOString().slice(0, 7), sourceRef: "reconcile:auto",
  });
  const result = await api.post("/api/reconcile/statements/import", { documentId: stored.documentId, ...(currency ? { currency: currency.toUpperCase() } : {}) });
  if (!args.json) {
    io.print(`${stored.reused ? "Reused" : "Stored"} document ${stored.documentId}: ${result.layout}, ${result.rowCount} rows.`);
    for (const statement of result.statements) io.print(`  ${statement.period}: ${statement.rowCount} rows (statement ${statement.id})`);
    for (const period of result.skippedClosedMonths || []) io.print(`  ${period}: month is closed, rows not imported (reopen it first)`);
    for (const balance of result.balances || []) io.print(`balance ${balance.wallet ? `${balance.wallet} ` : ""}${balance.amount} ${balance.currency} as of ${balance.asOf}`);
    for (const warning of (result.warnings || []).slice(0, 5)) io.print(`warning: ${warning}`);
    for (const summary of result.summaries || []) io.print(summary);
  }
  return { documentId: stored.documentId, ...result };
}

export async function upload(args, io) {
  const usage = "dataops reconcile upload --file statement.(csv|pdf|xlsx) --account revolut|finom|mercury|merchant --period YYYY-MM [--currency EUR] [--by-month] [--json]";
  if (!args.file) throw new UsageError(usage);
  if (args.account === undefined && args.period === undefined) return autoImport(args, io);
  const account = String(args.account || "");
  if (!ACCOUNTS.includes(account)) throw new UsageError(`--account must be one of ${ACCOUNTS.join(", ")}`);
  const period = periodOr(args);
  const currency = optionalString(args, "currency");
  if (currency !== undefined && !CURRENCY.test(currency)) throw new UsageError("--currency must be a 3-letter ISO code");
  const contentType = contentTypeFor(args.file);
  const bytes = await readFile(String(args.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const idempotencyKey = `statement-${sha256}`;
  const api = apiFor(args);
  let prepared = await api.post("/api/bookkeeping/documents/prepare", {
    sha256, byteSize: bytes.length, documentType: "bank-statement",
    accountId: account, statementMonth: period, contentType, idempotencyKey,
    sourceRef: `reconcile:${account}:${period}`,
  });
  if (prepared.uploadUrl) {
    const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", body: bytes, headers: prepared.uploadHeaders });
    if (!uploaded.ok) {
      const failure = (await uploaded.text()).slice(0, 8192);
      const code = failure.match(/<Code>([A-Za-z0-9_-]+)<\/Code>/)?.[1] || "UploadRejected";
      throw new Error(`Statement upload failed (${uploaded.status}, ${code}); retry the same file`);
    }
    prepared = await api.post(`/api/bookkeeping/documents/${enc(prepared.document.id)}/complete`, { idempotencyKey });
  }
  const documentId = prepared.document.id;
  const parsed = await api.post("/api/reconcile/statements/parse", { account, documentId, ...(currency ? { currency: currency.toUpperCase() } : {}) });
  const months = args.byMonth
    ? [...new Set(parsed.rows.map((row) => row.date.slice(0, 7)))].sort()
    : [period];
  const statements = [];
  for (const month of months) {
    const rows = args.byMonth ? parsed.rows.filter((row) => row.date.startsWith(month)) : parsed.rows;
    // Each month keeps the balances as of its own last day; the latest month carries the closing ones.
    const balances = (parsed.balances || []).filter((balance) => !args.byMonth || balance.asOf.startsWith(month));
    const saved = await api.post("/api/reconcile/statements", {
      account, period: month, documentId,
      ...(parsed.filename ? { filename: parsed.filename } : {}),
      contentType: parsed.contentType,
      rows,
      ...(balances.length ? { balances } : {}),
      ...(parsed.warnings?.length && month === months.at(-1) ? { warnings: parsed.warnings } : {}),
    });
    statements.push(saved.statement);
  }
  const statement = statements.at(-1);
  if (!args.json) {
    io.print(`${prepared.outcome === "existing" ? "Reused" : "Stored"} document ${documentId} (sha256 ${sha256.slice(0, 12)}…).`);
    if (args.byMonth) {
      for (const item of statements) io.print(`Statement ${item.id}: ${item.period}, ${item.rows.length} rows.`);
    }
    io.print(`${args.byMonth ? `${statements.length} statements` : `Statement ${statement.id}`}: ${parsed.rows.length} rows, ${parsed.incomingCount} incoming, incoming total ${parsed.incomingTotal} across ${account}.`);
    for (const balance of parsed.balances || []) io.print(`balance ${balance.wallet ? `${balance.wallet} ` : ""}${balance.amount} ${balance.currency} as of ${balance.asOf}`);
    for (const warning of (parsed.warnings || []).slice(0, 5)) io.print(`warning: ${warning}`);
    if ((parsed.warnings || []).length > 5) io.print(`… and ${parsed.warnings.length - 5} more warnings (dataops reconcile statement ${statement.id} --json)`);
    io.print(`Next: dataops reconcile report --period ${months.at(-1)}`);
  }
  return { documentId, statement, ...(args.byMonth ? { statements } : {}), parsed };
}

export async function balances(args, io) {
  const account = optionalString(args, "account");
  if (account !== undefined && !ACCOUNTS.includes(account)) throw new UsageError(`--account must be one of ${ACCOUNTS.join(", ")}`);
  const result = await apiFor(args).get("/api/reconcile/balances", { query: account ? { account } : {} });
  if (!args.json) {
    for (const item of result.items) io.print(`${item.accountId}${item.wallet ? ` ${item.wallet}` : ""}  ${item.amount} ${item.currency}  as of ${item.asOf}`);
    if (!result.items.length) io.print("No balances stored; upload a statement with a balance column.");
  }
  return result;
}

export async function statements(args, io) {
  const api = apiFor(args);
  const period = optionalString(args, "period");
  const result = await api.get("/api/reconcile/statements", { query: period ? { period } : {} });
  if (!args.json) {
    for (const statement of result.items) {
      io.print(`${statement.id}  ${statement.accountId}  ${statement.period}  ${statement.rowCount} rows (${statement.incomingCount} incoming)${statement.filename ? `  ${statement.filename}` : ""}`);
    }
    if (!result.items.length) io.print("No statements stored.");
  }
  return result;
}

export async function statement(args, io) {
  const id = positional(args, 0, "dataops reconcile statement <id> [--json]");
  const result = await apiFor(args).get(`/api/reconcile/statements/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result.statement, null, 2));
  return result;
}

export async function report(args, io) {
  const period = periodOr(args);
  const result = await apiFor(args).get("/api/reconcile/report", { query: { period } });
  if (!args.json) {
    io.print(`Reconciliation ${period}`);
    for (const statement of result.statements) {
      io.print(`statement ${statement.accountId}: ${statement.rowCount} rows (${statement.incomingCount} incoming)${statement.duplicateCount ? `, ${statement.duplicateCount} already in an earlier statement` : ""}${statement.filename ? ` ${statement.filename}` : ""}`);
    }
    if (!result.statements.length) io.print("no statements uploaded for this period");
    io.print("");
    io.print(`Matched (${result.matched.length})`);
    for (const match of result.matched) {
      io.print(`  ${match.row.date}  ${match.row.amount} ${match.row.currency}  ${match.row.counterparty}`);
      io.print(`    → ${match.dealName} (${match.dealId})${match.invoiceNumber ? ` invoice ${match.invoiceNumber}` : ""} [${match.strategy}/${match.confidence}] match ${match.matchId}`);
      if (match.transactionId) io.print(`    ledger row ${match.transactionId}${match.transactionClaimedBy ? ` (already claimed by ${match.transactionClaimedBy})` : " (unclaimed)"}`);
    }
    io.print(`Ambiguous (${result.ambiguous.length}) — pick a deal and confirm by hand`);
    for (const ambiguous of result.ambiguous) {
      io.print(`  ${ambiguous.row.date}  ${ambiguous.row.amount} ${ambiguous.row.currency}  ${ambiguous.row.counterparty}`);
      for (const candidate of ambiguous.candidates) io.print(`    ? ${candidate.dealName} (${candidate.dealId})${candidate.invoiceNumber ? ` invoice ${candidate.invoiceNumber}` : ""} [${candidate.strategy}]`);
    }
    io.print(`Incoming without invoice (${result.unmatchedIncoming.length})`);
    for (const item of result.unmatchedIncoming) {
      io.print(`  ${item.row.date}  ${item.row.amount} ${item.row.currency}  ${item.row.counterparty}${item.transactionId ? `  ledger ${item.transactionId}${item.transactionClaimedBy ? ` (claimed by ${item.transactionClaimedBy})` : ""}` : ""}`);
    }
    io.print(`Issued invoices without payment (${result.missingPayments.length})`);
    for (const payment of result.missingPayments) {
      io.print(`  ${payment.dealName} (${payment.dealId})${payment.invoiceNumber ? ` invoice ${payment.invoiceNumber}` : ""}: ${payment.amountDue} ${payment.currency}${payment.dueOn ? ` due ${payment.dueOn}` : ""}`);
    }
    io.print("Statement coverage");
    for (const account of result.coverage.accounts) {
      io.print(`  ${account.accountId}: ${account.coveredDays}/${result.coverage.daysInPeriod} days${account.gaps.length ? `, gaps ${account.gaps.map((gap) => `${gap.from}…${gap.to}`).join(", ")}` : ", fully covered"}`);
    }
    for (const accountId of result.coverage.accountsWithoutStatement) io.print(`  ${accountId}: no statement uploaded`);
  }
  return result;
}

/** The payment the match would record, in sponsors link-payment shape. */
async function confirmPlan(api, match) {
  if (match.transactionId && !match.transactionClaimedBy) {
    let cursor;
    do {
      const page = await api.get(`/api/sponsor-crm/deals/${enc(match.dealId)}/finance/candidates/payments`, { query: { limit: 50, cursor } });
      const candidate = (page?.items || []).find((item) => item.id === match.transactionId);
      if (candidate) {
        return {
          mode: "link",
          endpoint: `/api/sponsor-crm/deals/${enc(match.dealId)}/finance/payments`,
          body: { sourceId: candidate.id, identityToken: candidate.identityToken },
          description: `${candidate.effectiveDate} ${candidate.amount} ${candidate.currency} ledger row ${candidate.id}`,
        };
      }
      cursor = page?.nextCursor;
    } while (cursor);
    throw new UsageError(`Ledger row ${match.transactionId} is not an unclaimed payment candidate for ${match.dealName}; re-run the report.`);
  }
  return {
    mode: "receive",
    endpoint: `/api/sponsor-crm/deals/${enc(match.dealId)}/finance/receipts`,
    body: {
      receivedOn: match.row.date,
      amount: match.row.amount.replace("-", ""),
      currency: match.row.currency,
      counterparty: match.row.counterparty,
      reference: `statement:${match.statementId}:${match.rowIndex}${match.row.reference ? `:${match.row.reference}` : ""}`.slice(0, 300),
    },
    description: `${match.row.date} ${match.row.amount} ${match.row.currency} from ${match.row.counterparty}`,
  };
}

export async function confirm(args, io) {
  const usage = "dataops reconcile confirm <match-id> [--period YYYY-MM] [--apply] [--json]";
  const matchId = positional(args, 0, usage);
  const api = apiFor(args);
  let period = optionalString(args, "period");
  const periods = period ? [period] : [new Date().toISOString().slice(0, 7)];
  let match = null, reportResult = null;
  for (const candidatePeriod of periods) {
    reportResult = await api.get("/api/reconcile/report", { query: { period: candidatePeriod } });
    match = reportResult.matched.find((item) => item.matchId === matchId) || null;
    if (match) { period = candidatePeriod; break; }
  }
  if (!match) throw new UsageError(`Match ${matchId} is not in the ${periods.join(" or ")} report; re-run dataops reconcile report.`);
  if (match.transactionClaimedBy) throw new UsageError(`Match ${matchId} already claimed by deal ${match.transactionClaimedBy}.`);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(match.dealId)}`),
    api.get(`/api/sponsor-crm/deals/${enc(match.dealId)}/finance`),
  ]);
  if (!projection?.finance) throw new UsageError(`Deal ${match.dealName} has no finance record; classify its invoice first.`);
  const plan = await confirmPlan(api, match);
  const body = {
    dealVersion: deal.version,
    expectedVersion: projection.finance.version,
    ...plan.body,
  };
  const result = {
    mode: args.apply ? "apply" : "dry-run",
    matchId, dealId: match.dealId, dealName: match.dealName,
    ...(match.invoiceNumber ? { invoiceNumber: match.invoiceNumber } : {}),
    paymentMode: plan.mode,
    plan: plan.description,
  };
  let afterProjection;
  if (args.apply) {
    // Deterministic key: the same match id replays to the same write.
    const response = await api.post(plan.endpoint, body, {
      headers: { "Idempotency-Key": `reconcile-${matchId}-${plan.mode === "link" ? "link" : "rcpt"}` },
    });
    afterProjection = response?.projection;
    result.paymentState = afterProjection?.paymentState ?? response?.paymentState;
    if (afterProjection) result.projection = afterProjection;
  }
  attachThankYouResult(result, {
    projection: afterProjection,
    beforeProjection: projection,
    fallbackPaymentState: args.apply ? undefined : "paid",
    dealName: match.dealName,
    invoiceNumber: match.invoiceNumber,
    amount: match.row?.amount?.replace("-", ""),
    currency: match.row?.currency,
    receivedOn: match.row?.date,
  });
  if (!args.json) {
    io.print(`${result.mode}: ${plan.mode === "link" ? "link ledger row" : "record receipt"} ${plan.description}`);
    io.print(`  for ${match.dealName}${match.invoiceNumber ? ` (invoice ${match.invoiceNumber})` : ""}${result.paymentState ? ` — deal is now ${result.paymentState}` : ""}`);
    printThankYouHint(io, result.thankYou);
    if (!args.apply) io.print("Re-run with --apply to write.");
  }
  return result;
}

const STATUSES = ["matched", "no-invoice", "payment-proof-missing", "amount-mismatch", "needs-review"];

function periodArg(args, usage) {
  const period = args._?.[0] && MONTH.test(args._[0]) ? args._[0] : optionalString(args, "period");
  if (!MONTH.test(period || "")) throw new UsageError(usage);
  return period;
}

function rowLine(row) {
  const bank = row.bank ? `bank ${row.bank.accountId}${row.bank.wallet ? `/${row.bank.wallet}` : ""} ${row.bank.date} ${row.bank.amount} ${row.bank.currency}${row.bank.reference ? ` ref ${row.bank.reference}` : ""}` : "no bank row";
  const ledger = row.ledger ? `ledger ${row.ledger.id.slice(0, 12)} ${row.ledger.date} ${row.ledger.amount} ${row.ledger.currency}${row.ledger.category ? ` [${row.ledger.category}]` : ""}` : "no ledger row";
  const docs = row.documents.length ? `docs ${row.documents.map((doc) => doc.id.slice(0, 12)).join(",")}` : "no invoice";
  const proof = row.paymentProof ? ` proof ${row.paymentProof.documentId.slice(0, 12)}` : "";
  const exception = row.exception ? ` exception ${row.exception.kind}${row.exception.satisfied ? "" : " (proof missing)"}` : "";
  return [
    `${row.date}  ${row.status.padEnd(21)} ${row.amount} ${row.currency}  ${row.counterparty}${row.description && row.description !== row.counterparty ? ` — ${row.description}` : ""}`,
    `    row ${row.id}  ${bank} | ${ledger} | ${docs}${proof}${exception}${row.pairBasis ? ` | ${row.pairBasis}/${row.confidence}` : ""}`,
    ...(row.missing ? [`    missing: ${row.missing}`] : []),
    ...(row.candidates?.length ? [`    candidates: ${row.candidates.map((candidate) => candidate.transactionId || candidate.bankKey).join(", ")}`] : []),
  ];
}

export async function month(args, io) {
  const usage = "dataops reconcile month YYYY-MM [--status STATUS] [--json|--csv]";
  const period = periodArg(args, usage);
  const api = apiFor(args);
  const status = optionalString(args, "status");
  if (status !== undefined && !STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`);
  if (args.csv) {
    const csv = await api.get(`/api/reconcile/months/${period}`, { query: { format: "csv" } });
    io.print(typeof csv === "string" ? csv.trimEnd() : String(csv));
    return { period, csv };
  }
  const result = await api.get(`/api/reconcile/months/${period}`);
  if (!args.json) {
    const c = result.counters;
    io.print(`Reconciliation ${period} — ${result.state}${result.closed ? ` (closed by ${result.closed.by} ${result.closed.at})` : ""}`);
    io.print(`${c.rows} rows: ${c.matched} matched, ${c.bankWithoutInvoice} without invoice, ${c.ledgerWithoutBank} without payment proof, ${c.amountMismatch} amount mismatch, ${c.needsReview} need review, ${c.exceptions} exceptions${c.exceptions ? (result.exceptionConfirmation?.current ? " (confirmed)" : " (not confirmed)") : ""}.`);
    io.print(result.blockers ? `${result.blockers} rows block closing.` : "Nothing blocks closing.");
    io.print(`Statements: ${result.statements.map((statement) => `${statement.accountId} ${statement.from}…${statement.to}`).join("; ") || "none"}`);
    const rows = result.rows.filter((row) => !status || row.status === status)
      .sort((left, right) => Number(left.status === "matched") - Number(right.status === "matched") || left.date.localeCompare(right.date));
    for (const row of rows) for (const line of rowLine(row)) io.print(line);
  }
  return result;
}

export async function months(args, io) {
  const usage = "dataops reconcile months --from YYYY-MM --to YYYY-MM [--json]";
  const from = optionalString(args, "from"), to = optionalString(args, "to");
  if (!MONTH.test(from || "") || !MONTH.test(to || "")) throw new UsageError(usage);
  const result = await apiFor(args).get("/api/reconcile/months", { query: { from, to } });
  if (!args.json) {
    io.print("month    state   rows matched no-inv no-proof mismatch review except blockers statements");
    for (const item of result.items) {
      const c = item.counters;
      io.print(`${item.period}  ${item.state.padEnd(6)} ${String(c.rows).padStart(4)} ${String(c.matched).padStart(7)} ${String(c.bankWithoutInvoice).padStart(6)} ${String(c.ledgerWithoutBank).padStart(8)} ${String(c.amountMismatch).padStart(8)} ${String(c.needsReview).padStart(6)} ${String(c.exceptions).padStart(6)} ${String(item.blockers).padStart(8)} ${String(item.statements).padStart(10)}`);
    }
  }
  return result;
}

const monthPost = async (args, period, action, body) => apiFor(args).post(`/api/reconcile/months/${period}/${action}`, body);

export async function match(args, io) {
  const usage = "dataops reconcile match <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]";
  const bankKey = positional(args, 0, usage), transactionId = positional(args, 1, usage);
  const period = periodOr(args);
  const note = optionalString(args, "note");
  const result = await monthPost(args, period, "pair", { bankKey, transactionId, ...(note ? { note } : {}) });
  if (!args.json) io.print(`Paired bank row ${bankKey} with ledger row ${transactionId} in ${period}.`);
  return result;
}

export async function unmatch(args, io) {
  const usage = "dataops reconcile unmatch <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]";
  const bankKey = positional(args, 0, usage), transactionId = positional(args, 1, usage);
  const period = periodOr(args);
  const note = optionalString(args, "note");
  const result = await monthPost(args, period, "unpair", { bankKey, transactionId, ...(note ? { note } : {}) });
  if (!args.json) io.print(`Unpaired bank row ${bankKey} from ledger row ${transactionId} in ${period}.`);
  return result;
}

export async function attachProof(args, io) {
  const usage = "dataops reconcile attach-proof <ledger-id> <file> --period YYYY-MM [--account paypal]";
  const transactionId = positional(args, 0, usage), file = positional(args, 1, usage);
  const period = periodOr(args);
  const api = apiFor(args);
  const isPdf = contentTypeFor(file) === "application/pdf";
  const account = optionalString(args, "account") || "other";
  const stored = await storeDocument(api, file, isPdf
    ? { documentType: "other-evidence", sourceRef: `reconcile-proof:${period}` }
    : { documentType: "private-account-statement", accountId: account, statementMonth: period, sourceRef: `reconcile-proof:${account}:${period}` });
  const result = await api.post(`/api/reconcile/months/${period}/proof`, { transactionId, documentId: stored.documentId });
  if (!args.json) io.print(`${stored.reused ? "Reused" : "Stored"} proof ${stored.documentId}; ledger row ${transactionId} now has its payment proof.`);
  return { ...result, documentId: stored.documentId };
}

export async function attachDoc(args, io) {
  const usage = "dataops reconcile attach-doc <row> <file.pdf> --period YYYY-MM [--category C]";
  const row = positional(args, 0, usage), file = positional(args, 1, usage);
  const period = periodOr(args);
  const api = apiFor(args);
  const stored = await storeDocument(api, file, { documentType: "receipt", sourceRef: `reconcile-doc:${period}` });
  let result;
  if (row.startsWith("ledger:")) {
    result = await api.post(`/api/reconcile/months/${period}/document`, { transactionId: row.slice(7), documentId: stored.documentId });
  } else {
    const category = optionalString(args, "category");
    result = await api.post(`/api/reconcile/months/${period}/ledger`, { bankKey: row, documentId: stored.documentId, ...(category ? { category } : {}) });
  }
  if (!args.json) io.print(`${stored.reused ? "Reused" : "Stored"} document ${stored.documentId} and attached it to ${row}${result.transaction ? ` (ledger row ${result.transaction.id} created from the bank row)` : ""}.`);
  return { ...result, documentId: stored.documentId };
}

export async function createLedger(args, io) {
  const usage = "dataops reconcile create-ledger <bank-key> --period YYYY-MM [--category C] [--description D]";
  const bankKey = positional(args, 0, usage);
  const period = periodOr(args);
  const category = optionalString(args, "category"), description = optionalString(args, "description");
  const result = await monthPost(args, period, "ledger", { bankKey, ...(category ? { category } : {}), ...(description ? { description } : {}) });
  if (!args.json) io.print(`${result.duplicate ? "Ledger row already existed" : "Created ledger row"} ${result.transaction.id} for bank row ${bankKey}.`);
  return result;
}

export async function except(args, io) {
  const usage = "dataops reconcile except <row> --kind KIND --period YYYY-MM [--proof TEXT] [--note TEXT]";
  const row = positional(args, 0, usage);
  const period = periodOr(args);
  const kind = optionalString(args, "kind");
  if (!kind) throw new UsageError(usage);
  const proof = optionalString(args, "proof"), note = optionalString(args, "note");
  const result = await monthPost(args, period, "exception", { row, kind, ...(proof ? { proof } : {}), ...(note ? { note } : {}) });
  if (!args.json) io.print(`Marked ${row} as ${kind}${proof ? ` (proof: ${proof})` : ""}.`);
  return result;
}

export async function clearExcept(args, io) {
  const usage = "dataops reconcile clear-except <row> --period YYYY-MM";
  const row = positional(args, 0, usage);
  const result = await monthPost(args, periodOr(args), "clear-exception", { row });
  if (!args.json) io.print(`Cleared the exception on ${row}.`);
  return result;
}

function printBlockers(io, error) {
  const blockers = error?.body?.blockers || error?.details?.blockers || [];
  for (const blocker of blockers.slice(0, 50)) io.print(`  ${blocker.date || ""} ${blocker.status || blocker.kind || ""} ${blocker.amount || ""} ${blocker.currency || ""} ${blocker.counterparty || blocker.id}${blocker.missing ? ` — ${blocker.missing}` : ""}`);
  if (blockers.length > 50) io.print(`  … and ${blockers.length - 50} more (dataops reconcile month <period> --status …)`);
}

async function gate(args, io, action, usage, body = {}) {
  const period = periodArg(args, usage);
  try {
    const result = await monthPost(args, period, action, body);
    return { period, result };
  } catch (error) {
    if (!args.json) { io.print(String(error.message || error)); printBlockers(io, error); }
    throw error;
  }
}

export async function confirmExceptions(args, io) {
  const { period, result } = await gate(args, io, "confirm-exceptions", "dataops reconcile confirm-exceptions YYYY-MM");
  if (!args.json) io.print(`Confirmed ${result.month.exceptionConfirmation.count} exception rows for ${period}.`);
  return result;
}

export async function close(args, io) {
  const { period, result } = await gate(args, io, "close", "dataops reconcile close YYYY-MM");
  if (!args.json) io.print(`Closed ${period}. The month is locked; dataops reconcile reopen ${period} --reason … to change it.`);
  return result;
}

export async function reopen(args, io) {
  const reason = optionalString(args, "reason");
  if (!reason) throw new UsageError("dataops reconcile reopen YYYY-MM --reason TEXT");
  const { period, result } = await gate(args, io, "reopen", "dataops reconcile reopen YYYY-MM --reason TEXT", { reason });
  if (!args.json) io.print(`Reopened ${period}. The exception list needs confirming again before it closes.`);
  return result;
}

export async function config(args, io) {
  const api = apiFor(args);
  const file = optionalString(args, "set");
  const result = file
    ? await api.put("/api/reconcile/config", JSON.parse(await readFile(file, "utf8")))
    : await api.get("/api/reconcile/config");
  if (!args.json) io.print(JSON.stringify(result.config, null, 2));
  return result;
}

export async function aliases(args, io) {
  const result = await apiFor(args).get("/api/reconcile/aliases");
  if (!args.json) {
    for (const alias of result.items) io.print(`${alias.id}  ${alias.alias} → ${alias.sponsor}`);
    if (!result.items.length) io.print("No counterparty aliases stored.");
  }
  return result;
}

export async function alias(args, io) {
  const api = apiFor(args);
  const action = positional(args, 0, "dataops reconcile alias add <alias> --sponsor SPONSOR | alias remove <id>");
  if (action === "add") {
    const name = positional(args, 1, "dataops reconcile alias add <alias> --sponsor SPONSOR");
    const sponsor = optionalString(args, "sponsor");
    if (!sponsor) throw new UsageError("--sponsor is required");
    const result = await api.post("/api/reconcile/aliases", { alias: name, sponsor });
    if (!args.json) io.print(`Alias ${result.alias.alias} → ${result.alias.sponsor} (${result.alias.id})`);
    return result;
  }
  if (action === "remove") {
    const id = positional(args, 1, "dataops reconcile alias remove <id>");
    const result = await api.delete(`/api/reconcile/aliases/${enc(id)}`);
    if (!args.json) io.print(`Removed alias ${result.deleted}.`);
    return result;
  }
  throw new UsageError("dataops reconcile alias add <alias> --sponsor SPONSOR | alias remove <id>");
}

export const commands = {
  upload, balances, statements, statement, report, confirm, aliases, alias,
  month, months, match, unmatch, "attach-proof": attachProof, "attach-doc": attachDoc, "create-ledger": createLedger,
  except, "clear-except": clearExcept, "confirm-exceptions": confirmExceptions, close, reopen, config,
};
