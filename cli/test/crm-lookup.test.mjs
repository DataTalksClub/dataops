import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const { EXIT } = await import("../src/errors.mjs");

// Pinned so waiting/proceed verdicts are deterministic.
process.env.DATAOPS_TODAY = "2026-10-20";

const ANGELA = { id: "p1", name: "Angela Merit", organizationId: "o1", emails: ["Angela@MeritMap.ai"], primary: true, role: "CEO", companyName: "MeritMap", active: true };
const TUSHAR = { id: "p2", name: "Tushar Jinee", organizationId: "o1", emails: ["tushar@jineegreencard.com"], primary: false, companyName: "MeritMap", active: true };
const MERITMAP = { id: "o1", displayName: "MeritMap", domain: "meritmap.ai", relationship: "sponsor" };

const WAITING_DEAL = {
  id: "d1", organizationId: "o1", organizationName: "MeritMap", title: "Newsletter Aug 24", status: "open",
  stage: "invoiced", money: "invoiced", fulfillment: "in-delivery", amountEur: 3000, replyReview: false,
  lastContacted: "2026-08-24T10:00:00Z",
  nextTask: { id: "t1", description: "return later", date: "2026-11-01", deferred: false, assigneeId: "alexey", status: "waiting" },
  primaryContact: { id: "p1", name: "Angela Merit", email: "angela@meritmap.ai", role: "CEO" },
};

function meritmapRoutes() {
  return {
    "GET /api/sponsor-crm/directory/people": ({ query }) => {
      if (query.company === "o1") return { status: 200, body: { items: [ANGELA, TUSHAR], total: 2, nextCursor: null } };
      const needle = String(query.search || "").toLowerCase();
      if (needle === "angela@meritmap.ai") return { status: 200, body: { items: [ANGELA], total: 1, nextCursor: null } };
      if (needle === "tushar@jineegreencard.com") return { status: 200, body: { items: [TUSHAR], total: 1, nextCursor: null } };
      return { status: 200, body: { items: [], total: 0, nextCursor: null } };
    },
    "GET /api/sponsor-crm/directory/companies": ({ query }) => {
      if (String(query.search || "").toLowerCase() === "meritmap.ai") return { status: 200, body: { items: [MERITMAP], total: 1, nextCursor: null } };
      return { status: 200, body: { items: [], total: 0, nextCursor: null } };
    },
    "GET /api/sponsor-crm/directory/companies/o1": { status: 200, body: MERITMAP },
    "GET /api/sponsor-crm/pipeline": ({ query }) => {
      assert.equal(query.organizationId, "o1");
      assert.equal(query.view, "all");
      return { status: 200, body: { items: [WAITING_DEAL], total: 1, nextCursor: null } };
    },
    "GET /api/sponsor-crm/notes/deal/d1": {
      status: 200,
      body: { items: [{ id: "n1", body: "Invoice sent Aug 24", authorId: "alexey", createdAt: "2026-08-24T10:00:00Z" }], total: 1, nextCursor: null },
    },
  };
}

describe("CLI crm lookup", () => {
  beforeEach(() => {
    isolateConfig();
    process.env.DATAOPS_TODAY = "2026-10-20";
  });

  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("exact email matches person, org, colleagues, deal and waiting decision", async () => {
    const io = captureIo();
    const { calls, restore } = fake(meritmapRoutes());
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io), EXIT.ok);
      assert.equal(calls[0].route, "/api/sponsor-crm/directory/people");
      assert.equal(calls[0].query.search, "angela@meritmap.ai");
      assert.equal(calls[0].query.active, "all");
      const body = io.json();
      assert.equal(body.matchedVia, "email");
      assert.equal(body.organization.name, "MeritMap");
      assert.equal(body.people.length, 2);
      assert.equal(body.people[0].id, "p1");
      assert.equal(body.people[0].matched, true);
      assert.equal(body.people[1].id, "p2");
      assert.equal(body.people[1].matched, false);
      assert.equal(body.deals.length, 1);
      assert.deepEqual(body.deals[0].nextTask, { description: "return later", date: "2026-11-01", status: "waiting", deferred: false, assigneeId: "alexey" });
      assert.equal(body.deals[0].stage, "invoiced");
      assert.equal(body.deals[0].money, "invoiced");
      assert.equal(body.deals[0].fulfillment, "in-delivery");
      assert.equal(body.deals[0].amountEur, 3000);
      assert.equal(body.deals[0].notes.length, 1);
      assert.equal(body.deals[0].notes[0].body, "Invoice sent Aug 24");
      assert.equal(body.decision.action, "waiting");
      assert.equal(body.decision.until, "2026-11-01");
    } finally {
      restore();
    }
  });

  test("the delegated contact matches the same deal through the organization", async () => {
    const io = captureIo();
    const { restore } = fake(meritmapRoutes());
    try {
      assert.equal(await run(["crm", "lookup", "--email", "tushar@jineegreencard.com", "--json"], io), EXIT.ok);
      const body = io.json();
      assert.equal(body.matchedVia, "email");
      assert.equal(body.organization.name, "MeritMap");
      assert.equal(body.people.find((person) => person.id === "p2").matched, true);
      assert.equal(body.people.find((person) => person.id === "p1").matched, false);
      assert.equal(body.decision.action, "waiting");
      assert.equal(body.decision.until, "2026-11-01");
    } finally {
      restore();
    }
  });

  test("generic freemail domains are never matched to a company", async () => {
    const io = captureIo();
    const { calls, restore } = fake(meritmapRoutes());
    try {
      assert.equal(await run(["crm", "lookup", "--email", "student@gmail.com", "--json"], io), EXIT.ok);
      assert.equal(io.json().decision.action, "no_match");
      assert.ok(!calls.some((call) => call.route === "/api/sponsor-crm/directory/companies" && call.method === "GET"));
    } finally {
      restore();
    }
  });

  test("sender domain matches the company directory and pulls colleagues", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/directory/people": ({ query }) => {
        if (query.company === "o1") return { status: 200, body: { items: [ANGELA], total: 1, nextCursor: null } };
        return { status: 200, body: { items: [], total: 0, nextCursor: null } };
      },
      "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [], total: 0, nextCursor: null } },
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "someone@meritmap.ai", "--json"], io), EXIT.ok);
      const search = calls.find((call) => call.route === "/api/sponsor-crm/directory/companies");
      assert.equal(search.query.search, "meritmap.ai");
      const body = io.json();
      assert.equal(body.matchedVia, "domain");
      assert.equal(body.organization.name, "MeritMap");
      assert.equal(body.people.length, 1);
      assert.equal(body.decision.action, "proceed");
      assert.match(body.decision.reason, /no CRM deals/);
    } finally {
      restore();
    }
  });

  test("decision skips closed deals and proceeds on due or review states", async () => {
    const io = captureIo();
    const closed = { ...WAITING_DEAL, stage: "closed", money: "paid", fulfillment: "delivered", nextTask: null };
    const { restore } = fake({ ...meritmapRoutes(), "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [closed], total: 1, nextCursor: null } } });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io), EXIT.ok);
      assert.equal(io.json().decision.action, "skip");
    } finally {
      restore();
    }

    const io2 = captureIo();
    const due = { ...WAITING_DEAL, nextTask: { id: "t1", description: "nudge", date: "2026-01-01", deferred: false, assigneeId: "alexey", status: "todo" } };
    const { restore: restore2 } = fake({ ...meritmapRoutes(), "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [due], total: 1, nextCursor: null } } });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io2), EXIT.ok);
      const decision = io2.json().decision;
      assert.equal(decision.action, "proceed");
      assert.match(decision.reason, /next action due 2026-01-01/);
    } finally {
      restore2();
    }

    const io3 = captureIo();
    const review = { ...WAITING_DEAL, replyReview: true, nextTask: null };
    const { restore: restore3 } = fake({ ...meritmapRoutes(), "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [review], total: 1, nextCursor: null } } });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io3), EXIT.ok);
      assert.match(io3.json().decision.reason, /inbound reply/);
    } finally {
      restore3();
    }
  });

  test("a waiting marker outranks a closed stage, including on its revisit day", async () => {
    const io = captureIo();
    // Live MeritMap shape: delivered but not invoiced, so the stage math says
    // closed while the billing task still waits with today as its date.
    const live = { ...WAITING_DEAL, stage: "closed", money: "none", nextTask: { ...WAITING_DEAL.nextTask, date: "2026-10-20" } };
    const { restore } = fake({ ...meritmapRoutes(), "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [live], total: 1, nextCursor: null } } });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io), EXIT.ok);
      const decision = io.json().decision;
      assert.equal(decision.action, "waiting");
      assert.equal(decision.until, "2026-10-20");
      assert.match(decision.reason, /revisit 2026-10-20/);
    } finally {
      restore();
    }

    const io2 = captureIo();
    const overdue = { ...live, nextTask: { ...live.nextTask, date: "2026-10-01" } };
    const { restore: restore2 } = fake({ ...meritmapRoutes(), "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [overdue], total: 1, nextCursor: null } } });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io2), EXIT.ok);
      const decision = io2.json().decision;
      assert.equal(decision.action, "proceed");
      assert.match(decision.reason, /waiting overdue since 2026-10-01/);
    } finally {
      restore2();
    }
  });

  test("an archived deal with no note listing still resolves", async () => {
    const io = captureIo();
    const { restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/notes/deal/d1": { status: 422, body: { error: "deal is archived" } },
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--json"], io), EXIT.ok);
      assert.deepEqual(io.json().deals[0].notes, []);
    } finally {
      restore();
    }
  });

  test("set-wait marks the deal's open tasks waiting and prints the fresh state", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/deals/d1": { status: 200, body: { id: "d1", openTasks: [{ id: "t1", description: "send invoice", status: "todo" }, { id: "t2", description: "chase billing", status: "todo" }] } },
      "POST /api/tasks/t1/actions/mark-waiting": ({ body }) => ({ status: 200, body: { id: "t1", ...body } }),
      "POST /api/tasks/t2/actions/mark-waiting": ({ body }) => ({ status: 200, body: { id: "t2", ...body } }),
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--set-wait", "--until", "2026-12-01", "--reason", "billing delegated to Tushar", "--json"], io), EXIT.ok);
      const marks = calls.filter((call) => call.route.endsWith("/actions/mark-waiting"));
      assert.deepEqual(marks.map((call) => call.route), ["/api/tasks/t1/actions/mark-waiting", "/api/tasks/t2/actions/mark-waiting"]);
      for (const mark of marks) {
        assert.equal(mark.body.waitingFor, "billing delegated to Tushar");
        assert.equal(mark.body.followUpAt, "2026-12-01");
        assert.equal(mark.body.channel, "other");
      }
      const body = io.json();
      assert.deepEqual(body.setWait, { dealId: "d1", dealTitle: "Newsletter Aug 24", markedTaskIds: ["t1", "t2"], createdTaskId: null });
      assert.equal(body.decision.action, "waiting");
    } finally {
      restore();
    }
  });

  test("set-wait creates a waiting task when the deal has no open tasks", async () => {
    const io = captureIo();
    const { calls, restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/deals/d1": { status: 200, body: { id: "d1", openTasks: [] } },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: { id: "t-new", ...body } }),
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--set-wait", "--until", "+14d", "--reason", "budget cycle", "--json"], io), EXIT.ok);
      const created = calls.find((call) => call.route === "/api/tasks" && call.method === "POST");
      assert.equal(created.body.description, "Waiting: budget cycle");
      assert.equal(created.body.status, "waiting");
      assert.equal(created.body.waitingFor, "budget cycle");
      assert.equal(created.body.followUpAt, "2026-11-03");
      assert.equal(created.body.comment, "budget cycle");
      assert.deepEqual(created.body.subject, { type: "sponsor-deal", id: "d1" });
      assert.equal(io.json().setWait.createdTaskId, "t-new");
    } finally {
      restore();
    }
  });

  test("set-wait refuses to guess between several active deals", async () => {
    const io = captureIo();
    const second = { ...WAITING_DEAL, id: "d2", title: "Course sponsor", stage: "open", money: "none" };
    const { calls, restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [WAITING_DEAL, second], total: 2, nextCursor: null } },
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--set-wait", "--until", "2026-12-01", "--reason", "later", "--json"], io), EXIT.usage);
      assert.ok(!calls.some((call) => call.method === "POST"));
      assert.match(io.errors.join("\n"), /--deal-id/);
    } finally {
      restore();
    }
  });

  test("set-wait honors --deal-id and rejects foreign ones", async () => {
    const io = captureIo();
    const second = { ...WAITING_DEAL, id: "d2", title: "Course sponsor", stage: "open", money: "none" };
    const { calls, restore } = fake({
      ...meritmapRoutes(),
      "GET /api/sponsor-crm/pipeline": { status: 200, body: { items: [WAITING_DEAL, second], total: 2, nextCursor: null } },
      "GET /api/sponsor-crm/deals/d2": { status: 200, body: { id: "d2", openTasks: [] } },
      "POST /api/tasks": ({ body }) => ({ status: 201, body: { id: "t-new", ...body } }),
    });
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--set-wait", "--until", "2026-12-01", "--reason", "later", "--deal-id", "d2", "--json"], io), EXIT.ok);
      assert.equal(calls.find((call) => call.method === "POST").body.subject.id, "d2");
    } finally {
      restore();
    }

    const io2 = captureIo();
    const { restore: restore2 } = fake(meritmapRoutes());
    try {
      assert.equal(await run(["crm", "lookup", "--email", "angela@meritmap.ai", "--set-wait", "--until", "2026-12-01", "--reason", "later", "--deal-id", "nope", "--json"], io2), EXIT.usage);
    } finally {
      restore2();
    }
  });

  test("lookup usage errors", async () => {
    const io = captureIo();
    const { restore } = fake({});
    try {
      assert.equal(await run(["crm", "lookup", "--json"], io), EXIT.usage);
      assert.equal(await run(["crm", "lookup", "--email", "not-an-address", "--json"], io), EXIT.usage);
    } finally {
      restore();
    }
  });
});
