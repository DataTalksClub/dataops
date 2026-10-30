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
});
