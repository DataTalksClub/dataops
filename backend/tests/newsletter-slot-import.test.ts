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
});
