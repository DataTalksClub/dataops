import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { issueSourceKey, planNewsletterSync, readNewsletterCsv, sheetCount, sheetIssueDate, sheetIssues, sheetRate } from "../src/newsletterSheet.mjs";

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

  test("creates what is missing, protects DataOps names and links on past issues, and only fills upcoming ones", () => {
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
        // DataOps' name is kept and the sheet's company link is not applied
        // over a different name. The empty secondary fills from the sheet;
        // two companies named Synthetic Beta mean no link.
        primary: { sponsor: "Old name", sheetId: "NL-61" },
        secondary: { sheetId: "NL-61-secondary", sponsor: "Synthetic Beta", documentUrl: "https://docs.example.com/beta" },
      },
    });
    const upcoming = plan.updates.find((item) => item.id === "i-310");
    assert.deepEqual(upcoming.changes, { issueNumber: 310, slots: { primary: { sponsor: "Booked in DataOps", organizationId: "org-x", sheetId: "NL-310" } } });
    assert.deepEqual(plan.conflicts.map((item) => item.differences), [
      [
        'primary sponsor "Old name" vs sheet "Synthetic Alpha"',
        'secondary sponsor "Synthetic Beta" matches 2 companies (org-beta-1, org-beta-2); no company link',
      ],
      ['primary sponsor "Booked in DataOps" vs sheet "Synthetic Future"'],
    ]);

    // Applied, a second run has nothing to write.
    const applied = existing.map((issue) => {
      const update = plan.updates.find((item) => item.id === issue.id);
      return update ? { ...issue, ...update.changes, slots: { ...issue.slots, ...update.changes.slots } } : issue;
    });
    for (const item of plan.creates) applied.push({ id: item.sheetId, label: item.sheetId, version: 1, ...item.body });
    const again = planNewsletterSync(sheetIssues(rows, today).issues, applied, organizations, today);
    assert.deepEqual([again.creates.length, again.updates.length], [0, 0]);
  });

  test("an ambiguous company keeps the issue's existing link and is reported (NVIDIA/Nvidia)", () => {
    const nvidiaRows = [
      row(2, { date: "14 Sep 26", sponsor: "Nvidia", "promo type": "Primary Slot", id: "NL-300" }),
    ];
    const { issues: sheet } = sheetIssues(nvidiaRows, today);
    const organizations = [
      { id: "org-nvidia", displayName: "NVIDIA" },
      { id: "org-nvidia-2", displayName: "Nvidia" },
    ];
    const existing = [{
      id: "i-300", label: "Weekly #300", version: 3, kind: "weekly", issueNumber: 300, publicationDate: "2026-09-14", status: "sent",
      sourceKey: issueSourceKey("NL-300"),
      slots: { primary: { sheetId: "NL-300", sponsor: "NVIDIA", organizationId: "org-nvidia" }, secondary: {} },
    }];
    const plan = planNewsletterSync(sheet, existing, organizations, today);
    assert.deepEqual(plan.creates, []);
    // The link survives: nothing is written over it.
    assert.deepEqual(plan.updates, []);
    assert.deepEqual(plan.conflicts.map((item) => item.differences), [[
      'primary sponsor "Nvidia" matches 2 companies (org-nvidia, org-nvidia-2); keeping the existing company link',
    ]]);
  });

  test("a company link in DataOps is never overwritten by the sheet's own match", () => {
    const svelteRows = [
      row(2, { date: "14 Sep 26", sponsor: "Svelte", "promo type": "Primary Slot", id: "NL-300" }),
    ];
    const { issues: sheet } = sheetIssues(svelteRows, today);
    const organizations = [{ id: "org-svelte", displayName: "Svelte" }];
    const existing = [{
      id: "i-300", label: "Weekly #300", version: 3, kind: "weekly", issueNumber: 300, publicationDate: "2026-09-14", status: "sent",
      sourceKey: issueSourceKey("NL-300"),
      slots: { primary: { sheetId: "NL-300", sponsor: "NVIDIA", organizationId: "org-nvidia" }, secondary: {} },
    }];
    const plan = planNewsletterSync(sheet, existing, organizations, today);
    assert.deepEqual(plan.updates, []);
    assert.deepEqual(plan.conflicts.flatMap((item) => item.differences), [
      'primary sponsor "NVIDIA" vs sheet "Svelte"',
      "primary company link org-nvidia vs sheet org-svelte",
    ]);
  });

  test("sync never overwrites a past issue's corrected sponsor name and company link", () => {
    const correctedRows = [
      row(2, { date: "1 Jun 26", sponsor: "Nvidia", "promo type": "Primary Slot", id: "NL-288", doc: "Doc 288" }, { doc: "https://docs.example.com/288" }),
    ];
    const { issues: sheet } = sheetIssues(correctedRows, today);
    const organizations = [
      { id: "org-nvidia", displayName: "NVIDIA" },
      { id: "org-nvidia-2", displayName: "Nvidia" },
    ];
    const existing = [{
      id: "i-288", label: "Weekly #288", version: 7, kind: "weekly", issueNumber: 288,
      publicationDate: "2026-06-01", status: "sent",
      sourceKey: issueSourceKey("NL-288"),
      slots: { primary: { sheetId: "NL-288", sponsor: "NVIDIA Corporation", organizationId: "org-nvidia" }, secondary: {} },
    }];
    const plan = planNewsletterSync(sheet, existing, organizations, today);
    // The corrected name and link stay; the document link still follows the sheet.
    assert.deepEqual(plan.updates.map((item) => item.changes), [{
      slots: { primary: { sheetId: "NL-288", sponsor: "NVIDIA Corporation", organizationId: "org-nvidia", documentUrl: "https://docs.example.com/288" } },
    }]);
    assert.deepEqual(plan.conflicts.flatMap((item) => item.differences), [
      'primary sponsor "NVIDIA Corporation" vs sheet "Nvidia"',
      'primary sponsor "Nvidia" matches 2 companies (org-nvidia, org-nvidia-2); keeping the existing company link',
    ]);
  });

  test("finds the header row below the tab's banner row in a CSV export", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "newsletter-csv-")), "newsletter.csv");
    writeFileSync(file, [
      "DataTalks.Club newsletter schedule (banner row above the header)",
      "Date,Sponsor,Promo Type,URL,Doc,Note,ID",
      "14 Feb 22,Synthetic Alpha,Primary Slot,https://mailchi.mp/example/weekly-61,,week 61,NL-61",
      "14 Feb 22,Synthetic Beta,Secondary Slot,,,doc in the Sponsors tab,NL-61-secondary",
    ].join("\n"));
    const { issues, skipped } = sheetIssues(readNewsletterCsv(file), today);
    assert.deepEqual(issues.map((issue) => issue.sheetId), ["NL-61"]);
    assert.equal(issues[0].slots.primary.sponsor, "Synthetic Alpha");
    assert.equal(issues[0].slots.secondary.sponsor, "Synthetic Beta");
    assert.deepEqual(skipped, []);
  });

  test("refuses a Newsletter export that has no header row", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "newsletter-csv-")), "no-header.csv");
    writeFileSync(file, "some text\nsome more text\n");
    assert.throws(() => readNewsletterCsv(file), /No header row/);
  });

  test("parses historical Mailchimp, LinkedIn, and X stats and merges without overwriting existing metrics", () => {
    assert.equal(sheetCount("99,714"), 99714);
    assert.equal(sheetCount("15,188 views"), 15188);
    assert.equal(sheetCount("33.193"), 33193);
    assert.equal(sheetCount("???"), undefined);
    assert.equal(sheetRate("2.38%", 831, 34886), 2.38);
    assert.equal(sheetRate("", 650, 15188), 4.28);
    assert.equal(sheetRate("3121.14%", 1036, 33193), 3.12);

    const statsRows = [
      row(
        2,
        {
          date: "6 Apr 26",
          sponsor: "VectorAI DB",
          "promo type": "Primary Slot",
          id: "NL-297",
          "newsletter deliveries": "99,714",
          "newsletter views opens": "34,886",
          clicks: "831",
          "unique clicks": "651",
          ctr: "2.38%",
          "linkedin impressions": "8,080",
          "linkedin clicks": "109",
          "linkedin ctr": "1.35%",
          "linkedin post": "Post",
          "twitter impressions": "2,916",
          "twitter clicks": "0",
          "twitter ctr": "0.00%",
          "twitter post": "Tweet",
        },
        {
          "linkedin post": "https://www.linkedin.com/feed/update/urn:li:activity:7446932215609192448/",
          "twitter post": "https://x.com/DataTalksClub/status/2041170969592254836",
        },
      ),
      row(
        3,
        {
          date: "6 Apr 26",
          sponsor: "Astronomer",
          "promo type": "Secondary Slot",
          id: "NL-297-secondary",
          clicks: "273",
          "unique clicks": "185",
          ctr: "0.78%",
          "linkedin impressions": "2,639",
          "linkedin clicks": "49",
          "linkedin ctr": "1.86%",
          "linkedin post": "https://www.linkedin.com/feed/update/urn:li:activity:7447329446212612098/",
          "twitter impressions": "1,295",
          "twitter clicks": "7",
          "twitter ctr": "0.54%",
          "twitter post": "https://x.com/DataTalksClub/status/2041566603948195932",
        },
      ),
    ];

    const { issues: sheet } = sheetIssues(statsRows, today);
    assert.equal(sheet.length, 1);
    assert.deepEqual(sheet[0].stats, {
      sent: 99714,
      opens: 34886,
      clicks: 831,
      uniqueClicks: 651,
      openRate: 34.99,
      clickRate: 2.38,
    });
    assert.equal(sheet[0].slots.primary.stats.linkedinImpressions, 8080);
    assert.equal(sheet[0].slots.primary.stats.xPostUrl, "https://x.com/DataTalksClub/status/2041170969592254836");
    assert.equal(sheet[0].slots.secondary.stats.clicks, 273);
    assert.equal(sheet[0].slots.secondary.stats.xClicks, 7);

    // Existing issue without stats gets statsUpdated = 1
    const baseIssue = {
      id: "i-297",
      label: "Weekly #297",
      version: 1,
      kind: "weekly",
      issueNumber: 297,
      publicationDate: "2026-04-06",
      status: "sent",
      sourceKey: issueSourceKey("NL-297"),
      slots: {
        primary: { sheetId: "NL-297", sponsor: "VectorAI DB" },
        secondary: { sheetId: "NL-297-secondary", sponsor: "Astronomer" },
      },
    };
    const firstPlan = planNewsletterSync(sheet, [baseIssue], [], today);
    assert.equal(firstPlan.updates.length, 1);
    assert.equal(firstPlan.statsUpdated, 1);
    assert.equal(firstPlan.conflicts.length, 0);

    // Once saved with recordedAt, a second sync is a no-op
    const savedIssue = {
      ...baseIssue,
      stats: { ...firstPlan.updates[0].changes.stats, recordedAt: "2026-10-17T12:00:00.000Z" },
      slots: {
        primary: {
          ...firstPlan.updates[0].changes.slots.primary,
          stats: { ...firstPlan.updates[0].changes.slots.primary.stats, recordedAt: "2026-10-17T12:00:00.000Z" },
        },
        secondary: {
          ...firstPlan.updates[0].changes.slots.secondary,
          stats: { ...firstPlan.updates[0].changes.slots.secondary.stats, recordedAt: "2026-10-17T12:00:00.000Z" },
        },
      },
    };
    const secondPlan = planNewsletterSync(sheetIssues(statsRows, today).issues, [savedIssue], [], today);
    assert.equal(secondPlan.updates.length, 0);
    assert.equal(secondPlan.statsUpdated, 0);
    assert.equal(secondPlan.conflicts.length, 0);

    // If DataOps already has a differing metric, sync reports a conflict and does not overwrite it
    const conflictingIssue = {
      ...savedIssue,
      stats: { ...savedIssue.stats, opens: 35000 },
    };
    const conflictPlan = planNewsletterSync(sheetIssues(statsRows, today).issues, [conflictingIssue], [], today);
    assert.equal(conflictPlan.updates.length, 0);
    assert.deepEqual(conflictPlan.conflicts[0].differences, ["issue stats opens 35000 vs sheet 34886"]);
  });
});
