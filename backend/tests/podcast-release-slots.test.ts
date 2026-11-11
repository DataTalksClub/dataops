import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_PODCAST_EPISODES, TABLE_TEMPLATES } from "../src/db/tableNames";
import {
  freeSlotDates,
  nextEpisodeNumber,
  nextReleaseSlots,
  normalizeCadence,
  normalizeEpisodesPerSeason,
  takenReleaseDates,
  validCadence,
  DEFAULT_PODCAST_RELEASE_CADENCE,
  isReleaseCadenceDate,
} from "../src/podcast/releaseSlots";
import { civilToUtc, todayIn } from "../src/relativeDates";

const invoke = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: query, body: body === undefined ? null : JSON.stringify(body) },
    {},
  );
const data = (response: any) => JSON.parse(response.body);
const booked = (fields: Record<string, unknown> = {}) => ({
  title: "Synthetic episode",
  guests: [{ name: "Synthetic Guest" }],
  status: "booked",
  ...fields,
});

describe("podcast release slots", () => {
  it("validates and normalizes the cadence and season length", () => {
    assert.ok(validCadence({ weekday: 5, time: "19:00", timezone: "Europe/Berlin" }));
    assert.ok(!validCadence({ weekday: 0, time: "19:00", timezone: "Europe/Berlin" }));
    assert.ok(!validCadence({ weekday: 5, time: "7pm", timezone: "Europe/Berlin" }));
    assert.ok(!validCadence({ weekday: 5, time: "19:00", timezone: "Mars/Olympus" }));
    assert.deepEqual(normalizeCadence(undefined), { ...DEFAULT_PODCAST_RELEASE_CADENCE });
    assert.deepEqual(normalizeCadence({ weekday: 2, time: "bad", timezone: "bad" }), { ...DEFAULT_PODCAST_RELEASE_CADENCE, weekday: 2 });
    assert.equal(normalizeEpisodesPerSeason(9), 9);
    assert.equal(normalizeEpisodesPerSeason(0), 9);
    assert.equal(normalizeEpisodesPerSeason("9"), 9);
  });

  it("converts the wall time DST-aware", () => {
    // CEST (+02:00) before the autumn change, CET (+01:00) after it.
    assert.equal(civilToUtc("2026-10-23", "19:00", "Europe/Berlin"), "2026-10-23T17:00:00.000Z");
    assert.equal(civilToUtc("2026-10-30", "19:00", "Europe/Berlin"), "2026-10-30T18:00:00.000Z");
    assert.equal(todayIn("Europe/Berlin", new Date("2026-10-17T10:00:00Z")), "2026-10-17");
    assert.equal(isReleaseCadenceDate("2026-11-20", DEFAULT_PODCAST_RELEASE_CADENCE), true);
    assert.equal(isReleaseCadenceDate("2026-11-19", DEFAULT_PODCAST_RELEASE_CADENCE), false);
  });

  it("takes a slot on a release date or a Spotify schedule date, ignoring cancelled episodes", () => {
    const taken = takenReleaseDates([
      { status: "booked", releaseDate: "2026-10-23", publication: null },
      {
        status: "scheduled",
        releaseDate: null,
        publication: { audioSchedule: { scheduledAt: "2026-10-30T18:00:00.000Z", timezone: "Europe/Berlin", observedAt: "2026-10-01T00:00:00.000Z" } },
      },
      { status: "cancelled", releaseDate: "2026-11-06", publication: null },
    ] as any);
    assert.deepEqual([...taken].sort(), ["2026-10-23", "2026-10-30"]);
  });

  it("numbers the next episode after the highest held number and rolls over after 9", () => {
    assert.deepEqual(nextEpisodeNumber([], 9), { season: 1, episode: 1, code: "S1E1" });
    assert.deepEqual(
      nextEpisodeNumber([
        { status: "booked", season: 25, episode: null },
        { status: "recorded", season: 25, episode: 8 },
        { status: "published", season: 25, episode: 7 },
        { status: "cancelled", season: 25, episode: 9 },
      ] as any, 9),
      { season: 25, episode: 9, code: "S25E9" },
    );
    assert.deepEqual(
      nextEpisodeNumber([{ status: "published", season: 25, episode: 9 }] as any, 9),
      { season: 26, episode: 1, code: "S26E1" },
    );
    assert.deepEqual(
      nextEpisodeNumber([{ status: "published", season: 25, episode: 9 }] as any, 12),
      { season: 25, episode: 10, code: "S25E10" },
    );
  });

  it("skips taken Fridays", () => {
    const dates = freeSlotDates(
      "2026-10-17",
      2,
      { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
      new Set(["2026-10-23"]),
    );
    assert.deepEqual(dates, ["2026-10-30", "2026-11-06"]);
  });

  it("combines numbering and free slots", () => {
    const result = nextReleaseSlots({
      episodes: [{ status: "published", season: 25, episode: 9, releaseDate: "2026-10-23", publication: null }] as any,
      cadence: { weekday: 5, time: "19:00", timezone: "Europe/Berlin" },
      episodesPerSeason: 9,
      count: 1,
      now: new Date("2026-10-17T10:00:00Z"),
    });
    assert.equal(result.code, "S26E1");
    assert.equal(result.slots[0].date, "2026-10-30");
    assert.equal(result.slots[0].utcInstant, "2026-10-30T18:00:00.000Z");
  });

  it("keeps Miguel S25E8 fixed and selects S26E1 on 20 November after his booked Friday", () => {
    const result = nextReleaseSlots({
      episodes: [
        {
          id: "aedaf06e-187f-48c7-8096-477d34db097f",
          season: 25,
          episode: 8,
          status: "edited",
          recordingDate: "2026-10-12",
          releaseDate: "2026-11-13",
          releaseAssignmentStatus: "unassigned",
          publication: null,
        },
        { season: 25, episode: 9, status: "published", releaseDate: "2026-10-23", publication: null },
      ] as any,
      cadence: DEFAULT_PODCAST_RELEASE_CADENCE,
      episodesPerSeason: 9,
      count: 1,
      now: new Date("2026-11-11T12:00:00Z"),
    });
    assert.equal(result.code, "S26E1");
    assert.equal(result.slots[0].date, "2026-11-20");
  });
});

describe("podcast next-slot API", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  it("answers the next free slot and episode, validates count, and keeps the cadence configurable", async () => {
    const s25e9 = data(await invoke("POST", "/api/podcast-episodes", booked({
      season: 25, episode: 9, releaseDate: "2026-10-23", releaseAssignmentStatus: "final", status: "published",
    })));
    assert.equal(s25e9.season, 25);
    // A Spotify schedule on a date takes that date too.
    const scheduled = data(await invoke("POST", "/api/podcast-episodes", booked({
      season: 26,
      episode: 1,
      title: "Synthetic scheduled",
      releaseDate: "2026-11-06",
      releaseAssignmentStatus: "final",
      status: "scheduled",
      publication: {
        audioSchedule: { scheduledAt: "2026-11-06T18:00:00.000Z", timezone: "Europe/Berlin", observedAt: "2026-10-01T00:00:00.000Z" },
      },
    })));
    assert.ok(scheduled.id);

    const slots = data(await invoke("GET", "/api/podcast-episodes/next-slot", undefined, { count: "4" }));
    assert.equal(slots.code, "S26E2");
    assert.equal(slots.season, 26);
    assert.equal(slots.episode, 2);
    assert.equal(slots.episodesPerSeason, 9);
    assert.deepEqual(slots.cadence, { weekday: 5, time: "19:00", timezone: "Europe/Berlin" });
    assert.ok(slots.takenDates.includes("2026-10-23"));
    assert.ok(slots.takenDates.includes("2026-11-06"));
    for (const slot of slots.slots) {
      assert.ok(!slots.takenDates.includes(slot.date), `${slot.date} must be free`);
      assert.equal(new Date(slot.date).getUTCDay(), 5, `${slot.date} must be a Friday`);
    }

    assert.equal((await invoke("GET", "/api/podcast-episodes/next-slot", undefined, { count: "0" })).statusCode, 400);
    assert.equal((await invoke("GET", "/api/podcast-episodes/next-slot", undefined, { count: "99" })).statusCode, 400);

    const settings = data(await invoke("GET", "/api/workspace-settings"));
    assert.deepEqual(settings.podcastReleaseCadence, { weekday: 5, time: "19:00", timezone: "Europe/Berlin" });
    assert.equal(settings.podcastEpisodesPerSeason, 9);
    assert.equal(
      (await invoke("PUT", "/api/workspace-settings", { podcastReleaseCadence: { weekday: 9, time: "19:00", timezone: "Europe/Berlin" }, expectedVersion: settings.version })).statusCode,
      400,
    );
    assert.equal(
      (await invoke("PUT", "/api/workspace-settings", { podcastEpisodesPerSeason: 0, expectedVersion: settings.version })).statusCode,
      400,
    );
    const saved = await invoke("PUT", "/api/workspace-settings", {
      podcastReleaseCadence: { weekday: 5, time: "18:00", timezone: "Europe/Berlin" },
      podcastEpisodesPerSeason: 12,
      expectedVersion: settings.version,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(data(saved).podcastReleaseCadence, { weekday: 5, time: "18:00", timezone: "Europe/Berlin" });
    assert.equal(data(saved).podcastEpisodesPerSeason, 12);
    const moved = data(await invoke("GET", "/api/podcast-episodes/next-slot", undefined, { count: "1" }));
    assert.equal(moved.slots[0].localTime, "18:00");
    assert.equal(moved.episodesPerSeason, 12);
  });

  it("requires explicit provisional/final Friday assignments, blocks collisions, and leaves Miguel and the v41 pin unchanged", async () => {
    const miguelId = "aedaf06e-187f-48c7-8096-477d34db097f";
    const templateId = "6ac4a77f-4698-4d87-86d8-63f4a5852fff";
    const miguel = {
      PK: `EPISODE#${miguelId}`,
      SK: `EPISODE#${miguelId}`,
      rangeKey: "EPISODES",
      dateKey: `2026-11-13#${miguelId}`,
      id: miguelId,
      season: 25,
      episode: 8,
      title: "Navigating the Maze of Production Machine Learning",
      guests: [{ name: "Miguel Otero Pedrido" }],
      status: "edited",
      recordingDate: "2026-10-12",
      releaseDate: "2026-11-13",
      websiteSlug: "s25e08-navigating-the-maze-of-production-machine-learning",
      cardId: "3a17162e-db0b-4e20-a7ab-4561cdfa5c21",
      version: 1,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    };
    const pinnedTemplate = {
      PK: `TEMPLATE#${templateId}`,
      SK: `TEMPLATE#${templateId}`,
      id: templateId,
      type: "podcast-episode",
      version: 41,
      pinned: true,
      status: "proposed",
      revision: "acb9bd72-08de-4aa6-a04b-36fca5cc3cdf",
    };
    await client.send(new PutCommand({ TableName: TABLE_PODCAST_EPISODES, Item: miguel }));
    await client.send(new PutCommand({ TableName: TABLE_TEMPLATES, Item: pinnedTemplate }));

    const collision = await invoke("POST", "/api/podcast-episodes", booked({
      season: 26,
      episode: 1,
      releaseDate: "2026-11-13",
      releaseAssignmentStatus: "provisional",
      recordingDate: "2026-11-04",
    }));
    assert.equal(collision.statusCode, 409, collision.body);
    assert.match(data(collision).error, /Release date 2026-11-13 is already held/);

    const missingState = await invoke("POST", "/api/podcast-episodes", booked({
      season: 26,
      episode: 1,
      releaseDate: "2026-11-20",
      recordingDate: "2026-11-04",
    }));
    assert.equal(missingState.statusCode, 400);

    const invalidWeekday = await invoke("POST", "/api/podcast-episodes", booked({
      season: 26,
      episode: 1,
      releaseDate: "2026-11-19",
      releaseAssignmentStatus: "provisional",
      recordingDate: "2026-11-04",
    }));
    assert.equal(invalidWeekday.statusCode, 400);

    const afterMiguel = await client.send(new GetCommand({ TableName: TABLE_PODCAST_EPISODES, Key: { PK: miguel.PK, SK: miguel.SK } }));
    const afterTemplate = await client.send(new GetCommand({ TableName: TABLE_TEMPLATES, Key: { PK: pinnedTemplate.PK, SK: pinnedTemplate.SK } }));
    assert.deepEqual(afterMiguel.Item, miguel);
    assert.deepEqual(afterTemplate.Item, pinnedTemplate);
  });

  it("finalizes a provisional booking only after recording and reserves it in next-slot", async () => {
    const planned = data(await invoke("POST", "/api/podcast-episodes", booked({
      season: 29,
      episode: 1,
      releaseDate: "2026-11-20",
      releaseAssignmentStatus: "provisional",
      recordingDate: "2026-11-04",
    })));
    assert.equal(planned.releaseAssignmentStatus, "provisional");
    const secondBooking = await invoke("POST", "/api/podcast-episodes", booked({
      season: 29,
      episode: 2,
      releaseDate: "2026-11-20",
      releaseAssignmentStatus: "provisional",
      recordingDate: "2026-11-05",
    }));
    assert.equal(secondBooking.statusCode, 409);

    const earlyFinalize = await invoke("PUT", `/api/podcast-episodes/${planned.id}`, {
      version: planned.version,
      releaseAssignmentStatus: "final",
    });
    assert.equal(earlyFinalize.statusCode, 400);

    const recorded = data(await invoke("PUT", `/api/podcast-episodes/${planned.id}`, {
      version: planned.version,
      status: "recorded",
    }));
    const finalized = data(await invoke("PUT", `/api/podcast-episodes/${planned.id}`, {
      version: recorded.version,
      releaseAssignmentStatus: "final",
    }));
    assert.equal(finalized.releaseAssignmentStatus, "final");
    assert.equal(finalized.releaseDate, "2026-11-20");
    const next = data(await invoke("GET", "/api/podcast-episodes/next-slot", undefined, { count: "1" }));
    assert.ok(next.takenDates.includes("2026-11-20"));
    assert.ok(next.slots.every((slot: any) => slot.date !== "2026-11-20"));
  });
});
