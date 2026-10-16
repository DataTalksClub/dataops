// The transaction table: one dense row per transaction, the same columns
// as the bookkeeping spreadsheet it replaces (date, counterparty, what,
// original amount, EUR amount, account, type, category, period). Pure
// functions from records to markup and from URL state to filters; the
// surface (bookkeeping.js) owns fetching, events and saving.
import { sponsorRecordPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";
import { entryDirection, formatAmount, ledgerDate, monthLabel, monthOf } from "./bookkeeping-format.js";

// Query parameters the bookkeeping route keeps in the URL.
export const LEDGER_PARAMS = ["month", "q", "account", "dir", "category", "needs", "tx", "view"];
export const SECONDARY_VIEWS = ["files", "package", "invoices"];

// The spreadsheet's classification columns, in its order and wording:
// "Type" is stored as `subtype`, "Category" as `category`, "Period" as `period`.
export const CLASSIFICATION_FIELDS = [
  { field: "subtype", label: "Type" },
  { field: "category", label: "Category" },
  { field: "period", label: "Period" },
];

// The account a transaction went through. The sheet's Statement column holds
// either the account name or "Account - statement-file.pdf".
export function accountOf(entry) {
  const ref = String(entry?.statementRef || "").trim();
  if (!ref) return "";
  return ref.split(" - ")[0].trim();
}

const sign = (entry) => (entryDirection(entry) === "income" ? 1 : -1);

// Signed EUR value: the amount itself for EUR records, the recorded
// conversion otherwise; null when a foreign amount has no EUR value yet.
export function eurValue(entry) {
  const currency = String(entry?.currency || "EUR").toUpperCase();
  const raw = currency === "EUR" ? entry?.amount : entry?.amountEur;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? sign(entry) * value : null;
}

// Signed original-currency value, only for non-EUR records.
export function originalValue(entry) {
  const currency = String(entry?.currency || "EUR").toUpperCase();
  if (currency === "EUR") return null;
  const value = Number(entry?.amount);
  return Number.isFinite(value) ? sign(entry) * value : null;
}

const filled = (value) => String(value ?? "").trim() !== "";

// A row still needs classifying while the sheet's Type or Category is blank.
export function needsCategory(entry) {
  return !filled(entry.subtype) || !filled(entry.category);
}

// The value list a classification dropdown offers: every distinct value in
// use, the most common spelling winning among case/space variants.
export function vocabulary(entries, field) {
  const byKey = new Map();
  for (const entry of entries) {
    const value = String(entry?.[field] ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const spellings = byKey.get(key) || new Map();
    spellings.set(value, (spellings.get(value) || 0) + 1);
    byKey.set(key, spellings);
  }
  return [...byKey.values()]
    .map((spellings) => [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0])
    .sort((a, b) => a.localeCompare(b));
}

export function accountsOf(entries) {
  return [...new Set(entries.map(accountOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// URL state -> filters. Unknown values fall back to "show everything".
export function filtersFromParams(params) {
  const get = (name) => String(params?.get?.(name) || "").trim();
  const needs = get("needs");
  const dir = get("dir");
  return {
    q: get("q"),
    account: get("account"),
    dir: ["expense", "income"].includes(dir) ? dir : "",
    category: get("category"),
    needs: ["category", "receipt"].includes(needs) ? needs : "",
  };
}

// Is the month lens ("YYYY-MM", "YYYY" or "all") showing this entry?
export function inLens(entry, lens) {
  if (lens === "all") return true;
  const month = monthOf(entry);
  return /^\d{4}$/.test(lens) ? month.startsWith(lens) : month === lens;
}

export function filterEntries(entries, filters, { hasEvidence = () => true } = {}) {
  const query = filters.q.toLowerCase();
  return entries.filter((entry) => {
    if (filters.account && accountOf(entry) !== filters.account) return false;
    if (filters.dir && entryDirection(entry) !== filters.dir) return false;
    if (filters.category && String(entry.category || "").trim() !== filters.category) return false;
    if (filters.needs === "category" && !needsCategory(entry)) return false;
    if (filters.needs === "receipt" && hasEvidence(entry.id)) return false;
    if (query) {
      const haystack = [
        entry.counterparty, entry.description, entry.statementRef, entry.subtype,
        entry.category, entry.period, entry.comment, entry.amount, entry.amountEur,
      ].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const byDateAsc = (a, b) =>
  String(a.transactionDate || "").localeCompare(String(b.transactionDate || "")) ||
  String(a.sourceKey || a.id).localeCompare(String(b.sourceKey || b.id), undefined, { numeric: true });

// Months newest first; inside a month the sheet's order (oldest first).
export function groupByMonth(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const month = monthOf(entry);
    (groups.get(month) ?? groups.set(month, []).get(month)).push(entry);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)))
    .map(([month, rows]) => {
      const sorted = [...rows].sort(byDateAsc);
      let moneyIn = 0, moneyOut = 0, unconverted = 0;
      for (const entry of sorted) {
        const value = eurValue(entry);
        if (value === null) unconverted += 1;
        else if (value >= 0) moneyIn += value;
        else moneyOut += value;
      }
      return { month, entries: sorted, moneyIn, moneyOut, unconverted };
    });
}

function signedAmount(value, currency) {
  if (value === null) return "";
  const text = formatAmount(Math.abs(value), currency);
  return value < 0 ? `−${text}` : `+${text}`;
}

// One date when transaction and paid dates agree; the paid date, muted,
// only when it differs.
function dateCell(entry, e) {
  const sent = String(entry.transactionDate || "");
  const paid = String(entry.paidDate || "");
  const paidNote = paid && paid !== sent
    ? html`<span class="bk-date__paid" title="Paid ${e(ledgerDate(paid))}">paid ${e(ledgerDate(paid))}</span>`
    : "";
  return html`<time datetime="${e(sent)}">${e(ledgerDate(sent))}</time>${paidNote}`;
}

function selectMarkup({ id, field, label, value, options, e }) {
  const current = String(value ?? "").trim();
  const list = current && !options.some((o) => o === current) ? [...options, current] : options;
  return html`<select class="bk-inline-select" data-inline-field="${field}" data-id="${e(id)}" aria-label="${e(label)}">
      <option value=""${current ? "" : " selected"}>—</option>
      ${list.map((option) => html`<option value="${e(option)}"${option === current ? " selected" : ""}>${e(option)}</option>`).join("")}
    </select>`;
}

const icon = {
  receipt: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<path d="M4 1.5h8v13l-2-1.2-2 1.2-2-1.2-2 1.2z" stroke-linejoin="round"/>'
    + '<path d="M6 5.5h4M6 8h4" stroke-linecap="round"/></svg>',
};

export function ledgerRowMarkup(entry, { hasEvidence, vocab, selectedId, e }) {
  const direction = entryDirection(entry);
  const eur = eurValue(entry);
  const original = originalValue(entry);
  const missingEur = eur === null;
  const evidence = hasEvidence(entry.id);
  const flagged = needsCategory(entry);
  const description = String(entry.description || "");
  const showDescription = description && description !== entry.counterparty;
  return html`<tr class="bk-row${flagged ? " is-uncategorised" : ""}${direction === "income" ? " is-income" : ""}"
      data-tx="${e(entry.id)}"${entry.id === selectedId ? ' aria-selected="true"' : ""}>
      <td class="bk-col-date">${dateCell(entry, e)}</td>
      <td class="bk-col-who">
        <a class="bk-who" href="?tx=${encodeURIComponent(entry.id)}" data-open-tx="${e(entry.id)}"
          ><span class="bk-who__name">${e(entry.counterparty || "—")}</span
          >${showDescription ? html`<span class="bk-who__what" title="${e(description)}">${e(description)}</span>` : ""}</a
        >
      </td>
      <td class="bk-col-money bk-col-original">${original === null ? "" : e(signedAmount(original, entry.currency))}</td>
      <td class="bk-col-money bk-col-eur${missingEur ? " is-missing" : ""}">${missingEur
        ? html`<span class="bk-missing" title="No EUR value recorded yet">EUR?</span>`
        : e(signedAmount(eur, "EUR"))}</td>
      <td class="bk-col-account">${e(accountOf(entry))}</td>
      ${CLASSIFICATION_FIELDS.map(({ field, label }) => html`<td class="bk-col-class bk-col-${field}">${selectMarkup({
        id: entry.id, field, label: `${label} for ${entry.counterparty || "transaction"}`,
        value: entry[field], options: vocab[field] || [], e,
      })}</td>`).join("")}
      <td class="bk-col-flag">${evidence
        ? ""
        : html`<span class="bk-flag" title="No receipt attached" aria-label="No receipt">${icon.receipt}</span>`}</td>
    </tr>`;
}

export function ledgerHeadMarkup() {
  return html`<thead>
      <tr>
        <th scope="col" class="bk-col-date">Date</th>
        <th scope="col" class="bk-col-who">Counterparty · what</th>
        <th scope="col" class="bk-col-money bk-col-original">Original</th>
        <th scope="col" class="bk-col-money bk-col-eur">EUR</th>
        <th scope="col" class="bk-col-account">Account</th>
        ${CLASSIFICATION_FIELDS.map(({ field, label }) => html`<th scope="col" class="bk-col-class bk-col-${field}">${label}</th>`).join("")}
        <th scope="col" class="bk-col-flag"><span class="dk-visually-hidden">Receipt</span></th>
      </tr>
    </thead>`;
}

const COLUMN_COUNT = 9;

export function ledgerTableMarkup({ groups, hasEvidence, vocab, selectedId, e }) {
  const body = groups.map((group) => {
    const totals = [
      group.moneyOut ? html`<span class="bk-total">out <span class="dk-mono">${e(signedAmount(group.moneyOut, "EUR"))}</span></span>` : "",
      group.moneyIn ? html`<span class="bk-total">in <span class="dk-mono">${e(signedAmount(group.moneyIn, "EUR"))}</span></span>` : "",
      group.unconverted ? html`<span class="bk-total is-missing">${group.unconverted} without EUR</span>` : "",
    ].filter(Boolean).join("");
    return html`<tbody class="bk-month" data-month="${e(group.month)}">
        <tr class="bk-month__head">
          <th scope="rowgroup" colspan="${COLUMN_COUNT}">
            <span class="bk-month__title">${e(group.month ? monthLabel(group.month) : "No date")}</span>
            <span class="bk-month__count dk-mono">${group.entries.length}</span>
            <span class="bk-month__totals">${totals}</span>
          </th>
        </tr>
        ${group.entries.map((entry) => ledgerRowMarkup(entry, { hasEvidence, vocab, selectedId, e })).join("")}
      </tbody>`;
  }).join("");
  return html`<table class="bk-table">${ledgerHeadMarkup()}${body}</table>`;
}

export function emptyLedgerMarkup({ lensTitle, filtered, latest, e }) {
  if (filtered)
    return html`<div class="dk-empty dk-empty--compact">
        <p class="dk-empty__title">No transactions match these filters</p>
        <p class="dk-empty__desc"><button type="button" class="dk-button dk-button--secondary dk-button--sm" data-clear-filters>Clear filters</button></p>
      </div>`;
  return html`<div class="dk-empty dk-empty--compact">
      <p class="dk-empty__title">No transactions recorded for ${e(lensTitle)}</p>
      ${latest ? html`<p class="dk-empty__desc">The latest recorded transaction is from ${e(ledgerDate(latest))}.</p>` : ""}
    </div>`;
}

// ---- detail panel ----------------------------------------------------------

const DETAIL_FIELDS = [
  { name: "transactionDate", label: "Date", type: "date" },
  { name: "paidDate", label: "Paid", type: "date" },
  { name: "counterparty", label: "Counterparty", wide: true },
  { name: "description", label: "What", wide: true },
  { name: "amount", label: "Amount", inputmode: "decimal" },
  { name: "currency", label: "Currency", maxlength: 3 },
  { name: "amountEur", label: "EUR value", inputmode: "decimal", foreignOnly: true },
  { name: "entryType", label: "Direction", select: [["expense", "Expense (money out)"], ["income", "Income (money in)"]] },
  { name: "statementRef", label: "Account / statement", wide: true },
  { name: "subtype", label: "Type", list: "subtype" },
  { name: "category", label: "Category", list: "category" },
  { name: "period", label: "Period", list: "period" },
  { name: "quantity", label: "Count", inputmode: "numeric" },
  { name: "vatAmount", label: "VAT", inputmode: "decimal" },
  { name: "vatCurrency", label: "VAT currency", maxlength: 3 },
  { name: "comment", label: "Comment", wide: true, textarea: true },
];

function detailFieldMarkup(field, entry, e) {
  const raw = entry[field.name];
  const value = raw === null || raw === undefined ? "" : String(raw);
  const id = `bk-detail-${field.name}`;
  let control;
  if (field.select) {
    const current = value.toLowerCase();
    control = html`<select class="dk-select" id="${id}" name="${field.name}">
        <option value=""${current ? "" : " selected"}>Unclassified</option>
        ${field.select.map(([option, label]) => html`<option value="${option}"${option === current ? " selected" : ""}>${label}</option>`).join("")}
      </select>`;
  } else if (field.textarea) {
    control = html`<textarea class="dk-textarea" id="${id}" name="${field.name}" rows="2">${e(value)}</textarea>`;
  } else {
    control = html`<input class="dk-input" id="${id}" name="${field.name}" value="${e(value)}"${
      field.type ? ` type="${field.type}"` : ""}${field.inputmode ? ` inputmode="${field.inputmode}"` : ""}${
      field.maxlength ? ` maxlength="${field.maxlength}"` : ""}${field.list ? ` list="bk-list-${field.list}"` : ""} autocomplete="off" />`;
  }
  return html`<div class="bk-field${field.wide ? " bk-field--wide" : ""}" data-field="${field.name}">
      <label class="dk-label" for="${id}">${field.label}</label>
      ${control}
      <small class="bk-field__error" data-field-error></small>
    </div>`;
}

function documentLabel(document, humanize) {
  const type = humanize ? humanize(document.documentType || "document") : String(document.documentType || "document");
  const size = Number(document.verifiedByteSize || document.byteSize || 0);
  const kb = size ? ` · ${Math.max(1, Math.round(size / 1024))} KB` : "";
  return `${type} PDF${kb}`;
}

const capitalize = (text) => String(text || "").replace(/^./, (letter) => letter.toUpperCase());

/**
 * Suggested matches for the open transaction: unattached invoices or receipts
 * whose date, amount or provider fit, and sponsor deals still waiting for this
 * money or holding a payment recorded before this row existed. Each is a suggestion the operator confirms.
 */
export function suggestionsMarkup({ suggestions, humanize, e }) {
  if (!suggestions) return html`<p class="bk-suggest__none">Looking for matches…</p>`;
  const documents = suggestions.documents || [];
  const deals = suggestions.sponsor?.deals || [];
  if (!documents.length && !deals.length)
    return html`<p class="bk-suggest__none">No matching invoice or sponsor deal found.</p>`;
  const why = (reasons) => e(capitalize((reasons || []).join(", ")));
  const documentItems = documents.map((item) => {
    const facts = item.facts || {};
    const type = humanize ? humanize(item.documentType || "document") : String(item.documentType || "document");
    const parts = [facts.counterparty, facts.amount ? formatAmount(facts.amount, facts.currency) : "", facts.transactionDate ? ledgerDate(facts.transactionDate) : ""]
      .filter(Boolean)
      .map((part) => e(part));
    return html`<li class="bk-suggest">
        <div class="bk-suggest__text">
          <span class="bk-suggest__name">${e(type)}${parts.length ? html` · ${parts.join(" · ")}` : ""}</span>
          <span class="bk-suggest__why">${why(item.reasons)}</span>
        </div>
        <div class="bk-suggest__actions">
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-view-document="${e(item.id)}">View</button>
          <button type="button" class="dk-button dk-button--primary dk-button--sm" data-attach-suggestion="${e(item.id)}">Attach</button>
        </div>
      </li>`;
  });
  const dealItems = deals.map((deal) => html`<li class="bk-suggest">
      <div class="bk-suggest__text">
        <span class="bk-suggest__name">Sponsor deal · ${e(deal.organizationName || "Sponsor")}${deal.dealTitle ? html` · ${e(deal.dealTitle)}` : ""}${
          Number(deal.outstanding) > 0 ? html` · ${e(formatAmount(deal.outstanding, deal.currency))} outstanding` : ""}</span>
        <span class="bk-suggest__why">${why(deal.reasons)}. Link the payment in the deal.</span>
      </div>
      <div class="bk-suggest__actions">
        <a class="dk-button dk-button--secondary dk-button--sm" href="${e(sponsorRecordPath("deal", deal.dealId))}">Open deal</a>
      </div>
    </li>`);
  return html`<ul class="bk-suggests">${[...documentItems, ...dealItems].join("")}</ul>`;
}

/**
 * Suggestions per transaction, fetched when its details open and dropped
 * whenever attachments change. `holder(id)` is the element to fill, or null
 * once another transaction is open.
 */
export function suggestionLoader({ load, holder, render }) {
  const cache = new Map();
  const fill = (id) => {
    const target = holder(id);
    if (target) target.innerHTML = render(cache.get(id) || null);
  };
  return {
    clear: () => cache.clear(),
    show(id) {
      if (cache.has(id)) return fill(id);
      load(id)
        .then((result) => {
          cache.set(id, result);
          fill(id);
        })
        .catch(() => {
          const target = holder(id);
          if (target) target.textContent = "Suggestions are unavailable right now.";
        });
    },
  };
}

export function detailMarkup({ entry, documents, vocab, humanize, e }) {
  const eur = eurValue(entry);
  const original = originalValue(entry);
  const foreign = String(entry.currency || "EUR").toUpperCase() !== "EUR";
  const fields = DETAIL_FIELDS.filter((field) => !field.foreignOnly || foreign)
    .map((field) => detailFieldMarkup(field, entry, e)).join("");
  const datalists = CLASSIFICATION_FIELDS.map(({ field }) => html`<datalist id="bk-list-${field}">${
    (vocab[field] || []).map((option) => html`<option value="${e(option)}"></option>`).join("")}</datalist>`).join("");
  const receipts = documents.length
    ? html`<ul class="bk-receipts">${documents.map((document) => html`<li class="bk-receipt">
          <span class="bk-receipt__name">${e(documentLabel(document, humanize))}</span>
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-view-document="${e(document.id)}">View</button>
        </li>`).join("")}</ul>`
    : html`<p class="bk-receipts__none">No receipt attached.</p>`;
  return html`<div class="dk-split__head bk-detail__head">
      <button type="button" class="dk-split__back" data-close-detail>
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M10 3 5 8l5 5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Transactions
      </button>
      <h2 class="dk-split__title" id="bk-detail-title">${e(entry.counterparty || "Transaction")}</h2>
      <button type="button" class="dk-icon-button dk-icon-button--sm bk-detail__close" data-close-detail aria-label="Close details">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="dk-split__scroll bk-detail__scroll">
      <p class="bk-detail__summary">
        <span class="bk-detail__amount dk-mono${eur !== null && eur >= 0 ? " is-income" : ""}">${
          eur === null ? "EUR value missing" : e(signedAmount(eur, "EUR"))}</span>
        ${original !== null ? html`<span class="bk-detail__original dk-mono">${e(signedAmount(original, entry.currency))}</span>` : ""}
        <span class="bk-detail__date">${e(ledgerDate(entry.transactionDate))}</span>
      </p>
      <section class="bk-detail__section" aria-labelledby="bk-receipt-heading">
        <h3 class="bk-detail__subhead" id="bk-receipt-heading">Invoice / receipt</h3>
        ${receipts}
        ${entry.sponsorDealId ? html`<p class="bk-sponsor-link">Payment for a sponsor deal; the deal holds its amount and date.
          <a href="${e(sponsorRecordPath("deal", entry.sponsorDealId))}">Open deal</a></p>` : ""}
        <div class="bk-attach">
          <label class="dk-label" for="bk-attach-type">Attach a PDF</label>
          <div class="bk-attach__row">
            <select class="dk-select" id="bk-attach-type" data-attach-type>
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
            </select>
            <input class="dk-input" type="file" accept="application/pdf,.pdf" data-attach-file aria-label="PDF file" />
          </div>
        </div>
      </section>
      <section class="bk-detail__section" aria-labelledby="bk-suggest-heading">
        <h3 class="bk-detail__subhead" id="bk-suggest-heading">Suggested matches</h3>
        <div data-suggestions>${suggestionsMarkup({ suggestions: null, humanize, e })}</div>
      </section>
      <form class="bk-detail__form" data-detail-form data-id="${e(entry.id)}" novalidate>
        <h3 class="bk-detail__subhead">Details</h3>
        <p class="bk-detail__hint">Changes save as you leave each field. Amounts are positive; Direction sets the sign.</p>
        <div class="bk-fields">${fields}</div>
        ${datalists}
      </form>
      <div class="bk-detail__danger">
        <button type="button" class="dk-button dk-button--danger dk-button--sm" data-delete="${e(entry.id)}">Delete transaction</button>
      </div>
    </div>`;
}
