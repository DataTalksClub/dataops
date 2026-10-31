import { readFileSync } from "node:fs";

import { UsageError } from "../errors.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Money in, money out, net profit and VAT position per month, year or YTD";

export const help = `dataops finance - the books at a glance (the web Finance > Overview view)

Usage
  dataops finance summary --month 2026-10 [--json]
  dataops finance summary --year 2026 [--json]
  dataops finance summary --ytd [--json]
      Money in, money out and net in EUR, net profit excluding VAT, the projected
      VAT position, and taxes and TK on their own lines. Non-EUR amounts show the
      original currency, the rate, its date and its source (booked by the bank,
      or the ECB reference rate). Data gaps are listed under the table.

  dataops finance upcoming [--days 60] [--json]
      Tax and TK auto-debits due in the next N days (default 60): date (moved past
      weekends and Berlin holidays), amount, tax type and source (Bescheid, USt-VA,
      recurring), paid once the ledger or a statement shows it. Totals the next 30
      days against the latest business account balance and flags a shortfall.
  dataops finance schedule [--json]
  dataops finance schedule set <id> --file entry.json [--expected-version N]
      The schedule the debits come from. Replace an entry when a new Bescheid or
      USt-VA arrives; --expected-version is the version you read (omit to create).

For summary: exactly one of --month, --year or --ytd. --json prints the same numbers the
portal shows, as returned by GET /api/finance/summary. How rows are chosen,
deduplicated and converted: docs/finance-summary.md.
`;

const money = (value) =>
  value === null || value === undefined
    ? "-"
    : (Math.round(Number(value) * 100) / 100 || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Columns of [header, (row) => value, align]; numbers right-aligned. */
function grid(io, rows, columns) {
  const cells = rows.map((row) => columns.map(([, value]) => String(value(row) ?? "")));
  const widths = columns.map(([header], i) => Math.max(header.length, ...cells.map((line) => line[i].length)));
  const render = (values) =>
    values.map((value, i) => (columns[i][2] === "right" ? value.padStart(widths[i]) : value.padEnd(widths[i]))).join("  ").trimEnd();
  io.print(render(columns.map(([header]) => header)));
  for (const line of cells) io.print(render(line));
}

function periodArgs(args) {
  const given = ["month", "year", "ytd"].filter((name) => args[name] !== undefined && args[name] !== false);
  if (given.length !== 1) throw new UsageError("Give exactly one of --month YYYY-MM, --year YYYY or --ytd.");
  if (args.month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(args.month))) throw new UsageError("--month takes YYYY-MM, e.g. --month 2026-10.");
    return { month: String(args.month) };
  }
  if (args.year !== undefined) {
    if (!/^\d{4}$/.test(String(args.year))) throw new UsageError("--year takes YYYY, e.g. --year 2026.");
    return { year: String(args.year) };
  }
  return { ytd: "1" };
}

const vatWord = (value) => (value > 0 ? "owed to the Finanzamt" : value < 0 ? "refund from the Finanzamt" : "nothing owed");

export function printSummary(io, s) {
  const t = s.totals;
  io.print(`Finance summary ${s.period.label} (EUR)`);
  io.print("");
  io.print(`Net profit excluding VAT:  ${money(t.netProfitExVat)}`);
  io.print(`Projected VAT position:    ${money(t.projectedVat)} (${vatWord(t.projectedVat)})${t.vatUnknownCount ? `  ! ${t.vatUnknownCount} rows have no VAT amount` : ""}`);
  io.print("");
  const rows = s.months.length > 1 ? [...s.months, { month: "Total", ...t }] : s.months;
  grid(io, rows, [
    ["Month", (r) => (r.future ? `${r.month} *` : r.month)],
    ["Money in", (r) => money(r.moneyIn), "right"],
    ["Money out", (r) => money(r.moneyOut), "right"],
    ["Net", (r) => money(r.net), "right"],
    ["Profit ex VAT", (r) => money(r.netProfitExVat), "right"],
    ["Taxes", (r) => money(r.otherTaxes), "right"],
    ["TK", (r) => money(r.healthInsurance), "right"],
    ["VAT position", (r) => money(r.projectedVat), "right"],
    ["VAT paid", (r) => money(r.vatPaid - r.vatRefunded), "right"],
  ]);
  if (s.months.some((m) => m.future)) io.print("* not over yet");
  io.print("");
  grid(io, [
    ["Income net of VAT", t.incomeNetOfVat],
    ["Refunds from suppliers, net of VAT", t.refundsNetOfVat],
    ["Expenses net of VAT", -t.expensesNetOfVat],
    ["Net profit excluding VAT", t.netProfitExVat],
    ["Other taxes (Gewerbesteuer, prepayments)", -t.otherTaxes],
    ["Health insurance (TK)", -t.healthInsurance],
    ["Net after taxes and TK", t.netAfterTaxes],
    ["Output VAT", t.outputVat],
    ["Input VAT", -t.inputVat],
    ["VAT paid to / refunded by the Finanzamt", -(t.vatPaid - t.vatRefunded)],
  ], [["Line", (r) => r[0]], ["EUR", (r) => money(r[1]), "right"]]);
  if (s.byCurrency.length) {
    io.print("");
    grid(io, s.byCurrency, [
      ["Currency", (r) => r.currency],
      ["In (original)", (r) => money(r.moneyIn), "right"],
      ["In (EUR)", (r) => money(r.moneyInEur), "right"],
      ["Out (original)", (r) => money(r.moneyOut), "right"],
      ["Out (EUR)", (r) => money(r.moneyOutEur), "right"],
    ]);
  }
  if (s.conversions.length) {
    io.print("");
    io.print("Conversions");
    grid(io, s.conversions, [
      ["Date", (r) => r.date],
      ["Amount", (r) => `${money(r.amount)} ${r.currency}`, "right"],
      ["EUR", (r) => money(r.eur), "right"],
      ["Rate (per EUR)", (r) => (r.rate ? String(r.rate) : "-"), "right"],
      ["Rate date", (r) => r.rateDate || "-"],
      ["Source", (r) => ({ booked: "booked by bank", ecb: "ECB reference" })[r.rateSource] || "none"],
    ]);
  }
  const notes = [
    ...s.gaps.map((g) => `${g.month ? `${g.month}: ` : ""}${g.message} (${g.count})`),
    ...(s.duplicates.length ? [`Sheet rows dropped as duplicates of invoice/receipt rows (${s.duplicates.length})`] : []),
    ...(s.rateErrors || []).map((e) => `Exchange rate lookup failed: ${e}`),
  ];
  if (notes.length) {
    io.print("");
    io.print("Data gaps");
    for (const note of notes) io.print(`  - ${note}`);
  }
  io.print("");
  io.print(`${t.entryCount} ledger rows. Source rules: dataops finance summary --json | jq .rules`);
}

export async function summaryCommand(args, io) {
  const result = await apiFor(args).get("/api/finance/summary", { query: periodArgs(args) });
  if (args.json) return result;
  printSummary(io, result);
}

const TAX_TYPE = { "income-tax": "Income tax + Soli", "trade-tax": "Trade tax", vat: "VAT", "health-insurance": "Health insurance", other: "Other" };

export function printUpcoming(io, u) {
  io.print(`Upcoming tax debits ${u.today} to ${u.to} (EUR)`);
  io.print("");
  grid(io, u.debits, [
    ["Date", (d) => `${d.date}${d.approximate ? " ~" : ""}`],
    ["Amount", (d) => money(d.amount), "right"],
    ["Tax type", (d) => TAX_TYPE[d.taxType] || d.taxType],
    ["What", (d) => d.label],
    ["Source", (d) => (d.sourceRef ? `${d.source} ${d.sourceRef}` : d.source)],
    ["Status", (d) => (d.status === "paid" ? `paid (${d.matched.kind} ${d.matched.date})` : d.status)],
  ]);
  if (!u.debits.length) io.print("No scheduled debits in this window.");
  const shifted = u.debits.filter((d) => d.shifted);
  if (shifted.length || u.debits.some((d) => d.approximate)) io.print("");
  for (const d of shifted) io.print(`  ${d.date}: ${d.label} moved, ${d.shifted}`);
  if (u.debits.some((d) => d.approximate)) io.print("  ~ collected around this day, not on a fixed date");
  io.print("");
  io.print(`Due in the next 30 days:  ${money(u.dueNext30)}`);
  io.print(`Due in the next ${u.days} days:  ${money(u.dueInWindow)}`);
  io.print(u.balance
    ? `Balance (${u.balance.accountId}, as of ${u.balance.asOf}):  ${money(u.balance.amount)} ${u.balance.currency}${u.shortfall ? "  ! SHORTFALL" : "  covers the next 30 days"}${u.balance.stale ? "  (stale)" : ""}`
    : "Balance: unknown");
  if (u.warnings.length) {
    io.print("");
    io.print("Warnings");
    for (const w of u.warnings) io.print(`  - ${w}`);
  }
}

export async function upcomingCommand(args, io) {
  const days = args.days === undefined ? 60 : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new UsageError("--days takes a whole number from 1 to 366.");
  const result = await apiFor(args).get("/api/finance/upcoming", { query: { days: String(days) } });
  if (args.json) return result;
  printUpcoming(io, result);
}

export async function scheduleCommand(args, io) {
  const api = apiFor(args);
  if (args._[0] === "set") {
    const id = args._[1];
    if (!id || typeof args.file !== "string") throw new UsageError("dataops finance schedule set <id> --file entry.json [--expected-version N]");
    let entry;
    try { entry = JSON.parse(readFileSync(args.file, "utf8")); } catch (error) { throw new UsageError(`Cannot read ${args.file}: ${error.message}`); }
    if (args.expectedVersion !== undefined) entry.expectedVersion = Number(args.expectedVersion);
    const saved = await api.put(`/api/finance/tax-schedule/${encodeURIComponent(id)}`, entry);
    if (args.json) return saved;
    io.print(`Saved ${saved.id} version ${saved.version}: ${saved.label}, ${money(saved.amount)} EUR`);
    return;
  }
  if (args._.length) throw new UsageError(`Unknown schedule action ${args._[0]}. Use: dataops finance schedule [set <id> --file entry.json]`);
  const { items } = await api.get("/api/finance/tax-schedule");
  if (args.json) return { items };
  const when = (r) => (r.kind === "once" ? r.date : r.kind === "monthly" ? `monthly on the ${r.day}th` : `day ${r.day} of months ${r.months.join("/")}`);
  grid(io, items, [
    ["Id", (e) => e.id],
    ["What", (e) => e.label],
    ["Amount", (e) => money(e.amount), "right"],
    ["When", (e) => when(e.rule)],
    ["Source", (e) => e.source],
    ["Valid", (e) => `${e.validFrom || "…"} to ${e.validUntil || "…"}`],
    ["Version", (e) => String(e.version)],
  ]);
}

export const commands = { summary: summaryCommand, upcoming: upcomingCommand, schedule: scheduleCommand };
