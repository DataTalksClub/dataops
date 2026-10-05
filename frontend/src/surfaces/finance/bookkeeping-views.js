// Dynamic view templates for the bookkeeping surface. Pure functions from
// data to markup: no queries, no events — bookkeeping.js owns state and
// wiring, this module owns what the operator reads (#242 month lens).
import { html } from "./shared.js";
import { entryDirection, ledgerDate } from "./bookkeeping-format.js";

// The close-state header: the month, four counters, one CTA that follows
// the month state. This is what answers "what is left for this month".
export function closeStateMonthMarkup({
  title,
  transactions,
  missingEvidence,
  conversions,
  packageReady,
  cta,
  e,
}) {
  const ctaButton =
    cta.kind === "worklist"
      ? html`<button class="primary-button" type="button" data-cta-worklist>
          Review ${cta.count} open item${cta.count === 1 ? "" : "s"}
        </button>`
      : cta.kind === "download"
        ? html`<button class="primary-button" type="button" data-cta-download>
            Download the monthly package
          </button>`
        : cta.kind === "package"
          ? html`<button class="primary-button" type="button" data-cta-package>
              Prepare the monthly package
            </button>`
          : html`<button class="primary-button" type="button" data-cta-add>
              Add the first entry
            </button>`;
  return html`<h2>${e(title)} close</h2>
    <div class="bookkeeping-counters">
      <span class="bookkeeping-counter"
        ><strong>${transactions}</strong
        >transaction${transactions === 1 ? "" : "s"}</span
      ><span
        class="bookkeeping-counter ${missingEvidence ? "is-open" : "is-done"}"
        ><strong>${missingEvidence}</strong
        >evidence missing</span
      ><span
        class="bookkeeping-counter ${conversions ? "is-open" : "is-done"}"
        ><strong>${conversions}</strong
        >EUR conversions open</span
      ><span class="bookkeeping-counter ${packageReady ? "is-done" : "is-open"}"
        ><strong>${packageReady ? "Ready" : "—"}</strong>package</span
      >
    </div>
    <div class="bookkeeping-close-cta">${ctaButton}</div>`;
}

export function closeStateAllMarkup(transactions) {
  return html`<p class="bookkeeping-lens-note">
    All months — ${transactions} transaction${transactions === 1 ? "" : "s"}
    on record. Select a month above to see its close state.
  </p>`;
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
          >${e(ledgerDate(entry.transactionDate))} ·
          ${e(`${entry.amount} ${entry.currency}`)}${entry.description ? ` · ${e(entry.description)}` : ""}</small
        >`;
      const fix =
        kind === "evidence"
          ? html`<button type="button" data-attach-evidence="${e(entry.id)}">
              Attach evidence
            </button>`
          : kind === "eur"
            ? html`<button type="button" data-add-eur="${e(entry.id)}">
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
                    <td data-label="Transaction date">
                      ${e(ledgerDate(entry.transactionDate))}
                    </td>
                    <td data-label="Paid">
                      ${e(entry.paidDate ? ledgerDate(entry.paidDate) : "Unpaid")}
                    </td>
                    <td data-label="Entry">
                      <strong>${e(entry.counterparty)}</strong
                      ><small>${e(entry.description)}</small>
                    </td>
                    <td data-label="Amount" class="ledger-amount">
                      ${e(
                        `${entryDirection(entry) === "expense" ? "-" : ""}${entry.amount} ${entry.currency}`,
                      )}${entry.currency !== "EUR" && entry.amountEur
                        ? `<small class="ledger-eur">≈ ${e(`${entry.amountEur} EUR`)}</small>`
                        : ""}
                    </td>
                    <td data-label="VAT" class="ledger-vat">
                      ${e(
                        entry.vatAmount
                          ? `${entry.vatAmount} ${entry.vatCurrency || entry.currency}`
                          : "—",
                      )}
                    </td>
                    <td data-label="Category / type">
                      ${e([entry.category, entry.entryType].filter(Boolean).join(" / ") || "—")}
                    </td>
                    <td data-label="Evidence">
                      ${hasEvidence(entry.id)
                        ? `<span class="evidence-state is-attached">Referenced</span>`
                        : `<button type="button" class="evidence-state is-missing" data-attach-evidence="${e(entry.id)}">Missing</button>`}
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
    : html`<div class="honest-state">
        <strong>No bookkeeping entries${lensTitle ? ` in ${e(lensTitle)}` : ""}</strong>
        <p>Adjust the filters or the month, or add an entry.</p>
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
            <strong>Package ready.</strong> ${ready.transactionCount}
            transactions and ${ready.documentCount} documents inside.
          </p>
          <button type="button" data-download-archive="${e(ready.id)}">
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
            ${e(`${entry.transactionDate} · ${entry.counterparty}`)}
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
