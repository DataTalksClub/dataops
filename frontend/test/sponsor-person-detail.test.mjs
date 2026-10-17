import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSponsorPersonDetail,
  personChannelsMarkup,
  personDetailMarkup,
  personHeaderMarkup,
} from "../src/surfaces/finance/sponsor-person-detail.js";
import { createApiStub, escapeHtml, FakeNode, httpError } from "./support/fake-record-dom.mjs";

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

test("constructing the person detail fails loudly without E integration", () => {
  const surface = new FakeNode("section");
  assert.throws(() => createSponsorPersonDetail({ surface, closeRecord: () => {} }), /requires api/);
  assert.throws(() => createSponsorPersonDetail({ api: async () => ({}), closeRecord: () => {} }), /requires surface/);
  assert.throws(() => createSponsorPersonDetail({ api: async () => ({}), surface }), /requires closeRecord/);
});

test("opening a person fetches contact plus company name and bounded activity only", async () => {
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
  const opened = await detail.openPerson("p1");
  assert.equal(opened.id, "p1");
  assert.match(host.innerHTML, /Ada &lt;Lovelace&gt;/);
  assert.match(host.innerHTML, /CTO/);
  assert.match(host.innerHTML, /Primary/);
  assert.match(host.innerHTML, /Acme Co/);
  assert.match(host.innerHTML, /ada@acme\.example/);
  assert.match(host.innerHTML, /linkedin\.com/);
  assert.match(host.innerHTML, /Prefers email/);
  const activityHost = host.querySelector("[data-person-activity]");
  assert.match(activityHost.querySelector("[data-activity-related]").innerHTML, /related company/);
  assert.match(host.innerHTML, /Add a note/);
  assert.doesNotMatch(host.innerHTML, /Finance/);
  const paths = calls.map(({ path }) => path);
  assert.ok(!paths.some((path) => /\/finance|\/deals|\/directory\/people|messages|mail/.test(path)), `no finance/deal/directory/mail loads, got ${paths}`);
  assert.ok(host.querySelector("[data-person-title]").focused, "title takes keyboard focus");
});

test("a failed company lookup degrades the link without losing the person", async () => {
  const { host, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": httpError(500, "boom"),
      "GET /activity/contact/p1?limit=30": { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} },
    },
  });
  await detail.openPerson("p1");
  assert.match(host.innerHTML, /Company unavailable/);
  assert.match(host.innerHTML, /Ada &lt;Lovelace&gt;/);
});

test("missing people degrade honestly", async () => {
  const { host, detail } = personHarness({
    routes: { "GET /contacts/gone": httpError(404, "Not found") },
  });
  await detail.openPerson("gone");
  assert.match(host.innerHTML, /Person not found/);
});

test("edit, company link and back route through E/A integration", async () => {
  const { host, edited, companies, closed, detail } = personHarness({
    routes: {
      "GET /contacts/p1": person,
      "GET /directory/companies/c1": { id: "c1", displayName: "Acme Co" },
      "GET /activity/contact/p1?limit=30": { targetType: "contact", targetId: "p1", items: [], total: 0, nextCursor: null, sources: {}, relatedWork: [], tasksScope: "open", reads: {} },
    },
  });
  await detail.openPerson("p1");
  await host.dispatch("click", { closestPatch: { "[data-edit-person]": new FakeNode("button") } });
  assert.deepEqual(edited.map((record) => record.id), ["p1"]);
  await host.dispatch("click", { closestPatch: { "[data-open-company]": { dataset: { openCompany: "c1" } } } });
  assert.deepEqual(companies, ["c1"]);
  await host.dispatch("click", { metaKey: true, closestPatch: { "[data-open-company]": { dataset: { openCompany: "c1" } } } });
  assert.deepEqual(companies, ["c1"], "modified clicks keep native new-tab behavior");
  await host.dispatch("click", { closestPatch: { "[data-person-back]": new FakeNode("button") } });
  assert.deepEqual(closed, [true]);
});

test("person markup escapes content and hides edit without an editor", () => {
  const header = personHeaderMarkup({ name: "<Bo>", role: "<x>", primary: true, organizationId: "c1" }, { companyName: "<Co>", canEdit: true }, context);
  assert.match(header, /&lt;Bo&gt;/);
  assert.match(header, /&lt;x&gt;/);
  assert.match(header, /data-open-company="c1"/);
  assert.match(header, /href="\/sponsors\/companies\/c1"/, "company link is a real canonical anchor");
  assert.match(header, /data-edit-person/);
  const plain = personHeaderMarkup({ name: "Bo" }, {}, context);
  assert.match(plain, /No company link/);
  assert.doesNotMatch(plain, /data-edit-person/);
  const timed = personHeaderMarkup(
    { name: "Bo", lastTouch: "2026-10-09T12:00:00.000Z", lastContactedAt: "2026-10-09T12:35:00.000Z" },
    {},
    context,
  );
  assert.match(timed, /Last touch 9 Oct/);
  assert.match(timed, /Last contacted 9 Oct.*14:35/, "full stored contact precision is shown, never truncated to day");
  const channels = personChannelsMarkup({ emails: ["<a@b>"], linkedin: "https://example.com/<x>", telegram: "@t" }, context);
  assert.match(channels, /&lt;a@b&gt;/);
  assert.match(channels, /mailto:&lt;a@b&gt;/);
  assert.doesNotMatch(channels, /<a@b>/);
  assert.match(personChannelsMarkup({}, context), /No contact channels/);
  const detail = personDetailMarkup({ name: "Bo", notes: "<n>" }, {}, context);
  assert.match(detail, /&lt;n&gt;/);
  assert.match(detail, /data-person-activity/);
});
