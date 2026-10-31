/**
 * Bank statement parsers. One layout per account source; every parser
 * normalizes to the same row shape: a signed decimal amount (credits
 * positive), an ISO date, a counterparty and an optional reference.
 * Parsing is pure: bytes in, rows out, warnings for anything skipped.
 */
import { pdfText } from "../invoices/extract";

export const STATEMENT_ACCOUNTS = ["revolut", "finom", "mercury", "merchant"] as const;
export type StatementAccount = (typeof STATEMENT_ACCOUNTS)[number];

/** Currency assumed when a statement has no currency column (Finom exports one wallet per file). */
export const DEFAULT_CURRENCY: Partial<Record<StatementAccount, string>> = { finom: "EUR" };

export type StatementRow = {
  date: string;
  amount: string;
  currency: string;
  counterparty: string;
  reference?: string;
  /** The bank's own transaction id, when the export carries one; used to drop rows seen in an overlapping statement. */
  bankId?: string;
};

/** Closing balance of one wallet: the running balance printed on its latest row. */
export type StatementBalance = {
  currency: string;
  amount: string;
  asOf: string;
  /** Sub-account label from multi-account exports (Revolut "Account" column). */
  wallet?: string;
};

export type ParsedStatement = { rows: StatementRow[]; warnings: string[]; balances: StatementBalance[] };
export type ParseOptions = { currency?: string };

const CURRENCY = /^[A-Z]{3}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export class ParseError extends Error {}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new ParseError("date out of range");
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) throw new ParseError("date out of range");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Dates as banks print them: ISO, 01 Feb 2026, 02-Jan-2026, Jan 2 2026, 05/03/2026, with optional trailing time. */
export function parseStatementDate(value: string, order: "dmy" | "auto" = "dmy"): string {
  const text = value.trim().replace(/\s+/g, " ")
    .replace(/[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?(?:UTC|GMT|[A-Z]{2,4}))?$/i, "")
    .trim();
  const iso = text.match(ISO_DATE);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const monthName = text.match(/^(\d{1,2})[ -.](\d{1,2}|[A-Za-z]{3,})[ -.](\d{4})$/);
  if (monthName) {
    const month = MONTHS[monthName[2].slice(0, 3).toLowerCase()] ?? Number(monthName[2]);
    if (!month) throw new ParseError(`unreadable date "${value}"`);
    return isoDate(Number(monthName[3]), month, Number(monthName[1]));
  }
  const reversed = text.match(/^(\d{1,2}|[A-Za-z]{3,})[ .-](\d{1,2}),?[ .](\d{4})$/);
  if (reversed) {
    const month = MONTHS[reversed[1].slice(0, 3).toLowerCase()] ?? Number(reversed[1]);
    if (!month) throw new ParseError(`unreadable date "${value}"`);
    return isoDate(Number(reversed[3]), month, Number(reversed[2]));
  }
  const slashes = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashes) {
    const year = Number(slashes[3].length === 2 ? `20${slashes[3]}` : slashes[3]);
    let day = Number(slashes[1]), month = Number(slashes[2]);
    if (order === "auto" && day <= 12 && month > 12) [day, month] = [month, day];
    return isoDate(year, month, day);
  }
  throw new ParseError(`unreadable date "${value}"`);
}

/** "1,234.56", "1.234,56", "-12.00", "(12.00)", "+12", "12.00-" into a signed decimal string. */
export function parseAmount(value: string): string {
  const raw = String(value).trim();
  if (!raw) throw new ParseError("empty amount");
  const negative = /^\(.*\)$/.test(raw) || /-$/.test(raw) || /^-/.test(raw);
  let digits = raw.replace(/[()]/g, "").replace(/[^\d.,]/g, "");
  if (!digits) throw new ParseError(`unreadable amount "${value}"`);
  const lastComma = digits.lastIndexOf(","), lastDot = digits.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) digits = digits.replace(/\./g, "").replace(",", ".");
    else digits = digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const decimals = digits.length - lastComma - 1;
    digits = decimals === 3 && /^\d{1,3}(,\d{3})+$/.test(digits)
      ? digits.replace(/,/g, "")
      : digits.replace(",", ".");
  }
  if (!/^\d*(\.\d*)?$/.test(digits)) throw new ParseError(`unreadable amount "${value}"`);
  const [whole, fraction = ""] = digits.split(".");
  const result = `${negative && digits ? "-" : ""}${whole || "0"}.${(fraction + "00").slice(0, 2)}`;
  if (!Number.isFinite(Number(result))) throw new ParseError(`unreadable amount "${value}"`);
  return result;
}

function add(a: string, b: string): string {
  return (Math.round((Number(a) + Number(b)) * 100) / 100).toFixed(2);
}

export function sumAmounts(rows: Array<{ amount: string }>): string {
  return rows.reduce((total, row) => add(total, row.amount), "0.00");
}

/** Split a CSV line honouring double quotes; delimiter picked per line. */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { cells.push(current); current = ""; }
    else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function detectDelimiter(headerLine: string): string {
  const counts: Array<[string, number]> = [
    [",", (headerLine.match(/,/g) || []).length],
    [";", (headerLine.match(/;/g) || []).length],
    ["\t", (headerLine.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

const slug = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

const DATE_HEADERS = new Set(["starteddate", "completeddate", "date", "transactiondate", "valuedate", "postingdate", "posteddate", "bookingdate"]);
const DESCRIPTION_HEADERS = new Set(["description", "counterparty", "counterpartyname", "merchant", "merchantname", "name", "payee", "details", "narrative", "transactiondescription"]);
const REFERENCE_HEADERS = new Set(["reference", "ref", "paymentreference", "referencenumber", "memo", "transactionreference", "transactionid"]);
const AMOUNT_HEADERS = new Set(["amount", "transactionamount", "amountvalue", "operationamount"]);
const CURRENCY_HEADERS = new Set(["currency", "amountcurrency", "transactioncurrency", "currencycode", "paymentcurrency"]);
const BALANCE_HEADERS = new Set(["balance", "runningbalance", "balanceafter", "accountbalance"]);
const WALLET_HEADERS = new Set(["account", "accountname", "wallet"]);
const BANK_ID_HEADERS = new Set(["id", "transactionid"]);
const PAID_IN_HEADERS = new Set(["paidin", "moneyin", "credit", "creditamount", "incoming", "inflow", "deposits"]);
const PAID_OUT_HEADERS = new Set(["paidout", "moneyout", "debit", "debitamount", "outgoing", "outflow", "withdrawals"]);
const TYPE_HEADERS = new Set(["type", "transactiontype", "direction", "creditdebit"]);
const STATE_HEADERS = new Set(["state", "status"]);

type ColumnPlan = {
  date: number;
  /** Used when the preferred date cell is empty (a Revolut row that never completed). */
  fallbackDate: number;
  description: number;
  reference: number;
  amount: number;
  currency: number;
  paidIn: number;
  paidOut: number;
  type: number;
  state: number;
  balance: number;
  wallet: number;
  bankId: number;
  order: "dmy" | "auto";
  currencyDefault?: string;
};

function planColumns(headers: string[]): ColumnPlan {
  const find = (candidates: Set<string>) =>
    headers.findIndex((header) => header && candidates.has(slug(header)));
  const plan: ColumnPlan = {
    date: find(DATE_HEADERS),
    fallbackDate: -1,
    description: find(DESCRIPTION_HEADERS),
    reference: find(REFERENCE_HEADERS),
    amount: find(AMOUNT_HEADERS),
    currency: find(CURRENCY_HEADERS),
    paidIn: find(PAID_IN_HEADERS),
    paidOut: find(PAID_OUT_HEADERS),
    type: find(TYPE_HEADERS),
    state: find(STATE_HEADERS),
    balance: find(BALANCE_HEADERS),
    wallet: find(WALLET_HEADERS),
    bankId: find(BANK_ID_HEADERS),
    order: "dmy",
  };
  if (plan.date < 0) throw new ParseError(`no date column in headers: ${headers.join(", ")}`);
  if (plan.amount < 0 && plan.paidIn < 0 && plan.paidOut < 0)
    throw new ParseError(`no amount column in headers: ${headers.join(", ")}`);
  return plan;
}

function rowFromCells(cells: string[], plan: ColumnPlan, warnings: string[]): StatementRow | null {
  const dateCell = cells[plan.date] || (plan.fallbackDate >= 0 ? cells[plan.fallbackDate] || "" : "");
  const state = plan.state >= 0 ? (cells[plan.state] || "").toLowerCase() : "";
  if (state && !["completed", "success", "succeeded", "posted", "done", "paid", ""].includes(state)) {
    warnings.push(`skipped a ${state} row dated ${dateCell}`);
    return null;
  }
  let amount = "0.00";
  if (plan.amount >= 0 && cells[plan.amount]) {
    amount = parseAmount(cells[plan.amount]);
  } else {
    const paidIn = plan.paidIn >= 0 && cells[plan.paidIn] ? parseAmount(cells[plan.paidIn]) : "0.00";
    const paidOut = plan.paidOut >= 0 && cells[plan.paidOut] ? parseAmount(cells[plan.paidOut]) : "0.00";
    if (paidIn !== "0.00" && paidOut !== "0.00") throw new ParseError("row has both money in and money out");
    amount = paidIn !== "0.00" ? paidIn : paidOut === "0.00" ? "0.00" : `-${paidOut}`;
  }
  if (plan.type >= 0) {
    const type = slug(cells[plan.type] || "");
    if (["debit", "out", "outgoing", "dr", "payment"].includes(type)) amount = `-${amount.replace("-", "")}`;
    if (["credit", "in", "incoming", "cr", "receipt", "deposit"].includes(type)) amount = amount.replace("-", "");
  }
  if (amount === "0.00") return null;
  const counterparty = (plan.description >= 0 ? cells[plan.description] : "") || (plan.reference >= 0 ? cells[plan.reference] : "") || "";
  if (!counterparty) warnings.push(`row dated ${dateCell} has no counterparty text`);
  const bankId = plan.bankId >= 0 ? (cells[plan.bankId] || "").trim() : "";
  return {
    date: parseStatementDate(dateCell, plan.order),
    amount,
    currency: ((plan.currency >= 0 ? cells[plan.currency] : "") || "").toUpperCase() || plan.currencyDefault || "—",
    counterparty: counterparty.replace(/\s+/g, " ").trim(),
    ...(plan.reference >= 0 && cells[plan.reference] ? { reference: cells[plan.reference].trim() } : {}),
    ...(bankId ? { bankId: bankId.slice(0, 120) } : {}),
  };
}

/** Sortable "HH:MM:SS" from a date cell; rows without a time sort as midnight. */
function timeOf(value: string): string {
  const time = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return time ? `${pad(Number(time[1]))}:${time[2]}:${time[3] || "00"}` : "00:00:00";
}

/**
 * The closing balance of each wallet is the running balance on its latest
 * row. Rows that share a timestamp are ordered as the file lists them, read
 * in the file's own direction (exports come newest-first or oldest-first).
 */
function closingBalances(entries: Array<{ row: StatementRow; when: string; balance: string; wallet: string }>): StatementBalance[] {
  if (!entries.length) return [];
  const newestFirst = entries[0].when > entries[entries.length - 1].when;
  const ordered = newestFirst ? [...entries].reverse() : entries;
  const latest = new Map<string, { when: string; balance: StatementBalance }>();
  for (const entry of ordered) {
    const key = `${entry.wallet}|${entry.row.currency}`;
    const current = latest.get(key);
    if (current && current.when > entry.when) continue;
    latest.set(key, {
      when: entry.when,
      balance: {
        currency: entry.row.currency,
        amount: entry.balance,
        asOf: entry.row.date,
        ...(entry.wallet ? { wallet: entry.wallet } : {}),
      },
    });
  }
  return [...latest.values()].map((item) => item.balance)
    .sort((left, right) => (left.wallet || "").localeCompare(right.wallet || "") || left.currency.localeCompare(right.currency));
}

/**
 * Revolut and Finom always export the same columns, so their statements are
 * read through a fixed layout: every named column must be present by its
 * exact header, and a file that matches no layout is refused with the
 * difference spelled out rather than guessed at.
 */
type FixedLayout = {
  name: string;
  columns: {
    date: string;
    /** Used when the date cell is empty (a row that never completed). */
    fallbackDate?: string;
    description: string;
    reference: string;
    amount: string;
    currency?: string;
    state?: string;
    balance?: string;
    wallet?: string;
    bankId?: string;
  };
  /** Columns the layout reads when present but does not require. */
  optional?: Array<keyof FixedLayout["columns"]>;
};

export const FIXED_LAYOUTS: Partial<Record<StatementAccount, FixedLayout[]>> = {
  revolut: [
    {
      // Revolut Business "Account statement" CSV, one or all accounts. Booking
      // dates use the local (Europe/Berlin) completed date when exported.
      name: "Revolut Business account statement (local time)",
      columns: {
        date: "Date completed (Europe/Berlin)", fallbackDate: "Date started (Europe/Berlin)",
        description: "Description", reference: "Reference", amount: "Amount", currency: "Payment currency",
        state: "State", balance: "Balance", wallet: "Account", bankId: "ID",
      },
    },
    {
      name: "Revolut Business account statement (UTC)",
      columns: {
        date: "Date completed (UTC)", fallbackDate: "Date started (UTC)",
        description: "Description", reference: "Reference", amount: "Amount", currency: "Payment currency",
        state: "State", balance: "Balance", wallet: "Account", bankId: "ID",
      },
    },
    {
      name: "Revolut account statement (Type/Product layout)",
      columns: {
        date: "Completed Date", fallbackDate: "Started Date",
        description: "Description", reference: "Reference", amount: "Amount", currency: "Currency",
        state: "State", balance: "Balance",
      },
      optional: ["reference"],
    },
  ],
  finom: [
    {
      // Finom "Get statement" CSV: one wallet per file, no currency column.
      name: "Finom statement",
      columns: { date: "Completed date", description: "Counterparty name", reference: "Reference", amount: "Amount", balance: "Balance" },
      optional: ["balance"],
    },
  ],
};

const headerKey = (header: string) => header.trim().toLowerCase();

function fixedPlan(headers: string[], account: StatementAccount, layouts: FixedLayout[]): ColumnPlan {
  const index = new Map(headers.map((header, position) => [headerKey(header), position] as const).reverse());
  const misses: string[] = [];
  for (const layout of layouts) {
    const entries = Object.entries(layout.columns) as Array<[keyof FixedLayout["columns"], string]>;
    const missing = entries
      .filter(([field, header]) => !index.has(headerKey(header)) && !layout.optional?.includes(field))
      .map(([, header]) => header);
    if (missing.length) {
      misses.push(`${layout.name} (missing ${missing.join(", ")})`);
      continue;
    }
    const at = (field: keyof FixedLayout["columns"]) => {
      const header = layout.columns[field];
      return header === undefined ? -1 : index.get(headerKey(header)) ?? -1;
    };
    return {
      date: at("date"), fallbackDate: at("fallbackDate"), description: at("description"), reference: at("reference"),
      amount: at("amount"), currency: at("currency"), paidIn: -1, paidOut: -1, type: -1, state: at("state"),
      balance: at("balance"), wallet: at("wallet"), bankId: at("bankId"), order: "dmy",
    };
  }
  throw new ParseError(`unrecognized ${account} export; the bank may have changed its columns. Headers: ${headers.join(", ")}. Expected one of: ${misses.join("; ")}`);
}

function parseTable(headers: string[], dataRows: string[][], account: StatementAccount, options: ParseOptions = {}): ParsedStatement {
  const layouts = FIXED_LAYOUTS[account];
  const plan = layouts ? fixedPlan(headers, account, layouts) : planColumns(headers);
  if (account === "merchant") plan.order = "auto";
  if (plan.currency < 0) plan.currencyDefault = options.currency || DEFAULT_CURRENCY[account];
  const warnings: string[] = [];
  const rows: StatementRow[] = [];
  const balanceEntries: Array<{ row: StatementRow; when: string; balance: string; wallet: string }> = [];
  for (const cells of dataRows) {
    if (!cells.some((cell) => cell)) continue;
    try {
      const row = rowFromCells(cells, plan, warnings);
      if (!row) continue;
      rows.push(row);
      const balanceCell = plan.balance >= 0 ? cells[plan.balance] : "";
      if (balanceCell) {
        const dateCell = cells[plan.date] || (plan.fallbackDate >= 0 ? cells[plan.fallbackDate] || "" : "");
        balanceEntries.push({
          row,
          when: `${row.date}T${timeOf(dateCell)}`,
          balance: parseAmount(balanceCell),
          wallet: plan.wallet >= 0 ? (cells[plan.wallet] || "").trim().slice(0, 120) : "",
        });
      }
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      warnings.push(error.message);
    }
  }
  if (!rows.length) throw new ParseError("no statement rows parsed");
  return { rows, warnings, balances: closingBalances(balanceEntries) };
}

export function parseStatementCsv(text: string, account: StatementAccount, options: ParseOptions = {}): ParsedStatement {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new ParseError("statement file is empty");
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitDelimited(lines[0], delimiter);
  const dataRows = lines.slice(1).map((line) => splitDelimited(line, delimiter));
  return parseTable(headers, dataRows, account, options);
}

/** XLSX: exceljs is loaded lazily so CSV and test paths never pay for it. */
export async function parseStatementXlsx(bytes: Buffer, account: StatementAccount, options: ParseOptions = {}): Promise<ParsedStatement> {
  // exceljs ships CommonJS; its ESM namespace wraps the module under default.
  const load = new Function("return import('exceljs')") as () => Promise<{ default?: typeof import("exceljs"); Workbook?: unknown }>;
  const imported = await load();
  const ExcelJS = (imported.Workbook ? imported : imported.default ?? imported) as typeof import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ParseError("workbook has no sheets");
  const grid: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (cell.value == null) { cells.push(""); return; }
      if (cell.value instanceof Date) cells.push(cell.value.toISOString().slice(0, 10));
      else if (typeof cell.value === "object" && "result" in (cell.value as object)) cells.push(String((cell.value as { result: unknown }).result ?? ""));
      else if (typeof cell.value === "object" && "text" in (cell.value as object)) cells.push(String((cell.value as { text: unknown }).text ?? ""));
      else cells.push(String(cell.value));
    });
    grid.push(cells);
  });
  while (grid.length && !grid[0].some((cell) => cell)) grid.shift();
  if (!grid.length) throw new ParseError("sheet is empty");
  return parseTable(grid[0], grid.slice(1), account, options);
}

const moneyPattern = "\\(?\\+?-?[0-9][0-9.,\\s]*[0-9](?:[.,]\\d{2})?-?\\)?";

/**
 * PDF statement text (as pdfText lays it out). A transaction block starts at
 * a line that opens with a date; the block's last signed amount wins, a
 * "Reference:"-style line inside the block becomes the reference.
 */
export function parseStatementPdfText(text: string, defaultCurrency?: string): ParsedStatement {
  const warnings: string[] = [];
  const currencyHint = text.match(/(?:account currency|currency)[:\s]+([A-Z]{3})/i)?.[1]?.toUpperCase() || defaultCurrency;
  const dateStart = new RegExp("^(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ .-](?:\\d{1,2}|[A-Za-z]{3,})[ .-]\\d{2,4})(?=$|[\\s,])");
  const referenceLine = /^(?:payment )?reference(?: \/ description)?[:\s]+(.+)$/i;
  const counterpartyStrip = /^(?:transfer from|received (?:from|payment from)|payment from|incoming transfer from|from|sent to|transfer to|payment to|to|top-?up|card payment to|faster payment (?:from|to)|sepa (?:credit )?(?:from|to))\s+/i;
  const rows: StatementRow[] = [];
  let current: { date: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    // The running balance trails the amount in every layout; drop it before
    // picking the transaction amount.
    const block = current.body.join(" ").replace(/\bbalance\b.*$/i, "");
    const matches = [...block.matchAll(new RegExp(`(${moneyPattern})(?:\\s+([A-Z]{3}))?`, "g"))];
    const withCurrency = matches.filter((match) => match[2] && CURRENCY.test(match[2]));
    const last = withCurrency.at(-1) || matches.at(-1);
    if (!last) { warnings.push(`block dated ${current.date} has no amount`); current = null; return; }
    const currency = (last[2] || currencyHint || "").toUpperCase();
    const reference = current.body.map((line) => line.match(referenceLine)?.[1]).filter(Boolean).at(-1);
    const blockBefore = current.body
      .filter((line) => !referenceLine.test(line))
      .join(" ")
      .replace(/\bbalance\b.*$/i, "")
      .replace(/\breference[:\s][^,.;]*$/i, "")
      .replace(new RegExp(`(${moneyPattern})(?:\\s+[A-Z]{3})?\\s*$`), "");
    let counterparty = blockBefore
      .trim()
      .replace(counterpartyStrip, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    try {
      rows.push({
        date: current.date,
        amount: parseAmount(last[1]),
        currency: CURRENCY.test(currency) ? currency : "—",
        counterparty: counterparty || "—",
        ...(reference ? { reference: reference.trim() } : {}),
      });
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      warnings.push(error.message);
    }
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (dateStart.test(line)) {
      flush();
      current = { date: parseStatementDate(line.match(dateStart)![0]), body: [line.replace(dateStart, "")] };
      continue;
    }
    if (current) current.body.push(line.trim());
  }
  flush();
  if (!rows.length) throw new ParseError("no statement rows parsed from PDF text");
  return { rows, warnings, balances: [] };
}

/** Parse a statement by content type. PDF bytes go through pdfText first. */
export async function parseStatement(contentType: string, bytes: Buffer, account: StatementAccount, options: ParseOptions = {}): Promise<ParsedStatement> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf" || bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return parseStatementPdfText(await pdfText(bytes), options.currency || DEFAULT_CURRENCY[account]);
  }
  if (type.includes("spreadsheetml") || type === "application/vnd.ms-excel") {
    return parseStatementXlsx(bytes, account, options);
  }
  return parseStatementCsv(bytes.toString("utf8"), account, options);
}

/** Loose identity used to pair a statement row with a ledger transaction. */
export function rowsPairable(left: StatementRow, right: StatementRow, dayTolerance = 3): boolean {
  if (left.currency !== right.currency) return false;
  if (Math.abs(Number(left.amount) - Number(right.amount)) > 0.004) return false;
  return Math.abs(Date.parse(`${left.date}T00:00:00Z`) - Date.parse(`${right.date}T00:00:00Z`)) <= dayTolerance * 86_400_000;
}

export { sumAmounts as statementTotal };
