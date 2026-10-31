import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { attachThankYouResult, printThankYouHint } from "../thank-you.mjs";

export const summary = "Month-end reconciliation: bank statements, matching, payment confirm";

export const help = `dataops reconcile - month-end reconciliation (the Finance views' command line)

Usage
  dataops reconcile upload --file statement.(csv|pdf|xlsx) --account revolut|finom|mercury|merchant --period YYYY-MM [--currency EUR] [--json]
      Stores the raw statement as a verified private bank-statement document,
      parses its rows server-side and saves them for matching. Re-uploading the
      same file for the same account and period replaces the stored rows;
      rows that overlap another statement of the same account (a year export
      next to a month export) are counted once in the report.
      --currency sets the currency of a file without a currency column
      (Finom exports default to EUR). The closing balance of each wallet is
      stored with its as-of date.
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

export async function upload(args, io) {
  const usage = "dataops reconcile upload --file statement.(csv|pdf|xlsx) --account revolut|finom|mercury|merchant --period YYYY-MM [--currency EUR] [--json]";
  if (!args.file) throw new UsageError(usage);
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
  const saved = await api.post("/api/reconcile/statements", {
    account, period, documentId,
    ...(parsed.filename ? { filename: parsed.filename } : {}),
    contentType: parsed.contentType,
    rows: parsed.rows,
    ...(parsed.balances?.length ? { balances: parsed.balances } : {}),
    ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}),
  });
  const statement = saved.statement;
  if (!args.json) {
    io.print(`${prepared.outcome === "existing" ? "Reused" : "Stored"} document ${documentId} (sha256 ${sha256.slice(0, 12)}…).`);
    io.print(`Statement ${statement.id}: ${statement.rows.length} rows, ${parsed.incomingCount} incoming, incoming total ${parsed.incomingTotal} across ${account}.`);
    for (const balance of parsed.balances || []) io.print(`balance ${balance.wallet ? `${balance.wallet} ` : ""}${balance.amount} ${balance.currency} as of ${balance.asOf}`);
    for (const warning of (parsed.warnings || []).slice(0, 5)) io.print(`warning: ${warning}`);
    if ((parsed.warnings || []).length > 5) io.print(`… and ${parsed.warnings.length - 5} more warnings (dataops reconcile statement ${statement.id} --json)`);
    io.print(`Next: dataops reconcile report --period ${period}`);
  }
  return { documentId, statement, parsed };
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

export const commands = { upload, balances, statements, statement, report, confirm, aliases, alias };
