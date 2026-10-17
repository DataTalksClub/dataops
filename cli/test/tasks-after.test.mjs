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

describe("tasks --after", () => {
  test("update --after sets the single parent", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1", version: 2 }),
      "PUT /api/tasks/t-1": ({ body }) => task({ id: "t-1", ...body, version: 3 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "update", "t-1", "--after", "p-9"], io), 0);
    assert.deepEqual(calls.at(-1).body, { dependsOn: ["p-9"], expectedVersion: 2 });
    assert.match(io.text(), /Updated t-1/);
  });

  test("update --after none clears the chain", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-2": task({ id: "t-2", version: 2, dependsOn: ["p-9"] }),
      "PUT /api/tasks/t-2": ({ body }) => task({ id: "t-2", ...body, version: 3 }),
    });
    assert.equal(await run(["tasks", "update", "t-2", "--after", "none"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { dependsOn: [], expectedVersion: 2 });
  });

  test("--after and --depends-on together are a usage error", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    assert.equal(await run(["tasks", "update", "t-3", "--after", "p-9", "--depends-on", "p-9"], io), 2);
    assert.match(io.errors.join("\n"), /Use --after or --depends-on, not both/);
    assert.equal(calls.length, 0);
  });

  test("a moved parent reports its rescheduled dependents", async () => {
    const calls = fakePortal({
      "GET /api/tasks/p-1": task({ id: "p-1", version: 2, date: "2026-10-10" }),
      "PUT /api/tasks/p-1": ({ body }) => task({ id: "p-1", ...body, version: 3, rescheduled: ["c-1", "c-2"] }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "update", "p-1", "--date", "2026-10-12", "--json"], io), 0);
    assert.deepEqual(io.json().rescheduled, ["c-1", "c-2"]);
    assert.equal(calls.length, 2);
  });
});
