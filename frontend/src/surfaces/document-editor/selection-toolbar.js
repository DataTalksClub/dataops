// The inline formatting toolbar: select text in a formatted block and a
// small bar offers bold, italic, code and link. Cmd/Ctrl+B, I, E and K do
// the same from the keyboard. Formatting changes the DOM; the block reads it
// back as markdown (see inline-markdown.js).

import { escapeHtml } from "../../core/html.js";
import { promptInline } from "./inline-prompt.js";

const BUTTONS = [
  { kind: "strong", label: "Bold", text: "B", hint: "⌘B" },
  { kind: "em", label: "Italic", text: "I", hint: "⌘I" },
  { kind: "code", label: "Code", text: "</>", hint: "⌘E" },
  { kind: "link", label: "Link", text: "Link", hint: "⌘K" },
];

function richEditableOf(node) {
  const element = node?.nodeType === 3 ? node.parentElement : node;
  return element?.closest?.('[data-editable="rich"]') || null;
}

function enclosing(range, tag, root) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentElement;
  const found = node?.closest?.(tag);
  return found && root.contains(found) ? found : null;
}

function unwrap(element) {
  const parent = element.parentNode;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function notifyInput(editable, inputType) {
  editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
}

export function applyFormat(editable, kind) {
  const doc = editable.ownerDocument;
  const selection = doc.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return;

  if (kind === "strong" || kind === "em") {
    doc.execCommand(kind === "strong" ? "bold" : "italic");
    return;
  }
  if (kind === "code") {
    const existing = enclosing(range, "code", editable);
    if (existing) {
      unwrap(existing);
    } else if (!range.collapsed) {
      const code = doc.createElement("code");
      code.setAttribute("data-md", "`");
      code.textContent = range.toString();
      range.deleteContents();
      range.insertNode(code);
      range.setStartAfter(code);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    notifyInput(editable, "formatCode");
    return;
  }
  if (kind === "link") {
    const existing = enclosing(range, "a", editable);
    const saved = range.cloneRange();
    const rect = range.getBoundingClientRect();
    promptInline({
      anchorRect: rect,
      placeholder: "Paste a link",
      value: existing?.getAttribute("data-href") || existing?.getAttribute("href") || "",
      submitLabel: existing ? "Update" : "Link",
    }).then((url) => {
      editable.focus({ preventScroll: true });
      const restored = doc.getSelection();
      restored.removeAllRanges();
      restored.addRange(saved);
      if (url === null) return;
      if (existing) {
        existing.setAttribute("href", url);
        existing.setAttribute("data-href", url);
        notifyInput(editable, "formatCreateLink");
        return;
      }
      if (saved.collapsed) {
        doc.execCommand("insertHTML", false,
          `<a href="${escapeHtml(url)}" data-href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
        return;
      }
      doc.execCommand("createLink", false, url);
    });
  }
}

export function installSelectionToolbar(root) {
  const doc = root.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "selection-toolbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Format text");
  bar.hidden = true;
  let target = null;

  for (const button of BUTTONS) {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = `selection-toolbar-button is-${button.kind}`;
    el.textContent = button.text;
    el.title = `${button.label} (${button.hint})`;
    el.setAttribute("aria-label", button.label);
    el.dataset.kind = button.kind;
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => {
      if (!target) return;
      applyFormat(target, button.kind);
      update();
    });
    bar.append(el);
  }
  doc.body.append(bar);

  function hide() {
    bar.hidden = true;
    target = null;
  }

  function update() {
    const selection = doc.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !root.isConnected) return hide();
    const range = selection.getRangeAt(0);
    const editable = richEditableOf(range.commonAncestorContainer);
    if (!editable || !root.contains(editable) || !range.toString().trim()) return hide();
    target = editable;
    for (const button of bar.querySelectorAll(".selection-toolbar-button")) {
      const kind = button.dataset.kind;
      const tag = { strong: "strong, b", em: "em, i", code: "code", link: "a" }[kind];
      button.setAttribute("aria-pressed", String(Boolean(enclosing(range, tag, editable))));
    }
    bar.hidden = false;
    const rect = range.getBoundingClientRect();
    const width = bar.offsetWidth || 180;
    const height = bar.offsetHeight || 32;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, (globalThis.innerWidth || 1200) - width - 8));
    const top = rect.top - height - 8 > 8 ? rect.top - height - 8 : rect.bottom + 8;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  doc.addEventListener("selectionchange", update);
  globalThis.addEventListener?.("scroll", hide, true);
  // Keyboard shortcuts from editable.js arrive as "editable:format".
  root.addEventListener("editable:format", (event) => {
    const editable = event.target.closest?.('[data-editable="rich"]');
    if (editable) applyFormat(editable, event.detail.kind);
  });
  return { hide, update };
}
