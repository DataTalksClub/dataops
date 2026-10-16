import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { guestCellDate, type PodcastScheduleRow } from "../scripts/import-calendar";
import {
  mergeSources,
  nameKey,
  parseRss,
  planWrites,
  readWebsiteEpisodes,
  type ExistingEpisode,
  type WebsiteEpisode,
} from "../scripts/import-podcast-episodes";

const fixtures = path.join(__dirname, "fixtures", "podcast-import");
const row = (values: Partial<PodcastScheduleRow>): PodcastScheduleRow => ({
  sheet: "Time table",
  row: 1,
  recordingDate: "2027-01-01",
  guests: [],
  status: "confirmed",
  hidden: false,
  ...values,
});
const schedule: PodcastScheduleRow[] = [
  row({ row: 10, recordingDate: "2026-12-21", guests: ["Ada Example"] }),
  row({ sheet: "Extra podcast slots", row: 4, recordingDate: "2026-12-18", guests: ["Ada Example"], title: "Synthetic Systems" }),
  row({ sheet: "Extra podcast slots", row: 5, recordingDate: "2027-01-11", guests: ["Grace Example"], title: "Synthetic Data Stories" }),
  row({ sheet: "Extra podcast slots", row: 6, recordingDate: "2027-03-01", guests: ["Bo Placeholder"] }),
  row({ row: 23, recordingDate: "2027-03-22", guests: ["Eve Placeholder"] }),
  row({ row: 21, recordingDate: "2027-03-08", guests: ["Cy Placeholder"], status: "proposed" }),
  row({ row: 22, recordingDate: "2027-03-15", guests: ["Di Placeholder"], status: "cancelled" }),
  row({ row: 2, recordingDate: "2021-03-05", guests: ["Old Fixture Guest"], hidden: true }),
];
const merge = () =>
  mergeSources({
    website: readWebsiteEpisodes(fixtures),
    schedule,
    rss: parseRss(readFileSync(path.join(fixtures, "feed.xml"), "utf8")),
    today: "2027-02-01",
  });

describe("podcast episode import", () => {
  it("skips website files Jekyll does not publish", () => {
    const slugs = readWebsiteEpisodes(fixtures).map((episode) => episode.slug);
    assert.deepEqual(slugs, ["s30e01-synthetic-systems", "s30e02-synthetic-data-stories"]);
  });
  it("merges website, schedule and RSS with the website owning numbering", () => {
    const { episodes, report } = merge();
    const ada = episodes.find((episode) => episode.websiteSlug === "s30e01-synthetic-systems")!;
    assert.deepEqual(ada.guests, [{ name: "Ada Example", slug: "adaexample" }]);
    assert.equal(ada.status, "published");
    assert.equal(ada.releaseDate, "2027-01-15");
    assert.equal(ada.recordingDate, "2026-12-18");
    assert.equal(ada.season, 30);
    assert.equal(ada.episode, 1);
    assert.equal(ada.links!.website, "https://datatalks.club/podcast/s30e01-synthetic-systems.html");
    assert.equal(ada.links!.anchor, "https://anchor.fm/example/episodes/Synthetic-Systems---Ada-Example-e1abc01");

    const grace = episodes.find((episode) => episode.websiteSlug === "s30e02-synthetic-data-stories")!;
    assert.equal(grace.releaseDate, undefined);
    assert.equal(grace.recordingDate, "2027-01-11");
    assert.equal(grace.links!.anchor, "https://podcasters.example.com/pod/show/example/episodes/Synthetic-Data-Stories---Grace-Example-e1abc02");

    const upcoming = episodes.filter((episode) => episode.source === "schedule");
    assert.deepEqual(upcoming.map((episode) => [episode.guests[0].name, episode.status]), [["Bo Placeholder", "booked"]]);

    assert.deepEqual(report.numberingConflicts, [
      { websiteSlug: "s30e01-synthetic-systems", website: "S30E1", rss: "S30E3" },
    ]);
    assert.deepEqual(report.rssUnmatched, ["Fixture Conference Interviews"]);
    assert.equal(report.rssLinksFilled, 1);
    assert.equal(report.scheduleDuplicateRows, 0);
    assert.equal(report.scheduleMatched, 2);
    assert.equal(report.timetableMatched, 1);
    assert.deepEqual(report.timetableUnmatched, ["Time table!23"]);
    assert.equal(report.scheduleUnmatchedHistory, 1);
    assert.deepEqual(report.scheduleNotBooked, ["Time table!21"]);
    assert.deepEqual(report.scheduleCancelled, ["Time table!22"]);
  });

  it("matches the register by slug, schedule key, then guest and date, so reruns create nothing", () => {
    const { episodes } = merge();
    const first = planWrites(episodes, []);
    assert.equal(first.creates.length, 3);
    const register: ExistingEpisode[] = first.creates.map((episode, index) => ({
      ...episode,
      id: `episode-${index}`,
      version: 1,
    }));
    const rerun = planWrites(merge().episodes, register);
    assert.equal(rerun.creates.length, 0);
    assert.equal(rerun.updates.length, 0);
    assert.equal(rerun.unchanged, 3);

    const manual: ExistingEpisode = {
      source: "schedule",
      id: "manual-ada",
      version: 4,
      title: "Working title",
      guests: [{ name: "ada example" }],
      recordingDate: "2026-12-18",
      status: "edited",
      cardId: "card-fixture",
      notes: "Keep me",
    };
    const adopted = planWrites(merge().episodes, [manual]);
    const update = adopted.updates.find((item) => item.id === "manual-ada")!;
    assert.equal(update.changes.websiteSlug, "s30e01-synthetic-systems");
    assert.equal(update.changes.status, "published");
    assert.equal(update.changes.title, "Synthetic Systems: A Fixture Episode");
    assert.ok(!("cardId" in update.changes));
    assert.ok(!("notes" in update.changes));
    assert.equal(adopted.creates.length, 2);
  });

  it("creates episodes only from Extra podcast slots, never from the Time table or for the host", () => {
    const sasha: WebsiteEpisode = {
      slug: "s30e03-synthetic-shipping",
      season: 30,
      episode: 3,
      title: "Synthetic Shipping",
      short: null,
      guests: [{ name: "Aleksandr Sample" }],
      releaseDate: "2027-02-05",
      links: {},
      anchorId: null,
    };
    const { episodes, report } = mergeSources({
      website: [sasha],
      schedule: [
        // The register numbers the episode; the guest spelling differs.
        row({ sheet: "Extra podcast slots", row: 7, recordingDate: "2027-01-18", guests: ["Sasha Sample"], season: 30, episode: 3, title: "Synthetic Shipping" }),
        // The weekly plan spells the guest another way: same recording.
        row({ row: 30, weekOf: "2027-01-18", recordingDate: "2027-01-18", guests: ["Alexander Sample"] }),
        // The host's own workshop in the week's podcast cell.
        row({ row: 31, weekOf: "2027-01-25", recordingDate: "2027-01-26", guests: ["Host Person"] }),
        row({ sheet: "Extra podcast slots", row: 8, recordingDate: "2027-02-01", guests: ["host person"] }),
        // A confirmed Time table row with no register entry is reported, not created.
        row({ row: 32, weekOf: "2027-02-08", recordingDate: "2027-02-08", guests: ["Una Placeholder"] }),
      ],
      rss: [],
      today: "2027-01-10",
      hosts: ["Host Person"],
    });
    assert.deepEqual(episodes.map((episode) => episode.source), ["website"]);
    assert.equal(episodes[0].recordingDate, "2027-01-18");
    assert.equal(report.scheduleMatched, 1);
    assert.equal(report.timetableMatched, 1);
    assert.deepEqual(report.scheduleHostRows, ["Time table!31", "Extra podcast slots!8"]);
    assert.deepEqual(report.timetableUnmatched, ["Time table!32"]);

    const register: ExistingEpisode[] = [
      { ...episodes[0], id: "real", version: 2 },
      { source: "schedule", id: "duplicate", version: 1, guests: [{ name: "Alexander Sample" }], recordingDate: "2027-01-18", status: "recorded" },
      { source: "schedule", id: "host", version: 1, guests: [{ name: "Host Person" }], recordingDate: "2027-01-25", status: "recorded" },
    ];
    const plan = planWrites(episodes, register);
    assert.equal(plan.creates.length, 0);
    assert.deepEqual(plan.unmatched.map((episode) => episode.id), ["duplicate", "host"]);
  });

  it("dates published history from the Time table by guest when the register has no row", () => {
    const { episodes, report } = mergeSources({
      website: readWebsiteEpisodes(fixtures),
      schedule: [row({ row: 40, weekOf: "2026-12-14", recordingDate: "2026-12-16", guests: ["Ada Example"], hidden: true })],
      rss: [],
      today: "2027-02-01",
    });
    const ada = episodes.find((episode) => episode.websiteSlug === "s30e01-synthetic-systems")!;
    assert.equal(ada.recordingDate, "2026-12-16");
    assert.equal(ada.scheduleSourceKey, undefined);
    assert.equal(report.timetableRecordingDates, 1);
  });

  it("reads the recording day from a Time table guest cell", () => {
    assert.equal(guestCellDate("Alexey Grigorev (Aug 18)", "2026-08-17"), "2026-08-18");
    assert.equal(guestCellDate("Gustaf Example (Jun 29)", "2026-06-22"), "2026-06-29");
    assert.equal(guestCellDate("Ada Example (sept 8)", "2026-09-07"), "2026-09-08");
    assert.equal(guestCellDate("Ada Example (jan 2)", "2026-12-28"), "2027-01-02");
    assert.equal(guestCellDate("Ada Example (see extra podcast slots)", "2026-09-07"), "");
    assert.equal(guestCellDate("Ada Example", "2026-09-07"), "");
  });

  it("folds transliterated guest names", () => {
    assert.equal(nameKey("Aleksandr Kim"), nameKey("Alexander Kim"));
    assert.notEqual(nameKey("Alexandra Kim"), nameKey("Alexander Kim"));
  });
});
