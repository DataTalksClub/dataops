import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The vendored dakit dismiss helper (src/dakit/dakit-dialogs.js) is the
// shared click-outside layer for every native <dialog> in the app — the
// calendar forms, the finance forms, anything opened with showModal().
// Pin its contract here: a click that began and ended on the backdrop
// (which lands on the dialog element itself) closes an open dialog; a
// click that began inside the panel never does, not even when the drag
// ends outside.

const listeners = new Map();
class StubDocument {
  addEventListener(type, listener, options) {
    const capture = options === true || !!(options && options.capture);
    const key = capture ? `${type}:capture` : `${type}:bubble`;
    const list = listeners.get(key) || [];
    list.push(listener);
    listeners.set(key, list);
  }
  removeEventListener() {}
}

globalThis.HTMLDialogElement = class HTMLDialogElement {};
globalThis.document = new StubDocument();
await import("../src/dakit/dakit-dialogs.js");

function fire(key, event) {
  for (const listener of listeners.get(key) || []) listener(event);
}

function pressAndClick(target) {
  fire("pointerdown:capture", { target });
  fire("click:bubble", { target });
}

function stubDialog() {
  const dialog = new globalThis.HTMLDialogElement();
  dialog.open = true;
  dialog.closeCalls = 0;
  dialog.close = () => {
    dialog.closeCalls += 1;
    dialog.open = false;
  };
  return dialog;
}

describe("dakit dialog dismissal", () => {
  test("a click on the backdrop closes an open dialog", () => {
    const dialog = stubDialog();
    pressAndClick(dialog);
    assert.equal(dialog.closeCalls, 1);
  });

  test("a click inside the panel does not close the dialog", () => {
    const dialog = stubDialog();
    const button = { parentNode: dialog };
    pressAndClick(button);
    assert.equal(dialog.closeCalls, 0);
  });

  test("a drag from the panel to the backdrop does not close the dialog", () => {
    const dialog = stubDialog();
    const button = { parentNode: dialog };
    fire("pointerdown:capture", { target: button });
    fire("click:bubble", { target: dialog });
    assert.equal(dialog.closeCalls, 0);
  });

  test("a backdrop click on a closed dialog does not call close", () => {
    const dialog = stubDialog();
    dialog.open = false;
    pressAndClick(dialog);
    assert.equal(dialog.closeCalls, 0);
  });
});
