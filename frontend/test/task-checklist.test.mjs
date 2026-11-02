import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTaskChecklist } from "../src/surfaces/work-detail/task-checklist.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

test("Task checklist renders progress, SOP links, evidence, and tick actions", async () => {
  const previousDocument = globalThis.document;
  const document = new FakeDocument();
  globalThis.document = document;
  try {
    const calls = [];
    const root = new FakeElement("div");
    const section = renderTaskChecklist({
      id: "task-1",
      version: 3,
      status: "todo",
      checklistItems: [
        { id: "kb-1", text: "Update the listing", checked: true, instructionDocId: "sop.event.listing", link: "https://example.test/listing" },
        { id: "kb-2", text: "Notify registrants", checked: false },
      ],
    }, {
      resolveDocReference: (id) => ({ id, title: "Update an event listing", path: "content/sops/event-listing.md" }),
      toggleTaskChecklistItem: (...args) => calls.push(args),
    });

    root.append(section);
    assert.match(section.textContent, /1\/2 complete/);
    assert.equal(section.querySelector(".task-checklist-instruction")?.href, "/sops/event-listing.md");
    assert.equal(section.querySelector(".task-checklist-evidence a")?.href, "https://example.test/listing");

    const checkboxes = section.querySelectorAll("input[type=checkbox]");
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[0].checked, true);
    checkboxes[1].checked = true;
    await checkboxes[1].dispatch("change");
    assert.deepEqual(calls, [["task-1", "kb-2", true, 3]]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("completed and skipped Tasks cannot change checklist items", () => {
  const previousDocument = globalThis.document;
  globalThis.document = new FakeDocument();
  try {
    for (const status of ["done", "skipped"]) {
      const section = renderTaskChecklist({
        id: "task-1",
        version: 4,
        status,
        checklistItems: [{ id: "inline-1", text: "Review the update", checked: false }],
      }, { toggleTaskChecklistItem() {} });
      assert.equal(section.querySelector("input[type=checkbox]")?.disabled, true);
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
