import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const FULL = "4c7ef52c-1acc-45a3-ba0c-1c654da56ea6";
const PREFIX = FULL.slice(0, 8);
const SIBLING = "4c7ef52c-9999-45a3-ba0c-1c654da56ea6";
const UNRELATED = "4c7ef999-aaaa-45a3-ba0c-1c654da56ea6";

describe("CLI show commands accept unique id prefixes", () => {
  beforeEach(() => {
    isolateConfig();
    delete globalThis.fetch;
  });

  test("tasks show resolves a unique 8-character prefix", async () => {
    const calls = fakePortal({
      "GET /api/tasks": () => ({ status: 200, body: { tasks: [{ id: FULL, description: "Real task", status: "todo" }], nextCursor: null } }),
      [`GET /api/tasks/${FULL}`]: () => ({ status: 200, body: { id: FULL, description: "Real task", status: "todo" } }),
    });
    const io = captureIo();
    const code = await run(["tasks", "show", PREFIX, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
    assert.ok(calls.some((c) => c.route === "/api/tasks" && c.method === "GET"));
    assert.ok(calls.some((c) => c.route === `/api/tasks/${FULL}`));
  });

  test("tasks show rejects an ambiguous prefix naming the matches", async () => {
    fakePortal({
      "GET /api/tasks": () => ({ status: 200, body: { tasks: [{ id: FULL }, { id: SIBLING }], nextCursor: null } }),
    });
    const io = captureIo();
    const code = await run(["tasks", "show", PREFIX], io);
    assert.notEqual(code, 0);
    assert.match(io.errors.join("\n"), /Ambiguous short id prefix/);
    assert.match(io.errors.join("\n"), /2 Task matches/);
  });

  test("tasks show reports when no Task matches the prefix", async () => {
    fakePortal({
      "GET /api/tasks": () => ({ status: 200, body: { tasks: [{ id: UNRELATED }], nextCursor: null } }),
    });
    const io = captureIo();
    const code = await run(["tasks", "show", PREFIX], io);
    assert.notEqual(code, 0);
    assert.match(io.errors.join("\n"), /No Task matches short id prefix/);
  });

  test("tasks show rejects prefixes shorter than 8 characters", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    const code = await run(["tasks", "show", "abc"], io);
    assert.notEqual(code, 0);
    assert.match(io.errors.join("\n"), /too short/);
    assert.equal(calls.length, 0);
  });

  test("tasks show passes a full id through without listing", async () => {
    const calls = fakePortal({
      [`GET /api/tasks/${FULL}`]: () => ({ status: 200, body: { id: FULL, description: "Real task", status: "todo" } }),
    });
    const io = captureIo();
    const code = await run(["tasks", "show", FULL, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
    assert.equal(calls.length, 1);
  });

  test("tasks show follows list pagination while resolving", async () => {
    const calls = fakePortal({
      "GET /api/tasks": (call) => call.query.cursor
        ? { status: 200, body: { tasks: [{ id: FULL }], nextCursor: null } }
        : { status: 200, body: { tasks: [{ id: UNRELATED }], nextCursor: "page-2" } },
      [`GET /api/tasks/${FULL}`]: () => ({ status: 200, body: { id: FULL, description: "Real task", status: "todo" } }),
    });
    const io = captureIo();
    const code = await run(["tasks", "show", PREFIX, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
    const listCalls = calls.filter((c) => c.route === "/api/tasks");
    assert.deepEqual(listCalls.map((c) => c.query.cursor), [undefined, "page-2"]);
  });

  test("crm company show resolves a prefix across directory pages", async () => {
    fakePortal({
      "GET /api/sponsor-crm/directory/companies": (call) => call.query.cursor
        ? { status: 200, body: { items: [{ id: FULL, displayName: "Acme" }], nextCursor: null } }
        : { status: 200, body: { items: [{ id: UNRELATED, displayName: "Other" }], nextCursor: "p2" } },
      [`GET /api/sponsor-crm/directory/companies/${FULL}`]: () => ({ status: 200, body: { id: FULL, displayName: "Acme" } }),
    });
    const io = captureIo();
    const code = await run(["crm", "company", "show", PREFIX, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
  });

  test("crm person show resolves a unique prefix", async () => {
    fakePortal({
      "GET /api/sponsor-crm/directory/people": () => ({ status: 200, body: { items: [{ id: FULL, name: "Pat" }], nextCursor: null } }),
      [`GET /api/sponsor-crm/contacts/${FULL}`]: () => ({ status: 200, body: { id: FULL, name: "Pat" } }),
    });
    const io = captureIo();
    const code = await run(["crm", "person", "show", PREFIX, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
  });

  test("crm deal show resolves a unique prefix", async () => {
    fakePortal({
      "GET /api/sponsor-crm/deals": () => ({ status: 200, body: { items: [{ id: FULL, name: "Deal" }], nextCursor: null } }),
      [`GET /api/sponsor-crm/deals/${FULL}`]: () => ({ status: 200, body: { id: FULL, name: "Deal" } }),
    });
    const io = captureIo();
    const code = await run(["crm", "deal", "show", PREFIX, "--json"], io);
    assert.equal(code, 0, io.errors.join(" | "));
    assert.equal(io.json().id, FULL);
  });

  test("crm company show rejects an ambiguous prefix", async () => {
    fakePortal({
      "GET /api/sponsor-crm/directory/companies": () => ({ status: 200, body: { items: [{ id: FULL }, { id: SIBLING }], nextCursor: null } }),
    });
    const io = captureIo();
    const code = await run(["crm", "company", "show", PREFIX], io);
    assert.notEqual(code, 0);
    assert.match(io.errors.join("\n"), /Ambiguous short id prefix/);
  });
});
