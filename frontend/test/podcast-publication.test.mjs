import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  buildPublication, formatPublicationTime, proofLinks, publicationFormValues, samePublication,
  scheduleGroups, utcToZonedLocal, zonedLocalToUtc,
} from "../src/surfaces/podcast/publication-model.js";
import { formChanges } from "../src/surfaces/podcast/detail.js";
import { createPodcastSurface } from "../src/surfaces/podcast/index.js";
import { FakeDocument, FakeElement, findAllByClass, findByText, nextTicks } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

const NOW = "2026-11-01T10:00:00.000Z";
const SPOTIFY = { publicVerifiedAt: "2026-10-01T09:00:00.000Z", episodeUrl: "https://open.spotify.com/episode/synthetic1" };
const PUBLIC = { spotify: "public", transcript: "reviewed", website: "not-recorded", scheduledLocalDate: null };
const NONE = { spotify: "not-recorded", transcript: "not-recorded", website: "not-recorded", scheduledLocalDate: null };
const SCHEDULE_AT = (at, timezone = "UTC") => ({ audioSchedule: { scheduledAt: at, timezone, observedAt: NOW } });

function episode(id, fields = {}) {
  return {
    id, season: 26, episode: 1, title: `Synthetic ${id}`, guests: [{ name: `Guest ${id}` }],
    status: "edited", recordingDate: "2026-10-01", links: {}, cardId: null, card: null, version: 1,
    readiness: NONE,
    ...fields,
  };
}

describe("publication time", () => {
  test("converts wall time to UTC and back in the chosen timezone, across DST", () => {
    assert.equal(zonedLocalToUtc("2026-11-20T06:00", "Europe/Berlin"), "2026-11-20T05:00:00.000Z");
    assert.equal(zonedLocalToUtc("2026-07-20T06:00", "Europe/Berlin"), "2026-07-20T04:00:00.000Z");
    assert.equal(zonedLocalToUtc("2026-11-20T06:00", "Asia/Tokyo"), "2026-11-19T21:00:00.000Z");
    assert.equal(utcToZonedLocal("2026-11-20T05:00:00.000Z", "Europe/Berlin"), "2026-11-20T06:00");
    // 02:30 does not exist on the spring-forward night in Berlin.
    assert.equal(zonedLocalToUtc("2027-03-28T02:30", "Europe/Berlin"), "");
    assert.equal(zonedLocalToUtc("2026-11-20T06:00", "Mars/Base"), "");
    assert.equal(zonedLocalToUtc("tomorrow", "UTC"), "");
  });

  test("formats the evidenced schedule in its own timezone, not the viewer's", () => {
    const text = formatPublicationTime(SCHEDULE_AT("2026-11-19T21:00:00.000Z", "Asia/Tokyo"));
    assert.match(text, /20 Nov 2026/);
    assert.match(text, /06:00/);
    assert.match(text, /\(Asia\/Tokyo\)$/);
    assert.equal(formatPublicationTime({}), "");
    assert.equal(formatPublicationTime(null), "");
  });
});

describe("schedule grouping", () => {
  test("separates upcoming from pages that are out, drops cancelled, keeps history in Past", () => {
    const later = episode("later", { publication: SCHEDULE_AT("2026-12-05T06:00:00.000Z") });
    const sooner = episode("sooner", { publication: SCHEDULE_AT("2026-11-05T06:00:00.000Z") });
    const planned = episode("planned", { releaseDate: "2026-12-31" });
    const released = episode("released", {
      status: "published",
      publication: { website: { releasedAt: NOW, proofUrl: "https://example.com/p" } },
      readiness: { ...PUBLIC, website: "released" },
    });
    const observed = episode("observed", {
      status: "published",
      publication: { websiteObserved: { observedAt: NOW, proofUrl: "https://example.com/p" } },
      readiness: { ...NONE, website: "observed-live" },
    });
    const historical = episode("historical", { status: "published", releaseDate: "2020-01-01" });
    const cancelled = episode("cancelled", { status: "cancelled" });
    const [upcoming, past] = scheduleGroups([later, planned, released, observed, historical, cancelled, sooner]);
    assert.deepEqual(upcoming.episodes.map((item) => item.id), ["sooner", "later", "planned"]);
    assert.deepEqual(past.episodes.map((item) => item.id).sort(), ["historical", "observed", "released"]);
  });

  test("a live page observation does not retire an episode still awaiting audio publication", () => {
    const unfinished = episode("unfinished", {
      status: "recorded", releaseDate: "2099-01-01",
      publication: { websiteObserved: { observedAt: NOW, proofUrl: "https://example.com/p" } },
      readiness: { ...NONE, website: "observed-live" },
    });
    assert.deepEqual(scheduleGroups([unfinished])[0].episodes.map((item) => item.id), ["unfinished"]);
  });

  test("verified public audio stays in Past while website evidence is unrecorded", () => {
    const audioPublic = episode("audio-public", {
      status: "published", releaseDate: "2020-01-01",
      publication: { spotify: SPOTIFY },
      readiness: { ...NONE, spotify: "public" },
    });
    const [upcoming, past] = scheduleGroups([audioPublic]);
    assert.deepEqual(upcoming.episodes, []);
    assert.deepEqual(past.episodes.map((item) => item.id), ["audio-public"]);
  });

  test("a scheduled episode stays upcoming even when its status says published", () => {
    const premature = episode("premature", {
      status: "published",
      publication: SCHEDULE_AT("2026-10-01T06:00:00.000Z"),
      readiness: { ...NONE, spotify: "awaiting-public-check" },
    });
    assert.deepEqual(scheduleGroups([premature])[0].episodes.map((item) => item.id), ["premature"]);
  });

  test("proof links come only from recorded facts", () => {
    assert.deepEqual(proofLinks(episode("x")), []);
    const links = proofLinks(episode("x", { publication: { spotify: SPOTIFY, websiteObserved: { observedAt: NOW, proofUrl: "https://example.com/p" } } }));
    assert.deepEqual(links.map((link) => link.id), ["spotify", "observed"]);
  });
});

describe("publication form", () => {
  const values = (extra = {}) => ({
    timezone: "", audioScheduledLocal: "", scheduleProofUrl: "", spotifyVerified: false, spotifyUrl: "",
    transcriptReviewed: false, transcriptUrl: "", websiteUrl: "", websiteObservedUrl: "", ...extra,
  });
  const PROOF = "https://example.com/transcript-review";

  test("builds the publication body and keeps observation times already recorded", () => {
    assert.deepEqual(buildPublication(null, values(), NOW), { value: null });
    const full = values({
      timezone: "Europe/Berlin", audioScheduledLocal: "2026-11-20T06:00",
      spotifyVerified: true, spotifyUrl: SPOTIFY.episodeUrl, transcriptReviewed: true, transcriptUrl: PROOF,
      websiteObservedUrl: "https://example.com/live",
    });
    const built = buildPublication(null, full, NOW);
    assert.deepEqual(built.value, {
      audioSchedule: { scheduledAt: "2026-11-20T05:00:00.000Z", timezone: "Europe/Berlin", observedAt: NOW },
      spotify: { publicVerifiedAt: NOW, episodeUrl: SPOTIFY.episodeUrl },
      transcript: { reviewedAt: NOW, proofUrl: PROOF },
      websiteObserved: { observedAt: NOW, proofUrl: "https://example.com/live" },
    });
    const later = buildPublication(built.value, full, "2027-01-01T00:00:00.000Z");
    assert.ok(samePublication(later.value, built.value), "re-saving the same facts changes nothing");
  });

  test("refuses what the form can catch: half a schedule, missing proofs, bad zone", () => {
    assert.match(buildPublication(null, values({ audioScheduledLocal: "2026-11-20T06:00" }), NOW).error, /timezone/i);
    assert.match(buildPublication(null, values({ timezone: "UTC" }), NOW).error, /scheduled time/i);
    assert.match(buildPublication(null, values({ spotifyVerified: true }), NOW).error, /Spotify/);
    assert.match(buildPublication(null, values({ transcriptReviewed: true }), NOW).error, /proof/);
    assert.match(buildPublication(null, values({ timezone: "Nowhere", audioScheduledLocal: "2026-11-20T06:00" }), NOW).error, /IANA/);
    assert.match(buildPublication(null, values({ scheduleProofUrl: "https://example.com/s" }), NOW).error, /scheduled time/i);
  });

  test("formChanges sends publication only when it changed and never touches the intended date", () => {
    const base = episode("form", { releaseDate: "2026-10-01" });
    const form = (extra) => ({ title: base.title, guests: "Guest form", season: "26", episode: "1", recordingDate: "2026-10-01", releaseDate: "2026-10-01", websiteSlug: "", notes: "", ...values(extra) });
    assert.deepEqual(formChanges(base, form({}), NOW), {});
    const changes = formChanges(base, form({ timezone: "UTC", audioScheduledLocal: "2026-12-01T08:00" }), NOW);
    assert.deepEqual(changes.publication, { audioSchedule: { scheduledAt: "2026-12-01T08:00:00.000Z", timezone: "UTC", observedAt: NOW } });
    assert.equal(changes.releaseDate, undefined);
    assert.throws(() => formChanges(base, form({ audioScheduledLocal: "2026-12-01T08:00" }), NOW), /timezone/i);
    const stored = episode("form2", { publication: changes.publication });
    assert.equal(publicationFormValues(stored).audioScheduledLocal, "2026-12-01T08:00");
    assert.equal(formChanges(stored, form({}), NOW).publication, null);
  });

  test("a Spotify link in links is not pre-filled as verification", () => {
    const linked = episode("linked", { links: { spotify: SPOTIFY.episodeUrl } });
    assert.equal(publicationFormValues(linked).spotifyVerified, false);
    assert.equal(publicationFormValues(linked).spotifyUrl, "");
  });
});

function harness(episodes) {
  const documentList = new FakeElement("main");
  const body = new FakeElement("body");
  const document = new FakeDocument(documentList, body);
  document.body = body;
  globalThis.document = document;
  const calls = [];
  const surface = createPodcastSurface({
    apiUrl: (path) => new URL(path, "https://dataops.test"),
    documentList,
    documentRef: document,
    getActiveWorkspaceRoute: () => ({ path: "/podcast/schedule", params: new URLSearchParams() }),
    getActiveWorkspaceView: () => "podcast",
    navigateCanonicalWorkspace: (path, params = {}) => calls.push(["navigate", path, params]),
    request: async () => ({ items: episodes }),
    setRouteTitle: () => {},
    getDialogs: () => undefined,
    getSplit: () => undefined,
  });
  return { surface, documentList, calls };
}

describe("Podcast schedule view", () => {
  const card = { id: "card-1", title: "Synthetic card", stage: "preparation", taskCount: 8, openTaskCount: 5 };
  const records = [
    episode("a-scheduled", {
      cardId: "card-1", card, releaseDate: "2099-01-05",
      publication: SCHEDULE_AT("2099-01-01T05:00:00.000Z", "Europe/Berlin"),
      readiness: { ...NONE, spotify: "scheduled" },
    }),
    episode("b-ready", {
      publication: { ...SCHEDULE_AT("2026-10-01T05:00:00.000Z"), spotify: SPOTIFY, transcript: { reviewedAt: NOW, proofUrl: "https://example.com/transcript" } },
      readiness: PUBLIC,
    }),
    episode("c-planned", { releaseDate: "2026-12-24" }),
    episode("d-out", {
      status: "published",
      publication: { spotify: SPOTIFY, transcript: { reviewedAt: NOW, proofUrl: "https://example.com/t" }, website: { releasedAt: NOW, proofUrl: "https://example.com/page" } },
      readiness: { ...PUBLIC, website: "released" },
    }),
    episode("e-history", { status: "published", releaseDate: "2024-03-01" }),
  ];

  test("shows the plan apart from Spotify evidence, says not recorded without it, and links card and proofs", async () => {
    const { surface, documentList, calls } = harness(records);
    surface.renderPodcastSurface();
    await nextTicks(4);
    assert.ok(findByText(documentList, "Upcoming (2)", "h3"));
    assert.ok(findByText(documentList, "Past (3)", "h3"));
    const rowOf = (id) => findAllByClass(documentList, "podcast-schedule__row").find((row) => row.dataset.episodeId === id);
    const chips = (row) => Object.fromEntries(findAllByClass(row, "podcast-readiness").map((chip) => [chip.dataset.track, chip.dataset.state]));
    assert.deepEqual(chips(rowOf("a-scheduled")), { spotify: "scheduled", transcript: "not-recorded", website: "not-recorded" });
    assert.deepEqual(chips(rowOf("b-ready")), { spotify: "public", transcript: "reviewed", website: "not-recorded" });
    assert.deepEqual(chips(rowOf("e-history")), { spotify: "not-recorded", transcript: "not-recorded", website: "not-recorded" });
    assert.ok(findByText(rowOf("e-history"), "Not recorded"));
    assert.ok(!findAllByClass(rowOf("e-history"), "podcast-readiness").some((chip) => /not scheduled|blocked/i.test(chip.textContent)));
    // The intended date and the evidenced Spotify time are two separate things.
    const planned = findAllByClass(rowOf("a-scheduled"), "podcast-schedule__when")[0].textContent;
    assert.match(planned, /5 Jan 2099/);
    const evidence = findAllByClass(rowOf("a-scheduled"), "podcast-schedule__evidence")[0].textContent;
    assert.match(evidence, /1 Jan 2099/);
    assert.match(evidence, /06:00/);
    assert.equal(findAllByClass(rowOf("c-planned"), "podcast-schedule__evidence").length, 0, "a plan alone shows no Spotify claim");
    assert.deepEqual(chips(rowOf("c-planned")).spotify, "not-recorded");
    assert.ok(findByText(rowOf("a-scheduled"), "5/8 open"));
    assert.equal(findAllByClass(rowOf("b-ready"), "podcast-proof").length, 2);
    assert.ok(findByText(rowOf("a-scheduled"), "None recorded"));
    const cardLink = findAllByClass(rowOf("a-scheduled"), "podcast-schedule__card")[0];
    // A link to the Card's own page: the app opens it over the schedule.
    assert.equal(cardLink.href, "/cards?cardId=card-1");
    const tabs = findAllByClass(documentList, "dk-tab");
    assert.deepEqual(tabs.map((tab) => tab.getAttribute("aria-current")), [null, null, "page"]);
  });
});
