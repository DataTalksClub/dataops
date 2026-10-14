import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ensureFrontmatter,
  patchFrontmatterList,
  patchFrontmatterScalar,
  readFrontmatterList,
  readFrontmatterScalar,
} from "../src/surfaces/document-editor/frontmatter.js";

const DOC = [
  "---",
  "id: sop.example.publish",
  "aliases:",
  "- content/old/path.md",
  "title: Publish the weekly example",
  "summary: Send the published link and approved cuts to the content",
  "  team with clear context.",
  "doc_type: sop",
  "tags:",
  "- maven",
  "- lightning-lesson",
  "systems: [drive, \"mail chimp\"]",
  "owner_role: education-owner",
  "---",
  "",
  "# Publish the weekly example",
].join("\n");

describe("frontmatter", () => {
  test("reads folded scalars and both list styles from the markdown", () => {
    assert.equal(
      readFrontmatterScalar(DOC, "summary"),
      "Send the published link and approved cuts to the content team with clear context.",
    );
    assert.equal(readFrontmatterScalar(DOC, "doc_type"), "sop");
    assert.deepEqual(readFrontmatterList(DOC, "tags"), ["maven", "lightning-lesson"]);
    assert.deepEqual(readFrontmatterList(DOC, "systems"), ["drive", "mail chimp"]);
    assert.deepEqual(readFrontmatterList(DOC, "aliases"), ["content/old/path.md"]);
    assert.equal(readFrontmatterScalar(DOC, "missing"), "");
    assert.deepEqual(readFrontmatterList("# No frontmatter", "tags"), []);
  });

  test("replacing a folded scalar removes its continuation lines and nothing else", () => {
    const next = patchFrontmatterScalar(DOC, "summary", 'A "short" summary', { quoted: true });
    assert.match(next, /^summary: "A \\"short\\" summary"\ndoc_type: sop$/m);
    assert.doesNotMatch(next, /team with clear context/);
    assert.equal(readFrontmatterScalar(next, "summary"), 'A "short" summary');
    assert.equal(next.replace(/^summary:.*\n/m, ""), DOC.replace(/^summary:.*\n.*\n/m, ""));
  });

  test("replacing an unindented list keeps the file's list style and drops the old items", () => {
    const next = patchFrontmatterList(DOC, "tags", ["maven", "handoff: video"]);
    assert.match(next, /^tags:\n- maven\n- "handoff: video"\nsystems:/m);
    assert.deepEqual(readFrontmatterList(next, "tags"), ["maven", "handoff: video"]);
    const inline = patchFrontmatterList(DOC, "systems", ["drive"]);
    assert.match(inline, /^systems:\n {2}- drive\nowner_role:/m);
    const emptied = patchFrontmatterList(DOC, "tags", []);
    assert.match(emptied, /^tags: \[\]\nsystems:/m);
    assert.deepEqual(readFrontmatterList(emptied, "tags"), []);
  });

  test("adds missing keys and creates frontmatter for documents without one", () => {
    const added = patchFrontmatterScalar(DOC, "status", "proposed");
    assert.match(added, /owner_role: education-owner\nstatus: proposed\n---\n/);
    const created = patchFrontmatterList(ensureFrontmatter("# Plain\n\nBody"), "tags", ["a"]);
    assert.equal(created, "---\ntags:\n  - a\n---\n# Plain\n\nBody");
    assert.deepEqual(readFrontmatterList(created, "tags"), ["a"]);
  });
});
