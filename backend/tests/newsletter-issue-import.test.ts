import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { inspectNewsletterIssues, issueSourceKey } from "../scripts/import-newsletter-issues";

async function workbook(rows: unknown[][]) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "newsletter-import-")), "schedule.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Newsletter");
  for (const row of rows) sheet.addRow(row);
  await book.xlsx.writeFile(file);
  return file;
}

const header = ["Date", "Sponsor", "Promo Type", "URL", "Doc", "Note", "Newsletter deliveries", "ID"];
const url = (issue: number) => ({ text: `https://mailchi.mp/example/weekly-${issue}`, hyperlink: `https://mailchi.mp/example/weekly-${issue}` });
const doc = (name: string) => ({ text: name, hyperlink: `https://docs.example.com/${name}` });

describe("newsletter issue import", () => {
  it("groups primary and secondary rows into one issue per email", async () => {
    const result = await inspectNewsletterIssues(await workbook([
      header,
      [new Date("2027-01-04T00:00:00Z"), "Sponsor A", "Primary Slot", url(310), doc("a"), "", 1000, "NL-310"],
      [{ formula: "A2+0", result: new Date("2027-01-04T00:00:00Z") }, "Sponsor B", "Secondary Slot", url(310), doc("b"), "", "", "NL-310-secondary"],
      [new Date("2027-01-06T00:00:00Z"), "Sponsor D", "Stand-Alone Newsletter", "", "", "", "", "NL-2027-01-06-standalone"],
      [new Date("2027-01-11T00:00:00Z"), "Sponsor C", "Primary Slot", url(311), "", "", "", "NL-311"],
      [new Date("2027-01-18T00:00:00Z"), "N/A", "Primary Slot", url(312), "", "", "", "NL-312"],
      [new Date("2027-01-25T00:00:00Z"), "N/A", "Vacation", "Vacation", "", "Holiday", "", "NL-2027-01-25-vacation"],
    ]), { today: "2027-01-05" });
    assert.deepEqual(result.report.reasons, {});
    assert.equal(result.report.rows, 6);
    assert.deepEqual(result.issues.map(({ sourceType, ...issue }) => issue), [
      {
        kind: "weekly", publicationDate: "2027-01-04", issueNumber: 310, status: "sent",
        slots: {
          primary: { ticked: true, sheetId: "NL-310", sponsor: "Sponsor A", documentUrl: "https://docs.example.com/a" },
          secondary: { ticked: true, sheetId: "NL-310-secondary", sponsor: "Sponsor B", documentUrl: "https://docs.example.com/b" },
        },
        sourceKey: issueSourceKey("NL-310"),
      },
      {
        kind: "standalone", publicationDate: "2027-01-06", status: "planned",
        slots: { primary: { ticked: true, sheetId: "NL-2027-01-06-standalone", sponsor: "Sponsor D" } },
        sourceKey: issueSourceKey("NL-2027-01-06-standalone"),
      },
      {
        kind: "weekly", publicationDate: "2027-01-11", issueNumber: 311, status: "planned",
        slots: { primary: { ticked: true, sheetId: "NL-311", sponsor: "Sponsor C" }, secondary: { ticked: false } },
        sourceKey: issueSourceKey("NL-311"),
      },
      {
        kind: "weekly", publicationDate: "2027-01-18", issueNumber: 312, status: "planned",
        slots: { primary: { ticked: true, sheetId: "NL-312" }, secondary: { ticked: false } },
        sourceKey: issueSourceKey("NL-312"),
      },
      {
        kind: "weekly", publicationDate: "2027-01-25", status: "cancelled",
        slots: { primary: { ticked: false, sheetId: "NL-2027-01-25-vacation" }, secondary: { ticked: false } },
        planningNote: "Holiday",
        sourceKey: issueSourceKey("NL-2027-01-25-vacation"),
      },
    ]);
  });

  it("keys issues by the sheet ID so moved rows keep their issue, and rejects bad rows", async () => {
    const first = await inspectNewsletterIssues(await workbook([
      header,
      [new Date("2027-03-01T00:00:00Z"), "", "Primary Slot", url(340), "", "", "", "NL-340"],
      [new Date("2027-03-08T00:00:00Z"), "", "Primary Slot", url(341), "", "", "", "NL-341"],
    ]));
    const moved = await inspectNewsletterIssues(await workbook([
      header,
      [new Date("2027-03-08T00:00:00Z"), "", "Primary Slot", url(341), "", "", "", "NL-341"],
      [new Date("2027-03-01T00:00:00Z"), "", "Primary Slot", url(340), "", "", "", "NL-340"],
      [new Date("2027-03-15T00:00:00Z"), "", "Primary Slot", url(342), "", "", "", ""],
      [new Date("2027-03-22T00:00:00Z"), "", "Primary Slot", url(343), "", "", "", "NL-340"],
      [new Date("2027-03-29T00:00:00Z"), "", "Banner", url(344), "", "", "", "NL-344"],
    ]));
    const keyOf = (result: typeof first, issueNumber: number) =>
      result.issues.find((issue) => issue.issueNumber === issueNumber)?.sourceKey;
    assert.equal(keyOf(moved, 340), keyOf(first, 340));
    assert.equal(keyOf(moved, 341), keyOf(first, 341));
    assert.deepEqual(moved.report.reasons, { "missing-or-invalid-id": 1, "duplicate-id": 1, "unknown-promo-type": 1 });
  });

  it("requires the schedule columns", async () => {
    await assert.rejects(
      inspectNewsletterIssues(await workbook([["Publication date", "Campaign"], [new Date(), "x"]])),
      /no date column|no type column|no id column/,
    );
  });
});
