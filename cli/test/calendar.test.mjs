import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const configDir = mkdtempSync(path.join(tmpdir(), "dataops-cli-cal-"));
process.env.DATAOPS_CONFIG_DIR = configDir;

const { run } = await import("../src/cli.mjs");
const { saveProfile } = await import("../src/config.mjs");

saveProfile("https://portal.test", { token: "dops_test_token", tokenId: "id-1" });

function captureIo() {
  const out = [];
  const errors = [];
  return {
    out,
    errors,
    log: (line) => out.push(String(line)),
    error: (line) => errors.push(String(line)),
    text: () => out.join("\n"),
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const result = await handler(url, options);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

describe("Calendar CLI commands", () => {
  test("calendar list fetches events, holidays, and alerts", async () => {
    const io = captureIo();
    const requests = [];

    globalThis.fetch = async (url) => {
      const u = String(url);
      requests.push(u);
      assert.match(u, /\/api\/calendar-items\?from=2026-08-01&to=2026-08-31/);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "card:card-1", kind: "webinar", kindLabel: "Webinar", title: "Community webinar · Ada Example",
              date: "2026-08-13", status: "announced", entity: { type: "card", id: "card-1" }, href: "/cards?cardId=card-1",
            },
            {
              id: "podcast-recording:ep-1", kind: "podcast-recording", kindLabel: "Podcast recording", title: "Live podcast · Grace Sample",
              date: "2026-08-15", status: "booked", entity: { type: "podcast-episode", id: "ep-1" }, href: "/podcast?episodeId=ep-1",
            },
          ],
          holidays: [
            {
              name: "Summer Break",
              kind: "berlin-school-holiday",
              startDate: "2026-08-01",
              endDate: "2026-08-20",
            },
          ],
          alerts: [
            {
              severity: "warning",
              reasonCode: "school-holiday-overlap",
              fingerprint: "fp-summer-123",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(
      ["calendar", "list", "--from", "2026-08-01", "--to", "2026-08-31"],
      io,
    );
    assert.equal(code, 0);
    assert.match(io.text(), /2026-08-13\s+\[Webinar\]\s+\[announced\]\s+Community webinar · Ada Example  \(card card-1\)/);
    assert.match(io.text(), /Live podcast · Grace Sample  \(podcast-episode ep-1\)/);
    assert.match(io.text(), /Summer Break/);
    assert.match(io.text(), /Active Alerts/);
    assert.match(io.text(), /fp-summer-123/);
  });

  test("calendar list --json returns raw API payload", async () => {
    const io = captureIo();
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          items: [
            { id: "card:c1", kind: "webinar", kindLabel: "Webinar", title: "Webinar", date: "2026-08-03" },
            { id: "podcast-release:e1", kind: "podcast-release", kindLabel: "Podcast release", title: "Release", date: "2026-08-04" },
          ],
          holidays: [],
          alerts: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(
      ["calendar", "list", "--from", "2026-08-01", "--to", "2026-08-05", "--type", "webinar", "--json"],
      io,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(io.text());
    assert.deepEqual(parsed.items.map((item) => item.title), ["Webinar"]);
  });

  test("calendar has no create, edit or delete: events live on their Cards and episodes", async () => {
    for (const subcommand of ["create", "edit", "delete", "detail"]) {
      const io = captureIo();
      globalThis.fetch = async () => { throw new Error("no request expected"); };
      const code = await run(["calendar", subcommand, "x"], io);
      assert.notEqual(code, 0, subcommand);
    }
  });

  test("calendar day provides slot availability and full day schedule", async () => {
    const io = captureIo();

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/overlays")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                provider: "owner-calendar",
                label: "09:30–10:30 Team sync",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "outside",
              },
              {
                provider: "owner-calendar",
                label: "12:30–13:30 Podcast with Guest",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "midday",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "card:card-webinar", kind: "webinar", kindLabel: "Webinar", title: "MLOps live demonstration",
              date: "2026-08-13", status: "announced", entity: { type: "card", id: "card-webinar" }, href: "/cards?cardId=card-webinar",
            },
          ],
          holidays: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(["calendar", "day", "2026-08-13"], io);
    assert.equal(code, 0);

    const text = io.text();
    // Midday is busy because of "Podcast with Guest"
    assert.match(text, /Midday Event Slot \(11:30–14:00[^)]*\):\s+BUSY/);
    assert.match(text, /Podcast with Guest/);
    // Evening is available because there are no evening blockers
    assert.match(text, /Evening Event Slot \(16:30–18:30, start 17:00\):\s+AVAILABLE/);
    // Full schedule lists both overlay and activity items
    assert.match(text, /Team sync/);
    assert.match(text, /MLOps live demonstration/);
  });

  test("calendar day --json returns structured slot availability payload", async () => {
    const io = captureIo();

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/overlays")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                provider: "owner-calendar",
                label: "Vacation in Italy",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "all-day",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ items: [], holidays: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(["calendar", "day", "2026-08-13", "--json"], io);
    assert.equal(code, 0);

    const payload = JSON.parse(io.text());
    assert.equal(payload.date, "2026-08-13");
    // All-day vacation blocks both slots
    assert.equal(payload.slots.midday.available, false);
    assert.equal(payload.slots.evening.available, false);
    assert.deepEqual(payload.slots.blockers, ["Vacation in Italy"]);
  });

  test("calendar slots reports projected overlays across a date range", async () => {
    const io = captureIo();

    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/api\/calendar-items\/overlays\?from=2026-08-10&to=2026-08-14/);
      return new Response(
        JSON.stringify({
          items: [
            {
              category: "Alexey",
              label: "12:30–14:00 Available event slot",
              startDate: "2026-08-12",
              slot: "midday",
            },
            {
              category: "Alexey",
              label: "16:30–18:30 Available event slot",
              startDate: "2026-08-12",
              slot: "evening",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(
      ["calendar", "slots", "--from", "2026-08-10", "--to", "2026-08-14"],
      io,
    );
    assert.equal(code, 0);
    assert.match(io.text(), /12:30–14:00 Available event slot/);
    assert.match(io.text(), /16:30–18:30 Available event slot/);
  });

  test("calendar settings explains missing connection selection and discovery grants", async () => {
    globalThis.fetch = async () => Response.json({ settings: { connectionId: "" }, connections: [], connectionProblem: "Grant personal-scheduler the use operation in Dapier" });
    const io = captureIo();
    assert.equal(await run(["calendar", "settings"], io), 0);
    assert.match(io.text(), /none selected.*--connection/);
    assert.match(io.text(), /Grant personal-scheduler the use operation/);
  });

  test("calendar settings gets and updates overlay configuration", async () => {
    const ioGet = captureIo();
    let savedSettings = null;

    globalThis.fetch = async (url, options = {}) => {
      if (options.method === "PUT") {
        savedSettings = JSON.parse(options.body);
        return new Response(
          JSON.stringify({ settings: savedSettings }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          settings: {
            connectionId: "google-calendar",
            filterNonSlotHours: true,
            filterDtcPlaceholders: true,
            filterTransparent: true,
            filterLunch: true,
            filterRoutines: true,
            filterFitness: false,
            filterFocus: false,
            filterBusy: true,
            customKeywords: ["dentist"],
          },
          connections: [
            { id: "google-calendar", label: "Work Calendar" },
            { id: "personal-cal", label: "Personal Calendar" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Test GET settings
    const codeGet = await run(["calendar", "settings"], ioGet);
    assert.equal(codeGet, 0);
    assert.match(ioGet.text(), /Connection ID:\s+google-calendar/);
    assert.match(ioGet.text(), /Filter Busy:\s+true/);
    assert.match(ioGet.text(), /Available Dapier Calendar Connections/);

    // Test PUT settings update
    const ioPut = captureIo();
    const codePut = await run(
      [
        "calendar",
        "settings",
        "--connection",
        "personal-cal",
        "--filter-busy",
        "false",
        "--custom-keywords",
        "haircut,dentist",
      ],
      ioPut,
    );
    assert.equal(codePut, 0);
    assert.equal(savedSettings.connectionId, "personal-cal");
    assert.equal(savedSettings.filterBusy, false);
    assert.deepEqual(savedSettings.customKeywords, ["haircut", "dentist"]);
  });

  test("calendar dismiss-alert and sync-holidays post to their endpoints", async () => {
    const ioAlert = captureIo();
    const requests = [];

    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      if (String(url).includes("/alerts/")) {
        return new Response(JSON.stringify({ dismissed: true }), { status: 200 });
      }
      if (String(url).includes("/holidays/sync")) {
        return new Response(
          JSON.stringify({ count: 42, freshAsOf: "2026-08-01" }),
          { status: 200 },
        );
      }
      throw new Error("Unknown URL");
    };

    const code1 = await run(["calendar", "dismiss-alert", "alert-fp-123"], ioAlert);
    assert.equal(code1, 0);
    assert.match(ioAlert.text(), /Dismissed calendar alert alert-fp-123/);
    assert.equal(
      requests[0].url,
      "https://portal.test/work/api/calendar-items/alerts/alert-fp-123/dismiss",
    );

    const ioSync = captureIo();
    const code2 = await run(["calendar", "sync-holidays"], ioSync);
    assert.equal(code2, 0);
    assert.match(ioSync.text(), /Synced holidays: 42/);
    assert.equal(
      requests[1].url,
      "https://portal.test/work/api/calendar-items/holidays/sync",
    );
  });

  test("calendar slots defaults to duration 60 and window any", async () => {
    const io = captureIo();
    let seenUrl = "";
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ items: [], sources: {} }), { status: 200 });
    };
    const code = await run(["calendar", "slots", "--from", "2026-08-10", "--to", "2026-08-14"], io);
    assert.equal(code, 0);
    assert.match(seenUrl, /duration=60/);
    assert.match(seenUrl, /window=any/);
    assert.match(io.text(), /\[60 min, any\]/);
  });

  test("calendar slots workshop case wires duration 90 and window evening", async () => {
    const io = captureIo();
    let seenUrl = "";
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          items: [
            { provider: "owner-calendar", category: "Available slot", label: "17:00 Available", startDate: "2026-10-13", slot: "evening", isAvailableSlot: true },
          ],
          sources: {},
        }),
        { status: 200 },
      );
    };
    const code = await run(
      ["calendar", "slots", "--from", "2026-10-13", "--to", "2026-10-13", "--duration", "90", "--window", "evening"],
      io,
    );
    assert.equal(code, 0);
    assert.match(seenUrl, /duration=90/);
    assert.match(seenUrl, /window=evening/);
    assert.match(io.text(), /evening AVAILABLE/);
  });

  test("calendar day splits evening anchors: 60 min starts 17:00, 90 min workshop starts 16:30", async () => {
    // 16:30-17:00 blocks the 90-min workshop block 16:30-18:00 but leaves the 60-min 17:00-18:00 block free.
    const mkFetch = () => async (url) => {
      if (String(url).includes("/overlays")) {
        return new Response(
          JSON.stringify({
            items: [
              { provider: "owner-calendar", label: "16:30–17:00 Early call", startDate: "2026-08-13", endDate: "2026-08-13", slot: "evening" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [], holidays: [] }), { status: 200 });
    };
    const io60 = captureIo();
    globalThis.fetch = mkFetch();
    assert.equal(await run(["calendar", "day", "2026-08-13", "--duration", "60", "--window", "evening"], io60), 0);
    assert.match(io60.text(), /Evening Event Slot \(16:30–18:30, start 17:00\):\s+AVAILABLE/);

    const io90 = captureIo();
    globalThis.fetch = mkFetch();
    assert.equal(await run(["calendar", "day", "2026-08-13", "--duration", "90", "--window", "evening"], io90), 0);
    assert.match(io90.text(), /Evening Event Slot \(16:30–18:30, start 16:30\):\s+BUSY/);
  });

  test("calendar day midday window prefers 12:30 start for 60-min", async () => {
    // 13:30-14:00 is inside the midday band but outside the preferred 12:30-13:30 block.
    const mkFetch = () => async (url) => {
      if (String(url).includes("/overlays")) {
        return new Response(
          JSON.stringify({
            items: [
              { provider: "owner-calendar", label: "13:30–14:00 Wrap-up", startDate: "2026-08-13", endDate: "2026-08-13", slot: "midday" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [], holidays: [] }), { status: 200 });
    };
    const io = captureIo();
    globalThis.fetch = mkFetch();
    assert.equal(await run(["calendar", "day", "2026-08-13", "--duration", "60", "--window", "midday"], io), 0);
    assert.match(io.text(), /Midday Event Slot \(11:30–14:00, start 12:30\):\s+AVAILABLE/);
    assert.match(io.text(), /\[60 min, midday\]/);
    // Window filter hides the evening line.
    assert.doesNotMatch(io.text(), /Evening Event Slot/);
  });

  test("calendar slots and day reject invalid duration and window", async () => {
    for (const argv of [
      ["calendar", "slots", "--duration", "0"],
      ["calendar", "slots", "--duration", "abc"],
      ["calendar", "slots", "--window", "night"],
      ["calendar", "day", "2026-08-13", "--duration", "-5"],
      ["calendar", "day", "2026-08-13", "--window", "morning"],
    ]) {
      const io = captureIo();
      globalThis.fetch = async () => { throw new Error("no request expected"); };
      const code = await run(argv, io);
      assert.notEqual(code, 0, argv.join(" "));
    }
  });
});

describe("Calendar hold CLI commands", () => {
  test("calendar propose posts a tentative hold with evening/60/+7d defaults", async () => {
    const io = captureIo();
    let seen = null;
    globalThis.fetch = async (url, options = {}) => {
      seen = { url: String(url), body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          hold: {
            id: "hold_abc123", date: "2026-10-27", window: "evening", durationMinutes: 60,
            title: "GraphRAG workshop", status: "tentative", expiresAt: "2026-11-03T00:00:00.000Z",
            googleSync: { state: "deferred", reason: "dry-run" },
          },
        }),
        { status: 201 },
      );
    };
    const code = await run(["calendar", "propose", "--date", "2026-10-27", "--title", "GraphRAG workshop", "--topic", "Adopting GraphRAG in production"], io);
    assert.equal(code, 0);
    assert.match(seen.url, /\/api\/calendar-holds$/);
    assert.deepEqual(seen.body, {
      date: "2026-10-27", window: "evening", durationMinutes: 60,
      title: "GraphRAG workshop", topic: "Adopting GraphRAG in production", expiresDays: 7,
    });
    assert.match(io.text(), /Proposed hold hold_abc123/);
    assert.match(io.text(), /Google sync deferred/);
  });

  test("calendar propose wires workshop flags: 90 min evening with card", async () => {
    const io = captureIo();
    let seen = null;
    globalThis.fetch = async (url, options = {}) => {
      seen = { url: String(url), body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({ hold: { id: "hold_w9", date: "2026-10-27", window: "evening", durationMinutes: 90, title: "Workshop", status: "tentative" } }),
        { status: 201 },
      );
    };
    const code = await run(
      ["calendar", "propose", "--date", "2026-10-27", "--window", "evening", "--duration", "90", "--title", "Workshop", "--topic", "Workshop topic", "--guest-ref", "guest@example.com", "--document-url", "https://example.com/outline", "--card", "card-1"],
      io,
    );
    assert.equal(code, 0);
    assert.equal(seen.body.durationMinutes, 90);
    assert.equal(seen.body.window, "evening");
    assert.equal(seen.body.cardId, "card-1");
    assert.equal(seen.body.guestRef, "guest@example.com");
    assert.equal(seen.body.documentUrl, "https://example.com/outline");
  });

  test("calendar propose validates before sending", async () => {
    for (const argv of [
      ["calendar", "propose", "--title", "No date", "--topic", "T"],
      ["calendar", "propose", "--date", "2026-10-27"],
      ["calendar", "propose", "--date", "2026-10-27", "--title", "x"],
      ["calendar", "propose", "--date", "2026-10-27", "--title", "x", "--topic", "T", "--window", "any"],
      ["calendar", "propose", "--date", "2026-10-27", "--title", "x", "--topic", "T", "--duration", "0"],
    ]) {
      const io = captureIo();
      globalThis.fetch = async () => { throw new Error("no request expected"); };
      const code = await run(argv, io);
      assert.notEqual(code, 0, argv.join(" "));
    }
  });

  test("calendar confirm-hold and release-hold hit their endpoints", async () => {
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
      const u = String(url);
      if (u.endsWith("/confirm")) return new Response(JSON.stringify({ hold: { id: "hold_1", title: "T" } }), { status: 200 });
      return new Response(JSON.stringify({ hold: { id: "hold_1", title: "T" } }), { status: 200 });
    };
    assert.equal(await run(["calendar", "confirm-hold", "hold_1"], captureIo()), 0);
    assert.equal(await run(["calendar", "release-hold", "hold_1"], captureIo()), 0);
    assert.equal(requests[0].url, "https://portal.test/work/api/calendar-holds/hold_1/confirm");
    assert.equal(requests[1].url, "https://portal.test/work/api/calendar-holds/hold_1/release");
    assert.deepEqual(requests[1].body, { reason: "manual" });

    const io = captureIo();
    globalThis.fetch = async () => { throw new Error("no request expected"); };
    assert.notEqual(await run(["calendar", "release-hold", "hold_1", "--reason", "bogus"], io), 0);
    assert.notEqual(await run(["calendar", "confirm-hold"], captureIo()), 0);
  });

  test("confirm-hold passes guest details and reports a deferred invite", async () => {
    const io = captureIo();
    let body;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ hold: { title: "Guest at DataTalks.Club Podcast", googleSync: { state: "deferred", reason: "Orin connection required" } } });
    };
    assert.equal(await run(["calendar", "confirm-hold", "hold-1", "--guest-ref", "guest@example.com", "--document-url", "https://example.com/podcast"], io), 0);
    assert.deepEqual(body, { guestRef: "guest@example.com", documentUrl: "https://example.com/podcast" });
    assert.match(io.text(), /Google sync deferred: Orin connection required/);
  });

  test("calendar holds lists and filters by status", async () => {
    const io = captureIo();
    let seenUrl = "";
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({ holds: [{ id: "hold_1", date: "2026-10-27", window: "evening", durationMinutes: 60, title: "T", status: "tentative", expiresAt: "2026-11-03T00:00:00Z" }] }),
        { status: 200 },
      );
    };
    assert.equal(await run(["calendar", "holds", "--status", "tentative"], io), 0);
    assert.match(seenUrl, /\/api\/calendar-holds\?status=tentative/);
    assert.match(io.text(), /hold_1/);

    const bad = captureIo();
    globalThis.fetch = async () => { throw new Error("no request expected"); };
    assert.notEqual(await run(["calendar", "holds", "--status", "bogus"], bad), 0);
  });
});
