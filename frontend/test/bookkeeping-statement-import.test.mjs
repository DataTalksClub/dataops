import { test } from "node:test";
import assert from "node:assert/strict";
import { importStatementWithReview } from "../src/surfaces/finance/bookkeeping-statement-import.js";

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
