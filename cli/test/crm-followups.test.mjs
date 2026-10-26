import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

describe("CLI crm followups and dnc", () => {
  beforeEach(() => {
    isolateConfig();
    delete globalThis.fetch;
  });

  test("dataops crm followups lists open follow-up tasks", async () => {
    const calls = fakePortal({
      "GET /api/sponsor-crm/followups": () => ({
        status: 200,
        body: {
          items: [
            {
              task: { id: "task-1", date: "2026-10-22", status: "todo", title: "Check deck", description: "Check deck" },
              subjectType: "sponsor-company",
              subjectId: "org-1",
              subjectName: "Acme Corp",
              isDue: true,
              isOverdue: false,
            },
          ],
          total: 1,
        },
      }),
    });
    const io = captureIo();
    const code = await run(["crm", "followups"], io);
    assert.equal(code, 0);
    assert.ok(io.text().includes("task-1"));
    assert.ok(io.text().includes("Acme Corp"));
    assert.ok(io.text().includes("Check deck"));
    assert.equal(calls.length, 1);
  });

  test("dataops crm followups --due and --overdue pass query filters", async () => {
    let capturedQuery;
    fakePortal({
      "GET /api/sponsor-crm/followups": ({ query }) => {
        capturedQuery = query;
        return { status: 200, body: { items: [], total: 0 } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["crm", "followups", "--due"], io), 0);
    assert.equal(capturedQuery.due, "true");

    assert.equal(await run(["crm", "followups", "--overdue"], io), 0);
    assert.equal(capturedQuery.overdue, "true");
  });

  test("dataops crm company dnc sets and unsets doNotContact flag", async () => {
    let requestBody;
    fakePortal({
      "POST /api/sponsor-crm/organizations/org-123/dnc": ({ body }) => {
        requestBody = body;
        return { status: 200, body: { id: "org-123", doNotContact: body.doNotContact } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["crm", "company", "dnc", "org-123", "--note", "pulled out"], io), 0);
    assert.deepEqual(requestBody, { doNotContact: true, note: "pulled out" });
    assert.ok(io.text().includes("marked do-not-contact"));

    assert.equal(await run(["crm", "company", "dnc", "org-123", "--unset"], io), 0);
    assert.deepEqual(requestBody, { doNotContact: false });
    assert.ok(io.text().includes("marked contactable"));
  });

  test("dataops crm person dnc sets and unsets doNotContact flag", async () => {
    let requestBody;
    fakePortal({
      "POST /api/sponsor-crm/contacts/p-456/dnc": ({ body }) => {
        requestBody = body;
        return { status: 200, body: { id: "p-456", doNotContact: body.doNotContact } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["crm", "person", "dnc", "p-456", "--note", "unsubscribed"], io), 0);
    assert.deepEqual(requestBody, { doNotContact: true, note: "unsubscribed" });
    assert.ok(io.text().includes("marked do-not-contact"));

    assert.equal(await run(["crm", "person", "dnc", "p-456", "--unset"], io), 0);
    assert.deepEqual(requestBody, { doNotContact: false });
    assert.ok(io.text().includes("marked contactable"));
  });

  test("companies list and people list pass tag, contact dates, and dnc filters", async () => {
    let companyQuery;
    let peopleQuery;
    fakePortal({
      "GET /api/sponsor-crm/directory/companies": ({ query }) => {
        companyQuery = query;
        return { status: 200, body: { items: [], total: 0 } };
      },
      "GET /api/sponsor-crm/directory/people": ({ query }) => {
        peopleQuery = query;
        return { status: 200, body: { items: [], total: 0 } };
      },
    });
    const io = captureIo();
    assert.equal(
      await run([
        "crm", "companies", "list",
        "--tag", "inbound",
        "--first-contact-after", "2026-09-01",
        "--last-contact-before", "2026-10-01",
        "--dnc", "false",
      ], io),
      0,
    );
    assert.equal(companyQuery.tag, "inbound");
    assert.equal(companyQuery.firstContactAfter, "2026-09-01");
    assert.equal(companyQuery.lastContactBefore, "2026-10-01");
    assert.equal(companyQuery.dnc, "false");

    assert.equal(
      await run([
        "crm", "people", "list",
        "--tag", "inbound",
        "--first-contact-before", "2026-09-20",
        "--last-contact-after", "2026-10-01",
        "--dnc", "false",
        "--no-deal", "true",
      ], io),
      0,
    );
    assert.equal(peopleQuery.tag, "inbound");
    assert.equal(peopleQuery.firstContactBefore, "2026-09-20");
    assert.equal(peopleQuery.lastContactAfter, "2026-10-01");
    assert.equal(peopleQuery.dnc, "false");
    assert.equal(peopleQuery.noDeal, "true");
  });

  test("dataops crm followups lists direct contact/company follow-ups", async () => {
    fakePortal({
      "GET /api/sponsor-crm/followups": () => ({
        status: 200,
        body: {
          items: [],
          records: [
            { kind: "company", id: "org-9", name: "Acme Corp", follow_up_at: "2026-10-20", follow_up_status: "open", follow_up_note: "revisit", isDue: true, isOverdue: true },
            { kind: "person", id: "p-9", name: "Jane", organizationId: "org-9", organizationName: "Acme Corp", follow_up_at: "2026-11-01", follow_up_status: "open", isDue: false, isOverdue: false },
          ],
          total: 2,
        },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["crm", "followups"], io), 0);
    assert.ok(io.text().includes("Acme Corp"));
    assert.ok(io.text().includes("2026-10-20"));
    assert.ok(io.text().includes("Jane (Acme Corp)"));
  });

  test("dataops crm company followup sets, and clears, the direct follow-up", async () => {
    let requestBody;
    fakePortal({
      "POST /api/sponsor-crm/organizations/org-123/followup": ({ body }) => {
        requestBody = body;
        return { status: 200, body: { id: "org-123", ...body } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["crm", "company", "followup", "org-123", "--on", "2026-11-05", "--status", "open", "--note", "revisit"], io), 0);
    assert.deepEqual(requestBody, { follow_up_at: "2026-11-05", follow_up_status: "open", follow_up_note: "revisit" });
    assert.ok(io.text().includes("2026-11-05"));

    assert.equal(await run(["crm", "company", "followup", "org-123", "--clear"], io), 0);
    assert.deepEqual(requestBody, { clear: true });

    assert.notEqual(await run(["crm", "company", "followup", "org-123"], io), 0);
  });

  test("dataops crm person followup rejects an unknown status", async () => {
    fakePortal({});
    const io = captureIo();
    assert.notEqual(await run(["crm", "person", "followup", "p-456", "--on", "2026-11-05", "--status", "someday"], io), 0);
  });

  test("company update passes follow-up flags through to the API", async () => {
    let requestBody;
    fakePortal({
      "PUT /api/sponsor-crm/organizations/org-123": ({ body }) => {
        requestBody = body;
        return { status: 200, body: { id: "org-123" } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["crm", "company", "update", "org-123", "--follow-up-at", "2026-11-05", "--follow-up-status", "open"], io), 0);
    assert.equal(requestBody.follow_up_at, "2026-11-05");
    assert.equal(requestBody.follow_up_status, "open");
  });
});
