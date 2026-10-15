// Background repaints of the workspace surface.
//
// Data the operator did not ask for (the bootstrap work, recurring, quality and
// docs snapshots, the Users list a route hydrates) lands at an unpredictable
// moment, sometimes seconds after the page appeared. Repainting the workspace
// then replaces every element in it, so an operator who already opened a
// select, typed into a field or opened a menu loses it. This scheduler is the
// one gate every such repaint goes through:
//
// 1. A refresh whose data did not change does not repaint at all.
// 2. A changed refresh waits while the operator is in the middle of something
//    (editing a field in the surface, an open menu or modal dialog, a
//    half-typed field) and repaints once that ends: on blur, close, Escape or
//    submit.
// 3. When it repaints, keyboard focus that sat on an element of the old
//    surface (a button, a heading) moves to the same element of the new one.
//
// Repaints the operator asked for (after their own mutation, on navigation)
// do not use this gate; they render at once and settle any pending repaint.

const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range",
  "reset", "submit",
]);

const SETTLE_EVENTS = ["focusout", "click", "keyup", "submit", "close", "toggle"];

export function snapshotFingerprint(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item.values()];
    return item;
  });
}

function isElement(node) {
  return Boolean(node && typeof node === "object" && node.tagName);
}

// A control whose replacement loses what the operator is doing in it: text,
// an open native picker, a caret position.
export function isEditingControl(element) {
  if (!isElement(element)) return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName).toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has(String(element.type || "text").toLowerCase());
}

function isTextControl(element) {
  if (!isEditingControl(element)) return false;
  return String(element.tagName).toUpperCase() !== "SELECT";
}

function isShown(element) {
  if (element.isConnected === false) return false;
  // In a browser a closed menu has no boxes, however it was hidden.
  if (typeof element.getClientRects === "function") {
    return element.getClientRects().length > 0;
  }
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden === true) return false;
  }
  return true;
}

function within(root, node) {
  return Boolean(root && node && node !== root && root.contains(node));
}

// Why a repaint has to wait right now, or null when it can go ahead.
export function interactionHold({ documentRef, root, editedControls = new Set() }) {
  const active = documentRef.activeElement;
  if (within(root, active) && isEditingControl(active)) return "editing";
  for (const dialog of documentRef.querySelectorAll("dialog")) {
    if (dialog.open) return "dialog";
  }
  for (const menu of documentRef.querySelectorAll('[role="menu"]')) {
    if (isShown(menu)) return "menu";
  }
  for (const control of editedControls) {
    if (!within(root, control)) editedControls.delete(control);
    else return "unsaved";
  }
  return null;
}

// Focus is remembered by id when the element has one, otherwise by its
// position under the root together with enough of its identity (tag, name,
// label, text) that a repaint which moved rows around cannot hand focus to a
// different element.
function focusSignature(element) {
  return [
    element.tagName,
    element.getAttribute?.("name") || "",
    element.getAttribute?.("aria-label") || "",
    String(element.textContent || "").trim().slice(0, 120),
  ].join("\u0000");
}

export function captureFocus(root, documentRef) {
  const active = documentRef.activeElement;
  if (!within(root, active)) return null;
  const path = [];
  for (let current = active; current && current !== root; current = current.parentElement) {
    const parent = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
  }
  return { id: active.id || "", path, signature: focusSignature(active) };
}

export function restoreFocus(root, documentRef, captured) {
  if (!captured) return false;
  const active = documentRef.activeElement;
  // The new surface already placed focus itself; that wins.
  if (within(root, active)) return false;
  let target = null;
  if (captured.id) {
    const id = globalThis.CSS?.escape ? globalThis.CSS.escape(captured.id) : captured.id;
    target = root.querySelector(`#${id}`);
  }
  if (!target) {
    let current = root;
    for (const index of captured.path) {
      current = current?.children?.[index];
      if (!current) break;
    }
    if (current && current !== root && focusSignature(current) === captured.signature) {
      target = current;
    }
  }
  if (!target) {
    // The repaint moved it (a summary appeared above): accept the one element
    // that is unmistakably the same.
    const matches = [...root.querySelectorAll(String(captured.signature.split("\u0000")[0]).toLowerCase())]
      .filter((node) => focusSignature(node) === captured.signature);
    if (matches.length === 1) target = matches[0];
  }
  if (!target || typeof target.focus !== "function") return false;
  target.focus({ preventScroll: true });
  return true;
}

export function createBackgroundRender({
  documentRef,
  root,
  render,
  setTimeoutImpl = setTimeout,
}) {
  // One entry per waiting repaint: the condition under which it still applies
  // (its surface is on screen). Empty means nothing is waiting.
  let pending = [];
  let listening = false;
  let settleTimer = null;
  const editedControls = new Set();

  // Text the operator typed into the surface is unsaved until the surface is
  // replaced by a render, or its form is submitted.
  documentRef.addEventListener("input", (event) => {
    if (event.isTrusted === false) return;
    const target = event.target;
    if (within(root, target) && isTextControl(target)) editedControls.add(target);
  }, true);
  documentRef.addEventListener("submit", (event) => {
    for (const control of [...editedControls]) {
      if (event.target?.contains?.(control)) editedControls.delete(control);
    }
  }, true);

  function onSettle() {
    if (settleTimer !== null) return;
    // Let the event finish (focus lands on its next element, a menu hides,
    // a dialog removes itself) before asking whether the operator is done.
    settleTimer = setTimeoutImpl(() => {
      settleTimer = null;
      flush();
    }, 0);
  }

  function listen(on) {
    if (listening === on) return;
    listening = on;
    for (const type of SETTLE_EVENTS) {
      if (on) documentRef.addEventListener(type, onSettle, true);
      else documentRef.removeEventListener(type, onSettle, true);
    }
  }

  function settled() {
    pending = [];
    listen(false);
  }

  function paint() {
    const applies = pending.some((when) => when());
    settled();
    if (!applies) return "hidden";
    const focus = captureFocus(root, documentRef);
    const restore = () => restoreFocus(root, documentRef, focus);
    const result = render();
    if (result && typeof result.then === "function") result.then(restore, () => {});
    else restore();
    return "rendered";
  }

  function flush() {
    if (pending.length === 0) return "idle";
    if (interactionHold({ documentRef, root, editedControls })) return "deferred";
    return paint();
  }

  return {
    // `previous` and `next` are the data before and after the refresh; when
    // they are equal the screen already shows it. `when` says whether the
    // repaint still applies once it runs (its surface may be gone by then).
    request({ when = () => true, ...change } = {}) {
      const compared = "previous" in change && "next" in change;
      if (compared && snapshotFingerprint(change.previous) === snapshotFingerprint(change.next)) {
        return "unchanged";
      }
      pending.push(when);
      if (interactionHold({ documentRef, root, editedControls })) {
        listen(true);
        return "deferred";
      }
      return paint();
    },
    flush,
    // A render the operator asked for already shows the latest data.
    settled,
    hasPending: () => pending.length > 0,
  };
}
