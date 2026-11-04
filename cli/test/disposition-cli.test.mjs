import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

test("bare CLI forwards --target-period for deferred dispositions and preserves required-input rejection", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "dataops-disposition-cli-"));
  const calls = [], period = "2038-07", targetPeriod = "2038-08";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ method: request.method, url: request.url, body });
    const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(body.targetPeriod || "") && body.targetPeriod > period;
    response.writeHead(valid ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(valid ? { month: { period, version: 12 } } : { error: "deferred requires a later targetPeriod (YYYY-MM)" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const environment = { DATAOPS_URL: `http://127.0.0.1:${server.address().port}`,
    DATAOPS_TOKEN: "invented-scoped-token", DATAOPS_CONFIG_DIR: path.join(temporary, "config") };
  const args = ["reconcile", "disposition", "invoice:invented", "--period", period, "--kind", "deferred",
    "--reason", "Verified later settlement", "--evidence", "Invented attribution register",
    "--digest", "a".repeat(64), "--version", "11", "--json"];
  try {
    for (const flags of [["--target-period", targetPeriod], [`--target-period=${targetPeriod}`]]) {
      const result = await runCli([...args, ...flags], environment);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { month: { period, version: 12 } });
      assert.deepEqual(calls.at(-1), { method: "POST", url: `/api/reconcile/months/${period}/invoice-disposition`, body: {
        rowId: "invoice:invented", kind: "deferred", reason: "Verified later settlement", evidence: "Invented attribution register",
        rowDigest: "a".repeat(64), version: 11, targetPeriod,
      } });
    }
    const missingTarget = await runCli(args, environment);
    assert.equal(missingTarget.code, 6);
    assert.equal(missingTarget.stdout, "");
    assert.equal(JSON.parse(missingTarget.stderr).error.status, 400);
    assert.match(JSON.parse(missingTarget.stderr).error.message, /requires a later targetPeriod/);
    assert.equal(Object.hasOwn(calls.at(-1).body, "targetPeriod"), false);
    const missingEvidence = args.filter((_value, index) => index !== args.indexOf("--evidence") && index !== args.indexOf("--evidence") + 1);
    const missingRequired = await runCli([...missingEvidence, "--target-period", targetPeriod], environment);
    assert.equal(missingRequired.code, 2);
    assert.equal(missingRequired.stdout, "");
    assert.match(JSON.parse(missingRequired.stderr).error.message, /--evidence/);
    assert.equal(calls.length, 3, "missing required evidence must fail before any HTTP call");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
