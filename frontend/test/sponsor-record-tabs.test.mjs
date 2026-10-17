import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveDisclosureMarkup,
  createArchiveLoader,
  createSponsorRecord,
  dealsListMarkup,
  emptyMarkup,
  errorMarkup,
  nextTaskMarkup,
  overviewMarkup,
  peopleListMarkup,
  recordShellMarkup,
  recordTabsMarkup,
} from "../src/surfaces/finance/sponsor-record.js";
import { createApiStub, escapeHtml, FakeNode, httpError } from "./support/fake-record-dom.mjs";

const context = { escapeHtml };

const company = {
  id: "c1",
  displayName: "Acme <Co>",
  domain: "acme.example",
  relationship: "talking",
  active: true,
  primaryPerson: { id: "p1", name: "Ada", email: "ada@acme.example" },
  notes: "Warm intro via conference.",
  lastTouch: "2026-10-09T12:00:00.000Z",
  openDealCount: 1,
  version: 3,
};

const preview = {
  targetType: "organization",
  targetId: "c1",
  items: [
    { ts: "2026-10-09T12:00:00Z", source: "note", id: "n1", actor: "op", text: "Called Ada", provenance: {} },
  ],
  total: 1,
  nextCursor: null,
  sources: { note: 1 },
  relatedWork: [
    { taskId: "t1", status: "todo", date: "2026-10-20", effectiveDate: "2026-10-20", eligible: true, deferred: false, description: "Send deck", href: "/sponsors/deals/d1", scope: "direct" },
  ],
  tasksScope: "open",
  reads: {},
};

function recordHarness({ routes, context: extra = {} } = {}) {
  const calls = [];
  const api = createApiStub(routes, calls);
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-record]", new FakeNode("article"));
  const closed = [];
  const financed = [];
  const record = createSponsorRecord({
    api,
    surface,
    escapeHtml,
    closeRecord: () => closed.push(true),
    loadFinance: async (deal) => financed.push(deal.id),
    ...extra,
  });
  record.wire(host);
  return { api, surface, host, calls, closed, financed, record };
}

function seedPanels(host, names = ["overview", "people", "activity", "deals", "finance"]) {
  const panels = {};
  for (const name of names) panels[name] = host.setQuery(`[data-record-panel="${name}"]`, new FakeNode("section"));
  host.setQuery("[data-record-header]", new FakeNode("header"));
  host.setQuery("[data-record-title]", new FakeNode("h2"));
  return panels;
}

test("constructing the record fails loudly without E integration", () => {
  const surface = new FakeNode("section");
  assert.throws(() => createSponsorRecord({ surface, closeRecord: () => {}, loadFinance: async () => {} }), /requires api/);
  assert.throws(() => createSponsorRecord({ api: async () => ({}), closeRecord: () => {}, loadFinance: async () => {} }), /requires surface/);
  assert.throws(() => createSponsorRecord({ api: async () => ({}), surface, loadFinance: async () => {} }), /requires closeRecord/);
  assert.throws(() => createSponsorRecord({ api: async () => ({}), surface, closeRecord: () => {} }), /requires loadFinance/);
});

test("opening a company fetches only the projection plus an activity preview", async () => {
  const { host, calls, financed, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  assert.match(host.innerHTML, /Acme &lt;Co&gt;/);
  assert.match(host.innerHTML, /role="tablist"/);
  assert.match(host.innerHTML, /data-record-tab="finance"/);
  assert.match(panels.overview.innerHTML, /Next action/);
  assert.match(panels.overview.innerHTML, /Send deck/);
  assert.match(panels.overview.innerHTML, /Company summary/);
  assert.match(panels.overview.innerHTML, /Warm intro via conference/);
  assert.match(panels.overview.innerHTML, /Called Ada/);
  const paths = calls.map(({ path }) => path);
  assert.deepEqual(paths, ["/directory/companies/c1", "/activity/organization/c1?limit=3"]);
  assert.equal(financed.length, 0, "no eager finance load on Overview");
  assert.ok(!paths.some((path) => /\/deals|\/directory\/people|messages|mail/.test(path)), "no deal/people/mail bodies on Overview");
  assert.ok(host.querySelector("[data-record-title]").focused, "title takes keyboard focus");
});

test("missing companies degrade honestly and retry refetches", async () => {
  const routes = { "GET /directory/companies/gone": httpError(404, "Not found") };
  const { host, record, calls } = recordHarness({ routes });
  await record.openCompany("gone");
  assert.match(host.innerHTML, /Company not found/);
  assert.equal(calls.length, 1);
  const failing = recordHarness({
    routes: { "GET /directory/companies/c1": httpError(500, "boom") },
  });
  const panels = seedPanels(failing.host);
  await failing.record.openCompany("c1");
  assert.match(failing.host.innerHTML, /Unavailable/);
  assert.match(failing.host.innerHTML, /data-record-retry/);
});

test("people tab pages the directory and gates editing on A's editor", async () => {
  const people = {
    items: [{ id: "p1", organizationId: "c1", name: "Ada", emails: ["ada@acme.example"], primary: true, role: "CTO", lastTouch: "2026-10-09T00:00:00Z" }],
    total: 2,
    nextCursor: "people-2",
  };
  const edited = [];
  const { host, calls, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /directory/people?company=c1&limit=30": people,
      "GET /directory/people?company=c1&limit=30&cursor=people-2": { items: [{ id: "p2", name: "Bo" }], total: 2, nextCursor: null },
    },
    context: { openContactEditor: (person) => edited.push(person) },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("people");
  assert.match(panels.people.innerHTML, /Ada/);
  assert.match(panels.people.innerHTML, /CTO/);
  assert.match(panels.people.innerHTML, /Primary/);
  assert.match(panels.people.innerHTML, /data-edit-person="p1"/);
  assert.match(panels.people.innerHTML, /Show more people/);
  assert.ok(calls.some(({ path }) => path === "/directory/people?company=c1&limit=30"));
  // Paged follow-up appends with the bound cursor.
  await host.dispatch("click", { closestPatch: { "[data-people-more]": new FakeNode("button") } });
  assert.match(panels.people.innerHTML, /Bo/);
  // Edit routes through A's editor with the stored person.
  const edit = new FakeNode("button");
  await host.dispatch("click", { closestPatch: { "[data-edit-person]": { dataset: { editPerson: "p1" } } } });
  assert.deepEqual(edited.map((person) => person.id), ["p1"]);
  void edit;
});

test("people tab without an editor shows no edit affordances", async () => {
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /directory/people?company=c1&limit=30": { items: [{ id: "p1", name: "Ada" }], total: 1, nextCursor: null },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("people");
  assert.doesNotMatch(panels.people.innerHTML, /data-edit-person/);
  assert.doesNotMatch(panels.people.innerHTML, /data-add-person/);
});

test("deals tab selects the deal and finance loads lazily per deal", async () => {
  const deals = {
    items: [
      { id: "d1", organizationId: "c1", status: "agreed", productKind: "package", openTasks: [{ description: "Sign", date: "2026-10-22" }] },
      { id: "d0", organizationId: "c1", status: "lost", productKind: "one-off" },
    ],
    nextCursor: null,
  };
  const { host, calls, financed, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": { ...company, primaryPerson: null },
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": deals,
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1", { dealId: "d0" });
  await record.switchTab("deals");
  assert.equal(record.getSelectedDealId(), "d0", "explicit deep-link selection is preserved");
  await host.dispatch("click", { closestPatch: { "[data-select-deal]": { dataset: { selectDeal: "d1" } } } });
  assert.equal(record.getSelectedDealId(), "d1");
  assert.match(panels.deals.innerHTML, /aria-current="true"/);
  await record.switchTab("finance");
  assert.deepEqual(financed, ["d1"], "canonical loadFinance runs once per selected deal");
  assert.match(panels.finance.innerHTML, /data-booking-panel="finance"/, "finance tab hosts the canonical hook");
  assert.equal(calls.filter(({ path }) => path.startsWith("/deals")).length, 1);
  // Revisiting without a deal change never refetches finance.
  await record.switchTab("overview");
  await record.switchTab("finance");
  assert.deepEqual(financed, ["d1"]);
});

test("finance without deals stays an honest empty state", async () => {
  const { host, financed, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: [], nextCursor: null },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("finance");
  assert.equal(financed.length, 0);
  assert.match(panels.finance.innerHTML, /No deal selected/);
});

test("Back closes through E integration and tabs are keyboard reachable", async () => {
  const { host, closed, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /directory/people?company=c1&limit=30": { items: [], total: 0, nextCursor: null },
    },
  });
  seedPanels(host);
  await record.openCompany("c1");
  const tabButton = new FakeNode("button");
  tabButton.dataset.recordTab = "overview";
  await host.dispatch("keydown", { key: "ArrowRight", closestPatch: { '[role="tab"]': tabButton } });
  assert.ok(host.querySelector('[data-record-tab="people"]').focused, "ArrowRight moves focus to the next tab");
  assert.match(host.querySelector('[data-record-panel="people"]').innerHTML, /No people yet/, "keyboard activation loads the tab");
  await host.dispatch("click", { closestPatch: { "[data-record-back]": new FakeNode("button") } });
  assert.deepEqual(closed, [true]);
  assert.equal(record.getSelectedDealId(), null, "Back destroys the record state");
});

test("overview shows effective dates and links to People without faking contacts", async () => {
  const payload = {
    ...preview,
    relatedWork: [
      { taskId: "t1", status: "waiting", date: "2026-10-20", effectiveDate: "2026-10-25", deferred: true, deferredUntil: "2026-10-25", eligible: true, description: "Follow up after pause", scope: "direct" },
    ],
  };
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme", notes: "Warm." },
      "GET /activity/organization/c1?limit=3": payload,
      "GET /directory/people?company=c1&limit=30": { items: [{ id: "p1", name: "Ada" }], total: 1, nextCursor: null },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  const overview = panels.overview.innerHTML;
  assert.match(overview, /25 Oct/, "effective date drives the due moment");
  assert.match(overview, /deferred/, "deferred wakeup is labeled");
  assert.match(overview, /originally 20 Oct/, "original date is distinct optional context only");
  assert.doesNotMatch(overview, /No primary person yet/, "no fake no-contact claim");
  const viewPeople = host.querySelector("[data-record-overview]") || panels.overview;
  assert.match(panels.overview.innerHTML, /data-goto-people/, "absent primary offers View People");
  await host.dispatch("click", { closestPatch: { "[data-goto-people]": new FakeNode("button") } });
  assert.match(panels.people.innerHTML, /Ada/, "View People opens the bounded People tab");
  void viewPeople;
});

test("overview error states unknown instead of claiming empty", async () => {
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": { ...company, notes: "Warm intro." },
      "GET /activity/organization/c1?limit=3": httpError(503, "workspace unavailable"),
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  assert.match(panels.overview.innerHTML, /unavailable/i);
  assert.doesNotMatch(panels.overview.innerHTML, /No open task|No recent activity|No task due now/);
  assert.match(panels.overview.innerHTML, /Warm intro/, "verified company summary stays");
});

test("next task names a readable owner, never a raw ID", () => {
  const owners = { op1: "Ada Owner" };
  const ownerName = (id) => owners[id] || "";
  const assigned = nextTaskMarkup(
    { description: "Call", date: "2026-10-20", assigneeId: "op1", taskId: "t1" },
    undefined,
    { ...context, ownerName },
  );
  assert.match(assigned, /Ada Owner/);
  assert.doesNotMatch(assigned, /op1/);
  const unknown = nextTaskMarkup(
    { description: "Call", date: "2026-10-20", assigneeId: "ghost", taskId: "t1" },
    undefined,
    { ...context, ownerName },
  );
  assert.match(unknown, /Unavailable assignee/);
  assert.doesNotMatch(unknown, /ghost/);
  const unassigned = nextTaskMarkup({ description: "Call", date: "2026-10-20", taskId: "t1" }, undefined, context);
  assert.match(unassigned, /Unassigned/);
  const throwing = nextTaskMarkup(
    { description: "Call", date: "2026-10-20", assigneeId: "op1", taskId: "t1" },
    undefined,
    { ...context, ownerName: () => { throw new Error("down"); } },
  );
  assert.match(throwing, /Unavailable assignee/);
});

test("record shell is accessible and honest states escape content", () => {  const shell = recordShellMarkup({ displayName: "<Acme>" }, { returnLabel: "Companies" }, context);
  assert.match(shell, /&lt;Acme&gt;/);
  assert.match(shell, /role="tablist"/);
  assert.match(shell, /role="tabpanel"/);
  assert.match(shell, /aria-selected="true"/);
  assert.match(recordTabsMarkup("activity", context), /data-record-tab="activity"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-record-tab="activity"/);
  assert.match(errorMarkup("<boom>", context), /&lt;boom&gt;/);
  assert.match(errorMarkup("x", context), /data-record-retry/);
  assert.match(emptyMarkup("Empty", null, context), /Empty/);
  const people = peopleListMarkup({ items: [], total: 0, canEdit: true }, context);
  assert.match(people, /No people yet/);
  assert.match(people, /data-add-person/);
  const deals = dealsListMarkup({ deals: [{ id: "d1", status: "agreed", productKind: "package" }], selectedDealId: "d1" }, context);
  assert.match(deals, /Selected/);
  const overview = overviewMarkup({ company: { notes: "<hi>" }, primaryPerson: null, nextTask: null, recent: [] }, context);
  assert.match(overview, /No open task/);
  assert.match(overview, /&lt;hi&gt;/);
});

test("archive disclosure is collapsed, lazy, read-only and honest", async () => {
  const collapsed = archiveDisclosureMarkup({ status: "idle" }, context);
  assert.match(collapsed, /data-record-archive/);
  assert.doesNotMatch(collapsed, /open>/);
  assert.match(archiveDisclosureMarkup({ status: "loading" }, context), /Loading archive/);
  const ready = archiveDisclosureMarkup({
    status: "ready",
    total: 2,
    items: [{ id: "a1", label: "Archived draft", preview: "<hello>", detail: "Full <body>", createdAt: "2026-09-01T10:00:00Z" }],
  }, context);
  assert.match(ready, /Archived drafts and delivery history \(2\)/);
  assert.match(ready, /Archived draft/);
  assert.match(ready, /&lt;hello&gt;/);
  assert.match(ready, /Full text/);
  assert.match(ready, /&lt;body&gt;/);
  assert.doesNotMatch(ready, /<button/);
  assert.doesNotMatch(ready, /data-(draft|approve|cancel|suppress|create-review|reconcile)/);
  assert.match(archiveDisclosureMarkup({ status: "ready", items: [], total: 0 }, context), /No archived messages/);
  assert.match(archiveDisclosureMarkup({ status: "error", error: "<bad>" }, context), /&lt;bad&gt;/);

  let opens = 0;
  const loader = createArchiveLoader({ loadArchive: async () => { opens += 1; return { items: [], total: 0 }; }, dealId: "d1" });
  assert.equal(loader.state.status, "idle");
  await loader.open();
  await loader.open();
  assert.equal(opens, 1, "archive loads once per deal");
  const failing = createArchiveLoader({ loadArchive: async () => { throw httpError(500, "gone"); }, dealId: "d1" });
  await failing.open();
  assert.equal(failing.state.status, "error");
  assert.throws(() => createArchiveLoader({ dealId: "d1" }), /requires loadArchive/);
});

test("people rows keep full last-contacted precision", () => {
  const markup = peopleListMarkup({
    items: [{ id: "p1", name: "Ada", lastTouch: "2026-10-09T12:00:00.000Z", lastContactedAt: "2026-10-09T12:35:00.000Z" }],
    total: 1,
    canEdit: false,
  }, context);
  assert.match(markup, /Last touch 9 Oct/);
  assert.match(markup, /Last contacted 9 Oct.*14:35/);
});

test("activity tab exposes the archive lazily per selected deal", async () => {
  const archives = [];
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": {
        items: [
          { id: "d1", organizationId: "c1", status: "agreed", productKind: "package" },
          { id: "d2", organizationId: "c1", status: "open", productKind: "one-off" },
        ],
        nextCursor: null,
      },
      "GET /activity/organization/c1?limit=30": preview,
    },
    context: { loadArchive: async (dealId) => { archives.push(dealId); return { items: [], total: 0 }; } },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("activity");
  assert.equal(archives.length, 0, "archive never loads before its disclosure opens");
  const archiveHost = panels.activity.querySelector("[data-record-archive-host]");
  assert.match(archiveHost.innerHTML, /No deal selected/);
  await record.switchTab("deals");
  await record.switchTab("activity");
  assert.match(archiveHost.innerHTML, /data-record-archive/);
  assert.ok(archiveHost.listenerOptions("toggle").includes(true), "toggle listener uses capture (details toggle does not bubble)");
  assert.doesNotMatch(archiveHost.innerHTML, /No deal selected/, "deal selection re-resolves the archive");
  const disclosure = archiveHost.querySelector("[data-record-archive]");
  disclosure.open = true;
  await archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  assert.deepEqual(archives, ["d1"]);
  assert.match(archiveHost.innerHTML, /No archived messages/);
  disclosure.open = false;
  await archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  disclosure.open = true;
  await archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  assert.deepEqual(archives, ["d1"], "reopening never refetches a loaded archive");
  await host.dispatch("click", { closestPatch: { "[data-select-deal]": { dataset: { selectDeal: "d2" } } } });
  assert.equal(record.getSelectedDealId(), "d2");
  assert.deepEqual(archives, ["d1"], "selecting another deal does not eager-load its archive");
  disclosure.open = true;
  await archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  assert.deepEqual(archives, ["d1", "d2"], "the new deal archives lazily on open");
});

test("archive loader pages explicitly without dedupe or fake totals", async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path === "/notes/x") throw new Error("unexpected");
    return null;
  };
  const pages = {
    "": { items: [{ id: "m1", kind: "communication-draft-version", label: "Archived draft v1", version: 1 }, { id: "m1", kind: "communication-draft-version", label: "Archived draft v2", version: 2 }], nextCursor: "c2", total: null },
    c2: { items: [{ id: "m2", kind: "sponsor-send-attempt", label: "Delivery delivered" }], nextCursor: null, total: null },
  };
  const seen = [];
  const loader = createArchiveLoader({
    loadArchive: async (dealId, { cursor = "", limit = 50 } = {}) => {
      seen.push({ dealId, cursor, limit });
      assert.equal(limit, 50);
      return pages[cursor];
    },
    dealId: "d1",
  });
  await loader.open();
  assert.equal(loader.state.items.length, 2, "one bounded first page, no silent fan-out");
  assert.equal(loader.state.nextCursor, "c2");
  assert.equal(loader.state.total, null, "no fake total when the server provides none");
  await loader.loadMore();
  assert.equal(loader.state.items.length, 3, "continuation appends");
  assert.deepEqual(loader.state.items.map((item) => item.label), ["Archived draft v1", "Archived draft v2", "Delivery delivered"], "distinct draft versions preserved, never deduped by id");
  assert.equal(loader.state.nextCursor, null);
  assert.deepEqual(seen, [{ dealId: "d1", cursor: "", limit: 50 }, { dealId: "d1", cursor: "c2", limit: 50 }], "cursor contract honored");
  void calls;
});

test("empty first archive page with cursor offers continuation, not emptiness", () => {
  const markup = archiveDisclosureMarkup(
    { status: "ready", items: [], nextCursor: "page-2", total: null, error: "" },
    context,
  );
  assert.match(markup, /Load older/, "continuation offered for the empty projected page");
  assert.doesNotMatch(markup, /No archived messages/, "no false empty claim while a cursor remains");
  const done = archiveDisclosureMarkup(
    { status: "ready", items: [], nextCursor: null, total: null, error: "" },
    context,
  );
  assert.match(done, /No archived messages/, "honest empty only at the true end");
});

test("archive retry after a failed continuation resumes its own cursor", async () => {
  const seen = [];
  let attempts = 0;
  const loader = createArchiveLoader({
    loadArchive: async (dealId, { cursor = "" } = {}) => {
      seen.push(cursor);
      attempts += 1;
      if (!cursor) return { items: [], nextCursor: "page-2", total: null };
      if (attempts === 2) throw new Error("page lost");
      return { items: [{ id: "m9", label: "Archived draft v9" }], nextCursor: null, total: null };
    },
    dealId: "d1",
  });
  await loader.open();
  assert.equal(loader.state.items.length, 0);
  assert.equal(loader.state.nextCursor, "page-2");
  await loader.loadMore();
  assert.equal(loader.state.status, "error");
  await loader.retry();
  assert.equal(loader.state.status, "ready");
  assert.equal(loader.state.items.length, 1);
  assert.deepEqual(seen, ["", "page-2", "page-2"], "retry resumes the failed cursor, never restarts page one");
});

test("concurrent cursorless retries single-flight the refetch", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = createArchiveLoader({
    loadArchive: async () => {
      calls += 1;
      if (calls === 1) throw new Error("first open fails");
      await gate;
      return { items: [{ id: "m1", label: "Archived draft v1" }], nextCursor: null, total: null };
    },
    dealId: "d1",
  });
  await loader.open();
  assert.equal(loader.state.status, "error");
  const first = loader.retry();
  const second = loader.retry();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2, "one initial fetch + one refetch, no duplicate retry");
  assert.equal(loader.state.status, "ready");
});

test("archive retry resumes the failed page and keeps visible rows", async () => {
  let attempts = 0;
  const loader = createArchiveLoader({
    loadArchive: async (dealId, { cursor = "" } = {}) => {
      attempts += 1;
      if (!cursor) return { items: [{ id: "m1", label: "Archived draft v1" }], nextCursor: "c2", total: null };
      if (attempts === 2) throw new Error("page lost");
      return { items: [{ id: "m2", label: "Delivery delivered" }], nextCursor: null, total: null };
    },
    dealId: "d1",
  });
  await loader.open();
  await loader.loadMore();
  assert.equal(loader.state.status, "error");
  assert.equal(loader.state.items.length, 1, "failed continuation retains visible rows");
  assert.equal(loader.state.nextCursor, "c2", "cursor retained for resume");
  await loader.retry();
  assert.equal(loader.state.status, "ready");
  assert.equal(loader.state.items.length, 2);
  assert.equal(attempts, 3);
});

test("reviewable archive drafts open the exact preview read-only", async () => {
  const reviewed = [];
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: [{ id: "d1", organizationId: "c1", status: "open", productKind: "one-off" }], nextCursor: null },
    },
    context: {
      loadArchive: async () => ({
        items: [{ id: "m1", kind: "communication-draft-version", label: "Archived draft v2", preview: "Old draft", version: 2, reviewable: true, createdAt: "2026-10-01T00:00:00Z" }],
        total: 1,
      }),
      onReviewDraft: async (id, version) => reviewed.push([id, version]),
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("deals");
  await record.switchTab("activity");
  const archiveHost = panels.activity.querySelector("[data-record-archive-host]");
  const disclosure = archiveHost.querySelector("[data-record-archive]");
  disclosure.open = true;
  await archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  assert.match(archiveHost.innerHTML, /Review exact draft/);
  assert.doesNotMatch(archiveHost.innerHTML, /data-approve|data-cancel|data-suppress/);
  await archiveHost.dispatch("click", { closestPatch: { "[data-archive-review]": { dataset: { archiveReview: "m1", archiveVersion: "2" } } } });
  assert.deepEqual(reviewed, [["m1", 2]]);
});

test("deals page beyond fifty and resolve off-page selections by ID", async () => {
  const page1 = Array.from({ length: 50 }, (_, index) => ({ id: `d${index}`, organizationId: "c1", status: "open", productKind: "one-off" }));
  const { host, calls, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: page1, nextCursor: "page-2" },
      "GET /deals?organizationId=c1&limit=50&cursor=page-2": {
        items: [{ id: "d50", organizationId: "c1", status: "agreed", productKind: "package" }],
        nextCursor: null,
      },
      "GET /deals/deep": { id: "deep", organizationId: "c1", status: "open", productKind: "package" },
      "GET /deals/stray": { id: "stray", organizationId: "other", status: "open", productKind: "package" },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1", { dealId: "deep" });
  await record.switchTab("deals");
  assert.equal(calls.filter(({ path }) => path === "/deals?organizationId=c1&limit=50").length, 1);
  assert.equal(record.getSelectedDealId(), "deep", "off-page deal resolves by ID and is kept");
  assert.deepEqual(calls.filter(({ path }) => path === "/deals/deep").length, 1);
  assert.match(panels.deals.innerHTML, /Show more deals/);
  await host.dispatch("click", { closestPatch: { "[data-deals-more]": new FakeNode("button") } });
  assert.equal(record.getSelectedDealId(), "deep", "paging never replaces the selection");
  assert.match(panels.deals.innerHTML, /d50/);
  assert.doesNotMatch(panels.deals.innerHTML, /Show more deals/, "cursor exhaustion hides the pager");
  assert.equal(calls.filter(({ path }) => path.startsWith("/deals?")).length, 2, "no duplicate pages");
});

test("tab switching updates buttons in place without nesting tablists", async () => {
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /directory/people?company=c1&limit=30": { items: [], total: 0, nextCursor: null },
    },
  });
  seedPanels(host);
  const tabs = host.setQuery("[data-record-tabs]", new FakeNode("div"));
  const buttons = ["overview", "people", "activity", "deals", "finance"].map((id) => {
    const button = new FakeNode("button");
    button.dataset.recordTab = id;
    return button;
  });
  tabs.setQueryAll("[role=tab]", buttons);
  tabs.setQueryAll('[role="tab"]', buttons);
  await record.openCompany("c1");
  await record.switchTab("people");
  const peopleButton = buttons[1];
  assert.equal(peopleButton.getAttribute("aria-selected"), "true");
  assert.equal(buttons[0].getAttribute("aria-selected"), "false");
  assert.doesNotMatch(tabs.innerHTML, /data-record-tabs/, "no nested tablist markup");
});

test("rapid activity clicks share one loader and one fetch", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = async (path) => {
    if (path === "/directory/companies/c1") return company;
    if (path === "/activity/organization/c1?limit=3") return preview;
    if (path === "/activity/organization/c1?limit=30") {
      fetches += 1;
      await gate;
      return preview;
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-record]", new FakeNode("article"));
  host.setQuery('[data-record-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-record-panel="people"]', new FakeNode("section"));
  host.setQuery('[data-record-panel="activity"]', new FakeNode("section"));
  host.setQuery('[data-record-panel="deals"]', new FakeNode("section"));
  host.setQuery('[data-record-panel="finance"]', new FakeNode("section"));
  const record = createSponsorRecord({
    api, surface, escapeHtml, closeRecord: () => {}, loadFinance: async () => {},
  });
  record.wire(host);
  await record.openCompany("c1");
  const first = record.switchTab("activity");
  const second = record.switchTab("activity");
  release();
  await Promise.all([first, second]);
  assert.equal(fetches, 1, "one bounded fetch for two rapid tab clicks");
});

test("late archive responses never paint under a newly selected deal", async () => {
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const archiveCalls = [];
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": {
        items: [
          { id: "d1", organizationId: "c1", status: "open", productKind: "one-off" },
          { id: "d2", organizationId: "c1", status: "open", productKind: "package" },
        ],
        nextCursor: null,
      },
      "GET /activity/organization/c1?limit=30": preview,
    },
    context: {
      loadArchive: async (dealId) => {
        archiveCalls.push(dealId);
        if (dealId === "d1") {
          await gateA;
          return { items: [{ id: "a1", label: "Archived draft v1 (deal one)" }], nextCursor: null, total: null };
        }
        return { items: [{ id: "b1", label: "Archived draft v1 (deal two)" }], nextCursor: null, total: null };
      },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("deals");
  await record.switchTab("activity");
  const archiveHost = panels.activity.querySelector("[data-record-archive-host]");
  const disclosure = archiveHost.querySelector("[data-record-archive]");
  disclosure.open = true;
  const pendingA = archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  // Select deal two while deal one's archive is still in flight.
  await host.dispatch("click", { closestPatch: { "[data-select-deal]": { dataset: { selectDeal: "d2" } } } });
  releaseA();
  await pendingA;
  assert.ok(!archiveHost.innerHTML.includes("deal one"), "stale A history never paints under B");
  assert.deepEqual(archiveCalls, ["d1"], "no duplicate A fetch, no eager B fetch");
});

test("archive toggle paints pending state immediately, result after resolve", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: [{ id: "d1", organizationId: "c1", status: "open", productKind: "one-off" }], nextCursor: null },
      "GET /activity/organization/c1?limit=30": preview,
    },
    context: {
      loadArchive: async () => {
        await gate;
        return { items: [{ id: "m1", label: "Archived draft v1" }], nextCursor: null, total: null };
      },
    },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("deals");
  await record.switchTab("activity");
  const archiveHost = panels.activity.querySelector("[data-record-archive-host]");
  const disclosure = archiveHost.querySelector("[data-record-archive]");
  disclosure.open = true;
  const pending = archiveHost.dispatch("toggle", { closestPatch: { "[data-record-archive]": disclosure } });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(archiveHost.innerHTML, /Loading archive/, "pending state paints before the fetch resolves");
  release();
  await pending;
  assert.match(archiveHost.innerHTML, /Archived draft v1/, "guarded paint renders the result");
});

test("deals list edits through the loaded object with its version", async () => {
  const edited = [];
  const deals = [
    { id: "d1", organizationId: "c1", status: "open", productKind: "one-off", version: 4 },
  ];
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: deals, nextCursor: null },
    },
    context: { onEditDeal: (deal) => edited.push(deal) },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("deals");
  assert.match(panels.deals.innerHTML, /data-edit-deal="d1"/);
  await host.dispatch("click", { closestPatch: { "[data-edit-deal]": { dataset: { editDeal: "d1" } } } });
  assert.deepEqual(edited, [{ id: "d1", organizationId: "c1", status: "open", productKind: "one-off", version: 4 }], "editor receives the actual loaded deal, no refetch");
  const plain = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: deals, nextCursor: null },
    },
  });
  const plainPanels = seedPanels(plain.host);
  await plain.record.openCompany("c1");
  await plain.record.switchTab("deals");
  assert.doesNotMatch(plainPanels.deals.innerHTML, /data-edit-deal/, "no edit affordance without an editor callback");
});

test("add deal preassociates the loaded company and respects generation", async () => {
  const added = [];
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: [], nextCursor: null },
    },
    context: { onAddDeal: async (organizationId) => added.push(organizationId) },
  });
  const panels = seedPanels(host);
  await record.openCompany("c1");
  await record.switchTab("deals");
  await host.dispatch("click", { closestPatch: { "[data-add-deal]": new FakeNode("button") } });
  assert.deepEqual(added, ["c1"], "company id preassociated");
  record.destroy();
  await host.dispatch("click", { closestPatch: { "[data-add-deal]": new FakeNode("button") } });
  assert.deepEqual(added, ["c1"], "stale panel cannot open the editor after navigation");
});

test("failed explicit selections never fall back to unrelated finance", async () => {
  const page = [{ id: "d1", organizationId: "c1", status: "open", productKind: "one-off" }];
  for (const [name, dealId, byId, message] of [
    ["missing", "gone", httpError(404, "Not found"), /not found/i],
    ["wrong-company", "stray", { id: "stray", organizationId: "other", status: "open", productKind: "package" }, /does not belong/],
    ["unreadable", "flaky", httpError(503, "boom"), /could not be loaded/i],
  ]) {
    const financed = [];
    const { host, record } = recordHarness({
      routes: {
        "GET /directory/companies/c1": company,
        "GET /activity/organization/c1?limit=3": preview,
        "GET /deals?organizationId=c1&limit=50": { items: page, nextCursor: null },
        [`GET /deals/${dealId}`]: byId,
      },
      context: { loadFinance: async (deal) => financed.push(deal.id) },
    });
    const panels = seedPanels(host);
    await record.openCompany("c1", { dealId });
    await record.switchTab("deals");
    assert.equal(record.getSelectedDealId(), dealId, `${name}: the requested ID is preserved, never replaced`);
    assert.equal(record.getCompany().id, "c1");
    assert.match(panels.deals.innerHTML, message, `${name}: the failure is explicit`);
    await record.switchTab("finance");
    assert.deepEqual(financed, [], `${name}: no unrelated finance loads`);
    assert.match(panels.finance.innerHTML, message, `${name}: finance shows the error, not a fallback deal`);
  }
});

test("the next task follows D eligibility ordering, never a deferred row", async () => {
  const deferredOnly = {
    ...preview,
    relatedWork: [{ taskId: "w1", status: "waiting", date: "2026-10-20", description: "Awaiting reply", scope: "direct", eligible: false, deferred: true, effectiveDate: "2026-10-25" }],
  };
  const mixed = {
    ...preview,
    relatedWork: [
      { taskId: "w1", status: "waiting", date: "2026-10-20", description: "Awaiting reply", scope: "direct", eligible: false, deferred: true, effectiveDate: "2026-10-25" },
      { taskId: "t1", status: "todo", date: "2026-10-22", description: "Call back", scope: "direct", eligible: true, deferred: false, effectiveDate: "2026-10-22" },
    ],
  };
  for (const [name, payload, expected] of [["deferred-only", deferredOnly, null], ["mixed", mixed, "t1"]]) {
    const { host, record } = recordHarness({
      routes: {
        "GET /directory/companies/c1": company,
        "GET /activity/organization/c1?limit=3": payload,
      },
    });
    const panels = seedPanels(host);
    await record.openCompany("c1");
    const next = panels.overview.innerHTML;
    if (expected) assert.match(next, /Call back/, `${name}: the eligible todo wins`);
    else assert.match(next, /No task due now/, `${name}: deferred work never masquerades as due`);
    void record;
  }
});

test("destroy invalidates pending loads", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host, record } = recordHarness({
    routes: {
      "GET /directory/companies/c1": async () => { await gate; return company; },
    },
  });
  const pending = record.openCompany("c1");
  record.destroy();
  release();
  await pending;
  assert.match(host.innerHTML, /Loading company/, "pending open leaves only its loading state");
  assert.doesNotMatch(host.innerHTML, /Acme/, "no record renders after destroy");
  assert.equal(record.getCompany(), null);
});

test("company identity comes only from the D projection, never a snapshot", async () => {
  const viaD = { ...company, displayName: "Acme Live", version: 4 };
  const { host, calls, record } = recordHarness({
    routes: { "GET /directory/companies/c1": viaD },
  });
  seedPanels(host);
  await record.openCompany("c1");
  assert.match(host.innerHTML, /Acme Live/);
  assert.ok(!calls.some(({ path }) => path === "/directory/people?company=c1&limit=30"), "overview never forces collections");
  const missing = recordHarness({ routes: { "GET /directory/companies/gone": httpError(404, "missing") } });
  seedPanels(missing.host);
  await missing.record.openCompany("gone");
  assert.match(missing.host.innerHTML, /Company not found/);
});

test("archive and restore actions render only when wired", async () => {
  const archived = [];
  const restored = [];
  const withHandlers = recordHarness({
    routes: {
      "GET /directory/companies/c1": { ...company, archivedAt: "2026-10-01T00:00:00Z" },
      "GET /activity/organization/c1?limit=3": preview,
    },
    context: {
      onArchiveCompany: async () => archived.push(true),
      onRestoreCompany: async () => restored.push(true),
    },
  });
  seedPanels(withHandlers.host);
  await withHandlers.record.openCompany("c1");
  assert.match(withHandlers.host.innerHTML, /data-restore-company/);
  assert.match(withHandlers.host.innerHTML, /Archived/);
  await withHandlers.host.dispatch("click", { closestPatch: { "[data-restore-company]": new FakeNode("button") } });
  assert.deepEqual(restored, [true]);
  const plain = recordHarness({
    routes: {
      "GET /directory/companies/c1": company,
      "GET /activity/organization/c1?limit=3": preview,
    },
  });
  seedPanels(plain.host);
  await plain.record.openCompany("c1");
  assert.doesNotMatch(plain.host.innerHTML, /data-archive-company/);
  assert.doesNotMatch(plain.host.innerHTML, /data-restore-company/);
});
