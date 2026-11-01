import { bookkeepingVendorPresentation } from "./bookkeeping-vendors.js";

const text = (value) => String(value ?? "").trim();
const filled = (value) => text(value) !== "";

function requiredRenderers(escape, formatAmount) {
  if (typeof escape !== "function") throw new TypeError("escape must be a function");
  if (typeof formatAmount !== "function") throw new TypeError("formatAmount must be a function");
  return {
    e: (value) => escape(String(value ?? "")),
    amount: (value, currency) => String(formatAmount(value, currency)),
  };
}

function transactionSign(transaction) {
  return String(transaction?.entryType || "").toLowerCase().includes("income") ? 1 : -1;
}

function signedValue(value, sign) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.abs(amount) * sign : null;
}

function signedAmountMarkup(value, currency, formatAmount) {
  if (value === null) return "Not recorded";
  return formatAmount(value, currency);
}

function invoiceDocuments({ invoice, invoices, documents }) {
  if (Array.isArray(invoices)) return invoices;
  if (invoice) return Array.isArray(invoice) ? invoice : [invoice];
  if (Array.isArray(documents)) {
    return documents.filter((document) =>
      String(document?.documentType || "").toLowerCase() === "invoice",
    );
  }
  return [];
}

function invoiceMarkup(document, index, e) {
  const id = text(document?.id || document?.documentId);
  const filename = text(document?.filename || document?.originalFilename || document?.fileName || document?.name);
  const label = filename ? `Open invoice · ${filename}` : "Open invoice";
  const buttonParts = [
    '<button type="button" class="dk-button dk-button--primary dk-button--lg bk-transaction-invoice__open"',
    `data-view-document="${e(id)}"`,
    `aria-label="${e(label)}">${e(label)}</button>`,
  ];
  const control = id
    ? buttonParts.join(" ")
    : `<span class="bk-transaction-invoice__name">${e(filename || `Attached invoice ${index + 1}`)}</span>`;
  return `<li class="bk-transaction-invoice">${control}</li>`;
}

function invoiceSectionMarkup(documents, e) {
  if (!documents.length) {
    return `<section class="bk-transaction-invoices" aria-labelledby="bk-transaction-invoices-heading">
      <h3 id="bk-transaction-invoices-heading">Invoice</h3>
      <p class="bk-transaction-invoices__none">No invoice</p>
    </section>`;
  }
  return `<section class="bk-transaction-invoices" aria-labelledby="bk-transaction-invoices-heading">
    <h3 id="bk-transaction-invoices-heading">Invoice${documents.length === 1 ? "" : "s"}</h3>
    <ul class="bk-transaction-invoices__list">${documents.map((document, index) => invoiceMarkup(document, index, e)).join("")}</ul>
  </section>`;
}

function statementLineMarkup(statementLink, { e, amount }) {
  const line = statementLink.line || {};
  const lineAmount = filled(line.amount)
    ? amount(line.amount, line.currency || "EUR")
    : "Not recorded";
  const rowIndex = Number(statementLink.statementRowIndex);
  const sourceLine = statementLink.statementRowIndex !== null &&
    statementLink.statementRowIndex !== undefined && Number.isInteger(rowIndex) && rowIndex >= 0
    ? `<dt>Source parsed line</dt><dd>${e(rowIndex + 1)}</dd>`
    : "";
  const documentId = text(statementLink.statementDocumentId || statementLink.documentId);
  const artifactId = text(statementLink.statementArtifactId || statementLink.artifactId);
  const openStatement = documentId
    ? `<button type="button" class="dk-button dk-button--secondary" data-view-document="${e(documentId)}">Open statement</button>`
    : artifactId
      ? `<button type="button" class="dk-button dk-button--secondary" data-view-artifact="${e(artifactId)}">Open statement</button>`
      : `<button type="button" class="dk-button dk-button--secondary" disabled>Open statement</button>`;
  const details = [
    ["Account", statementLink.accountLabel],
    ["Statement period", statementLink.statementPeriod],
    ["Bank line date", line.date],
    ["Bank line amount", lineAmount],
    ["Raw counterparty", line.counterparty],
    ["Reference", line.reference],
  ].filter(([, value]) => filled(value));
  const bankKey = text(statementLink.bankKey);
  const lineDate = text(line.date);
  const period = /^\d{4}-\d{2}-\d{2}$/.test(lineDate)
    ? lineDate.slice(0, 7)
    : text(statementLink.statementPeriod);
  const reconcileHref = bankKey && /^\d{4}-\d{2}$/.test(period)
    ? `/finance/reconcile/${period}?bankKey=${encodeURIComponent(bankKey)}`
    : "";
  const recordTarget = documentId
    ? ` data-view-document="${e(documentId)}"`
    : artifactId
      ? ` data-view-artifact="${e(artifactId)}"`
      : " disabled";
  return `<section class="bk-transaction-statement" aria-labelledby="bk-transaction-statement-heading">
    <h3 id="bk-transaction-statement-heading">Matched statement line</h3>
    <button type="button" class="bk-transaction-statement__record"${recordTarget}>
      <span class="bk-transaction-statement__account">${e(statementLink.accountLabel || "Bank account")}</span>
      <span class="bk-transaction-statement__period">${e(statementLink.statementPeriod || "Statement period unavailable")}</span>
      <span class="bk-transaction-statement__line">${e(line.date || "Date unavailable")} · ${e(lineAmount)}</span>
      <span class="bk-transaction-statement__counterparty">${e(line.counterparty || "Counterparty unavailable")}</span>
      ${filled(line.reference) ? `<span class="bk-transaction-statement__reference">${e(line.reference)}</span>` : ""}
    </button>
    <dl class="bk-transaction-statement__facts">${details.map(([label, value]) =>
      `<dt>${e(label)}</dt><dd>${e(value)}</dd>`,
    ).join("")}${sourceLine}</dl>
    ${reconcileHref ? `<a class="dk-button dk-button--secondary" href="${e(reconcileHref)}">View matching line in reconciliation</a>` : ""}
    ${openStatement}
  </section>`;
}

function candidateLabel(candidate, { e, amount }) {
  const line = candidate?.line || {};
  const amountText = filled(line.amount) ? amount(line.amount, line.currency || "EUR") : "Amount unavailable";
  return [
    line.date || "Date unavailable",
    amountText,
    line.counterparty || "Counterparty unavailable",
    line.reference || "",
    candidate?.accountLabel || "",
  ].filter(Boolean).join(" · ");
}

function unmatchedStatementMarkup(candidates, renderers) {
  const { e } = renderers;
  const options = candidates.map((candidate) => {
    const bankKey = text(candidate?.bankKey);
    if (!bankKey) return "";
    return `<option value="${e(bankKey)}">${e(candidateLabel(candidate, renderers))}</option>`;
  }).join("");
  return `<section class="bk-transaction-statement bk-transaction-statement--unmatched" aria-labelledby="bk-transaction-statement-heading">
    <h3 id="bk-transaction-statement-heading">Statement</h3>
    <p class="bk-transaction-statement__none">Not matched to a statement</p>
    <label class="bk-transaction-statement__candidate-label">Potential statement matches
      <select data-statement-candidate${candidates.length ? "" : " disabled"}>
        ${candidates.length ? options : `<option value="">No matching statement rows available</option>`}
      </select>
    </label>
    <button type="button" class="dk-button dk-button--secondary" data-link-statement-row${candidates.length ? "" : " disabled"}>Link selected statement line</button>
  </section>`;
}

function pendingStatementMarkup({ e }, error = "") {
  const message = error
    ? `Could not load statement details: ${error}`
    : "Checking the linked statement line…";
  return `<section class="bk-transaction-statement" aria-labelledby="bk-transaction-statement-heading">
    <h3 id="bk-transaction-statement-heading">Statement</h3>
    <p class="bk-transaction-statement__none" role="status">${e(message)}</p>
    ${error ? `<button type="button" class="dk-button dk-button--secondary" data-retry-statement-link>Retry</button>` : ""}
  </section>`;
}

function fieldMarkup(label, value, e) {
  return `<div class="bk-transaction-field"><dt>${e(label)}</dt><dd>${value}</dd></div>`;
}

/**
 * Render a transaction's read-only accounting summary and evidence links.
 * The caller supplies attached documents, an optional resolved statement
 * link, candidate statement rows, and the application's escaping/amount
 * formatting functions.
 */
export function bookkeepingTransactionSummaryMarkup({
  transaction = {},
  invoice,
  invoices,
  documents,
  statementLink = null,
  statementCandidates = [],
  statementPending = false,
  statementError = "",
  escape,
  formatAmount,
} = {}) {
  const renderers = requiredRenderers(escape, formatAmount);
  const { e, amount } = renderers;
  const presentation = bookkeepingVendorPresentation(transaction);
  const sign = transactionSign(transaction);
  const currency = text(transaction.currency || "EUR").toUpperCase();
  const originalValue = signedValue(transaction.amount, sign);
  const eurSource = currency === "EUR" ? transaction.amount : transaction.amountEur;
  const eurValue = signedValue(eurSource, sign);
  const invoiceList = invoiceDocuments({ invoice, invoices, documents });
  const vatCurrency = text(transaction.vatCurrency || currency).toUpperCase();
  const vatValue = filled(transaction.vatAmount)
    ? amount(transaction.vatAmount, vatCurrency)
    : "No VAT recorded";
  const exchangeRate = text(transaction.exchangeRate);
  const transactionDate = text(transaction.transactionDate || transaction.paidDate || "Not recorded");
  const paidDate = filled(transaction.paidDate) && text(transaction.paidDate) !== transactionDate
    ? fieldMarkup("Paid date", e(transaction.paidDate), e)
    : "";
  const exchangeRateDate = filled(transaction.exchangeRateDate)
    ? ` · ${e(transaction.exchangeRateDate)}`
    : "";
  const exchangeRateSource = filled(transaction.exchangeRateSource)
    ? ` · ${e(transaction.exchangeRateSource)}`
    : "";
  const exchangeRateMarkup = exchangeRate
    ? `<div class="bk-transaction-field">
      <dt>Exchange rate</dt>
      <dd>1 EUR = ${e(exchangeRate)} ${e(currency)}${exchangeRateDate}${exchangeRateSource}</dd>
    </div>`
    : "";
  const vatExtra = [
    filled(transaction.vatRate)
      ? `${e(transaction.vatRate)}${String(transaction.vatRate).trim().endsWith("%") ? "" : "%"}`
      : "",
    transaction.reverseCharge === true || String(transaction.reverseCharge).toLowerCase() === "true" ? "Reverse charge" : "",
  ].filter(Boolean).join(" · ");
  const statementMarkup = statementLink
    ? statementLineMarkup(statementLink, renderers)
    : statementPending || statementError
      ? pendingStatementMarkup(renderers, statementError)
      : unmatchedStatementMarkup(Array.isArray(statementCandidates) ? statementCandidates : [], renderers);

  return `${invoiceSectionMarkup(invoiceList, e)}
    <section class="bk-transaction-summary" aria-labelledby="bk-transaction-summary-heading">
      <h3 id="bk-transaction-summary-heading">Transaction</h3>
      <h4 class="bk-transaction-summary__vendor">${e(presentation.canonicalCounterparty)}</h4>
      <p class="bk-transaction-summary__what"><span>What for</span> ${e(presentation.description)}</p>
      <dl class="bk-transaction-summary__facts">
        ${fieldMarkup("Raw bank name", e(presentation.rawCounterparty || "Unknown"), e)}
        ${fieldMarkup("Date", e(transactionDate), e)}
        ${paidDate}
        ${fieldMarkup("Original amount", e(signedAmountMarkup(originalValue, currency, amount)), e)}
        ${fieldMarkup("EUR amount", e(signedAmountMarkup(eurValue, "EUR", amount)), e)}
        ${exchangeRateMarkup}
        ${fieldMarkup("Category", e(text(transaction.category) || "Uncategorized"), e)}
        <div class="bk-transaction-field"><dt>VAT</dt><dd>${e(vatValue)}${vatExtra ? ` · ${vatExtra}` : ""}</dd></div>
      </dl>
    </section>
    ${statementMarkup}`;
}

/** Render an accessible native dialog shell around already-safe dialog content. */
export function bookkeepingTransactionDialogMarkup({
  title = "Transaction details",
  content = "",
  id = "bookkeeping-transaction-dialog",
  escape,
} = {}) {
  if (typeof escape !== "function") throw new TypeError("escape must be a function");
  const e = (value) => escape(String(value ?? ""));
  const dialogId = e(id);
  const titleId = `${dialogId}-title`;
  return `<dialog class="surface-dialog bk-transaction-dialog" id="${dialogId}" aria-labelledby="${titleId}">
    <header class="bk-transaction-dialog__header">
      <h2 id="${titleId}">${e(title)}</h2>
      <button type="button" class="bk-transaction-dialog__close" data-close-transaction-dialog aria-label="Close transaction details">Close</button>
    </header>
    <div class="bk-transaction-dialog__content">${content}</div>
  </dialog>`;
}
