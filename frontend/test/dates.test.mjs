import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatDayLabel,
  formatDayMonth,
  formatEditedTimestamp,
  formatIssueDate,
  formatUtcMinute,
} from "../src/core/dates.js";

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

// Every input class the shared helpers below must handle exactly as the
// per-surface copies they replaced did.
const INPUTS = [
  "2026-01-18",
  "2026-12-31",
  "2027-01-01",
  "2024-02-29",
  "2026-03-01T23:59:59.000Z",
  "2026-03-01T00:30:00+02:00",
  "2026-05-10T09:30",
  "2026-05-10 09:30",
  "",
  "soon",
  "2026-13-01",
  "2025-02-30",
  null,
  undefined,
  0,
];

// Verbatim copies of the removed per-surface helpers, kept as the oracle.
const replaced = {
  formatShortPlanningDate(iso) {
    const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? String(iso)
      : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
  },
  issuePageDate(iso) {
    const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? String(iso)
      : new Intl.DateTimeFormat("en-GB", {
          weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
        }).format(parsed);
  },
  cardSummaryIssueDate(iso) {
    const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? String(iso || "")
      : new Intl.DateTimeFormat("en-GB", {
          weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
        }).format(parsed);
  },
  previewEditedTimestamp(iso) {
    if (!iso) return "";
    return String(iso).slice(0, 16).replace("T", " ") + " UTC";
  },
  sponsorDocEditedTimestamp(iso) {
    return iso ? `${String(iso).slice(0, 16).replace("T", " ")} UTC` : "";
  },
};

describe("formatDayMonth", () => {
  test("shows day and short month of the UTC calendar day", () => {
    assert.equal(formatDayMonth("2026-01-18"), "18 Jan");
    assert.equal(formatDayMonth("2026-12-31"), "31 Dec");
    assert.equal(formatDayMonth("2027-01-01"), "1 Jan");
    assert.equal(formatDayMonth("2024-02-29"), "29 Feb");
  });

  test("reads a timestamp on its written day, not local time", () => {
    assert.equal(formatDayMonth("2026-03-01T23:59:59.000Z"), "1 Mar");
    assert.equal(formatDayMonth("2026-03-01T00:30:00+02:00"), "1 Mar");
  });

  test("returns what does not parse as String(value)", () => {
    assert.equal(formatDayMonth("soon"), "soon");
    assert.equal(formatDayMonth(""), "");
    assert.equal(formatDayMonth(null), "null");
    assert.equal(formatDayMonth(undefined), "undefined");
  });

  test("matches the removed planning copies on every input class", () => {
    for (const value of INPUTS) {
      assert.equal(formatDayMonth(value), replaced.formatShortPlanningDate(value), String(value));
    }
  });
});

describe("formatIssueDate", () => {
  test("long weekday for the issue page, short for the card summary", () => {
    assert.equal(formatIssueDate("2026-01-18", { weekday: "long" }), "Sunday, 18 Jan 2026");
    assert.equal(formatIssueDate("2026-01-18", { weekday: "short" }), "Sun, 18 Jan 2026");
    assert.equal(formatIssueDate("2026-12-31T23:30:00Z", { weekday: "long" }), "Thursday, 31 Dec 2026");
    assert.equal(formatIssueDate("2027-01-01", { weekday: "short" }), "Fri, 1 Jan 2027");
  });

  test("returns what does not parse as String(value)", () => {
    assert.equal(formatIssueDate("soon", { weekday: "long" }), "soon");
    assert.equal(formatIssueDate("", { weekday: "short" }), "");
    assert.equal(formatIssueDate(null, { weekday: "long" }), "null");
  });

  test("matches the removed issue-page copy on every input class", () => {
    for (const value of INPUTS) {
      assert.equal(formatIssueDate(value, { weekday: "long" }), replaced.issuePageDate(value), String(value));
    }
  });

  test("matches the removed card-summary copy given the call site's `|| \"\"`", () => {
    for (const value of INPUTS) {
      assert.equal(
        formatIssueDate(value || "", { weekday: "short" }),
        replaced.cardSummaryIssueDate(value),
        String(value),
      );
    }
  });
});

describe("formatUtcMinute / formatEditedTimestamp", () => {
  test("cuts a timestamp to the minute as stored", () => {
    assert.equal(formatUtcMinute("2026-05-10T09:30:45.123Z"), "2026-05-10 09:30");
    assert.equal(formatUtcMinute("2026-05-10"), "2026-05-10");
    assert.equal(formatEditedTimestamp("2026-05-10T09:30:45.123Z"), "2026-05-10 09:30 UTC");
  });

  test("an absent timestamp is empty", () => {
    assert.equal(formatEditedTimestamp(""), "");
    assert.equal(formatEditedTimestamp(null), "");
    assert.equal(formatEditedTimestamp(undefined), "");
  });

  test("matches both removed edited-timestamp copies on every input class", () => {
    for (const value of INPUTS) {
      assert.equal(formatEditedTimestamp(value), replaced.previewEditedTimestamp(value), String(value));
      assert.equal(formatEditedTimestamp(value), replaced.sponsorDocEditedTimestamp(value), String(value));
    }
  });

  test("matches the inline card-summary slice on every input class", () => {
    for (const value of INPUTS) {
      assert.equal(formatUtcMinute(value), String(value).slice(0, 16).replace("T", " "), String(value));
    }
  });
});
