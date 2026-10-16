import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { issueSourceKey, planNewsletterSync, sheetIssueDate, sheetIssues } from "../src/newsletterSheet.mjs";

// Synthetic rows shaped like the schedule sheet's Newsletter tab.
const row = (n, values, links = {}) => ({
  row: n,
  values: { date: "", sponsor: "", "promo type": "", url: "", doc: "", note: "", id: "", ...values },
  links: { url: "", doc: "", ...links },
});
const today = "2026-10-16";

const rows = [
  row(2, { date: "14 Feb 22", sponsor: "Synthetic Alpha", "promo type": "Primary Slot", url: "https://mailchi.mp/example/weekly-61", id: "NL-61" }),
  row(3, { date: "14 Feb 22", sponsor: "Synthetic Beta", "promo type": "Secondary Slot", id: "NL-61-secondary", doc: "Beta doc" }, { doc: "https://docs.example.com/beta" }),
  row(4, { date: "2 Mar 22", sponsor: "Synthetic Gamma", "promo type": "Stand-Alone Newsletter", id: "NL-2022-03-02-standalone" }),
  row(5, { date: "28 Mar 22", sponsor: "N/A", "promo type": "Vacation", id: "NL-2022-03-28-vacation" }),
  row(6, { date: "4 Jan 27", sponsor: "Synthetic Future", "promo type": "Primary Slot", id: "NL-310" }),
  row(7, { date: "", "promo type": "Primary Slot", id: "NL-62" }),
  row(8, { date: "21 Feb 22", "promo type": "Webinar", id: "NL-62" }),
];

describe("newsletter sheet", () => {
  test("reads the sheet's dates", () => {
    assert.equal(sheetIssueDate("14 Feb 22"), "2022-02-14");
    assert.equal(sheetIssueDate("4 Jan 2027"), "2027-01-04");
    assert.equal(sheetIssueDate("2026-10-19"), "2026-10-19");
    assert.equal(sheetIssueDate("31 Feb 22"), "");
  });

  test("groups rows into one issue per email, every row back to the start", () => {
    const { issues, skipped } = sheetIssues(rows, today);
    assert.deepEqual(issues.map((issue) => [issue.sheetId, issue.kind, issue.publicationDate, issue.issueNumber, issue.status]), [
      ["NL-61", "weekly", "2022-02-14", 61, "sent"],
      ["NL-2022-03-02-standalone", "standalone", "2022-03-02", undefined, "sent"],
      ["NL-2022-03-28-vacation", "weekly", "2022-03-28", undefined, "cancelled"],
      ["NL-310", "weekly", "2027-01-04", 310, "planned"],
    ]);
    assert.deepEqual(issues[0].slots, {
      primary: { sheetId: "NL-61", sponsor: "Synthetic Alpha" },
      secondary: { sheetId: "NL-61-secondary", sponsor: "Synthetic Beta", documentUrl: "https://docs.example.com/beta" },
    });
    assert.equal(issues[0].sourceKey, issueSourceKey("NL-61"));
    assert.deepEqual(skipped.map((item) => item.row), [7, 8]);
  });

  test("creates what is missing, follows the sheet for past issues, and only fills upcoming ones", () => {
    const { issues: sheet } = sheetIssues(rows, today);
    const organizations = [
      { id: "org-alpha", displayName: "Synthetic Alpha" },
      { id: "org-beta-1", displayName: "Synthetic Beta" },
      { id: "org-beta-2", displayName: "synthetic beta" },
    ];
    const existing = [
      { id: "i-61", label: "Weekly #61", version: 2, kind: "weekly", publicationDate: "2022-02-14", status: "planned",
        sourceKey: issueSourceKey("NL-61"), slots: { primary: { sponsor: "Old name" }, secondary: {} } },
      { id: "i-310", label: "Weekly #310", version: 5, kind: "weekly", publicationDate: "2027-01-04", status: "planned",
        slots: { primary: { sponsor: "Booked in DataOps", organizationId: "org-x" }, secondary: {} } },
    ];
    const plan = planNewsletterSync(sheet, existing, organizations, today);
    assert.deepEqual(plan.creates.map((item) => item.sheetId), ["NL-2022-03-02-standalone", "NL-2022-03-28-vacation"]);
    assert.equal(plan.creates[0].body.sourceType, "schedule-sheet");
    const past = plan.updates.find((item) => item.id === "i-61");
    assert.deepEqual(past.changes, {
      issueNumber: 61,
      status: "sent",
      slots: {
        // Exactly one company named Synthetic Alpha: linked. Two named Synthetic Beta: plain text.
        primary: { sponsor: "Synthetic Alpha", sheetId: "NL-61", organizationId: "org-alpha" },
        secondary: { sponsor: "Synthetic Beta", sheetId: "NL-61-secondary", documentUrl: "https://docs.example.com/beta" },
      },
    });
    const upcoming = plan.updates.find((item) => item.id === "i-310");
    assert.deepEqual(upcoming.changes, { issueNumber: 310, slots: { primary: { sponsor: "Booked in DataOps", organizationId: "org-x", sheetId: "NL-310" } } });
    assert.deepEqual(plan.conflicts.map((item) => item.differences), [['primary sponsor "Booked in DataOps" vs sheet "Synthetic Future"']]);

    // Applied, a second run has nothing to write.
    const applied = existing.map((issue) => {
      const update = plan.updates.find((item) => item.id === issue.id);
      return update ? { ...issue, ...update.changes, slots: { ...issue.slots, ...update.changes.slots } } : issue;
    });
    for (const item of plan.creates) applied.push({ id: item.sheetId, label: item.sheetId, version: 1, ...item.body });
    const again = planNewsletterSync(sheetIssues(rows, today).issues, applied, organizations, today);
    assert.deepEqual([again.creates.length, again.updates.length], [0, 0]);
  });
});
