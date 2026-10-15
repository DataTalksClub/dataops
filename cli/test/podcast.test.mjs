import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { parseGuests, episodeCode } = await import("../src/commands/podcast.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const episode = (fields) => ({
  id: "ep-1",
  season: 25,
  episode: 3,
  title: "Synthetic episode",
  guests: [{ name: "Test Guest", slug: "test-guest" }],
  status: "booked",
  recordingDate: "2026-11-04",
  links: { youtube: "https://youtube.example/watch" },
  version: 4,
  ...fields,
});

describe("podcast", () => {
  test("parses guests with optional slugs and codes episodes", () => {
    assert.deepEqual(parseGuests("Jane Doe:jane-doe, Bob"), [{ name: "Jane Doe", slug: "jane-doe" }, { name: "Bob" }]);
    assert.equal(episodeCode({ season: 25, episode: 3 }), "S25E3");
    assert.equal(episodeCode({ season: 25 }), "S25");
    assert.equal(episodeCode({}), "");
  });

  test("list passes filters through and prints one row per episode", async () => {
    const calls = fakePortal({ "GET /api/podcast-episodes": { items: [episode({})] } });
    const io = captureIo();
    assert.equal(await run(["podcast", "list", "--season", "25", "--status", "booked", "--from", "2026-11-01"], io), 0);
    assert.deepEqual(calls[0].query, { season: "25", status: "booked", from: "2026-11-01" });
    assert.match(io.text(), /S25E3\s+booked\s+2026-11-04/);
    assert.match(io.text(), /Test Guest - Synthetic episode/);
  });

  test("list refuses an unknown status before calling the API", async () => {
    const calls = fakePortal({});
    assert.equal(await run(["podcast", "list", "--status", "aired"], captureIo()), 2);
    assert.equal(calls.length, 0);
  });

  test("show prints the linked card summary; --json returns the record", async () => {
    const record = episode({ cardId: "c-1", card: { id: "c-1", title: "Podcast with Test Guest", stage: "preparation", taskCount: 9, openTaskCount: 7 } });
    fakePortal({ "GET /api/podcast-episodes/ep-1": record });
    const io = captureIo();
    assert.equal(await run(["podcast", "show", "ep-1"], io), 0);
    assert.match(io.text(), /episode:\s+S25E3/);
    assert.match(io.text(), /youtube:\s+https:\/\/youtube\.example\/watch/);
    assert.match(io.text(), /card: Podcast with Test Guest \[preparation\] 7\/9 Tasks open/);
    const json = captureIo();
    assert.equal(await run(["podcast", "show", "ep-1", "--json"], json), 0);
    assert.equal(json.json().card.id, "c-1");
  });

  test("create sends guests, links and booked status; needs a title or guest", async () => {
    const calls = fakePortal({
      "POST /api/podcast-episodes": ({ body }) => ({ status: 201, body: { id: "ep-9", version: 1, ...body } }),
    });
    const io = captureIo();
    assert.equal(
      await run(["podcast", "create", "--guests", "Jane Doe:jane-doe", "--season", "26", "--episode", "1", "--recording-date", "2026-12-01", "--spotify", "https://spotify.example/e", "--json"], io),
      0,
    );
    assert.deepEqual(calls[0].body, {
      season: 26,
      episode: 1,
      recordingDate: "2026-12-01",
      status: "booked",
      guests: [{ name: "Jane Doe", slug: "jane-doe" }],
      links: { spotify: "https://spotify.example/e" },
    });
    assert.equal(await run(["podcast", "create", "--season", "26"], captureIo()), 2);
    assert.equal(calls.length, 1);
  });

  test("update reads the version, merges links and clears with none", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": ({ body }) => episode({ ...body, version: 5 }),
    });
    assert.equal(
      await run(["podcast", "update", "ep-1", "--status", "recorded", "--release-date", "none", "--apple", "https://apple.example/e", "--youtube", "none"], captureIo()),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      releaseDate: null,
      status: "recorded",
      links: { apple: "https://apple.example/e" },
      version: 4,
    });
  });

  test("update maps a version conflict to exit code 5", async () => {
    fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": { status: 409, body: { error: "Episode changed; reload and retry" } },
    });
    assert.equal(await run(["podcast", "update", "ep-1", "--status", "edited"], captureIo()), 5);
  });

  test("create-card posts the episode version and refuses linked or undated episodes", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "POST /api/podcast-episodes/ep-1/card": ({ body }) => ({
        status: 201,
        body: { episode: episode({ cardId: "c-2", version: body.version + 1 }), card: { id: "c-2", title: "Synthetic episode" } },
      }),
      "GET /api/podcast-episodes/ep-2": episode({ id: "ep-2", cardId: "c-0" }),
      "GET /api/podcast-episodes/ep-3": episode({ id: "ep-3", recordingDate: null }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "create-card", "ep-1"], io), 0);
    assert.deepEqual(calls[1].body, { version: 4 });
    assert.match(io.text(), /Created Card c-2/);
    assert.equal(await run(["podcast", "create-card", "ep-2"], captureIo()), 2);
    assert.equal(await run(["podcast", "create-card", "ep-3"], captureIo()), 2);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  });
});

describe("podcast schedule", () => {
  test("lists readiness from the API without inferring public from a time", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes": {
        items: [
          episode({
            id: "ep-1",
            publication: { timezone: "Europe/Berlin", audioScheduledAt: "2026-11-20T05:00:00.000Z" },
            readiness: { spotify: "awaiting-public-check", transcript: "pending", website: "blocked", websiteBlockers: ["Transcript not reviewed"] },
          }),
          episode({ id: "ep-2", status: "cancelled" }),
        ],
      },
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "schedule"], io), 0);
    assert.ok(calls.length === 1);
    const out = io.text();
    assert.match(out, /awaiting-public-check/);
    assert.match(out, /blocked/);
    assert.doesNotMatch(out, /ep-2/);
  });
});
