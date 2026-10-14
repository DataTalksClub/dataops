import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  convertItem,
  duplicateStep,
  emitProcedure,
  findStep,
  flowOf,
  groupsOf,
  insertAfter,
  joinGroupAbove,
  markerSafe,
  mergeIntoPrevious,
  moveItem,
  newProse,
  newScreenshot,
  newStep,
  nudgeItem,
  parseProcedure,
  procedureHeading,
  removeItem,
  setGroupTitle,
  setProcedureHeading,
  setScreenshotField,
  setStepAttrs,
  setStepBody,
  setTodoText,
  splitStep,
  startGroupAt,
  stepsOf,
  todosOf,
} from "../src/surfaces/document-editor/procedure-model.js";

const GROUPED = [
  "## Procedure",
  "",
  '<!-- sop-todo: "Confirm the export folder" -->',
  "",
  '<!-- sop-group-start: "Prepare" -->',
  "### Prepare",
  "",
  "<!-- sop-prose-start -->",
  "Intro prose that belongs to the Prepare group.",
  "<!-- sop-prose-end -->",
  "",
  '<!-- sop-step-start id=1 systems="drive" action="upload" -->',
  "1.  Upload the file to the [shared folder](https://example.test/folder).",
  "",
  "    Use drag and drop.",
  "",
  "    <!-- sop-screenshot-start -->",
  "    ![Upload dialog](../images/upload.png)",
  "    <!-- sop-caption-start -->",
  "    The upload dialog.",
  "    <!-- sop-caption-end -->",
  "    <!-- sop-screenshot-end -->",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-step-start id=2 -->",
  "2.  Rename the file.",
  "<!-- sop-step-end -->",
  "<!-- sop-group-end -->",
  "",
  '<!-- sop-group-start: "Publish" -->',
  "### Publish",
  "",
  "<!-- sop-step-start id=3 -->",
  "3.  Share the link.",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-prose-start -->",
  "Closing note for Publish.",
  "<!-- sop-prose-end -->",
  "<!-- sop-group-end -->",
].join("\n");

const FLAT = [
  "## Procedure",
  "",
  "<!-- sop-step-start id=1 -->",
  "1.  First.",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-step-start id=2 -->",
  "2.  Second.",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-step-start id=3 -->",
  "3.  Third.",
  "<!-- sop-step-end -->",
].join("\n");

describe("procedure model", () => {
  test("parses an ordered tree and emits it byte-for-byte when untouched", () => {
    const model = parseProcedure(GROUPED);
    assert.equal(emitProcedure(model), GROUPED);
    assert.equal(procedureHeading(model), "Procedure");
    assert.deepEqual(todosOf(model).map((t) => t.text), ["Confirm the export folder"]);
    const groups = groupsOf(model);
    assert.deepEqual(groups.map((g) => g.title), ["Prepare", "Publish"]);
    assert.deepEqual(groups[0].children.map((c) => c.kind), ["prose", "step", "step"]);
    assert.deepEqual(groups[1].children.map((c) => c.kind), ["step", "prose"]);
    const [first] = stepsOf(model);
    assert.equal(first.body, "Upload the file to the [shared folder](https://example.test/folder).\n\nUse drag and drop.");
    assert.deepEqual(first.attrs, { systems: ["drive"], action: "upload" });
    assert.equal(first.screenshots[0].src, "../images/upload.png");
    assert.equal(first.screenshots[0].alt, "Upload dialog");
    assert.equal(first.screenshots[0].caption, "The upload dialog.");
    assert.equal(emitProcedure(parseProcedure(FLAT)), FLAT);
  });

  test("text edits regenerate only the edited item", () => {
    const model = parseProcedure(GROUPED);
    setStepBody(findStep(model, 2), "Rename the file\nso it matches the episode.");
    const out = emitProcedure(model);
    assert.match(out, /<!-- sop-step-start id=2 -->\n2\. {2}Rename the file\n {4}so it matches the episode\.\n<!-- sop-step-end -->/);
    // The neighbouring step, its attributes and screenshot are untouched.
    assert.ok(out.includes(GROUPED.split("\n").slice(11, 23).join("\n")));
    assert.match(out, /Intro prose that belongs to the Prepare group\.\n<!-- sop-prose-end -->\n\n<!-- sop-step-start id=1/);
  });

  test("Enter splits a step and renumbers without moving prose out of its group", () => {
    const model = parseProcedure(GROUPED);
    const step = findStep(model, 2);
    const created = splitStep(model, step, "Rename the file.", "Check the name.");
    assert.equal(created.id, 3);
    assert.deepEqual(stepsOf(model).map((s) => s.id), [1, 2, 3, 4]);
    const out = emitProcedure(model);
    assert.match(out, /<!-- sop-step-start id=3 -->\n3\. {2}Check the name\.\n<!-- sop-step-end -->\n<!-- sop-group-end -->/);
    // The untouched step after the split keeps its source lines with a new number.
    assert.match(out, /<!-- sop-step-start id=4 -->\n4\. {2}Share the link\./);
    // Prose stays where it was: first in Prepare, last in Publish.
    const reparsed = parseProcedure(out);
    assert.deepEqual(groupsOf(reparsed)[0].children.map((c) => c.kind), ["prose", "step", "step", "step"]);
    assert.deepEqual(groupsOf(reparsed)[1].children.map((c) => c.kind), ["step", "prose"]);
    assert.equal(emitProcedure(reparsed), out);
  });

  test("Backspace at the start merges into the previous flow item across groups", () => {
    const model = parseProcedure(GROUPED);
    const third = findStep(model, 3);
    const merged = mergeIntoPrevious(model, third, third.body);
    assert.equal(merged.target, findStep(model, 2));
    assert.equal(merged.target.body, "Rename the file. Share the link.");
    assert.equal(merged.caret, "Rename the file. ".length);
    assert.deepEqual(groupsOf(model)[1].children.map((c) => c.kind), ["prose"]);
    // The first flow item has nothing before it.
    const prose = groupsOf(model)[0].children[0];
    assert.equal(mergeIntoPrevious(model, prose, prose.body), null);
  });

  test("merging moves screenshots onto the previous step", () => {
    const model = parseProcedure(GROUPED);
    const second = findStep(model, 2);
    const first = findStep(model, 1);
    removeItem(model, second);
    insertAfter(model, groupsOf(model)[0].children[0], second);
    // Order is now prose, step(2 text "Rename"), step(1 with screenshot).
    const withShot = stepsOf(model)[1];
    assert.equal(withShot, first);
    mergeIntoPrevious(model, first, first.body);
    assert.equal(stepsOf(model).length, 2);
    assert.equal(stepsOf(model)[0].screenshots.length, 1);
    const out = emitProcedure(model);
    assert.match(out, /1\. {2}Rename the file\. Upload the file[\s\S]*sop-screenshot-start[\s\S]*<!-- sop-step-end -->/);
  });

  test("Shift+Tab starts a group at a step and Tab joins it back", () => {
    const model = parseProcedure(FLAT);
    const second = findStep(model, 2);
    const group = startGroupAt(model, second);
    assert.deepEqual(groupsOf(model).map((g) => g.title), ["Steps", "New group"]);
    assert.equal(group.title, "New group");
    assert.deepEqual(group.children.map((s) => s.id), [2, 3]);
    let out = emitProcedure(model);
    assert.match(out, /<!-- sop-group-start: "Steps" -->\n### Steps\n\n<!-- sop-step-start id=1 -->/);
    assert.match(out, /<!-- sop-step-end -->\n<!-- sop-group-end -->\n\n<!-- sop-group-start: "New group" -->/);
    // Every step lives in a group once groups exist.
    const reparsed = parseProcedure(out);
    assert.equal(reparsed.items.filter((i) => i.kind === "step").length, 0);

    assert.equal(joinGroupAbove(reparsed, findStep(reparsed, 2)), groupsOf(reparsed)[0]);
    assert.equal(groupsOf(reparsed).length, 1);
    assert.equal(joinGroupAbove(reparsed, findStep(reparsed, 1)), "flat");
    out = emitProcedure(reparsed);
    assert.equal(groupsOf(parseProcedure(out)).length, 0);
    assert.deepEqual(stepsOf(parseProcedure(out)).map((s) => s.body), ["First.", "Second.", "Third."]);
  });

  test("Shift+Tab inside a group splits it; first steps and non-first steps of a group are guarded", () => {
    const model = parseProcedure(GROUPED);
    assert.equal(startGroupAt(model, findStep(model, 3)), null);
    const group = startGroupAt(model, findStep(model, 2), "Review");
    assert.deepEqual(groupsOf(model).map((g) => g.title), ["Prepare", "Review", "Publish"]);
    assert.deepEqual(group.children.map((s) => s.id), [2]);
    assert.equal(joinGroupAbove(model, findStep(model, 3)), groupsOf(model)[1]);
    assert.equal(joinGroupAbove(model, findStep(model, 3)), null);
  });

  test("moves, nudges, duplicates and converts items", () => {
    const model = parseProcedure(FLAT);
    const [one, two, three] = stepsOf(model);
    assert.equal(moveItem(model, three, one, true), true);
    assert.deepEqual(stepsOf(model).map((s) => s.body), ["Third.", "First.", "Second."]);
    assert.equal(nudgeItem(model, two, -1), true);
    assert.deepEqual(stepsOf(model).map((s) => s.body), ["Third.", "Second.", "First."]);
    const copy = duplicateStep(model, two);
    assert.equal(copy.body, "Second.");
    assert.deepEqual(stepsOf(model).map((s) => s.id), [1, 2, 3, 4]);
    const prose = convertItem(model, copy, "prose");
    assert.equal(prose.kind, "prose");
    assert.deepEqual(flowOf(model).map((i) => i.kind), ["step", "step", "prose", "step"]);
    const out = emitProcedure(model);
    assert.match(out, /<!-- sop-prose-start -->\nSecond\.\n<!-- sop-prose-end -->/);
    assert.deepEqual(stepsOf(parseProcedure(out)).map((s) => s.id), [1, 2, 3]);
  });

  test("markers stay parseable when titles, todos and attributes contain quotes", () => {
    const model = parseProcedure(GROUPED);
    setGroupTitle(groupsOf(model)[0], 'Prepare "raw" audio');
    setTodoText(todosOf(model)[0], 'Ask "Ops"');
    setStepAttrs(findStep(model, 2), { action: "click", tool: 'the "Save" button', systems: ["drive"] });
    setProcedureHeading(model, "How to do it");
    const out = emitProcedure(model);
    assert.match(out, /^## How to do it\n/);
    assert.match(out, /<!-- sop-group-start: "Prepare 'raw' audio" -->\n### Prepare 'raw' audio/);
    assert.match(out, /<!-- sop-todo: "Ask 'Ops'" -->/);
    assert.match(out, /<!-- sop-step-start id=2 action="click" tool="the 'Save' button" systems="drive" -->/);
    const reparsed = parseProcedure(out);
    assert.equal(groupsOf(reparsed)[0].title, "Prepare 'raw' audio");
    assert.equal(markerSafe('a "b"\nc'), "a 'b' c");
  });

  test("screenshot caption edits regenerate the screenshot block", () => {
    const model = parseProcedure(GROUPED);
    const shot = findStep(model, 1).screenshots[0];
    setScreenshotField(shot, "caption", "");
    setScreenshotField(shot, "alt", "Upload");
    const out = emitProcedure(model);
    assert.match(out, / {4}<!-- sop-screenshot-start -->\n {4}!\[Upload\]\(\.\.\/images\/upload\.png\)\n {4}<!-- sop-screenshot-end -->/);
    assert.doesNotMatch(out, /sop-caption-start/);
  });

  test("new steps and prose land in the last group of a grouped procedure", () => {
    const model = parseProcedure(GROUPED);
    insertAfter(model, null, newStep("Tail step."));
    insertAfter(model, null, newProse("Tail prose."));
    const last = groupsOf(model).at(-1);
    assert.deepEqual(last.children.map((c) => c.kind), ["step", "prose", "step", "prose"]);
    const out = emitProcedure(model);
    assert.match(out, /<!-- sop-prose-end -->\n\n<!-- sop-step-start id=4 -->\n4\. {2}Tail step\.\n<!-- sop-step-end -->\n\n<!-- sop-prose-start -->\nTail prose\.\n<!-- sop-prose-end -->\n<!-- sop-group-end -->$/);
  });

  test("an uploaded screenshot appends lines without regenerating the step", () => {
    const model = parseProcedure(GROUPED);
    const step = findStep(model, 1);
    step.screenshots.push(newScreenshot("content/images/new.png"));
    const out = emitProcedure(model);
    assert.ok(out.includes(GROUPED.split("\n").slice(11, 22).join("\n")));
    assert.match(out, / {4}<!-- sop-screenshot-end -->\n\n {4}<!-- sop-screenshot-start -->\n {4}!\[\]\(content\/images\/new\.png\)\n {4}<!-- sop-screenshot-end -->\n<!-- sop-step-end -->/);
    assert.equal(stepsOf(parseProcedure(out))[0].screenshots.length, 2);
  });
});
