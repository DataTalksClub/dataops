import { UsageError } from "../errors.mjs";
import { fetchSheet, readSheetDir, planClassification, planSync } from "../bookkeepingSheet.mjs";
import { linkEvidence, storeDocument } from "../documentUpload.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Bookkeeping: sync from the spreadsheet, fill classification, read invoices";

export const help = `dataops bookkeeping - keep DataOps transactions in step with the bookkeeping sheet

Usage
  dataops bookkeeping show <transaction-id> [--json]
      Read all stored transaction fields, void state, audit history and
      document/evidence links. No writes.

  dataops bookkeeping set <transaction-id> [--category CATEGORY] [--subtype SUBTYPE]
      [--amount-eur AMOUNT --rate-source TEXT] [--apply]
      Set classification and/or the booked EUR amount on an existing row.
      Dry-run by default; --apply writes the row and records an audit entry.

  dataops bookkeeping sync --sheet <spreadsheet-id> [--apply]
  dataops bookkeeping sync <csv-dir> [--apply]
      Compare the bookkeeping sheet with DataOps transactions. Adds rows DataOps
      lacks and updates fields the sheet fills in differently. Never deletes, never
      clears a value the sheet leaves blank, never writes to the sheet.
      --sheet reads every tab through the Sheets API with the Google access token in
      DAPIER_ACCESS_TOKEN; <csv-dir> reads one <tab>.csv per tab instead.
  dataops bookkeeping classify [--since YYYY-MM-DD] [--apply]
      Fill a missing Type, Category or Period from the provider's other transactions
      when they all agree. Default --since 2025-01-01 (older tabs have no classification).

  dataops bookkeeping add-income --date YYYY-MM-DD --amount AMOUNT --currency CUR
      --counterparty NAME --reference REF --period YYYY-MM --category CATEGORY
      --comment TEXT [--apply]
      Add a non-sponsor income transaction such as an affiliate or platform payout.
      The reference is the idempotency key. Dry-run by default; --apply writes it.
  dataops bookkeeping add-income --type refund --date YYYY-MM-DD --amount AMOUNT
      --currency CUR --counterparty VENDOR --reference CREDIT-NOTE-NUMBER
      --comment TEXT [--category CATEGORY] [--document ID]... [--evidence FILE.pdf]...
      [--apply]
      Record a vendor refund or credit note credited to the vendor's balance without
      a bank transaction: a contra-expense expense row with subtype Refund and the key
      credit-note:<number>, the same classification the invoice intake uses, never a
      platform payout. --category defaults to Refund. --document links an already
      stored document as the row's evidence; --evidence uploads a PDF first. Both
      flags repeat, and relinking an already linked document does nothing.

  dataops bookkeeping facts [--retry] [--apply]
      Read each unattached invoice or receipt PDF that has not been read yet and keep
      its date, amount and provider, so the row details can suggest a match.
      --retry also re-reads documents an earlier run could not read.

  To void or restore a duplicate ledger row during month reconciliation (admin only):
  dataops reconcile void-ledger <ledger-id> --period YYYY-MM --reason TEXT --duplicate-of <ledger-id> [--yes]
  dataops reconcile restore-ledger <ledger-id> --period YYYY-MM --reason TEXT [--yes]

Bookkeeping writes print a dry run unless --apply is given. Reconciliation void
and restore print a dry run unless --yes is given. Run the preview first and read it.

Sanctioned sheet pull without a Google token in the environment (run from the
dapier checkout; the google-data-pull skill exports one <tab>.csv per tab):
  python3 .agents/skills/google-data-pull/gpull.py --agent admin-os \\
    --as "drive datatalks" drive sheet <spreadsheet-id> --out-dir <csv-dir>
  node <dataops>/cli/bin/dataops.mjs bookkeeping sync <csv-dir>
Keep any CSV export outside this repository: it is private finance data.
`;

async function transactions(api) {
  const result = await api.get("/api/bookkeeping/transactions");
  return Array.isArray(result?.items) ? result.items : [];
}

const label = (item) => `${item.tab}:${item.row}`;
const describe = (changes) =>
  Object.entries(changes)
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join(" ");

async function eachWithLimit(items, limit, work) {
  const queue = [...items];
  const failures = [];
  let done = 0;
  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        await work(item);
        done += 1;
      } catch (error) {
        failures.push({ item, error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
  return { done, failures };
}

async function sheetRows(args) {
  if (typeof args.sheet === "string" && args.sheet) {
    const token = process.env.DAPIER_ACCESS_TOKEN;
    if (!token) throw new UsageError('--sheet needs a Google access token in DAPIER_ACCESS_TOKEN. The sanctioned route with no token in the environment exports the sheet to CSVs with the dapier google-data-pull skill (gpull.py), then runs `bookkeeping sync <csv-dir>`.');
    return fetchSheet(args.sheet, token);
  }
  if (args._[0]) return readSheetDir(args._[0]);
  throw new UsageError("Pass --sheet <spreadsheet-id> or the directory holding a CSV export.");
}

export async function sync(args, io) {
  const rows = await sheetRows(args);
  const api = apiFor(args);
  const plan = planSync(rows, await transactions(api));
  const counts = {
    sheetRows: rows.filter((row) => row.record).length,
    create: plan.creates.length,
    update: plan.updates.length,
    locked: plan.locked.length,
    unchanged: plan.unchanged,
    orphans: plan.orphans.length,
    skipped: plan.skipped.length,
  };
  const result = { mode: args.apply ? "apply" : "dry-run", counts, plan };
  if (args.apply) {
    const created = await eachWithLimit(plan.creates, 4, (item) => api.post("/api/bookkeeping/transactions", item.record));
    const updated = await eachWithLimit(plan.updates, 4, (item) =>
      api.put(`/api/bookkeeping/transactions/${encodeURIComponent(item.id)}`, item.changes),
    );
    result.applied = { created: created.done, updated: updated.done };
    result.failures = [...created.failures, ...updated.failures].map(({ item, error }) => ({ row: label(item), error }));
  }
  if (!args.json) {
    if (!args.quiet) {
      for (const item of plan.creates) io.print(`create  ${label(item)}  ${item.record.transactionDate}  ${item.record.counterparty}  ${item.record.amount} ${item.record.currency}`);
      for (const item of plan.updates) io.print(`update  ${label(item)}  ${describe(item.changes)}`);
      for (const item of plan.locked) io.print(`locked  ${label(item)}  ${describe(item.changes)}  (sponsor deal ${item.sponsorDealId} holds this payment; not changed)`);
      for (const item of plan.orphans) io.print(`orphan  ${item.sourceKey}  ${item.transactionDate}  ${item.counterparty}  ${item.amount} ${item.currency}  (in DataOps, no longer in the sheet; left alone)`);
      for (const item of plan.skipped) io.print(`skip    ${label(item)}  ${item.skip}`);
    }
    io.print(`${result.mode}: ${Object.entries(counts).map(([name, value]) => `${name} ${value}`).join(", ")}`);
    if (result.applied) io.print(`applied: created ${result.applied.created}, updated ${result.applied.updated}, failed ${result.failures.length}`);
    for (const failure of result.failures || []) io.print(`failed  ${failure.row}  ${failure.error}`);
  }
  if (result.failures?.length) throw new Error(`${result.failures.length} sheet rows could not be written; rerun to retry.`);
  return result;
}

export async function classify(args, io) {
  const since = args.since === undefined ? "2025-01-01" : String(args.since);
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UsageError("--since takes YYYY-MM-DD (or an empty value for all years).");
  const api = apiFor(args);
  const plan = planClassification(await transactions(api), { since });
  const result = { mode: args.apply ? "apply" : "dry-run", counts: { fill: plan.fills.length, locked: plan.locked.length, unresolved: plan.unresolved.length }, plan };
  if (args.apply) {
    const applied = await eachWithLimit(plan.fills, 4, (item) =>
      api.put(`/api/bookkeeping/transactions/${encodeURIComponent(item.id)}`, item.changes),
    );
    result.applied = { updated: applied.done };
    result.failures = applied.failures.map(({ item, error }) => ({ id: item.id, error }));
  }
  if (!args.json) {
    if (!args.quiet) {
      for (const item of plan.fills) io.print(`fill  ${item.transactionDate}  ${item.counterparty}  ${describe(item.changes)}`);
      for (const item of plan.unresolved) io.print(`open  ${item.transactionDate}  ${item.counterparty}  (no agreeing history)`);
    }
    io.print(`${result.mode}: fill ${plan.fills.length}, locked ${plan.locked.length} (sponsor payments), unresolved ${plan.unresolved.length}`);
    if (result.applied) io.print(`applied: updated ${result.applied.updated}, failed ${result.failures.length}`);
  }
  if (result.failures?.length) throw new Error(`${result.failures.length} transactions could not be classified; rerun to retry.`);
  return result;
}

export async function facts(args, io) {
  const api = apiFor(args);
  const listed = await api.get("/api/bookkeeping/documents");
  const pending = (Array.isArray(listed?.items) ? listed.items : []).filter(
    (document) =>
      document.status === "active" &&
      ["invoice", "receipt"].includes(document.documentType) &&
      !Number(document.linkRefCount || 0) &&
      (!document.facts || (args.retry && document.facts.method === "unreadable")),
  );
  const result = { mode: args.apply ? "apply" : "dry-run", counts: { unread: pending.length } };
  if (args.apply) {
    const methods = {};
    const applied = await eachWithLimit(pending, 2, async (document) => {
      const read = await api.post(`/api/bookkeeping/documents/${encodeURIComponent(document.id)}/facts`, {});
      const method = read?.facts?.method || "unknown";
      methods[method] = (methods[method] || 0) + 1;
    });
    result.applied = { read: applied.done, methods };
    result.failures = applied.failures.map(({ item, error }) => ({ id: item.id, error }));
  }
  if (!args.json) {
    io.print(`${result.mode}: ${pending.length} unattached invoices or receipts not read yet`);
    if (result.applied)
      io.print(`applied: read ${result.applied.read} (${Object.entries(result.applied.methods).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}), failed ${result.failures.length}`);
  }
  if (result.failures?.length) throw new Error(`${result.failures.length} documents could not be read; rerun to retry.`);
  return result;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const AMOUNT = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Za-z]{3}$/;

function incomeText(args, name, max = 300) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UsageError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be at most ${max} characters.`);
  return trimmed;
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function incomeAmount(args) {
  const rawAmount = incomeText(args, "amount", 20);
  const amountParts = rawAmount.match(AMOUNT);
  if (!amountParts || (amountParts[1] === "0" && !Number(amountParts[2] || 0)))
    throw new UsageError("--amount must be a positive amount with up to two decimal places.");
  return `${amountParts[1]}.${(amountParts[2] || "").padEnd(2, "0")}`;
}

function platformIncomeRecord(args) {
  const date = incomeText(args, "date", 10);
  if (!validDate(date)) throw new UsageError("--date must be a real date in YYYY-MM-DD format.");
  const amount = incomeAmount(args);
  const currency = incomeText(args, "currency", 3).toUpperCase();
  if (!CURRENCY.test(currency)) throw new UsageError("--currency must be a 3-letter ISO code.");
  const counterparty = incomeText(args, "counterparty");
  const reference = incomeText(args, "reference", 280);
  const incomePeriod = incomeText(args, "period", 7);
  if (!MONTH.test(incomePeriod)) throw new UsageError("--period must be YYYY-MM.");
  const category = incomeText(args, "category");
  const comment = incomeText(args, "comment", 2000);
  return {
    transactionDate: date,
    counterparty,
    description: comment.slice(0, 300),
    amount,
    currency,
    entryType: "income",
    statementRef: reference,
    comment,
    incomePeriod,
    category,
    sourceType: "platform-payout",
    sourceKey: `platform-payout:${reference}`,
  };
}

function creditNoteRecord(args) {
  const date = incomeText(args, "date", 10);
  if (!validDate(date)) throw new UsageError("--date must be a real date in YYYY-MM-DD format.");
  const amount = incomeAmount(args);
  const currency = incomeText(args, "currency", 3).toUpperCase();
  if (!CURRENCY.test(currency)) throw new UsageError("--currency must be a 3-letter ISO code.");
  const counterparty = incomeText(args, "counterparty");
  const number = incomeText(args, "reference", 280);
  const category = args.category === undefined ? "Refund" : incomeText(args, "category");
  const comment = incomeText(args, "comment", 2000);
  return {
    transactionDate: date,
    counterparty,
    description: comment.slice(0, 300),
    amount,
    currency,
    entryType: "expense",
    subtype: "Refund",
    statementRef: number,
    comment,
    category,
    sourceType: "credit-note",
    sourceKey: `credit-note:${number}`,
  };
}

const INCOME_IDENTITY_FIELDS = [
  "transactionDate", "counterparty", "description", "amount", "currency", "entryType",
  "statementRef", "comment", "incomePeriod", "category", "sourceType", "sourceKey",
];

function checkIncomeIdentity(existing, expected, reference, kind) {
  const fields = expected.sourceType === "credit-note" ? [...INCOME_IDENTITY_FIELDS, "subtype"] : INCOME_IDENTITY_FIELDS;
  const differences = fields.filter((field) => existing[field] !== expected[field]);
  if (differences.length) {
    throw new UsageError(`Reference ${reference} already belongs to a ${kind} with different details (${differences.join(", ")}); existing row ${existing.id} was left unchanged.`);
  }
}

function repeatable(args, name) {
  const value = args[name];
  if (value === undefined) return [];
  const listed = Array.isArray(value) ? value : [value];
  const cleaned = listed.map((item) => String(item).trim()).filter(Boolean);
  if (cleaned.length !== listed.length) throw new UsageError(`--${name} takes a non-empty value.`);
  return cleaned;
}

export async function addIncome(args, io) {
  const type = args.type === undefined ? "platform-payout" : String(args.type);
  if (!["platform-payout", "refund"].includes(type))
    throw new UsageError("--type must be platform-payout or refund.");
  if (type === "refund" && args.period !== undefined)
    throw new UsageError("--period only applies to platform payouts; a credit note is booked on its date.");
  const kind = type === "refund" ? "credit note" : "platform payout";
  const transaction = type === "refund" ? creditNoteRecord(args) : platformIncomeRecord(args);
  const reference = transaction.statementRef;
  const documents = repeatable(args, "document");
  const evidenceFiles = repeatable(args, "evidence");
  const api = apiFor(args);
  const rows = await transactions(api);
  const existing = rows.find((item) => item.sourceKey === transaction.sourceKey);
  if (existing) checkIncomeIdentity(existing, transaction, reference, kind);
  let result;
  if (existing) {
    result = { mode: args.apply ? "apply" : "dry-run", outcome: "existing", transaction: existing };
  } else if (args.apply) {
    const saved = await api.post("/api/bookkeeping/transactions", transaction);
    checkIncomeIdentity(saved, transaction, reference, kind);
    result = { mode: "apply", outcome: "created", transaction: saved };
  } else {
    result = { mode: "dry-run", outcome: "would-create", transaction };
  }
  if (args.apply) {
    const uploaded = [];
    for (const file of evidenceFiles)
      uploaded.push(await storeDocument(api, file, { documentType: "other-evidence", sourceRef: transaction.sourceKey.slice(0, 160) }));
    const documentIds = [...documents, ...uploaded.map((store) => store.documentId)];
    if (documentIds.length) {
      const linked = await linkEvidence(api, result.transaction.id, documentIds);
      result.documents = [
        ...uploaded.map(({ documentId, reused }) => ({ documentId, linked: true, uploaded: !reused })),
        ...linked.filter(({ documentId }) => !uploaded.some((store) => store.documentId === documentId)).map(({ documentId, outcome }) => ({ documentId, linked: outcome !== "existing" })),
      ];
    }
  } else if (documents.length || evidenceFiles.length) {
    result.documents = [
      ...documents.map((documentId) => ({ documentId })),
      ...evidenceFiles.map((file) => ({ file })),
    ];
  }
  if (!args.json) {
    const item = result.transaction;
    io.print(`${result.mode}: ${result.outcome} ${kind} ${item.transactionDate}  ${item.amount} ${item.currency}  ${item.counterparty}  ${type === "refund" ? "number" : "reference"} ${reference}${item.addedAt ? `  added ${item.addedAt}` : ""}`);
    for (const document of result.documents || []) {
      const state = args.apply ? (document.linked ? "linked" : "already linked") : "would link";
      io.print(`  ${state} ${document.file ? `${document.file} as ` : ""}document ${document.documentId || "(dry run: upload first)"}`);
    }
  }
  return result;
}

export async function show(args, io) {
  if (args._.length !== 1 || !String(args._[0]).trim())
    throw new UsageError("Usage: dataops bookkeeping show <transaction-id> [--json]");
  const api = apiFor(args);
  const transaction = await api.get(`/api/bookkeeping/transactions/${encodeURIComponent(args._[0])}`);
  const linked = await api.get("/api/bookkeeping/links");
  const result = { ...transaction, links: linked.items.filter((link) => link.transactionId === transaction.id) };
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function set(args, io) {
  if (args._.length !== 1 || !String(args._[0]).trim())
    throw new UsageError("Usage: dataops bookkeeping set <transaction-id> [--category CATEGORY] [--subtype SUBTYPE] [--amount-eur AMOUNT --rate-source TEXT] [--apply]");
  const changes = {};
  for (const name of ["category", "subtype", "rateSource"]) {
    if (args[name] !== undefined) {
      const value = String(args[name]).trim();
      if (!value || value.length > 300) throw new UsageError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} needs a non-empty value up to 300 characters.`);
      changes[name] = value;
    }
  }
  if (args.amountEur !== undefined) {
    const amount = String(args.amountEur).trim();
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(amount) || Number(amount) <= 0)
      throw new UsageError("--amount-eur must be a positive decimal amount with up to four decimal places.");
    const decimalPlaces = amount.split(".")[1]?.length || 0;
    changes.amountEur = decimalPlaces > 2
      ? Number(amount).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
      : Number(amount).toFixed(2);
  }
  if (changes.rateSource && !changes.amountEur)
    throw new UsageError("--rate-source requires --amount-eur.");
  if (!Object.keys(changes).length)
    throw new UsageError("Pass at least one of --category, --subtype or --amount-eur.");

  const api = apiFor(args);
  const transaction = await api.get(`/api/bookkeeping/transactions/${encodeURIComponent(args._[0])}`);
  const result = {
    mode: args.apply ? "apply" : "dry-run",
    transactionId: transaction.id,
    changes,
    previous: Object.fromEntries(Object.keys(changes).map((field) => [field, transaction[field] ?? null])),
  };
  if (args.apply) {
    if (transaction.sourceType === "sponsor-receipt" && changes.amountEur) {
      if (changes.category || changes.subtype)
        throw new UsageError("Sponsor receipt conversion updates only accept --amount-eur and --rate-source.");
      result.transaction = await api.put(
        `/api/sponsor-crm/finance/receipts/${encodeURIComponent(transaction.id)}/conversion`,
        { amountEur: changes.amountEur, rateSource: changes.rateSource },
      );
    } else {
      result.transaction = await api.put(`/api/bookkeeping/transactions/${encodeURIComponent(transaction.id)}`, changes);
    }
  }
  if (!args.json) {
    io.print(`${result.mode}: ${args.apply ? "updated" : "would update"} ${transaction.id}  ${describe(changes)}`);
  }
  return result;
}

export const commands = { show, set, sync, classify, facts, "add-income": addIncome };
