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
      const code = await run(["crm", "companies", "list", "--search", "acme", "--relationship", "talking", "--tag", "inbound", "--json"], io);
      assert.equal(code, EXIT.ok);
      assert.equal(calls[0].query.search, "acme");
      assert.equal(calls[0].query.relationship, "talking");
      assert.equal(calls[0].query.tag, "inbound");
      const body = io.json();
      assert.equal(body.total, 1);
      assert.equal(body.items[0].displayName, "Acme");
    } finally {
      restore();
    }
  });

  test("people list, person show/create/update/archive/unarchive reach canonical contact endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/people": { status: 200, body: { items: [], total: 0, nextCursor: null } },
      "GET /api/sponsor-crm/contacts/a1000000-0000-4000-8000-000000000001": { status: 200, body: { id: "a1000000-0000-4000-8000-000000000001", name: "Ada" } },
      "POST /api/sponsor-crm/contacts": (call) => ({ status: 201, body: { id: "p2", ...call.body } }),
      "PUT /api/sponsor-crm/contacts/p2": (call) => ({ status: 200, body: { id: "p2", ...call.body } }),
      "DELETE /api/sponsor-crm/contacts/p2": { status: 200, body: { id: "p2", archivedAt: "2026-10-19" } },
      "POST /api/sponsor-crm/contacts/p2/unarchive": { status: 200, body: { id: "p2", active: true } },
    });
    try {
      assert.equal(await run(["crm", "people", "list", "--unlinked", "true", "--tag", "inbound", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.unlinked, "true");
      assert.equal(calls[0].query.tag, "inbound");
      assert.equal(await run(["crm", "person", "show", "a1000000-0000-4000-8000-000000000001", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "person", "create", "--data", '{"name":"Bo"}', "--tags", "inbound", "--first-contact-at", "2026-08-01T00:00:00Z", "--last-contact-at", "2026-09-01T00:00:00Z", "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.name, "Bo");
      assert.deepEqual(calls[2].body.tags, ["inbound"]);
      assert.equal(calls[2].body.first_contact_at, "2026-08-01T00:00:00Z");
      assert.equal(calls[2].body.last_contact_at, "2026-09-01T00:00:00Z");
      assert.equal(await run(["crm", "person", "update", "p2", "--data", '{"name":"Bo2","version":1}', "--first-contact-at", "2026-08-05T00:00:00Z", "--json"], io), EXIT.ok);
      assert.equal(calls[3].body.name, "Bo2");
      assert.equal(calls[3].body.first_contact_at, "2026-08-05T00:00:00Z");
      assert.equal(await run(["crm", "person", "archive", "p2", "--json"], io), EXIT.ok);
      assert.equal(calls[4].route, "/api/sponsor-crm/contacts/p2");
      io.out.length = 0;
      assert.equal(await run(["crm", "person", "archive", "p2"], io), EXIT.ok);
      assert.ok(io.text().includes("Archived person p2."));
      assert.equal(await run(["crm", "person", "unarchive", "p2", "--json"], io), EXIT.ok);
      assert.equal(calls[6].route, "/api/sponsor-crm/contacts/p2/unarchive");
      io.out.length = 0;
      assert.equal(await run(["crm", "person", "unarchive", "p2"], io), EXIT.ok);
      assert.ok(io.text().includes("Unarchived person p2."));
    } finally {
      restore();
    }
  });

  test("company show/create/update/archive reach canonical directory and organization endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/directory/companies/b2000000-0000-4000-8000-000000000001": { status: 200, body: { id: "b2000000-0000-4000-8000-000000000001", displayName: "Acme", version: 1 } },
      "POST /api/sponsor-crm/organizations": (call) => ({ status: 201, body: { id: "org2", ...call.body } }),
      "PUT /api/sponsor-crm/organizations/org2": (call) => ({ status: 200, body: { id: "org2", ...call.body } }),
      "DELETE /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", archivedAt: "2026-10-19" } },
      "POST /api/sponsor-crm/organizations/org2/unarchive": { status: 200, body: { id: "org2", active: true } },
    });
    try {
      assert.equal(await run(["crm", "company", "show", "b2000000-0000-4000-8000-000000000001", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/directory/companies/b2000000-0000-4000-8000-000000000001");
      assert.equal(await run(["crm", "company", "create", "--data", '{"displayName":"Beta"}', "--tags", "inbound", "--first-contact-at", "2026-07-01T00:00:00Z", "--last-contact-at", "2026-09-01T00:00:00Z", "--json"], io), EXIT.ok);
      assert.equal(calls[1].body.displayName, "Beta");
      assert.deepEqual(calls[1].body.tags, ["inbound"]);
      assert.equal(calls[1].body.first_contact_at, "2026-07-01T00:00:00Z");
      assert.equal(calls[1].body.last_contact_at, "2026-09-01T00:00:00Z");
      assert.equal(await run(["crm", "company", "update", "org2", "--data", '{"displayName":"Beta 2","version":1}', "--last-contact-at", "2026-10-01T00:00:00Z", "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.displayName, "Beta 2");
      assert.equal(calls[2].body.last_contact_at, "2026-10-01T00:00:00Z");
      assert.equal(await run(["crm", "company", "archive", "org2", "--json"], io), EXIT.ok);
      assert.equal(calls[3].route, "/api/sponsor-crm/organizations/org2");
      assert.equal(await run(["crm", "company", "unarchive", "org2", "--json"], io), EXIT.ok);
      assert.equal(calls[4].route, "/api/sponsor-crm/organizations/org2/unarchive");
    } finally {
      restore();
    }
  });

  test("company human output formatting", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/directory/companies/b2000000-0000-4000-8000-000000000001": { status: 200, body: { id: "b2000000-0000-4000-8000-000000000001", displayName: "Acme" } },
      "POST /api/sponsor-crm/organizations": { status: 201, body: { id: "org2", displayName: "Beta" } },
      "PUT /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", displayName: "Beta 2" } },
      "DELETE /api/sponsor-crm/organizations/org2": { status: 200, body: { id: "org2", archivedAt: "2026-10-19" } },
      "POST /api/sponsor-crm/organizations/org2/unarchive": { status: 200, body: { id: "org2", active: true } },
    });
    try {
      assert.equal(await run(["crm", "company", "show", "b2000000-0000-4000-8000-000000000001"], io), EXIT.ok);
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
      io.out.length = 0;
      assert.equal(await run(["crm", "company", "unarchive", "org2"], io), EXIT.ok);
      assert.ok(io.text().includes("Unarchived company org2."));
    } finally {
      restore();
    }
  });

  test("deal show/create/update/archive reach canonical deal endpoints", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/deals/d4000000-0000-4000-8000-000000000001": { status: 200, body: { id: "d4000000-0000-4000-8000-000000000001", title: "Q4 Sponsorship", status: "agreed", version: 1 } },
      "POST /api/sponsor-crm/deals": (call) => ({ status: 201, body: { id: "deal2", ...call.body } }),
      "PUT /api/sponsor-crm/deals/deal2": (call) => ({ status: 200, body: { id: "deal2", ...call.body } }),
      "DELETE /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", archivedAt: "2026-10-19" } },
      "POST /api/sponsor-crm/deals/deal2/unarchive": { status: 200, body: { id: "deal2", active: true } },
    });
    try {
      assert.equal(await run(["crm", "deal", "show", "d4000000-0000-4000-8000-000000000001", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/deals/d4000000-0000-4000-8000-000000000001");
      assert.equal(await run(["crm", "deal", "create", "--data", '{"organizationId":"org1","status":"open","title":"New Deal"}', "--json"], io), EXIT.ok);
      assert.equal(calls[1].body.title, "New Deal");
      assert.equal(await run(["crm", "deal", "update", "deal2", "--data", '{"title":"Updated Deal","version":1}', "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.title, "Updated Deal");
      assert.equal(await run(["crm", "deal", "archive", "deal2", "--json"], io), EXIT.ok);
      assert.equal(calls[3].route, "/api/sponsor-crm/deals/deal2");
      assert.equal(await run(["crm", "deal", "unarchive", "deal2", "--json"], io), EXIT.ok);
      assert.equal(calls[4].route, "/api/sponsor-crm/deals/deal2/unarchive");
    } finally {
      restore();
    }
  });

  test("deal human output formatting", async () => {
    const io = captureIo();
    const { restore } = fake({
      "GET /api/sponsor-crm/deals/d4000000-0000-4000-8000-000000000001": { status: 200, body: { id: "d4000000-0000-4000-8000-000000000001", title: "Q4 Sponsorship", status: "agreed" } },
      "POST /api/sponsor-crm/deals": { status: 201, body: { id: "deal2", title: "New Deal" } },
      "PUT /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", title: "Updated Deal" } },
      "DELETE /api/sponsor-crm/deals/deal2": { status: 200, body: { id: "deal2", archivedAt: "2026-10-19" } },
      "POST /api/sponsor-crm/deals/deal2/unarchive": { status: 200, body: { id: "deal2", active: true } },
    });
    try {
      assert.equal(await run(["crm", "deal", "show", "d4000000-0000-4000-8000-000000000001"], io), EXIT.ok);
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
      io.out.length = 0;
      assert.equal(await run(["crm", "deal", "unarchive", "deal2"], io), EXIT.ok);
      assert.ok(io.text().includes("Unarchived deal deal2."));
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
      assert.equal(await run(["crm", "activity", "contact", "c1", "--types", "note,mail", "--limit", "10", "--cursor", "c_1", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.types, "note,mail");
      assert.equal(calls[0].query.limit, "10");
      assert.equal(calls[0].query.cursor, "c_1");
      assert.equal(await run(["crm", "notes", "list", "organization", "o1", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "note", "add", "organization", "o1", "--body", "Called", "--source-key", "k1", "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.body, "Called");
      assert.equal(calls[2].body.sourceKey, "k1");
    } finally {
      restore();
    }
  });

  test("note show, update, and delete reach note item endpoints with aliases and versioning", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "GET /api/sponsor-crm/notes/organization/o1/n1": {
        status: 200,
        body: { id: "n1", targetType: "organization", targetId: "o1", authorId: "u1", body: "Initial note text", createdAt: "2026-10-19T10:00:00Z", version: 1 },
      },
      "PUT /api/sponsor-crm/notes/organization/o1/n1": (call) => ({
        status: 200,
        body: { id: "n1", targetType: "organization", targetId: "o1", authorId: "u1", body: call.body.body, version: 2, updatedAt: "2026-10-19T11:00:00Z" },
      }),
      "DELETE /api/sponsor-crm/notes/organization/o1/n1": {
        status: 200,
        body: { id: "n1", deleted: true },
      },
      "DELETE /api/sponsor-crm/notes/contact/c1/n2": {
        status: 200,
        body: { id: "n2", deleted: true },
      },
    });
    try {
      // Usage errors
      assert.equal(await run(["crm", "note", "show"], io), EXIT.usage);
      assert.equal(await run(["crm", "note", "show", "organization", "o1"], io), EXIT.usage);
      assert.equal(await run(["crm", "note", "update", "organization", "o1", "n1"], io), EXIT.usage);
      assert.equal(await run(["crm", "note", "delete", "organization", "o1"], io), EXIT.usage);

      // note show (JSON and human)
      assert.equal(await run(["crm", "note", "show", "organization", "o1", "n1", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/notes/organization/o1/n1");
      io.out.length = 0;
      assert.equal(await run(["crm", "note", "show", "company", "o1", "n1"], io), EXIT.ok);
      assert.ok(io.text().includes("Note n1"));
      assert.ok(io.text().includes("Initial note text"));

      // note update (JSON, version, and edit alias)
      assert.equal(await run(["crm", "note", "update", "organization", "o1", "n1", "--body", "Updated text", "--version", "1", "--json"], io), EXIT.ok);
      assert.deepEqual(calls[2].body, { body: "Updated text", version: 1 });
      io.out.length = 0;
      assert.equal(await run(["crm", "note", "edit", "company", "o1", "n1", "--body", "Updated text 2"], io), EXIT.ok);
      assert.ok(io.text().includes("Updated note n1 on organization o1."));

      // note delete (JSON, remove alias, person alias)
      assert.equal(await run(["crm", "note", "delete", "organization", "o1", "n1", "--json"], io), EXIT.ok);
      assert.equal(calls[4].route, "/api/sponsor-crm/notes/organization/o1/n1");
      io.out.length = 0;
      assert.equal(await run(["crm", "note", "remove", "person", "c1", "n2"], io), EXIT.ok);
      assert.equal(calls[5].route, "/api/sponsor-crm/notes/contact/c1/n2");
      assert.ok(io.text().includes("Deleted note n2 from contact c1."));
    } finally {
      restore();
    }
  });

  test("touch requires valid target, channel and logs outreach with human and json output", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      "POST /api/sponsor-crm/touches": (call) => ({
        status: 201,
        body: { organization: { id: "org1", lastOutboundAt: "2026-10-18" }, messageId: "msg1", ...call.body },
      }),
    });
    try {
      assert.equal(await run(["crm", "touch"], io), EXIT.usage);
      assert.equal(await run(["crm", "touch", "deal", "d1", "--channel", "email"], io), EXIT.usage);
      assert.equal(await run(["crm", "touch", "contact", "c1"], io), EXIT.usage);
      assert.equal(await run(["crm", "touch", "contact", "c1", "--channel", "invalid"], io), EXIT.usage);

      // contact touch with note, date, json
      assert.equal(await run(["crm", "touch", "contact", "c1", "--channel", "email", "--note", "Sent deck", "--date", "2026-10-18", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/touches");
      assert.deepEqual(calls[0].body, { targetType: "contact", targetId: "c1", channel: "email", note: "Sent deck", touchedAt: "2026-10-18" });

      // organization touch with human output
      io.out.length = 0;
      assert.equal(await run(["crm", "touch", "organization", "org1", "--channel", "call"], io), EXIT.ok);
      assert.equal(calls[1].body.targetType, "organization");
      assert.equal(calls[1].body.channel, "call");
      assert.ok(io.text().includes("Logged call touch for organization org1."));

      // company/person aliases
      assert.equal(await run(["crm", "touch", "company", "org1", "--channel", "meeting", "--json"], io), EXIT.ok);
      assert.equal(calls[2].body.targetType, "organization");
      assert.equal(await run(["crm", "touch", "person", "c1", "--channel", "linkedin", "--json"], io), EXIT.ok);
      assert.equal(calls[3].body.targetType, "contact");

      // subverb alias (touch add / touch log)
      assert.equal(await run(["crm", "touch", "add", "contact", "c1", "--channel", "other", "--json"], io), EXIT.ok);
      assert.equal(calls[4].body.targetType, "contact");
      assert.equal(calls[4].body.channel, "other");
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
      "POST /api/sponsor-crm/views/v1/unarchive": { status: 200, body: { id: "v1" } },
    });
    try {
      assert.equal(await run(["crm", "views", "list", "--entity", "companies", "--json"], io), EXIT.ok);
      assert.equal(calls[0].query.entity, "companies");
      assert.equal(await run(["crm", "views", "create", "--data", '{"entity":"companies","name":"Mine","filters":{}}', "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "views", "update", "v1", "--data", '{"name":"Mine2","filters":{},"version":1}', "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "views", "archive", "v1", "--json"], io), EXIT.ok);
      assert.equal(await run(["crm", "views", "unarchive", "v1", "--json"], io), EXIT.ok);
      io.out.length = 0;
      assert.equal(await run(["crm", "views", "unarchive", "v1"], io), EXIT.ok);
      assert.ok(io.text().includes("Unarchived view v1."));
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

describe('CLI CRM hard delete', () => {
  beforeEach(isolateConfig);
  for (const [entity, plural] of [['company', 'organizations'], ['person', 'contacts']]) {
    test(`${entity} delete requires confirmation and reports API exit codes`, async () => {
      let status = 200;
      const calls = fakePortal({
        [`DELETE /api/sponsor-crm/${plural}/fixture`]: () => ({ status, body: status === 200 ? { id: 'fixture', deleted: true } : { error: status === 404 ? 'Not found' : 'Record has notes' } }),
      });
      try {
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--json'], captureIo()), EXIT.usage);
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes=false', '--json'], captureIo()), EXIT.usage);
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes', '--expected-version', '--json'], captureIo()), EXIT.usage);
        for (const version of ['0', '-1', '1.5', 'invalid', '9007199254740992']) {
          assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes', '--expected-version', version, '--json'], captureIo()), EXIT.usage);
        }
        assert.equal(calls.length, 0);
        const io = captureIo();
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes', '--expected-version', '3', '--json'], io), EXIT.ok);
        assert.deepEqual(io.json(), { id: 'fixture', deleted: true });
        assert.equal(calls[0].query.hard, 'true'); assert.equal(calls[0].query.expectedVersion, '3');
        const human = captureIo();
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes'], human), EXIT.ok);
        assert.match(human.text(), /Deleted/);
        status = 404;
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes', '--json'], captureIo()), 4);
        status = 409;
        const conflict = captureIo();
        assert.equal(await run(['crm', entity, 'delete', 'fixture', '--yes', '--json'], conflict), 5);
        assert.match(JSON.parse(conflict.errors.join('\n')).error.message, /notes/);
      } finally { delete globalThis.fetch; }
    });
  }
  test('sponsors delete deals requires confirmation, sends the hard delete and reports API exit codes', async () => {
    let status = 200;
    const calls = fakePortal({
      'DELETE /api/sponsor-crm/deals/fixture': () => ({ status, body: status === 200 ? { id: 'fixture', deleted: true } : { error: status === 404 ? 'Not found' : 'Deal has a deliverable (d1); hard delete is refused' } }),
    });
    try {
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--json'], captureIo()), EXIT.usage);
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes=false', '--json'], captureIo()), EXIT.usage);
      for (const version of ['0', '-1', '1.5', 'invalid']) {
        assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes', '--expected-version', version, '--json'], captureIo()), EXIT.usage);
      }
      assert.equal(await run(['sponsors', 'delete', 'organizations', 'fixture', '--yes', '--json'], captureIo()), EXIT.usage);
      assert.equal(calls.length, 0);
      const io = captureIo();
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes', '--expected-version', '3', '--json'], io), EXIT.ok);
      assert.deepEqual(io.json(), { id: 'fixture', deleted: true });
      assert.equal(calls[0].query.hard, 'true'); assert.equal(calls[0].query.expectedVersion, '3');
      const human = captureIo();
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes'], human), EXIT.ok);
      assert.match(human.text(), /Deleted deal/);
      status = 404;
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes', '--json'], captureIo()), 4);
      status = 409;
      const conflict = captureIo();
      assert.equal(await run(['sponsors', 'delete', 'deals', 'fixture', '--yes', '--json'], conflict), 5);
      assert.match(JSON.parse(conflict.errors.join('\n')).error.message, /deliverable/);
    } finally { delete globalThis.fetch; }
  });
  test('help and agent guide document permanent deletion', async () => {
    for (const argv of [['crm', '--help'], ['agent-guide']]) {
      const io = captureIo(); assert.equal(await run(argv, io), EXIT.ok);
      assert.match(io.text(), /crm company delete/); assert.match(io.text(), /crm person delete/);
      assert.match(io.text(), /--yes/); assert.match(io.text(), /expected-version/);
    }
  });
});
