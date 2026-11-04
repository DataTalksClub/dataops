import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ApiError } from "../src/api.mjs";
import { ConflictError, errorPayload } from "../src/errors.mjs";

const reportPeriod = "2039-04";
const blockers = [
  { reportPeriod, period: reportPeriod, rowId: "ledger:invented-payment", date: "2039-04-06", counterparty: "Invented Payment Vendor", amount: "19.00", currency: "EUR", status: "payment-proof-missing", reason: "Payment proof remains unconfirmed", rowDigest: "a".repeat(64) },
  { reportPeriod, period: reportPeriod, rowId: "invoice-review:invented-attribution", date: "2039-04-09", counterparty: "Invented Attribution Vendor", amount: "", currency: "EUR", status: "needs-attribution", reason: "Original amount and cash-month attribution require verification", rowDigest: "b".repeat(64) },
  { rowId: "ledger:invented-mismatch", reference: "invented-receipt", reason: "Bank and invoice amounts do not match" },
];
const body = {
  error: "Accountant export blocked: 3 unresolved payment/evidence items", reportPeriod,
  blockers: blockers.map((row) => ({ ...row, token: "synthetic-secret-not-for-cli", internal: { credentials: "synthetic-secret-not-for-cli" } })),
  token: "synthetic-secret-not-for-cli", content: "synthetic-secret-not-for-cli", internal: { source: "synthetic-secret-not-for-cli" },
};

test("finance gate JSON errors retain only documented context and blocker fields", () => {
  const result = errorPayload(new ApiError(409, body, "https://portal.test/api/bookkeeping/reports/accountant"));
  assert.deepEqual(result, { error: { message: body.error, exitCode: 5, status: 409, details: { reportPeriod, blockers } } });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-not-for-cli|credentials|internal|token/);
});

test("unrelated API responses stay private and existing local conflict details remain unchanged", () => {
  for (const [status, value] of [[500, body], [409, { error: "Unrelated conflict", token: "hidden" }], [409, { reportPeriod, blockers: "invalid" }], [409, { ...body, reportPeriod: { nested: "hidden" } }]]) {
    assert.equal(errorPayload(new ApiError(status, value, "https://portal.test/api/example")).error.details, undefined);
  }
  const details = { changedRecordId: "invented-record" };
  assert.deepEqual(errorPayload(new ConflictError("Changed", details)).error.details, details);
});

function runCli(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/dataops.mjs", import.meta.url)), ...args], {
      env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("real CLI API CSV/TSV and draft package return all three blockers with exit 5 and no artifact output", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dataops-finance-gate-json-"));
  const output = path.join(temporary, "package-output");
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const environment = { DATAOPS_URL: url, DATAOPS_TOKEN: "synthetic-scoped-token", DATAOPS_CONFIG_DIR: path.join(temporary, "config") };
    for (const args of [
      ["api", "GET", `/api/bookkeeping/reports/accountant?period=${reportPeriod}&format=csv`, "--json"],
      ["api", "GET", `/api/bookkeeping/reports/accountant?period=${reportPeriod}&format=tsv`, "--json"],
      ["reconcile", "package", reportPeriod, "--draft", "--out", output, "--json"],
    ]) {
      const result = await runCli(args, environment);
      assert.equal(result.code, 5, result.stderr);
      assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr).error;
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { reportPeriod, blockers });
      assert.doesNotMatch(result.stderr, /synthetic-secret-not-for-cli/);
    }
    assert.deepEqual(calls, [
      { method: "GET", url: `/api/bookkeeping/reports/accountant?period=${reportPeriod}&format=csv` },
      { method: "GET", url: `/api/bookkeeping/reports/accountant?period=${reportPeriod}&format=tsv` },
      { method: "GET", url: `/api/reconcile/months/${reportPeriod}/package?draft=true` },
    ]);
    await assert.rejects(access(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(temporary), [], "blocked commands must not create a report, package, or credentials file");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
