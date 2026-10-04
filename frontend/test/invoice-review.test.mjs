import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceDetailMarkup, invoiceLedgerMarkup } from "../src/surfaces/finance/invoices.js";
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const draft = { id: "demo", revision: 3, status: "pending", fields: { counterparty: "Example <Vendor>", amount: "12.00", currency: "USD", archiveRequired: true }, extraction: { method: "bounded-pdf-text", evidence: ["Invoice total label"], issues: ["Payment requires bank evidence"] }, source: { intakeItemIds: ["intake-demo"], artifactId: "artifact-demo", checksum: "sanitized-checksum" }, destinations: { dropbox: { state: "pending", operationId: "archive-demo" }, sheets: { state: "pending", operationId: "sheet-demo" } }, missingEvidence: ["amountEur", "paidDate"], publicationStatus: "not-confirmed", audit: [] };

test("pending invoice presents source evidence, actual payment correction and current verification", () => {
  const markup = invoiceDetailMarkup(draft, escape);
  assert.ok(markup.includes("Example &lt;Vendor>"));
  for (const value of ["Revision 3", "bounded-pdf-text", "intake-demo", "artifact-demo", "Missing evidence: amountEur", "Actual EUR paid", "Payment evidence / operator attestation", "Invoice tax conversion is not bank payment evidence", "data-invoice-document", 'data-invoice-action="verify"', 'data-invoice-action="reject"']) assert.ok(markup.includes(value), value);
});

test("partial publication separates verified archive from actionable spreadsheet failure", () => {
  const markup = invoiceDetailMarkup({ ...draft, status: "confirmed", publicationStatus: "incomplete", destinations: { dropbox: { state: "verified", operationId: "archive-demo", reference: "file-demo" }, sheets: { state: "blocked", operationId: "sheet-demo", error: "Header mapping incompatible" } } }, escape);
  for (const value of ["Dropbox: verified", "Spreadsheet: blocked", "Header mapping incompatible", "file-demo", 'data-invoice-action="retry"', '<fieldset disabled>']) assert.ok(markup.includes(value), value);
  assert.ok(!markup.includes('data-invoice-action="verify"'));
});

test("rejected and verified complete records offer no mutation or retry", () => {
  for (const record of [{ ...draft, status: "rejected" }, { ...draft, status: "confirmed", publicationStatus: "complete" }]) {
    const markup = invoiceDetailMarkup(record, escape);
    assert.ok(!markup.includes("data-invoice-action="));
    assert.ok(!markup.includes("Save corrections"));
  }
});

test("pending untouched drafts offer re-extraction; operator-corrected drafts do not", () => {
  assert.ok(invoiceDetailMarkup(draft, escape).includes('data-invoice-action="reextract"'));
  const corrected = { ...draft, audit: [{ action: "corrected", actor: "operator", at: "2026-10-04T00:00:00Z", revision: 2 }] };
  assert.ok(!invoiceDetailMarkup(corrected, escape).includes('data-invoice-action="reextract"'));
  const reextracted = { ...draft, audit: [{ action: "re-extracted", actor: "email-intake", at: "2026-10-04T00:00:00Z", revision: 2 }] };
  assert.ok(!invoiceDetailMarkup(reextracted, escape).includes('data-invoice-action="reextract"'));
});

test("ledger rows are dense sheet-shaped rows with pending drafts first and negative prices", () => {
  const rows = [
    { ...draft, id: "b".repeat(64), status: "confirmed", fields: { ...draft.fields, counterparty: "Amazon Web Services", description: "Cloud services", transactionDate: "2026-08-02", paidDate: "2026-08-02", amountEur: "20.09", statementRef: "Revolut" } },
    { ...draft, id: "c".repeat(64), fields: { ...draft.fields, counterparty: "OpenAI", description: "ChatGPT Plus subscription", transactionDate: "2026-08-01" } },
    { ...draft, id: "d".repeat(64), status: "rejected", fields: { ...draft.fields, counterparty: "Dropped vendor" } },
  ];
  const markup = invoiceLedgerMarkup(rows, escape);
  const order = [...markup.matchAll(/data-review-invoice="([a-d]+)"/g)].map(match => match[1][0]);
  assert.deepEqual(order, ["c", "b", "d"]);
  const firstRow = markup.split("<tr")[2];
  assert.ok(firstRow.includes("OpenAI"), firstRow);
  assert.ok(firstRow.includes("-12.00"), firstRow);
  assert.ok(markup.includes("-20.09"), "actual EUR renders negative for the confirmed row");
  assert.ok(markup.includes("1 pending review"));
  assert.ok(markup.includes("is-pending") && markup.includes("is-confirmed") && markup.includes("is-rejected"));
  assert.ok(markup.includes("Price, $") && markup.includes("Price, EUR") && markup.includes("Statement") && markup.includes("Count"));
});

test("empty ledger shows the honest forwarding state", () => {
  const markup = invoiceLedgerMarkup([], escape);
  assert.ok(markup.includes("No invoice drafts received."));
  assert.ok(!markup.includes("<table"));
});
