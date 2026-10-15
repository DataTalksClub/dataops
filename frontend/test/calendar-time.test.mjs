import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { berlinDateTime, berlinTime, berlinTimestamp } from "../src/surfaces/calendar-time.js";

// Berlin switches to summer time at 01:00 UTC on 29 March 2026 (02:00 -> 03:00)
// and back at 01:00 UTC on 25 October 2026 (03:00 -> 02:00).
describe("calendar times in Europe/Berlin", () => {
  test("shows UTC instants as Berlin wall-clock time on both sides of the spring change", () => {
    assert.equal(berlinTime("2026-03-29T00:30:00.000Z"), "01:30");
    assert.equal(berlinTime("2026-03-29T00:59:00.000Z"), "01:59");
    assert.equal(berlinTime("2026-03-29T01:00:00.000Z"), "03:00");
    assert.equal(berlinTime("2026-03-29T01:30:00.000Z"), "03:30");
    assert.equal(berlinDateTime("2026-03-28T23:30:00.000Z"), "2026-03-29T00:30");
  });

  test("shows the repeated autumn hour and winter time", () => {
    assert.equal(berlinTime("2026-10-25T00:30:00.000Z"), "02:30");
    assert.equal(berlinTime("2026-10-25T01:30:00.000Z"), "02:30");
    assert.equal(berlinTime("2026-10-25T02:30:00.000Z"), "03:30");
    assert.equal(berlinTime("2026-12-01T10:00:00.000Z"), "11:00");
    assert.equal(berlinTime("2026-08-13T10:00:00.000Z"), "12:00");
  });

  test("converts Berlin wall-clock input back to UTC and rejects the skipped hour", () => {
    assert.equal(berlinTimestamp("2026-03-29", "01:30"), "2026-03-29T00:30:00.000Z");
    assert.equal(berlinTimestamp("2026-03-29", "03:30"), "2026-03-29T01:30:00.000Z");
    assert.equal(berlinTimestamp("2026-12-01", "11:00"), "2026-12-01T10:00:00.000Z");
    assert.throws(() => berlinTimestamp("2026-03-29", "02:30"), /does not exist in Europe\/Berlin/);
  });

  test("does not depend on the viewer's own timezone", () => {
    // Formatting goes through Intl with an explicit zone, never local getters.
    assert.equal(berlinTime(Date.parse("2026-03-29T01:30:00Z")), "03:30");
  });
});
