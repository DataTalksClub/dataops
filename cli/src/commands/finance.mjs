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
      VAT position, and taxes and TK on their own lines. Non-EUR currency rows
      show each original amount and its EUR value inline, plus the rate, date and
      source when available (booked by the bank or the ECB reference rate).
      Owner pay (salary, draw, reimbursement) has its own line below net profit.
      Data gaps are listed under the table.

  dataops finance taxes --month 2026-10 | --year 2026 | --ytd [--json]
      The tax ledger: VAT (projected output minus input VAT next to what was
      actually paid to or refunded by the Finanzamt, and what is outstanding),
      other taxes by type (income tax + Soli, trade tax, other) and TK health
      insurance, per month and for the period. Table by default.

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
const rateSource = (source) => ({ booked: "booked by bank", ecb: "ECB reference" })[source] || "";

function currencyRowLabel(currency, entries) {
  const details = entries
    .filter((entry) => entry.currency === currency && entry.currency !== "EUR")
    .map((entry) => {
      const eur = entry.eur === null ? "not converted" : `${money(entry.eur)} EUR`;
      const rate = entry.rate ? ` @ ${entry.rate} per EUR` : "";
      const sourceDate = [rateSource(entry.rateSource), entry.rateDate].filter(Boolean).join(" ");
      return `${entry.date}: ${entry.counterparty ? `${entry.counterparty}: ` : ""}${money(entry.amount)} ${entry.currency} → ${eur}${rate}${sourceDate ? ` (${sourceDate})` : ""}`;
    });
  return details.length ? `${currency} — ${details.join("; ")}` : currency;
}

export function printSummary(io, s) {
  const t = s.totals;
  io.print(`Finance summary ${s.period.label} (EUR)`);
  io.print("");
  io.print(`Net profit excluding VAT:  ${money(t.netProfitExVat)}`);
  io.print(`Projected VAT position:    ${money(t.projectedVat)} (${vatWord(t.projectedVat)})`);
  io.print("");
  const rows = s.months.length > 1 ? [...s.months, { month: "Total", ...t }] : s.months;
  grid(io, rows, [
    ["Month", (r) => (r.future ? `${r.month} *` : r.month)],
    ["Money in", (r) => money(r.moneyIn), "right"],
    ["Money out", (r) => money(r.moneyOut), "right"],
    ["Net", (r) => money(r.net), "right"],
    ["Profit ex VAT", (r) => money(r.netProfitExVat), "right"],
    ["ESt+Soli", (r) => money(r.incomeTax), "right"],
    ["GewSt", (r) => money(r.tradeTax), "right"],
    ["TK", (r) => money(r.healthInsurance), "right"],
    ["Taxes total", (r) => money(r.taxesTotal), "right"],
    ["Tax refunds", (r) => money(r.taxRefunds), "right"],
    ["Owner pay", (r) => money(r.ownerPay || 0), "right"],
    ["VAT position", (r) => money(r.projectedVat), "right"],
    ["VAT paid", (r) => money(r.vatPaid - r.vatRefunded), "right"],
  ]);
  if (s.months.some((m) => m.future)) io.print("* not over yet");
  io.print("");
  grid(io, [
    ["Income net of VAT", t.incomeNetOfVat],
    ["Expenses net of VAT", -t.expensesNetOfVat],
    ["Net profit excluding VAT", t.netProfitExVat],
    ["Einkommensteuer + Soli", -t.incomeTax],
    ["Gewerbesteuer", -t.tradeTax],
    ["Other taxes", -t.otherTaxes],
    ["Health insurance (TK)", -t.healthInsurance],
    ["Taxes and TK paid", -t.taxesTotal],
    ["Net after taxes and TK", t.netAfterTaxes],
    ["Tax refunds received (cash, not a negative tax)", t.taxRefunds],
    ["Owner pay (below net profit)", -(t.ownerPay || 0)],
    ["Net after owner pay", t.netAfterOwnerPay ?? t.netAfterTaxes],
    ["Output VAT", t.outputVat],
    ["Input VAT", -t.inputVat],
    ["VAT paid to / refunded by the Finanzamt", -(t.vatPaid - t.vatRefunded)],
  ], [["Line", (r) => r[0]], ["EUR", (r) => money(r[1]), "right"]]);
  if (s.taxRefunds.length) {
    io.print("");
    io.print("Tax refunds (money in; not revenue, not a negative tax)");
    for (const r of s.taxRefunds) io.print(`  ${r.date}  ${money(r.eur)}  ${r.id}  ${r.counterparty}`);
  }
  if (s.byCurrency.length) {
    io.print("");
    grid(io, s.byCurrency, [
      ["Currency", (r) => currencyRowLabel(r.currency, s.entries)],
      ["In (original)", (r) => money(r.moneyIn), "right"],
      ["In (EUR)", (r) => money(r.moneyInEur), "right"],
      ["Out (original)", (r) => money(r.moneyOut), "right"],
      ["Out (EUR)", (r) => money(r.moneyOutEur), "right"],
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

export function printTaxes(io, r) {
  const t = r.totals;
  io.print(`Tax ledger ${r.period.label} (EUR)${r.open ? " - period still open, VAT is a projection" : ""}`);
  io.print("");
  io.print(`Net profit excluding VAT:  ${money(r.netProfitExVat)}`);
  io.print(`Projected VAT position:    ${money(t.projectedVat)} (${vatWord(t.projectedVat)})`);
  io.print(`VAT actually ${t.vatSettled < 0 ? "refunded" : "paid"}:      ${money(Math.abs(t.vatSettled))}   outstanding: ${money(t.vatOutstanding)}`);
  io.print("");
  const rows = r.months.length > 1 ? [...r.months, { month: "Total", ...t }] : r.months;
  grid(io, rows, [
    ["Month", (m) => (m.future ? `${m.month} *` : m.month)],
    ["Output VAT", (m) => money(m.outputVat), "right"],
    ["Input VAT", (m) => money(m.inputVat), "right"],
    ["VAT projected", (m) => money(m.projectedVat), "right"],
    ["VAT paid", (m) => money(m.vatPaid), "right"],
    ["VAT refunded", (m) => money(m.vatRefunded), "right"],
    ["Income tax+Soli", (m) => money(m.taxes["income-tax"]), "right"],
    ["Trade tax", (m) => money(m.taxes["trade-tax"]), "right"],
    ["Other tax", (m) => money(m.taxes.other), "right"],
    ["TK", (m) => money(m.taxes["health-insurance"]), "right"],
    ["Taxes total", (m) => money(m.taxesTotal), "right"],
    ["Tax refunds", (m) => money(m.taxRefunds), "right"],
  ]);
  if (r.months.some((m) => m.future)) io.print("* not over yet");
  if (r.gaps.length) {
    io.print("");
    io.print("Data gaps");
    for (const g of r.gaps) io.print(`  - ${g.month ? `${g.month}: ` : ""}${g.message} (${g.count})`);
  }
  io.print("");
  io.print(`${r.entries.length} tax/TK payments. Source rules: dataops finance taxes --json | jq .rules`);
}

export async function taxesCommand(args, io) {
  const result = await apiFor(args).get("/api/finance/taxes", { query: periodArgs(args) });
  if (args.json) return result;
  printTaxes(io, result);
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

export const commands = { summary: summaryCommand, taxes: taxesCommand, upcoming: upcomingCommand, schedule: scheduleCommand };
