import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const { EXIT } = await import("../src/errors.mjs");

describe("CLI crm workspace", () => {
  beforeEach(() => {
    isolateConfig();
  });

  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("companies list maps flags to directory query and pages", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/companies": (call) => ({
        status: 200,
        body: { items: [{ id: "a", displayName: "Acme", relationship: "talking", primaryPerson: { name: "Ada" }, lastTouch: "2026-10-01T00:00:00Z", openDealCount: 1 }], total: 1, nextCursor: null, query: call.query },
      }),
    });
    try {
      const code = await run(["crm", "companies", "list", "--search", "acme", "--relationship", "talking", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[0].query.search, "acme");
      assert.equal(calls[0].query.relationship, "talking");
      const body = io.json();
      assert.equal(body.total, 1);
      assert.equal(body.items[0].displayName, "Acme");
    } finally {
      restore();
    }
  });

  test("people list, person show/create/update reach canonical contact endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/people": { status: 200, body: { items: [], total: 0, nextCursor: null } },
      "GET /api/sponsor-crm/contacts/p1": { status: 200, body: { id: "p1", name: "Ada" } },
      "POST /api/sponsor-crm/contacts": (call) => ({ status: 201, body: { id: "p2", ...call.body } }),
      "PUT /api/sponsor-crm/contacts/p2": (call) => ({ status: 200, body: { id: "p2", ...call.body } }),
    });
    try {
      assert.equal(await run(["crm", "people", "list", "--unlinked", "true", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.unlinked, "true");
      assert.equal(await run(["crm", "person", "show", "p1", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "person", "create", "--data", '{"name":"Bo"}', "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.name, "Bo");
      assert.equal(await run(["crm", "person", "update", "p2", "--data", '{"name":"Bo2","version":1}', "--json"], io), EXIT.ok);
    } finally {
      restore();
    }
  });

  test("activity, notes list and note add map target, types and source key", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/activity/contact/c1": { status: 200, body: { items: [], total: 0, nextCursor: null, relatedWork: [], tasksScope: "open" } },
      "GET /api/sponsor-crm/notes/organization/o1": { status: 200, body: { items: [], total: 0, nextCursor: null } },
      "POST /api/sponsor-crm/notes/organization/o1": (call) => ({ status: 201, body: { id: "n1", ...call.body } }),
    });
    try {
      assert.equal(await run(["crm", "activity", "contact", "c1", "--types", "note,mail", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.types, "note,mail");
      assert.equal(await run(["crm", "notes", "list", "organization", "o1", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "note", "add", "organization", "o1", "--body", "Called", "--source-key", "k1", "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.body, "Called");
      assert.equal(calls[2].body.sourceKey, "k1");
    } finally {
      restore();
    }
  });

  test("views list/create/update/archive hit the views endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/views": { status: 200, body: { items: [{ id: "builtin:companies:active", builtin: true }], total: 1 } },
      "POST /api/sponsor-crm/views": (call) => ({ status: 201, body: { id: "v1", ...call.body } }),
      "PUT /api/sponsor-crm/views/v1": (call) => ({ status: 200, body: { id: "v1", ...call.body } }),
      "DELETE /api/sponsor-crm/views/v1": { status: 200, body: { id: "v1", archivedAt: "2026-10-17" } },
    });
    try {
      assert.equal(await run(["crm", "views", "list", "--entity", "companies", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.entity, "companies");
      assert.equal(await run(["crm", "views", "create", "--data", '{"entity":"companies","name":"Mine","filters":{}}', "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "views", "update", "v1", "--data", '{"name":"Mine2","filters":{},"version":1}', "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "views", "archive", "v1", "--json"], io), EXIT.ok);
    } finally {
      restore();
    }
  });

  test("unknown crm verbs are usage errors", async () => {
    const io = captureIo();
    const code = await run(["crm", "companies", "frobnicate"], io);
    assert.equal(code, EXIT.usage);
  });
});
