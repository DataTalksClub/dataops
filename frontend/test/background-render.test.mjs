import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createBackgroundRender,
  interactionHold,
  isEditingControl,
  snapshotFingerprint,
} from "../src/runtime/background-render.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

function element(documentRef, tagName, props = {}) {
  const node = documentRef.createElement(tagName);
  Object.assign(node, props);
  return node;
}

// A workspace whose render replaces every element under the root, the way
// the real surfaces do with documentList.replaceChildren(...).
function createHarness({ summaryAfterFirstPaint = false } = {}) {
  const shell = new FakeElement("main");
  const documentRef = new FakeDocument(shell);
  const root = element(documentRef, "div", { id: "document-list" });
  const outside = element(documentRef, "input", { type: "search" });
  shell.append(outside, root);
  let renders = 0;
  let controls;
  function paint() {
    for (const child of [...root.children]) child.remove();
    const heading = element(documentRef, "h3");
    heading.textContent = "Read-only diagnostics";
    const select = element(documentRef, "select");
    select.setAttribute("aria-label", "Default assignee");
    const note = element(documentRef, "textarea");
    const save = element(documentRef, "button", { type: "button" });
    save.textContent = "Save";
    const form = element(documentRef, "form");
    form.append(note, save);
    if (summaryAfterFirstPaint && controls) {
      const summary = element(documentRef, "p");
      summary.textContent = "Loaded";
      root.append(summary);
    }
    root.append(heading, select, form);
    controls = { heading, select, note, save, form };
  }
  paint();
  const timers = [];
  const scheduler = createBackgroundRender({
    documentRef,
    root,
    render() {
      renders += 1;
      paint();
    },
    setTimeoutImpl: (callback) => timers.push(callback),
  });
  return {
    documentRef,
    root,
    outside,
    scheduler,
    controls: () => controls,
    renders: () => renders,
    // Run the settle check the scheduler queued after an event.
    async settle(type, values = {}) {
      await documentRef.dispatch(type, values);
      while (timers.length) timers.shift()();
    },
  };
}

describe("background render gate", () => {
  test("fingerprints plain data, Maps and Sets by value", () => {
    assert.equal(
      snapshotFingerprint({ cards: [{ id: "a" }], seen: new Set(["x"]) }),
      snapshotFingerprint({ cards: [{ id: "a" }], seen: new Set(["x"]) }),
    );
    assert.notEqual(
      snapshotFingerprint({ byId: new Map([["a", 1]]) }),
      snapshotFingerprint({ byId: new Map([["a", 2]]) }),
    );
  });

  test("knows which controls lose work when they are replaced", () => {
    assert.equal(isEditingControl(new FakeElement("select")), true);
    assert.equal(isEditingControl(new FakeElement("textarea")), true);
    assert.equal(isEditingControl(Object.assign(new FakeElement("input"), { type: "text" })), true);
    assert.equal(isEditingControl(Object.assign(new FakeElement("input"), { type: "checkbox" })), false);
    assert.equal(isEditingControl(Object.assign(new FakeElement("div"), { isContentEditable: true })), true);
    assert.equal(isEditingControl(new FakeElement("button")), false);
    assert.equal(isEditingControl(null), false);
  });

  test("a refresh whose data did not change does not repaint", () => {
    const harness = createHarness();
    const data = { cards: [{ id: "c1", title: "Same" }] };
    assert.equal(
      harness.scheduler.request({ previous: data, next: structuredClone(data) }),
      "unchanged",
    );
    assert.equal(harness.renders(), 0);
    assert.equal(harness.scheduler.hasPending(), false);
  });

  test("changed data repaints at once when the operator is not busy", () => {
    const harness = createHarness();
    assert.equal(
      harness.scheduler.request({ previous: { n: 1 }, next: { n: 2 } }),
      "rendered",
    );
    assert.equal(harness.renders(), 1);
  });

  test("an open select waits, keeps its element, and the update lands on blur", async () => {
    const harness = createHarness();
    const select = harness.controls().select;
    select.focus();
    assert.equal(
      harness.scheduler.request({ previous: { n: 1 }, next: { n: 2 } }),
      "deferred",
    );
    assert.equal(harness.renders(), 0);
    assert.equal(harness.documentRef.activeElement, select);
    assert.equal(select.parentElement, harness.root);

    // Clicking inside the still-focused select settles nothing.
    await harness.settle("click", { target: select });
    assert.equal(harness.renders(), 0);

    select.blur();
    await harness.settle("focusout", { target: select });
    assert.equal(harness.renders(), 1);
    assert.equal(harness.scheduler.hasPending(), false);
  });

  test("an open modal dialog holds the repaint until it closes", async () => {
    const harness = createHarness();
    const dialog = element(harness.documentRef, "dialog", { open: true });
    const reason = element(harness.documentRef, "textarea");
    dialog.append(reason);
    harness.documentRef.addRoot(dialog);
    reason.focus();
    reason.value = "Self-hosted event";
    assert.equal(interactionHold({ documentRef: harness.documentRef, root: harness.root }), "dialog");
    assert.equal(harness.scheduler.request(), "deferred");
    assert.equal(reason.value, "Self-hosted event");

    dialog.open = false;
    dialog.remove();
    await harness.settle("close", { target: dialog });
    assert.equal(harness.renders(), 1);
  });

  test("an open Card or Task dialog holds the repaint until it closes, except the first data", async () => {
    const harness = createHarness();
    const panel = element(harness.documentRef, "section");
    const modal = element(harness.documentRef, "div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    panel.append(modal);
    harness.documentRef.addRoot(panel);
    assert.equal(interactionHold({ documentRef: harness.documentRef, root: harness.root }), "modal");
    // A dialog opened from the address does not keep the page under it empty.
    assert.equal(harness.scheduler.request({ initial: true }), "rendered");
    assert.equal(harness.renders(), 1);
    assert.equal(harness.scheduler.request(), "deferred");

    panel.hidden = true;
    await harness.settle("focusin", { target: harness.controls().heading });
    assert.equal(harness.renders(), 2);
  });

  test("an open menu holds the repaint until it hides", async () => {
    const harness = createHarness();
    const menu = element(harness.documentRef, "div");
    menu.setAttribute("role", "menu");
    harness.root.append(menu);
    assert.equal(harness.scheduler.request(), "deferred");
    menu.hidden = true;
    await harness.settle("keyup", { key: "Escape" });
    assert.equal(harness.renders(), 1);
  });

  test("typed text keeps the surface after focus moves to a button, until submit", async () => {
    const harness = createHarness();
    const { note, save, form } = harness.controls();
    note.focus();
    note.value = "half a thought";
    await harness.documentRef.dispatch("input", { target: note, isTrusted: true });
    save.focus();
    assert.equal(
      interactionHold({ documentRef: harness.documentRef, root: harness.root }),
      null,
      "without the edit record a button focus would not hold",
    );
    assert.equal(harness.scheduler.request(), "deferred");
    await harness.settle("focusout", { target: note });
    assert.equal(harness.renders(), 0);
    assert.equal(note.value, "half a thought");

    await harness.settle("submit", { target: form });
    assert.equal(harness.renders(), 1);
  });

  test("an input outside the surface does not hold it", () => {
    const harness = createHarness();
    harness.outside.focus();
    assert.equal(harness.scheduler.request(), "rendered");
  });

  test("focus on a non-editing element moves to its replacement", () => {
    const harness = createHarness();
    const oldHeading = harness.controls().heading;
    oldHeading.focus();
    assert.equal(harness.scheduler.request(), "rendered");
    const newHeading = harness.controls().heading;
    assert.notEqual(newHeading, oldHeading);
    assert.equal(harness.documentRef.activeElement, newHeading);
  });

  test("focus follows its element when the repaint moved it", () => {
    const harness = createHarness({ summaryAfterFirstPaint: true });
    harness.controls().heading.focus();
    assert.equal(harness.scheduler.request(), "rendered");
    assert.equal(harness.documentRef.activeElement, harness.controls().heading);
  });

  test("a render the operator asked for settles a waiting repaint", async () => {
    const harness = createHarness();
    harness.controls().select.focus();
    assert.equal(harness.scheduler.request(), "deferred");
    harness.scheduler.settled();
    harness.controls().select.blur();
    await harness.settle("focusout");
    assert.equal(harness.renders(), 0);
  });

  test("a waiting repaint whose surface left the screen is dropped", async () => {
    const harness = createHarness();
    let visible = true;
    harness.controls().select.focus();
    assert.equal(
      harness.scheduler.request({ previous: 1, next: 2, when: () => visible }),
      "deferred",
    );
    visible = false;
    harness.controls().select.blur();
    await harness.settle("focusout");
    assert.equal(harness.renders(), 0);
    assert.equal(harness.scheduler.hasPending(), false);
  });
});
