import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolateConfig, fakePortal } from "./helpers.mjs";

isolateConfig();
const campaigns = await import("../src/commands/campaigns.mjs");
const io = { print() {} };

test("campaigns CLI imports CSV for template or cohort Card, lists with filters, and updates with version checks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dataops-campaigns-test-"));
  const csvPath = path.join(dir, "02-campaign-calendar.csv");
  writeFileSync(
    csvPath,
    [
      "Date,Relative week,Relative date,Phase,Preferred day,Platform,Post type,Typefully examples,Working title / angle,Audience,Primary CTA,Phrases,Assets needed,Why this belongs in this phase,Status",
      "TBD,T-12 weeks,T-84 days,Foundation,Monday,Primary social,Problem framing,,Why {{ course_topic }} matters now,Potential learners,Join waitlist,,Positioning,Relevance.,Planned",
    ].join("\n"),
    "utf8",
  );

  try {
    const calls = fakePortal({
      "POST /api/campaign-calendar/import": ({ body }) => ({
        cardId: body.cardId,
        importedCount: 1,
        replacedCount: 0,
        rows: [{ id: "row-1", cardId: body.cardId, offset: "T-84 days", channel: "Primary social", format: "Problem framing", status: "Planned", version: 1 }],
      }),
      "GET /api/campaign-calendar": ({ query }) => ({
        cardId: query.cardId,
        rows: [{ id: "row-1", cardId: query.cardId, offset: "T-84 days", channel: "Primary social", format: "Problem framing", status: query.status || "Planned", version: 1 }],
      }),
      "GET /api/campaign-calendar/row-1": {
        row: { id: "row-1", cardId: "card-123", offset: "T-84 days", channel: "Primary social", format: "Problem framing", status: "Planned", version: 2 },
      },
      "PUT /api/campaign-calendar/row-1": ({ body }) => ({
        row: { id: "row-1", cardId: "card-123", ...body, version: body.version + 1 },
      }),
      "DELETE /api/campaign-calendar/row-1": { deleted: true },
    });

    const imported = await campaigns.importCsv(
      { _: [], card: "card-123", file: csvPath, replace: true, owner: "Orin", json: true },
      io,
    );
    assert.equal(imported.importedCount, 1);
    assert.equal(calls[0].body.cardId, "card-123");
    assert.equal(calls[0].body.replace, true);
    assert.equal(calls[0].body.owner, "Orin");
    assert.match(calls[0].body.csv, /T-84 days/);

    const listed = await campaigns.list(
      { _: [], card: "card-123", status: "Planned", channel: "Primary social", json: true },
      io,
    );
    assert.equal(listed.rows.length, 1);
    assert.equal(calls[1].query.cardId, "card-123");
    assert.equal(calls[1].query.status, "Planned");
    assert.equal(calls[1].query.channel, "Primary social");

    const updated = await campaigns.update(
      { _: ["row-1"], status: "Published", owner: "Alexey", json: true },
      io,
    );
    assert.equal(updated.row.status, "Published");
    assert.equal(updated.row.owner, "Alexey");
    assert.equal(updated.row.version, 3);

    await campaigns.remove({ _: ["row-1"], version: "3", json: true }, io);
    assert.equal(calls.at(-1).query.version, "3");

    await assert.rejects(
      () => campaigns.update({ _: ["row-1"], json: true }, io),
      /Provide at least one field/,
    );
    await assert.rejects(
      () => campaigns.list({ _: [], json: true }, io),
      /--card ID \(or --template\) is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
