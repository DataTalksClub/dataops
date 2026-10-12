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
