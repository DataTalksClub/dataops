import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PodcastScheduleRow } from "../scripts/import-calendar";
import {
  mergeSources,
  parseRss,
  planWrites,
  readWebsiteEpisodes,
  type ExistingEpisode,
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
  row({ row: 20, recordingDate: "2027-03-01", guests: ["Bo Placeholder"] }),
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
    assert.equal(report.scheduleDuplicateRows, 1);
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
});
