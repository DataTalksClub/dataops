// Dynamic view templates for the bookkeeping surface. Pure functions from
// data to markup: no queries, no events — bookkeeping.js owns state and
// wiring, this module owns what the operator reads (#242 month lens).
import { html } from "./shared.js";
import { entryDirection, entryTypeLabel, formatAmount, ledgerDate } from "./bookkeeping-format.js";

// The close-state header: the month and one CTA that follows the month
// state. The open items themselves are the Needs attention list below; no
// counter tiles restate it (dakit principle 4, no vanity metrics).
export function closeStateMonthMarkup({ title, cta, e }) {
  // The page header's Add entry is the one solid primary; the close CTA is
  // secondary whatever the month state.
  const ctaButton =
    cta.kind === "worklist"
      ? html`<button class="dk-button dk-button--secondary" type="button" data-cta-worklist>
          <span>Review <span class="dk-mono">${cta.count}</span>&nbsp;open&nbsp;item${cta.count === 1 ? "" : "s"}</span>
        </button>`
      : cta.kind === "download"
        ? html`<button class="dk-button dk-button--secondary" type="button" data-cta-download>
            Download the monthly package
          </button>`
        : cta.kind === "package"
          ? html`<button class="dk-button dk-button--secondary" type="button" data-cta-package>
              Prepare the monthly package
            </button>`
          : cta.kind === "export"
            ? html`<button class="dk-button dk-button--secondary" type="button" data-export-report-csv>
                Export report data
              </button>`
            : html`<button class="dk-button dk-button--secondary" type="button" data-cta-add>
                Add the first entry
              </button>`;
  return html`<h2>${e(title)} close</h2>
    <div class="bookkeeping-close-cta">${ctaButton}</div>`;
}

export function closeStateAllMarkup(transactions) {
  return html`<p class="bookkeeping-lens-note">
    All months — <span class="dk-mono">${transactions}</span>&nbsp;transaction${transactions === 1 ? "" : "s"}
    on record. Select a month above to see its close state.
  </p>`;
}

// The reconcile rows in fix order: evidence, then conversions, then
// classification — every open item with its one-click fix.
export function worklistRowsFromOpenItems({
  missingEvidence,
  conversions,
  unclassified,
}) {
  return [
    ...missingEvidence.map((entry) => ({ kind: "evidence", entry })),
    ...conversions.map((entry) => ({ kind: "eur", entry })),
    ...unclassified.map((entry) => ({ kind: "classify", entry })),
  ];
}

// The one-line state the collapsed close panel shows next to its heading.
export function worklistHintMarkup(rows) {
  return rows.length
    ? html`<span class="dk-mono">${rows.length}</span>&nbsp;open&nbsp;item${rows.length === 1 ? "" : "s"}`
    : "All clear";
}

// The reconcile list: every open item with its fix one click away.
export function worklistMarkup({ rows, monthTitle, e }) {
  if (!rows.length) {
    return html`<p class="bookkeeping-worklist-done">
      ✓ Nothing needs attention for ${e(monthTitle)}.
    </p>`;
  }
  return rows
    .map(({ kind, entry }) => {
      const what = html`<strong>${e(entry.counterparty)}</strong>
        <small
          ><span class="dk-mono">${e(ledgerDate(entry.transactionDate))} ·
          ${e(formatAmount(entry.amount, entry.currency))}</span>${entry.description ? ` · ${e(entry.description)}` : ""}</small
        >`;
      const fix =
        kind === "evidence"
          ? html`<button class="dk-button dk-button--secondary dk-button--sm" type="button" data-attach-evidence="${e(entry.id)}">
              Attach evidence
            </button>`
          : kind === "eur"
            ? html`<button class="dk-button dk-button--secondary dk-button--sm" type="button" data-add-eur="${e(entry.id)}">
                Add EUR value
              </button>`
            : html`<label class="worklist-classify"
                >Classify
                <select data-classify="${e(entry.id)}">
                  <option value="">Choose…</option>
                  <option value="expense">Expense — money out</option>
                  <option value="income">Income — money in</option>
                </select></label
              >`;
      return html`<article class="worklist-row is-${kind}">
        <div class="worklist-what">${what}</div>
        <div class="row-actions">${fix}</div>
      </article>`;
    })
    .join("");
}

export function ledgerTableMarkup({ shown, hasEvidence, lensTitle, e }) {
  return shown.length
    ? html`<div class="bookkeeping-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Paid</th>
              <th>Provider / description</th>
              <th>Amount</th>
              <th>VAT</th>
              <th>Category / type</th>
              <th>Evidence</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${shown
              .map(
                (entry) =>
                  html`<tr>
                    <td data-label="Transaction date" class="dk-mono">
                      ${e(ledgerDate(entry.transactionDate))}
                    </td>
                    <td data-label="Paid" class="${entry.paidDate ? "is-paid dk-mono" : "is-unpaid"}">
                      ${e(entry.paidDate ? ledgerDate(entry.paidDate) : "Unpaid")}
                    </td>
                    <td data-label="Entry">
                      <div><strong>${e(entry.counterparty)}</strong
                      ><small>${e(entry.description)}</small></div>
                    </td>
                    <td data-label="Amount" class="ledger-amount dk-mono ${entryDirection(entry)}">
                      <div>${e(
                        formatAmount(`${entryDirection(entry) === "expense" ? "-" : ""}${entry.amount}`, entry.currency),
                      )}${entry.currency !== "EUR" && entry.amountEur
                        ? `<small class="ledger-eur dk-mono">≈ ${e(formatAmount(entry.amountEur))}</small>`
                        : ""}</div>
                    </td>
                    <td data-label="VAT" class="ledger-vat dk-mono">
                      ${e(
                        entry.vatAmount
                          ? formatAmount(entry.vatAmount, entry.vatCurrency || entry.currency)
                          : "—",
                      )}
                    </td>
                    <td data-label="Category / type">
                      ${e([entry.category, entryTypeLabel(entry.entryType)].filter(Boolean).join(" / ") || "—")}
                    </td>
                    <td data-label="Evidence">
                      ${hasEvidence(entry.id)
                        ? `<span class="dk-badge dk-badge--success">Referenced</span>`
                        : html`<span class="evidence-missing"
                            ><span class="dk-badge dk-badge--danger">Missing</span
                            ><button type="button" class="dk-button dk-button--secondary dk-button--sm"
                              data-attach-evidence="${e(entry.id)}">Attach</button></span
                          >`}
                    </td>
                    <td data-label="Actions">
                      <div class="row-actions">
                        <button data-edit="${e(entry.id)}">Edit</button
                        ><button
                          class="danger-text-button"
                          data-delete="${e(entry.id)}"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>`
    : html`<div class="dk-empty dk-empty--compact">
        <p class="dk-empty__title">No bookkeeping entries${lensTitle ? ` in ${e(lensTitle)}` : ""}</p>
        <p class="dk-empty__desc">Adjust the filters or the month, or add an entry.</p>
      </div>`;
}

// Evidence documents grouped under the month each document belongs to;
// groups arrive ordered, unfiled documents last.
export function documentGroupsMarkup({ groups, e, humanizeOptionLabel }) {
  return groups
    .map(({ month, docs }) => {
      const rows = docs
        .map((d) => {
          const documentLinks = d.links || [];
          const matchDescription = documentLinks.length
            ? ` · matched to ${documentLinks.length} ${documentLinks.length === 1 ? "entry" : "entries"}`
            : " · not matched";
          return html`<article class="bookkeeping-document-row">
            <div>
              <strong>${e(d.originalFilename || "Private PDF")}</strong>
              <p>
                ${e(humanizeOptionLabel(d.documentType))}${matchDescription}
              </p>
            </div>
            <div class="row-actions">
              <button data-download="${e(d.id)}">Download</button
              >${documentLinks
                .map((l) => {
                  const transaction = l.transaction;
                  return ` <button data-unlink="${e(l.id)}">Unlink ${e(transaction?.counterparty || "entry")}</button>`;
                })
                .join("")}
            </div>
          </article>`;
        })
        .join("");
      return `<div class="bookkeeping-doc-group"><h4>${
        month ? e(month) : "No month yet"
      }</h4>${rows}</div>`;
    })
    .join("");
}

// The package review: pre-flight statement checklist, what the archive will
// contain, and the ready state once the package exists.
export function packageReviewMarkup({
  title,
  preflightRows,
  preflightNote,
  preview,
  ready,
  e,
}) {
  return html`<h4>${e(title)} package</h4>
    <div class="bookkeeping-preflight">
      ${preflightRows.join("")}
      ${preflightNote || ""}
    </div>
    <p class="bookkeeping-package-preview">${preview}</p>
    ${ready
      ? html`<div class="bookkeeping-package-ready">
          <p>
            <strong>Package ready.</strong> <span class="dk-mono">${ready.transactionCount}</span>&nbsp;transactions
            and <span class="dk-mono">${ready.documentCount}</span>&nbsp;documents inside.
          </p>
          <button class="dk-button dk-button--secondary dk-button--sm" type="button" data-download-archive="${e(ready.id)}">
            Download package
          </button>
          <small>Link expires after five minutes.</small>
        </div>`
      : ""}`;
}

// The evidence link select only offers the lens month's transactions, entries
// missing evidence first — the operator picks from what the close actually
// needs instead of an all-time list.
export function transactionOptionsMarkup(scoped, e) {
  return html`<option value="">
      No transaction
    </option>
    ${scoped
      .map(
        (entry) =>
          html`<option value="${e(entry.id)}">
            ${e(`${ledgerDate(entry.transactionDate)} · ${entry.counterparty}`)}
          </option>`,
      )
      .join("")}`;
}

// Statement uploads need the business-account picker; options mirror the
// accounts list with the explicit "No account" escape hatch.
export function accountOptionsMarkup(accounts, e) {
  return html`<option value="">
      No account
    </option>
    ${accounts
      .map(
        (account) =>
          html`<option value="${e(account.id)}">
            ${e(account.displayName)} (${e(account.kind)})
          </option>`,
      )
      .join("")}`;
}
