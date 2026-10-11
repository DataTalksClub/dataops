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
  test("calendar list fetches activities, holidays, and alerts", async () => {
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
              id: "act-1",
              title: "Community webinar",
              activityType: "webinar",
              status: "confirmed",
              startDate: "2026-08-13",
              endDate: "2026-08-13",
              allDay: true,
            },
            {
              id: "act-2",
              title: "Live podcast",
              activityType: "podcast-live",
              status: "announced",
              startsAt: "2026-08-15T10:30:00Z",
              endsAt: "2026-08-15T11:30:00Z",
              allDay: false,
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
    assert.match(io.text(), /Community webinar/);
    assert.match(io.text(), /Live podcast/);
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
            { id: "act-1", title: "Webinar", activityType: "webinar", allDay: true },
          ],
          holidays: [],
          alerts: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(
      ["calendar", "list", "--from", "2026-08-01", "--to", "2026-08-05", "--json"],
      io,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(io.text());
    assert.equal(parsed.items[0].title, "Webinar");
  });

  test("calendar detail shows full activity details", async () => {
    const io = captureIo();
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/api\/calendar-items\/act-123$/);
      return new Response(
        JSON.stringify({
          id: "act-123",
          title: "Quarterly Planning Workshop",
          activityType: "workshop",
          status: "confirmed",
          version: 3,
          allDay: false,
          startsAt: "2026-08-20T14:30:00Z",
          endsAt: "2026-08-20T16:30:00Z",
          url: "https://zoom.us/j/12345",
          notes: "Bring draft objectives",
          cardId: "card-456",
          templateId: "tpl-789",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(["calendar", "detail", "act-123"], io);
    assert.equal(code, 0);
    assert.match(io.text(), /Quarterly Planning Workshop/);
    assert.match(io.text(), /workshop/);
    assert.match(io.text(), /confirmed/);
    assert.match(io.text(), /card-456/);
    assert.match(io.text(), /https:\/\/zoom\.us\/j\/12345/);
  });

  test("calendar create validates flags and posts canonical payload", async () => {
    const io = captureIo();
    let sentBody = null;

    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/api\/calendar-items$/);
      assert.equal(options.method, "POST");
      sentBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          id: "created-act-1",
          ...sentBody,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const code = await run(
      [
        "calendar",
        "create",
        "--title",
        "Hands-on LLM Workshop",
        "--type",
        "workshop",
        "--date",
        "2026-09-10",
        "--status",
        "confirmed",
        "--link",
        "https://datatalks.club/events",
      ],
      io,
    );
    assert.equal(code, 0);
    assert.deepEqual(sentBody, {
      title: "Hands-on LLM Workshop",
      activityType: "workshop",
      status: "confirmed",
      allDay: true,
      startDate: "2026-09-10",
      endDate: "2026-09-10",
      url: "https://datatalks.club/events",
    });
    assert.match(io.text(), /Created calendar activity "Hands-on LLM Workshop"/);
  });

  test("calendar edit fetches current version and merges updates", async () => {
    const io = captureIo();
    let putBody = null;

    globalThis.fetch = async (url, options) => {
      const u = String(url);
      if (options.method === "GET") {
        return new Response(
          JSON.stringify({
            id: "act-edit-1",
            title: "Old Title",
            activityType: "webinar",
            status: "tentative",
            version: 5,
            allDay: true,
            startDate: "2026-08-15",
            endDate: "2026-08-15",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (options.method === "PUT") {
        putBody = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            id: "act-edit-1",
            ...putBody,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${options.method} ${u}`);
    };

    const code = await run(
      [
        "calendar",
        "edit",
        "act-edit-1",
        "--title",
        "New Title",
        "--status",
        "announced",
      ],
      io,
    );
    assert.equal(code, 0);
    assert.equal(putBody.version, 5);
    assert.equal(putBody.title, "New Title");
    assert.equal(putBody.status, "announced");
    assert.equal(putBody.activityType, "webinar");
    assert.match(io.text(), /Updated calendar activity "New Title"/);
  });

  test("calendar delete sends DELETE with existing version", async () => {
    const io = captureIo();
    let deleteBody = null;

    globalThis.fetch = async (url, options) => {
      const u = String(url);
      if (options.method === "GET") {
        return new Response(
          JSON.stringify({
            id: "act-del-1",
            title: "To Be Deleted",
            version: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (options.method === "DELETE") {
        deleteBody = JSON.parse(options.body);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${options.method} ${u}`);
    };

    const code = await run(["calendar", "delete", "act-del-1"], io);
    assert.equal(code, 0);
    assert.deepEqual(deleteBody, { version: 2 });
    assert.match(io.text(), /Deleted calendar activity act-del-1/);
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
                category: "Alexey",
                label: "09:30–10:30 Team sync",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "outside",
              },
              {
                category: "Alexey",
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
              id: "act-webinar",
              title: "MLOps live demonstration",
              activityType: "webinar",
              status: "confirmed",
              startDate: "2026-08-13",
              endDate: "2026-08-13",
              allDay: true,
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
    assert.match(text, /Midday Event Slot \(11:30–14:00\):\s+BUSY/);
    assert.match(text, /Podcast with Guest/);
    // Evening is available because there are no evening blockers
    assert.match(text, /Evening Event Slot \(16:30–18:30\):\s+AVAILABLE/);
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
                category: "Alexey",
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
            showAvailableSlots: true,
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
});
