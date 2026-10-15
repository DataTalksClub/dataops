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
const READY = { spotify: "public", transcript: "reviewed", website: "ready", websiteBlockers: [], scheduledLocalDate: null };
const BLOCKED = (spotify, transcript, blockers) => ({ spotify, transcript, website: "blocked", websiteBlockers: blockers, scheduledLocalDate: null });

function episode(id, fields = {}) {
  return {
    id, season: 26, episode: 1, title: `Synthetic ${id}`, guests: [{ name: `Guest ${id}` }],
    status: "edited", recordingDate: "2026-10-01", links: {}, cardId: null, card: null, version: 1,
    readiness: BLOCKED("not-scheduled", "pending", ["Transcript not reviewed", "Spotify episode not verified public"]),
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

  test("formats the schedule in its own timezone, not the viewer's", () => {
    const text = formatPublicationTime({ timezone: "Asia/Tokyo", audioScheduledAt: "2026-11-19T21:00:00.000Z" });
    assert.match(text, /20 Nov 2026/);
    assert.match(text, /06:00/);
    assert.match(text, /\(Asia\/Tokyo\)$/);
    assert.equal(formatPublicationTime({ audioScheduledAt: "2026-11-19T21:00:00.000Z" }), "");
  });
});

describe("schedule grouping", () => {
  test("separates upcoming from released, orders by scheduled instant, drops cancelled", () => {
    const later = episode("later", { publication: { timezone: "UTC", audioScheduledAt: "2026-12-05T06:00:00.000Z" } });
    const sooner = episode("sooner", { publication: { timezone: "UTC", audioScheduledAt: "2026-11-05T06:00:00.000Z" } });
    const unscheduled = episode("unscheduled");
    const released = episode("released", {
      status: "published",
      publication: { website: { releasedAt: NOW, proofUrl: "https://example.com/p" } },
      readiness: { ...READY, website: "released" },
    });
    const legacy = episode("legacy", { status: "published", releaseDate: "2020-01-01" });
    const cancelled = episode("cancelled", { status: "cancelled" });
    const [upcoming, past] = scheduleGroups([later, unscheduled, released, legacy, cancelled, sooner]);
    assert.deepEqual(upcoming.episodes.map((item) => item.id), ["sooner", "later", "unscheduled"]);
    assert.deepEqual(past.episodes.map((item) => item.id).sort(), ["legacy", "released"]);
  });

  test("a scheduled episode stays upcoming even when its status says published", () => {
    const premature = episode("premature", {
      status: "published",
      publication: { timezone: "UTC", audioScheduledAt: "2026-10-01T06:00:00.000Z" },
      readiness: BLOCKED("awaiting-public-check", "pending", ["Transcript not reviewed", "Spotify episode not verified public"]),
    });
    assert.deepEqual(scheduleGroups([premature])[0].episodes.map((item) => item.id), ["premature"]);
  });

  test("proof links come only from recorded facts", () => {
    assert.deepEqual(proofLinks(episode("x")), []);
    const links = proofLinks(episode("x", { publication: { spotify: SPOTIFY, website: { releasedAt: NOW, proofUrl: "https://example.com/p" } } }));
    assert.deepEqual(links.map((link) => link.id), ["spotify", "website"]);
  });
});

describe("publication form", () => {
  const values = (extra = {}) => ({
    timezone: "", audioScheduledLocal: "", spotifyVerified: false, spotifyUrl: "", transcriptReviewed: false,
    transcriptUrl: "", websiteUrl: "", websiteEarlyReason: "", ...extra,
  });

  test("builds the publication body and keeps timestamps already recorded", () => {
    assert.deepEqual(buildPublication(null, values(), NOW), { value: null });
    const built = buildPublication(null, values({
      timezone: "Europe/Berlin", audioScheduledLocal: "2026-11-20T06:00",
      spotifyVerified: true, spotifyUrl: SPOTIFY.episodeUrl, transcriptReviewed: true,
    }), NOW);
    assert.deepEqual(built.value, {
      timezone: "Europe/Berlin",
      audioScheduledAt: "2026-11-20T05:00:00.000Z",
      spotify: { publicVerifiedAt: NOW, episodeUrl: SPOTIFY.episodeUrl },
      transcript: { reviewedAt: NOW },
    });
    const later = buildPublication(built.value, values({
      timezone: "Europe/Berlin", audioScheduledLocal: "2026-11-20T06:00",
      spotifyVerified: true, spotifyUrl: SPOTIFY.episodeUrl, transcriptReviewed: true,
    }), "2027-01-01T00:00:00.000Z");
    assert.ok(samePublication(later.value, built.value), "re-saving the same facts changes nothing");
  });

  test("refuses what the form can catch: no timezone, missing proof, bad zone", () => {
    assert.match(buildPublication(null, values({ audioScheduledLocal: "2026-11-20T06:00" }), NOW).error, /timezone/i);
    assert.match(buildPublication(null, values({ spotifyVerified: true }), NOW).error, /Spotify/);
    assert.match(buildPublication(null, values({ timezone: "Nowhere" }), NOW).error, /IANA/);
  });

  test("formChanges sends publication only when it changed and leaves releaseDate to the API", () => {
    const base = episode("form", { releaseDate: "2026-10-01" });
    const form = (extra) => ({ title: base.title, guests: "Guest form", season: "26", episode: "1", recordingDate: "2026-10-01", releaseDate: "2026-10-01", websiteSlug: "", notes: "", ...values(extra) });
    assert.deepEqual(formChanges(base, form({}), NOW), {});
    const changes = formChanges(base, form({ timezone: "UTC", audioScheduledLocal: "2026-12-01T08:00", releaseDate: "2026-12-01" }), NOW);
    assert.deepEqual(changes.publication, { timezone: "UTC", audioScheduledAt: "2026-12-01T08:00:00.000Z" });
    assert.equal(changes.releaseDate, undefined);
    assert.throws(() => formChanges(base, form({ audioScheduledLocal: "2026-12-01T08:00" }), NOW), /timezone/i);
    const stored = episode("form2", { publication: changes.publication });
    assert.deepEqual(publicationFormValues(stored).audioScheduledLocal, "2026-12-01T08:00");
    const cleared = formChanges(stored, form({}), NOW);
    assert.equal(cleared.publication, null);
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
      cardId: "card-1", card,
      publication: { timezone: "Europe/Berlin", audioScheduledAt: "2099-01-01T05:00:00.000Z" },
      readiness: BLOCKED("scheduled", "pending", ["Transcript not reviewed", "Spotify episode not verified public"]),
    }),
    episode("b-ready", {
      publication: { timezone: "UTC", audioScheduledAt: "2026-10-01T05:00:00.000Z", spotify: SPOTIFY, transcript: { reviewedAt: NOW, proofUrl: "https://example.com/transcript" } },
      readiness: READY,
    }),
    episode("c-out", {
      status: "published",
      publication: { spotify: SPOTIFY, transcript: { reviewedAt: NOW }, website: { releasedAt: NOW, proofUrl: "https://example.com/page" } },
      readiness: { ...READY, website: "released" },
    }),
  ];

  test("shows audio scheduled apart from public Spotify, with blockers, card tasks and proofs", async () => {
    const { surface, documentList, calls } = harness(records);
    surface.renderPodcastSurface();
    await nextTicks(4);
    assert.ok(findByText(documentList, "Upcoming (2)", "h3"));
    assert.ok(findByText(documentList, "Past (1)", "h3"));
    const rowOf = (id) => findAllByClass(documentList, "podcast-schedule__row").find((row) => row.dataset.episodeId === id);
    const chips = (row) => Object.fromEntries(findAllByClass(row, "podcast-readiness").map((chip) => [chip.dataset.track, chip.dataset.state]));
    assert.deepEqual(chips(rowOf("a-scheduled")), { spotify: "scheduled", transcript: "pending", website: "blocked" });
    assert.deepEqual(chips(rowOf("b-ready")), { spotify: "public", transcript: "reviewed", website: "ready" });
    assert.deepEqual(chips(rowOf("c-out")), { spotify: "public", transcript: "reviewed", website: "released" });
    assert.ok(findByText(rowOf("a-scheduled"), "Audio scheduled"));
    assert.equal(
      findAllByClass(rowOf("a-scheduled"), "podcast-readiness").find((chip) => chip.dataset.track === "website").title,
      "Transcript not reviewed; Spotify episode not verified public",
    );
    const when = findAllByClass(rowOf("a-scheduled"), "podcast-schedule__when")[0].textContent;
    assert.match(when, /1 Jan 2099/);
    assert.match(when, /06:00/);
    assert.ok(findByText(rowOf("a-scheduled"), "5/8 open"));
    assert.equal(findAllByClass(rowOf("b-ready"), "podcast-proof").length, 2);
    assert.ok(findByText(rowOf("a-scheduled"), "None recorded"));
    assert.equal(findByText(rowOf("b-ready"), "None recorded"), undefined);
    const cardLink = findAllByClass(rowOf("a-scheduled"), "podcast-schedule__card")[0];
    assert.equal(cardLink.href, "/cards?cardId=card-1");
    await cardLink.click();
    assert.deepEqual(calls.at(-1), ["navigate", "/cards", { cardId: "card-1" }]);
    const tabs = findAllByClass(documentList, "dk-tab");
    assert.deepEqual(tabs.map((tab) => tab.getAttribute("aria-current")), [null, "page"]);
  });
});
