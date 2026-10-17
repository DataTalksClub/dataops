import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSponsorPersonDetail,
  personChannelsMarkup,
  personDetailMarkup,
  personHeaderMarkup,
  personOverviewMarkup,
} from "../src/surfaces/finance/sponsor-person-detail.js";
import { createApiStub, escapeHtml, FakeNode, httpError, installFormData } from "./support/fake-record-dom.mjs";

installFormData();

const context = { escapeHtml };

const person = {
  id: "p1",
  organizationId: "c1",
  name: "Ada <Lovelace>",
  emails: ["ada@acme.example"],
  primary: true,
  role: "CTO",
  linkedin: "https://www.linkedin.com/in/ada",
  telegram: "@ada",
  notes: "Prefers email.",
  lastTouch: "2026-10-09T12:00:00.000Z",
  active: true,
  version: 2,
};

function personHarness({ routes, context: extra = {} } = {}) {
  const calls = [];
  const api = createApiStub(routes, calls);
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  const closed = [];
  const edited = [];
  const companies = [];
  const detail = createSponsorPersonDetail({
    api,
    surface,
    escapeHtml,
    closeRecord: () => closed.push(true),
    openContactEditor: (record) => edited.push(record),
    openCompanyRecord: (id) => companies.push(id),
    ...extra,
  });
  detail.wire(host);
  return { api, surface, host, calls, closed, edited, companies, detail };
}

function seedPersonPanels(host) {
  return {
    overview: host.setQuery('[data-person-panel="overview"]', new FakeNode("section")),
    activity: host.setQuery('[data-person-panel="activity"]', new FakeNode("section")),
  };
}

test("constructing the person detail fails loudly without E integration", () => {
  const surface = new FakeNode("section");
  assert.throws(() => createSponsorPersonDetail({ surface, closeRecord: () => {} }), /requires api/);
  assert.throws(() => createSponsorPersonDetail({ api: async () => ({}), closeRecord: () => {} }), /requires surface/);
  assert.throws(() => createSponsorPersonDetail({ api: async () => ({}), surface }), /requires closeRecord/);
});

test("opening a person renders identity overview only, no activity fetch", async () => {
  const { host, calls, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme Co" },
    },
  });
  seedPersonPanels(host);
  const opened = await detail.openPerson("p1");
  assert.equal(opened.id, "p1");
  assert.match(host.innerHTML, /Ada &lt;Lovelace&gt;/);
  assert.match(host.innerHTML, /CTO/);
  assert.match(host.innerHTML, /Primary/);
  assert.match(host.innerHTML, /Acme Co/);
  assert.match(host.innerHTML, /role="tablist"/);
  const urls = calls.map(({ path }) => path);
  assert.ok(!urls.some((path) => path.includes("/activity/")), `no activity fetch on open, got ${urls}`);
  assert.doesNotMatch(host.innerHTML, /Related open work|No activity yet|data-activity-note-form/);
  assert.match(host.innerHTML, /data-person-panel="activity"/, "empty activity panel waits for its tab");
  assert.ok(host.querySelector("[data-person-title]").focused, "title takes keyboard focus");
});

test("activity loads lazily once on first tab open with honest states", async () => {
  const { host, calls, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme Co" },
      "GET /activity/contact/p1?limit=30": {
        targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null,
        sources: {},
        relatedWork: [{ taskId: "t1", status: "todo", date: "2026-10-21", description: "Intro call", href: "/sponsors/companies/c1", scope: "related-company" }],
        tasksScope: "open", reads: {},
      },
    },
  });
  const panels = seedPersonPanels(host);
  await detail.openPerson("p1");
  await detail.switchTab("activity");
  assert.match(panels.activity.innerHTML, /Filter activity/, "compact disclosure wraps the type filter");
  assert.match(panels.activity.innerHTML, /data-activity-note-form/, "note form lives in the activity tab");
  assert.match(panels.activity.querySelector("[data-activity-related]").innerHTML, /related company/, "related-company work stays labeled");
  const activityCalls = calls.filter(({ path }) => path.includes("/activity/"));
  assert.equal(activityCalls.length, 1, "exactly one bounded activity fetch");
  await detail.switchTab("overview");
  await detail.switchTab("activity");
  assert.equal(calls.filter(({ path }) => path.includes("/activity/")).length, 1, "no refetch on revisit");
});

test("activity errors render retry without faking content", async () => {
  const { host, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /activity/contact/p1?limit=30": httpError(500, "boom"),
    },
  });
  seedPersonPanels(host);
  await detail.openPerson("p1");
  await detail.switchTab("activity");
  assert.match(host.querySelector('[data-person-panel="activity"]').querySelector("[data-activity-list]").innerHTML, /Activity unavailable/);
});

test("stale activity never clears the new person's single-flight flag", async () => {
  const fetches = { p1: 0, p2: 0 };
  let releaseA, releaseB;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "" };
    if (path === "/activity/contact/p1?limit=30") {
      fetches.p1 += 1;
      await gateA;
      return { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    if (path === "/activity/contact/p2?limit=30") {
      fetches.p2 += 1;
      await gateB;
      return { targetType: "contact", targetId: "p2", items: [{ ts: "2026-10-09T00:00:00Z", source: "note", id: "b-note", actor: null, text: "Bee", provenance: {} }], total: 1, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  const activityPanel = host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  await detail.openPerson("p1");
  const pendingA = detail.switchTab("activity");
  await detail.openPerson("p2");
  const pendingB = detail.switchTab("activity");
  // Stale A resolves while B is still in flight: it must return before
  // touching the shared single-flight flag.
  releaseA();
  await pendingA;
  // Repeat B click while B is in flight: still exactly one B request.
  await detail.switchTab("activity");
  assert.equal(fetches.p2, 1, "stale A never cleared B's single-flight flag");
  releaseB();
  await pendingB;
  assert.match(activityPanel.querySelector("[data-activity-list]").innerHTML, /Bee/, "B content paints after its own load");
  assert.equal(fetches.p1, 1);
});

test("deferred company lookup waits until A actually reaches the company API", async () => {
  let releaseCompany;
  const gate = new Promise((resolve) => { releaseCompany = resolve; });
  let aInCompanyFetch = false;
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "c9" };
    if (path === "/directory/companies/c1") {
      aInCompanyFetch = true;
      await gate;
      return { id: "c1", displayName: "Acme Co" };
    }
    if (path === "/directory/companies/c9") return { id: "c9", displayName: "Beta Inc" };
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {}, openCompanyRecord: () => {} });
  detail.wire(host);
  const pendingA = detail.openPerson("p1");
  for (let spin = 0; spin < 100 && !aInCompanyFetch; spin += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.ok(aInCompanyFetch, "B opens only after A entered the company fetch (not just the contact token)");
  await detail.openPerson("p2");
  releaseCompany();
  await pendingA;
  assert.match(host.innerHTML, /Beta Inc/, "only the newer person's company renders");
  assert.doesNotMatch(host.innerHTML, /Acme Co/, "stale company lookup paints nothing");
});

test("stale rejected open paints no error into the newer person", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let current = true;
  const api = async (path) => {
    if (path === "/contacts/p1") {
      await gate;
      throw httpError(503, "workspace unavailable");
    }
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "" };
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  const pendingA = detail.openPerson("p1", { isCurrent: () => current });
  await detail.openPerson("p2", { isCurrent: () => current });
  current = false;
  release();
  await pendingA;
  assert.match(host.innerHTML, /Bo</, "newer open renders");
  assert.doesNotMatch(host.innerHTML, /unavailable|No person found/, "stale rejection paints no error into the new page");
});

test("stale activity responses never render into a switched person", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "" };
    if (path === "/activity/contact/p1?limit=30") {
      await gate;
      return { targetType: "contact", targetId: "p1", items: [{ ts: "2026-10-01T00:00:00Z", source: "note", id: "old", actor: null, text: "Stale", provenance: {} }], total: 1, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    if (path === "/activity/contact/p2?limit=30") {
      return { targetType: "contact", targetId: "p2", items: [{ ts: "2026-10-09T00:00:00Z", source: "note", id: "fresh", actor: null, text: "Fresh", provenance: {} }], total: 1, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  const activityPanel = host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  await detail.openPerson("p1");
  const pending = detail.switchTab("activity");
  await detail.openPerson("p2");
  releaseFirst();
  await pending;
  await detail.switchTab("activity");
  const listHtml = activityPanel.querySelector("[data-activity-list]").innerHTML;
  assert.match(listHtml, /Fresh/, "only the current person's activity renders");
  assert.doesNotMatch(listHtml, /Stale/);
});

test("rapid activity clicks fetch once and share one wiring", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path.startsWith("/activity/")) {
      fetches += 1;
      await gate;
      return { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  await detail.openPerson("p1");
  const first = detail.switchTab("activity");
  const second = detail.switchTab("activity");
  release();
  await Promise.all([first, second]);
  assert.equal(fetches, 1, "one bounded fetch for two rapid tab clicks");
});

test("person load failure retries the same person without duplicate state", async () => {
  let attempts = 0;
  const api = async (path) => {
    if (path === "/contacts/p1") {
      attempts += 1;
      if (attempts === 1) throw httpError(503, "unavailable");
      return person;
    }
    if (path === "/directory/companies/c1") return { id: "c1", displayName: "Acme Co" };
    if (path.startsWith("/activity/")) {
      return { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} };
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {}, openCompanyRecord: () => {} });
  detail.wire(host);
  await detail.openPerson("p1");
  assert.match(host.innerHTML, /unavailable/i);
  await host.dispatch("click", { closestPatch: { "[data-record-retry]": new FakeNode("button") } });
  assert.equal(attempts, 2, "retry refetches the same person once");
  assert.match(host.innerHTML, /Ada &lt;Lovelace&gt;/);
});

test("tab switching updates buttons in place without nesting tablists", async () => {
  const { host, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme Co" },
      "GET /activity/contact/p1?limit=30": { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} },
    },
  });
  seedPersonPanels(host);
  const tabs = host.setQuery("[data-person-tabs]", new FakeNode("div"));
  const overviewButton = new FakeNode("button");
  overviewButton.dataset.personTab = "overview";
  const activityButton = new FakeNode("button");
  activityButton.dataset.personTab = "activity";
  tabs.setQueryAll('[role="tab"]', [overviewButton, activityButton]);
  await detail.openPerson("p1");
  await detail.switchTab("activity");
  assert.equal(overviewButton.getAttribute("aria-selected"), "false");
  assert.equal(activityButton.getAttribute("aria-selected"), "true");
  assert.equal(activityButton.getAttribute("tabindex"), "0");
  assert.doesNotMatch(tabs.innerHTML, /data-person-tabs/, "no nested tablist markup");
});

test("a stale person open never paints or focuses after tab navigation", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let current = true;
  const api = async (path) => {
    if (path === "/contacts/p1") {
      await gate;
      return person;
    }
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "" };
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  const pending = detail.openPerson("p1", { isCurrent: () => current });
  current = false;
  release();
  await pending;
  assert.match(host.innerHTML, /Loading person/, "no stale paint");
  assert.ok(!host.querySelector("[data-person-title]").focused, "no focus steal");
  current = true;
  await detail.openPerson("p2", { isCurrent: () => current });
  assert.match(host.innerHTML, /Bo</, "newer open still succeeds");
});

test("person contact rejection shows error with working retry, no paint", async () => {
  let attempts = 0;
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  const api = async (path) => {
    if (path === "/contacts/p1") {
      attempts += 1;
      if (attempts === 1) throw httpError(503, "workspace unavailable");
      return person;
    }
    if (path === "/directory/companies/c1") return { id: "c1", displayName: "Acme Co" };
    throw new Error(`Unexpected: ${path}`);
  };
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {}, openCompanyRecord: () => {} });
  detail.wire(host);
  await detail.openPerson("p1", { isCurrent: () => true });
  assert.match(host.innerHTML, /unavailable/i);
  assert.doesNotMatch(host.innerHTML, /Ada/);
  await host.dispatch("click", { closestPatch: { "[data-record-retry]": new FakeNode("button") } });
  assert.equal(attempts, 2);
  assert.match(host.innerHTML, /Ada &lt;Lovelace&gt;/, "retry recovers the same person");
});

test("deferred company lookup never paints into the newer person", async () => {
  let releaseCompany;
  const gate = new Promise((resolve) => { releaseCompany = resolve; });
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "c9" };
    if (path === "/directory/companies/c1") {
      await gate;
      return { id: "c1", displayName: "Acme Co" };
    }
    if (path === "/directory/companies/c9") return { id: "c9", displayName: "Beta Inc" };
    throw new Error(`Unexpected: ${path}`);
  };
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {}, openCompanyRecord: () => {} });
  detail.wire(host);
  const pendingA = detail.openPerson("p1", { isCurrent: () => true });
  await detail.openPerson("p2", { isCurrent: () => true });
  releaseCompany();
  await pendingA;
  assert.match(host.innerHTML, /Beta Inc/, "only the newer person's company renders");
  assert.doesNotMatch(host.innerHTML, /Acme Co/, "stale company lookup paints nothing");
});

test("a fresh unguarded open is not poisoned by an older false guard", async () => {
  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-person]", new FakeNode("article"));
  host.setQuery('[data-person-panel="overview"]', new FakeNode("section"));
  host.setQuery('[data-person-panel="activity"]', new FakeNode("section"));
  const api = async (path) => {
    if (path === "/contacts/p1") return person;
    if (path === "/contacts/p2") return { ...person, id: "p2", name: "Bo", organizationId: "" };
    throw new Error(`Unexpected: ${path}`);
  };
  let current = false;
  const detail = createSponsorPersonDetail({ api, surface, escapeHtml, closeRecord: () => {} });
  detail.wire(host);
  await detail.openPerson("p1", { isCurrent: () => current });
  assert.match(host.innerHTML, /Loading person/, "false guard renders nothing");
  await detail.openPerson("p2");
  assert.match(host.innerHTML, /Bo</, "unguarded newer open succeeds");
});

test("missing people degrade honestly", async () => {
  const { host, detail } = personHarness({
    routes: { "GET /contacts/gone": httpError(404, "Not found") },
  });
  await detail.openPerson("gone");
  assert.match(host.innerHTML, /Person not found/);
});

test("edit, company anchor and back behavior are preserved", async () => {
  const { host, edited, companies, closed, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme Co" },
    },
  });
  seedPersonPanels(host);
  await detail.openPerson("p1");
  await host.dispatch("click", { closestPatch: { "[data-edit-person]": new FakeNode("button") } });
  assert.deepEqual(edited.map((record) => record.id), ["p1"]);
  await host.dispatch("click", { closestPatch: { "[data-open-company]": { dataset: { openCompany: "c1" } } } });
  assert.deepEqual(companies, ["c1"]);
  await host.dispatch("click", { metaKey: true, closestPatch: { "[data-open-company]": { dataset: { openCompany: "c1" } } } });
  assert.deepEqual(companies, ["c1"], "modified clicks keep native new-tab behavior");
  await host.dispatch("click", { closestPatch: { "[data-person-back]": new FakeNode("button") } });
  assert.deepEqual(closed, [true]);
  await host.dispatch("keydown", { key: "ArrowRight", closestPatch: { '[role="tab"]': { dataset: { personTab: "overview" } } } });
  assert.ok(host.querySelector('[data-person-tab="activity"]').focused, "tabs are keyboard reachable");
});

test("person markup escapes content and hides edit without an editor", () => {
  const header = personHeaderMarkup({ name: "<Bo>", role: "<x>", primary: true, organizationId: "c1" }, { companyName: "<Co>", canEdit: true }, context);
  assert.match(header, /&lt;Bo&gt;/);
  assert.match(header, /&lt;x&gt;/);
  assert.match(header, /href="\/sponsors\/companies\/c1"/);
  assert.match(header, /data-open-company="c1"/);
  assert.match(header, /data-edit-person/);
  const plain = personHeaderMarkup({ name: "Bo" }, {}, context);
  assert.match(plain, /No company link/);
  assert.doesNotMatch(plain, /data-edit-person/);
  const channels = personChannelsMarkup({ emails: ["<a@b>"], linkedin: "https://example.com/<x>", telegram: "@t" }, context);
  assert.match(channels, /&lt;a@b&gt;/);
  assert.match(channels, /mailto:&lt;a@b&gt;/);
  assert.doesNotMatch(channels, /<a@b>/);
  assert.match(personChannelsMarkup({}, context), /No contact channels/);
  const detail = personDetailMarkup({ name: "Bo", notes: "<n>" }, {}, context);
  assert.match(detail, /data-person-panel="activity"/);
  assert.match(detail, /data-person-panel="overview"/);
  const overviewShell = personOverviewMarkup({ name: "Bo", notes: "<n>" }, context);
  assert.match(overviewShell, /Channels/);
  assert.match(overviewShell, /&lt;n&gt;/, "notes live in the overview panel, not the shell");
  assert.doesNotMatch(overviewShell, /data-activity-note-form|data-activity-list/, "overview fetches and shows no timeline");
});
