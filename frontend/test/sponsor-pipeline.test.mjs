import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { pipelineControlsFromFilters, renderSponsorPipelineList, renderSponsorPipelineFilters } from "../src/surfaces/finance/sponsor-pipeline.js";
import { escapeHtml } from "../src/core/html.js";

test("funnel renders compact rows grouped by commitments and opportunities, with escaped primary people and actions", () => {
  const items = [
    { id: "open", organizationName: "Synthetic <Sponsor>", stage: "open", primaryContact: { name: "Test Person", email: "test@example.test" }, nextTask: { description: "Confirm the date", date: "2026-10-20" }, amountEur: 1500 },
    { id: "agreed", organizationName: "Agreed Sponsor", stage: "agreed", primaryContact: null, replyReview: true },
  ];
  const before = structuredClone(items);
  const markup = renderSponsorPipelineList({ items, escapeHtml, humanSponsorDate: (value) => value, ownerName: () => "Synthetic owner" });
  assert.match(markup, /Active commitments/);
  assert.match(markup, /Opportunities & history/);
  assert.match(markup, /Synthetic &lt;Sponsor&gt;/);
  assert.match(markup, /Test Person · test@example.test/);
  assert.match(markup, /Confirm the date/);
  assert.match(markup, /Review newer inbound/);
  assert.match(markup, /data-open-deal="agreed"/);
  assert.doesNotMatch(markup, /crm-pipeline-card/);
  assert.deepEqual(items, before);
});

test("funnel totals are server-wide rather than page counts and include closed/lost", () => {
  const markup = renderSponsorPipelineFilters({ counts: { open: 1000, agreed: 3, lost: 5 }, selected: "agreed", escapeHtml });
  assert.match(markup, /Opportunities <strong>1000/);
  assert.match(markup, /Lost <strong>5/);
  assert.match(markup, /data-pipeline-status="agreed" aria-pressed="true"/);
});

test("chips show the deals the current view lists, and say when it hides some", async () => {
  const { pipelineChipCount, pipelineMatchSummary } = await import("../src/surfaces/finance/sponsor-pipeline.js");
  const counts = { invoiced: 18, agreed: 2 }, viewCounts = { invoiced: 5, agreed: 2 };
  assert.equal(pipelineChipCount(counts, viewCounts, "invoiced"), "5 of 18");
  assert.equal(pipelineChipCount(counts, viewCounts, "agreed"), "2");
  assert.equal(pipelineChipCount(counts, undefined, "invoiced"), "18");
  assert.match(renderSponsorPipelineFilters({ counts, viewCounts, selected: "", escapeHtml }), /Invoiced <strong>5 of 18/);
  assert.equal(pipelineMatchSummary({ total: 6, totalDeals: 78 }), "6 matching deals · 78 deals in total");
  assert.equal(pipelineMatchSummary({ total: 1, totalDeals: 1 }), "1 matching deal");
});

test("Sponsors creates ride on their collections, never the page header", async () => {
  const { sponsorSurfaceMarkup } = await import("../src/surfaces/finance/sponsor-layout.js");
  const markup = sponsorSurfaceMarkup((value) => value);
  const pageHeader = markup.slice(0, markup.indexOf("</header>"));
  assert.match(pageHeader, /dk-page-header/);
  assert.doesNotMatch(pageHeader, /<button/);
  // Add deal follows the Pipeline list title; Refresh suggestions trails.
  assert.match(markup, /crm-list-head">[\s\S]*?data-crm-list-heading>Pipeline<\/h2>\s*<button[^>]*data-dk-create[^>]*data-add-deal/);
  assert.match(markup, /dk-collection-header__trail">[\s\S]*?data-booking-count[\s\S]*?data-evaluate-communications\s+aria-label="Refresh suggestions"/);
  // Stage totals and scope note are grouped in one summary; search & primary controls sit in the toolbar.
  assert.match(markup, /data-crm-pipeline-summary[\s\S]*?data-crm-pipeline/);
  assert.match(markup, /crm-pipeline-toolbar[\s\S]*?data-crm-search[\s\S]*?data-pipeline-view[\s\S]*?crm-filter-disclosure[\s\S]*?data-crm-status/);
  // Add company follows the Companies title.
  assert.match(markup, /Companies<\/h3>\s*<button[^>]*data-dk-create[^>]*data-add-org/);
});

test("sponsor owner options use the directory, preserve selected owners and escape labels", async () => {
  const { sponsorOwnerOptions } = await import("../src/surfaces/finance/sponsor-deal-form.js");
  const members = [
    { id: "synthetic-operator", name: "New <Operator>", active: true },
    { id: "inactive", name: "Former Operator", active: false },
  ];
  const options = sponsorOwnerOptions(members, "synthetic-operator", escapeHtml);
  assert.match(options, /value="synthetic-operator" selected/);
  assert.match(options, /New &lt;Operator&gt;/);
  assert.doesNotMatch(options, /Former Operator|Grace/);
  assert.match(sponsorOwnerOptions(members, "inactive", escapeHtml), /value="inactive" selected disabled/);
  assert.match(sponsorOwnerOptions(members, "deleted", escapeHtml), /value="deleted" selected disabled>Unavailable assignee/);
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

test('newer inbound stays the visible attention reason while a task is deferred', () => {
  const markup = renderSponsorPipelineList({
    items: [{ id: 'deal', organizationName: 'Synthetic', stage: 'agreed', replyReview: true, inboundAt: '2026-10-17',
      nextTask: { id: 'task', description: 'Wait for material', deferred: true, date: '2026-11-01' } }],
    escapeHtml, humanSponsorDate: (value) => value, ownerName: () => 'Owner',
  });
  assert.match(markup, /Review newer inbound \(inferred\)/);
  assert.match(markup, /Inbound 2026-10-17/);
  assert.match(markup, /Deferred task: Wait for material/);
  const noInbound = renderSponsorPipelineList({ items: [{ id: 'deal', organizationName: 'Synthetic', stage: 'agreed',
    nextTask: { id: 'task', description: 'Wait for material', deferred: true } }],
    escapeHtml, humanSponsorDate: (value) => value, ownerName: () => 'Owner' });
  assert.match(noInbound, /Deferred: Wait for material/);
  assert.match(noInbound, /data-pipeline-task="task"/);
});

test("saved-view sorts map onto pipeline controls without changing the list endpoint vocabulary", () => {
  assert.deepEqual(
    pipelineControlsFromFilters({ view: "closed", stage: "lost", search: "acme", owner: "op-1" }, "recent"),
    { view: "closed", stage: "lost", search: "acme", owner: "op-1", sort: "recent",
      nextActionFrom: "", nextActionBefore: "" },
  );
  assert.deepEqual(pipelineControlsFromFilters({}, "next-action"), {
    view: "actionable", stage: "", search: "", owner: "", sort: "next-action",
    nextActionFrom: "", nextActionBefore: "",
  });
  const scoped = pipelineControlsFromFilters({ organizationId: "org-1" }, "next-action");
  assert.equal(scoped.organizationId, "org-1");
  assert.deepEqual(
    pipelineControlsFromFilters({ view: "overdue", nextActionFrom: "2026-10-01", nextActionBefore: "2026-10-17" }, "next-action"),
    { view: "overdue", stage: "", search: "", owner: "", sort: "next-action",
      nextActionFrom: "2026-10-01", nextActionBefore: "2026-10-17" },
  );
});

test("narrow CRM tabs keep the folded alerts bar full width instead of shrinking to its label", () => {
  const css = readFileSync(new URL("../src/styles/responsive.css", import.meta.url), "utf8");
  const rule = css.match(/\.sponsor-crm-surface > \.crm-alerts \{([^}]*)\}/);
  assert.ok(rule, "responsive.css must style the direct .crm-alerts child of the CRM surface");
  assert.match(rule[1], /flex:\s*1 1 100%/);
  assert.match(rule[1], /min-width:\s*0/);
});

test("narrow Pipeline controls stack the Show and Sort labels so values clear the chevron", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles/finance.css", import.meta.url), "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 600px) {\n  .crm-list-head"));
  assert.match(narrow.slice(0, 2000), /\.crm-funnel-controls label:has\(select\) \{ flex-direction: column;/);
});
