import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { createPodcastEpisode } from "../src/db/podcastEpisodes";
import {
  derivePublicationReadiness,
  localDate,
  normalizePublication,
} from "../src/podcast/publication";

const invoke = (method: string, path: string, body?: unknown) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) },
    {},
  );
const data = (response: any) => JSON.parse(response.body);

const NOW = new Date("2026-11-20T12:00:00Z");
const SPOTIFY = { publicVerifiedAt: "2026-11-20T09:00:00Z", episodeUrl: "https://open.spotify.com/episode/synthetic123" };
const TRANSCRIPT = { reviewedAt: "2026-11-19T10:00:00Z", proofUrl: "https://example.com/transcript-review" };
const WEBSITE = { releasedAt: "2026-11-20T10:00:00Z", proofUrl: "https://example.com/podcast/synthetic" };
const OBSERVED = { observedAt: "2026-11-20T11:00:00Z", proofUrl: "https://example.com/podcast/synthetic" };
const SCHEDULE = { scheduledAt: "2026-11-21T05:00:00Z", timezone: "Europe/Berlin", observedAt: "2026-11-19T08:00:00Z" };

describe("podcast publication model", () => {
  it("reads the local date in the schedule's timezone", () => {
    assert.equal(localDate("2026-11-20T23:30:00Z", "Europe/Berlin"), "2026-11-21");
    assert.equal(localDate("2026-11-20T23:30:00Z", "America/New_York"), "2026-11-20");
  });

  it("reports not-recorded, never a definite not-scheduled, without evidence", () => {
    for (const none of [null, undefined, {}]) {
      const readiness = derivePublicationReadiness(none, NOW);
      assert.equal(readiness.spotify, "not-recorded");
      assert.equal(readiness.transcript, "not-recorded");
      assert.equal(readiness.website, "not-recorded");
      assert.equal(readiness.scheduledLocalDate, null);
    }
  });

  it("does not treat scheduled audio, or a passed schedule, as public", () => {
    assert.equal(derivePublicationReadiness({ audioSchedule: SCHEDULE }, NOW).spotify, "scheduled");
    const past = { audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-20T05:00:00Z" } };
    assert.equal(derivePublicationReadiness(past, NOW).spotify, "awaiting-public-check");
    assert.equal(derivePublicationReadiness({ ...past, spotify: SPOTIFY }, NOW).spotify, "public");
  });

  it("reads transcript and website from what was recorded, with no gate between them", () => {
    const noProof = { transcript: { reviewedAt: TRANSCRIPT.reviewedAt } } as any;
    assert.equal(derivePublicationReadiness(noProof, NOW).transcript, "not-recorded");
    assert.equal(derivePublicationReadiness({ transcript: TRANSCRIPT }, NOW).transcript, "reviewed");
    assert.equal(derivePublicationReadiness({ spotify: SPOTIFY, transcript: TRANSCRIPT }, NOW).website, "not-recorded");
    assert.equal(derivePublicationReadiness({ website: WEBSITE }, NOW).website, "released");
    assert.equal(derivePublicationReadiness({ websiteObserved: OBSERVED }, NOW).website, "observed-live");
  });

  it("validates shapes, proofs and instants", () => {
    const bad = (value: unknown, message: RegExp) => {
      const result = normalizePublication(value, NOW);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.match((result as any).error, message);
    };
    bad([], /Invalid publication/);
    bad({ other: 1 }, /Unknown publication field/);
    bad({ timezone: "UTC" }, /Unknown publication field/);
    bad({ audioSchedule: { ...SCHEDULE, timezone: "Mars/Base" } }, /timezone/);
    bad({ audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-21" } }, /scheduledAt/);
    bad({ audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-21T05:00:00" } }, /scheduledAt/);
    bad({ audioSchedule: { ...SCHEDULE, observedAt: "2026-12-01T00:00:00Z" } }, /future/);
    bad({ audioSchedule: { ...SCHEDULE, proofUrl: "http://insecure.example" } }, /proofUrl/);
    bad({ spotify: { ...SPOTIFY, episodeUrl: "https://example.com/episode/1" } }, /open.spotify.com/);
    bad({ spotify: { ...SPOTIFY, episodeUrl: "http://open.spotify.com/episode/1" } }, /open.spotify.com/);
    bad({ spotify: { ...SPOTIFY, publicVerifiedAt: "2026-12-01T00:00:00Z" } }, /future/);
    bad({ transcript: { reviewedAt: TRANSCRIPT.reviewedAt } }, /proofUrl is required/);
    bad({ transcript: { ...TRANSCRIPT, proofUrl: "http://x.example" } }, /proofUrl/);
    bad({ websiteObserved: { observedAt: OBSERVED.observedAt } }, /proofUrl/);
    bad({ website: { releasedAt: WEBSITE.releasedAt } }, /proofUrl/);
    bad({ website: { ...WEBSITE, earlyReason: "x" } }, /Invalid website release/);
    assert.equal(normalizePublication({ website: WEBSITE }, NOW).ok, true, "a release needs no other evidence first");
    const ok = normalizePublication({
      audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-21T06:00:00+01:00" },
      spotify: SPOTIFY, transcript: TRANSCRIPT, website: WEBSITE, websiteObserved: OBSERVED,
    }, NOW);
    assert.equal(ok.ok, true);
    assert.equal((ok as any).value.audioSchedule.scheduledAt, "2026-11-21T05:00:00.000Z");
  });
});

// The API validates against the real clock, so these facts sit safely in the past.
const API_SPOTIFY = { ...SPOTIFY, publicVerifiedAt: "2026-01-02T09:00:00Z" };
const API_TRANSCRIPT = { ...TRANSCRIPT, reviewedAt: "2026-01-01T10:00:00Z" };
const API_WEBSITE = { ...WEBSITE, releasedAt: "2026-01-02T10:00:00Z" };
const API_OBSERVED = { ...OBSERVED, observedAt: "2026-01-03T10:00:00Z" };
const API_SCHEDULE = { scheduledAt: "2099-01-01T20:00:00Z", timezone: "Asia/Tokyo", observedAt: "2026-01-01T08:00:00Z" };

describe("podcast publication API", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  const create = async (extra: Record<string, unknown> = {}) => {
    const response = await invoke("POST", "/api/podcast-episodes", {
      title: "Synthetic Schedule Episode",
      guests: [{ name: "Ada Example" }],
      status: "edited",
      recordingDate: "2026-10-01",
      ...extra,
    });
    assert.equal(response.statusCode, 201, response.body);
    return data(response);
  };
  const put = (episode: any, body: Record<string, unknown>) =>
    invoke("PUT", `/api/podcast-episodes/${episode.id}`, { version: episode.version, ...body });

  it("keeps the intended release date apart from evidenced Spotify scheduling", async () => {
    const episode = await create({ releaseDate: "2099-01-05" });
    assert.equal(episode.readiness.spotify, "not-recorded");
    const scheduled = await put(episode, { publication: { audioSchedule: API_SCHEDULE } });
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    const body = data(scheduled);
    assert.equal(body.releaseDate, "2099-01-05", "the intended date is not rewritten by schedule evidence");
    assert.equal(body.readiness.scheduledLocalDate, "2099-01-02");
    assert.equal(body.readiness.spotify, "scheduled");
    assert.equal(body.status, "edited");
    const dated = (await create({ releaseDate: "2099-02-01" }));
    assert.equal(dated.publication, undefined);
    assert.equal(dated.readiness.spotify, "not-recorded", "an intended date alone claims nothing external");
  });

  it("records an already-live page", async () => {
    const episode = await create({ title: "Synthetic Observed Episode" });
    const observed = await put(episode, { publication: { websiteObserved: API_OBSERVED } });
    assert.equal(observed.statusCode, 200, observed.body);
    const body = data(observed);
    assert.equal(body.readiness.website, "observed-live");
    assert.equal(body.readiness.spotify, "not-recorded");
    assert.equal(body.status, "edited", "observing history does not change status");
    const cleared = data(await put(body, { publication: null }));
    assert.equal(cleared.publication, undefined);
    assert.equal(cleared.readiness.website, "not-recorded");
  });

  it("enters scheduled and published without publication evidence; the Card carries the proof", async () => {
    const published = await invoke("POST", "/api/podcast-episodes", { title: "Synthetic Published", guests: [], status: "published" });
    assert.equal(published.statusCode, 201, published.body);
    const episode = await create({ title: "Synthetic Scheduled" });
    const scheduled = await put(episode, { status: "scheduled" });
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    assert.equal(data(scheduled).status, "scheduled");

    const historical = await createPodcastEpisode(client, {
      title: "Synthetic Historical", guests: [{ name: "Grace Sample" }], status: "published",
      releaseDate: "2024-01-01",
    });
    const shown = data(await invoke("GET", `/api/podcast-episodes/${historical.id}`));
    assert.equal(shown.readiness.website, "not-recorded");
    const edited = await put(shown, { notes: "Synthetic note" });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(data(edited).status, "published");
  });

  it("does not revalidate untouched publication facts on unrelated updates", async () => {
    const episode = await create({ title: "Synthetic Untouched Episode" });
    const saved = data(await put(episode, { publication: { transcript: API_TRANSCRIPT } }));
    const renamed = await put(saved, { notes: "Synthetic note" });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(data(renamed).publication, saved.publication);
  });
});
