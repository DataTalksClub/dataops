import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const MARKER = "pipe-secret-MARKER-4f7e2a";

describe("CLI secrets", () => {
  beforeEach(() => {
    isolateConfig();
  });

  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("list shows names and field names, never values", async () => {
    const io = captureIo();
    const fake_ = fake({
      "GET /api/secrets": {
        status: 200,
        body: { secrets: [{ name: "airtable", fields: ["password", "username"], createdAt: "2026-10-16T10:00:00Z", createdBy: "u1", updatedAt: "2026-10-16T11:00:00Z", updatedBy: "u1" }] },
      },
    });
    try {
      const code = await run(["secrets", "list"], io);
      assert.equal(code, 0);
      assert.match(io.text(), /airtable/);
      assert.match(io.text(), /password,username/);
      assert.equal(io.text().includes(MARKER), false);
    } finally { fake_.restore(); }
  });

  test("get --field prints exactly the value on stdout, notes on stderr", async () => {
    const io = captureIo();
    const fake_ = fake({
      "GET /api/secrets/airtable": {
        status: 200,
        body: { secret: { name: "airtable", fields: { username: "u", password: MARKER } } },
      },
    });
    try {
      const code = await run(["secrets", "get", "airtable", "--field", "password"], io);
      assert.equal(code, 0);
      assert.equal(io.text(), MARKER);
      assert.equal(io.out.length, 1);
      assert.deepEqual(io.errors, []);
    } finally { fake_.restore(); }
  });

  test("get --out writes a 600 file without a trailing newline and keeps stdout clean", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-out-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, "pw.txt");
    const io = captureIo();
    const fake_ = fake({
      "GET /api/secrets/airtable": {
        status: 200,
        body: { secret: { name: "airtable", fields: { password: MARKER } } },
      },
    });
    try {
      const code = await run(["secrets", "get", "airtable", "--field", "password", "--out", target], io);
      assert.equal(code, 0);
      assert.equal(readFileSync(target, "utf8"), MARKER);
      if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(io.out, []);
      assert.deepEqual(io.errors, []);
    } finally { fake_.restore(); }
  });

  test("get of a missing field exits 4 and names the available fields", async () => {
    const io = captureIo();
    const fake_ = fake({
      "GET /api/secrets/airtable": {
        status: 200,
        body: { secret: { name: "airtable", fields: { username: "u" } } },
      },
    });
    try {
      const code = await run(["secrets", "get", "airtable", "--field", "password"], io);
      assert.equal(code, 4);
      assert.match(io.errors.join("\n"), /no field 'password'/);
      assert.match(io.errors.join("\n"), /username/);
    } finally { fake_.restore(); }
  });

  test("set sends the field object and confirms with field names only", async () => {
    const io = captureIo();
    let sentBody;
    const fake_ = fake({
      "PUT /api/secrets/airtable": {
        status: 200,
        body: { secret: { name: "airtable", fields: ["password", "username"] } },
        // handler form to capture the body
      },
    });
    // Wrap fetch to record the JSON body of the PUT.
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === "PUT") sentBody = JSON.parse(options.body);
      return previous(url, options);
    };
    try {
      const code = await run(["secrets", "set", "airtable", "--field", `password=${MARKER}`, "--field", "username=u"], io);
      assert.equal(code, 0);
      assert.deepEqual(sentBody, { fields: { password: MARKER, username: "u" } });
      assert.equal(io.out.join("\n").includes(MARKER), false);
      assert.match(io.out.join("\n"), /Set airtable \(password, username\)/);
    } finally {
      fake_.restore();
      globalThis.fetch = previous;
    }
  });

  test("set --from-file reads a JSON object file", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-file-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "secret.json");
    writeFileSync(source, JSON.stringify({ username: "u", password: MARKER }));
    const io = captureIo();
    let sentBody;
    const fake_ = fake({
      "PUT /api/secrets/airtable": { status: 200, body: { secret: { name: "airtable", fields: ["password", "username"] } } },
    });
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === "PUT") sentBody = JSON.parse(options.body);
      return previous(url, options);
    };
    try {
      const code = await run(["secrets", "set", "airtable", "--from-file", source], io);
      assert.equal(code, 0);
      assert.deepEqual(sentBody, { fields: { username: "u", password: MARKER } });
    } finally {
      fake_.restore();
      globalThis.fetch = previous;
    }
  });

  test("set with no fields is a usage error", async () => {
    const io = captureIo();
    const fake_ = fake({});
    try {
      const code = await run(["secrets", "set", "airtable"], io);
      assert.equal(code, 2);
      assert.match(io.errors.join("\n"), /Nothing to set/);
    } finally { fake_.restore(); }
  });

  test("delete confirms on stderr", async () => {
    const io = captureIo();
    const fake_ = fake({ "DELETE /api/secrets/airtable": { status: 200, body: { deleted: true, name: "airtable" } } });
    try {
      const code = await run(["secrets", "delete", "airtable"], io);
      assert.equal(code, 0);
      assert.match(io.out.join("\n"), /Deleted airtable/);
    } finally { fake_.restore(); }
  });
});

describe("CLI secrets — stdin value via real process", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));

  test("bare --field KEY reads the value from stdin; stdout stays clean", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-stdin-"));
    const calls = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        calls.push({ url: request.url, method: request.method, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ secret: { name: "airtable", fields: ["password"] } }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const child = spawn(process.execPath, [path.join(root, "cli/bin/dataops.mjs"), "secrets", "set", "airtable", "--field", "password", "--url", url], {
        env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: "dops_test", DATAOPS_URL: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdin.end(`${MARKER}\n`);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0);
      const put = calls.find((call) => call.method === "PUT");
      assert.ok(put, "PUT reached the portal");
      assert.deepEqual(JSON.parse(put.body), { fields: { password: MARKER } });
      assert.equal(stdout.includes(MARKER), false, "value leaked to stdout");
      assert.match(stdout, /Set airtable \(password\)/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
