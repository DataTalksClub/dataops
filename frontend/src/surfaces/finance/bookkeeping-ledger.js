// The transaction table: one dense row per transaction, the same columns
// as the bookkeeping spreadsheet it replaces (date, counterparty, what,
// original amount, EUR amount, account, type, category). Pure
// functions from records to markup and from URL state to filters; the
// surface (bookkeeping.js) owns fetching, events and saving.
import { sponsorRecordPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";
import { cashDate, entryDirection, formatAmount, ledgerDate, monthLabel, monthOf } from "./bookkeeping-format.js";
import { bookkeepingVendorPresentation } from "./bookkeeping-vendors.js";

// Query parameters the bookkeeping route keeps in the URL.
export const LEDGER_PARAMS = ["month", "q", "account", "dir", "category", "tx", "view"];
export const SECONDARY_VIEWS = ["files", "package", "invoices", "tuition"];

// The classification columns: "Type" is stored as `subtype`, "Category" as
// `category`. The spreadsheet's Period column is not shown in the table: it
// was copied in with the sheet layout (efdd13e5), nobody asked for it.
export const CLASSIFICATION_FIELDS = [
  { field: "subtype", label: "Type" },
  { field: "category", label: "Category" },
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
  const linked = (Array.isArray(documents) ? documents : []).filter((document) =>
    ids.has(String(document.id || ""))
      && document.status === "active"
      && INVOICE_EVIDENCE_TYPES.has(String(document.documentType || "")),
  );
  return linked.length ? linked : invoiceSourceDocuments(entry);
}

export const INVOICE_SOURCE_PREFIX = "invoice:";

/**
 * Rows the invoice intake booked (sourceType "invoice") hold their PDF as the
 * confirmed invoice's source artifact, not as a bookkeeping document link, so
 * /links never lists it. The month package already resolves it that way; the
 * table does the same and opens it through /invoices/:id/document.
 */
export function invoiceSourceDocuments(entry) {
  const invoiceId = String(entry?.invoiceId || "").trim();
  if (!invoiceId || !String(entry?.documentArtifactId || "").trim()) return [];
  const number = String(entry.invoiceNumber || "").trim();
  return [{
    id: `${INVOICE_SOURCE_PREFIX}${invoiceId}`,
    status: "active",
    documentType: "invoice",
    originalFilename: number ? `Invoice ${number}` : `Invoice from ${entry.counterparty || "vendor"}`,
  }];
}

// URL state -> filters. Unknown values fall back to "show everything".
export function filtersFromParams(params) {
  const get = (name) => String(params?.get?.(name) || "").trim();
  const dir = get("dir");
  return {
    q: get("q"),
    account: get("account"),
    dir: ["expense", "income"].includes(dir) ? dir : "",
    category: get("category"),
  };
}

// Is the month lens ("YYYY-MM", "YYYY" or "all") showing this entry?
export function inLens(entry, lens) {
  if (lens === "all") return true;
  const month = monthOf(entry);
  return /^\d{4}$/.test(lens) ? month.startsWith(lens) : month === lens;
}

const BANK_ONLY_EXCEPTION_LABELS = {
  owner_withdrawal: "Owner withdrawal",
  bank_fee: "Bank fee",
  tk_debit: "TK health insurance debit",
  tax_debit: "Tax debit",
  tax_refund: "Tax refund",
};

/** Project classified, unmatched statement lines into the internal ledger view. */
export function bankOnlyEntryFromMonthRow(row) {
  const bank = row?.bank;
  const kind = String(row?.exception?.kind || "");
  const label = BANK_ONLY_EXCEPTION_LABELS[kind];
  if (!bank || row.ledger || !label || !bank.key) return null;
  const date = String(row.date || bank.date || "").slice(0, 10);
  const amount = Number(bank.amount ?? row.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount)) return null;
  return {
    id: `bank-only:${bank.key}`,
    sourceKey: `bank-only:${bank.key}`,
    transactionDate: date,
    paidDate: date,
    amount: String(Math.abs(amount)),
    currency: String(bank.currency || row.currency || "EUR"),
    entryType: amount < 0 ? "expense" : "income",
    counterparty: String(row.counterparty || bank.counterparty || label),
    description: String(row.description || bank.reference || label),
    statementRef: String(bank.wallet || bank.accountId || ""),
    subtype: label,
    category: label,
    period: date.slice(0, 7),
    reconciliationOnly: true,
    bankKey: String(bank.key || ""),
    reconciliationLabel: label,
    reconciliationState: row.exception.satisfied ? "confirmed" : "proof needed",
  };
}

export function filterEntries(entries, filters, { accountNameOf = resolveAccountName } = {}) {
  const query = filters.q.toLowerCase();
  return entries.filter((entry) => {
    if (filters.account && accountNameOf(entry) !== filters.account) return false;
    if (filters.dir && entryDirection(entry) !== filters.dir) return false;
    if (filters.category && String(entry.category || "").trim() !== filters.category) return false;
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

export function displayRowCount(entries = []) {
  return entries.reduce((count, entry) => {
    const allocations = Array.isArray(entry?.allocations) ? entry.allocations.length : 0;
    return count + Math.max(allocations, 1);
  }, 0);
}

export function readableTransactionDescription(entry) {
  const raw = String(entry?.description || "").trim();
  if (entry?.sponsorDealId && raw === `Sponsor payment for deal ${entry.sponsorDealId}`) {
    return "Sponsor payment";
  }
  return raw;
}

export function pendingInvoiceEntry(invoice) {
  if (!invoice || invoice.status !== "pending") return null;
  const fields = invoice.fields || {};
  const receivedDate = cashDate({ transactionDate: invoice.createdAt });
  return {
    id: `invoice-draft:${invoice.id}`,
    invoiceDraftId: invoice.id,
    pendingInvoiceDraft: true,
    invoiceStatus: invoice.status,
    transactionDate: fields.transactionDate || receivedDate,
    paidDate: fields.paidDate || "",
    useReceivedDate: !fields.transactionDate && !fields.paidDate && Boolean(receivedDate),
    counterparty: fields.counterparty || "Unidentified provider",
    description: fields.description || "",
    amount: fields.amount || "",
    currency: fields.currency || "EUR",
    amountEur: fields.amountEur,
    vatAmount: fields.vatAmount,
    vatEur: fields.vatAmountEur,
    reverseCharge: fields.reverseCharge,
    entryType: "expense",
    subtype: fields.subtype || "",
    category: fields.category || "",
    statementRef: fields.statementRef || "",
    invoiceNumber: fields.invoiceNumber || "",
    documentArtifactId: invoice.source?.artifactId || "",
    invoiceId: invoice.id,
  };
}

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
        if (entry.pendingInvoiceDraft) continue;
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

// The cash date is primary; the source transaction date remains in the record.
function dateCell(entry, e) {
  const date = cashDate(entry);
  if (!date) return "—";
  return html`<time datetime="${e(date)}"${entry.useReceivedDate ? ' title="Invoice received date"' : ""}>${e(ledgerDate(date))}</time>`;
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
  pdf: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<path d="M4 1.5h5.5L13 5v9.5H4z" stroke-linejoin="round"/>'
    + '<path d="M9.5 1.5V5H13" stroke-linejoin="round"/>'
    + '<path d="M6 8.5h4M6 11h3" stroke-linecap="round"/></svg>',
  bank: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<path d="M2 6 8 2.5 14 6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M3.5 6.5V12M6.5 6.5V12M9.5 6.5V12M12.5 6.5V12M2.5 12.5h11" stroke-linecap="round"/></svg>',
  missing: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<path d="M4 1.5h5.5L13 5v9.5H4z" stroke-linejoin="round" stroke-dasharray="2 1.6"/>'
    + '<path d="M6.5 9.5h3" stroke-linecap="round"/></svg>',
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<circle cx="8" cy="8" r="6"/>'
    + '<path d="M8 4.8V8l2.2 1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Invoice cell: always one control on the same axis. Attached -> one PDF icon
// (with a count when several); missing -> one muted dashed icon.
function invoiceCellMarkup(documents, hasAttachedFlag, e, txId) {
  const count = documents.length;
  if (count === 1) {
    const [document] = documents;
    const label = document.originalFilename || "invoice or receipt PDF";
    return html`<button type="button" class="dk-icon-button dk-icon-button--sm bk-cell-icon bk-cell-icon--invoice bk-evidence-view" data-view-document="${e(document.id)}"
        aria-label="View ${e(label)}" title="${e(label)}">${icon.pdf}</button>`;
  }
  if (count > 1)
    return html`<button type="button" class="dk-icon-button dk-icon-button--sm bk-cell-icon bk-cell-icon--invoice bk-evidence-view" data-open-tx="${e(txId)}"
        aria-label="${count} invoices attached, open details" title="${count} invoices attached">${icon.pdf}<span class="bk-cell-icon__count">${count}</span></button>`;
  if (hasAttachedFlag)
    return html`<span class="bk-cell-icon bk-cell-icon--invoice" title="Invoice attached" aria-label="Invoice attached">${icon.receipt}</span>`;
  return html`<span class="bk-cell-icon bk-cell-icon--missing" title="No invoice attached" aria-label="No invoice attached">${icon.missing}</span>`;
}

// Account cell: bank icon (opens the statement when matched), a muted bank
// icon with the account name in the tooltip when there is only a label, and
// a dash when there is nothing.
function accountCellMarkup(account, accountDoc, e) {
  const title = accountDoc?.statementPeriod ? `${account} — open ${accountDoc.statementPeriod} statement` : account;
  if (accountDoc?.statementDocumentId)
    return html`<button type="button" class="dk-icon-button dk-icon-button--sm bk-cell-icon bk-account-view" data-view-document="${e(accountDoc.statementDocumentId)}"
        aria-label="${e(title)}" title="${e(title)}">${icon.bank}</button>`;
  if (account)
    return html`<span class="bk-cell-icon bk-cell-icon--quiet" title="${e(account)}" aria-label="${e(account)}">${icon.bank}</span>`;
  return html`<span class="bk-cell-icon bk-cell-icon--empty" aria-label="No account" title="No account">—</span>`;
}

function sponsorDealLink(entry, counterparty, e) {
  if (!entry.sponsorDealId) return "";
  return html`<a class="bk-who__deal"
    href="${e(sponsorRecordPath("deal", entry.sponsorDealId))}" data-deal-link
    aria-label="Open sponsor deal for ${e(counterparty)}" title="Open sponsor deal">Deal</a>`;
}

export function ledgerRowMarkup(entry, { hasEvidence, hasInvoice = () => false, vocab, selectedId, financeEntry, statementLinks = new Map(), e }) {
  const isDraft = Boolean(entry.pendingInvoiceDraft);
  const direction = entryDirection(entry);
  const net = netValue(entry, financeEntry);
  const original = originalValue(entry);
  const originalText = original === null ? "" : signedAmount(original, entry.currency);
  const missingEur = net === null;
  const flagged = !isDraft && needsCategory(entry);
  const presentation = bookkeepingVendorPresentation(entry);
  const counterparty = String(entry.counterparty || "").trim() || presentation.canonicalCounterparty;
  const description = readableTransactionDescription(entry) || presentation.description;
  const showDescription = Boolean(description);
  const vat = vatPresentation(isDraft ? entry : financeEntry);
  const invoiceEvidence = isDraft ? invoiceSourceDocuments(entry) : hasInvoice(entry.id);
  const invoiceDocuments = Array.isArray(invoiceEvidence) ? invoiceEvidence : [];
  const hasInvoiceAttached = invoiceDocuments.length > 0 || invoiceEvidence === true;
  const account = resolveAccountName(entry, statementLinks);
  const accountDoc = statementLinks instanceof Map ? statementLinks.get(String(entry.id || "")) : null;
  const dealLink = sponsorDealLink(entry, counterparty, e);
  const draftStatus = isDraft
    ? html`<span class="dk-badge dk-badge--warning bk-draft-status"
        title="Unverified invoice draft — click to open invoice review">${icon.pending}<span>Pending review</span></span>`
    : "";
  const whoAnchor = isDraft
    ? html`<a class="bk-who" href="?view=invoices" data-open-invoice-review="${e(entry.invoiceDraftId)}"
        aria-label="Review pending invoice draft from ${e(counterparty)}"><span class="bk-who__name">${e(counterparty)}</span
        >${showDescription ? html`<span class="bk-who__what" title="${e(description)}">${e(description)}</span>` : ""}</a>`
    : html`<a class="bk-who" href="?tx=${encodeURIComponent(entry.id)}" data-open-tx="${e(entry.id)}"
        ><span class="bk-who__name">${e(counterparty)}</span
        >${showDescription ? html`<span class="bk-who__what" title="${e(description)}">${e(description)}</span>` : ""}</a>`;
  const whoCell = dealLink || draftStatus
    ? html`<div class="bk-who-cell">${whoAnchor}${draftStatus}${dealLink}</div>`
    : whoAnchor;
  return html`<tr class="bk-row${isDraft ? " bk-row--pending-draft" : ""}${flagged ? " is-uncategorised" : ""}${direction === "income" ? " is-income" : ""}"
      ${isDraft ? `data-pending-invoice="${e(entry.invoiceDraftId)}"` : `data-tx="${e(entry.id)}"`}${!isDraft && entry.id === selectedId ? ' aria-selected="true"' : ""}>
      <td class="bk-col-date">${dateCell(entry, e)}</td>
      <td class="bk-col-who">${whoCell}</td>
      <td class="bk-col-money bk-col-eur${missingEur ? " is-unconverted" : ""}"${!missingEur && originalText ? ` title="Original ${e(originalText)}"` : ""}>${missingEur
        ? html`<span class="bk-unconverted" title="No EUR value recorded yet — convert it before the report">${e(originalText || "EUR?")}</span>`
        : e(signedAmount(net, "EUR"))}</td>
      <td class="bk-col-vat"${vat ? ` title="${e(vatTitle(isDraft ? entry : financeEntry, vat))}"` : ""}>${e(vat || "—")}</td>
      ${CLASSIFICATION_FIELDS.map(({ field, label }) => isDraft
        ? html`<td class="bk-col-class bk-col-${field}">${e(entry[field] || "—")}</td>`
        : html`<td class="bk-col-class bk-col-${field}">${selectMarkup({
            id: entry.id, field, label: `${label} for ${entry.counterparty || "transaction"}`,
            value: entry[field], options: vocab[field] || [], e,
          })}</td>`).join("")}
      <td class="bk-col-flag">${invoiceCellMarkup(invoiceDocuments, hasInvoiceAttached, e, entry.id)}</td>
      <td class="bk-col-account">${accountCellMarkup(account, accountDoc, e)}</td>
    </tr>`;
}

function bankOnlyRowMarkup(entry, e) {
  const direction = entryDirection(entry);
  const eur = eurValue(entry);
  const original = originalValue(entry);
  const originalText = original === null ? "" : signedAmount(original, entry.currency);
  const missingEur = eur === null;
  const status = `${entry.reconciliationLabel} · ${entry.reconciliationState}`;
  return html`<tr class="bk-row bk-row--statement-only${direction === "income" ? " is-income" : ""}" data-bank-only="${e(entry.bankKey)}">
      <td class="bk-col-date">${dateCell(entry, e)}</td>
      <td class="bk-col-who">
        <span class="bk-who">
          <span class="bk-who__name">${e(entry.counterparty)}</span>
          <span class="bk-who__what" title="${e(entry.description)}">${e(entry.description)}</span>
          <span class="bk-who__what bk-statement-status">${e(status)}</span>
        </span>
      </td>
      <td class="bk-col-money bk-col-eur${missingEur ? " is-unconverted" : ""}"${!missingEur && originalText ? ` title="Original ${e(originalText)}"` : ""}>${missingEur
        ? html`<span class="bk-unconverted" title="No EUR value recorded for this statement row">${e(originalText || "EUR?")}</span>`
        : e(signedAmount(eur, "EUR"))}</td>
      <td class="bk-col-vat">—</td>
      ${CLASSIFICATION_FIELDS.map(({ field }) => html`<td class="bk-col-class bk-col-${field}">${e(entry[field] || "")}</td>`).join("")}
      <td class="bk-col-flag"><span class="bk-cell-icon bk-cell-icon--quiet"
        title="Bank statement line, no invoice needed" aria-label="Bank statement line">${icon.bank}</span></td>
      <td class="bk-col-account">${accountCellMarkup(accountOf(entry), null, e)}</td>
    </tr>`;
}

function allocationChildMarkup(entry, allocation, { getAllocationDocument = () => null, statementLinks = new Map(), e }) {
  const vatCurrency = String(allocation.vatCurrency || allocation.currency || entry.currency || "EUR")
    .trim()
    .toUpperCase();
  const vatEur = vatCurrency === "EUR" ? allocation.vatAmount : undefined;
  const child = {
    ...entry,
    ...allocation,
    vatAmount: allocation.vatAmount,
    vatCurrency: allocation.vatCurrency,
    vatEur,
    reverseCharge: allocation.reverseCharge,
    transactionDate: entry.transactionDate,
    paidDate: entry.paidDate,
    currency: allocation.currency || entry.currency,
    entryType: entry.entryType,
  };
  const net = netValue(child, { vatEur });
  const original = originalValue(child);
  const originalText = original === null ? "" : signedAmount(original, child.currency);
  const vat = vatPresentation(child);
  const document = getAllocationDocument(entry, allocation);
  const accountName = resolveAccountName(entry, statementLinks);
  const statementLink = statementLinks instanceof Map ? statementLinks.get(String(entry.id || "")) : null;
  const pdfAction = invoiceCellMarkup(document ? [document] : [], false, e, entry.id);
  const counterparty = allocation.counterparty || entry.counterparty || "";
  const dealLink = sponsorDealLink(entry, counterparty, e);
  const paymentLink = html`<a class="bk-who" href="?tx=${encodeURIComponent(entry.id)}" data-open-tx="${e(entry.id)}"
          aria-label="Open original payment for ${e(counterparty || "invoice")}">
          <span class="bk-who__name">${e(counterparty)}</span>
          <span class="bk-who__what" title="${e(allocation.description || "")}">${e(allocation.description || "")}</span>
        </a>`;
  return html`<tr class="bk-row bk-row--allocation-child" data-allocation-parent="${e(entry.id)}" data-allocation-document="${e(allocation.documentId || "")}">
      <td class="bk-col-date">${dateCell(child, e)}</td>
      <td class="bk-col-who">${dealLink ? html`<div class="bk-who-cell">${paymentLink}${dealLink}</div>` : paymentLink}</td>
      <td class="bk-col-money bk-col-eur${net === null ? " is-unconverted" : ""}"${net !== null && originalText ? ` title="Original ${e(originalText)}"` : ""}>${net === null
        ? html`<span class="bk-unconverted" title="No EUR value recorded for this invoice allocation">${e(originalText || "EUR?")}</span>`
        : e(signedAmount(net, "EUR"))}</td>
      <td class="bk-col-vat"${vat ? ` title="${e(vatTitle(child, vat))}"` : ""}>${e(vat || "—")}</td>
      ${CLASSIFICATION_FIELDS.map(({ field }) => html`<td class="bk-col-class bk-col-${field}">${e(allocation[field] || "")}</td>`).join("")}
      <td class="bk-col-flag">${pdfAction}</td>
      <td class="bk-col-account">${accountCellMarkup(accountName, statementLink, e)}</td>
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

const COLUMN_COUNT = 8;

// One totals row at the bottom of a month: money in and money out, no net.
// The figures are the Finance overview's own (financeTotals from
// /api/finance/summary) whenever that month is loaded, so the two pages show
// the same numbers; otherwise the visible rows are summed as an interim.
// Unconverted-row counts always come from the visible rows.
export function monthTotalsRowMarkup(group, financeTotals, e) {
  const moneyIn = Number(financeTotals?.moneyIn ?? group.moneyIn);
  const moneyOut = Math.abs(Number(financeTotals?.moneyOut ?? group.moneyOut));
  return html`<tr class="bk-month__totals-row">
      <th colspan="${COLUMN_COUNT}" scope="rowgroup" data-month-total="${e(group.month)}"${financeTotals ? " data-finance-total" : ""}>
        <span class="bk-month__totals-inner">
          <span class="bk-month__totals-label">Total</span>
          <span class="bk-month__totals-figures">
            <span class="bk-month__totals-figure">Money in <span class="dk-mono">${e(formatAmount(moneyIn, "EUR"))}</span></span>
            <span class="bk-month__totals-figure">Money out <span class="dk-mono">${e(formatAmount(moneyOut, "EUR"))}</span></span>
            ${group.unconverted ? html`<span class="bk-total is-missing">${group.unconverted} without EUR</span>` : ""}
          </span>
        </span>
      </th>
    </tr>`;
}

export function ledgerTableMarkup({
  groups,
  hasEvidence,
  hasInvoice = () => false,
  getAllocationDocument = () => null,
  vocab,
  selectedId,
  financeEntriesById = new Map(),
  financeMonthTotals = null,
  // A single-month lens already names the month in the period navigator, so
  // the in-table month group head would repeat it in every section.
  hideGroupHead = false,
  statementLinks = new Map(),
  e,
}) {
  const body = groups.map((group) => {
    const visibleRowCount = displayRowCount(group.entries);
    return html`<tbody class="bk-month" data-month="${e(group.month)}">
        ${hideGroupHead ? "" : html`<tr class="bk-month__head">
          <th scope="rowgroup" colspan="${COLUMN_COUNT}">
            <span class="bk-month__title">${e(group.month ? monthLabel(group.month) : "No date")}</span>
            <span class="bk-month__count dk-mono">${visibleRowCount}</span>
          </th>
        </tr>`}
        ${group.entries.map((entry) => {
          if (entry.reconciliationOnly) return bankOnlyRowMarkup(entry, e);
          const allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
          if (allocations.length) {
            return allocations
              .map((allocation) => allocationChildMarkup(entry, allocation, { getAllocationDocument, statementLinks, e }))
              .join("");
          }
          return ledgerRowMarkup(entry, { hasEvidence, hasInvoice, vocab, selectedId, financeEntry: financeEntriesById.get(entry.id), statementLinks, e });
        }).join("")}
        ${monthTotalsRowMarkup(group, typeof financeMonthTotals === "function" ? financeMonthTotals(group.month) : null, e)}
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
