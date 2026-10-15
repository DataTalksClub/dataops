import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { attachHovercard } from "../src/core/hovercard.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

function setup(options = {}) {
  const root = new FakeElement("main");
  const doc = new FakeDocument(root);
  globalThis.document = doc;
  const trigger = doc.createElement("a");
  trigger.matches = (selector) => (selector === ":focus-visible" ? options.focusVisible ?? true : false);
  const toggle = doc.createElement("button");
  root.append(trigger, toggle);
  let renders = 0;
  const card = attachHovercard(trigger, {
    label: "Card summary: Podcast",
    toggle,
    render: () => {
      renders += 1;
      const body = doc.createElement("p");
      body.textContent = "Summary";
      return body;
    },
  });
  return { root, doc, trigger, toggle, card, renders: () => renders };
}

const panel = (root) => root.children.find((child) => child.className === "dk-hovercard");

describe("hover card", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => {
    mock.timers.reset();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  test("opens after a short hover and stays open while the pointer is over it", async () => {
    const { root, trigger } = setup();
    await trigger.dispatch("pointerenter", { pointerType: "mouse" });
    assert.equal(panel(root), undefined);
    mock.timers.tick(350);
    const card = panel(root);
    assert.ok(card);
    assert.equal(card.getAttribute("role"), "dialog");
    assert.equal(card.getAttribute("aria-label"), "Card summary: Podcast");
    // Inserted right after the trigger, so Tab reaches it next.
    assert.equal(root.children.indexOf(card), root.children.indexOf(trigger) + 1);
    await Promise.resolve();
    assert.equal(card.textContent, "Summary");

    // Crossing the gap from the link onto the card keeps it open.
    await trigger.dispatch("pointerleave", { pointerType: "mouse" });
    await card.dispatch("pointerenter", { pointerType: "mouse" });
    mock.timers.tick(500);
    assert.ok(panel(root));
    await card.dispatch("pointerleave", { pointerType: "mouse" });
    mock.timers.tick(200);
    assert.equal(panel(root), undefined);
  });

  test("a hover that moves on before the delay never opens it", async () => {
    const { root, trigger, renders } = setup();
    await trigger.dispatch("pointerenter", { pointerType: "mouse" });
    mock.timers.tick(200);
    await trigger.dispatch("pointerleave", { pointerType: "mouse" });
    mock.timers.tick(1000);
    assert.equal(panel(root), undefined);
    assert.equal(renders(), 0);
  });

  test("touch never opens it by hover; the toggle opens and closes it", async () => {
    const { root, trigger, toggle } = setup();
    await trigger.dispatch("pointerenter", { pointerType: "touch" });
    mock.timers.tick(1000);
    assert.equal(panel(root), undefined);
    assert.equal(toggle.getAttribute("aria-haspopup"), "dialog");
    await toggle.click();
    assert.ok(panel(root));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await toggle.click();
    assert.equal(panel(root), undefined);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  test("keyboard focus opens it and Escape closes it, returning focus", async () => {
    const { root, doc, trigger } = setup();
    trigger.focus();
    await trigger.dispatch("focus");
    mock.timers.tick(350);
    assert.ok(panel(root));
    await doc.dispatch("keydown", { key: "Escape" });
    assert.equal(panel(root), undefined);
    assert.equal(doc.activeElement, trigger);
  });

  test("a mouse click focusing the link does not open it", async () => {
    const { root, trigger } = setup({ focusVisible: false });
    await trigger.dispatch("focus");
    mock.timers.tick(1000);
    assert.equal(panel(root), undefined);
  });

  test("a pointer press outside closes it", async () => {
    const { root, doc, toggle } = setup();
    await toggle.click();
    assert.ok(panel(root));
    const elsewhere = doc.createElement("div");
    root.append(elsewhere);
    await doc.dispatch("pointerdown", { target: elsewhere });
    assert.equal(panel(root), undefined);
  });
});
