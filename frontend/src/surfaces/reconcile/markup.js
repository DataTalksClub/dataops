// Month-end bank reconciliation markup: one table row per bank transaction
// and per unpaired ledger row, laid out like the old bookkeeping sheet so
// each row shows its bank side, its ledger side and its invoice/receipt
// together. Pure functions of the GET /api/reconcile/months/:period payload;
// `e` is the shared escaper.
import { FILTERS, filterCounts, matchOptions, rowActions, rowSides, STATUS_META, visibleRows } from "./model.js";

// Plain template concatenation; every interpolated value is escaped by the caller.
export function html(strings, ...values) {
  return strings.reduce((markup, segment, index) => markup + segment + (index < values.length ? values[index] : ""), "");
}

export function formatAmount(value) {
  const number = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(number)) return "–";
  const text = Math.abs(number).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return number < 0 && text !== "0.00" ? `−${text}` : text;
}

const money = (amount, currency, e) => html`<span class="recon-money">${formatAmount(amount)} <span class="recon-currency">${e(currency || "")}</span></span>`;
const when = (iso) => String(iso || "").replace("T", " ").slice(0, 16);
const shortId = (id) => (String(id).length > 10 ? `${String(id).slice(0, 8)}…` : String(id));

export const STAT_TILES = Object.freeze([
  { key: "matched", label: "Matched", filter: "matched" },
  { key: "bankWithoutInvoice", label: "Bank without invoice", filter: "no-invoice" },
  { key: "ledgerWithoutBank", label: "Ledger without payment proof", filter: "payment-proof-missing" },
  { key: "amountMismatch", label: "Amount mismatch", filter: "amount-mismatch" },
  { key: "needsReview", label: "Needs review", filter: "needs-review" },
  { key: "exceptions", label: "Exceptions", filter: "exceptions" },
]);

export function stateBadgeMarkup(month, e) {
  if (month.state === "closed") {
    const by = month.closed ? ` by ${e(month.closed.by)} · ${e(when(month.closed.at))}` : "";
    return html`<span class="dk-badge dk-badge--success" data-recon-state="closed">Closed${by}</span>`;
  }
  return html`<span class="dk-badge dk-badge--info" data-recon-state="open">Open</span>`;
}

export function confirmationMarkup(month, e) {
  const confirmation = month.exceptionConfirmation;
  if (!month.counters.exceptions && !confirmation) return "";
  if (!confirmation) return html`<span class="dk-badge dk-badge--warning" data-recon-confirmation="missing">Exceptions not confirmed</span>`;
  if (!confirmation.current) {
    return html`<span class="dk-badge dk-badge--warning" data-recon-confirmation="stale"
      title="Confirmed by ${e(confirmation.by)} at ${e(when(confirmation.at))}; the list changed since">Exceptions changed: re-confirm</span>`;
  }
  return html`<span class="dk-badge dk-badge--success" data-recon-confirmation="current"
    >${e(String(confirmation.count))} exceptions confirmed by ${e(confirmation.by)} · ${e(when(confirmation.at))}</span>`;
}

export function headerActionsMarkup(month) {
  const open = month.state !== "closed";
  return html`<button type="button" class="dk-button dk-button--secondary dk-button--sm" data-recon-csv>Download CSV</button>
    ${open && month.counters.exceptions ? html`<button type="button" class="dk-button dk-button--secondary dk-button--sm" data-recon-confirm
      title="Admin sign-off of this month's exception list">Confirm exceptions</button>` : ""}
    ${open
      ? html`<button type="button" class="dk-button dk-button--primary dk-button--sm" data-recon-close>Close month</button>`
      : html`<button type="button" class="dk-button dk-button--secondary dk-button--sm" data-recon-reopen>Reopen</button>`}`;
}

export function statsMarkup(month, filter, e) {
  return html`<div class="dk-stat-strip recon-stats" role="group" aria-label="Month counters">
    ${STAT_TILES.map((tile) => {
      const value = Number(month.counters[tile.key] || 0);
      const attention = tile.key !== "matched" && tile.key !== "exceptions" && value > 0;
      return html`<button type="button" class="dk-stat recon-stat${attention ? " recon-stat--attention" : ""}" data-recon-filter="${tile.filter}"
        aria-pressed="${filter === tile.filter}">
        <span class="dk-stat__label">${e(tile.label)}</span>
        <span class="dk-stat__value" data-recon-counter="${tile.key}">${e(String(value))}</span>
      </button>`;
    }).join("")}
  </div>`;
}

export function statementsMarkup(month, e) {
  if (!month.statements?.length) {
    return html`<p class="recon-muted" data-recon-statements>No bank statements uploaded for this month
      (<code>dataops reconcile upload --file … --account … --period ${e(month.period)}</code>).</p>`;
  }
  return html`<p class="recon-muted" data-recon-statements>Statements: ${month.statements.map((statement) =>
    html`<span class="dk-chip">${e(statement.accountId)}${statement.from ? ` ${e(statement.from)}–${e(statement.to || "")}` : ""}</span>`).join(" ")}</p>`;
}

export function filtersMarkup(rows, filter, e) {
  const counts = filterCounts(rows);
  return html`<div class="dk-tabs dk-tabs--sm recon-filters" role="radiogroup" aria-label="Filter rows by status">
    ${FILTERS.filter((item) => item.id === "all" || item.id === filter || counts[item.id]).map((item) => html`<button type="button" class="dk-tab" role="radio"
      aria-checked="${item.id === filter}" data-recon-filter="${item.id}">${e(item.label)} <span class="dk-count">${e(String(counts[item.id]))}</span></button>`).join("")}
  </div>`;
}

function statusCell(row, e) {
  const meta = STATUS_META[row.status] || { label: row.status, tone: "info" };
  return html`<td class="recon-status">
    <span class="dk-badge dk-badge--${meta.tone}" data-recon-status="${e(row.status)}">${e(meta.label)}</span>
    ${row.missing ? html`<p class="recon-missing-text">${e(row.missing)}</p>` : ""}
    ${row.pairBasis ? html`<p class="recon-sub">paired: ${e(row.pairBasis)}${row.amountDifference ? `, Δ ${e(row.amountDifference)}` : ""}</p>` : ""}
  </td>`;
}

function bankCell(row, e) {
  const bank = row.bank;
  if (!bank) {
    const proof = row.paymentProof;
    if (proof) {
      return html`<td class="recon-side" data-recon-side="bank">
        <span class="recon-sub">Payment proof</span>
        <button type="button" class="recon-link" data-recon-doc="${e(proof.documentId)}">${e(proof.filename || shortId(proof.documentId))}</button>
        <p class="recon-sub">${e(proof.by)} · ${e(when(proof.at))}</p></td>`;
    }
    return html`<td class="recon-side recon-side--missing" data-recon-side="bank" data-recon-missing="bank">No bank transaction</td>`;
  }
  return html`<td class="recon-side" data-recon-side="bank">
    <span class="recon-account">${e(bank.accountId)}${bank.wallet ? ` · ${e(bank.wallet)}` : ""}</span>
    <span>${e(bank.date)}</span><span>${money(bank.amount, bank.currency, e)}</span>
    ${bank.origAmount ? html`<span class="recon-sub">orig ${money(bank.origAmount, bank.origCurrency, e)}</span>` : ""}
    ${bank.reference ? html`<span class="recon-sub recon-reference">${e(bank.reference)}</span>` : ""}
  </td>`;
}

function ledgerCell(row, e) {
  const ledger = row.ledger;
  if (!ledger) return html`<td class="recon-side recon-side--missing" data-recon-side="ledger" data-recon-missing="ledger">No ledger row</td>`;
  return html`<td class="recon-side" data-recon-side="ledger">
    <a class="recon-link" href="/bookkeeping?tx=${encodeURIComponent(ledger.id)}" title="${e(ledger.id)}">${e(shortId(ledger.id))}</a>
    <span>${e(ledger.date)}</span><span>${money(ledger.amount, ledger.currency, e)}</span>
    ${ledger.category ? html`<span class="recon-sub">${e(ledger.category)}</span>` : ""}
  </td>`;
}

function documentsCell(row, e) {
  if (row.documents?.length) {
    return html`<td data-recon-side="documents"><ul class="recon-docs">${row.documents.map((doc, index) => html`<li>
      <button type="button" class="recon-link" data-recon-doc="${e(doc.id)}">${e(doc.label || `Document ${index + 1}`)}</button></li>`).join("")}</ul></td>`;
  }
  const covered = row.exception?.satisfied;
  return covered
    ? html`<td class="recon-muted" data-recon-side="documents">Not needed (${e(row.exception.kind)})</td>`
    : html`<td class="recon-side--missing" data-recon-side="documents" data-recon-missing="documents">No invoice</td>`;
}

function proofCell(row, e) {
  if (row.paymentProof) return html`<td><button type="button" class="recon-link" data-recon-doc="${e(row.paymentProof.documentId)}"
    >${e(row.paymentProof.filename || "Proof")}</button></td>`;
  if (row.bank) return html`<td class="recon-muted">Bank row</td>`;
  return html`<td class="recon-side--missing" data-recon-missing="proof">Missing</td>`;
}

function exceptionCell(row, e) {
  const exception = row.exception;
  if (!exception) {
    return row.classification && row.classification.kind !== "known_vendor"
      ? html`<td class="recon-muted">Looks like ${e(row.classification.kind)}</td>`
      : html`<td class="recon-muted">–</td>`;
  }
  return html`<td data-recon-exception="${e(exception.kind)}">
    <span class="dk-badge dk-badge--${exception.satisfied ? "success" : "warning"}">${e(exception.kind)}</span>
    <p class="recon-sub">${exception.satisfied ? "proof" : "needs"}: ${e(exception.proof)}${exception.evidence ? ` · ${e(exception.evidence)}` : ""}</p>
    ${exception.recorded?.note ? html`<p class="recon-sub">${e(exception.recorded.note)}</p>` : ""}
  </td>`;
}

export const ACTION_LABELS = Object.freeze({
  "attach-invoice": "Attach invoice",
  "attach-proof": "Attach proof",
  "create-ledger": "Create ledger row",
  match: "Match…",
  "confirm-pair": "Confirm match",
  unmatch: "Unmatch",
  exception: "Mark exception",
  "clear-exception": "Clear exception",
});

function actionsCell(row, open, e) {
  const actions = rowActions(row, { open });
  if (!actions.length) return html`<td class="recon-actions-cell recon-muted">–</td>`;
  return html`<td class="recon-actions-cell"><div class="recon-actions">${actions.map((action) => html`<button type="button" class="dk-button dk-button--secondary dk-button--sm"
    data-recon-action="${action}" data-recon-row="${e(row.id)}">${ACTION_LABELS[action]}</button>`).join("")}</div></td>`;
}

export function rowMarkup(row, open, e) {
  const description = row.description && row.description !== row.counterparty ? row.description : "";
  return html`<tr class="recon-row recon-row--${e(row.status)}" data-recon-row-id="${e(row.id)}">
    <td class="recon-nowrap">${e(row.date)}</td>
    ${statusCell(row, e)}
    <td class="recon-party"><strong>${e(row.counterparty)}</strong>${description ? html`<span class="recon-sub">${e(description)}</span>` : ""}</td>
    <td class="recon-num">${money(row.amount, row.currency, e)}</td>
    ${bankCell(row, e)}${ledgerCell(row, e)}${documentsCell(row, e)}${proofCell(row, e)}${exceptionCell(row, e)}
    ${actionsCell(row, open, e)}
  </tr>`;
}

export function tableMarkup(month, filter, e) {
  const rows = visibleRows(month.rows, filter);
  const open = month.state !== "closed";
  if (!rows.length) {
    const title = month.rows.length ? "No rows match this filter" : "No bank or ledger rows in this month";
    return html`<div class="dk-empty dk-empty--compact"><p class="dk-empty__title">${title}</p></div>`;
  }
  return html`<div class="recon-table-wrap" tabindex="0" role="region" aria-label="Reconciliation rows">
    <table class="dk-table recon-table">
      <caption class="dk-visually-hidden">Bank transactions and ledger rows for ${e(month.period)}</caption>
      <thead><tr>${["Date", "Status", "Counterparty", "Amount", "Bank transaction", "Ledger row", "Invoice / receipt", "Payment proof", "Exception", "Actions"]
        .map((label) => html`<th scope="col"${label === "Actions" ? ' class="recon-actions-cell"' : ""}>${label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => rowMarkup(row, open, e)).join("")}</tbody>
    </table>
  </div>`;
}

/** The 409 from close or confirm-exceptions: its message and every blocking row. */
export function blockersMarkup(error, e) {
  const blockers = Array.isArray(error?.blockers) ? error.blockers : [];
  const status = (value) => STATUS_META[value] || { label: value, tone: "warning" };
  return html`<div class="dk-callout dk-callout--danger recon-blockers" role="alert" data-recon-blockers>
    <div class="dk-callout__body">
      <p class="dk-callout__title">${e(error?.error || error?.message || "The month cannot close")}</p>
      ${blockers.length ? html`<ul class="recon-blocker-list">${blockers.map((blocker) => html`<li data-recon-blocker="${e(blocker.id)}">
        ${blocker.date ? html`<span class="recon-nowrap">${e(blocker.date)}</span> ` : ""}
        ${blocker.counterparty ? html`<strong>${e(blocker.counterparty)}</strong> ` : ""}
        ${blocker.amount !== undefined ? html`${money(blocker.amount, blocker.currency, e)} ` : ""}
        ${blocker.status ? html`<span class="dk-badge dk-badge--${status(blocker.status).tone}">${e(status(blocker.status).label)}</span> ` : ""}
        ${blocker.kind ? html`<span class="dk-badge dk-badge--warning">${e(blocker.kind)}</span> needs ${e(blocker.proof || "proof")} ` : ""}
        ${blocker.missing ? html`<span class="recon-sub">${e(blocker.missing)}</span>` : ""}
      </li>`).join("")}</ul>` : ""}
    </div>
  </div>`;
}

export function logMarkup(month, e) {
  const entries = [...(month.log || [])].reverse();
  const detail = (value) => (value && typeof value === "object" ? Object.entries(value).map(([key, item]) =>
    `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join(", ") : String(value ?? ""));
  return html`<details class="recon-log" data-recon-log>
    <summary>Activity log <span class="dk-count">${e(String(entries.length))}</span></summary>
    ${entries.length ? html`<ol class="recon-log__list">${entries.map((entry) => html`<li>
      <span class="recon-nowrap recon-sub">${e(when(entry.at))}</span> <strong>${e(entry.by)}</strong> ${e(entry.action)}
      ${entry.detail ? html`<span class="recon-sub">${e(detail(entry.detail))}</span>` : ""}</li>`).join("")}</ol>` : html`<p class="recon-muted">Nothing recorded yet.</p>`}
  </details>`;
}

export function monthBodyMarkup(month, filter, e) {
  return html`${statsMarkup(month, filter, e)}
    ${statementsMarkup(month, e)}
    ${filtersMarkup(month.rows, filter, e)}
    ${tableMarkup(month, filter, e)}
    ${logMarkup(month, e)}`;
}

// ---- dialogs ---------------------------------------------------------------

const rowSummary = (row, e) => html`<p class="recon-dialog-row">${e(row.date)} · <strong>${e(row.counterparty)}</strong> · ${money(row.amount, row.currency, e)}</p>`;

const dialogFrame = (title, row, body, submit, e) => html`<form method="dialog" data-recon-form>
  <header class="dk-dialog__head"><div><h2>${e(title)}</h2></div></header>
  <div class="dk-dialog__body">${row ? rowSummary(row, e) : ""}${body}<p class="dk-field-error" data-recon-dialog-error role="alert" hidden></p></div>
  <footer class="dk-dialog__foot">
    <button type="button" class="dk-button dk-button--secondary" data-recon-cancel>Cancel</button>
    ${submit ? html`<button type="submit" class="dk-button dk-button--primary" data-recon-submit>${e(submit)}</button>` : ""}
  </footer>
</form>`;

const field = (label, control) => html`<label class="recon-field"><span class="dk-label">${label}</span>${control}</label>`;

export function attachDialogMarkup(row, purpose, e) {
  const proof = purpose === "proof";
  const bankOnly = rowSides(row).kind === "bank";
  const hint = proof
    ? "A PayPal or other statement, or a card receipt, that shows this payment. It stands in for the missing bank transaction."
    : bankOnly
      ? "The invoice or receipt for this bank transaction. A ledger row is created from the bank row with the document attached."
      : "The invoice or receipt for this ledger row.";
  const body = html`<p class="recon-muted">${hint}</p>
    <label class="recon-drop" data-recon-drop>
      <input type="file" accept="application/pdf" class="dk-visually-hidden" data-recon-file>
      <span class="recon-drop__title">Drop a PDF here or choose a file</span>
      <span class="recon-sub" data-recon-file-name>No file chosen</span>
    </label>
    ${!proof && bankOnly ? field("Category (optional)", html`<input class="dk-input" name="category" autocomplete="off">`) : ""}`;
  return dialogFrame(proof ? "Attach payment proof" : "Attach invoice", row, body, "Upload and attach", e);
}

export function ledgerDialogMarkup(row, e) {
  const suggested = row.classification?.category || "";
  const body = html`<p class="recon-muted">Books this bank transaction as a ledger row with the same date, amount and counterparty, paired with it.</p>
    ${field("Category", html`<input class="dk-input" name="category" value="${e(suggested)}" autocomplete="off">`)}
    ${field("Description", html`<input class="dk-input" name="description" value="${e(row.bank?.reference || "")}" autocomplete="off">`)}`;
  return dialogFrame("Create ledger row", row, body, "Create ledger row", e);
}

export function matchDialogMarkup(month, row, e) {
  const wantBank = rowSides(row).kind === "ledger";
  const options = matchOptions(month, row);
  const list = options.length
    ? html`<fieldset class="recon-options"><legend class="dk-label">${wantBank ? "Bank transactions" : "Ledger rows"}</legend>
      ${options.map((option, index) => html`<label class="recon-option">
        <input type="radio" name="other" value="${e(option.id)}"${index === 0 && option.score !== undefined ? " checked" : ""}>
        <span>${option.row ? html`${e(option.row.date)} · <strong>${e(option.row.counterparty)}</strong> · ${money(option.row.amount, option.row.currency, e)}`
          : html`<code>${e(option.id)}</code>`}
          ${option.score !== undefined ? html` <span class="dk-badge dk-badge--info">suggested ${e(String(Math.round(option.score * 100) / 100))}</span>` : ""}</span>
      </label>`).join("")}</fieldset>`
    : html`<p class="recon-muted">No unpaired ${wantBank ? "bank transactions" : "ledger rows"} in this month.</p>`;
  const body = html`${list}
    ${field(wantBank ? "Or a bank key" : "Or a ledger row id", html`<input class="dk-input" name="manual" autocomplete="off" spellcheck="false">`)}
    ${field("Note (optional)", html`<input class="dk-input" name="note" autocomplete="off">`)}`;
  return dialogFrame("Match row", row, body, "Match", e);
}

export function unmatchDialogMarkup(row, e) {
  const body = html`<p class="recon-muted">Splits the bank transaction from ledger row <code>${e(row.ledger?.id || "")}</code>.
    Automatic pairing will not pair them again.</p>
    ${field("Note (optional)", html`<input class="dk-input" name="note" autocomplete="off">`)}`;
  return dialogFrame("Unmatch row", row, body, "Unmatch", e);
}

export function exceptionDialogMarkup(month, row, e) {
  const suggested = row.classification?.kind;
  const policies = month.exceptionPolicies || [];
  const body = html`<p class="recon-muted">A row that legitimately has no invoice. Each kind needs its own proof instead.</p>
    ${field("Kind", html`<select class="dk-select" name="kind" required>${policies.map((policy) => html`<option value="${e(policy.kind)}"
      ${policy.kind === suggested ? " selected" : ""}>${e(policy.label)} (proof: ${e(policy.proof)})</option>`).join("")}</select>`)}
    ${field("Proof (optional)", html`<input class="dk-input" name="proof" autocomplete="off" placeholder="e.g. tax schedule reference">`)}
    ${field("Note (optional)", html`<input class="dk-input" name="note" autocomplete="off">`)}`;
  return dialogFrame("Mark exception", row, body, "Mark exception", e);
}

export function reopenDialogMarkup(month, e) {
  const body = html`<p class="recon-muted">Reopening ${e(month.period)} drops the exception confirmation; the approver confirms again before it closes.</p>
    ${field("Reason", html`<textarea class="dk-textarea" name="reason" rows="3" required></textarea>`)}`;
  return dialogFrame("Reopen month", null, body, "Reopen", e);
}
