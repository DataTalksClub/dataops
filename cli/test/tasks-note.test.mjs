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

describe("tasks notes", () => {
  test("note appends text with the version", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1", version: 2 }),
      "POST /api/tasks/t-1/actions/add-note": ({ body }) => task({ id: "t-1", ...body, version: 3 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "note", "t-1", "Check the logo file"], io), 0);
    assert.deepEqual(calls.at(-1).body, { note: "Check the logo file", expectedVersion: 2 });
    assert.match(io.text(), /Noted t-1/);
  });

  test("note without text is a usage error before anything is sent", async () => {
    const calls = fakePortal({});
    let io = captureIo();
    assert.equal(await run(["tasks", "note", "t-1"], io), 2);
    assert.match(io.errors.join("\n"), /Usage: dataops tasks note/);
    io = captureIo();
    assert.equal(await run(["tasks", "note", "t-1", "  "], io), 2);
    assert.equal(calls.length, 0);
  });

  test("show prints the full log with timestamps and authors", async () => {
    fakePortal({
      "GET /api/tasks/t-2": task({
        id: "t-2",
        comment: "Latest",
        notesLog: [
          { id: "n-1", text: "First context", authorId: "u-ann", createdAt: "2026-10-15T09:00:00.000Z" },
          { id: "n-2", text: "Latest", authorId: "u-orin", createdAt: "2026-10-16T09:00:00.000Z" },
        ],
        historyActors: [
          { id: "u-ann", name: "Ann" },
          { id: "u-orin", name: "Orin" },
        ],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "show", "t-2"], io), 0);
    const text = io.text();
    assert.match(text, /notes log:/);
    assert.match(text, /2026-10-15T09:00:00\.000Z Ann: First context/);
    assert.match(text, /2026-10-16T09:00:00\.000Z Orin: Latest/);
  });

  test("update --comment still sends the comment; the server appends it", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-3": task({ id: "t-3", version: 4 }),
      "PUT /api/tasks/t-3": ({ body }) => task({ id: "t-3", ...body, version: 5 }),
    });
    assert.equal(await run(["tasks", "update", "t-3", "--comment", "Another note"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { comment: "Another note", expectedVersion: 4 });
  });
});
