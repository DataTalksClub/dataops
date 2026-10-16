import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDayLabel } from "../src/core/dates.js";

describe("formatDayLabel", () => {
  test("omits the year inside the current year", () => {
    assert.equal(formatDayLabel("2026-01-18", "2026-10-16"), "18 Jan");
    assert.equal(formatDayLabel("2026-12-31", "2026-01-01"), "31 Dec");
  });

  test("shows the year outside the current year, either way", () => {
    assert.equal(formatDayLabel("2027-01-18", "2026-10-16"), "18 Jan 2027");
    assert.equal(formatDayLabel("2025-12-31", "2026-01-01"), "31 Dec 2025");
  });

  test("reads a timestamp on its calendar day", () => {
    assert.equal(formatDayLabel("2027-01-18T23:30:00.000Z", "2026-10-16"), "18 Jan 2027");
    assert.equal(formatDayLabel("2026-03-05T08:00:00Z", "2026-10-16"), "5 Mar");
  });

  test("returns anything that is not a calendar date as given", () => {
    assert.equal(formatDayLabel("", "2026-10-16"), "");
    assert.equal(formatDayLabel(null, "2026-10-16"), "");
    assert.equal(formatDayLabel("soon", "2026-10-16"), "soon");
    assert.equal(formatDayLabel("2025-02-29", "2026-10-16"), "2025-02-29");
  });
});
