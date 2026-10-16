// Read the bookkeeping spreadsheet (exported as one CSV per tab) and plan how
// DataOps transactions catch up with it. The sheet is the source of truth:
// the plan adds rows DataOps is missing and updates fields the sheet fills in
// differently. It never deletes a transaction and never clears a value the
// sheet leaves blank, so classification done in DataOps survives a sync.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SOURCE_TYPE = "spreadsheet";

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : "";
}

/** "2026-01-02", "2 Jan 2026" or "Jan 2, 2026" as an ISO date; "" otherwise. */
export function sheetDate(raw) {
  const text = String(raw || "").trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (match) return validDate(match[1], Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/);
  if (match && MONTHS.includes(match[2].toLowerCase()))
    return validDate(match[3], MONTHS.indexOf(match[2].toLowerCase()) + 1, Number(match[1]));
  match = text.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match && MONTHS.includes(match[1].toLowerCase()))
    return validDate(match[3], MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2]));
  return "";
}

/**
 * A sheet amount as { value, negative } or null. Accepts "-290.66",
 * "1,492.25", "-12,240" (comma before three digits groups thousands),
 * "- 109,76" (comma before one or two digits is the decimal point) and
 * "-5.086.00" (repeated dots group thousands).
 */
export function sheetAmount(raw) {
  let text = String(raw || "").trim().replace(/\s+/g, "");
  if (!text || /^n\/?a$/i.test(text)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  text = text.replace(/^[$€£]|[$€£]$/g, "");
  if (!/^[\d.,]+$/.test(text)) return null;
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    text = text.split(group).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    text = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  } else if ((text.match(/\./g) || []).length > 1) {
    text = text.slice(0, lastDot).replace(/\./g, "") + text.slice(lastDot);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return { value: money(number), negative };
}

/** Two-decimal money string, the shape the bookkeeping API stores. */
export function money(number) {
  return (Math.round(Number(number) * 100) / 100).toFixed(2);
}

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Classification spellings the sheet drifted between; DataOps keeps one.
const CANONICAL = {
  period: {
    anually: "Annually",
    annually: "Annually",
    annual: "Annually",
    yearly: "Annually",
    reccurent: "Recurrent",
    recurrent: "Recurrent",
    "one-time purchase": "One-time",
  },
  category: {
    "work-related tools": "Work-related",
  },
};

/** The canonical spelling of a classification value (trimmed, one variant). */
export function canonical(field, value) {
  const text = collapse(value);
  if (!text) return "";
  return CANONICAL[field]?.[text.toLowerCase()] || text;
}

export const CLASSIFICATION = ["subtype", "category", "period"];

// Header labels in the sheet, lower-cased, to transaction fields. "Type" is
// the sheet's name for subtype; the old tabs' "Notes"/"Test" column holds the
// invoice count.
const HEADERS = {
  date: "transactionDate",
  "date sent": "transactionDate",
  "date paid": "paidDate",
  provider: "counterparty",
  what: "description",
  "price, $": "usd",
  "price, eur": "eur",
  statement: "statementRef",
  count: "quantity",
  notes: "notes",
  test: "notes",
  comment: "comment",
  "entry type": "entryType",
  type: "subtype",
  period: "period",
  category: "category",
};

function rowFields(header, row) {
  const value = {};
  header.forEach((name, index) => {
    const field = HEADERS[collapse(name).toLowerCase()] || (index === 0 ? "transactionDate" : "");
    if (field && value[field] === undefined) value[field] = row[index];
  });
  return value;
}

// The taxes tab has no header: date, then payee and/or description, then the
// amount in the last filled cell.
function taxFields(row) {
  const filled = row.map(collapse);
  const amountIndex = filled.reduce((found, cell, index) => (index >= 3 && cell ? index : found), -1);
  const first = filled[1] || "";
  const second = filled[2] || "";
  const counterparty = first || second;
  return {
    transactionDate: filled[0],
    counterparty,
    description: second || first,
    eur: amountIndex >= 0 ? filled[amountIndex] : "",
    category: /krankenkass|health|insurance/i.test(counterparty) ? "Health Insurance" : "Taxes",
  };
}

function isHeader(row) {
  return row.some((cell) => collapse(cell).toLowerCase() === "provider");
}

/**
 * One sheet row as a transaction, or { skip } with a reason. Amount, currency
 * and direction follow the sheet: a "Price, $" amount is the original USD
 * amount with "Price, EUR" its conversion; otherwise the EUR price is the
 * amount. Negative prices are expenses unless "Entry Type" says otherwise.
 */
export function rowRecord(fields, { taxes = false } = {}) {
  const transactionDate = sheetDate(fields.transactionDate) || sheetDate(fields.paidDate);
  if (!transactionDate) return { skip: "no date" };
  const usd = sheetAmount(fields.usd);
  const eur = sheetAmount(fields.eur);
  const primary = usd || eur;
  if (!primary) return { skip: "no amount" };
  const counterparty = collapse(fields.counterparty);
  if (!counterparty) return { skip: "no provider" };
  const record = {
    transactionDate,
    counterparty,
    description: collapse(fields.description) || counterparty,
    amount: primary.value,
    currency: usd ? "USD" : "EUR",
  };
  const paidDate = sheetDate(fields.paidDate);
  if (paidDate) record.paidDate = paidDate;
  if (usd && eur) record.amountEur = eur.value;
  const entryType = collapse(fields.entryType).toLowerCase();
  record.entryType = ["expense", "income"].includes(entryType) ? entryType : primary.negative ? "expense" : "income";
  const statementRef = collapse(fields.statementRef);
  if (statementRef) record.statementRef = statementRef;
  const count = collapse(fields.quantity ?? fields.notes);
  if (/^\d+$/.test(count)) record.quantity = Number(count);
  const comment = collapse(fields.comment ?? (/^\d+$/.test(collapse(fields.notes)) ? "" : fields.notes));
  if (comment) record.comment = comment;
  for (const field of CLASSIFICATION) {
    const value = canonical(field, fields[field]);
    if (value) record[field] = value;
  }
  if (taxes) record.category = fields.category;
  return { record };
}

const identity = (record) =>
  [record.transactionDate, collapse(record.counterparty).toLowerCase(), money(record.amount), record.currency];

/**
 * A key from the row's content rather than its position, so sorting or
 * inserting rows in the sheet does not change it. Identical rows in one tab
 * are told apart by their order of appearance.
 */
export function sourceKey(tab, record, occurrence) {
  const digest = createHash("sha256")
    .update(JSON.stringify([tab, ...identity(record), occurrence]))
    .digest("hex")
    .slice(0, 20);
  return `sheet:${tab}:${digest}`;
}

/** Every row of one tab: { tab, row, record, sourceKey } or { tab, row, skip }. */
export function readTab(tab, rows) {
  const out = [];
  const seen = new Map();
  const taxes = !rows.some(isHeader);
  let header = null;
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!row.some((cell) => collapse(cell))) return;
    if (!taxes && !header) {
      if (isHeader(row)) header = row;
      return;
    }
    const fields = taxes ? taxFields(row) : rowFields(header, row);
    const result = rowRecord(fields, { taxes });
    if (result.skip) {
      out.push({ tab, row: rowNumber, skip: result.skip });
      return;
    }
    const id = JSON.stringify(identity(result.record));
    const occurrence = seen.get(id) || 0;
    seen.set(id, occurrence + 1);
    out.push({ tab, row: rowNumber, record: result.record, sourceKey: sourceKey(tab, result.record, occurrence) });
  });
  return out;
}

/**
 * Every tab of the spreadsheet through the Sheets API (read-only GET). Numbers
 * come unformatted, so a cell shown as "15,204" still syncs as 15203.78;
 * dates come as the sheet displays them.
 */
export async function fetchSheet(spreadsheetId, accessToken, fetchImpl = fetch) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const get = async (url) => {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Google Sheets answered HTTP ${response.status}; check the sheet id and the token's account.`);
    return response.json();
  };
  const meta = await get(`${base}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((sheet) => sheet.properties.title);
  if (!titles.length) throw new Error("The spreadsheet has no tabs.");
  const query = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  for (const title of titles) query.append("ranges", `'${title.replace(/'/g, "''")}'`);
  const values = await get(`${base}/values:batchGet?${query}`);
  return (values.valueRanges || []).flatMap((range, index) =>
    readTab(titles[index], (range.values || []).map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))))),
  );
}

/** Every `<tab>.csv` in a directory: an offline export of the same sheet. */
export function readSheetDir(dir) {
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv")).sort();
  if (!files.length) throw new Error(`No .csv files in ${dir}: export the sheet with one CSV per tab first.`);
  return files.flatMap((name) => readTab(name.slice(0, -4), parseCsv(readFileSync(path.join(dir, name), "utf8"))));
}

// Fields the sheet owns. Identity fields (date, provider, amount, currency)
// only change when a moved row is re-paired; the rest update whenever the
// sheet has a value that differs.
const IDENTITY_FIELDS = ["transactionDate", "counterparty", "amount", "currency"];
const SYNC_FIELDS = [
  "description",
  "paidDate",
  "amountEur",
  "statementRef",
  "quantity",
  "comment",
  "entryType",
  ...CLASSIFICATION,
];

function same(field, left, right) {
  if (["amount", "amountEur"].includes(field)) return Number(left) === Number(right);
  if (field === "quantity") return Number(left) === Number(right);
  return collapse(left) === collapse(right);
}

function changes(record, existing, fields) {
  const changed = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === "") continue;
    if (existing[field] === undefined || existing[field] === null || !same(field, value, existing[field])) changed[field] = value;
  }
  // DataOps-only classification still gets the canonical spelling.
  for (const field of CLASSIFICATION) {
    if (changed[field] !== undefined || record[field]) continue;
    const current = existing[field];
    if (typeof current === "string" && current && canonical(field, current) !== current) changed[field] = canonical(field, current);
  }
  return changed;
}

const tabOf = (key) => String(key || "").split(":")[1] || "";

/**
 * Pair rows whose identity moved (a corrected date or amount) with the
 * transaction that no longer matches any row, when exactly one candidate on
 * each side shares the rest of the identity.
 */
function pairMoved(sheetRows, transactions) {
  const pairs = [];
  const tiers = [
    (r) => [r.transactionDate, collapse(r.counterparty).toLowerCase()],
    (r) => [collapse(r.counterparty).toLowerCase(), money(r.amount), r.currency],
    (r) => [r.transactionDate, money(r.amount), r.currency],
  ];
  let rows = [...sheetRows];
  let left = [...transactions];
  for (const tier of tiers) {
    const group = (items, recordOf, tabFor) => {
      const map = new Map();
      for (const item of items) {
        const key = JSON.stringify([tabFor(item), ...tier(recordOf(item))]);
        map.set(key, [...(map.get(key) || []), item]);
      }
      return map;
    };
    const fromSheet = group(rows, (row) => row.record, (row) => row.tab);
    const fromDataOps = group(left, (item) => item, (item) => tabOf(item.sourceKey));
    for (const [key, candidates] of fromSheet) {
      const matches = fromDataOps.get(key) || [];
      if (candidates.length === 1 && matches.length === 1) pairs.push([candidates[0], matches[0]]);
    }
    const pairedRows = new Set(pairs.map(([row]) => row));
    const pairedItems = new Set(pairs.map(([, item]) => item));
    rows = rows.filter((row) => !pairedRows.has(row));
    left = left.filter((item) => !pairedItems.has(item));
  }
  return { pairs, rows, left };
}

/**
 * What a sync would do: create sheet rows DataOps lacks, update fields that
 * differ, and report transactions that no longer match a row (never deleted).
 * A row matches its transaction by stored key, then by the same content in
 * the same tab, then as a moved row (see pairMoved). A transaction a sponsor
 * deal claimed as its payment is immutable: its differences are reported as
 * locked, not written.
 */
export function planSync(sheetRows, transactions) {
  const skipped = sheetRows.filter((row) => row.skip);
  const rows = sheetRows.filter((row) => row.record);
  const fromSheet = transactions.filter((item) => item.sourceType === SOURCE_TYPE);
  const byKey = new Map(fromSheet.map((item) => [item.sourceKey, item]));
  const used = new Set();
  const pairs = [];
  let unmatched = [];
  for (const row of rows) {
    const existing = byKey.get(row.sourceKey);
    if (existing && !used.has(existing)) {
      used.add(existing);
      pairs.push([row, existing, SYNC_FIELDS]);
    } else unmatched.push(row);
  }
  const sameContent = new Map();
  for (const item of fromSheet.filter((entry) => !used.has(entry))) {
    const key = JSON.stringify([tabOf(item.sourceKey), ...identity(item)]);
    sameContent.set(key, [...(sameContent.get(key) || []), item]);
  }
  unmatched = unmatched.filter((row) => {
    const existing = sameContent.get(JSON.stringify([row.tab, ...identity(row.record)]))?.shift();
    if (!existing) return true;
    used.add(existing);
    pairs.push([row, existing, SYNC_FIELDS, { sourceKey: row.sourceKey }]);
    return false;
  });
  const moved = pairMoved(unmatched, fromSheet.filter((item) => !used.has(item)));
  for (const [row, existing] of moved.pairs) pairs.push([row, existing, [...IDENTITY_FIELDS, ...SYNC_FIELDS], { sourceKey: row.sourceKey }]);
  const updates = [];
  const locked = [];
  let unchanged = 0;
  for (const [row, existing, fields, extra = {}] of pairs) {
    const changed = changes(row.record, existing, fields);
    if (existing.sponsorDealId) {
      if (Object.keys(changed).length) locked.push({ id: existing.id, tab: row.tab, row: row.row, sponsorDealId: existing.sponsorDealId, changes: changed });
      else unchanged += 1;
      continue;
    }
    if (extra.sourceKey && extra.sourceKey !== existing.sourceKey) changed.sourceKey = extra.sourceKey;
    if (Object.keys(changed).length) updates.push({ id: existing.id, tab: row.tab, row: row.row, changes: changed, before: pick(existing, Object.keys(changed)) });
    else unchanged += 1;
  }
  const creates = moved.rows.map((row) => ({
    tab: row.tab,
    row: row.row,
    record: { ...row.record, sourceType: SOURCE_TYPE, sourceKey: row.sourceKey },
  }));
  return { creates, updates, locked, unchanged, orphans: moved.left.map((item) => summary(item)), skipped };
}

const pick = (item, fields) => Object.fromEntries(fields.map((field) => [field, item[field] ?? null]));
const summary = (item) => pick(item, ["id", "sourceKey", "transactionDate", "counterparty", "amount", "currency"]);

/**
 * Fill a transaction's missing Type, Category and Period from the provider's
 * other transactions, when every classified one agrees and the direction
 * (income or expense) is the same. Ambiguous or unknown providers stay blank.
 */
export function planClassification(transactions, { since = "" } = {}) {
  const history = new Map();
  for (const item of transactions) {
    if (!CLASSIFICATION.some((field) => collapse(item[field]))) continue;
    const key = JSON.stringify([collapse(item.counterparty).toLowerCase(), item.entryType]);
    history.set(key, [...(history.get(key) || []), item]);
  }
  const fills = [];
  const locked = [];
  const unresolved = [];
  for (const item of transactions) {
    const missing = CLASSIFICATION.filter((field) => !collapse(item[field]));
    if (since && String(item.transactionDate) < since) continue;
    if (!missing.length || !(missing.includes("subtype") || missing.includes("category"))) continue;
    const known = history.get(JSON.stringify([collapse(item.counterparty).toLowerCase(), item.entryType])) || [];
    const changed = {};
    for (const field of missing) {
      const values = new Set(known.map((other) => canonical(field, other[field])).filter(Boolean));
      if (values.size === 1) changed[field] = [...values][0];
    }
    if (!Object.keys(changed).length) unresolved.push(summary(item));
    else if (item.sponsorDealId) locked.push({ ...summary(item), sponsorDealId: item.sponsorDealId, changes: changed });
    else fills.push({ id: item.id, transactionDate: item.transactionDate, counterparty: item.counterparty, changes: changed });
  }
  return { fills, locked, unresolved };
}
