/**
 * Replays month reconciliation on past months from raw statement files and a
 * ledger export, and compares each month with the report that was sent.
 * Reads private finance data from paths given on the command line and
 * writes results there too; nothing touches DataOps or the repository.
 *
 *   npx tsx scripts/reconcile-backtest.ts \
 *     --statements ~/tmp/reconcile-samples/history --statements ~/tmp/reconcile-samples/prod-revolut-2026-10.csv \
 *     --ledger transactions.json --links links.json --truth ground-truth/ \
 *     --from 2024-01 --to 2026-09 --compare-from 2025-01 --out ~/tmp/reconcile-backtest
 *     [--rules private-rules.json] [--date-lag 10] [--fx-spread 0.03] [--fee-tolerance 2]
 */
import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { buildMonthTable, DEFAULT_TOLERANCES, pairAll, tableCsv, type ReconcileTolerances } from "../src/reconcile/month";
import { bankRowsFrom, DEFAULT_RULES, ledgerRowsFrom, periodsBetween } from "../src/reconcile/monthService";
import { recognizeStatement } from "../src/reconcile/statementIntake";
import type { StatementRecord } from "../src/reconcile/service";
import { backtestMonth, expectedSource, type MonthBacktest, type TruthRow } from "../src/reconcile/backtest";
import { documentName, packagePath, reportName, statementName, uniquePaths } from "../src/reconcile/naming";

function options(argv: string[]) {
  const values: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    (values[key] ||= []).push(argv[i + 1]);
    i++;
  }
  const one = (key: string, fallback?: string) => values[key]?.[0] ?? fallback;
  return { values, one };
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).sort().flatMap((name) => filesUnder(join(path, name)));
}

const CONTENT_TYPES: Record<string, string> = { ".pdf": "application/pdf", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

async function main() {
  const { values, one } = options(process.argv.slice(2));
  const out = one("out");
  if (!out || !values.statements || !one("ledger") || !one("from") || !one("to")) {
    throw new Error("usage: --statements PATH... --ledger transactions.json [--links links.json] [--truth DIR] --from YYYY-MM --to YYYY-MM [--compare-from YYYY-MM] --out DIR");
  }
  const tolerances: ReconcileTolerances = {
    dateLagDays: Number(one("date-lag", String(DEFAULT_TOLERANCES.dateLagDays))),
    fxSpreadPct: Number(one("fx-spread", String(DEFAULT_TOLERANCES.fxSpreadPct))),
    feeTolerance: Number(one("fee-tolerance", String(DEFAULT_TOLERANCES.feeTolerance))),
    namedFxSpreadPct: Number(one("named-fx-spread", String(DEFAULT_TOLERANCES.namedFxSpreadPct))),
    namedMismatchPct: Number(one("named-mismatch", String(DEFAULT_TOLERANCES.namedMismatchPct))),
  };
  // Rules naming people (owner withdrawals) live in the stored config, so they come from a private file here.
  const rules = one("rules") ? [...JSON.parse(readFileSync(one("rules")!, "utf8")), ...DEFAULT_RULES] : DEFAULT_RULES;
  mkdirSync(out, { recursive: true });

  // Statements: every file recognised by content; anything else is listed, not guessed.
  const records: StatementRecord[] = [];
  const statementFiles: Array<{ file: string; account: string; layout: string; months: string[]; rows: number; wallets: string[] }> = [];
  const refused: Array<{ file: string; reason: string }> = [];
  let order = 0;
  for (const file of values.statements.flatMap(filesUnder)) {
    const type = CONTENT_TYPES[extname(file).toLowerCase()];
    if (!type) continue;
    try {
      const { account, layout, parsed } = await recognizeStatement(readFileSync(file), type);
      const months = [...new Set(parsed.rows.map((row) => row.date.slice(0, 7)))].sort();
      records.push({
        id: createHash("sha256").update(file).digest("hex").slice(0, 32), recordType: "reconcile-statement", accountId: account, period: months.at(-1) || "",
        filename: basename(file), rows: parsed.rows, createdAt: new Date(Date.UTC(2000, 0, 1) + order++ * 1000).toISOString(), updatedAt: "",
      });
      statementFiles.push({ file, account, layout, months, rows: parsed.rows.length, wallets: [...new Set(parsed.rows.map((row) => row.wallet || "main"))] });
    } catch (error) {
      refused.push({ file, reason: (error as Error).message.slice(0, 200) });
    }
  }
  const bank = bankRowsFrom(records);

  const ledgerExport = JSON.parse(readFileSync(one("ledger")!, "utf8"));
  const linksExport = one("links") ? JSON.parse(readFileSync(one("links")!, "utf8")) : { items: [] };
  const ledger = ledgerRowsFrom(ledgerExport.items || ledgerExport, linksExport.items || linksExport);
  const decisions = { pairs: [], rejected: [], exceptions: {}, proofs: {} };
  const pairing = pairAll(bank, ledger, decisions, tolerances);

  const compareFrom = one("compare-from", one("from"))!;
  const truthDir = one("truth");
  const results: MonthBacktest[] = [];
  const runOnly: Array<{ period: string; counters: unknown }> = [];
  const noTruth: string[] = [];
  const nameMap: Array<{ period: string; old: string; new: string }> = [];

  for (const period of periodsBetween(one("from")!, one("to")!)) {
    const table = buildMonthTable({ period, bank, ledger, decisions, rules, tolerances, pairing });
    // The month package in the new layout: report, statements and the name every document would get.
    const packageDir = join(out, "packages");
    mkdirSync(join(packageDir, period), { recursive: true });
    writeFileSync(join(packageDir, period, reportName(period, "csv")), tableCsv(table));
    const manifest: string[] = [];
    for (const statement of statementFiles.filter((item) => item.months.includes(period))) {
      for (const wallet of statement.wallets) {
        const path = packagePath(period, "statements", statementName(period, statement.account, wallet, statement.file));
        manifest.push(path);
        mkdirSync(join(packageDir, period, "statements"), { recursive: true });
        if (!existsSync(join(packageDir, path))) copyFileSync(statement.file, join(packageDir, path));
      }
    }

    const truthFile = truthDir ? join(truthDir, `${period}.json`) : "";
    if (period < compareFrom || !truthFile || !existsSync(truthFile)) {
      if (period >= compareFrom) noTruth.push(period);
      runOnly.push({ period, counters: table.counters });
      writeFileSync(join(packageDir, period, "manifest.txt"), uniquePaths(manifest).join("\n") + "\n");
      continue;
    }
    const truthRaw = JSON.parse(readFileSync(truthFile, "utf8"));
    const truth: TruthRow[] = (Array.isArray(truthRaw) ? truthRaw : truthRaw.rows).map((row: Record<string, unknown>) => ({
      date: String(row.date || row.paidDate || ""),
      ...(row.paidDate ? { paidDate: String(row.paidDate) } : {}),
      counterparty: String(row.counterparty || ""),
      ...(row.description ? { description: String(row.description) } : {}),
      amount: Number(row.amount || 0),
      currency: String(row.currency || "EUR").toUpperCase(),
      amountEur: row.amountEur == null ? null : Number(row.amountEur),
      ...(row.entryType ? { entryType: String(row.entryType).toLowerCase() } : {}),
      ...(row.category ? { category: String(row.category) } : {}),
      ...(row.statementRef ? { statementRef: String(row.statementRef) } : {}),
      ...(row.docRef ? { docRef: String(row.docRef) } : {}),
    }));
    const result = backtestMonth(period, truth, table, ledger);
    results.push(result);
    const documentPaths: string[] = [];
    for (const row of truth) {
      if (!row.docRef) continue;
      const folder = expectedSource(row.statementRef) === "separate-proof" && /statement/i.test(row.docRef) ? "proofs" : row.entryType === "income" ? "income" : "expenses";
      const name = documentName({ date: row.paidDate || row.date, counterparty: row.counterparty, amount: row.amount, currency: row.currency, filename: row.docRef });
      documentPaths.push(packagePath(period, folder, name));
    }
    const unique = uniquePaths([...manifest, ...documentPaths]);
    writeFileSync(join(packageDir, period, "manifest.txt"), unique.join("\n") + "\n");
    truth.filter((row) => row.docRef).forEach((row, index) => nameMap.push({ period, old: row.docRef!, new: unique[manifest.length + index] }));
    writeFileSync(join(out, `${period}.json`), JSON.stringify(result, null, 1));
  }

  writeFileSync(join(out, "summary.json"), JSON.stringify({ tolerances, statementFiles: statementFiles.map(({ file, ...rest }) => ({ file: basename(file), ...rest })), refused, results: results.map(({ rows: _rows, onlyInOurs: _o, bankOnly: _b, calibration: _c, ...rest }) => rest), runOnly, noTruth }, null, 1));
  writeFileSync(join(out, "name-map.json"), JSON.stringify(nameMap, null, 1));
  writeFileSync(join(out, "calibration.json"), JSON.stringify({ dateLags: results.flatMap((result) => result.calibration.dateLags), fxSpreads: results.flatMap((result) => result.calibration.fxSpreads) }));

  const total = (key: keyof MonthBacktest["outcomes"]) => results.reduce((sum, result) => sum + result.outcomes[key], 0);
  const claimed = total("match") + total("wrong-account") + total("extra-pair");
  const expected = total("match") + total("wrong-account") + total("missed");
  console.log(JSON.stringify({
    months: results.length, runOnly: runOnly.length, noTruth, statementFiles: statementFiles.length, refused: refused.length, bankRows: bank.length, ledgerRows: ledger.length,
    outcomes: Object.fromEntries((["match", "wrong-account", "missed", "agree-no-bank", "extra-pair", "unverifiable", "only-in-report"] as const).map((key) => [key, total(key)])),
    precision: claimed ? Math.round((total("match") / claimed) * 1000) / 1000 : null,
    recall: expected ? Math.round((total("match") / expected) * 1000) / 1000 : null,
  }, null, 1));
}

main().catch((error) => { console.error(error); process.exit(1); });
