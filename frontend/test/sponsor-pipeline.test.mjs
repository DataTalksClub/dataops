import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSponsorPipelineDeals, renderSponsorPipelineBoard, renderSponsorPipelineFilters, sponsorPipelineStage } from "../src/surfaces/finance/sponsor-pipeline.js";

const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const context = { escapeHtml, organizationName: () => "Synthetic <Sponsor>", humanSponsorDate: (value) => value };

test("pipeline derives progress with delivered precedence and excludes lost deals", () => {
  assert.equal(sponsorPipelineStage({ status: "open", money: "none" }), "open");
  assert.equal(sponsorPipelineStage({ status: "agreed", money: "none" }), "agreed");
  for (const money of ["invoiced", "partial", "paid", "overdue"]) {
    assert.equal(sponsorPipelineStage({ status: "agreed", money }), "invoiced");
  }
  assert.equal(sponsorPipelineStage({ status: "agreed", money: "paid", fulfillment: "delivered" }), "delivered");
  assert.equal(sponsorPipelineStage({ status: "lost", money: "paid", fulfillment: "delivered" }), null);
});

test("board and filters agree on derived stages and keep read actions bound to deal IDs", () => {
  const deals = [
    { id: "open", organizationId: "org", status: "open", productKind: "one-off", amountEur: 1500, nextAction: { type: "follow_up", due: "2026-10-20" } },
    { id: "bill", organizationId: "org", status: "agreed", money: "invoiced", productKind: "package", deliverables: [{ plannedPublicationDate: "2026-10-22" }] },
    { id: "done", organizationId: "org", status: "agreed", money: "paid", fulfillment: "delivered" },
    { id: "lost", organizationId: "org", status: "lost" },
  ];
  const snapshot = structuredClone(deals);
  const grouped = groupSponsorPipelineDeals(deals);
  assert.deepEqual(Object.fromEntries(Object.entries(grouped).map(([key, values]) => [key, values.map(({ id }) => id)])), {
    open: ["open"], agreed: [], invoiced: ["bill"], delivered: ["done"],
  });
  const board = renderSponsorPipelineBoard({ deals, ...context });
  assert.equal((board.match(/data-pipeline-stage=/g) || []).length, 4);
  assert.match(board, /Synthetic &lt;Sponsor>/);
  assert.match(board, /€1,500/);
  assert.match(board, /Follow up · 2026-10-20/);
  assert.match(board, /Publishes 2026-10-22/);
  assert.match(board, /data-open-deal="bill"/);
  assert.doesNotMatch(board, /data-open-deal="lost"/);
  assert.match(board, /No deals in this stage/);
  const filters = renderSponsorPipelineFilters({ deals, selected: "invoiced", escapeHtml });
  assert.match(filters, /All deals <strong>3<\/strong>/);
  assert.match(filters, /data-pipeline-status="invoiced"\s+aria-pressed="true"/);
  assert.deepEqual(deals, snapshot, "rendering never mutates deal status or records");
});

test("Sponsors creates ride on their collections, never the page header", async () => {
  const { sponsorSurfaceMarkup } = await import("../src/surfaces/finance/sponsor-layout.js");
  const markup = sponsorSurfaceMarkup((value) => value);
  const pageHeader = markup.slice(0, markup.indexOf("</header>"));
  assert.match(pageHeader, /dk-page-header/);
  assert.doesNotMatch(pageHeader, /<button/);
  // Add deal follows the Queue/Pipeline list title; Refresh suggestions trails.
  assert.match(markup, /crm-list-head">[\s\S]*?data-crm-list-heading>Pipeline<\/h2>\s*<button[^>]*data-dk-create[^>]*data-add-deal/);
  assert.match(markup, /dk-collection-header__trail">[\s\S]*?data-booking-count[\s\S]*?data-evaluate-communications\s+aria-label="Refresh suggestions"/);
  // Add sponsor follows the Companies title.
  assert.match(markup, /Companies<\/h3>\s*<button[^>]*data-dk-create[^>]*data-add-org/);
});

test("sponsor owner options use the directory, preserve selected owners and escape labels", async () => {
  const { sponsorOwnerOptions } = await import("../src/surfaces/finance/sponsor-deal-form.js");
  const escapeOwner = (value) => escapeHtml(value).replaceAll(">", "&gt;");
  const members = [
    { id: "synthetic-operator", name: "New <Operator>", active: true },
    { id: "inactive", name: "Former Operator", active: false },
  ];
  const options = sponsorOwnerOptions(members, "synthetic-operator", escapeOwner);
  assert.match(options, /value="synthetic-operator" selected/);
  assert.match(options, /New &lt;Operator&gt;/);
  assert.doesNotMatch(options, /Former Operator|Grace/);
  assert.match(sponsorOwnerOptions(members, "inactive", escapeOwner), /value="inactive" selected disabled/);
  assert.match(sponsorOwnerOptions(members, "deleted", escapeOwner), /value="deleted" selected disabled>Unavailable assignee/);
  assert.equal(members.length, 2, "rendering leaves the directory unchanged");
});

test("sponsor forms obtain their default and explicit assignee from the safe team directory", async () => {
  const { createSponsorOwnerDirectory } = await import("../src/surfaces/finance/sponsor-deal-form.js");
  const urls = [];
  const directory = createSponsorOwnerDirectory({
    request: async (url) => {
      urls.push(url);
      return { defaultAssigneeId: "replacement", teamMembers: [
        { id: "replacement", name: "Replacement", active: true },
        { id: "explicit", name: "Explicit", active: true },
      ] };
    },
    workApiUrl: (path) => path,
    escapeHtml,
  });
  await directory.load();
  const select = { innerHTML: "" };
  directory.fill(select);
  assert.match(select.innerHTML, /value="replacement" selected/);
  directory.fill(select, "explicit");
  assert.match(select.innerHTML, /value="explicit" selected/);
  assert.deepEqual(urls, ["/api/team-members"]);
});
