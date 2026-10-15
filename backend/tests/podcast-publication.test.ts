import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
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
const TRANSCRIPT = { reviewedAt: "2026-11-19T10:00:00Z" };
const WEBSITE = { releasedAt: "2026-11-20T10:00:00Z", proofUrl: "https://example.com/podcast/synthetic" };

describe("podcast publication model", () => {
  it("reads the local date in the publication timezone", () => {
    assert.equal(localDate("2026-11-20T23:30:00Z", "Europe/Berlin"), "2026-11-21");
    assert.equal(localDate("2026-11-20T23:30:00Z", "America/New_York"), "2026-11-20");
  });

  it("does not treat scheduled audio, or a passed schedule, as public", () => {
    const future = { timezone: "Europe/Berlin", audioScheduledAt: "2026-11-21T05:00:00Z" };
    assert.equal(derivePublicationReadiness(future, NOW).spotify, "scheduled");
    const past = { timezone: "Europe/Berlin", audioScheduledAt: "2026-11-20T05:00:00Z" };
    const readiness = derivePublicationReadiness(past, NOW);
    assert.equal(readiness.spotify, "awaiting-public-check");
    assert.equal(readiness.website, "blocked");
    assert.deepEqual(readiness.websiteBlockers, ["Transcript not reviewed", "Spotify episode not verified public"]);
    assert.equal(derivePublicationReadiness(null, NOW).spotify, "not-scheduled");
  });

  it("needs both a reviewed transcript and a verified public episode for the website", () => {
    const scheduledAndReviewed = { timezone: "UTC", audioScheduledAt: "2026-11-19T05:00:00Z", transcript: TRANSCRIPT };
    const only = derivePublicationReadiness(scheduledAndReviewed, NOW);
    assert.equal(only.website, "blocked");
    assert.deepEqual(only.websiteBlockers, ["Spotify episode not verified public"]);
    assert.equal(derivePublicationReadiness({ spotify: SPOTIFY }, NOW).website, "blocked");
    const both = derivePublicationReadiness({ spotify: SPOTIFY, transcript: TRANSCRIPT }, NOW);
    assert.equal(both.website, "ready");
    assert.deepEqual(both.websiteBlockers, []);
    assert.equal(derivePublicationReadiness({ spotify: SPOTIFY, transcript: TRANSCRIPT, website: WEBSITE }, NOW).website, "released");
    assert.equal(derivePublicationReadiness({ website: { ...WEBSITE, earlyReason: "x" } }, NOW).website, "released-early");
  });

  it("validates shapes, proofs and instants", () => {
    const bad = (value: unknown, message: RegExp) => {
      const result = normalizePublication(value, NOW);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.match((result as any).error, message);
    };
    bad([], /Invalid publication/);
    bad({ other: 1 }, /Unknown publication field/);
    bad({ timezone: "Mars/Base" }, /timezone/);
    bad({ audioScheduledAt: "2026-11-21T05:00:00Z" }, /needs a timezone/);
    bad({ timezone: "UTC", audioScheduledAt: "2026-11-21" }, /audioScheduledAt/);
    bad({ timezone: "UTC", audioScheduledAt: "2026-11-21T05:00:00" }, /audioScheduledAt/);
    bad({ spotify: { ...SPOTIFY, episodeUrl: "https://example.com/episode/1" } }, /open.spotify.com/);
    bad({ spotify: { ...SPOTIFY, episodeUrl: "http://open.spotify.com/episode/1" } }, /open.spotify.com/);
    bad({ spotify: { ...SPOTIFY, publicVerifiedAt: "2026-12-01T00:00:00Z" } }, /future/);
    bad({ transcript: { reviewedAt: "2026-11-19T10:00:00Z", proofUrl: "http://x.example" } }, /proofUrl/);
    bad({ website: { releasedAt: WEBSITE.releasedAt } }, /proofUrl/);
    bad({ website: WEBSITE }, /earlyReason/);
    bad({ spotify: SPOTIFY, website: WEBSITE }, /earlyReason/);
    const ok = normalizePublication({ timezone: "Europe/Berlin", audioScheduledAt: "2026-11-21T06:00:00+01:00", spotify: SPOTIFY, transcript: TRANSCRIPT, website: WEBSITE }, NOW);
    assert.equal(ok.ok, true);
    assert.equal((ok as any).value.audioScheduledAt, "2026-11-21T05:00:00.000Z");
    const early = normalizePublication({ website: { ...WEBSITE, earlyReason: "  Operator override  " } }, NOW);
    assert.equal((early as any).value.website.earlyReason, "Operator override");
  });
});

// The API validates against the real clock, so these facts sit safely in the past.
const API_SPOTIFY = { ...SPOTIFY, publicVerifiedAt: "2026-01-02T09:00:00Z" };
const API_TRANSCRIPT = { reviewedAt: "2026-01-01T10:00:00Z" };
const API_WEBSITE = { ...WEBSITE, releasedAt: "2026-01-02T10:00:00Z" };

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

  it("records a schedule, derives releaseDate and never infers public", async () => {
    const episode = await create();
    assert.equal(episode.readiness.spotify, "not-scheduled");
    const scheduled = await put(episode, {
      publication: { timezone: "Asia/Tokyo", audioScheduledAt: "2099-01-01T20:00:00Z" },
    });
    assert.equal(scheduled.statusCode, 200, scheduled.body);
    const body = data(scheduled);
    assert.equal(body.releaseDate, "2099-01-02");
    assert.equal(body.readiness.spotify, "scheduled");
    assert.equal(body.readiness.scheduledLocalDate, "2099-01-02");
    assert.equal(body.readiness.website, "blocked");
    const fetched = data(await invoke("GET", `/api/podcast-episodes/${episode.id}`));
    assert.equal(fetched.readiness.spotify, "scheduled");
    assert.equal(fetched.publication.timezone, "Asia/Tokyo");
    assert.equal(fetched.status, "edited");

    const mismatch = await put(body, {
      publication: { timezone: "Asia/Tokyo", audioScheduledAt: "2099-01-01T20:00:00Z" },
      releaseDate: "2099-01-01",
    });
    assert.equal(mismatch.statusCode, 400);
    assert.match(data(mismatch).error, /releaseDate must match/);
  });

  it("keeps the website blocked until transcript and public Spotify are both recorded", async () => {
    const episode = await create({ title: "Synthetic Gate Episode" });
    const base = { timezone: "UTC", audioScheduledAt: "2026-01-01T05:00:00Z" };
    const early = await put(episode, {
      publication: { ...base, transcript: API_TRANSCRIPT, website: API_WEBSITE },
    });
    assert.equal(early.statusCode, 400, early.body);
    assert.match(data(early).error, /reviewed transcript and a verified public Spotify/);

    const reviewed = data(await put(episode, { publication: { ...base, transcript: API_TRANSCRIPT } }));
    assert.equal(reviewed.readiness.transcript, "reviewed");
    assert.equal(reviewed.readiness.website, "blocked");
    assert.deepEqual(reviewed.readiness.websiteBlockers, ["Spotify episode not verified public"]);
    assert.equal(reviewed.readiness.spotify, "awaiting-public-check");

    const still = await put(reviewed, { publication: { ...reviewed.publication, website: API_WEBSITE } });
    assert.equal(still.statusCode, 400);

    const verified = data(await put(reviewed, { publication: { ...reviewed.publication, spotify: API_SPOTIFY } }));
    assert.equal(verified.readiness.spotify, "public");
    assert.equal(verified.readiness.website, "ready");

    const released = data(await put(verified, { publication: { ...verified.publication, website: API_WEBSITE } }));
    assert.equal(released.readiness.website, "released");
    assert.equal(released.publication.website.proofUrl, API_WEBSITE.proofUrl);
  });

  it("allows a recorded early release with an explicit reason, and clears with null", async () => {
    const episode = await create({ title: "Synthetic Early Episode" });
    const early = await put(episode, {
      publication: { website: { ...API_WEBSITE, earlyReason: "Operator decision, recorded" } },
    });
    assert.equal(early.statusCode, 200, early.body);
    assert.equal(data(early).readiness.website, "released-early");
    const cleared = data(await put(data(early), { publication: null }));
    assert.equal(cleared.publication, undefined);
    assert.equal(cleared.readiness.website, "blocked");
  });

  it("does not revalidate untouched publication facts on unrelated updates", async () => {
    const episode = await create({ title: "Synthetic Untouched Episode" });
    const saved = data(await put(episode, { publication: { transcript: API_TRANSCRIPT } }));
    const renamed = await put(saved, { notes: "Synthetic note" });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(data(renamed).publication, saved.publication);
  });
});
