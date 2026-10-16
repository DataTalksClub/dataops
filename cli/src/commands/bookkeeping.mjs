import { UsageError } from "../errors.mjs";
import { fetchSheet, readSheetDir, planClassification, planSync } from "../bookkeepingSheet.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Bookkeeping: sync from the spreadsheet, fill classification";

export const help = `dataops bookkeeping - keep DataOps transactions in step with the bookkeeping sheet

Usage
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

Both print a dry run unless --apply is given. Run the dry run first and read it.

Dapier hands the Google token to the command (run from the dapier checkout):
  uv run dapier token exec drive <account> --agent admin-os -- \\
    node <dataops>/cli/bin/dataops.mjs bookkeeping sync --sheet <spreadsheet-id>
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
    if (!token) throw new UsageError("--sheet needs a Google access token in DAPIER_ACCESS_TOKEN: run the command under `dapier token exec drive <account>`.");
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
  const result = { mode: args.apply ? "apply" : "dry-run", counts: { fill: plan.fills.length, unresolved: plan.unresolved.length }, plan };
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
    io.print(`${result.mode}: fill ${plan.fills.length}, unresolved ${plan.unresolved.length}`);
    if (result.applied) io.print(`applied: updated ${result.applied.updated}, failed ${result.failures.length}`);
  }
  if (result.failures?.length) throw new Error(`${result.failures.length} transactions could not be classified; rerun to retry.`);
  return result;
}

export const commands = { sync, classify };
