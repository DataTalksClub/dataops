import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATAOPS_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "dataops-cli-sync-"));
process.env.DATAOPS_URL = "https://portal.test";
process.env.DATAOPS_TOKEN = "dops_test";

const { run } = await import("../src/cli.mjs");
const { EXIT } = await import("../src/errors.mjs");
const { issueSourceKey } = await import("../src/newsletterSheet.mjs");
const { captureIo, fakePortal } = await import("./helpers.mjs");

const csvFile = (lines) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "newsletter-sync-")), "newsletter.csv");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

const banner = "DataTalks.Club newsletter schedule (banner row above the header)";
const header = "Date,Sponsor,Promo Type,Doc,ID";
const organizations = [
  { id: "org-nvidia", displayName: "NVIDIA" },
  { id: "org-nvidia-2", displayName: "Nvidia" },
];
const linkedIssue = {
  id: "i-300",
  label: "Weekly #300",
  version: 3,
  kind: "weekly",
  issueNumber: 300,
  publicationDate: "2026-09-14",
  status: "sent",
  sourceKey: issueSourceKey("NL-300"),
  slots: { primary: { sheetId: "NL-300", sponsor: "NVIDIA", organizationId: "org-nvidia" }, secondary: {} },
};
const syncRoutes = {
  "GET /api/newsletter-issues": { items: [linkedIssue] },
  "GET /api/sponsor-crm/organizations": { items: organizations },
};

describe("newsletter sync", () => {
  test("--sheet is retired with a usage error and sends nothing", async () => {
    const io = captureIo();
    const calls = fakePortal({});
    const exit = await run(["newsletter", "sync", "--sheet", "sheet-id", "--json"], io);
    assert.equal(exit, EXIT.usage);
    const message = io.errors.join("\n");
    assert.match(message, /--sheet is retired/);
    assert.match(message, /DataOps is the source of truth/);
    assert.equal(calls.length, 0);
  });

  test("dry run over a banner-row CSV keeps an ambiguous company link and reports it", async () => {
    const io = captureIo();
    const calls = fakePortal(syncRoutes);
    const file = csvFile([banner, header, "14 Sep 26,Nvidia,Primary Slot,,NL-300"]);
    const exit = await run(["newsletter", "sync", file], io);
    assert.equal(exit, EXIT.ok);
    const text = io.text();
    assert.match(text, /plain CSV cannot carry cell hyperlinks/);
    assert.match(text, /matches 2 companies \(org-nvidia, org-nvidia-2\); keeping the existing company link/);
    assert.match(text, /unchanged 1, differences 1, skippedRows 0, sponsorsLinked 0/);
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  });

  test("a CSV whose link columns show full URLs plans the document links", async () => {
    const io = captureIo();
    fakePortal({
      "GET /api/newsletter-issues": { items: [] },
      "GET /api/sponsor-crm/organizations": { items: organizations },
    });
    const file = csvFile([header, "2 Mar 26,Acme,Stand-Alone Newsletter,https://docs.example.com/acme,NL-2026-03-02-standalone"]);
    const exit = await run(["newsletter", "sync", file, "--json"], io);
    assert.equal(exit, EXIT.ok);
    const result = io.json();
    assert.equal(result.plan.creates.length, 1);
    assert.equal(result.plan.creates[0].body.slots.primary.documentUrl, "https://docs.example.com/acme");
  });
});
