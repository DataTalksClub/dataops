// Covers the one-off scripts/link-newsletter-cards.ts; delete together with it.
import { describe, it } from "node:test";
import assert from "node:assert";
import { planLinks } from "../scripts/link-newsletter-cards";

const slot = (id: string, publicationDate: string, campaignNumber: number | null, extra = {}) => ({
  id, version: 1, publicationDate, campaignNumber, status: "open", ...extra,
});
const card = (id: string, anchorDate: string | null, issueNumber: string | null) => ({
  id, title: `Synthetic ${id}`, anchorDate, issueNumber,
});

describe("newsletter card backfill plan", () => {
  it("links by issue, then nearest date, and reports conflicts", () => {
    const plan = planLinks(
      [
        card("by-issue", "2027-04-05", "350"),
        card("by-date", "2027-04-14", null),
        card("far-issue", "2027-06-01", "352"),
        card("twin-a", "2027-04-26", null),
        card("twin-b", "2027-04-27", null),
        card("tie", "2027-05-13", null),
        card("nothing", "2028-01-01", null),
        card("done", "2027-03-01", "340"),
      ],
      [
        slot("s-issue", "2027-04-06", 350),
        slot("s-date", "2027-04-12", null),
        slot("s-far", "2027-04-19", 352),
        slot("s-twin", "2027-04-26", null),
        slot("s-tie-1", "2027-05-11", null),
        slot("s-tie-2", "2027-05-15", null),
        slot("s-linked", "2027-03-01", 340, { cardId: "done" }),
        slot("s-cancelled", "2028-01-01", null, { status: "cancelled" }),
      ],
    );
    assert.deepEqual(plan.links.map(({ cardId, slotId, by }) => [cardId, slotId, by]), [
      ["by-issue", "s-issue", "issue"],
      ["by-date", "s-date", "date"],
    ]);
    assert.deepEqual(plan.alreadyLinked, [{ cardId: "done", slotId: "s-linked" }]);
    assert.deepEqual(plan.mismatches.map(({ cardId }) => cardId), ["far-issue"]);
    assert.deepEqual(plan.duplicates, [{ slotId: "s-twin", cardIds: ["twin-a", "twin-b"] }]);
    assert.deepEqual(plan.ambiguous, [{ cardId: "tie", slotIds: ["s-tie-1", "s-tie-2"] }]);
    assert.deepEqual(plan.unmatched.map(({ cardId }) => cardId), ["nothing"]);
  });
});
