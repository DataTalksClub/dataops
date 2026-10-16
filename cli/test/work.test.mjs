import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run, FAMILIES, guideBody } = await import("../src/cli.mjs");
const { orderQueue, queueSegment, multipart, requiresQuery } = await import("../src/commands/tasks.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
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
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
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

  test("skip requires a reason and unskip returns the Task to todo", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-6": task({ id: "t-6", version: 4 }),
      "POST /api/tasks/t-6/actions/skip": ({ body }) => task({ id: "t-6", status: "skipped", skipReason: body.reason, version: 5 }),
      "POST /api/tasks/t-6/actions/unskip": () => task({ id: "t-6", status: "todo", version: 6 }),
    });
    assert.equal(await run(["tasks", "skip", "t-6"], captureIo()), 2);
    assert.equal(await run(["tasks", "skip", "t-6", "--reason", "Self-hosted, no recording"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { reason: "Self-hosted, no recording", expectedVersion: 4 });
    assert.equal(await run(["tasks", "unskip", "t-6"], captureIo()), 0);
    assert.equal(calls.at(-1).route, "/api/tasks/t-6/actions/unskip");
    assert.deepEqual(calls.at(-1).body, { expectedVersion: 4 });
  });

  test("--depends-on sets prerequisites and none clears them", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-7": task({ id: "t-7", version: 2 }),
      "PUT /api/tasks/t-7": ({ body }) => task({ id: "t-7", ...body }),
      "POST /api/tasks": ({ body }) => task({ id: "t-8", date: body.date, ...body }),
    });
    assert.equal(await run(["tasks", "update", "t-7", "--depends-on", "a, b"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { dependsOn: ["a", "b"], expectedVersion: 2 });
    assert.equal(await run(["tasks", "update", "t-7", "--depends-on", "none"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { dependsOn: [], expectedVersion: 2 });
    assert.equal(await run(["tasks", "create", "--description", "D", "--card", "c-1", "--depends-on", "a"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body.dependsOn, ["a"]);
    assert.equal(await run(["tasks", "update", "t-7", "--depends-on"], captureIo()), 2);
  });

  test("show names each prerequisite and its status, and list marks blocked Tasks", async () => {
    fakePortal({
      "GET /api/tasks/t-9": task({
        id: "t-9",
        blocked: true,
        prerequisites: [
          { id: "p-1", description: "Verify Spotify episode", status: "todo" },
          { id: "p-2", description: "Review transcript", status: "skipped" },
        ],
      }),
      "GET /api/tasks": { tasks: [task({ id: "t-9", blocked: true, date: "2026-10-14" })] },
    });
    let io = captureIo();
    assert.equal(await run(["tasks", "show", "t-9"], io), 0);
    const shown = io.text();
    assert.match(shown, /Verify Spotify episode \[todo\] \(p-1\); Review transcript \[skipped\] \(p-2\)/);
    assert.match(shown, /blocked:\s+yes/);
    io = captureIo();
    assert.equal(await run(["tasks", "list", "--status", "todo"], io), 0);
    assert.match(io.text(), /BLOCKED[\s\S]*yes/);
  });

  test("a blocked completion surfaces the API's reason with the conflict exit code", async () => {
    fakePortal({
      "GET /api/tasks/t-10": task({ id: "t-10" }),
      "PUT /api/tasks/t-10": {
        status: 409,
        body: { error: 'Cannot mark task as done: complete "Review transcript" first', code: "prerequisites-incomplete" },
      },
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "done", "t-10"], io), 5);
    assert.match(io.errors.join("\n"), /complete "Review transcript" first/);
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

describe("required resources", () => {
  test("requires filters go to every queue lane and --can-do defaults to DATAOPS_CAPABILITIES", async () => {
    process.env.DATAOPS_CAPABILITIES = "youtube, luma";
    const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--mine", "--requires", "youtube", "--as-of", "2026-10-14", "--json"], io), 0);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.query.requires, "youtube");
      assert.equal(call.query.canDo, "youtube,luma");
    }
    assert.deepEqual(io.json().canDo, ["youtube", "luma"]);
  });

  test("--can-do overrides the environment and all turns the filter off", () => {
    const env = { DATAOPS_CAPABILITIES: "youtube" };
    assert.deepEqual(requiresQuery({ canDo: "mailchimp,gmail" }, env), { canDo: "mailchimp,gmail" });
    assert.deepEqual(requiresQuery({ canDo: "all" }, env), {});
    assert.deepEqual(requiresQuery({}, env), { canDo: "youtube" });
    assert.deepEqual(requiresQuery({}, { DATAOPS_CAPABILITIES: "" }), {});
    assert.deepEqual(requiresQuery({ excludeRequires: "luma" }, {}), { excludeRequires: "luma" });
    assert.throws(() => requiresQuery({ canDo: true }, {}), /--can-do needs/);
  });

  test("an explicit filter carries the resource filters in its one query", async () => {
    const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
    assert.equal(await run(["tasks", "list", "--status", "todo", "--exclude-requires", "finom,revolut"], captureIo()), 0);
    assert.deepEqual(calls.map((call) => call.query), [{ status: "todo", excludeRequires: "finom,revolut" }]);
  });

  test("list and show print requires", async () => {
    fakePortal({
      "GET /api/tasks": { tasks: [task({ id: "t-r", date: "2026-10-14", requires: ["youtube", "luma"] })] },
      "GET /api/tasks/t-r": task({ id: "t-r", requires: ["youtube", "luma"] }),
    });
    let io = captureIo();
    assert.equal(await run(["tasks", "list", "--date", "2026-10-14"], io), 0);
    assert.match(io.text(), /REQUIRES/);
    assert.match(io.text(), /youtube,luma/);
    io = captureIo();
    assert.equal(await run(["tasks", "show", "t-r"], io), 0);
    assert.match(io.text(), /requires:\s+youtube, luma/);
  });

  test("create and update send requires; none clears it", async () => {
    const calls = fakePortal({
      "POST /api/tasks": ({ body }) => ({ status: 201, body: task({ id: "t-n", ...body }) }),
      "GET /api/tasks/t-n": task({ id: "t-n", version: 2 }),
      "PUT /api/tasks/t-n": ({ body }) => task({ id: "t-n", ...body }),
    });
    assert.equal(await run(["tasks", "create", "--description", "Cut video", "--date", "2026-10-20", "--requires", "youtube,dropbox"], captureIo()), 0);
    assert.deepEqual(calls[0].body.requires, ["youtube", "dropbox"]);
    assert.equal(await run(["tasks", "update", "t-n", "--requires", "none"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { requires: [], expectedVersion: 2 });
  });

  test("resources list prints the vocabulary", async () => {
    fakePortal({
      "GET /api/resources": { resources: [{ id: "youtube", name: "YouTube", icon: "video", access: "Channel access" }] },
    });
    const io = captureIo();
    assert.equal(await run(["resources", "list"], io), 0);
    assert.match(io.text(), /youtube\s+YouTube\s+Channel access/);
  });
});

describe("cards and templates", () => {
  test("delete names the Card and Task count, and needs --yes", async () => {
    const calls = fakePortal({
      "GET /api/cards/c-9": { card: { id: "c-9", title: "Synthetic duplicate", version: 7, taskCount: 15 } },
      "DELETE /api/cards/c-9": () => ({ deleted: { cardId: "c-9", title: "Synthetic duplicate", deletedTaskIds: ["a", "b"] } }),
    });
    const io = captureIo();
    assert.equal(await run(["cards", "delete", "c-9"], io), 2);
    assert.match(io.errors.join("\n"), /Synthetic duplicate" and its 15 Tasks/);
    assert.equal(calls.some(({ method }) => method === "DELETE"), false);
    const done = captureIo();
    assert.equal(await run(["cards", "delete", "c-9", "--yes"], done), 0);
    assert.deepEqual(calls.at(-1).body, { expectedVersion: 7 });
    assert.match(done.text(), /Deleted c-9 - Synthetic duplicate and 2 Tasks/);
  });

  test("Card options preview without writes, then apply the same selection", async () => {
    const calls = fakePortal({
      "POST /api/cards/c-options/template-update": ({ body }) => body.previewOnly
        ? { preview: { previewToken: "a".repeat(64), targetOptionalGroups: body.optionalGroups } }
        : { applied: true, card: { id: "c-options" } },
    });
    assert.equal(await run(["cards", "template-update", "c-options", "--optional-groups", "sponsored"], captureIo()), 0);
    assert.deepEqual(calls.map(({ body }) => body), [{ previewOnly: true, optionalGroups: ["sponsored"] }]);
    assert.equal(await run(["cards", "template-update", "c-options", "--optional-groups", "none", "--apply"], captureIo()), 0);
    assert.deepEqual(calls.at(-2).body, { previewOnly: true, optionalGroups: [] });
    assert.deepEqual(calls.at(-1).body, { previewToken: "a".repeat(64), optionalGroups: [] });
  });

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

  test("create leaves the title to the Template's card_title when --title is omitted", async () => {
    const calls = fakePortal({
      "GET /api/templates/newsletter-issue": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [template] },
      "POST /api/cards": ({ body }) => ({ status: 201, body: { card: { id: "c-2", title: "2 Nov", ...body }, tasks: [] } }),
    });
    assert.equal(await run(["cards", "create", "--date", "2026-11-02", "--template", "newsletter-issue"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { anchorDate: "2026-11-02", templateId: "tpl-1" });
  });

  test("an unknown template is a usage error before anything is created", async () => {
    const calls = fakePortal({
      "GET /api/templates/nope": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [template] },
    });
    assert.equal(await run(["cards", "create", "--title", "X", "--date", "2026-11-02", "--template", "nope"], captureIo()), 2);
    assert.ok(!calls.some((call) => call.method === "POST"));
  });

  test("a Card without --template is a usage error before anything is sent", async () => {
    const calls = fakePortal({});
    assert.equal(await run(["cards", "create", "--title", "X", "--date", "2026-11-02"], captureIo()), 2);
    assert.equal(calls.length, 0);
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
    const calls = fakePortal({ "POST /api/operating-model": ({ body, query }) => ({ body, query }) });
    const io = captureIo();
    assert.equal(await run(["api", "post", "/api/operating-model", "--data", '{"a":1}', "--query", "x=1", "--query", "y=2", "--json"], io), 0);
    assert.deepEqual(calls[0].query, { x: "1", y: "2" });
    assert.deepEqual(io.json(), { body: { a: 1 }, query: { x: "1", y: "2" } });
    assert.equal(await run(["api", "GET", "/api/x", "--data", "{}"], captureIo()), 2);
  });
});

describe("newsletter", () => {
  test("create makes a weekly issue with its primary slot ticked; naming a sponsor ticks its slot", async () => {
    const calls = fakePortal({
      "POST /api/newsletter-issues": ({ body }) => ({ status: 201, body: { id: "i-1", label: "Weekly #302", cardId: "c-1", ...body } }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "create", "--date", "2026-11-09", "--number", "302", "--secondary-sponsor", "Example"], io), 0);
    assert.deepEqual(calls.at(-1).body, {
      publicationDate: "2026-11-09",
      issueNumber: 302,
      kind: "weekly",
      status: "planned",
      slots: { primary: { ticked: true }, secondary: { ticked: true, sponsor: "Example" } },
    });
    assert.match(io.text(), /Created Weekly #302 on 2026-11-09 \[planned\], Card c-1/);
  });

  test("update merges slot flags over the current slots at the current version", async () => {
    const current = {
      id: "i-3", version: 4, label: "Weekly #306",
      slots: { primary: { ticked: true, sponsor: "A", sheetId: "NL-306" }, secondary: { ticked: true, sponsor: "B", documentUrl: "https://d/b" } },
    };
    const calls = fakePortal({
      "GET /api/newsletter-issues/i-3": current,
      "PUT /api/newsletter-issues/i-3": ({ body }) => ({ ...current, ...body, version: 5 }),
    });
    assert.equal(await run(["newsletter", "update", "i-3", "--secondary", "off", "--primary-sponsor", "C", "--confirm"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, {
      slots: {
        primary: { ticked: true, sponsor: "C", sheetId: "NL-306" },
        secondary: { ticked: false, documentUrl: "https://d/b" },
      },
      confirmCardDeletion: true,
      confirmSlotRemoval: true,
      version: 4,
    });
    assert.equal(await run(["newsletter", "update", "i-3", "--secondary", "maybe"], captureIo()), 2);
    assert.equal(await run(["newsletter", "update", "i-3"], captureIo()), 2);
  });

  test("list --card is the reverse lookup; there is no card linking command", async () => {
    const calls = fakePortal({ "GET /api/newsletter-issues": { items: [] } });
    assert.equal(await run(["newsletter", "list", "--card", "c-1"], captureIo()), 0);
    assert.deepEqual(calls[0].query, { cardId: "c-1" });
    assert.equal(await run(["newsletter", "link-card", "i-1", "c-1"], captureIo()), 2);
    assert.equal(await run(["newsletter", "create-card", "i-1"], captureIo()), 2);
  });
});

describe("agent guide", () => {
  test("strips LF and CRLF metadata without rewriting the guide body", () => {
    for (const newline of ["\n", "\r\n"]) {
      for (const bom of ["", "\uFEFF"]) {
        const body = `# Synthetic guide${newline}${newline}Keep this body.${newline}`;
        assert.equal(guideBody(`${bom}---${newline}name: synthetic${newline}---${newline}${newline}${body}`), body);
      }
    }
    assert.equal(guideBody("# No metadata\r\nBody\r\n"), "# No metadata\r\nBody\r\n");
  });

  test("prints the skill body without its frontmatter", async () => {
    const io = captureIo();
    assert.equal(await run(["agent-guide"], io), 0);
    assert.match(io.text(), /^# DataOps CLI for agents/);
    assert.match(io.text(), /dataops kb related/);
    assert.match(io.text(), /DATAOPS_CAPABILITIES/);
    assert.match(io.text(), /leave it for another agent/);
  });
});

describe("team default assignee", () => {
  test("shows and changes the workspace default assignee with the read version", async () => {
    let settings = { defaultAssigneeId: null, version: 0 };
    const calls = fakePortal({
      "GET /api/team-members/default-assignee": () => settings,
      "GET /api/team-members": { teamMembers: [{ id: "u-orin", name: "Orin" }], defaultAssigneeId: null },
      "PUT /api/team-members/default-assignee": ({ body }) => {
        settings = { defaultAssigneeId: body.defaultAssigneeId, version: body.expectedVersion + 1 };
        return settings;
      },
    });
    let io = captureIo();
    assert.equal(await run(["team", "default-assignee"], io), 0);
    assert.match(io.text(), /No default assignee/);

    io = captureIo();
    assert.equal(await run(["team", "set-default-assignee", "u-orin"], io), 0);
    assert.deepEqual(calls.find((call) => call.method === "PUT").body, { defaultAssigneeId: "u-orin", expectedVersion: 0 });

    io = captureIo();
    assert.equal(await run(["team", "default-assignee"], io), 0);
    assert.match(io.text(), /Orin \(u-orin\)/);

    io = captureIo();
    assert.equal(await run(["team", "set-default-assignee", "none"], io), 0);
    assert.deepEqual(calls.filter((call) => call.method === "PUT").at(-1).body, { defaultAssigneeId: null, expectedVersion: 1 });
  });
});

describe("team: adding a person", () => {
  test("add-user creates the account sign-in requires", async () => {
    const calls = fakePortal({
      "POST /api/users": ({ body }) => ({ status: 201, body: { user: { id: "u-new", ...body } } }),
    });
    const io = captureIo();
    assert.equal(await run(["team", "add-user", "--email", "new@datatalks.club", "--name", "New Person"], io), 0);
    assert.deepEqual(calls.at(-1).body, { email: "new@datatalks.club", name: "New Person", role: "operator" });
    assert.match(io.text(), /Added New Person <new@datatalks.club> as operator \(u-new\)\. They can sign in now\./);

    assert.equal(await run(["team", "add-user", "--email", "a@datatalks.club", "--name", "Ann", "--role", "admin"], captureIo()), 0);
    assert.equal(calls.at(-1).body.role, "admin");
  });

  test("add-user needs an email, a name and a known role", async () => {
    fakePortal({});
    for (const [argv, message] of [
      [["team", "add-user", "--name", "X"], /--email is required/],
      [["team", "add-user", "--email", "x@datatalks.club"], /--name is required/],
      [["team", "add-user", "--email", "x@datatalks.club", "--name", "X", "--role", "owner"], /--role must be operator or admin/],
    ]) {
      const io = captureIo();
      assert.equal(await run(argv, io), 2);
      assert.match(io.errors.join("\n"), message);
    }
  });

  test("an email that already has an account is refused by the portal", async () => {
    fakePortal({
      "POST /api/users": { status: 409, body: { error: "A user with email a@datatalks.club already exists", code: "email_taken" } },
    });
    const io = captureIo();
    assert.equal(await run(["team", "add-user", "--email", "a@datatalks.club", "--name", "Ann", "--json"], io), 5);
    assert.equal(JSON.parse(io.errors[0]).error.code, "email_taken");
  });
});

describe("team: a person leaving", () => {
  const work = (tasks, cards = 0, schedules = 0, sponsorRecords = 0) => ({ tasks, cards, schedules, sponsorRecords });

  test("handover shows the open work, reassign hands it over", async () => {
    const calls = fakePortal({
      "GET /api/users/u-grace/handover": {
        user: { id: "u-grace", name: "Grace", disabled: true },
        openWork: work(3, 1),
        openTotal: 4,
        isDefaultAssignee: false,
      },
      "POST /api/users/u-grace/reassign": { reassignedTo: "u-orin", moved: work(3, 1), remaining: work(0) },
    });
    let io = captureIo();
    assert.equal(await run(["team", "handover", "u-grace"], io), 0);
    assert.match(io.text(), /Grace \(disabled\): 3 open tasks, 1 card\./);

    io = captureIo();
    assert.equal(await run(["team", "reassign", "u-grace", "--to", "u-orin"], io), 0);
    assert.deepEqual(calls.at(-1).body, { reassignTo: "u-orin" });
    assert.match(io.text(), /Moved 3 open tasks, 1 card to u-orin\./);

    io = captureIo();
    assert.equal(await run(["team", "reassign", "u-grace"], io), 2);
    assert.match(io.errors.join("\n"), /--to is required/);
  });

  test("disable-user and delete-user pass the recipient and the new default", async () => {
    const calls = fakePortal({
      "POST /api/users/u-lee/disable": {
        user: { id: "u-lee", name: "Lee", disabled: true },
        reassignedTo: "u-orin", moved: work(2), newDefaultAssigneeId: "u-orin", revokedCredentials: 2,
      },
      "DELETE /api/users/u-lee": { deleted: { id: "u-lee", name: "Lee" }, reassignedTo: null, moved: null, revokedCredentials: 0 },
    });
    let io = captureIo();
    assert.equal(await run(["team", "disable-user", "u-lee", "--reassign-to", "u-orin", "--new-default", "u-orin"], io), 0);
    assert.deepEqual(calls.at(-1).body, { reassignTo: "u-orin", newDefaultAssigneeId: "u-orin" });
    assert.match(io.text(), /Disabled Lee\.\nMoved 2 open tasks to u-orin\./);

    io = captureIo();
    assert.equal(await run(["team", "delete-user", "u-lee", "--reassign-to", "u-orin"], io), 0);
    assert.equal(calls.at(-1).method, "DELETE");
    assert.deepEqual(calls.at(-1).body, { reassignTo: "u-orin" });
    assert.match(io.text(), /Deleted Lee; history still shows the name\./);
  });

  test("delete-user of an active account is refused by the portal", async () => {
    fakePortal({
      "DELETE /api/users/u-active": { status: 409, body: { error: "Disable Ann first; only a disabled account can be deleted", code: "disable_first" } },
    });
    const io = captureIo();
    assert.equal(await run(["team", "delete-user", "u-active", "--json"], io), 5);
    assert.equal(JSON.parse(io.errors[0]).error.code, "disable_first");
  });
});

describe("newsletter card lead time", () => {
  test("shows the setting and writes a new value with the version it read", async () => {
    const calls = fakePortal({
      "GET /api/workspace-settings": { defaultAssigneeId: null, newsletterCardLeadDays: 21, version: 4 },
      "PUT /api/workspace-settings": ({ body }) => ({ status: 200, body: { newsletterCardLeadDays: body.newsletterCardLeadDays, version: 5 } }),
    });
    const shown = captureIo();
    assert.equal(await run(["newsletter", "card-lead-days"], shown), 0);
    assert.match(shown.text(), /21 days before/);
    const set = captureIo();
    assert.equal(await run(["newsletter", "card-lead-days", "14"], set), 0);
    assert.deepEqual(calls.at(-1).body, { newsletterCardLeadDays: 14, expectedVersion: 4 });
    assert.match(set.text(), /now created 14 days before/);
    assert.equal(await run(["newsletter", "card-lead-days", "soon"], captureIo()), 2);
  });
});
