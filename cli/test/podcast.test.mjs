import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { parseGuests, episodeCode, publicationFromFlags } = await import("../src/commands/podcast.mjs");

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

  test("create without --recording-date prints auto-selected slot from API", async () => {
    fakePortal({
      "POST /api/podcast-episodes": ({ body }) => ({
        status: 201,
        body: {
          id: "ep-auto",
          version: 1,
          ...body,
          recordingDate: "2026-11-03",
          recordingDateAutoSelected: true,
          recordingSlot: { date: "2026-11-03", window: "midday", localTime: "12:00", timezone: "Europe/Berlin", label: "2026-11-03 midday 12:00 Europe/Berlin" },
        },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "create", "--guests", "Auto Guest", "--title", "Auto topic"], io), 0);
    assert.match(io.text(), /Auto-selected recording slot: 2026-11-03 midday 12:00 Europe\/Berlin/);
  });

  test("create-card works when episode had no recording date after auto-pick", async () => {
    fakePortal({
      "GET /api/podcast-episodes/ep-undated": episode({ recordingDate: null, cardId: null }),
      "POST /api/podcast-episodes/ep-undated/card": {
        status: 201,
        body: {
          episode: episode({ recordingDate: "2026-11-03", cardId: "c-auto" }),
          card: { id: "c-auto", title: "Podcast with Test Guest" },
          recordingDateAutoSelected: true,
          recordingSlot: { date: "2026-11-03", window: "midday", localTime: "12:00", timezone: "Europe/Berlin", label: "2026-11-03 midday 12:00 Europe/Berlin" },
        },
      },
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "create-card", "ep-undated"], io), 0);
    assert.match(io.text(), /Auto-selected recording slot/);
    assert.match(io.text(), /Created Card c-auto/);
  });

  test("next-recording-slot prints midday preference and rows", async () => {
    fakePortal({
      "GET /api/podcast-episodes/next-recording-slot": {
        preference: { primary: "midday", fallback: "evening", eveningLocalTime: "17:00", note: "not workshop 16:30" },
        slots: [{ date: "2026-11-03", window: "midday", localTime: "12:00", timezone: "Europe/Berlin", label: "2026-11-03 midday 12:00 Europe/Berlin" }],
        takenDates: [],
      },
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "next-recording-slot", "--count", "1"], io), 0);
    assert.match(io.text(), /midday ~12:00/);
    assert.match(io.text(), /not workshop 16:30/);
    assert.match(io.text(), /2026-11-03/);
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

  test("update sends page content flags, topics and JSON files", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": ({ body }) => episode({ ...body, version: 5 }),
    });
    const io = captureIo();
    assert.equal(
      await run(
        [
          "podcast", "update", "ep-1",
          "--short", "Synthetic short",
          "--description", "Synthetic description",
          "--topics", "alpha, beta ",
          "--duration", "PT1H2M3S",
          "--image-url", "https://example.com/cover.jpg",
        ],
        io,
      ),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      short: "Synthetic short",
      description: "Synthetic description",
      topics: ["alpha", "beta"],
      duration: "PT1H2M3S",
      imageUrl: "https://example.com/cover.jpg",
      version: 4,
    });
  });

  test("update reads transcript, clips and resources from JSON files", async () => {
    const dir = await import("node:os").then((os) => os.tmpdir());
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const transcriptFile = join(dir, "synthetic-transcript.json");
    writeFileSync(transcriptFile, JSON.stringify([{ header: "Intro" }]));
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": ({ body }) => episode({ ...body, version: 5 }),
    });
    assert.equal(
      await run(["podcast", "update", "ep-1", "--transcript-file", transcriptFile, "--topics", "none"], captureIo()),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      transcript: [{ header: "Intro" }],
      topics: null,
      version: 4,
    });
    assert.equal(
      await run(["podcast", "update", "ep-1", "--transcript-file", join(dir, "missing.json")], captureIo()),
      2,
    );
  });

  test("show prints page content counts", async () => {
    fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({
        short: "Synthetic short",
        topics: ["alpha"],
        transcript: [{ header: "Intro" }, { line: "Hi" }],
        clips: [{ name: "Intro", startOffset: 0, endOffset: 3 }],
        resources: [{ name: "Tool", type: "tool" }],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "show", "ep-1"], io), 0);
    assert.match(io.text(), /short:\s+Synthetic short/);
    assert.match(io.text(), /topics:\s+alpha/);
    assert.match(io.text(), /page transcript:\s+2 entries/);
    assert.match(io.text(), /clips:\s+1 clips/);
    assert.match(io.text(), /resources:\s+1 resources/);
  });

  test("update maps a version conflict to exit code 5", async () => {
    fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": { status: 409, body: { error: "Episode changed; reload and retry" } },
    });
    assert.equal(await run(["podcast", "update", "ep-1", "--status", "edited"], captureIo()), 5);
  });

  test("create-card posts the episode version and refuses already-linked episodes", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "POST /api/podcast-episodes/ep-1/card": ({ body }) => ({
        status: 201,
        body: { episode: episode({ cardId: "c-2", version: body.version + 1 }), card: { id: "c-2", title: "Synthetic episode" } },
      }),
      "GET /api/podcast-episodes/ep-2": episode({ id: "ep-2", cardId: "c-0" }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "create-card", "ep-1"], io), 0);
    assert.deepEqual(calls[1].body, { version: 4 });
    assert.match(io.text(), /Created Card c-2/);
    assert.equal(await run(["podcast", "create-card", "ep-2"], captureIo()), 2);
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
            publication: { audioSchedule: { scheduledAt: "2026-11-20T05:00:00.000Z", timezone: "Europe/Berlin", observedAt: "2026-11-01T00:00:00.000Z" } },
            readiness: { spotify: "awaiting-public-check", transcript: "not-recorded", website: "not-recorded" },
          }),
          episode({ id: "ep-2", status: "cancelled" }),
        ],
      },
      "GET /api/podcast-episodes/next-slot": {
        code: "S26E1",
        season: 26,
        episode: 1,
        episodesPerSeason: 9,
        cadence: { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
        slots: [{ date: "2026-10-30", localTime: "19:00", timezone: "Europe/Berlin", utcInstant: "2026-10-30T18:00:00.000Z" }],
        takenDates: ["2026-10-23"],
      },
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "schedule"], io), 0);
    assert.ok(calls.length === 2);
    const out = io.text();
    assert.match(out, /awaiting-public-check/);
    assert.match(out, /not-recorded/);
    assert.doesNotMatch(out, /ep-2/);
    assert.match(out, /Next free slot: 2026-10-30 19:00 Europe\/Berlin .* as S26E1/);
    const json = captureIo();
    assert.equal(await run(["podcast", "schedule", "--json"], json), 0);
    assert.equal(json.json().nextSlot.code, "S26E1");
  });
});

describe("podcast next-slot and cadence", () => {
  const nextSlotResponse = {
    code: "S26E1",
    season: 26,
    episode: 1,
    episodesPerSeason: 9,
    cadence: { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
    slots: [{ date: "2026-10-30", localTime: "19:00", timezone: "Europe/Berlin", utcInstant: "2026-10-30T18:00:00.000Z" }],
    takenDates: ["2026-10-23"],
  };

  test("next-slot passes count through and prints the episode and slots", async () => {
    const calls = fakePortal({ "GET /api/podcast-episodes/next-slot": nextSlotResponse });
    const io = captureIo();
    assert.equal(await run(["podcast", "next-slot", "--count", "1"], io), 0);
    assert.deepEqual(calls[0].query, { count: "1" });
    assert.match(io.text(), /Next episode: S26E1/);
    assert.match(io.text(), /Friday 19:00 Europe\/Berlin/);
    assert.match(io.text(), /2026-10-30/);
    assert.match(io.text(), /Taken: 2026-10-23/);
    assert.equal(await run(["podcast", "next-slot", "--count", "0"], captureIo()), 2);
    assert.equal(await run(["podcast", "next-slot", "--count", "99"], captureIo()), 2);
  });

  test("cadence shows the stored setting and sets it with the version", async () => {
    const calls = fakePortal({
      "GET /api/workspace-settings": {
        version: 3,
        podcastReleaseCadence: { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
        podcastEpisodesPerSeason: 9,
      },
      "PUT /api/workspace-settings": ({ body }) => ({ version: 4, podcastReleaseCadence: body.podcastReleaseCadence, podcastEpisodesPerSeason: body.podcastEpisodesPerSeason ?? 9 }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "cadence"], io), 0);
    assert.match(io.text(), /Friday 19:00 Europe\/Berlin.*9 episodes per season/);
    assert.equal(await run(["podcast", "cadence", "--weekday", "fri", "--time", "19:00", "--timezone", "Europe/Berlin", "--episodes-per-season", "9"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, {
      expectedVersion: 3,
      podcastReleaseCadence: { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
      podcastEpisodesPerSeason: 9,
    });
    assert.equal(await run(["podcast", "cadence", "--weekday", "8"], captureIo()), 2);
    assert.equal(await run(["podcast", "cadence", "--time", "7pm"], captureIo()), 2);
    assert.equal(await run(["podcast", "cadence", "--timezone", "Mars/Olympus"], captureIo()), 2);
    assert.equal(await run(["podcast", "cadence", "--episodes-per-season", "0"], captureIo()), 2);
  });
});

describe("podcast publication evidence flags", () => {
  const NOW = "2026-10-01T00:00:00.000Z";

  test("records evidence with its observation time and keeps it while the proof is unchanged", () => {
    const first = publicationFromFlags(
      { spotifySchedule: "2026-11-20T06:00:00+01:00", timezone: "Europe/Berlin", spotifyVerified: "https://open.spotify.com/episode/x", transcriptReviewed: "https://example.com/review" },
      null,
      NOW,
    );
    assert.deepEqual(first, {
      audioSchedule: { scheduledAt: "2026-11-20T05:00:00.000Z", timezone: "Europe/Berlin", observedAt: NOW },
      spotify: { publicVerifiedAt: NOW, episodeUrl: "https://open.spotify.com/episode/x" },
      transcript: { reviewedAt: NOW, proofUrl: "https://example.com/review" },
    });
    const again = publicationFromFlags({ spotifyVerified: "https://open.spotify.com/episode/x" }, first, "2027-01-01T00:00:00.000Z");
    assert.equal(again.spotify.publicVerifiedAt, NOW);
  });

  test("keeps a seen-live page separate and clears with none", () => {
    const observed = publicationFromFlags({ websiteObserved: "https://example.com/live" }, null, NOW);
    assert.deepEqual(observed, { websiteObserved: { observedAt: NOW, proofUrl: "https://example.com/live" } });
    assert.equal(publicationFromFlags({ websiteObserved: "none" }, observed, NOW), null);
    assert.equal(publicationFromFlags({}, observed, NOW), undefined);
  });

  test("refuses half a schedule", () => {
    assert.throws(() => publicationFromFlags({ spotifySchedule: "2026-11-20T06:00:00Z" }, null, NOW), /together/);
  });

  test("update sends publication with the current version", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({ publication: { transcript: { reviewedAt: NOW, proofUrl: "https://example.com/review" } } }),
      "PUT /api/podcast-episodes/ep-1": episode({ version: 5 }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "update", "ep-1", "--website-observed", "https://example.com/live"], io), 0);
    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put.body.publication.transcript.proofUrl, "https://example.com/review");
    assert.equal(put.body.publication.websiteObserved.proofUrl, "https://example.com/live");
    assert.equal(put.body.version, 4);
  });

  test("invite proposes one hold, creates a standalone task, and prints the orin@ email; no card", async () => {
    const hold = {
      id: "hold_inv1",
      date: "2026-11-04",
      window: "evening",
      durationMinutes: 60,
      title: "Podcast with Sofiia",
      status: "tentative",
      startIso: "2026-11-04T15:30:00.000Z",
      endIso: "2026-11-04T16:30:00.000Z",
      googleSync: { state: "synced" },
    };
    const email = {
      from: "orin@datatalks.club",
      subject: "Sofiia at DataTalks.Club Podcast",
      body: "Hi Sofiia,\n\nFor the interview, will Wednesday 4 November at 16:30 CET work for you?\n\nhttps://datatalksclub.github.io/docs/activities/podcast/",
      docsUrl: "https://datatalksclub.github.io/docs/activities/podcast/",
    };
    const calls = fakePortal({
      "POST /api/calendar-holds": { hold },
      "POST /api/tasks": ({ body }) => ({ id: "task-1", version: 1, ...body }),
      "POST /api/podcast-first-contact/email": email,
    });
    const io = captureIo();
    const code = await run(
      ["podcast", "invite", "--guest", "Sofiia", "--email", "sofiia@example.com", "--date", "2026-11-04", "--topic", "LLM evals in production"],
      io,
    );
    assert.equal(code, 0);
    const routes = calls.map((call) => `${call.method} ${call.route}`);
    assert.deepEqual(routes, [
      "POST /api/calendar-holds",
      "POST /api/tasks",
      "POST /api/podcast-first-contact/email",
    ]);
    // The hold carries the internal topic; the email call carries one slot label.
    assert.equal(calls[0].body.topic, "LLM evals in production");
    assert.equal(calls[0].body.guestRef, "sofiia@example.com");
    const taskBody = calls[1].body;
    assert.match(taskBody.description, /Sofiia/);
    assert.ok(!("cardId" in taskBody), "invite creates a standalone Task, never a Card");
    assert.equal(calls[2].body.guestFirstName, "Sofiia");
    assert.match(calls[2].body.slotLabel, /16:30/);
    // Printed email: from orin@, one slot, docs URL, send reminder.
    assert.match(io.text(), /From: orin@datatalks\.club/);
    assert.match(io.text(), /To: sofiia@example\.com/);
    assert.match(io.text(), /Sofiia at DataTalks\.Club Podcast/);
    assert.match(io.text(), /datatalksclub\.github\.io\/docs\/activities\/podcast\//);
    assert.match(io.text(), /No Card created/);
    assert.match(io.text(), /nothing was mailed automatically/);
  });

  test("invite validates before sending anything", async () => {
    for (const argv of [
      ["podcast", "invite", "--email", "s@example.com", "--date", "2026-11-04", "--topic", "T"],
      ["podcast", "invite", "--guest", "Sofiia", "--date", "2026-11-04", "--topic", "T"],
      ["podcast", "invite", "--guest", "Sofiia", "--email", "not-an-email", "--date", "2026-11-04", "--topic", "T"],
      ["podcast", "invite", "--guest", "Sofiia", "--email", "s@example.com", "--topic", "T"],
      ["podcast", "invite", "--guest", "Sofiia", "--email", "s@example.com", "--date", "2026-11-04"],
      ["podcast", "invite", "--guest", "Sofiia", "--email", "s@example.com", "--date", "2026-11-04", "--topic", "T", "--window", "any"],
      ["podcast", "invite", "--guest", "Sofiia", "--email", "s@example.com", "--date", "2026-11-04", "--topic", "T", "--duration", "0"],
    ]) {
      const calls = fakePortal({});
      const code = await run(argv, captureIo());
      assert.notEqual(code, 0, argv.join(" "));
      assert.equal(calls.length, 0, argv.join(" "));
    }
  });
});
