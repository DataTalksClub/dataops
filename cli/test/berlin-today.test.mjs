import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { berlinToday } from "../src/format.mjs";
import { generate as generateRecurring } from "../src/commands/recurring.mjs";
import { recordThankYou } from "../src/commands/sponsors.mjs";
import { sync as syncNewsletter } from "../src/commands/newsletter.mjs";

describe("CLI Berlin today at 23:30 UTC", () => {
  it("computes 2026-01-16 in Europe/Berlin at 2026-01-15T23:30:00Z", () => {
    delete process.env.DATAOPS_TODAY;
    assert.equal(berlinToday(new Date("2026-01-15T23:30:00Z")), "2026-01-16");
  });

  it("uses Berlin day (2026-01-16, not UTC 2026-01-15) in recurring.mjs, sponsors.mjs and newsletter.mjs at 23:30 UTC", async (t) => {
    delete process.env.DATAOPS_TODAY;
    process.env.DATAOPS_TOKEN = "tok-test";
    process.env.DATAOPS_URL = "https://ops.example.test";
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-15T23:30:00Z") });

    const requests = [];
    const origFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/work/, "");
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method: init.method || "GET", path, query: Object.fromEntries(u.searchParams), body });
      if (path === "/api/recurring/generate") {
        return new Response(JSON.stringify({ generated: [], skipped: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/sponsor-crm/deals/deal-1") {
        return new Response(JSON.stringify({ id: "deal-1", title: "Deal 1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/sponsor-crm/deals/deal-1/finance") {
        return new Response(
          JSON.stringify({
            finance: { evidence: [] },
            lastPaymentOn: "2026-01-10",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/api/newsletter-issues") {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/sponsor-crm/organizations") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const baseArgs = { url: "https://ops.example.test", token: "tok-test", json: true, _: [] };
    const io = { print: () => {}, error: () => {} };

    await generateRecurring({ ...baseArgs }, io);
    const recurringCall = requests.find((r) => r.path === "/api/recurring/generate");
    assert.equal(recurringCall.body.startDate, "2026-01-16");
    assert.equal(recurringCall.body.endDate, "2026-01-16");

    const tyRes = await recordThankYou({ ...baseArgs, _: ["deal-1"], ref: "msg-123" }, io);
    assert.equal(tyRes.evidenceEntry.on, "2026-01-16");

    const dir = mkdtempSync(join(tmpdir(), "nl-sync-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const csvPath = join(dir, "newsletter.csv");
    // An issue on 2026-01-15 is already in the past at 23:30 UTC (Berlin day 2026-01-16), so status is 'sent'.
    writeFileSync(
      csvPath,
      "ID,Promo Type,Date,Sponsor\nNL-100,Primary Slot,2026-01-15,Acme\n",
      "utf8",
    );
    const syncRes = await syncNewsletter({ ...baseArgs, _: [csvPath] }, io);
    assert.equal(syncRes.plan.creates[0].body.status, "sent");
  });
});
