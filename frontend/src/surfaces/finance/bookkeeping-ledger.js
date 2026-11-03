// The transaction table: one dense row per transaction, the same columns
// as the bookkeeping spreadsheet it replaces (date, counterparty, what,
// original amount, EUR amount, account, type, category, period). Pure
// functions from records to markup and from URL state to filters; the
// surface (bookkeeping.js) owns fetching, events and saving.
import { sponsorRecordPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";
import { cashDate, entryDirection, formatAmount, ledgerDate, monthLabel, monthOf } from "./bookkeeping-format.js";
import { bookkeepingVendorPresentation } from "./bookkeeping-vendors.js";

// Query parameters the bookkeeping route keeps in the URL.
export const LEDGER_PARAMS = ["month", "q", "account", "dir", "category", "needs", "tx", "view"];
export const SECONDARY_VIEWS = ["files", "package", "invoices", "tuition"];

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

// Short readable labels for statement refs on rows with no linked bank
// statement. Rows linked to an uploaded statement use its account name.
const SHORT_ACCOUNT_LABELS = Object.freeze([
  [/^revolut/i, "Revolut"],
  [/^finom/i, "Finom"],
  [/^n26\b/i, "N26"],
  [/^n96\b/i, "N26-personal"],
  [/^paypal/i, "PayPal"],
  [/^wise/i, "Wise"],
]);

export function shortAccountLabel(ref) {
  const text = String(ref || "").trim();
  if (!text) return "";
  if (/^[a-z]+:[a-z]+:/i.test(text) || text.length > 24) return "";
  for (const [pattern, label] of SHORT_ACCOUNT_LABELS) {
    if (pattern.test(text)) return label;
  }
  return text.split(/\s+/)[0];
}

// Display name for the account column: the uploaded statement's account
// name when the transaction is paired with a bank line, else the short
// label for its statement reference.
export function resolveAccountName(entry, statementLinks = new Map()) {
  const link = statementLinks instanceof Map ? statementLinks.get(String(entry?.id || "")) : null;
  if (link?.accountName) return link.accountName;
  return shortAccountLabel(accountOf(entry));
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

// Signed net EUR value: the gross amount minus VAT, in the transaction's
// direction. VAT-free rows keep their gross value.
export function netValue(entry, financeEntry) {
  const gross = eurValue(entry);
  if (gross === null) return null;
  const vat = Number(financeEntry?.vatEur);
  if (!Number.isFinite(vat) || vat === 0) return gross;
  return Math.round((gross - Math.sign(gross || 1) * Math.abs(vat)) * 100) / 100;
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

export function accountsOf(entries, statementLinks = new Map()) {
  return [...new Set(entries.map((entry) => resolveAccountName(entry, statementLinks)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

const INVOICE_EVIDENCE_TYPES = new Set([
  "invoice", "receipt", "credit-note", "credit_note", "other-evidence", "proof",
]);

/** Active invoice, receipt, credit note, and proof PDFs linked as evidence. */
export function linkedEvidenceDocuments(entry, links, documents) {
  if (!entry?.id) return [];
  const ids = new Set((Array.isArray(links) ? links : [])
    .filter((link) => link.transactionId === entry.id && link.coverageType === "evidence")
    .map((link) => String(link.documentId || "")));
  return (Array.isArray(documents) ? documents : []).filter((document) =>
    ids.has(String(document.id || ""))
      && document.status === "active"
      && INVOICE_EVIDENCE_TYPES.has(String(document.documentType || "")),
  );
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

export function filterEntries(entries, filters, { hasEvidence = () => true, accountNameOf = resolveAccountName } = {}) {
  const query = filters.q.toLowerCase();
  return entries.filter((entry) => {
    if (filters.account && accountNameOf(entry) !== filters.account) return false;
    if (filters.dir && entryDirection(entry) !== filters.dir) return false;
    if (filters.category && String(entry.category || "").trim() !== filters.category) return false;
    if (filters.needs === "category" && !needsCategory(entry)) return false;
    if (filters.needs === "receipt" && hasEvidence(entry.id)) return false;
    if (query) {
      const presentation = bookkeepingVendorPresentation(entry);
      const haystack = [
        entry.counterparty, presentation.canonicalCounterparty, presentation.description,
        entry.description, entry.statementRef, entry.subtype,
        entry.category, entry.period, entry.comment, entry.amount, entry.amountEur,
      ].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const byDateAsc = (a, b) =>
  cashDate(a).localeCompare(cashDate(b)) ||
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

export function vatPresentation(entry) {
  if (!entry) return "";
  const eurVat = entry.vatEur !== null && entry.vatEur !== undefined && String(entry.vatEur).trim() !== ""
    ? Number(entry.vatEur)
    : null;
  if (eurVat !== null && Number.isFinite(eurVat)) return formatAmount(eurVat, "EUR");
  if (entry.vatAmount !== null && entry.vatAmount !== undefined && String(entry.vatAmount).trim() !== "")
    return formatAmount(entry.vatAmount, entry.vatCurrency || entry.currency || "EUR");
  if (entry.reverseCharge) return "Reverse charge";
  return "";
}

/** Hover text for the VAT cell: reverse-charge rows explain themselves. */
export function vatTitle(entry, text) {
  if (entry?.reverseCharge) return "Reverse charge — VAT is accounted by the recipient";
  return text || "";
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

export function ledgerRowMarkup(entry, { hasEvidence, hasInvoice = () => false, vocab, selectedId, financeEntry, statementLinks = new Map(), e }) {
  const direction = entryDirection(entry);
  const net = netValue(entry, financeEntry);
  const original = originalValue(entry);
  const originalText = original === null ? "" : signedAmount(original, entry.currency);
  const missingEur = net === null;
  const flagged = needsCategory(entry);
  const presentation = bookkeepingVendorPresentation(entry);
  const counterparty = String(entry.counterparty || "").trim() || presentation.canonicalCounterparty;
  const description = String(entry.description || "").trim() || presentation.description;
  const showDescription = Boolean(description);
  const vat = vatPresentation(financeEntry);
  const invoiceEvidence = hasInvoice(entry.id);
  const invoiceDocuments = Array.isArray(invoiceEvidence) ? invoiceEvidence : [];
  const hasInvoiceAttached = invoiceDocuments.length > 0 || invoiceEvidence === true;
  const invoiceActions = invoiceDocuments.length
    ? invoiceDocuments.map((document) => html`<button type="button" class="dk-button dk-button--secondary dk-button--sm bk-evidence-view"
        data-view-document="${e(document.id)}"
        aria-label="View ${e(document.originalFilename || "invoice or receipt PDF")}"
        title="${e(document.originalFilename || "Invoice or receipt PDF")}">View PDF</button>`).join("")
    : hasInvoiceAttached
      ? html`<span class="bk-invoice-icon" title="Invoice attached" aria-label="Invoice attached">${icon.receipt}</span>`
      : html`<span class="bk-no-invoice">No invoice</span>`;
  const account = resolveAccountName(entry, statementLinks);
  const accountDoc = statementLinks instanceof Map ? statementLinks.get(String(entry.id || "")) : null;
  const accountCell = accountDoc?.statementDocumentId
    ? html`<button type="button" class="bk-account-link" data-view-document="${e(accountDoc.statementDocumentId)}" title="Open ${e(accountDoc.statementPeriod ? `${accountDoc.statementPeriod} statement` : "statement")}">${
      e(account)}</button>`
    : e(account || "—");
  return html`<tr class="bk-row${flagged ? " is-uncategorised" : ""}${direction === "income" ? " is-income" : ""}"
      data-tx="${e(entry.id)}"${entry.id === selectedId ? ' aria-selected="true"' : ""}>
      <td class="bk-col-date">${dateCell(entry, e)}</td>
      <td class="bk-col-who">
        <a class="bk-who" href="?tx=${encodeURIComponent(entry.id)}" data-open-tx="${e(entry.id)}"
          ><span class="bk-who__name">${e(counterparty)}</span
          >${showDescription ? html`<span class="bk-who__what" title="${e(description)}">${e(description)}</span>` : ""}</a
        >
      </td>
      <td class="bk-col-money bk-col-eur${missingEur ? " is-unconverted" : ""}"${!missingEur && originalText ? ` title="Original ${e(originalText)}"` : ""}>${missingEur
        ? html`<span class="bk-unconverted" title="No EUR value recorded yet — convert it before the report">${e(originalText || "EUR?")}</span>`
        : e(signedAmount(net, "EUR"))}</td>
      <td class="bk-col-vat"${vat ? ` title="${e(vatTitle(financeEntry, vat))}"` : ""}>${e(vat || "—")}</td>
      ${CLASSIFICATION_FIELDS.map(({ field, label }) => html`<td class="bk-col-class bk-col-${field}">${selectMarkup({
        id: entry.id, field, label: `${label} for ${entry.counterparty || "transaction"}`,
        value: entry[field], options: vocab[field] || [], e,
      })}</td>`).join("")}
      <td class="bk-col-flag">
        ${invoiceActions}
        ${hasEvidence(entry.id) ? "" : html`<span class="bk-flag" title="No receipt attached" aria-label="No receipt">${icon.receipt}</span>`}
      </td>
      <td class="bk-col-account">${accountCell}</td>
    </tr>`;
}

export function ledgerHeadMarkup() {
  return html`<thead>
      <tr>
        <th scope="col" class="bk-col-date">Date</th>
        <th scope="col" class="bk-col-who">Counterparty · what</th>
        <th scope="col" class="bk-col-money bk-col-eur">Net</th>
        <th scope="col" class="bk-col-vat">VAT</th>
        ${CLASSIFICATION_FIELDS.map(({ field, label }) => html`<th scope="col" class="bk-col-class bk-col-${field}">${label}</th>`).join("")}
        <th scope="col" class="bk-col-flag">Invoice</th>
        <th scope="col" class="bk-col-account">Account</th>
      </tr>
    </thead>`;
}

const COLUMN_COUNT = 9;

export function ledgerTableMarkup({ groups, hasEvidence, hasInvoice = () => false, vocab, selectedId, financeEntriesById = new Map(), statementLinks = new Map(), e }) {
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
        ${group.entries.map((entry) => ledgerRowMarkup(entry, { hasEvidence, hasInvoice, vocab, selectedId, financeEntry: financeEntriesById.get(entry.id), statementLinks, e })).join("")}
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
