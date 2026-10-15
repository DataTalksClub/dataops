// Dynamic view templates for the bookkeeping surface. Pure functions from
// data to markup: no queries, no events — bookkeeping.js owns state and
// wiring, this module owns the secondary views' markup.
import { html } from "./shared.js";

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
