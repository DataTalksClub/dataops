import { describe, it } from "node:test";
import assert from "node:assert";
import { isHolidayNotice } from "../scripts/import-calendar";

// A holiday reminder typed into the schedule's webinar column was imported as a
// "Webinar" activity and showed on the calendar next to the school-holiday band.
describe("calendar import holiday notices", () => {
  it("recognises holiday reminders in activity columns", () => {
    for (const title of [
      "School Autumn holidays (October 19 – Oct31)",
      "School holidays",
      "Herbstferien",
      "Public holiday",
      "Christmas break",
      "Summer vacation",
    ]) {
      assert.equal(isHolidayNotice(title), true, title);
    }
  });

  it("keeps real activities", () => {
    for (const title of [
      "LLM Zoomcamp launch webinar",
      "Holiday sales with Stripe (podcast)",
      "Lunch break chat",
      "Data engineering in the summer of 2026",
    ]) {
      assert.equal(isHolidayNotice(title), false, title);
    }
  });
});
