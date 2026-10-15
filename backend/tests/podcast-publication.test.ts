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
  statusGateError,
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

  it("reports not-recorded, never a definite not-scheduled or blocked, without evidence", () => {
    for (const none of [null, undefined, {}]) {
      const readiness = derivePublicationReadiness(none, NOW);
      assert.equal(readiness.spotify, "not-recorded");
      assert.equal(readiness.transcript, "not-recorded");
      assert.equal(readiness.website, "not-recorded");
      assert.equal(readiness.scheduledLocalDate, null);
      assert.deepEqual(readiness.websiteGate, {
        met: false,
        missing: ["Reviewed transcript with proof", "Verified public Spotify episode"],
      });
    }
  });

  it("does not treat scheduled audio, or a passed schedule, as public", () => {
    assert.equal(derivePublicationReadiness({ audioSchedule: SCHEDULE }, NOW).spotify, "scheduled");
    const past = { audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-20T05:00:00Z" } };
    assert.equal(derivePublicationReadiness(past, NOW).spotify, "awaiting-public-check");
    assert.equal(derivePublicationReadiness({ ...past, spotify: SPOTIFY }, NOW).spotify, "public");
  });

  it("needs both a reviewed transcript with proof and a verified public episode", () => {
    const scheduledAndReviewed = derivePublicationReadiness({ audioSchedule: SCHEDULE, transcript: TRANSCRIPT }, NOW);
    assert.equal(scheduledAndReviewed.website, "not-recorded");
    assert.deepEqual(scheduledAndReviewed.websiteGate.missing, ["Verified public Spotify episode"]);
    assert.equal(derivePublicationReadiness({ spotify: SPOTIFY }, NOW).website, "not-recorded");
    const noProof = { spotify: SPOTIFY, transcript: { reviewedAt: TRANSCRIPT.reviewedAt } } as any;
    assert.equal(derivePublicationReadiness(noProof, NOW).transcript, "not-recorded");
    assert.equal(derivePublicationReadiness(noProof, NOW).websiteGate.met, false);
    const both = derivePublicationReadiness({ spotify: SPOTIFY, transcript: TRANSCRIPT }, NOW);
    assert.equal(both.website, "ready");
    assert.equal(both.websiteGate.met, true);
    assert.equal(derivePublicationReadiness({ spotify: SPOTIFY, transcript: TRANSCRIPT, website: WEBSITE }, NOW).website, "released");
  });

  it("an observed live page is history: it neither authorises nor satisfies the gate", () => {
    const readiness = derivePublicationReadiness({ websiteObserved: OBSERVED }, NOW);
    assert.equal(readiness.website, "observed-live");
    assert.equal(readiness.websiteGate.met, false);
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
    bad({ website: WEBSITE }, /website needs: Reviewed transcript with proof; Verified public Spotify/);
    bad({ spotify: SPOTIFY, website: WEBSITE }, /Reviewed transcript with proof/);
    bad({ transcript: TRANSCRIPT, website: WEBSITE }, /Verified public Spotify/);
    bad({ spotify: SPOTIFY, transcript: TRANSCRIPT, website: { ...WEBSITE, earlyReason: "x" } }, /Invalid website release/);
    const ok = normalizePublication({
      audioSchedule: { ...SCHEDULE, scheduledAt: "2026-11-21T06:00:00+01:00" },
      spotify: SPOTIFY, transcript: TRANSCRIPT, website: WEBSITE, websiteObserved: OBSERVED,
    }, NOW);
    assert.equal(ok.ok, true);
    assert.equal((ok as any).value.audioSchedule.scheduledAt, "2026-11-21T05:00:00.000Z");
  });

  it("gates entering scheduled and published on real evidence", () => {
    assert.match(statusGateError("published", null), /verified public Spotify/);
    assert.match(statusGateError("published", { audioSchedule: SCHEDULE }), /verified public Spotify/);
    assert.match(statusGateError("published", { websiteObserved: OBSERVED }), /verified public Spotify/);
    assert.equal(statusGateError("published", { spotify: SPOTIFY }), "");
    assert.match(statusGateError("scheduled", { spotify: SPOTIFY }), /scheduling evidence/);
    assert.equal(statusGateError("scheduled", { audioSchedule: SCHEDULE }), "");
    assert.equal(statusGateError("edited", null), "");
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

  it("refuses to record a website release until the gate is met, with no override", async () => {
    const episode = await create({ title: "Synthetic Gate Episode" });
    const early = await put(episode, {
      publication: { transcript: API_TRANSCRIPT, website: { ...API_WEBSITE, earlyReason: "override" } },
    });
    assert.equal(early.statusCode, 400);
    const blocked = await put(episode, { publication: { transcript: API_TRANSCRIPT, website: API_WEBSITE } });
    assert.equal(blocked.statusCode, 400, blocked.body);
    assert.match(data(blocked).error, /Verified public Spotify/);

    const reviewed = data(await put(episode, { publication: { audioSchedule: API_SCHEDULE, transcript: API_TRANSCRIPT } }));
    assert.equal(reviewed.readiness.website, "not-recorded");
    assert.deepEqual(reviewed.readiness.websiteGate.missing, ["Verified public Spotify episode"]);
    assert.equal((await put(reviewed, { publication: { ...reviewed.publication, website: API_WEBSITE } })).statusCode, 400);

    const verified = data(await put(reviewed, { publication: { ...reviewed.publication, spotify: API_SPOTIFY } }));
    assert.equal(verified.readiness.website, "ready");
    const released = data(await put(verified, { publication: { ...verified.publication, website: API_WEBSITE } }));
    assert.equal(released.readiness.website, "released");
  });

  it("records an already-live page as a historical observation without authorising it", async () => {
    const episode = await create({ title: "Synthetic Observed Episode" });
    const observed = await put(episode, { publication: { websiteObserved: API_OBSERVED } });
    assert.equal(observed.statusCode, 200, observed.body);
    const body = data(observed);
    assert.equal(body.readiness.website, "observed-live");
    assert.equal(body.readiness.websiteGate.met, false);
    assert.equal(body.readiness.spotify, "not-recorded");
    assert.equal(body.status, "edited", "observing history does not change status");
    const cleared = data(await put(body, { publication: null }));
    assert.equal(cleared.publication, undefined);
    assert.equal(cleared.readiness.website, "not-recorded");
  });

  it("gates every path into published and scheduled; historical statuses stay", async () => {
    const refused = await invoke("POST", "/api/podcast-episodes", {
      title: "Synthetic Premature", guests: [], status: "published",
    });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.match(data(refused).error, /verified public Spotify/);
    assert.equal((await invoke("POST", "/api/podcast-episodes", { title: "Synthetic Premature", guests: [], status: "scheduled" })).statusCode, 422);

    const episode = await create({ title: "Synthetic Status Gate" });
    assert.equal((await put(episode, { status: "published" })).statusCode, 422);
    const scheduledOnly = data(await put(episode, { publication: { audioSchedule: API_SCHEDULE } }));
    assert.equal((await put(scheduledOnly, { status: "published" })).statusCode, 422, "scheduled audio is not public");
    const scheduledStatus = await put(scheduledOnly, { status: "scheduled" });
    assert.equal(scheduledStatus.statusCode, 200, scheduledStatus.body);
    const sameWrite = await put(data(scheduledStatus), { status: "published", publication: { audioSchedule: API_SCHEDULE, spotify: API_SPOTIFY } });
    assert.equal(sameWrite.statusCode, 200, sameWrite.body);
    assert.equal(data(sameWrite).status, "published");

    // A record that was published before this gate existed keeps its status and
    // can still be edited without evidence being invented.
    const historical = await createPodcastEpisode(client, {
      title: "Synthetic Historical", guests: [{ name: "Grace Sample" }], status: "published",
      releaseDate: "2024-01-01",
    });
    const shown = data(await invoke("GET", `/api/podcast-episodes/${historical.id}`));
    assert.equal(shown.status, "published");
    assert.equal(shown.readiness.spotify, "not-recorded");
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
