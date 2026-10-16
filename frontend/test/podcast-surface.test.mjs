import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  episodeCode, episodeKeyDate, episodeSummary, episodeTitle, filterEpisodes, groupEpisodes,
  parseGuestNames, seasonsOf, suggestNextNumber,
} from "../src/surfaces/podcast/model.js";
import { formChanges } from "../src/surfaces/podcast/detail.js";
import { createBody } from "../src/surfaces/podcast/create-dialog.js";
import { createPodcastSurface } from "../src/surfaces/podcast/index.js";
import { FakeDocument, FakeElement, findAllByClass, findByText, nextTicks } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function episode(id, fields = {}) {
  return {
    id,
    season: 25,
    episode: 1,
    title: `Synthetic ${id}`,
    guests: [{ name: `Guest ${id}` }],
    status: "booked",
    recordingDate: "2026-11-04",
    links: {},
    cardId: null,
    card: null,
    version: 1,
    ...fields,
  };
}

const REGISTER = [
  episode("booked-late", { episode: 5, recordingDate: "2026-12-01" }),
  episode("booked-soon", { episode: 4, recordingDate: "2026-11-02" }),
  episode("scheduled", { episode: 3, status: "scheduled", releaseDate: "2026-11-20", recordingDate: "2026-10-01" }),
  episode("pub-25", { episode: 2, status: "published", releaseDate: "2026-09-01" }),
  episode("pub-24", { season: 24, episode: 9, status: "published", releaseDate: "2026-03-01" }),
  episode("cancelled", { season: 24, episode: 8, status: "cancelled" }),
  episode("loose", { season: null, episode: null, status: "published", releaseDate: "2020-01-01" }),
];

describe("podcast model", () => {
  test("codes, titles and summaries read from the record", () => {
    assert.equal(episodeCode({ season: 25, episode: 3 }), "S25E3");
    assert.equal(episodeCode({ season: 25 }), "S25");
    assert.equal(episodeCode({}), "");
    assert.equal(episodeSummary({ title: "Shipping ML", guests: [{ name: "Ada" }, { name: "Bo" }] }), "Ada, Bo — Shipping ML");
    assert.equal(episodeSummary({ guests: [] }), "Untitled episode");
    assert.equal(episodeTitle({ guests: [{ name: "Ada" }] }), "Podcast with Ada");
  });

  test("the key date is the recording while booked and the release after", () => {
    assert.deepEqual(episodeKeyDate({ status: "booked", recordingDate: "2026-11-04", releaseDate: "2026-12-01" }), { kind: "recording", value: "2026-11-04" });
    assert.deepEqual(episodeKeyDate({ status: "edited", recordingDate: "2026-11-04" }), { kind: "recording", value: "2026-11-04" });
    assert.deepEqual(episodeKeyDate({ status: "published", releaseDate: "2026-12-01" }), { kind: "release", value: "2026-12-01" });
  });

  test("groups upcoming first by date, then seasons newest first, then unnumbered", () => {
    const groups = groupEpisodes(REGISTER);
    assert.deepEqual(groups.map((group) => group.label), ["Upcoming", "Season 25", "Season 24", "No season"]);
    assert.deepEqual(groups[0].episodes.map((item) => item.id), ["booked-soon", "scheduled", "booked-late"]);
    assert.deepEqual(groups[2].episodes.map((item) => item.id), ["pub-24", "cancelled"]);
  });

  test("filters by status, season and guest or title", () => {
    assert.deepEqual(filterEpisodes(REGISTER, { status: "upcoming" }).map((item) => item.id), ["booked-late", "booked-soon", "scheduled"]);
    assert.deepEqual(filterEpisodes(REGISTER, { status: "published", season: "24" }).map((item) => item.id), ["pub-24"]);
    assert.deepEqual(filterEpisodes(REGISTER, { status: "all", query: "guest pub-25" }).map((item) => item.id), ["pub-25"]);
    assert.deepEqual(filterEpisodes(REGISTER, { status: "all", query: "s24e9" }).map((item) => item.id), ["pub-24"]);
    assert.deepEqual(seasonsOf(REGISTER), [25, 24]);
  });

  test("suggests the next free number and keeps guest slugs by name", () => {
    assert.deepEqual(suggestNextNumber(REGISTER), { season: 25, episode: 6 });
    assert.deepEqual(suggestNextNumber([]), { season: null, episode: null });
    assert.deepEqual(parseGuestNames("Ada Example, Bo", [{ name: "ada example", slug: "ada" }]), [{ name: "Ada Example", slug: "ada" }, { name: "Bo" }]);
  });

  test("form changes carry only what moved, clearing with null", () => {
    const record = episode("e", { links: { youtube: "https://y.example/1" }, notes: "Old" });
    assert.deepEqual(
      formChanges(record, {
        title: record.title, guests: "Guest e", season: "25", episode: "2", recordingDate: "2026-11-04",
        releaseDate: "2026-12-24", websiteSlug: "", notes: "", "link-youtube": "", "link-spotify": "https://s.example/1",
      }),
      { episode: 2, releaseDate: "2026-12-24", notes: null, links: { spotify: "https://s.example/1" } },
    );
    assert.deepEqual(createBody({ guests: "Ada", title: "", season: "26", episode: "", status: "" }), {
      status: "booked", guests: [{ name: "Ada" }], season: 26,
    });
  });
});

function harness({ episodes = REGISTER, routeId = "", view = "", handlers = {}, today = "2026-10-15" } = {}) {
  const documentList = new FakeElement("main");
  const body = new FakeElement("body");
  const document = new FakeDocument(documentList, body);
  document.body = body;
  globalThis.document = document;
  let route = { params: new URLSearchParams({ ...(view ? { view } : {}), ...(routeId ? { episodeId: routeId } : {}) }) };
  const calls = [];
  const shown = [];
  let records = episodes.map((item) => ({ ...item }));
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
      if (path.startsWith("/podcast") && options.render !== false) surface.renderPodcastSurface();
    },
    request: async (url, options = {}) => {
      const method = options.method || "GET";
      const path = new URL(url).pathname;
      const payload = options.body ? JSON.parse(options.body) : undefined;
      calls.push([method, path, payload]);
      const handler = handlers[`${method} ${path}`];
      if (handler) return handler(payload, records);
      if (method === "GET" && path === "/api/podcast-episodes") return { items: records };
      const id = decodeURIComponent(path.split("/")[3] || "");
      if (method === "GET") {
        const found = records.find((item) => item.id === id);
        if (!found) throw Object.assign(new Error("Not found"), { status: 404 });
        return found;
      }
      if (method === "PUT") {
        const current = records.find((item) => item.id === id);
        if (payload.version !== current.version) throw Object.assign(new Error("Episode changed; reload and retry"), { status: 409 });
        const { version, ...changes } = payload;
        const next = { ...current, ...changes, version: version + 1 };
        delete next.card;
        records = records.map((item) => (item.id === id ? { ...next, card: current.card } : item));
        return next;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    setRouteTitle: (title) => calls.push(["title", title]),
    getDialogs: () => undefined,
    getSplit: () => ({ show: (split, pane) => shown.push(pane) }),
    today: () => today,
  });
  return {
    surface, documentList, document, calls, shown,
    setRecords: (next) => { records = next; },
    get records() { return records; },
  };
}

function rows(root) {
  return findAllByClass(root, "dk-split__item").map((row) => row.dataset.episodeId);
}

describe("Podcast surface", () => {
  test("loads, lists upcoming episodes grouped, and filters with the segmented control", async () => {
    const { surface, documentList, calls } = harness({ view: "list" });
    surface.renderPodcastSurface();
    assert.ok(findByText(documentList, "Loading episodes…"));
    await nextTicks(4);
    assert.ok(findByText(documentList, "Podcast", "h1"));
    assert.ok(calls.some(([kind, title]) => kind === "title" && title === "Podcast"));
    const head = documentList.querySelector(".dk-split__head.dk-collection-header");
    assert.ok(findByText(head, "Episodes", "h2"));
    assert.ok(head.querySelector("[data-dk-create]"), "New episode carries the c shortcut");
    assert.equal(documentList.querySelector(".dk-split").dataset.view, "list");
    assert.deepEqual(rows(documentList), ["booked-soon", "scheduled", "booked-late"]);
    assert.ok(findByText(documentList, "Upcoming", "h3"));
    assert.equal(documentList.querySelector(".dk-stat-strip"), null);
    assert.equal(documentList.querySelector(".dk-split").dataset.pane, "closed");
    assert.equal(documentList.querySelector(".dk-split__detail"), null, "no placeholder pane");

    const tabs = documentList.querySelector('.podcast-status-filter[role="radiogroup"]');
    assert.equal(tabs.querySelector('[data-filter="upcoming"]').getAttribute("aria-checked"), "true");
    await tabs.querySelector('[data-filter="all"]').click();
    assert.deepEqual(rows(documentList), ["booked-soon", "scheduled", "booked-late", "pub-25", "pub-24", "cancelled", "loose"]);
    assert.ok(findByText(documentList, "Season 24", "h3"));

    const season = documentList.querySelector(".podcast-season-filter");
    season.value = "24";
    await season.dispatch("change");
    assert.deepEqual(rows(documentList), ["pub-24", "cancelled"]);

    const search = documentList.querySelector(".podcast-search");
    search.value = "nobody";
    await search.dispatch("input");
    assert.ok(findByText(documentList, "No matches"));
    assert.equal(documentList.querySelector(".podcast-search").value, "nobody");
  });

  test("rows read code, guest — title, status and date, and open in place", async () => {
    const { surface, documentList, calls, shown } = harness({ view: "list" });
    surface.renderPodcastSurface();
    await nextTicks(4);
    const row = documentList.querySelector('[data-episode-id="booked-soon"]');
    assert.equal(row.href, "/podcast/booked-soon?view=list");
    assert.ok(findByText(row, "S25E4", ".podcast-row__code"));
    assert.ok(findByText(row, "Guest booked-soon — Synthetic booked-soon"));
    assert.ok(findByText(row, "Booked", ".podcast-status"));
    assert.ok(findByText(row, "2 Nov 2026"));
    await row.dispatch("click", { button: 0 });
    assert.deepEqual(calls.find(([kind]) => kind === "navigate"), ["navigate", "/podcast/booked-soon", { view: "list" }, { render: false }]);
    assert.deepEqual(shown, ["detail"]);
    assert.equal(documentList.querySelector(".dk-split").dataset.view, "detail");
    assert.equal(documentList.querySelector('[data-episode-id="booked-soon"]').getAttribute("aria-current"), "true");
    assert.ok(findByText(documentList, "Synthetic booked-soon", "h2"));

    await documentList.querySelector(".dk-split__back").click();
    assert.deepEqual(calls.filter(([kind]) => kind === "navigate").at(-1), [
      "navigate", "/podcast", { view: "list" }, { restoreFocus: { kind: "split-list" } },
    ]);
  });

  test("detail shows the card chip and service links; status moves at the record's version", async () => {
    const linked = episode("linked", {
      status: "recorded",
      cardId: "card-1",
      card: { id: "card-1", title: "Podcast with Guest linked", stage: "preparation", taskCount: 9, openTaskCount: 7 },
      links: { youtube: "https://youtube.example/watch?v=1", website: "https://site.example/ep" },
      notes: "Bring the slides.",
      version: 3,
    });
    const { surface, documentList, calls } = harness({ episodes: [linked], routeId: "linked" });
    surface.renderPodcastSurface();
    await nextTicks(4);
    const chip = documentList.querySelector(".podcast-card-chip");
    assert.equal(chip.href, "/cards?cardId=card-1");
    assert.ok(findByText(chip, "Podcast with Guest linked"));
    assert.ok(findByText(chip, "Preparation"));
    assert.ok(findByText(chip, "7/9"));
    assert.deepEqual(documentList.querySelectorAll(".podcast-link").map((link) => link.dataset.link), ["youtube", "website"]);
    assert.ok(findByText(documentList, "Bring the slides."));
    assert.equal(documentList.querySelector('[data-podcast-action="advance"]'), null, "no Mark button: the Card moves the status");
    assert.ok(findByText(documentList, "Moves with the Card: recorded, edited, scheduled and published follow its ticked Tasks."));
    const choose = documentList.querySelector(".podcast-status-select");
    choose.value = "edited";
    await choose.dispatch("change");
    await nextTicks(2);
    assert.deepEqual(calls.find(([method]) => method === "PUT"), ["PUT", "/api/podcast-episodes/linked", { status: "edited", version: 3 }]);
    assert.ok(findByText(documentList, "Marked edited."));
    assert.ok(findByText(documentList, "Edited", ".podcast-status"));
    assert.ok(documentList.querySelector(".podcast-card-chip"), "the card summary survives a save");
    // A link to the Card's own page: the app opens it over the episode.
    assert.equal(documentList.querySelector(".podcast-card-chip").href, "/cards?cardId=card-1");
  });

  test("an episode without a Card is set by hand, with no evidence gate", async () => {
    const bare = episode("bare", { status: "edited", version: 2, releaseDate: "2026-12-01" });
    const first = harness({ episodes: [bare], routeId: "bare" });
    first.surface.renderPodcastSurface();
    await nextTicks(4);
    assert.equal(first.documentList.querySelector(".podcast-status-hint"), null, "no Card, nothing moves it");
    const choose = first.documentList.querySelector(".podcast-status-select");
    choose.value = "published";
    await choose.dispatch("change");
    await nextTicks(2);
    assert.deepEqual(first.calls.find(([method]) => method === "PUT"), ["PUT", "/api/podcast-episodes/bare", { status: "published", version: 2 }]);
  });

  test("a version conflict keeps the form, names the conflict and reloads on request", async () => {
    const { surface, documentList, calls, setRecords, records } = harness({ routeId: "booked-soon" });
    surface.renderPodcastSurface();
    await nextTicks(4);
    await documentList.querySelector('[data-podcast-action="edit"]').click();
    const form = documentList.querySelector(".podcast-edit-form");
    assert.ok(form);
    setRecords(records.map((item) => (item.id === "booked-soon" ? { ...item, title: "Changed elsewhere", version: 2 } : item)));
    form.querySelector('[name="notes"]').value = "My note";
    await form.dispatch("submit");
    await nextTicks(2);
    const message = documentList.querySelector(".podcast-message");
    assert.equal(message.dataset.kind, "conflict");
    assert.match(message.textContent, /changed since you opened it/);
    assert.equal(documentList.querySelector('.podcast-edit-form [name="notes"]').value, "My note");
    await findByText(message, "Reload episode", "button").click();
    await nextTicks(2);
    assert.ok(calls.some(([method, path]) => method === "GET" && path === "/api/podcast-episodes/booked-soon"));
    assert.equal(documentList.querySelector(".podcast-edit-form"), null);
    assert.ok(findByText(documentList, "Changed elsewhere", "h2"));

    await documentList.querySelector('[data-podcast-action="edit"]').click();
    const again = documentList.querySelector(".podcast-edit-form");
    again.querySelector('[name="releaseDate"]').value = "2026-12-24";
    await again.dispatch("submit");
    await nextTicks(2);
    assert.deepEqual(calls.filter(([method]) => method === "PUT").at(-1)[2], { releaseDate: "2026-12-24", version: 2 });
    assert.ok(findByText(documentList, "Episode saved."));
  });

  test("a published episode shows its links as chips, names only the missing ones, and asks for no Card", async () => {
    const out = episode("out", {
      status: "published",
      releaseDate: "2026-09-01",
      websiteSlug: "synthetic-out",
      links: {
        youtube: "https://youtube.example/watch?v=out",
        spotify: "https://open.spotify.com/episode/out",
        apple: "https://podcasts.apple.example/out",
        website: "https://site.example/out",
      },
      readiness: { spotify: "not-recorded", transcript: "not-recorded", website: "not-recorded", scheduledLocalDate: null },
    });
    const { surface, documentList } = harness({ episodes: [out], routeId: "out" });
    surface.renderPodcastSurface();
    await nextTicks(4);
    const publication = documentList.querySelector(".podcast-publication");
    assert.deepEqual(publication.querySelectorAll(".podcast-link").map((link) => link.dataset.link), ["youtube", "spotify", "apple", "website"]);
    assert.ok(findByText(publication, "Missing: Anchor"));
    for (const gone of ["Intended release", "Spotify schedule", "Not recorded", "Website release needs evidence"]) {
      assert.equal(findByText(publication, gone), undefined, `${gone} is not shown on a published episode`);
    }
    assert.equal(documentList.querySelector('[data-podcast-action="create-card"]'), null);
    assert.equal(documentList.querySelector(".podcast-card-section"), null);
  });

  test("an episode on its way out keeps its plan and Spotify rows and says nothing is missing", async () => {
    const { surface, documentList } = harness({ episodes: [episode("soon", { releaseDate: "2026-12-01" })], routeId: "soon" });
    surface.renderPodcastSurface();
    await nextTicks(4);
    const publication = documentList.querySelector(".podcast-publication");
    assert.ok(findByText(publication, "Intended release", "dt"));
    assert.ok(findByText(publication, "Spotify schedule", "dt"));
    assert.equal(publication.querySelector(".podcast-links-missing"), null);
    assert.ok(findByText(publication, "No links yet. Add them with Edit once the episode is out."));
    assert.ok(documentList.querySelector('[data-podcast-action="create-card"]'));
  });

  test("Create card posts the version and shows the linked card; undated episodes wait", async () => {
    const { surface, documentList, calls } = harness({
      episodes: [episode("dated", { version: 5 }), episode("undated", { recordingDate: null })],
      routeId: "dated",
      handlers: {
        "POST /api/podcast-episodes/dated/card": (payload, records) => ({
          episode: { ...records[0], cardId: "card-9", version: payload.version + 1 },
          card: { id: "card-9", title: "Synthetic dated", stage: "preparation", taskCount: 4, openTaskCount: 4 },
        }),
      },
    });
    surface.renderPodcastSurface();
    await nextTicks(4);
    await documentList.querySelector('[data-podcast-action="create-card"]').click();
    await nextTicks(2);
    assert.deepEqual(calls.find(([method]) => method === "POST"), ["POST", "/api/podcast-episodes/dated/card", { version: 5 }]);
    assert.ok(findByText(documentList.querySelector(".podcast-card-chip"), "Synthetic dated"));
    assert.ok(findByText(documentList, "Created Card “Synthetic dated”."));

    await documentList.querySelector('[data-episode-id="undated"]').dispatch("click", { button: 0 });
    const create = documentList.querySelector('[data-podcast-action="create-card"]');
    assert.equal(create.disabled, true);
    assert.ok(findByText(documentList, "Set a recording date first: the Card's tasks count from it."));
  });

  test("New episode loads the register before opening and suggests the next number", async () => {
    const { surface, documentList, document, calls } = harness({
      handlers: {
        "POST /api/podcast-episodes": (payload) => ({ id: "new-1", version: 1, links: {}, ...payload }),
      },
    });
    surface.renderPodcastSurface();
    await nextTicks(4);
    const trigger = documentList.querySelector("[data-dk-create]");
    const before = calls.filter(([method, path]) => method === "GET" && path === "/api/podcast-episodes").length;
    await trigger.click();
    await nextTicks(2);
    assert.equal(calls.filter(([method, path]) => method === "GET" && path === "/api/podcast-episodes").length, before + 1);
    const dialog = document.body.querySelector(".podcast-dialog");
    assert.ok(dialog);
    dialog.close = () => dialog.dispatch("close");
    const form = dialog.querySelector(".podcast-create-form");
    assert.equal(form.querySelector('[name="season"]').value, "25");
    assert.equal(form.querySelector('[name="episode"]').value, "6");
    await form.dispatch("submit");
    assert.ok(findByText(dialog, "Add a guest or a title."));
    form.querySelector('[name="guests"]').value = "Ada Example";
    form.querySelector('[name="status"]').value = "recorded";
    await form.dispatch("submit");
    await nextTicks(2);
    assert.deepEqual(calls.find(([method]) => method === "POST")[2], {
      status: "recorded", guests: [{ name: "Ada Example" }], season: 25, episode: 6,
    });
    assert.deepEqual(calls.filter(([kind]) => kind === "navigate").at(-1), ["navigate", "/podcast/new-1", {}, {}]);
    assert.ok(findByText(documentList, "Episode created."));
    assert.equal(documentList.querySelector('[data-episode-id="new-1"]').getAttribute("aria-current"), "true");
  });

  test("an empty register offers the first episode; a stale link and an outage are recoverable", async () => {
    const empty = harness({ episodes: [] });
    empty.surface.renderPodcastSurface();
    await nextTicks(4);
    assert.ok(findByText(empty.documentList, "No episodes yet"));
    const first = findByText(empty.documentList, "Create the first episode", "button");
    assert.ok(first);
    assert.equal(first.dataset.dkCreate, undefined, "only New episode carries the shortcut");

    const stale = harness({ routeId: "gone" });
    stale.surface.renderPodcastSurface();
    await nextTicks(4);
    assert.ok(findByText(stale.documentList, "Episode not found", "h2"));
    await findByText(stale.documentList, "Retry", "button").click();
    await nextTicks(2);
    assert.ok(stale.calls.some(([method, path]) => method === "GET" && path === "/api/podcast-episodes/gone"));

    let fail = true;
    const outage = harness({
      view: "list",
      handlers: {
        "GET /api/podcast-episodes": (payload, records) => {
          if (fail) throw new Error("Synthetic outage");
          return { items: records };
        },
      },
    });
    outage.surface.renderPodcastSurface();
    await nextTicks(4);
    assert.ok(findByText(outage.documentList, "Podcast episodes are unavailable"));
    fail = false;
    await findByText(outage.documentList, "Retry", "button").click();
    await nextTicks(4);
    assert.deepEqual(rows(outage.documentList), ["booked-soon", "scheduled", "booked-late"]);
  });
});
