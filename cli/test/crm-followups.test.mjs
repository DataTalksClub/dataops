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
});
