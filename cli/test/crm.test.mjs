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

  test("companies list executes a saved view with explicit flags winning", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/views/builtin%3Acompanies%3Arecent": {
        status: 200,
        body: { id: "builtin:companies:recent", entity: "companies", builtin: true, filters: { active: "true" }, resolvedFilters: { active: "true", lastTouchAfter: "2026-09-17" }, resolvedToday: "2026-10-17" },
      },
      "GET /api/sponsor-crm/directory/companies": (call) => ({ status: 200, body: { items: [], total: 0, nextCursor: null, query: call.query } }),
    });
    try {
      const code = await run(["crm", "companies", "list", "--saved-view", "builtin:companies:recent", "--active", "all", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[1].query.lastTouchAfter, "2026-09-17");
      assert.equal(calls[1].query.active, "all");
    } finally {
      restore();
    }
  });

  test("pipeline list passes saved-view filters to the canonical endpoint", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/views/v9": {
        status: 200,
        body: { id: "v9", entity: "pipeline", filters: { view: "actionable" }, resolvedFilters: { view: "actionable" }, sort: { field: "next-action" } },
      },
      "GET /api/sponsor-crm/pipeline": (call) => ({ status: 200, body: { items: [], query: call.query } }),
    });
    try {
      const code = await run(["crm", "pipeline", "list", "--saved-view", "v9", "--stage", "open", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[1].query.view, "actionable");
      assert.equal(calls[1].query.sort, "next-action");
      assert.equal(calls[1].query.stage, "open");
    } finally {
      restore();
    }
  });

  for (const view of ["early", "overdue", "reply"]) {
    test(`pipeline ${view} flags and saved-view date filters have canonical query parity`, async () => {
      const io = captureIo();
      const filters = { view, nextActionFrom: "2026-10-15", nextActionBefore: "2026-10-17" };
      const { calls, restore } = fake({
        "GET /api/sponsor-crm/views/v-filter": { status: 200, body: { entity: "pipeline", resolvedFilters: filters } },
        "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [] } },
      });
      try {
        assert.equal(await run(["crm", "pipeline", "list", "--saved-view", "v-filter", "--json"], io), EXIT.ok);
        const savedQuery = calls[1].query;
        assert.equal(await run(["crm", "pipeline", "list", "--view", view,
          "--next-action-from", "2026-10-15", "--next-action-before", "2026-10-17", "--json"], io), EXIT.ok);
        assert.deepEqual(calls[2].query, savedQuery);
        assert.equal(await run(["crm", "pipeline", "list", "--saved-view", "v-filter",
          "--next-action-from", "2026-10-16", "--json"], io), EXIT.ok);
        assert.deepEqual(calls[4].query, { ...filters, nextActionFrom: "2026-10-16" });
        assert.ok(calls.every((call) => call.method === "GET"));
      } finally { restore(); }
    });
  }

  test("archive wraps the existing communications endpoint read-only", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/deals/d9/communications": { status: 200, body: { items: [] } },
    });
    try {
      const code = await run(["crm", "archive", "d9", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].route, "/api/sponsor-crm/deals/d9/communications");
    } finally {
      restore();
    }
  });

  test("views show returns one resolved view", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/views/v9": { status: 200, body: { id: "v9", resolvedFilters: {} } },
    });
    try {
      const code = await run(["crm", "views", "show", "v9", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(io.json().id, "v9");
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  });

  test("activity human output follows effective/deferred dates, not raw dates", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/activity/organization/o1": {
        status: 200,
        body: {
          items: [], total: 0, nextCursor: null, tasksScope: "open",
          relatedWork: [{
            taskId: "t1", status: "waiting", date: "2026-01-06", description: "Future follow-up",
            effectiveDate: "2099-01-01", eligible: false, deferred: true, deferredUntil: "2099-01-01T00:00:00Z",
            subjectHref: "/sponsors/companies/o1", scope: "direct",
          }],
        },
      },
    });
    try {
      const code = await run(["crm", "activity", "organization", "o1"], io);
      assert.equal(code, EXIT.ok);
      assert.match(io.text(), /2099-01-01/);
      assert.match(io.text(), /deferred/);
      assert.doesNotMatch(io.text(), /Open waiting 2026-01-06/);
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
