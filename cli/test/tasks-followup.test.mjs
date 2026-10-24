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

const task = (fields) => ({ status: "todo", version: 1, description: "Synthetic task", ...fields });

describe("tasks followup", () => {
  test("about a card creates the follow-up on that card, due the resolved day", async () => {
    process.env.DATAOPS_TODAY = "2026-10-17";
    const calls = fakePortal({
      "GET /api/cards/c-1": { card: { id: "c-1", title: "Card" } },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-1", ...body }) }),
    });
    const io = captureIo();
    assert.equal(
      await run(["tasks", "followup", "--about", "c-1", "--on", "+7d", "--description", "check X", "--note", "context"], io),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      description: "check X",
      date: "2026-10-24",
      cardId: "c-1",
      comment: "context",
    });
    assert.match(io.text(), /Created follow-up Task f-1 about card c-1/);
  });

  test("about a task inherits its card, about a deal links the subject", async () => {
    let calls = fakePortal({
      "GET /api/tasks/t-9": task({ id: "t-9", cardId: "c-9" }),
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-2", ...body }) }),
    });
    assert.equal(await run(["tasks", "followup", "--about", "t-9", "--on", "2026-10-20", "--description", "check"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { description: "check", date: "2026-10-20", cardId: "c-9" });

    calls = fakePortal({
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-3", ...body }) }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "followup", "--about", "deal-7", "--on", "mon", "--description", "check X"], io), 0);
    // 2026-10-17 is a Saturday in the fake lane only with DATAOPS_TODAY; without it
    // the weekday still resolves to a Monday strictly in the future.
    assert.match(calls.at(-1).body.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(calls.at(-1).body.subject, { type: "sponsor-deal", id: "deal-7" });
    assert.match(io.text(), /about sponsor deal deal-7/);
  });

  test("about a task with a subject inherits the subject, --assignee is honored", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-8": task({ id: "t-8", subject: { type: "sponsor-deal", id: "deal-3", label: "Acme", href: "/sponsors/deals/deal-3" } }),
      "GET /api/me": { user: { id: "u-orin" } },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-4", ...body }) }),
    });
    assert.equal(
      await run(["tasks", "followup", "--about", "t-8", "--on", "2026-10-20", "--description", "check", "--assignee", "me"], captureIo()),
      0,
    );
    assert.deepEqual(calls.at(-1).body.subject, { type: "sponsor-deal", id: "deal-3" });
    assert.equal(calls.at(-1).body.assigneeId, "u-orin");
  });

  test("about a company or person links the corresponding subject", async () => {
    let calls = fakePortal({
      "GET /api/sponsor-crm/directory/companies/org-1": { id: "org-1", displayName: "Fabi.ai" },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-5", ...body }) }),
    });
    let io = captureIo();
    assert.equal(
      await run(["tasks", "followup", "--about", "org-1", "--on", "2026-10-25", "--description", "check pricing"], io),
      0,
    );
    assert.deepEqual(calls.at(-1).body.subject, { type: "sponsor-company", id: "org-1" });
    assert.match(io.text(), /about company Fabi\.ai/);

    calls = fakePortal({
      "GET /api/sponsor-crm/contacts/cnt-1": { id: "cnt-1", name: "Allie Beazell" },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "f-6", ...body }) }),
    });
    io = captureIo();
    assert.equal(
      await run(["tasks", "followup", "--about", "cnt-1", "--on", "2026-10-25", "--description", "ping on slack"], io),
      0,
    );
    assert.deepEqual(calls.at(-1).body.subject, { type: "sponsor-person", id: "cnt-1" });
    assert.match(io.text(), /about person Allie Beazell/);
  });

  test("missing flags are usage errors before anything is sent", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    assert.equal(await run(["tasks", "followup", "--about", "c-1", "--on", "2026-10-20"], io), 2);
    assert.match(io.errors.join("\n"), /--description is required/);
    assert.equal(calls.length, 0);
  });
});
