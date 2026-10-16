import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  buildSeasonGrid, countsLabel, episodeFlag, formatAge, STALE_DAYS,
} from "../src/surfaces/podcast/seasons-model.js";
import { createPodcastSurface } from "../src/surfaces/podcast/index.js";
import { FakeDocument, FakeElement, findAllByClass, findByText, nextTicks } from "./support/fake-dom.mjs";

const TODAY = "2026-10-15";
const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function episode(id, fields = {}) {
  return {
    id,
    season: 3,
    episode: 1,
    title: `Synthetic ${id}`,
    guests: [{ name: `Guest ${id}` }],
    status: "published",
    recordingDate: null,
    releaseDate: "2021-01-01",
    links: {},
    version: 1,
    ...fields,
  };
}

// Season 3 holds E1, two E4s and no E2/E3; season 4 is in flight; three
// in-flight episodes have no number; one old episode has no season at all.
const REGISTER = [
  episode("s3e1"),
  episode("s3e4a", { episode: 4, releaseDate: "2021-03-01", links: { youtube: "https://youtube.example/watch?v=a" } }),
  episode("s3e4b", { episode: 4, releaseDate: "2021-04-01" }),
  episode("s4e1", { season: 4, episode: 1 }),
  episode("s4e2", { season: 4, episode: 2, status: "recorded", recordingDate: "2026-09-30", releaseDate: "2026-10-16" }),
  episode("kim", { season: null, episode: null, status: "recorded", recordingDate: "2026-06-15", releaseDate: null }),
  episode("booked", { season: null, episode: null, status: "booked", recordingDate: "2026-11-02", releaseDate: null }),
  episode("late", { season: 4, episode: null, status: "booked", recordingDate: "2026-10-01", releaseDate: null }),
  episode("loose", { season: null, episode: null, releaseDate: "2019-01-01" }),
];

describe("seasons model", () => {
  test("flags recorded or edited episodes that sat too long, and booked or scheduled ones past their date", () => {
    const recordedOn = (days) => new Date(Date.UTC(2026, 9, 15) - days * 86400000).toISOString().slice(0, 10);
    assert.equal(episodeFlag({ status: "recorded", recordingDate: recordedOn(STALE_DAYS - 1) }, TODAY), null);
    assert.deepEqual(episodeFlag({ status: "edited", recordingDate: recordedOn(STALE_DAYS) }, TODAY), {
      kind: "stale", days: STALE_DAYS, text: "Edited 6 weeks after recording",
    });
    assert.equal(episodeFlag({ status: "recorded", recordingDate: "2026-06-15" }, TODAY).text, "Recorded 4 months after recording");
    assert.equal(episodeFlag({ status: "booked", recordingDate: "2026-10-12" }, TODAY).text, "Recording date passed 3 days ago");
    assert.equal(episodeFlag({ status: "scheduled", releaseDate: "2026-10-14" }, TODAY).kind, "overdue");
    assert.equal(episodeFlag({ status: "published", recordingDate: "2020-01-01" }, TODAY), null);
    assert.equal(episodeFlag({ status: "recorded" }, TODAY), null, "no recording date, no claim");
    assert.equal(formatAge(1), "1 day");
  });

  test("seasons run newest first with gaps and duplicates in number order", () => {
    const grid = buildSeasonGrid(REGISTER, TODAY);
    assert.deepEqual(grid.seasons.map((row) => row.season), [4, 3]);
    const s3 = grid.seasons[1];
    assert.deepEqual(
      s3.cells.map((cell) => (cell.kind === "gap" ? `gap${cell.number}` : `${cell.episode.id}${cell.duplicate ? "*" : ""}`)),
      ["s3e1", "gap2", "gap3", "s3e4a*", "s3e4b*"],
    );
    assert.equal(countsLabel(grid.seasons[0].counts), "1 published · 1 recorded");
    assert.equal(countsLabel({ booked: 1, published: 6, recorded: 1 }), "6 published · 1 recorded · 1 booked");
    assert.deepEqual(grid.pipeline.map((item) => item.episode.id), ["kim", "late", "booked"]);
    assert.equal(grid.pipeline[0].flag.kind, "stale");
    assert.equal(grid.pipeline[1].flag.kind, "overdue");
    assert.equal(grid.pipeline[2].flag, null);
    assert.deepEqual(grid.loose.map((item) => item.id), ["loose"]);
  });
});

function harness({ routeId = "", view = "" } = {}) {
  const documentList = new FakeElement("main");
  const body = new FakeElement("body");
  const document = new FakeDocument(documentList, body);
  document.body = body;
  globalThis.document = document;
  let route = { params: new URLSearchParams({ ...(view ? { view } : {}), ...(routeId ? { episodeId: routeId } : {}) }) };
  const calls = [];
  const surface = createPodcastSurface({
    apiUrl: (path) => new URL(path, "https://dataops.test"),
    documentList,
    documentRef: document,
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceView: () => "podcast",
    navigateCanonicalWorkspace: (path, params = {}, options = {}) => {
      calls.push(["navigate", path, params, options]);
      const match = /^\/podcast\/(.+)$/.exec(path);
      route = { params: new URLSearchParams({ ...params, ...(match ? { episodeId: decodeURIComponent(match[1]) } : {}) }) };
      if (options.render !== false) surface.renderPodcastSurface();
    },
    request: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/podcast-episodes") return { items: REGISTER };
      throw new Error(`unexpected ${path}`);
    },
    setRouteTitle: () => {},
    getDialogs: () => undefined,
    getSplit: () => ({ show: () => {} }),
    today: () => TODAY,
  });
  return { surface, documentList, calls };
}

describe("Podcast seasons view", () => {
  test("is the default: cells per season, gaps, duplicates, and the unnumbered lane, full width", async () => {
    const { surface, documentList } = harness();
    surface.renderPodcastSurface();
    await nextTicks(4);
    const tabs = documentList.querySelector(".podcast-views");
    assert.equal(tabs.querySelector('[data-podcast-view="seasons"]').getAttribute("aria-current"), "page");
    assert.equal(tabs.querySelector('[data-podcast-view="list"]').href, "/podcast?view=list");
    assert.equal(documentList.querySelector(".dk-split").dataset.dkSplit, "podcast-seasons");
    assert.equal(documentList.querySelector(".podcast-status-filter"), null, "the grid has no status filter");

    const seasons = documentList.querySelectorAll(".podcast-season").map((row) => row.dataset.season);
    assert.deepEqual(seasons, ["4", "3"]);
    const s3 = documentList.querySelector('.podcast-season[data-season="3"]');
    assert.ok(findByText(s3, "3 published", ".podcast-season__counts"));
    assert.equal(s3.querySelector(".podcast-season__head").children.length, 2, "title and counts; gaps show only as dashed cells");
    assert.deepEqual(findAllByClass(s3, "podcast-cell").map((cell) => cell.textContent), ["E1", "E2", "E3", "E4", "E4"]);
    assert.equal(findAllByClass(s3, "podcast-cell--gap").length, 2);
    const duplicate = s3.querySelector('[data-episode-id="s3e4a"]');
    assert.ok(duplicate.classList.contains("podcast-cell--duplicate"));
    assert.match(duplicate.getAttribute("aria-label"), /^S3E4, Published, Guest s3e4a — Synthetic s3e4a, number used twice$/);
    const recorded = documentList.querySelector('[data-episode-id="s4e2"]');
    assert.equal(recorded.dataset.status, "recorded");
    assert.equal(recorded.dataset.flag, undefined, "recorded two weeks ago is not stuck");

    const lane = documentList.querySelector(".podcast-pipeline");
    assert.ok(findByText(lane, "Not yet numbered", "h3"));
    assert.deepEqual(findAllByClass(lane, "dk-split__item").map((row) => row.dataset.episodeId), ["kim", "late", "booked"]);
    assert.ok(findByText(lane.querySelector('[data-episode-id="kim"]'), "Stuck"));
    assert.ok(findByText(lane.querySelector('[data-episode-id="late"]'), "Late"));
    assert.ok(findByText(documentList, "No season", "h3"));

    const split = documentList.querySelector(".dk-split");
    assert.equal(split.dataset.pane, "closed");
    assert.equal(documentList.querySelector(".dk-split__detail"), null, "no pane until an episode opens");
  });

  test("a cell opens the episode in place; Back and the List tab keep the view in the URL", async () => {
    const { surface, documentList, calls } = harness();
    surface.renderPodcastSurface();
    await nextTicks(4);
    await documentList.querySelector('.podcast-cell[data-episode-id="s3e4b"]').dispatch("click", { button: 0 });
    assert.deepEqual(calls.at(-1), ["navigate", "/podcast/s3e4b", {}, { render: false }]);
    assert.equal(documentList.querySelector('.podcast-cell[data-episode-id="s3e4b"]').getAttribute("aria-current"), "true");
    assert.equal(documentList.querySelector(".dk-split").dataset.pane, "open");
    assert.ok(findByText(documentList.querySelector(".dk-split__detail"), "Synthetic s3e4b", "h2"));

    await documentList.querySelector(".podcast-detail-close").dispatch("click");
    assert.deepEqual(calls.at(-1), ["navigate", "/podcast", {}, { restoreFocus: { kind: "split-list" } }]);
    assert.equal(documentList.querySelector(".dk-split__detail"), null);
    await documentList.querySelector('.podcast-cell[data-episode-id="s3e4b"]').dispatch("click", { button: 0 });

    await documentList.querySelector('[data-podcast-view="list"]').dispatch("click", { button: 0 });
    assert.deepEqual(calls.at(-1), ["navigate", "/podcast/s3e4b", { view: "list" }, {}]);
    assert.ok(documentList.querySelector(".podcast-status-filter"), "the list keeps its filters");
    assert.equal(documentList.querySelector(".podcast-season"), null);
  });

  test("search dims cells that do not match and drops seasons with no match", async () => {
    const { surface, documentList } = harness();
    surface.renderPodcastSurface();
    await nextTicks(4);
    const search = documentList.querySelector(".podcast-search");
    search.value = "s3e4a";
    await search.dispatch("input");
    assert.deepEqual(documentList.querySelectorAll(".podcast-season").map((row) => row.dataset.season), ["3"]);
    assert.equal(documentList.querySelector('[data-episode-id="s3e4a"]').classList.contains("is-dimmed"), false);
    assert.equal(documentList.querySelector('[data-episode-id="s3e1"]').classList.contains("is-dimmed"), true);
    assert.equal(documentList.querySelector(".podcast-pipeline"), null);
    const again = documentList.querySelector(".podcast-search");
    again.value = "nobody at all";
    await again.dispatch("input");
    assert.ok(findByText(documentList, "No matches"));
  });
});
