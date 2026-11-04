import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join, relative, resolve, sep, posix, win32 } from "node:path";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { contentTypeFor, requirePdfBytes, storeDocument } from "../documentUpload.mjs";
import { attachThankYouResult, printThankYouHint } from "../thank-you.mjs";

export const summary = "Month-end reconciliation: bank statements, matching, payment confirm";

export const help = `dataops reconcile - month-end reconciliation (the Finance views' command line)

Usage
  dataops reconcile upload --file statement.pdf [--account finom|revolut] [--period YYYY-MM] [--quiet] [--preview|--replace] [--json]
      Finom and Revolut statements need no flags: the bank comes from the
      file, and its rows are stored as one statement per month, then each
      month is reconciled and summarised in a finance notification
      (--quiet skips it, e.g. for history). A file that is no known
      statement is refused. An overlapping statement returns a difference
      preview without changing active data. --replace explicitly confirms the
      current preview; --preview/--dry-run only previews. Both banks preserve
      original PDF history and use the printed account, wallet and month.
  dataops reconcile import-document <document-id> [--period YYYY-MM] [--quiet] [--preview|--replace] [--json]
      Parse a bank-statement document DataOps already stores (bank detected
      from its content) into per-month statements. The same preview and explicit
      replacement rules apply; --period selects the month to import.
  dataops reconcile parse <document-id> --account revolut|finom|mercury|merchant [--json]
      The same parse without storing anything: prints the row count, incoming
      total, per-wallet closing balances and warnings for a stored
      bank-statement document.
  dataops reconcile balances [--account ACCOUNT] [--json]
      Latest known balance per account wallet, from uploaded statements.
  dataops reconcile statements [--period YYYY-MM] [--json]
  dataops reconcile statement <id> [--json]
  dataops reconcile report --period YYYY-MM [--json]
      Matched payment candidates, ambiguous matches, incoming money without an
      invoice, issued invoices without a payment, platform payouts, and statement
      coverage gaps. A platform payout appears in its income month and the month
      it was added, so late entries surface in the next monthly report.
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
  dataops reconcile matches --period YYYY-MM [--json]
      The result of the automatic matching: matched bank rows with their
      invoice, basis, confidence and difference; bank rows without an invoice;
      invoices without a bank row. Matching runs by itself after every
      statement upload; confident pairs are persisted, weak ones wait for review.
  dataops reconcile auto-match --period YYYY-MM [--json]
      Run the matcher on a month again (after new invoices arrive) and show the result.
  dataops reconcile match <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]
  dataops reconcile unmatch <bank-key> <ledger-id> --period YYYY-MM [--note TEXT]
      Pair or unpair by hand; logged on the month. Unmatching an automatic
      pair keeps it from coming back.
  dataops reconcile attach-proof <ledger-id> <file> --period YYYY-MM [--account paypal]
      A separate PDF payment proof for one ledger row the bank statements do
      not show (personal card, PayPal, other bank).
  dataops reconcile attach-doc <row> <file.pdf> --period YYYY-MM [--category C]
      The invoice/receipt for one row. A bank-row key attaches to its paired
      ledger row, or creates one if unpaired. A ledger ID (64 hex, UUID,
      receipt-<hex>, optionally prefixed ledger:) attaches directly.
  dataops reconcile create-ledger <bank-key> --period YYYY-MM [--category C] [--description D]
      Create the missing ledger row and pair it with the bank row. Repeating the
      command for the same bank row reuses that ledger row.
  dataops reconcile void-ledger <ledger-id> --period YYYY-MM --reason TEXT --duplicate-of <ledger-id> [--yes]
      Soft-void one exact duplicate ledger row; dry run unless --yes. Requires
      an admin, a reason, and an active duplicate row from the same period with
      matching amount, currency and counterparty (dates within 3 days). Keeps
      the row, its links and audit history; voided rows leave normal totals and
      reconciliation until restored.
  dataops reconcile restore-ledger <ledger-id> --period YYYY-MM --reason TEXT [--yes]
      Restore a previously voided row after checking its active duplicate twin;
      dry run unless --yes. Requires an admin and is recorded in the audit log.
  dataops reconcile note <ledger-id> --note TEXT
      Add or replace the note on an existing ledger row.
  dataops reconcile except <row> --kind KIND --period YYYY-MM [--proof TEXT] [--note TEXT]
      Mark a no-invoice row: tax_debit, tax_refund, tk_debit, platform_payout,
      internal_transfer, bank_fee, owner_withdrawal. Tax rows are listed separately.
  dataops reconcile clear-except <row> --period YYYY-MM
  dataops reconcile disposition <row-id> --period YYYY-MM --kind verified-unpaid|deferred --reason TEXT --evidence TEXT --digest SHA256 --version N [--target-period YYYY-MM]
  dataops reconcile confirm-exceptions YYYY-MM
      Admin sign-off of the month's exception list (required before close).
  dataops reconcile close YYYY-MM
      Refused, with the blocking rows listed, while any row lacks its
      invoice or its bank side. A closed month is locked.
  dataops reconcile reopen YYYY-MM --reason TEXT
  dataops reconcile package YYYY-MM [--out DIR] [--draft] [--json]
      Build the accountant's month package locally (nothing is sent):
        YYYY-MM/YYYY-MM_reconciliation_datatalksclub.csv
        YYYY-MM/statements/YYYY-MM_<bank>-<account>_statement.<ext>
        YYYY-MM/income|expenses/YYYY-MM-DD_<company>_<what>_<amount><CUR>.pdf
        YYYY-MM/proofs/YYYY-MM-DD_<company>_<payment-proof-what>_<amount><CUR>.pdf
      plus datatalksclub-YYYY-MM.zip, created natively without an external zip
      command. Date is the cash date; company/what use the saved report values,
      and amount uses the invoice/allocation currency. Payment proofs name
      their purpose in what. Invoice numbers stay in the source PDF. Text uses
      lowercase-hyphen slugs (max 40), collisions get -2, -3; originals keep
      their names in DataOps. Refused for an open month unless --draft.
  dataops reconcile config [--set rules.json] [--json]
  dataops reconcile aliases [--json]
  dataops reconcile alias add <alias> --sponsor SPONSOR [--json]
  dataops reconcile alias remove <id> [--json]
`;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ACCOUNTS = ["revolut", "finom", "mercury", "merchant"];

function periodOr(args) {
  const period = optionalString(args, "period");
  if (!MONTH.test(period || "")) throw new UsageError("--period must be YYYY-MM");
  return period;
}

async function importStoredStatement(api, documentId, args) {
  const input = { documentId, ...(args.account ? { account: args.account } : {}), ...(args.period && !args.byMonth ? { period: args.period } : {}), ...(args.quiet ? { notify: false } : {}) };
  const result = await api.post("/api/reconcile/statements/import", { ...input, ...(args.preview || args.dryRun || args.replace ? { preview: true } : {}) });
  if (args.replace && !args.preview && !args.dryRun) return api.post("/api/reconcile/statements/import", { ...input, replace: true, previewDigest: result.preview.digest });
  return result;
}

function printStatementImport(result, io) {
  if (result.preview) {
    io.print(result.preview.message);
    for (const item of result.preview.replacements) {
      io.print(`${item.period}: ${item.difference.identical ? "no operation differences" : `${item.difference.added.reduce((n, row) => n + row.count, 0)} added, ${item.difference.removed.reduce((n, row) => n + row.count, 0)} removed`}; balances ${item.difference.balancesChanged ? "changed" : "unchanged"}; coverage ${item.difference.periodChanged ? "changed" : "unchanged"}`);
      const balances = (values) => (values || []).map((value) => `${value.asOf} ${value.wallet || "main"} ${value.amount} ${value.currency}`).join(", ") || "not printed";
      for (const [label, record] of [...item.difference.existing.map((record) => ["Existing", record]), ["Incoming", item.difference.candidate]]) {
        io.print(`  ${label}: Issue date ${record.issueDate || "not printed"}; From ${record.from || "not printed"}; To ${record.to || "not printed"}; Opening ${balances(record.openingBalances)}; Closing ${balances(record.balances)}.`);
      }
    }
    if (!result.committed) io.print("No active statement changed. Review --json for row differences; use --replace to confirm replacement after review.");
  }
  for (const statement of result.statements || []) io.print(`${statement.period}: ${statement.rowCount} rows (statement ${statement.id})`);
  for (const balance of result.balances || []) io.print(`balance ${balance.wallet ? `${balance.wallet} ` : ""}${balance.amount} ${balance.currency} as of ${balance.asOf}`);
  for (const summary of result.summaries || []) io.print(summary);
}

export async function upload(args, io) {
  if (!args.file) throw new UsageError("dataops reconcile upload --file statement.pdf [--account finom|revolut] [--period YYYY-MM] [--preview|--replace] [--json]");
  if (args.account && !ACCOUNTS.includes(String(args.account))) throw new UsageError(`--account must be one of ${ACCOUNTS.join(", ")}`);
  if (args.period) periodOr(args);
  contentTypeFor(args.file);
  requirePdfBytes(args.file, await readFile(String(args.file)));
  const api = apiFor(args);
  const stored = await storeDocument(api, args.file, { documentType: "bank-statement", accountId: args.account || "auto", statementMonth: args.period || new Date().toISOString().slice(0, 7), sourceRef: "reconcile:upload" });
  const result = await importStoredStatement(api, stored.documentId, args);
  if (!args.json) printStatementImport(result, io);
  return { documentId: stored.documentId, ...result };
}

export async function importDocument(args, io) {
  const usage = "dataops reconcile import-document <document-id> [--period YYYY-MM] [--quiet] [--preview|--replace] [--json]";
  const documentId = positional(args, 0, usage);
  const result = await importStoredStatement(apiFor(args), documentId, args);
  if (!args.json) printStatementImport(result, io);
  return result;
}

export async function parse(args, io) {
  const usage = "dataops reconcile parse <document-id> --account revolut|finom|mercury|merchant [--json]";
  const documentId = positional(args, 0, usage);
  const account = String(args.account || "");
  if (!ACCOUNTS.includes(account)) throw new UsageError(`--account must be one of ${ACCOUNTS.join(", ")}`);
  const result = await apiFor(args).post("/api/reconcile/statements/parse", { account, documentId });
  if (!args.json) {
    io.print(`${result.rowCount} rows, ${result.incomingCount} incoming, incoming total ${result.incomingTotal} across ${account}; nothing stored.`);
    for (const balance of result.balances || []) io.print(`balance ${balance.wallet ? `${balance.wallet} ` : ""}${balance.amount} ${balance.currency} as of ${balance.asOf}`);
    for (const warning of (result.warnings || []).slice(0, 5)) io.print(`warning: ${warning}`);
  }
  return result;
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
      io.print(`${statement.id}  ${statement.accountId}  ${statement.period}  ${statement.rowCount} rows (${statement.incomingTotal} incoming)${statement.filename ? `  ${statement.filename}` : ""}`);
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
    const platformPayouts = result.platformPayouts || [];
    io.print(`Platform payouts (${platformPayouts.length})`);
    for (const payout of platformPayouts) {
      io.print(`  ${payout.transactionDate}  ${payout.amount} ${payout.currency}  ${payout.counterparty}${payout.category ? `  ${payout.category}` : ""}${payout.reference ? `  reference ${payout.reference}` : ""}  (income ${payout.incomePeriod}; added ${payout.addedAt})`);
      if (payout.comment) io.print(`    ${payout.comment}`);
    }
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
    const rows = result.rows.filter((row) => !row.tax && (!status || row.status === status))
      .sort((left, right) => Number(left.status === "matched") - Number(right.status === "matched") || left.date.localeCompare(right.date));
    for (const row of rows) for (const line of rowLine(row)) io.print(line);
    const taxRows = result.rows.filter((row) => row.tax).sort((left, right) => left.date.localeCompare(right.date));
    if (taxRows.length) {
      io.print(`\nTaxes and health insurance (${taxRows.length}; excluded from month-close review and accountant package)`);
      for (const row of taxRows) for (const line of rowLine(row)) io.print(line);
    }
  }
  return result;
}

const matchLine = (period, counts) =>
  `Matches ${period}: ${counts.matched} matched (${counts.autoMatched} automatically, ${counts.needsReview} to review), ${counts.unmatchedBank} bank rows unmatched, ${counts.invoicesWithoutBank} invoices without a bank row.`;

const money = (amount, currency) => `${amount} ${currency}`;

function printMatches(io, result) {
  io.print(matchLine(result.period, result.counts));
  io.print(`\nMatched (${result.matched.length})`);
  for (const row of result.matched) {
    io.print(`  ${row.date}  ${money(row.amount, row.currency)}  ${row.counterparty}`);
    io.print(`    ↔ ${row.invoice.counterparty}${row.invoice.invoiceNumber ? ` #${row.invoice.invoiceNumber}` : ""} ${row.invoice.date} ${money(row.invoice.amount, row.invoice.currency)}  [${row.basis}/${row.confidence}${row.auto ? ", auto" : ""}]${row.difference ? ` diff ${row.difference}` : ""}${row.documents === 0 || row.invoice.documents === 0 ? " (no document)" : ""}  bank ${row.bankKey} ledger ${row.invoice.transactionId}`);
  }
  io.print(`\nBank rows without an invoice (${result.unmatchedBank.length})`);
  for (const row of result.unmatchedBank) io.print(`  ${row.date}  ${money(row.amount, row.currency)}  ${row.counterparty}${row.classification ? ` [${row.classification}]` : ""}  ${row.status}  bank ${row.bankKey}`);
  io.print(`\nInvoices without a bank row (${result.invoicesWithoutBank.length})`);
  for (const row of result.invoicesWithoutBank) io.print(`  ${row.date}  ${money(row.amount, row.currency)}  ${row.counterparty}${row.invoiceNumber ? ` #${row.invoiceNumber}` : ""}  ledger ${row.transactionId}`);
}

export async function matches(args, io) {
  const usage = "dataops reconcile matches --period YYYY-MM [--json]";
  if (!MONTH.test(optionalString(args, "period") || "")) throw new UsageError(usage);
  const result = await apiFor(args).get(`/api/reconcile/months/${periodOr(args)}/matches`);
  if (!args.json) printMatches(io, result);
  return result;
}

export async function autoMatch(args, io) {
  const usage = "dataops reconcile auto-match --period YYYY-MM [--json]";
  if (!MONTH.test(optionalString(args, "period") || "")) throw new UsageError(usage);
  const result = await monthPost(args, periodOr(args), "auto-match", {});
  if (!args.json) {
    io.print(`Auto-matched ${result.autoMatch.attached} new pairs${result.autoMatch.skippedClosedMonths.length ? ` (closed, skipped: ${result.autoMatch.skippedClosedMonths.join(", ")})` : ""}.`);
    printMatches(io, result);
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

const LEDGER_ID = /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|receipt-[a-f0-9]{20,64})$/i;

export async function attachDoc(args, io) {
  const usage = "dataops reconcile attach-doc <row> <file.pdf> --period YYYY-MM [--category C]";
  const row = positional(args, 0, usage), file = positional(args, 1, usage);
  const period = periodOr(args);
  const api = apiFor(args);
  const stored = await storeDocument(api, file, { documentType: "receipt", sourceRef: `reconcile-doc:${period}` });
  let result;
  const ledgerId = row.replace(/^ledger:/, "");
  if (row.startsWith("ledger:") || LEDGER_ID.test(ledgerId)) {
    result = await api.post(`/api/reconcile/months/${period}/document`, { transactionId: ledgerId, documentId: stored.documentId });
  } else {
    const category = optionalString(args, "category");
    result = await api.post(`/api/reconcile/months/${period}/ledger`, { bankKey: row, documentId: stored.documentId, ...(category ? { category } : {}) });
  }
  if (!args.json) {
    const document = `${stored.reused ? "Reused" : "Stored"} document ${stored.documentId}`;
    if (result.paired && result.transaction?.id) {
      io.print(`${document} and attached it to paired ledger row ${result.transaction.id} for bank row ${row}.`);
    } else {
      io.print(`${document} and attached it to ${row}${result.transaction ? ` (ledger row ${result.transaction.id} created from the bank row)` : ""}.`);
    }
  }
  return { ...result, documentId: stored.documentId };
}

export async function note(args, io) {
  const usage = "dataops reconcile note <ledger-id> --note TEXT";
  const transactionId = positional(args, 0, usage);
  const text = optionalString(args, "note");
  if (text === undefined) throw new UsageError(usage);
  const api = apiFor(args);
  const transaction = await api.put(`/api/bookkeeping/transactions/${enc(transactionId)}`, { comment: text });
  if (!args.json) io.print(`Updated note on ledger row ${transactionId}.`);
  return transaction;
}

export async function voidLedger(args, io) {
  const usage = "dataops reconcile void-ledger <ledger-id> --period YYYY-MM --reason TEXT --duplicate-of <ledger-id> [--yes]";
  const transactionId = positional(args, 0, usage).replace(/^ledger:/, "");
  const period = periodOr(args);
  const duplicateOf = optionalString(args, "duplicateOf")?.replace(/^ledger:/, "");
  const reason = optionalString(args, "reason");
  if (!duplicateOf) throw new UsageError("--duplicate-of is required");
  if (!reason) throw new UsageError("--reason is required");
  const result = await monthPost(args, period, "void-ledger", { transactionId, reason, duplicateOf, confirm: Boolean(args.yes) });
  if (!args.json) io.print(`${result.voided ? "Voided" : "Dry run"} ledger row ${transactionId}${result.mode === "already-voided" ? " (already voided)" : ""}${result.mode === "dry-run" ? "; re-run with --yes to confirm" : "."}`);
  return result;
}

export async function restoreLedger(args, io) {
  const usage = "dataops reconcile restore-ledger <ledger-id> --period YYYY-MM --reason TEXT [--yes]";
  const transactionId = positional(args, 0, usage).replace(/^ledger:/, "");
  const period = periodOr(args);
  const reason = optionalString(args, "reason");
  if (!reason) throw new UsageError("--reason is required");
  const result = await monthPost(args, period, "restore-ledger", { transactionId, reason, confirm: Boolean(args.yes) });
  if (!args.json) io.print(`${result.restored ? "Restored" : "Dry run"} ledger row ${transactionId}${result.mode === "already-restored" ? " (already restored)" : ""}${result.mode === "dry-run" ? "; re-run with --yes to confirm" : "."}`);
  return result;
}

export async function createLedger(args, io) {
  const usage = "dataops reconcile create-ledger <bank-key> --period YYYY-MM [--category C] [--description D]";
  const bankKey = positional(args, 0, usage);
  const period = periodOr(args);
  const category = optionalString(args, "category"), description = optionalString(args, "description");
  const result = await monthPost(args, period, "ledger", { bankKey, ...(category ? { category } : {}), ...(description ? { description } : {}) });
  if (!args.json) {
    if (result.paired) io.print(`Bank row ${bankKey} is already paired with ledger row ${result.transaction.id}.`);
    else io.print(`${result.duplicate ? "Ledger row already existed" : "Created ledger row"} ${result.transaction.id} for bank row ${bankKey}.`);
  }
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
  for (const blocker of blockers.slice(0, 50)) io.print(`  ${blocker.date || ""} ${blocker.status || blocker.kind || ""} ${blocker.amount || ""} ${blocker.currency || ""} ${blocker.counterparty || blocker.rowId || blocker.id}${blocker.missing || blocker.reason ? ` — ${blocker.missing || blocker.reason}` : ""}`);
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

export async function disposition(args, io) {
  const usage = "dataops reconcile disposition <row-id> --period YYYY-MM --kind verified-unpaid|deferred --reason TEXT --evidence TEXT --digest SHA256 --version N [--target-period YYYY-MM]";
  const rowId = positional(args, 0, usage);
  const kind = optionalString(args, "kind"), reason = optionalString(args, "reason"), evidence = optionalString(args, "evidence");
  const rowDigest = optionalString(args, "digest"), rawVersion = optionalString(args, "version");
  if (!kind || !reason || !evidence || !rowDigest || rawVersion === undefined || !/^\d+$/.test(rawVersion)) throw new UsageError(usage);
  const targetPeriod = optionalString(args, "target-period");
  const result = await monthPost(args, periodOr(args), "invoice-disposition", { rowId, kind, reason, evidence, rowDigest, version: Number(rawVersion), ...(targetPeriod ? { targetPeriod } : {}) });
  if (!args.json) io.print(`Recorded ${kind} disposition for ${rowId}.`);
  return result;
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

async function downloadBytes(api, entry) {
  if (entry.invoiceId) {
    const signed = await api.get(`/api/bookkeeping/invoices/${enc(entry.invoiceId)}/document`);
    const response = await fetch(signed.url);
    if (!response.ok) throw new Error(`Download failed for ${entry.path} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  const route = entry.documentId ? `/api/bookkeeping/documents/${enc(entry.documentId)}/download` : `/api/artifacts/${enc(entry.artifactId)}/download`;
  const signed = await api.get(route);
  const response = await fetch(signed.downloadUrl);
  if (!response.ok) throw new Error(`Download failed for ${entry.path} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function validatePackageEntries(entries, period, outRoot) {
  if (!Array.isArray(entries)) throw new Error("Package manifest entries must be an array");
  const monthRoot = resolve(outRoot, period);
  return entries.map((entry) => {
    const manifestPath = entry?.path;
    if (typeof manifestPath !== "string" || !manifestPath || manifestPath.includes("\\") || manifestPath.includes("\0")
      || posix.isAbsolute(manifestPath) || win32.isAbsolute(manifestPath) || /^[A-Za-z]:/.test(manifestPath)) {
      throw new Error("Package manifest contains an invalid path");
    }
    const parts = manifestPath.split("/");
    if (parts[0] !== period || parts.length < 2 || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
      throw new Error(`Package manifest path must stay inside ${period}: ${manifestPath}`);
    }
    const target = resolve(outRoot, ...parts);
    const fromMonth = relative(monthRoot, target);
    if (!fromMonth || fromMonth === ".." || fromMonth.startsWith(`..${sep}`) || resolve(monthRoot, fromMonth) !== target) {
      throw new Error(`Package manifest path must stay inside ${period}: ${manifestPath}`);
    }
    return { entry, path: manifestPath, parts, target };
  });
}

async function assertNoSymlinkComponents(monthRoot, parts) {
  let current = monthRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Package output path contains a symlink: ${current}`);
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error(`Package output path component is not a directory: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function createPackageArchive(out, written, zipPath) {
  const { default: yazl } = await import("yazl");
  const archive = new yazl.ZipFile();
  const temporaryPath = `${zipPath}.${randomUUID()}.tmp`;
  const complete = pipeline(archive.outputStream, createWriteStream(temporaryPath, { flags: "wx" })).then(() => null, (error) => error);
  try {
    for (const path of written) archive.addFile(join(out, path), path.replaceAll("\\", "/"));
    archive.end();
    const error = await complete;
    if (error) throw error;
    await rename(temporaryPath, zipPath);
  } catch (error) {
    archive.outputStream.destroy(error);
    await complete;
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error(`Could not create package archive ${zipPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function packageMonth(args, io) {
  const usage = "dataops reconcile package YYYY-MM [--out DIR] [--draft] [--json]";
  const period = periodArg(args, usage);
  const api = apiFor(args);
  const manifest = await api.get(`/api/reconcile/months/${period}/package`, { query: args.draft ? { draft: "true" } : {} });
  if (manifest.reportPeriod !== period) throw new Error(`Package report month does not match selected report month ${period}`);
  if (manifest.blockers?.length) {
    const details = manifest.blockers.map((blocker) => `${blocker.rowId}: ${blocker.reason}`).join("; ");
    throw new Error(`Package is incomplete: ${manifest.blockers.length} blocker(s) prevent export. ${details}`);
  }
  const out = optionalString(args, "out") || ".";
  validatePackageEntries(manifest.entries, period, resolve(out));
  await mkdir(out, { recursive: true });
  const outRoot = await realpath(out);
  const planned = validatePackageEntries(manifest.entries, period, outRoot);
  const monthRoot = join(outRoot, period);
  await mkdir(monthRoot, { recursive: true });
  const monthInfo = await lstat(monthRoot);
  const realMonthRoot = await realpath(monthRoot);
  const monthFromOut = relative(outRoot, realMonthRoot);
  if (monthInfo.isSymbolicLink() || !monthFromOut || monthFromOut === ".." || monthFromOut.startsWith(`..${sep}`)) {
    throw new Error(`Package month directory must stay inside output directory: ${monthRoot}`);
  }
  for (const item of planned) await assertNoSymlinkComponents(monthRoot, item.parts.slice(1));
  const written = [];
  for (const { entry, path, parts, target: plannedTarget } of planned) {
    const target = resolve(outRoot, ...parts);
    if (target !== plannedTarget) throw new Error(`Package output path changed during validation: ${path}`);
    await assertNoSymlinkComponents(monthRoot, parts.slice(1, -1));
    await mkdir(dirname(target), { recursive: true });
    await assertNoSymlinkComponents(monthRoot, parts.slice(1));
    if (entry.kind === "report") await writeFile(target, manifest.csv);
    else if (entry.documentId || entry.artifactId || entry.invoiceId) await writeFile(target, await downloadBytes(api, entry));
    else continue;
    written.push(path);
  }
  let zip;
  const zipName = `datatalksclub-${period}${manifest.draft ? "-draft" : ""}.zip`;
  zip = join(out, zipName);
  await createPackageArchive(out, written, zip);
  if (!args.json) {
    io.print(`${manifest.draft ? "DRAFT package (month still open)" : "Package"} ${period}: ${written.length} files in ${join(out, period)}, ${zip}. Nothing was sent.`);
    for (const path of written) io.print(`  ${path}`);
  }
  return { ...manifest, written, ...(zip ? { zip } : {}) };
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
  upload, "import-document": importDocument, parse, balances, statements, statement, report, confirm, aliases, alias,
  month, months, matches, "auto-match": autoMatch, match, unmatch, "attach-proof": attachProof, "attach-doc": attachDoc, "void-ledger": voidLedger, "restore-ledger": restoreLedger, "create-ledger": createLedger, note,
  disposition, except, "clear-except": clearExcept, "confirm-exceptions": confirmExceptions, close, reopen, package: packageMonth, config,
};
