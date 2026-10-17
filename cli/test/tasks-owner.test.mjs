import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
  delete process.env.DATAOPS_TODAY;
});

const task = (fields) => ({ status: "todo", version: 3, description: "Synthetic task", ...fields });

describe("tasks owner by name", () => {
  test("--owner orin is passed through for the API to resolve", async () => {
    const calls = fakePortal({ "GET /api/tasks": { tasks: [task({ id: "o-1" })] } });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--owner", "orin", "--status", "todo", "--json"], io), 0);
    assert.deepEqual(calls.map((call) => call.query), [{ owner: "orin", status: "todo" }]);
    assert.deepEqual(io.json().tasks.map((item) => item.id), ["o-1"]);
  });

  test("--assignee is the same filter as --owner", async () => {
    const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
    assert.equal(await run(["tasks", "list", "--assignee", "orin@datatalks.club", "--status", "todo"], captureIo()), 0);
    assert.deepEqual(calls.map((call) => call.query), [{ owner: "orin@datatalks.club", status: "todo" }]);
  });

  test("--owner and --assignee together are a usage error before anything is sent", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--owner", "orin", "--assignee", "orin", "--status", "todo"], io), 2);
    assert.match(io.errors.join("\n"), /Use --owner or --assignee, not both/);
    assert.equal(calls.length, 0);
  });
});
