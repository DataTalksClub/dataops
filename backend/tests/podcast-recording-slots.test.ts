import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  heldWindows,
  nextRecordingSlot,
  nextRecordingSlots,
  RECORDING_EVENING_LOCAL,
  RECORDING_MIDDAY_LOCAL,
  takenRecordingDates,
} from "../src/podcast/recordingSlots";

describe("podcast recording slots", () => {
  it("prefers midday over evening on the same day", () => {
    // 2026-10-26 is a Monday
    const result = nextRecordingSlots({
      fromDate: "2026-10-26",
      episodes: [],
      holds: [],
      count: 1,
    });
    assert.equal(result.slots.length, 1);
    assert.equal(result.slots[0].date, "2026-10-26");
    assert.equal(result.slots[0].window, "midday");
    assert.equal(result.slots[0].localTime, RECORDING_MIDDAY_LOCAL);
    assert.equal(result.preference.eveningLocalTime, RECORDING_EVENING_LOCAL);
    assert.match(result.preference.note, /not workshop 12:00\/16:30/);
  });

  it("falls back to evening ~17:00 when midday is held (Mon/Tue)", () => {
    const result = nextRecordingSlots({
      fromDate: "2026-10-26",
      episodes: [],
      holds: [{ status: "tentative", date: "2026-10-26", window: "midday" }],
      count: 1,
    });
    assert.equal(result.slots[0].window, "evening");
    assert.equal(result.slots[0].localTime, "17:00");
    assert.notEqual(result.slots[0].localTime, "16:30");
  });

  it("skips dates taken by episodes or event Cards", () => {
    const taken = takenRecordingDates(
      [
        { status: "booked", recordingDate: "2026-10-26" },
        { status: "cancelled", recordingDate: "2026-10-27" },
      ],
      ["2026-10-28"],
    );
    assert.deepEqual([...taken].sort(), ["2026-10-26", "2026-10-28"]);

    const slot = nextRecordingSlot({
      fromDate: "2026-10-26",
      episodes: [{ status: "booked", recordingDate: "2026-10-26" }],
      holds: [],
      eventCardDates: ["2026-10-27"], // Tuesday occupied by event Card
    });
    // Wed 2026-10-28 midday (Mon episode, Tue event Card)
    assert.equal(slot?.date, "2026-10-28");
    assert.equal(slot?.window, "midday");
  });

  it("treats active holds as hard occupancy per window", () => {
    const held = heldWindows([
      { status: "tentative", date: "2026-10-26", window: "midday" },
      { status: "confirmed", date: "2026-10-26", window: "evening" },
      { status: "released", date: "2026-10-27", window: "midday" },
    ]);
    assert.ok(held.has("2026-10-26#midday"));
    assert.ok(held.has("2026-10-26#evening"));
    assert.ok(!held.has("2026-10-27#midday"));
  });

  it("does not offer evening on Wed–Fri when midday is busy", () => {
    // Wednesday 2026-10-28: midday held → skip day (evening not offered Wed)
    const slot = nextRecordingSlot({
      fromDate: "2026-10-28",
      episodes: [],
      holds: [{ status: "tentative", date: "2026-10-28", window: "midday" }],
    });
    assert.equal(slot?.date, "2026-10-29"); // Thursday midday
    assert.equal(slot?.window, "midday");
  });

  it("respects optional ownerFreeWindows when provided", () => {
    const slot = nextRecordingSlot({
      fromDate: "2026-10-26",
      episodes: [],
      holds: [],
      ownerFreeWindows: ["2026-10-27#evening"], // only Tue evening free per owner
    });
    assert.equal(slot?.date, "2026-10-27");
    assert.equal(slot?.window, "evening");
    assert.equal(slot?.localTime, "17:00");
  });

  it("skips weekends", () => {
    // Friday 2026-10-30 midday held → next is Mon 2026-11-02
    const slot = nextRecordingSlot({
      fromDate: "2026-10-30",
      episodes: [],
      holds: [{ status: "confirmed", date: "2026-10-30", window: "midday" }],
    });
    assert.equal(slot?.date, "2026-11-02");
    assert.equal(slot?.window, "midday");
  });
});
