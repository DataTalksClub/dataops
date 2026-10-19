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

  test("people list, person show/create/update/archive reach canonical contact endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/people": { status: 200, body: { items: [], total: 0, nextCursor: null } },
      "GET /api/sponsor-crm/contacts/p1": { status: 200, body: { id: "p1", name: "Ada" } },
      "POST /api/sponsor-crm/contacts": (call) => ({ status: 201, body: { id: "p2", ...call.body } }),
      "PUT /api/sponsor-crm/contacts/p2": (call) => ({ status: 200, body: { id: "p2", ...call.body } }),
      "DELETE /api/sponsor-crm/contacts/p2": { status: 200, body: { id: "p2", archivedAt: "2026-10-19" } },
    });
    try {
      assert.equal(await run(["crm", "people", "list", "--unlinked", "true", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.unlinked, "true");
      assert.equal(await run(["crm", "person", "show", "p1", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "person", "create", "--data", '{"name":"Bo"}', "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.name, "Bo");
      assert.equal(await run(["crm", "person", "update", "p2", "--data", '{"name":"Bo2","version":1}', "--json"], io), EXIT.ok);
      assert.equal(calls[3].body.name, "Bo2");
      assert.equal(await run(["crm", "person", "archive", "p2", "--json"], io), EXIT.ok);
      assert.equal(calls[4].route, "/api/sponsor-crm/contacts/p2");
      io.out.length = 0;
      assert.equal(await run(["crm", "person", "archive", "p2"], io), EXIT.ok);
      assert.ok(io.text().includes("Archived person p2."));
    } finally {
      restore();
    }
  });

  test("company show/create/update/archive reach canonical directory and organization endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/companies/org1": { status: 200, body: { id: "org1", displayName: "Acme", version: 1 } },
      "POST /api/sponsor-crm/organizations": (call) => ({ status: 201, body: { id: "org2", ...call.body } }),
      "PUT /api/sponsor-crm/organizations/org2": (call) => ({ status: 200, body: { id: "org2", ...call.body } }),
      "DELETE /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", archivedAt: "2026-10-19" } },
    });
    try {
      assert.equal(await run(["crm", "company", "show", "org1", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/directory/companies/org1");
      assert.equal(await run(["crm", "company", "create", "--data", '{"displayName":"Beta"}', "--json"], io), EXIT.ok);
      assert.equal(calls[1].body.displayName, "Beta");
      assert.equal(await run(["crm", "company", "update", "org2", "--data", '{"displayName":"Beta 2","version":1}', "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.displayName, "Beta 2");
      assert.equal(await run(["crm", "company", "archive", "org2", "--json"], io), EXIT.ok);
      assert.equal(calls[3].route, "/api/sponsor-crm/organizations/org2");
    } finally {
      restore();
    }
  });

  test("company human output formatting", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/directory/companies/org1": { status: 200, body: { id: "org1", displayName: "Acme" } },
      "POST /api/sponsor-crm/organizations": { status: 201, body: { id: "org2", displayName: "Beta" } },
      "PUT /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", displayName: "Beta 2" } },
      "DELETE /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", archivedAt: "2026-10-19" } },
    });
    try {
      assert.equal(await run(["crm", "company", "show", "org1"], io), EXIT.ok);
      assert.ok(io.text().includes("Acme"));
      io.out.length = 0;
      assert.equal(await run(["crm", "company", "create", "--data", '{"displayName":"Beta"}'], io), EXIT.ok);
      assert.ok(io.text().includes("Created company org2."));
      io.out.length = 0;
      assert.equal(await run(["crm", "company", "update", "org2", "--data", '{"displayName":"Beta 2","version":1}'], io), EXIT.ok);
      assert.ok(io.text().includes("Updated company org2."));
      io.out.length = 0;
      assert.equal(await run(["crm", "company", "archive", "org2"], io), EXIT.ok);
      assert.ok(io.text().includes("Archived company org2."));
    } finally {
      restore();
    }
  });

  test("deal show/create/update/archive reach canonical deal endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/deals/deal1": { status: 200, body: { id: "deal1", title: "Q4 Sponsorship", status: "agreed", version: 1 } },
      "POST /api/sponsor-crm/deals": (call) => ({ status: 201, body: { id: "deal2", ...call.body } }),
      "PUT /api/sponsor-crm/deals/deal2": (call) => ({ status: 200, body: { id: "deal2", ...call.body } }),
      "DELETE /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", archivedAt: "2026-10-19" } },
    });
    try {
      assert.equal(await run(["crm", "deal", "show", "deal1", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/deals/deal1");
      assert.equal(await run(["crm", "deal", "create", "--data", '{"organizationId":"org1","status":"open","title":"New Deal"}', "--json"], io), EXIT.ok);
      assert.equal(calls[1].body.title, "New Deal");
      assert.equal(await run(["crm", "deal", "update", "deal2", "--data", '{"title":"Updated Deal","version":1}', "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.title, "Updated Deal");
      assert.equal(await run(["crm", "deal", "archive", "deal2", "--json"], io), EXIT.ok);
      assert.equal(calls[3].route, "/api/sponsor-crm/deals/deal2");
    } finally {
      restore();
    }
  });

  test("deal human output formatting", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/deals/deal1": { status: 200, body: { id: "deal1", title: "Q4 Sponsorship", status: "agreed" } },
      "POST /api/sponsor-crm/deals": { status: 201, body: { id: "deal2", title: "New Deal" } },
      "PUT /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", title: "Updated Deal" } },
      "DELETE /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", archivedAt: "2026-10-19" } },
    });
    try {
      assert.equal(await run(["crm", "deal", "show", "deal1"], io), EXIT.ok);
      assert.ok(io.text().includes("Q4 Sponsorship"));
      io.out.length = 0;
      assert.equal(await run(["crm", "deal", "create", "--data", '{"organizationId":"org1","status":"open"}'], io), EXIT.ok);
      assert.ok(io.text().includes("Created deal deal2."));
      io.out.length = 0;
      assert.equal(await run(["crm", "deal", "update", "deal2", "--data", '{"title":"Updated Deal","version":1}'], io), EXIT.ok);
      assert.ok(io.text().includes("Updated deal deal2."));
      io.out.length = 0;
      assert.equal(await run(["crm", "deal", "archive", "deal2"], io), EXIT.ok);
      assert.ok(io.text().includes("Archived deal deal2."));
    } finally {
      restore();
    }
  });

  test("deals list maps flags to deals query and pages", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/deals": (call) => ({
        status: 200,
        body: { items: [{ id: "d1", title: "Q4 Sponsorship", organizationId: "org1", status: "agreed", money: "paid" }], nextCursor: "2" },
      }),
    });
    try {
      const code = await run(["crm", "deals", "list", "--company", "org1", "--status", "agreed", "--search", "sponsorship", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[0].query.organizationId, "org1");
      assert.equal(calls[0].query.status, "agreed");
      assert.equal(calls[0].query.search, "sponsorship");
      const body = io.json();
      assert.equal(body.items[0].id, "d1");
      assert.equal(body.items[0].title, "Q4 Sponsorship");
    } finally {
      restore();
    }
  });

  test("deals list human output formatting", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/deals": {
        status: 200,
        body: { items: [{ id: "d1", title: "Q4 Sponsorship", organizationId: "org1", status: "agreed", money: "paid" }], nextCursor: "10" },
      },
    });
    try {
      assert.equal(await run(["crm", "deals", "list"], io), EXIT.ok);
      assert.ok(io.text().includes("Q4 Sponsorship"));
      assert.ok(io.text().includes("agreed"));
      assert.ok(io.text().includes("paid"));
      assert.ok(io.text().includes("More: --cursor 10."));
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
