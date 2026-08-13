import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  cardsHeaderViewModel,
  formatCardAnchorLabel,
  groupCardItemsByMonth,
  groupCardItemsByStage,
} from "../src/core/workspace.js";

describe("Cards renderer view models", () => {
  test("builds the active board heading and archive route", () => {
    assert.deepEqual(cardsHeaderViewModel({
      archiveVisible: false,
      activeCount: 3,
      archivedCount: 2,
    }), {
      title: "Cards",
      eyebrow: "Task board",
      summary: "3 active cards · open a card to see its tasks",
      archiveAction: "Archive (2)",
      archiveRoute: "/cards/archive",
      createVisible: true,
    });
  });

  test("builds the archive heading and return route", () => {
    assert.deepEqual(cardsHeaderViewModel({
      archiveVisible: true,
      activeCount: 3,
      archivedCount: 1,
    }), {
      title: "Cards",
      eyebrow: "Task board",
      summary: "1 archived card · completed work remains available",
      archiveAction: "Back to board",
      archiveRoute: "/cards",
      createVisible: false,
    });
  });

  test("keeps unknown and completed stages out of the three-column board", () => {
    const groups = groupCardItemsByStage([
      { id: "default" },
      { id: "announced", stage: "ANNOUNCED" },
      { id: "after", stage: "after-event" },
      { id: "done", stage: "done" },
      { id: "unknown", stage: "unknown" },
    ]);
    assert.deepEqual(groups.map((group) => [group.stage, group.items.map((item) => item.id)]), [
      ["preparation", ["default"]],
      ["announced", ["announced"]],
      ["after-event", ["after"]],
    ]);
  });

  test("orders cards inside every column by anchor date then title", () => {
    const groups = groupCardItemsByStage([
      { id: "late", title: "Zeta", anchorDate: "2026-09-01" },
      { id: "undated", title: "Alpha", anchorDate: "" },
      { id: "early", title: "Yankee", anchorDate: "2026-08-14" },
      { id: "same-b", title: "Bravo", anchorDate: "2026-09-01" },
      { id: "announced", stage: "announced", title: "Later", anchorDate: "2026-10-02" },
      { id: "announced-early", stage: "announced", title: "Sooner", anchorDate: "2026-08-20" },
    ]);
    assert.deepEqual(groups.map((group) => [group.stage, group.items.map((item) => item.id)]), [
      ["preparation", ["early", "same-b", "late", "undated"]],
      ["announced", ["announced-early", "announced"]],
      ["after-event", []],
    ]);
  });

  test("labels anchor dates relative to today and keeps other years unambiguous", () => {
    assert.equal(formatCardAnchorLabel("2026-08-13", "2026-08-13"), "Today");
    assert.equal(formatCardAnchorLabel("2026-08-14", "2026-08-13"), "Tomorrow");
    assert.equal(formatCardAnchorLabel("2026-08-12", "2026-08-13"), "Yesterday");
    assert.equal(formatCardAnchorLabel("2026-09-01", "2026-08-13"), "1 Sept");
    assert.equal(formatCardAnchorLabel("2027-01-05", "2026-08-13"), "5 Jan 2027");
    assert.equal(formatCardAnchorLabel("", "2026-08-13"), "");
  });

  test("groups archived cards into newest-first months with undated last", () => {
    const groups = groupCardItemsByMonth([
      { id: "july-late", title: "Beta", anchorDate: "2026-07-31" },
      { id: "undated", title: "No date", anchorDate: "" },
      { id: "august", title: "Gamma", anchorDate: "2026-08-02" },
      { id: "july-early-b", title: "Bravo", anchorDate: "2026-07-01" },
      { id: "july-early-a", title: "Alpha", anchorDate: "2026-07-01" },
    ]);
    assert.deepEqual(
      groups.map((group) => [group.key, group.label, group.items.map((item) => item.id)]),
      [
        ["2026-08", "August 2026", ["august"]],
        ["2026-07", "July 2026", ["july-late", "july-early-a", "july-early-b"]],
        ["undated", "No date", ["undated"]],
      ],
    );
  });
});
