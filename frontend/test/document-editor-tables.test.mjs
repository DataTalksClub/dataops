import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseMarkdownBlocks, serializeBlocksToMarkdown } from "../src/surfaces/document-editor/block-model.js";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  serializeTable,
  setCell,
  splitTableRow,
} from "../src/surfaces/document-editor/table-model.js";

const TABLE = [
  "| Step | Owner | Notes |",
  "| :--- | :-: | ---: |",
  "| transcript | Reviewer | See [guide](https://x.test/a?b=1) and **bold** |",
  "| audio | Producer | a \\| b |",
].join("\n");

describe("table blocks", () => {
  test("a pipe table is one table block and round-trips byte for byte", () => {
    const md = `Intro\n\n${TABLE}\n\nOutro\n`;
    const blocks = parseMarkdownBlocks(md);
    assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "table", "paragraph"]);
    assert.equal(blocks[1].raw, TABLE);
    assert.equal(serializeBlocksToMarkdown(blocks), md.trim());
  });

  test("tables without outer pipes and single-column tables are tables; prose with a pipe is not", () => {
    assert.equal(parseMarkdownBlocks("a | b\n--- | ---\n1 | 2")[0].type, "table");
    assert.equal(parseMarkdownBlocks("| a |\n| --- |\n| 1 |")[0].type, "table");
    assert.equal(parseMarkdownBlocks("use a | b here\n---")[0].type, "paragraph");
    assert.equal(parseMarkdownBlocks("a | b\n\n| c | d |")[0].type, "paragraph");
  });

  test("cells split on unescaped pipes only", () => {
    assert.deepEqual(splitTableRow("| a \\| b | c |"), ["a \\| b", "c"]);
    assert.deepEqual(splitTableRow("a | | c"), ["a", "", "c"]);
  });

  test("parse and serialize keep alignment, links and formatting", () => {
    const table = parseTable(TABLE);
    assert.deepEqual(table.aligns, ["left", "center", "right"]);
    assert.equal(table.rows[0][2], "See [guide](https://x.test/a?b=1) and **bold**");
    assert.equal(
      serializeTable(table),
      TABLE.replace("| :--- | :-: | ---: |", "| :--- | :---: | ---: |"),
    );
  });

  test("editing a cell escapes pipes and flattens newlines", () => {
    const next = setCell(parseTable(TABLE), 1, 1, "x | y\nz");
    assert.match(serializeTable(next), /\| audio \| x \\\| y z \| a \\\| b \|/);
  });

  test("rows and columns are inserted, moved and deleted with the header and alignment", () => {
    const table = parseTable(TABLE);
    assert.equal(insertRow(table, 0).rows.length, 3);
    assert.deepEqual(insertRow(table, 1).rows[1], ["", "", ""]);
    assert.deepEqual(deleteRow(table, 0).rows.map((r) => r[0]), ["audio"]);
    assert.deepEqual(moveRow(table, 0, 1).rows.map((r) => r[0]), ["audio", "transcript"]);
    const wider = insertColumn(table, 1);
    assert.deepEqual(wider.header, ["Step", "", "Owner", "Notes"]);
    assert.deepEqual(wider.aligns, ["left", "", "center", "right"]);
    assert.ok(wider.rows.every((r) => r.length === 4));
    assert.deepEqual(moveColumn(table, 0, 2).header, ["Owner", "Notes", "Step"]);
    assert.deepEqual(deleteColumn(table, 1).header, ["Step", "Notes"]);
    assert.equal(deleteColumn(parseTable("| a |\n| --- |"), 0).header.length, 1);
  });

  test("ragged rows are padded to the widest row", () => {
    const table = parseTable("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n| 4 |");
    assert.deepEqual(table.header, ["a", "b", ""]);
    assert.deepEqual(table.rows, [["1", "2", "3"], ["4", "", ""]]);
  });
});
