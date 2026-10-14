import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { inspectNewsletterSlots } from "../scripts/import-newsletter-slots";

async function workbook(rows: unknown[][]) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "newsletter-import-")), "schedule.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Newsletter");
  for (const row of rows) sheet.addRow(row);
  await book.xlsx.writeFile(file);
  return file;
}

describe("newsletter slot import", () => {
  it("keys slots by the ID column so moved rows keep their slot", async () => {
    const header = ["ID", "Publication date", "Campaign", "Issue number", "Status"];
    const first = await inspectNewsletterSlots(await workbook([
      header,
      ["nl-0001", new Date("2027-03-01T00:00:00Z"), "Synthetic Issue A", 340, "open"],
      ["nl-0002", new Date("2027-03-08T00:00:00Z"), "Synthetic Issue B", 341, "open"],
    ]));
    const moved = await inspectNewsletterSlots(await workbook([
      header,
      ["nl-0000", new Date("2027-02-22T00:00:00Z"), "Inserted Issue", 339, "open"],
      ["nl-0002", new Date("2027-03-08T00:00:00Z"), "Synthetic Issue B", 341, "open"],
      ["nl-0001", new Date("2027-03-01T00:00:00Z"), "Synthetic Issue A", 340, "open"],
      ["", new Date("2027-03-15T00:00:00Z"), "No ID", 342, "open"],
      ["nl-0001", new Date("2027-03-22T00:00:00Z"), "Repeated ID", 343, "open"],
    ]));
    assert.equal(first.report.keyedBy, "id-column");
    const keyOf = (result: typeof first, label: string) =>
      result.rows.find((row) => row.campaignLabel === label)?.sourceKey;
    assert.equal(keyOf(moved, "Synthetic Issue A"), keyOf(first, "Synthetic Issue A"));
    assert.equal(keyOf(moved, "Synthetic Issue B"), keyOf(first, "Synthetic Issue B"));
    assert.deepEqual(moved.report.reasons, { "missing-or-invalid-id": 1, "duplicate-id": 1 });
  });
  it("keys slots by row while the sheet has no ID column", async () => {
    const result = await inspectNewsletterSlots(await workbook([
      ["Publication date", "Campaign", "Status"],
      [new Date("2027-03-01T00:00:00Z"), "Synthetic Issue A", "open"],
    ]));
    assert.equal(result.report.keyedBy, "row");
    assert.equal(result.rows.length, 1);
  });
  it("derives label, issue and status from the schedule sheet layout", async () => {
    const url = (issue: number) => ({ text: `https://mailchi.mp/example/weekly-${issue}`, hyperlink: `https://mailchi.mp/example/weekly-${issue}` });
    const header = ["Date", "Sponsor", "Promo Type", "URL", "Doc", "Newsletter deliveries", "Newsletter views (opens)", "ID"];
    const result = await inspectNewsletterSlots(await workbook([
      header,
      [new Date("2027-01-04T00:00:00Z"), "Sponsor A", "Primary Slot", url(310), "", 1000, 400, "NL-310"],
      [{ formula: "A2+0", result: new Date("2027-01-04T00:00:00Z") }, "Sponsor B", "Secondary Slot", url(310), "", "", "", "NL-310-secondary"],
      [new Date("2027-01-06T00:00:00Z"), "N/A", "Stand-Alone Newsletter", "", "", "", "", "NL-2027-01-06-standalone"],
      [new Date("2027-01-11T00:00:00Z"), "Sponsor C", "Primary Slot", url(311), "", "", "", "NL-311"],
      [new Date("2027-01-18T00:00:00Z"), "", "Primary Slot", url(312), "", "", "", "NL-312"],
      [new Date("2027-01-25T00:00:00Z"), "N/A", "Vacation", "Vacation", "", "", "", "NL-2027-01-25-vacation"],
    ]), { today: "2027-01-05" });
    assert.deepEqual(result.report.reasons, {});
    assert.deepEqual(
      result.rows.map(({ publicationDate, campaignLabel, campaignNumber, status, bookedByDisplayName }) =>
        ({ publicationDate, campaignLabel, campaignNumber, status, bookedByDisplayName })),
      [
        { publicationDate: "2027-01-04", campaignLabel: "Weekly #310", campaignNumber: 310, status: "sent", bookedByDisplayName: "Sponsor A" },
        { publicationDate: "2027-01-04", campaignLabel: "Weekly #310 secondary slot", campaignNumber: undefined, status: "sent", bookedByDisplayName: "Sponsor B" },
        { publicationDate: "2027-01-06", campaignLabel: "Stand-Alone Newsletter", campaignNumber: undefined, status: "open", bookedByDisplayName: undefined },
        { publicationDate: "2027-01-11", campaignLabel: "Weekly #311", campaignNumber: 311, status: "reserved", bookedByDisplayName: "Sponsor C" },
        { publicationDate: "2027-01-18", campaignLabel: "Weekly #312", campaignNumber: 312, status: "open", bookedByDisplayName: undefined },
        { publicationDate: "2027-01-25", campaignLabel: "Vacation", campaignNumber: undefined, status: "cancelled", bookedByDisplayName: undefined },
      ],
    );
  });
});
