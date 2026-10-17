import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSponsorRecord,
  dealsListMarkup,
  emptyMarkup,
  errorMarkup,
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
    { taskId: "t1", status: "todo", date: "2026-10-20", description: "Send deck", href: "/sponsors/deals/d1", scope: "direct" },
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
    loadFinance: async (deal, panel) => financed.push([deal.id, panel]),
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
  assert.deepEqual(financed.map(([id]) => id), ["d1"]);
  assert.equal(calls.filter(({ path }) => path.startsWith("/deals")).length, 1);
  // Revisiting without a deal change never refetches finance.
  await record.switchTab("overview");
  await record.switchTab("finance");
  assert.deepEqual(financed.map(([id]) => id), ["d1"]);
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
  await host.dispatch("click", { closestPatch: { "[data-record-back]": new FakeNode("button") } });
  assert.deepEqual(closed, [true]);
  const tabButton = new FakeNode("button");
  tabButton.dataset.recordTab = "overview";
  await host.dispatch("keydown", { key: "ArrowRight", closestPatch: { '[role="tab"]': tabButton } });
  assert.ok(host.querySelector('[data-record-tab="people"]').focused, "ArrowRight moves focus to the next tab");
  assert.match(host.querySelector('[data-record-panel="people"]').innerHTML, /No people yet/, "keyboard activation loads the tab");
});

test("record shell is accessible and honest states escape content", () => {
  const shell = recordShellMarkup({ displayName: "<Acme>" }, { returnLabel: "Companies" }, context);
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
