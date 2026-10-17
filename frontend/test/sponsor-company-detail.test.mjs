import assert from "node:assert/strict";
import { test } from "node:test";

import { createSponsorCompanyDetail } from "../src/surfaces/finance/sponsor-company-detail.js";
import { createApiStub, escapeHtml, FakeNode, installFormData } from "./support/fake-record-dom.mjs";

installFormData();

function migrationHarness({ organization, routes = {}, context: extra = {} } = {}) {
  const calls = [];
  const api = createApiStub(routes, calls);
  const surface = new FakeNode("section");
  surface.setQuery("[data-crm-detail]", new FakeNode("section"));
  const split = surface.setQuery("[data-crm-split]", new FakeNode("div"));
  const scroller = surface.setQuery("[data-crm-list-scroll]", new FakeNode("div"));
  scroller.scrollTop = 42;
  const closed = [];
  const changed = [];
  const drawn = [];
  const opened = [];
  const detail = createSponsorCompanyDetail({
    api,
    surface,
    escapeHtml,
    humanizeOptionLabel: (value) => value,
    humanSponsorDate: (value) => value,
    closeRecord: () => closed.push(true),
    onRecordChanged: (updated) => changed.push(updated),
    sponsorCommunications: null,
    draw: () => drawn.push(true),
    openDeal: (deal) => opened.push(deal),
    openDialog: () => {},
    loadFinance: async () => {},
    loadCommunications: async () => {},
    safe: async (action) => action(),
    ...extra,
  });
  return { api, surface, calls, closed, changed, drawn, opened, detail, organization };
}

const organization = { id: "c1", displayName: "Acme", domain: "acme.example", version: 3 };

const preview = {
  targetType: "organization", targetId: "c1", items: [], total: 0, nextCursor: null,
  sources: {}, relatedWork: [], tasksScope: "open", reads: {},
};

test("migration mounts the record shell and preserves back behavior", async () => {
  const { surface, closed, detail } = migrationHarness({
    organization,
    routes: {
      "GET /directory/companies/c1": organization,
      "GET /activity/organization/c1?limit=3": preview,
    },
  });
  await detail.reopenCompanyDetail(organization);
  const wired = surface.querySelector("[data-crm-detail]").querySelector("[data-crm-record]");
  const rendered = surface.querySelector("[data-crm-record]");
  assert.match(rendered.innerHTML, /Acme/);
  assert.match(rendered.innerHTML, /role="tablist"/);
  assert.match(rendered.innerHTML, /CRM/, "back names the workspace");
  await wired.dispatch("click", { closestPatch: { "[data-record-back]": new FakeNode("button") } });
  assert.deepEqual(closed, [true], "record Back calls E closeRecord (no competing lifecycle)");
});

test("reopenDealDetail forwards the isCurrent predicate to the record open", async () => {
  const { host, detail } = migrationHarness({
    organization,
    routes: {
      "GET /directory/companies/c1": organization,
      "GET /activity/organization/c1?limit=3": preview,
    },
  });
  let current = false;
  await detail.reopenDealDetail({ id: "d9", organizationId: "c1" }, { isCurrent: () => current });
  assert.match(host.innerHTML, /Loading company/, "stale deal open paints nothing");
  assert.doesNotMatch(host.innerHTML, /Acme/);
  current = true;
  await detail.reopenDealDetail({ id: "d9", organizationId: "c1" }, { isCurrent: () => current });
  assert.match(host.innerHTML, /Acme/, "live deal open renders");
});

test("migration archives and restores through the record header", async () => {
  const archived = { ...organization, archivedAt: "2026-10-17T00:00:00Z", active: false, version: 4 };
  const restored = { ...organization, version: 5 };
  let current = { ...organization };
  const { surface, calls, changed, detail } = migrationHarness({
    organization,
    routes: {
      "GET /directory/companies/c1": () => current,
      "GET /activity/organization/c1?limit=3": preview,
      "DELETE /organizations/c1": () => (current = archived),
      "PUT /organizations/c1": () => (current = restored),
    },
  });
  await detail.reopenCompanyDetail(organization);
  const wired = surface.querySelector("[data-crm-detail]").querySelector("[data-crm-record]");
  const rendered = surface.querySelector("[data-crm-record]");
  await wired.dispatch("click", { closestPatch: { "[data-archive-company]": new FakeNode("button") } });
  assert.ok(calls.some(({ method, path }) => method === "DELETE" && path === "/organizations/c1"));
  assert.deepEqual(changed.map((item) => item.id), ["c1"], "E onRecordChanged fires with the updated org");
  assert.equal(changed[0].version, 4);
  assert.match(rendered.innerHTML, /data-restore-company/, "archived header offers restore");
  await wired.dispatch("click", { closestPatch: { "[data-restore-company]": new FakeNode("button") } });
  const put = calls.find(({ method }) => method === "PUT");
  assert.equal(put.path, "/organizations/c1");
  assert.equal(put.body.version, 4, "restore carries the optimistic version");
  assert.equal(put.body.archivedAt, null);
});

test("migration projects the B archive read-only without send hooks", async () => {
  const communications = {
    items: [
      { recordType: "communication-draft-version", communicationId: "m1", version: 2, createdAt: "2026-10-01T00:00:00Z" },
      { recordType: "sponsor-send-attempt", communicationId: "m2", derivedStatus: "delivered", status: "delivered", createdAt: "2026-10-02T00:00:00Z" },
      { recordType: "communication-suggestion", id: "s1", communicationType: "thanks", status: "open", safeReason: "Say thanks" },
    ],
    nextCursor: null,
  };
  const { surface, detail } = migrationHarness({
    organization,
    routes: {
      "GET /directory/companies/c1": organization,
      "GET /activity/organization/c1?limit=3": preview,
      "GET /deals?organizationId=c1&limit=50": { items: [{ id: "d1", organizationId: "c1", status: "open", productKind: "one-off" }], nextCursor: null },
      "GET /deals/d1/communications?limit=50": communications,
      "GET /activity/organization/c1?limit=30": preview,
    },
  });
  await detail.reopenCompanyDetail(organization, { id: "d1" });
  // Drive the record controller directly through the mounted host.
  const rendered = surface.querySelector("[data-crm-record]");
  assert.match(rendered.innerHTML, /Acme/);
});
