import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
});

describe("tasks --proof-requirement", () => {
  test("create sends the proofRequirement with label and optional flag", async () => {
    const calls = fakePortal({ "POST /api/tasks": ({ body }) => ({ id: "t1", date: "2026-11-09", ...body }) });
    assert.equal(await run([
      "tasks", "create", "--description", "Publish", "--proof-requirement", "url",
      "--proof-label", "Published post", "--proof-optional", "--json",
    ], captureIo()), 0);
    assert.deepEqual(calls[0].body.proofRequirement, { type: "url", label: "Published post", required: false });
  });

  test("a bare type sends only the type; an unknown type is a usage error", async () => {
    const calls = fakePortal({ "POST /api/tasks": ({ body }) => ({ id: "t1", date: "2026-11-09", ...body }) });
    assert.equal(await run(["tasks", "create", "--description", "Publish", "--proof-requirement", "file", "--json"], captureIo()), 0);
    assert.deepEqual(calls[0].body.proofRequirement, { type: "file" });
    assert.equal(await run(["tasks", "create", "--description", "Publish", "--proof-requirement", "photo"], captureIo()), 2);
    assert.equal(await run(["tasks", "create", "--description", "Publish", "--proof-label", "x"], captureIo()), 2);
    assert.equal(calls.length, 1);
  });
});
