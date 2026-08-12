import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  cardsHeaderViewModel,
  groupCardItemsByStage,
} from "../src/core/work-model.js";

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
});
