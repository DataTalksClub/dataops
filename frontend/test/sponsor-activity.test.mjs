import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_TYPES,
  activityItemMarkup,
  activityListMarkup,
  activityPanelMarkup,
  createActivityLoader,
  formatBerlinDate,
  formatBerlinDateTime,
  relatedWorkMarkup,
  wireActivityPanel,
} from "../src/surfaces/finance/sponsor-activity.js";
import { createApiStub, escapeHtml, FakeNode, httpError } from "./support/fake-record-dom.mjs";

const context = { escapeHtml };

function activityPayload(items = [], extra = {}) {
  return {
    targetType: "organization",
    targetId: "c1",
    items,
    total: items.length,
    nextCursor: null,
    sources: { note: 1 },
    relatedWork: [],
    tasksScope: "open",
    reads: {},
    ...extra,
  };
}

test("Berlin timestamps format deterministically and degrade honestly", () => {
  assert.match(formatBerlinDateTime("2026-10-09T12:00:00.000Z"), /9 Oct 2026/);
  assert.equal(formatBerlinDateTime("not-a-date"), "Date unavailable");
  assert.match(formatBerlinDate("2026-10-09T12:00:00.000Z"), /9 Oct/);
});

test("loader fetches the first bounded page with limit and no cursor", async () => {
  const calls = [];
  const api = createApiStub({
    "GET /activity/organization/c1?limit=30": activityPayload([
      { ts: "2026-10-09T12:00:00.000Z", source: "note", id: "n1", actor: "ada", text: "Called", provenance: {} },
    ], {
      relatedWork: [{ taskId: "t1", status: "todo", date: "2026-10-20", description: "Follow up", href: "/sponsors/deals/d1", scope: "direct" }],
      total: 1,
    }),
  }, calls);
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  const state = await loader.load();
  assert.equal(state.status, "ready");
  assert.equal(state.items.length, 1);
  assert.equal(state.relatedWork[0].scope, "direct");
  assert.deepEqual(calls.map(({ path }) => path), ["/activity/organization/c1?limit=30"]);
});

test("type filter narrows the query and paging appends with the bound cursor", async () => {
  const calls = [];
  const api = createApiStub({
    "GET /activity/deal/d1?limit=30&types=note": activityPayload([{ ts: "2026-10-09T00:00:00Z", source: "note", id: "n1", actor: null, text: "One", provenance: {} }], { nextCursor: "cursor-1", total: 2 }),
    "GET /activity/deal/d1?limit=30&types=note&cursor=cursor-1": activityPayload([{ ts: "2026-10-08T00:00:00Z", source: "note", id: "n2", actor: null, text: "Two", provenance: {} }], { total: 2 }),
  }, calls);
  const loader = createActivityLoader({ api, targetType: "deal", targetId: "d1" });
  await loader.load({ types: ["note"] });
  assert.ok(calls[0].path.includes("types=note"));
  await loader.loadMore();
  assert.equal(loader.state.items.map((item) => item.id).join(","), "n1,n2");
  assert.equal(loader.state.nextCursor, null);
});

test("loadMore without a cursor fetches nothing", async () => {
  const calls = [];
  const api = createApiStub({ "GET *": activityPayload() }, calls);
  const loader = createActivityLoader({ api, targetType: "contact", targetId: "p1" });
  await loader.load();
  const before = calls.length;
  await loader.loadMore();
  assert.equal(calls.length, before);
});

test("a rejected bound cursor becomes an honest error, never a partial page", async () => {
  const api = createApiStub({
    "GET *": httpError(400, "Cursor does not match these filters"),
  });
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  const state = await loader.load();
  assert.equal(state.status, "error");
  assert.match(state.error, /Cursor does not match/);
  assert.deepEqual(state.items, []);
});

test("unknown target types fail loudly at construction", () => {
  assert.throws(() => createActivityLoader({ api: async () => ({}), targetType: "company", targetId: "c1" }), /unknown target/);
});

test("note append posts body plus idempotency key and validates length", async () => {
  const calls = [];
  const api = createApiStub({
    "POST /notes/contact/p1": { id: "n9", targetType: "contact", targetId: "p1", authorId: "op", body: "Met at conf", createdAt: "2026-10-17T00:00:00Z", version: 1 },
  }, calls);
  const loader = createActivityLoader({ api, targetType: "contact", targetId: "p1" });
  const saved = await loader.addNote({ body: "Met at conf", sourceKey: "key-1" });
  assert.equal(saved.id, "n9");
  assert.deepEqual(calls[0].body, { body: "Met at conf", sourceKey: "key-1" });
  await assert.rejects(loader.addNote({ body: "  " }), /required/);
  await assert.rejects(loader.addNote({ body: "x".repeat(2001) }), /1\.\.2000/);
});

test("a 409 note conflict is an error, never a replay success", async () => {
  const api = createApiStub({ "POST *": httpError(409, "sourceKey already used with a different body") });
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  await assert.rejects(loader.addNote({ body: "Different text", sourceKey: "key-1" }), /different body/);
});

test("timeline markup escapes content and labels provenance honestly", () => {
  const markup = activityItemMarkup({
    ts: "2026-10-09T12:00:00.000Z",
    source: "mail",
    id: "m1",
    actor: null,
    text: "<b>Hello</b>",
    detail: { snippet: "<b>Hello</b> and more" },
    provenance: { direction: "inbound", link: "direct", dealId: "d1" },
  }, context);
  assert.doesNotMatch(markup, /<b>Hello<\/b>/);
  assert.match(markup, /&lt;b&gt;Hello&lt;\/b&gt;/);
  assert.match(markup, /Mail/);
  assert.match(markup, /deal activity/);
  assert.match(markup, /directly linked/);
  assert.match(markup, /inbound/);
  assert.match(markup, /Full text/);
  const short = activityItemMarkup({ ts: "", source: "touch", id: "t", actor: "ada", text: "Ping", provenance: {} }, context);
  assert.match(short, /by ada/);
  assert.doesNotMatch(short, /Full text/);
});

test("empty timelines and related-company work render honestly", () => {
  assert.match(activityListMarkup([], context), /No activity yet/);
  assert.equal(relatedWorkMarkup([], context), "");
  const related = relatedWorkMarkup([
    { taskId: "t1", status: "todo", date: "2026-10-20", description: "Call <Ada>", href: "/x", scope: "related-company" },
  ], context);
  assert.match(related, /related company/);
  assert.match(related, /Call &lt;Ada&gt;/);
  assert.match(related, /data-open-task="t1"/);
});

test("the panel exposes filter, pager, note form and no send affordances", () => {
  const markup = activityPanelMarkup({ targetType: "deal" });
  for (const type of ACTIVITY_TYPES) assert.match(markup, new RegExp(`value="${type}"`));
  assert.match(markup, /data-activity-list/);
  assert.match(markup, /data-activity-pager/);
  assert.match(markup, /data-activity-related/);
  assert.match(markup, /Add a note/);
  assert.doesNotMatch(markup, /draft|send|approv|dispatch/i);
});

test("wired panel retries the same idempotency key until the note saves", async () => {
  const calls = [];
  let attempts = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path.startsWith("/notes/")) {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return { id: "n1", body: "Saved" };
    }
    return activityPayload();
  };
  const root = new FakeNode("div");
  const list = root.setQuery("[data-activity-list]", new FakeNode("div"));
  root.setQuery("[data-activity-pager]", new FakeNode("div"));
  root.setQuery("[data-activity-related]", new FakeNode("div"));
  root.setQuery("[data-activity-note-status]", new FakeNode("p"));
  const form = root.setQuery("[data-activity-note-form]", new FakeNode("form"));
  form.elements.body.value = "Saved";
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  const errors = [];
  const wired = wireActivityPanel(root, loader, {
    ...context,
    safe: async (action) => action().catch((error) => errors.push(error)),
    generateKey: () => "fixed-key",
  });
  await wired.refresh();
  assert.match(list.innerHTML, /No activity yet/);
  await form.dispatch("submit", {});
  assert.equal(errors.length, 1);
  assert.equal(calls.filter(({ path }) => path.startsWith("/notes/")).length, 1);
  await form.dispatch("submit", {});
  const notes = calls.filter(({ path }) => path.startsWith("/notes/"));
  assert.equal(notes.length, 2);
  assert.equal(notes[0].body.sourceKey, "fixed-key");
  assert.equal(notes[1].body.sourceKey, "fixed-key", "retry reuses the key: idempotent replay");
  assert.equal(form.elements.body.value, "", "draft clears only after save");
});

test("wired panel pager, retry and task buttons behave", async () => {
  const api = createApiStub({
    "GET /activity/organization/c1?limit=30": activityPayload(
      [{ ts: "2026-10-09T00:00:00Z", source: "history", id: "h1", actor: null, text: "Record updated", provenance: {} }],
      {
        nextCursor: "c2",
        total: 2,
        relatedWork: [{ taskId: "t1", status: "todo", date: "2026-10-20", description: "Call", href: "/sponsors/deals/d1", scope: "direct" }],
      },
    ),
    "GET /activity/organization/c1?limit=30&cursor=c2": activityPayload(
      [{ ts: "2026-10-08T00:00:00Z", source: "note", id: "n1", actor: null, text: "Older", provenance: {} }],
      { total: 2 },
    ),
  });
  const root = new FakeNode("div");
  const list = root.setQuery("[data-activity-list]", new FakeNode("div"));
  const pager = root.setQuery("[data-activity-pager]", new FakeNode("div"));
  const related = root.setQuery("[data-activity-related]", new FakeNode("div"));
  root.setQuery("[data-activity-note-form]", new FakeNode("form"));
  root.setQuery("[data-activity-note-status]", new FakeNode("p"));
  const opened = [];
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  const wired = wireActivityPanel(root, loader, { ...context, safe: async (action) => action(), openTaskPanel: (id) => opened.push(id) });
  await wired.refresh();
  assert.match(list.innerHTML, /Record updated/);
  assert.match(related.innerHTML, /data-open-task="t1"/);
  assert.match(pager.innerHTML, /Show more \(1 remaining\)/);
  const more = new FakeNode("button");
  more.setClosest("[data-activity-more]", more);
  await pager.dispatch("click", { targetPatch: {}, closestPatch: { "[data-activity-more]": more } });
  assert.match(list.innerHTML, /Older/);
  assert.equal(pager.innerHTML, "");
  const taskButton = new FakeNode("button");
  taskButton.setClosest("[data-open-task]", { dataset: { openTask: "t1" } });
  await related.dispatch("click", { closestPatch: { "[data-open-task]": { dataset: { openTask: "t1" } } } });
  assert.deepEqual(opened, ["t1"]);
});

test("a stale filter response never overwrites the newer page", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const api = async (path) => {
    calls += 1;
    if (calls === 1) {
      await first;
      return activityPayload([{ ts: "2026-10-01T00:00:00Z", source: "note", id: "old", actor: null, text: "Old", provenance: {} }]);
    }
    return activityPayload([{ ts: "2026-10-09T00:00:00Z", source: "note", id: "new", actor: null, text: "New", provenance: {} }], { total: 1 });
  };
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  const pending = loader.load({ types: [] });
  await loader.load({ types: ["note"] });
  releaseFirst();
  await pending;
  assert.deepEqual(loader.state.items.map((item) => item.id), ["new"], "deferred first response is discarded");
  assert.deepEqual(loader.state.types, ["note"]);
});

test("note status is owned locally even when the wrapper swallows errors", async () => {
  const root = new FakeNode("div");
  root.setQuery("[data-activity-list]", new FakeNode("div"));
  root.setQuery("[data-activity-pager]", new FakeNode("div"));
  root.setQuery("[data-activity-related]", new FakeNode("div"));
  root.setQuery("[data-activity-note-status]", new FakeNode("p"));
  const form = root.setQuery("[data-activity-note-form]", new FakeNode("form"));
  form.elements.body.value = "Draft";
  let fail = true;
  const api = async (path, options = {}) => {
    if (path.startsWith("/notes/")) {
      if (fail) throw new Error("network down");
      return { id: "n1", body: "Draft" };
    }
    return activityPayload();
  };
  const loader = createActivityLoader({ api, targetType: "deal", targetId: "d1" });
  // Swallowing wrapper: resolves without rethrowing.
  const swallowing = async () => {};
  const wired = wireActivityPanel(root, loader, { ...context, safe: swallowing, generateKey: () => "k" });
  await wired.refresh();
  await form.dispatch("submit", {});
  const status = root.querySelector("[data-activity-note-status]");
  assert.match(status.textContent, /not saved/, "status settles without the wrapper's catch");
  assert.equal(form.elements.body.value, "Draft", "failed draft is preserved");
  fail = false;
  await form.dispatch("submit", {});
  assert.match(status.textContent, /saved/);
  assert.equal(form.elements.body.value, "", "saved draft clears");
});

test("concurrent same-cursor paging is single-flight", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = async (path) => {
    if (path.includes("cursor=")) {
      fetches += 1;
      await gate;
      return activityPayload([{ ts: "2026-10-08T00:00:00Z", source: "note", id: "n2", actor: null, text: "Two", provenance: {} }], { total: 2 });
    }
    return activityPayload([{ ts: "2026-10-09T00:00:00Z", source: "note", id: "n1", actor: null, text: "One", provenance: {} }], { nextCursor: "c2", total: 2 });
  };
  const loader = createActivityLoader({ api, targetType: "organization", targetId: "c1" });
  await loader.load();
  const first = loader.loadMore();
  const second = loader.loadMore();
  release();
  await Promise.all([first, second]);
  assert.equal(fetches, 1, "one fetch for two concurrent pager clicks");
  assert.deepEqual(loader.state.items.map((item) => item.id), ["n1", "n2"], "no duplicate appends");
});

test("note submits are single-flight and preserve mid-save edits", async () => {
  const calls = [];
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  const api = async (path, options = {}) => {
    if (path.startsWith("/notes/")) {
      calls.push(JSON.parse(options.body));
      await gate;
      return { id: "n1", body: "First" };
    }
    return activityPayload();
  };
  const root = new FakeNode("div");
  root.setQuery("[data-activity-list]", new FakeNode("div"));
  root.setQuery("[data-activity-pager]", new FakeNode("div"));
  root.setQuery("[data-activity-related]", new FakeNode("div"));
  root.setQuery("[data-activity-note-status]", new FakeNode("p"));
  const form = root.setQuery("[data-activity-note-form]", new FakeNode("form"));
  form.elements.body.value = "First";
  const loader = createActivityLoader({ api, targetType: "deal", targetId: "d1" });
  const wired = wireActivityPanel(root, loader, { ...context, safe: async (action) => action(), generateKey: () => "k" });
  await wired.refresh();
  const first = form.dispatch("submit", {});
  const second = form.dispatch("submit", {});
  // The draft changes while the save is in flight.
  form.elements.body.value = "First plus more";
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1, "one POST for two rapid submits");
  assert.equal(calls[0].sourceKey, "k");
  assert.equal(form.elements.body.value, "First plus more", "mid-save edits are retained, not clobbered");
});

test("wired panel surfaces load failures with retry", async () => {
  let fail = true;
  const api = async () => {
    if (fail) throw httpError(500, "boom");
    return activityPayload();
  };
  const root = new FakeNode("div");
  const list = root.setQuery("[data-activity-list]", new FakeNode("div"));
  root.setQuery("[data-activity-pager]", new FakeNode("div"));
  root.setQuery("[data-activity-related]", new FakeNode("div"));
  const loader = createActivityLoader({ api, targetType: "deal", targetId: "d1" });
  const wired = wireActivityPanel(root, loader, { ...context, safe: async (action) => action() });
  await wired.refresh();
  assert.match(list.innerHTML, /Activity unavailable/);
  assert.match(list.innerHTML, /Retry/);
  fail = false;
  const retry = new FakeNode("button");
  await list.dispatch("click", { closestPatch: { "[data-activity-retry]": retry } });
  assert.match(list.innerHTML, /No activity yet/);
});
