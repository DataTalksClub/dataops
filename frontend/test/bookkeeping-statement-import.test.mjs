import { test } from "node:test";
import assert from "node:assert/strict";
import { importStatementWithReview, statementHeaderReviewLines } from "../src/surfaces/finance/bookkeeping-statement-import.js";

test("identical statement previews show exact issue dates, coverage, opening and closing for both sources", () => {
  const headers = { issueDate: "2028-04-05", from: "2028-03-01", to: "2028-03-31", openingBalances: [{ asOf: "2028-03-01", amount: "100.00", currency: "EUR" }], balances: [{ asOf: "2028-03-31", amount: "76.50", currency: "EUR" }] };
  const lines = statementHeaderReviewLines({ replacements: [{ difference: { identical: true, existing: [headers], candidate: { ...headers, issueDate: "2028-04-09" } } }] });
  assert.deepEqual(lines, [
    "Existing: Issue date 2028-04-05; From 2028-03-01; To 2028-03-31; Opening 2028-03-01 main 100.00 EUR; Closing 2028-03-31 main 76.50 EUR.",
    "Incoming: Issue date 2028-04-09; From 2028-03-01; To 2028-03-31; Opening 2028-03-01 main 100.00 EUR; Closing 2028-03-31 main 76.50 EUR.",
  ]);
});

test("statement replacement keeps the existing source unless explicitly confirmed", async () => {
  const calls = [];
  const preview = { digest: "invented-current-digest", requiresConfirmation: true, replacements: [], message: "No differences. Replace?" };
  const request = async (_url, options) => { calls.push(JSON.parse(options.body)); return { committed: false, preview }; };
  const result = await importStatementWithReview("invented-source", { request, workApiUrl: (path) => path, confirmReplacement: async (value) => { assert.equal(value, preview); return false; } });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, [{ documentId: "invented-source", preview: true }]);
});

test("statement replacement submits the reviewed digest in one batch", async () => {
  const calls = [];
  const preview = { digest: "invented-reviewed-digest", requiresConfirmation: true, replacements: [] };
  const request = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return body.preview ? { committed: false, preview } : { committed: true, statements: [{ id: "one-source-many-wallets" }] };
  };
  const result = await importStatementWithReview("invented-source", { request, workApiUrl: (path) => path, confirmReplacement: async () => true });
  assert.equal(result.committed, true);
  assert.deepEqual(calls[1], { documentId: "invented-source", replace: true, previewDigest: "invented-reviewed-digest" });
});
