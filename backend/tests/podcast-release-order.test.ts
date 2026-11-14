import { describe, it } from "node:test";
import assert from "node:assert";
import { isoWeekOf, releaseDateViolations } from "../src/podcast/releaseOrder";
import { nextReleaseSlots, DEFAULT_PODCAST_RELEASE_CADENCE } from "../src/podcast/releaseSlots";

const ep = (id: string, season: number | null, episode: number | null, releaseDate: string | null, status = "booked") =>
  ({ id, season, episode, releaseDate, status, publication: null }) as any;

describe("podcast release-order validator", () => {
  it("computes ISO weeks across year boundaries", () => {
    assert.equal(isoWeekOf("2026-10-23"), "2026-W43");
    assert.equal(isoWeekOf("2026-10-25"), "2026-W43");
    assert.equal(isoWeekOf("2026-10-26"), "2026-W44");
    assert.equal(isoWeekOf("2027-01-01"), "2026-W53");
  });

  it("flags the 17 Oct case: S25E9 on 23 Oct while S25E8 is unscheduled", () => {
    const register = [ep("e8", 25, 8, null), ep("e7", 25, 7, "2026-10-16", "published")];
    const violations = releaseDateViolations({ id: "e9", season: 25, episode: 9, releaseDate: "2026-10-23" }, register);
    assert.deepEqual(violations.map((v) => v.code), ["lower-episode-unscheduled"]);
    assert.match(violations[0].message, /S25E8 has no release date/);
    // Once E8 holds a date before E9, the same date is fine.
    const fixed = [ep("e8", 25, 8, "2026-10-16"), ep("e7", 25, 7, "2026-10-09", "published")];
    assert.deepEqual(releaseDateViolations({ id: "e9", season: 25, episode: 9, releaseDate: "2026-10-23" }, fixed), []);
  });

  it("flags a higher number before a lower scheduled number, and the reverse move", () => {
    const register = [ep("e8", 25, 8, "2026-11-13")];
    const early = releaseDateViolations({ id: "e9", season: 25, episode: 9, releaseDate: "2026-11-06" }, register);
    assert.deepEqual(early.map((v) => v.code), ["episode-order"]);
    const lateLow = releaseDateViolations({ id: "e8", season: 25, episode: 8, releaseDate: "2026-11-27" }, [ep("e9", 25, 9, "2026-11-20")]);
    assert.deepEqual(lateLow.map((v) => v.code), ["episode-order"]);
    // Season rollover orders season-major.
    assert.equal(releaseDateViolations({ id: "n", season: 26, episode: 1, releaseDate: "2026-11-20" }, [ep("e9", 25, 9, "2026-11-13")]).length, 0);
  });

  it("flags two episodes in the same ISO week, even on different days", () => {
    const register = [ep("a", 25, 1, "2026-10-23")];
    const violations = releaseDateViolations({ id: "b", season: 25, episode: 2, releaseDate: "2026-10-25" }, register);
    assert.deepEqual(violations.map((v) => v.code), ["same-iso-week"]);
    assert.equal(releaseDateViolations({ id: "b", season: 25, episode: 2, releaseDate: "2026-10-30" }, register).length, 0);
  });

  it("ignores cancelled episodes and the episode being edited", () => {
    const register = [ep("a", 25, 1, "2026-10-23", "cancelled"), ep("self", 25, 2, "2026-10-23")];
    assert.deepEqual(releaseDateViolations({ id: "self", season: 25, episode: 2, releaseDate: "2026-10-23" }, register), []);
  });

  it("never lets next-slot propose a failing date", () => {
    const base = { cadence: DEFAULT_PODCAST_RELEASE_CADENCE, episodesPerSeason: 9, count: 3 };
    // E8 numbered but unscheduled: every date would put E9 before it, so nothing is offered.
    const blocked = nextReleaseSlots({
      ...base,
      episodes: [ep("e8", 25, 8, null), ep("e7", 25, 7, "2026-10-16", "published")],
      now: new Date("2026-10-17T10:00:00Z"),
    });
    assert.equal(blocked.code, "S25E9");
    assert.deepEqual(blocked.slots, []);
    assert.match(blocked.blockedReasons![0], /S25E8 has no release date/);
    // A later-dated lower episode pushes proposals past it, one per ISO week.
    const result = nextReleaseSlots({
      ...base,
      episodes: [ep("e8", 25, 8, "2026-11-13")],
      now: new Date("2026-10-17T10:00:00Z"),
    });
    assert.equal(result.code, "S25E9");
    assert.deepEqual(result.slots.map((slot) => slot.date), ["2026-11-20", "2026-11-27", "2026-12-04"]);
    for (const slot of result.slots)
      assert.deepEqual(releaseDateViolations({ season: result.season, episode: result.episode, releaseDate: slot.date }, [ep("e8", 25, 8, "2026-11-13")]), []);
  });
});
