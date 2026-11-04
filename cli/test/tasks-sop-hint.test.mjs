import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";
isolateConfig();
const originalFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
afterEach(() => { globalThis.fetch = originalFetch; });

const task = { id: "t-1", description: "Synthetic upload task", status: "todo", version: 7,
  instructionDocId: "sop.finance.upload-package", sourceDocIds: ["sop.finance.monthly"],
  notesLog: [{ text: "Long historical context", createdAt: "2026-01-01" }] };

test("show prominently prompts the directly attached SOP, without fetching or writing", async () => {
  const calls = fakePortal({ "GET /api/tasks/t-1": task });
  const io = captureIo();
  assert.equal(await run(["tasks", "show", "t-1"], io), 0);
  const output = io.text();
  assert.match(output, /Before executing this task, read its attached SOP:\n  dataops kb show sop\.finance\.upload-package/);
  assert.ok(output.indexOf("id:") < output.indexOf("Before executing"));
  assert.ok(output.indexOf("Before executing") < output.indexOf("source docs:"));
  assert.ok(output.indexOf("Before executing") < output.indexOf("notes log:"));
  assert.doesNotMatch(output, /dataops kb show sop\.finance\.monthly/);
  assert.match(output, /instruction doc:\s+sop\.finance\.upload-package/);
  assert.deepEqual(calls.map(c => [c.method, c.route]), [["GET", "/api/tasks/t-1"]]);
});

test("show explicitly states no attached SOP instead of substituting source docs", async () => {
  fakePortal({ "GET /api/tasks/t-1": { ...task, instructionDocId: null } });
  const io = captureIo();
  assert.equal(await run(["tasks", "show", "t-1"], io), 0);
  assert.match(io.text(), /No SOP attached to this task\./);
  assert.doesNotMatch(io.text(), /dataops kb show/);
});

test("JSON task fields remain unchanged and fetching stays read-only", async () => {
  const calls = fakePortal({ "GET /api/tasks/t-1": task });
  const io = captureIo();
  assert.equal(await run(["tasks", "show", "t-1", "--json"], io), 0);
  assert.deepEqual(io.json(), task);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});
