import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run, FAMILIES } = await import("../src/cli.mjs");
const { orderQueue, queueSegment, multipart } = await import("../src/commands/tasks.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
});

const task = (fields) => ({ status: "todo", version: 3, description: "Synthetic task", ...fields });

describe("contract", () => {
  test("every command family has a summary and help with its usage", async () => {
    for (const [name, family] of Object.entries(FAMILIES)) {
      assert.ok(family.summary, `${name} summary`);
      assert.match(family.help, new RegExp(name === "agent-guide" ? "agent-guide" : "dataops"), `${name} help`);
      const io = captureIo();
      assert.equal(await run([name, "--help"], io), 0, `${name} --help`);
    }
  });

  test("a missing token is an auth error with exit code 3", async () => {
    delete process.env.DATAOPS_TOKEN;
    const io = captureIo();
    assert.equal(await run(["tasks", "list"], io), 3);
    assert.match(io.errors.join("\n"), /Not signed in/);
  });

  test("API failures map to exit codes and --json errors are machine-readable", async () => {
    fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1" }),
      "PUT /api/tasks/t-1": { status: 409, body: { error: "Task changed", code: "task_version_conflict" } },
    });
    let io = captureIo();
    assert.equal(await run(["tasks", "reopen", "t-1", "--json"], io), 5);
    assert.deepEqual(JSON.parse(io.errors[0]), {
      error: { message: "Task changed", exitCode: 5, status: 409, code: "task_version_conflict" },
    });
    io = captureIo();
    assert.equal(await run(["tasks", "show"], io), 2);
    assert.match(io.errors.join("\n"), /Usage: dataops tasks show/);
  });
});

describe("tasks", () => {
  test("queue segments follow the web order: overdue, follow-up due, today, waiting", () => {
    const day = "2026-10-14";
    const ordered = orderQueue(
      [
        task({ id: "w", status: "waiting", date: "2026-10-20", followUpAt: "2026-10-30" }),
        task({ id: "t", date: day }),
        task({ id: "f", status: "waiting", date: "2026-10-20", followUpAt: "2026-10-14" }),
        task({ id: "o", date: "2026-10-01" }),
        task({ id: "o", date: "2026-10-01" }),
        task({ id: "d", status: "done", date: "2026-10-01" }),
      ],
      day,
    );
    assert.deepEqual(ordered.map((item) => [item.id, item.queueSegment]), [
      ["o", "overdue"],
      ["f", "follow-up"],
      ["t", "today"],
      ["w", "waiting"],
    ]);
    assert.equal(queueSegment(task({ status: "done" }), day), "");
  });

  test("list without a view loads the three queue lanes for the owner", async () => {
    const calls = fakePortal({
      "GET /api/tasks": ({ query }) => ({
        tasks: query.date ? [task({ id: "today", date: query.date })] : query.status ? [] : [task({ id: "late", date: "2026-10-01" })],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--mine", "--as-of", "2026-10-14", "--json"], io), 0);
    const result = io.json();
    assert.equal(result.view, "queue");
    assert.deepEqual(result.tasks.map((item) => item.id), ["late", "today"]);
    assert.deepEqual(
      calls.map((call) => call.query).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        { date: "2026-10-14", owner: "me" },
        { endDate: "2026-10-13", owner: "me", startDate: "1970-01-01" },
        { owner: "me", status: "waiting" },
      ],
    );
  });

  test("an explicit filter is one API query", async () => {
    const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
    assert.equal(await run(["tasks", "list", "--card", "c-1", "--status", "done"], captureIo()), 0);
    assert.deepEqual(calls.map((call) => call.query), [{ cardId: "c-1", status: "done" }]);
  });

  test("done saves the proof and the status in one versioned write", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1", version: 7 }),
      "PUT /api/tasks/t-1": ({ body }) => task({ id: "t-1", ...body, version: 8 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "done", "t-1", "--proof-url", "https://example.test/x", "--comment", "Shipped"], io), 0);
    assert.deepEqual(calls.at(-1).body, { link: "https://example.test/x", comment: "Shipped", status: "done", expectedVersion: 7 });
    assert.match(io.text(), /Completed t-1/);
  });

  test("done on a waiting task saves proof, then resolves through the follow-up action", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-2": task({ id: "t-2", status: "waiting", version: 4 }),
      "PUT /api/tasks/t-2": ({ body }) => task({ id: "t-2", status: "waiting", ...body, version: 5 }),
      "POST /api/tasks/t-2/actions/resolve-done": ({ body }) => task({ id: "t-2", status: "done", version: body.expectedVersion + 1 }),
    });
    assert.equal(await run(["tasks", "done", "t-2", "--link", "https://example.test/y"], captureIo()), 0);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), [
      "GET /api/tasks/t-2",
      "PUT /api/tasks/t-2",
      "POST /api/tasks/t-2/actions/resolve-done",
    ]);
    assert.equal(calls[2].body.expectedVersion, 5);
  });

  test("done --file uploads the file to the task as multipart first", async () => {
    const calls = fakePortal({
      "POST /api/files": { status: 201, body: { file: { id: "f-1" } } },
      "GET /api/tasks/t-3": task({ id: "t-3", version: 1 }),
      "PUT /api/tasks/t-3": ({ body }) => task({ id: "t-3", ...body }),
    });
    const file = new URL("../package.json", import.meta.url).pathname;
    assert.equal(await run(["tasks", "done", "t-3", "--file", file], captureIo()), 0);
    assert.equal(calls[0].route, "/api/files");
    assert.match(String(calls[0].body), /name="taskId"\r\n\r\nt-3/);
    assert.match(String(calls[0].body), /filename="package.json"/);
  });

  test("wait sends the follow-up fields the API requires", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-4": task({ id: "t-4", version: 2 }),
      "POST /api/tasks/t-4/actions/mark-waiting": ({ body }) => task({ id: "t-4", status: "waiting", ...body }),
    });
    assert.equal(
      await run(["tasks", "wait", "t-4", "--for", "Sponsor", "--follow-up", "2026-10-20", "--channel", "email", "--note", "Asked"], captureIo()),
      0,
    );
    assert.deepEqual(calls.at(-1).body, { waitingFor: "Sponsor", followUpAt: "2026-10-20", channel: "email", note: "Asked", expectedVersion: 2 });
    const io = captureIo();
    assert.equal(await run(["tasks", "wait", "t-4", "--for", "Sponsor"], io), 2);
  });

  test("assign me resolves the signed-in user", async () => {
    const calls = fakePortal({
      "GET /api/me": { user: { id: "u-me" } },
      "GET /api/tasks/t-5": task({ id: "t-5" }),
      "PUT /api/tasks/t-5": ({ body }) => task({ id: "t-5", ...body }),
    });
    assert.equal(await run(["tasks", "assign", "t-5", "me"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { assigneeId: "u-me", expectedVersion: 3 });
  });

  test("multipart bodies carry each field and the file bytes", () => {
    const { body, contentType } = multipart({ taskId: "t", category: undefined }, { name: "a.txt", bytes: Buffer.from("hello") });
    const boundary = contentType.split("boundary=")[1];
    const text = body.toString();
    assert.match(text, /name="taskId"\r\n\r\nt\r\n/);
    assert.doesNotMatch(text, /category/);
    assert.ok(text.endsWith(`hello\r\n--${boundary}--\r\n`));
  });
});

describe("cards and templates", () => {
  const template = { id: "tpl-1", type: "newsletter-issue", name: "Newsletter issue", taskDefinitions: [{ description: "Draft", offsetDays: -3 }] };

  test("create resolves a template by type and anchors the card on --date", async () => {
    const calls = fakePortal({
      "GET /api/templates/newsletter-issue": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [template] },
      "POST /api/cards": ({ body }) => ({ status: 201, body: { card: { id: "c-1", ...body }, tasks: [{ id: "t", date: "2026-10-30", description: "Draft" }] } }),
    });
    const io = captureIo();
    assert.equal(await run(["cards", "create", "--title", "Issue", "--date", "2026-11-02", "--template", "newsletter-issue", "--optional-groups", "a,b"], io), 0);
    assert.deepEqual(calls.at(-1).body, { title: "Issue", anchorDate: "2026-11-02", templateId: "tpl-1", optionalGroups: ["a", "b"] });
    assert.match(io.text(), /Created Card c-1/);
  });

  test("an unknown template is a usage error before anything is created", async () => {
    const calls = fakePortal({
      "GET /api/templates/nope": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [template] },
    });
    assert.equal(await run(["cards", "create", "--title", "X", "--date", "2026-11-02", "--template", "nope"], captureIo()), 2);
    assert.ok(!calls.some((call) => call.method === "POST"));
  });

  test("link fills one named card link and keeps the others", async () => {
    const card = { id: "c-2", title: "Card", stage: "preparation", version: 4, cardLinks: [{ name: "Published", url: "" }, { name: "Other", url: "https://example.test/o" }] };
    const calls = fakePortal({
      "GET /api/cards/c-2": { card },
      "PUT /api/cards/c-2": ({ body }) => ({ card: { ...card, ...body } }),
    });
    assert.equal(await run(["cards", "link", "c-2", "Published", "https://example.test/p"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, {
      cardLinks: [{ name: "Published", url: "https://example.test/p" }, { name: "Other", url: "https://example.test/o" }],
      expectedVersion: 4,
    });
    const io = captureIo();
    assert.equal(await run(["cards", "link", "c-2", "Missing", "https://example.test/m"], io), 2);
    assert.match(io.errors.join("\n"), /Known links: Published, Other/);
  });

  test("stage validates the stage and sends the card version", async () => {
    const card = { id: "c-3", title: "Card", stage: "preparation", version: 2 };
    const calls = fakePortal({
      "GET /api/cards/c-3": { card },
      "PUT /api/cards/c-3": ({ body }) => ({ card: { ...card, ...body } }),
    });
    assert.equal(await run(["cards", "stage", "c-3", "shipped"], captureIo()), 2);
    assert.equal(await run(["cards", "stage", "c-3", "announced"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { stage: "announced", expectedVersion: 2 });
  });

  test("list follows cursors and hides archived cards unless asked", async () => {
    fakePortal({
      "GET /api/cards": ({ query }) => ({
        cards: query.cursor
          ? { items: [{ id: "b", status: "archived" }] }
          : { items: [{ id: "a", status: "active" }], nextCursor: "next" },
      }),
    });
    let io = captureIo();
    await run(["cards", "list", "--json"], io);
    assert.deepEqual(io.json().cards.map((card) => card.id), ["a"]);
    io = captureIo();
    await run(["cards", "list", "--all", "--json"], io);
    assert.deepEqual(io.json().cards.map((card) => card.id), ["a", "b"]);
  });
});

describe("api passthrough", () => {
  test("sends the method, route, repeated --query values, and --data", async () => {
    const calls = fakePortal({ "POST /api/document-reviews": ({ body, query }) => ({ body, query }) });
    const io = captureIo();
    assert.equal(await run(["api", "post", "/api/document-reviews", "--data", '{"a":1}', "--query", "x=1", "--query", "y=2", "--json"], io), 0);
    assert.deepEqual(calls[0].query, { x: "1", y: "2" });
    assert.deepEqual(io.json(), { body: { a: 1 }, query: { x: "1", y: "2" } });
    assert.equal(await run(["api", "GET", "/api/x", "--data", "{}"], captureIo()), 2);
  });
});
