/**
 * Fixed-layout parsers for the monthly PDF statements Finom and Revolut
 * Business issue, read from the text pdfText lays out. Each layout is
 * recognised by its exact column header line and its issuer markers; a
 * statement that does not carry them is refused rather than guessed at.
 *
 * Both banks print the opening and closing balance, so every parse is
 * checked against the statement's own totals: opening + movements must equal
 * closing (and, for Revolut, the printed money in / money out). A statement
 * that does not reconcile throws, because a silently dropped or mis-signed
 * row would otherwise flow into reconciliation unnoticed.
 */
import { ParseError, parseAmount, parseStatementDate, sumAmounts } from "./parsers";
import type { ParsedStatement, StatementBalance, StatementRow } from "./parsers";

export type StatementPeriod = { from: string; to: string };

export type PdfParsedStatement = ParsedStatement & {
  /** Which fixed layout the statement was read with. */
  layout: string;
  /** The statement period as printed on it. */
  period?: StatementPeriod;
  /** Opening balance per wallet, as printed. */
  openingBalances: StatementBalance[];
};

const CURRENCY_SYMBOLS: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP" };

function cents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

function centsToAmount(value: number): string {
  return (value / 100).toFixed(2);
}

function negate(amount: string): string {
  return centsToAmount(-cents(amount));
}

/** Split a pdfText line into its cells: pdfjs separates text items by runs of three or more spaces. */
function cells(line: string): string[] {
  return line.trim().split(/\s{3,}/).map((cell) => cell.trim()).filter(Boolean);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim());
}

/** The column header line reduced to its column names, for exact comparison. */
function headerKey(line: string): string {
  return cells(line).join(" | ");
}

// ---------------------------------------------------------------------------
// Detection

const FINOM_ENTITY = /FINOM(?: PAYMENTS B\.V\.|, a limited liability company)|^(?:\d+ )?Created with Finom\.co\s*$/m;
const FINOM_TITLE = /^.*\s{3,}STATEMENT(?:\s+OF\s+ACCOUNT)?\s*$|\sStatement of account\s*$/m;
const REVOLUT_ENTITY = /^© \d{4} Revolut Bank UAB\b/m;
const REVOLUT_SUMMARY = /^Balance summary\s*$/m;

/** Which bank issued a PDF statement, from its issuer markers. Null when neither (or both) match. */
export function detectPdfStatementAccount(text: string): "finom" | "revolut" | null {
  const finom = FINOM_ENTITY.test(text) && FINOM_TITLE.test(text);
  const revolut = REVOLUT_ENTITY.test(text) && REVOLUT_SUMMARY.test(text);
  if (finom === revolut) return null;
  return finom ? "finom" : "revolut";
}

// ---------------------------------------------------------------------------
// Finom

/**
 * Finom monthly statements. Until mid-July 2025 the account sat on a Solaris
 * IBAN and the table had no running balance; since then it carries one.
 */
const FINOM_LAYOUTS = [
  { name: "Finom statement of account (Solaris, no balance column)", header: "Completed | Description | Pay in/out", balance: false },
  { name: "Finom statement of account (with balance column)", header: "Completed | Description | Pay in/out | Balance", balance: true },
] as const;

const FINOM_DATE_LINE = /^(\d{2}\.\d{2}\.\d{4})\s{3,}(.*)$/;
const FINOM_EUR = /^(?:-\s?)?\d{1,3}(?:\.\d{3})*,\d{2} €$/;
const FINOM_FOREIGN = /^((?:-\s?)?\d{1,3}(?:\.\d{3})*,\d{2}) ([$£]|[A-Z]{3})$/;
const FINOM_PAGE_CHROME = /^(?:\d{1,2}|(?:\d{1,2} )?(?:Empowered by Solaris|Created with Finom\.co))$/;
const FINOM_DETAIL = /^(?:IBAN|BIC|Value date):/;
const FINOM_FX_RATE = /^\d+ [A-Z]{3} = [\d.,]+ [A-Z]{3}$/;

function finomLabel(text: string, label: string): string {
  const match = text.match(new RegExp(`^${label}:\\s+(.+?)\\s*$`, "m"));
  if (!match) throw new ParseError(`unrecognized finom PDF statement layout: no "${label}:" line`);
  return match[1];
}

export function parseFinomPdfText(text: string): PdfParsedStatement {
  if (!FINOM_ENTITY.test(text) || !FINOM_TITLE.test(text)) {
    throw new ParseError("unrecognized finom PDF statement layout: Finom issuer and \"Statement of account\" title not found");
  }
  const all = lines(text);
  const headers = new Set(all.filter((line) => /^Completed\s{3,}Description\b/.test(line.trim())).map(headerKey));
  const layout = FINOM_LAYOUTS.find((candidate) => headers.size === 1 && headers.has(candidate.header));
  if (!layout) {
    throw new ParseError(`unrecognized finom PDF statement layout: column header ${[...headers].map((h) => `"${h}"`).join(", ") || "missing"}; expected one of ${FINOM_LAYOUTS.map((l) => `"${l.header}"`).join(", ")}`);
  }
  const period = { from: parseStatementDate(finomLabel(text, "From")), to: parseStatementDate(finomLabel(text, "To")) };
  const opening = parseAmount(finomLabel(text, "Opening balance"));
  const closing = parseAmount(finomLabel(text, "Closing balance"));

  type Block = { date: string; counterparty: string; details: string[]; amount?: string; balance?: string; orig?: { amount: string; currency: string } };
  const blocks: Block[] = [];
  let open: Block | null = null;
  let last: Block | null = null;
  let tableStarted = false;
  for (const line of all) {
    const trimmed = line.trim();
    if (headerKey(trimmed) === layout.header) { tableStarted = true; continue; }
    if (!tableStarted || FINOM_PAGE_CHROME.test(trimmed)) continue;
    const dated = trimmed.match(FINOM_DATE_LINE);
    let pieces: string[];
    if (dated && !open) {
      const [first = "", ...rest] = cells(dated[2]);
      open = { date: parseStatementDate(dated[1]), counterparty: FINOM_EUR.test(first) ? "" : first, details: [] };
      pieces = FINOM_EUR.test(first) ? [first, ...rest] : rest;
      last = null;
    } else if (open) {
      pieces = cells(trimmed);
    } else {
      // Between rows: an original-currency amount belongs to the row above;
      // anything else is page chrome or the closing legal notice.
      const foreign = trimmed.match(FINOM_FOREIGN);
      if (foreign && last && last.amount && !last.orig && cells(trimmed).length === 1) {
        last.orig = { amount: parseAmount(foreign[1]), currency: CURRENCY_SYMBOLS[foreign[2]] || foreign[2] };
      }
      continue;
    }
    const amounts = pieces.filter((piece) => FINOM_EUR.test(piece));
    const words = pieces.filter((piece) => !FINOM_EUR.test(piece));
    if (amounts.length && words.length) {
      throw new ParseError(`unrecognized finom PDF statement layout: row dated ${open.date} mixes text and amounts on one line`);
    }
    if (!amounts.length) { open.details.push(...words); continue; }
    const expected = layout.balance ? 2 : 1;
    if (amounts.length !== expected) {
      throw new ParseError(`unrecognized finom PDF statement layout: row dated ${open.date} has ${amounts.length} amounts, expected ${expected}`);
    }
    open.amount = parseAmount(amounts[0]);
    if (layout.balance) open.balance = parseAmount(amounts[1]);
    blocks.push(open);
    last = open;
    open = null;
  }
  if (open) throw new ParseError(`unrecognized finom PDF statement layout: row dated ${open.date} has no amount`);

  const rows: StatementRow[] = blocks.map((block) => {
    const counterparty = block.counterparty || block.details[0] || "—";
    const reference = block.details
      .filter((detail) => !FINOM_DETAIL.test(detail) && !FINOM_FX_RATE.test(detail) && detail !== counterparty)
      .join(" ").replace(/\s+/g, " ").trim();
    return {
      date: block.date,
      amount: block.amount!,
      currency: "EUR",
      counterparty,
      ...(reference ? { reference } : {}),
      ...(block.orig ? { origAmount: block.orig.amount, origCurrency: block.orig.currency } : {}),
    };
  });

  // Rows are printed newest first; walk them oldest first against the balances.
  const net = cents(sumAmounts(rows));
  if (cents(opening) + net !== cents(closing)) {
    throw new ParseError(`finom PDF statement does not reconcile: opening ${opening} + movements ${centsToAmount(net)} != closing ${closing}`);
  }
  if (layout.balance) {
    let running = cents(opening);
    for (const block of [...blocks].reverse()) {
      running += cents(block.amount!);
      if (running !== cents(block.balance!)) {
        throw new ParseError(`finom PDF statement does not reconcile: running balance after the row dated ${block.date} is ${centsToAmount(running)}, statement prints ${block.balance}`);
      }
    }
  }
  return {
    layout: layout.name,
    rows,
    warnings: [],
    period,
    openingBalances: [{ currency: "EUR", amount: opening, asOf: period.from }],
    balances: [{ currency: "EUR", amount: closing, asOf: period.to }],
  };
}

// ---------------------------------------------------------------------------
// Revolut Business

const REVOLUT_HEADER = "Date (UTC) | Description | Money out | Money in | Balance";
const REVOLUT_LAYOUT = "Revolut Business account statement (per-wallet sections)";
const REVOLUT_DATE_LINE = /^(\d{1,2} [A-Z][a-z]{2} \d{4})\s{3,}([A-Z]{3})(?:\s{3,}(.*))?$/;
const REVOLUT_MONEY = /^([-+]\s?)?([€$£]|[A-Z]{3} ?)(\d{1,3}(?:[ ,]\d{3})*\.\d{2})$/;
const REVOLUT_FX = /^FX rate [A-Z]{3} [\d.]+ = [A-Z]{3} [\d.]+(?:,\s*Fee:\s*(.+))?$/;
const REVOLUT_NO_ROWS = /^There were no transactions during this period$/;
const REVOLUT_CHROME_START = /^(?:Report lost or stolen card|(?:Account|Monthly) statement(?:\s+Generated on the .*)?)$/;
const REVOLUT_CHROME_END = /^© \d{4} Revolut Bank UAB\b/;
const REVOLUT_PAGE = /^\d+\/\d+$/;
/** Revolut's statement type codes, in the vocabulary of its CSV "Type" column. */
const REVOLUT_TYPES: Record<string, string> = {
  CAR: "CARD_PAYMENT", MOS: "TRANSFER", MOR: "TRANSFER", MOA: "TOPUP",
  FEE: "FEE", EXO: "EXCHANGE", EXI: "EXCHANGE", ATM: "ATM",
};
const REVOLUT_PAYEE_PREFIX = /^(?:To|From|Money added from|Refund from|Payment from)\s+/;

type Money = { amount: string; currency: string };

function revolutMoney(piece: string): Money | null {
  const match = piece.match(REVOLUT_MONEY);
  if (!match) return null;
  const currency = CURRENCY_SYMBOLS[match[2]] || match[2].trim();
  const sign = match[1]?.trim() === "-" ? "-" : "";
  return { amount: parseAmount(`${sign}${match[3]}`), currency };
}

type RevolutSection = {
  wallet?: string;
  currency?: string;
  opening?: Money;
  moneyIn?: Money;
  moneyOut?: Money;
  closing?: Money;
  period?: StatementPeriod;
  sawHeader: boolean;
  empty: boolean;
  blocks: Array<{ date: string; code: string; pieces: string[] }>;
};

function revolutSummary(section: RevolutSection, label: string, value: string): Money {
  const money = revolutMoney(value);
  if (!money) throw new ParseError(`unrecognized revolut PDF statement layout: unreadable "${label}" in the ${section.wallet} section`);
  return money;
}

export function parseRevolutPdfText(text: string): PdfParsedStatement {
  if (!REVOLUT_ENTITY.test(text) || !REVOLUT_SUMMARY.test(text)) {
    throw new ParseError("unrecognized revolut PDF statement layout: Revolut Bank UAB issuer and \"Balance summary\" not found");
  }
  const sections: RevolutSection[] = [];
  let section: RevolutSection | null = null;
  let inTable = false;
  let chrome = false;
  let afterChrome = false;
  for (const line of lines(text)) {
    const trimmed = line.trim();
    if (chrome) {
      if (REVOLUT_CHROME_END.test(trimmed)) { chrome = false; afterChrome = true; }
      continue;
    }
    if (afterChrome) {
      afterChrome = false;
      if (REVOLUT_PAGE.test(trimmed)) continue;
    }
    if (REVOLUT_CHROME_START.test(trimmed)) { chrome = true; continue; }
    if (/^Generated on the /.test(trimmed)) continue;
    const parts = cells(trimmed);
    if (parts[0] === "Account name" && parts.length === 2) {
      section = { wallet: undefined, sawHeader: false, empty: false, blocks: [] };
      section.wallet = parts[1];
      sections.push(section);
      inTable = false;
      continue;
    }
    if (!section) continue;
    if (inTable) {
      if (trimmed === "Transaction types") { inTable = false; continue; }
      if (REVOLUT_NO_ROWS.test(trimmed)) { section.empty = true; continue; }
      if (headerKey(trimmed) === REVOLUT_HEADER) continue;
      const dated = trimmed.match(REVOLUT_DATE_LINE);
      if (dated) {
        section.blocks.push({ date: parseStatementDate(dated[1]), code: dated[2], pieces: dated[3] ? cells(dated[3]) : [] });
        continue;
      }
      const block = section.blocks.at(-1);
      if (!block) throw new ParseError(`unrecognized revolut PDF statement layout: text before the first row of the ${section.wallet} section`);
      block.pieces.push(...parts);
      continue;
    }
    if (headerKey(trimmed) === REVOLUT_HEADER) {
      if (!section.currency) throw new ParseError(`unrecognized revolut PDF statement layout: the ${section.wallet} section has no Currency line`);
      section.sawHeader = true;
      inTable = true;
      continue;
    }
    if (parts.length === 2) {
      const [label, value] = parts;
      if (label === "Currency" && /^[A-Z]{3}$/.test(value)) section.currency = value;
      else if (label === "Opening balance") section.opening = revolutSummary(section, label, value);
      else if (label === "Money in") section.moneyIn = revolutSummary(section, label, value);
      else if (label === "Money out") section.moneyOut = revolutSummary(section, label, value);
      else if (label === "Closing balance") section.closing = revolutSummary(section, label, value);
      continue;
    }
    const range = trimmed.match(/^Transactions from (.+?) to (.+)$/);
    if (range) section.period = { from: parseStatementDate(range[1]), to: parseStatementDate(range[2]) };
  }
  if (!sections.length) throw new ParseError("unrecognized revolut PDF statement layout: no \"Account name\" wallet section");

  const rows: StatementRow[] = [];
  const balances: StatementBalance[] = [];
  const openingBalances: StatementBalance[] = [];
  const periods: StatementPeriod[] = [];
  for (const current of sections) {
    const name = current.wallet;
    if (!current.sawHeader) {
      throw new ParseError(`unrecognized revolut PDF statement layout: the ${name} section has no "${REVOLUT_HEADER}" header`);
    }
    const { currency, opening, moneyIn, moneyOut, closing, period } = current;
    if (!currency || !opening || !moneyIn || !moneyOut || !closing || !period) {
      throw new ParseError(`unrecognized revolut PDF statement layout: the ${name} section lacks its balance summary or period`);
    }
    for (const money of [opening, moneyIn, moneyOut, closing]) {
      if (money.currency !== currency) throw new ParseError(`revolut PDF statement: the ${name} section mixes ${money.currency} into a ${currency} summary`);
    }
    if (current.empty && current.blocks.length) throw new ParseError(`revolut PDF statement: the ${name} section says it has no transactions but lists some`);
    periods.push(period);

    // Rows come newest first. The printed running balance tells money in from
    // money out: each row moves the balance by exactly its amount.
    const sectionRows: StatementRow[] = [];
    let running = cents(opening.amount);
    let totalIn = 0, totalOut = 0;
    for (const block of [...current.blocks].reverse()) {
      const type = REVOLUT_TYPES[block.code];
      if (!type) throw new ParseError(`unrecognized revolut PDF statement layout: unknown transaction type "${block.code}" on ${block.date}`);
      const firstMoney = block.pieces.findIndex((piece) => revolutMoney(piece));
      const moneys = firstMoney < 0 ? [] : block.pieces.slice(firstMoney).map(revolutMoney);
      if (firstMoney < 0 || moneys.some((money) => !money) || moneys.length < 2 || moneys.length > 3) {
        throw new ParseError(`unrecognized revolut PDF statement layout: row dated ${block.date} does not end in amount and balance cells`);
      }
      const [amount, ...restMoney] = moneys as Money[];
      const balance = restMoney.at(-1)!;
      const orig = restMoney.length === 2 ? restMoney[0] : undefined;
      if (amount.currency !== currency || balance.currency !== currency || (orig && orig.currency === currency)) {
        throw new ParseError(`unrecognized revolut PDF statement layout: row dated ${block.date} has amounts in unexpected currencies`);
      }
      const words = block.pieces.slice(0, firstMoney);
      let fee: string | undefined;
      const description = words.filter((word) => {
        const fx = word.match(REVOLUT_FX);
        if (!fx) return true;
        if (fx[1]) {
          const feeMoney = revolutMoney(fx[1].trim());
          if (!feeMoney) throw new ParseError(`unrecognized revolut PDF statement layout: unreadable FX fee on ${block.date}`);
          fee = negate(feeMoney.amount);
        }
        return false;
      }).join(" ").replace(/\s+/g, " ").trim();
      const magnitude = Math.abs(cents(amount.amount));
      const moved = cents(balance.amount) - running;
      let signed: number;
      if (moved === magnitude) signed = magnitude;
      else if (moved === -magnitude) signed = -magnitude;
      else {
        throw new ParseError(`revolut PDF statement does not reconcile: the ${name} row dated ${block.date} moves the balance by ${centsToAmount(moved)} but shows ${amount.amount}`);
      }
      running = cents(balance.amount);
      if (signed > 0) totalIn += signed; else totalOut += signed;
      const [payeePart, ...referenceParts] = description.split(/\s*•\s*/);
      const counterparty = payeePart.replace(REVOLUT_PAYEE_PREFIX, "").trim();
      const reference = referenceParts.join(" • ").trim();
      const bankType = block.code === "MOR" && /^Refund from /.test(payeePart) ? "CARD_REFUND" : type;
      sectionRows.push({
        date: block.date,
        amount: centsToAmount(signed),
        currency,
        counterparty: counterparty || "—",
        ...(reference ? { reference } : {}),
        bankType,
        ...(orig ? { origAmount: signed < 0 ? negate(orig.amount) : orig.amount, origCurrency: orig.currency } : {}),
        ...(fee && cents(fee) !== 0 ? { fee } : {}),
        wallet: currency,
      });
    }
    if (running !== cents(closing.amount)) {
      throw new ParseError(`revolut PDF statement does not reconcile: the ${name} rows end at ${centsToAmount(running)}, closing balance is ${closing.amount}`);
    }
    if (totalIn !== Math.abs(cents(moneyIn.amount)) || -totalOut !== Math.abs(cents(moneyOut.amount))) {
      throw new ParseError(`revolut PDF statement does not reconcile: the ${name} rows total in ${centsToAmount(totalIn)} / out ${centsToAmount(totalOut)}, statement prints ${moneyIn.amount} / ${moneyOut.amount}`);
    }
    rows.push(...sectionRows.reverse());
    openingBalances.push({ currency, amount: opening.amount, asOf: period.from, wallet: currency });
    balances.push({ currency, amount: closing.amount, asOf: period.to, wallet: currency });
  }
  const period = {
    from: periods.map((p) => p.from).sort()[0],
    to: periods.map((p) => p.to).sort().at(-1)!,
  };
  return { layout: REVOLUT_LAYOUT, rows, warnings: [], period, openingBalances, balances };
}
