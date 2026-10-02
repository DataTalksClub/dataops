import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceDetailMarkup } from "../src/surfaces/finance/invoices.js";
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
