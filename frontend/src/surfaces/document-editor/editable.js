// Always-editable text blocks.
//
// Every text block on the page is a contenteditable element: click anywhere
// and type. There is no edit mode and nothing to commit; edits are written
// to the draft as you type (debounced) and flushed on blur. Inline-only
// markdown is shown formatted (rich mode); a block holding block-level
// markdown (a nested list, a table) shows its rendered form until focused
// and its markdown source while focused (source mode).
//
// The keyboard model is the caller's: Enter, Backspace at the start, Tab and
// "/" are reported through callbacks so a step, a list item and a paragraph
// can each split, merge and indent the way their document structure allows.
// Moving between blocks with the arrow keys is handled here, in DOM order.

import {
  asSingleUrl,
  detectBlockShortcut,
  detectInlineShortcut,
  domToInlineMarkdown,
  inlineMarkdownToHtml,
  isInlineText,
  tokenizeInline,
} from "./inline-markdown.js";

const COMMIT_DELAY = 250;
let plaintextOnly = null;

function supportsPlaintextOnly(el) {
  if (plaintextOnly !== null) return plaintextOnly;
  try {
    el.contentEditable = "plaintext-only";
    plaintextOnly = el.contentEditable === "plaintext-only";
  } catch {
    plaintextOnly = false;
  }
  return plaintextOnly;
}

/** Write the focused block's pending keystrokes into the draft now. */
export function flushActiveEditable() {
  const active = globalThis.document?.activeElement;
  active?.closest?.("[data-editable]")?.__editable?.flush();
}

/** Visible text length of inline markdown, for caret placement. */
export function plainTextLength(markdown) {
  const count = (tokens) => tokens.reduce((sum, token) => {
    if (token.type === "text" || token.type === "code") return sum + token.text.length;
    if (token.type === "atom") return sum + (token.display ?? token.raw).length;
    return sum + count(token.children);
  }, 0);
  return count(tokenizeInline(markdown));
}

function selectionIn(el) {
  const selection = el.ownerDocument?.getSelection?.();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  return { selection, range };
}

function rangeFromStart(el, range) {
  const before = el.ownerDocument.createRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  return before;
}

function rangeToEnd(el, range) {
  const after = el.ownerDocument.createRange();
  after.selectNodeContents(el);
  after.setStart(range.endContainer, range.endOffset);
  return after;
}

/** Caret offset in visible text, or -1 when the caret is elsewhere. */
export function caretOffset(el) {
  const current = selectionIn(el);
  if (!current) return -1;
  return rangeFromStart(el, current.range).toString().length;
}

function textNodes(el) {
  const nodes = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(".md-atom")) nodes.push(node);
  }
  return nodes;
}

/** Put the caret at a visible-text offset ("start", "end" or a number). */
export function setCaret(el, at = "end") {
  const doc = el.ownerDocument;
  const selection = doc.getSelection?.();
  if (!selection) return;
  const range = doc.createRange();
  const total = el.textContent.length;
  let offset = at === "start" ? 0 : at === "end" ? total : Math.max(0, Math.min(total, at));
  if (offset >= total) {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    let placed = false;
    for (const node of textNodes(el)) {
      const length = node.nodeValue.length;
      if (offset <= length) {
        range.setStart(node, offset);
        range.collapse(true);
        placed = true;
        break;
      }
      offset -= length;
    }
    if (!placed) {
      range.selectNodeContents(el);
      range.collapse(offset <= 0);
    }
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

export function focusEditable(el, at = "end") {
  if (!el) return;
  el.focus({ preventScroll: true });
  setCaret(el, at);
  el.scrollIntoView?.({ block: "nearest" });
}

/** Editable blocks in the same editor root, in document order. */
function editablesAround(el) {
  const root = el.closest("[data-editor-root]") || el.ownerDocument.body;
  return [...root.querySelectorAll("[data-editable]")].filter(
    (node) => node.isConnected && node.offsetParent !== null,
  );
}

export function neighbourEditable(el, direction) {
  const list = editablesAround(el);
  const index = list.indexOf(el);
  return index === -1 ? null : list[index + direction] || null;
}

function caretRect(range) {
  const rects = range.getClientRects?.();
  if (rects && rects.length) return rects[rects.length - 1];
  const rect = range.getBoundingClientRect?.();
  return rect && (rect.width || rect.height) ? rect : null;
}

function onFirstLine(el, range) {
  const rect = caretRect(range);
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
  return rect.top - box.top < line * 0.75;
}

function onLastLine(el, range) {
  const rect = caretRect(range);
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
  return box.bottom - rect.bottom < line * 0.75;
}

/** Map a caret in rendered text onto the matching place in its markdown. */
function mapRenderedOffset(rendered, markdown, offset) {
  let j = 0;
  for (let k = 0; k < markdown.length; k += 1) {
    if (j >= offset) return k;
    if (markdown[k] === rendered[j]) j += 1;
  }
  return markdown.length;
}

/**
 * Make `el` an always-editable block. Returns a controller with `flush()`.
 *
 * Options: getValue, commit, restore, multiline, singleLine, plain,
 * placeholder, placeholderOnFocus, autoFocus, selectionRange, onSplit,
 * onEnterNewBlock, onMergePrevious, onDeleteBlock, onIndent, onOutdent,
 * onSlash, onBlockShortcut, onEscape, onPasteText, onFiles, renderAtom,
 * onActivity.
 */
export function attachEditable(el, options) {
  const {
    getValue,
    commit,
    restore,
    multiline = true,
    singleLine = false,
    plain = false,
    placeholder = "",
    placeholderOnFocus = false,
    autoFocus = false,
    selectionRange = null,
    renderAtom,
    resolveLink,
  } = options;
  let committed = getValue() ?? "";
  let timer = null;
  let slash = null;
  const mode = plain ? "plain" : isInlineText(committed) ? "rich" : "source";
  const controller = { el, mode, flush };
  el.__editable = controller;
  el.dataset.editable = mode;
  el.classList.add("inline-editable");
  if (placeholder) el.dataset.placeholder = placeholder;
  if (placeholderOnFocus) el.dataset.placeholderFocus = "";
  // Headings keep their heading role; other blocks announce as text boxes.
  if (!/^H[1-6]$/i.test(el.tagName || "") && el.getAttribute("role") == null) {
    el.setAttribute("role", "textbox");
    if (multiline && !singleLine) el.setAttribute("aria-multiline", "true");
  }
  el.spellcheck = true;

  const showValue = (value) => {
    if (mode === "rich") {
      el.innerHTML = inlineMarkdownToHtml(value, { renderAtom, resolveLink });
      for (const link of el.querySelectorAll("a")) link.addEventListener("click", onLinkClick);
    }
    else el.textContent = value;
    markEmpty();
  };
  const markEmpty = () => {
    const empty = !el.textContent.replace(/​/g, "").length &&
      !el.querySelector?.("img, .md-atom");
    el.toggleAttribute?.("data-empty", empty);
  };

  if (mode === "rich" || mode === "plain") {
    showValue(committed);
    if (mode === "plain" && supportsPlaintextOnly(el)) el.contentEditable = "plaintext-only";
    else el.contentEditable = "true";
  } else {
    // Source mode keeps the caller's rendered view until the block is focused.
    el.contentEditable = supportsPlaintextOnly(el) ? "plaintext-only" : "true";
    markEmpty();
  }

  // Links in text are text: a click places the caret. A wiki link (an atom)
  // or a Cmd/Ctrl+click follows the link.
  function onLinkClick(event) {
    const link = event.currentTarget;
    const atom = link.closest?.(".md-atom");
    if (!atom && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    options.onFollowLink?.(link);
  }

  function read() {
    let value = mode === "rich" ? domToInlineMarkdown(el) : el.innerText ?? el.textContent;
    value = value.replace(/​/g, "").replace(/ /g, " ");
    if (singleLine || !multiline) value = value.replace(/\s*\n+\s*/g, " ");
    else value = value.replace(/\n+$/, "");
    return value;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    // A block replaced by a re-render must not write its stale model back.
    if (!el.isConnected) return committed;
    if (mode === "source" && !el.classList.contains("is-source")) return committed;
    const value = read();
    if (value !== committed) {
      committed = value;
      commit(value);
    }
    return committed;
  }
  controller.read = () => (mode === "source" && !el.classList.contains("is-source") ? committed : read());

  function schedule() {
    options.onActivity?.();
    clearTimeout(timer);
    timer = setTimeout(flush, COMMIT_DELAY);
  }

  el.addEventListener("focus", () => {
    if (mode !== "source" || el.classList.contains("is-source")) return;
    // Swap the rendered view for the markdown, keeping the caret near the
    // spot that was clicked.
    const rendered = el.textContent;
    const clicked = caretOffset(el);
    el.classList.add("is-source");
    el.textContent = committed;
    markEmpty();
    const at = clicked < 0 ? "end" : mapRenderedOffset(rendered, committed, clicked);
    setCaret(el, at);
  });

  el.addEventListener("blur", () => {
    closeSlash();
    flush();
    if (mode === "source") {
      el.classList.remove("is-source");
      restore?.();
      markEmpty();
    }
  });

  el.addEventListener("input", (event) => {
    markEmpty();
    if (slash) updateSlash();
    else if (event.inputType === "insertText" && event.data === "/") startSlash();
    if (event.inputType === "insertText" && mode !== "plain") {
      if (applyBlockShortcut()) return;
      if (mode === "rich") applyInlineShortcut();
    }
    schedule();
  });

  el.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (slash?.controller && slash.controller.isOpen?.()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        slash.controller.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        slash.controller.choose();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSlash();
        return;
      }
    }
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      flush();
      if (options.onEscape) options.onEscape();
      else el.blur();
      return;
    }
    if (mod && mode === "rich" && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i" || key === "e" || key === "k") {
        event.preventDefault();
        event.stopPropagation();
        el.dispatchEvent(new CustomEvent("editable:format", {
          bubbles: true, detail: { kind: { b: "strong", i: "em", e: "code", k: "link" }[key] },
        }));
        return;
      }
    }
    if (event.key === "Enter") return onEnter(event, mod);
    if (event.key === "Backspace") return onBackspace(event);
    if (event.key === "Tab") return onTab(event);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") return onVertical(event);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") return onHorizontal(event);
  });

  el.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const files = [...(data.files || [])].filter((file) => file.type?.startsWith("image/"));
    if (files.length && options.onFiles) {
      event.preventDefault();
      event.stopPropagation();
      flush();
      options.onFiles(files);
      return;
    }
    const text = data.getData("text/plain");
    event.preventDefault();
    event.stopPropagation();
    if (!text) return;
    const url = asSingleUrl(text);
    const current = selectionIn(el);
    if (url && mode === "rich" && current && !current.range.collapsed) {
      // Pasting a link over selected text links the text, like Notion.
      el.ownerDocument.execCommand("createLink", false, url);
      for (const link of el.querySelectorAll("a:not([data-href])")) {
        link.setAttribute("data-href", link.getAttribute("href"));
        link.addEventListener("click", onLinkClick);
      }
      schedule();
      return;
    }
    if (options.onPasteText && options.onPasteText(text, controller)) return;
    insertText(singleLine || !multiline ? text.replace(/\s*\n+\s*/g, " ") : text);
  });

  el.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type?.startsWith("image/"));
    if (files.length && options.onFiles) {
      event.preventDefault();
      event.stopPropagation();
      flush();
      options.onFiles(files);
      return;
    }
    // Rich HTML dropped from elsewhere would bypass the markdown model.
    if (event.dataTransfer?.types?.includes("text/html")) {
      event.preventDefault();
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        el.focus();
        insertText(text);
      }
    }
  });

  function insertText(text) {
    const doc = el.ownerDocument;
    if (!doc.execCommand?.("insertText", false, text)) {
      const current = selectionIn(el);
      if (!current) return;
      current.range.deleteContents();
      current.range.insertNode(doc.createTextNode(text));
      current.range.collapse(false);
    }
    markEmpty();
    schedule();
  }
  controller.insertText = insertText;
  controller.splitAtCaret = () => splitAtCaret();

  function splitAtCaret() {
    const current = selectionIn(el);
    if (!current) return { before: read(), after: "" };
    current.range.deleteContents();
    const beforeRange = rangeFromStart(el, current.range);
    const afterRange = rangeToEnd(el, current.range);
    const toMarkdown = (range) => {
      const fragment = range.cloneContents();
      return mode === "rich" ? domToInlineMarkdown(fragment) : fragment.textContent;
    };
    return { before: toMarkdown(beforeRange), after: toMarkdown(afterRange) };
  }

  function onEnter(event, mod) {
    if (event.shiftKey) {
      if (singleLine || !multiline) event.preventDefault();
      return;
    }
    // In source mode Enter is a newline; Cmd/Ctrl+Enter leaves the block.
    if (mode === "source" && !mod) return;
    event.preventDefault();
    if (options.onSplit) {
      const { before, after } = splitAtCaret();
      committed = before;
      clearTimeout(timer);
      options.onSplit(before.replace(/\s+$/, ""), after.replace(/^\s+/, ""));
      return;
    }
    flush();
    if (options.onEnterNewBlock) options.onEnterNewBlock();
    else el.blur();
  }

  function atStart() {
    const current = selectionIn(el);
    return Boolean(current && current.range.collapsed &&
      !rangeFromStart(el, current.range).toString().length &&
      !rangeFromStart(el, current.range).cloneContents().querySelector?.(".md-atom, img"));
  }

  function atEnd() {
    const current = selectionIn(el);
    return Boolean(current && current.range.collapsed &&
      !rangeToEnd(el, current.range).toString().length);
  }

  function onBackspace(event) {
    if (!atStart()) return;
    const value = read();
    if (!value.trim() && options.onDeleteBlock) {
      event.preventDefault();
      clearTimeout(timer);
      options.onDeleteBlock();
      return;
    }
    if (options.onMergePrevious) {
      event.preventDefault();
      clearTimeout(timer);
      committed = value;
      options.onMergePrevious(value);
    }
  }

  function onTab(event) {
    const handler = event.shiftKey ? options.onOutdent : options.onIndent;
    if (!handler) return;
    event.preventDefault();
    const current = selectionIn(el);
    const offset = current ? rangeFromStart(el, current.range).toString().length : 0;
    flush();
    handler({ start: offset, end: offset });
  }

  function onVertical(event) {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    const current = selectionIn(el);
    if (!current || !current.range.collapsed) return;
    const up = event.key === "ArrowUp";
    if (up ? !onFirstLine(el, current.range) : !onLastLine(el, current.range)) return;
    const target = neighbourEditable(el, up ? -1 : 1);
    if (!target) return;
    event.preventDefault();
    flush();
    focusEditable(target, up ? "end" : "start");
  }

  function onHorizontal(event) {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    const left = event.key === "ArrowLeft";
    if (left ? !atStart() : !atEnd()) return;
    const target = neighbourEditable(el, left ? -1 : 1);
    if (!target) return;
    event.preventDefault();
    flush();
    focusEditable(target, left ? "end" : "start");
  }

  // ---------- markdown shortcuts as you type ----------

  function applyBlockShortcut() {
    if (!options.onBlockShortcut) return false;
    const current = selectionIn(el);
    if (!current || !current.range.collapsed) return false;
    const before = rangeFromStart(el, current.range).toString();
    const shortcut = detectBlockShortcut(before);
    if (!shortcut || shortcut.rest) return false;
    const rest = read().slice(shortcut.marker.length);
    if (!options.onBlockShortcut(shortcut.type, rest)) return false;
    clearTimeout(timer);
    return true;
  }

  function applyInlineShortcut() {
    const current = selectionIn(el);
    if (!current || !current.range.collapsed) return;
    const node = current.range.startContainer;
    if (node.nodeType !== 3 || node.parentElement?.closest("code, a, .md-atom")) return;
    const text = node.nodeValue.slice(0, current.range.startOffset);
    const found = detectInlineShortcut(text);
    if (!found) return;
    const doc = el.ownerDocument;
    const tag = found.kind === "strong" ? "strong" : found.kind === "em" ? "em" : "code";
    const wrapper = doc.createElement(tag);
    wrapper.setAttribute("data-md", found.marker);
    wrapper.textContent = found.inner;
    const tail = node.splitText(current.range.startOffset);
    node.nodeValue = text.slice(0, found.start);
    node.parentNode.insertBefore(wrapper, tail);
    // Continue typing after the formatted text, outside of it.
    const spacer = doc.createTextNode("​");
    node.parentNode.insertBefore(spacer, tail);
    const range = doc.createRange();
    range.setStart(spacer, 1);
    range.collapse(true);
    current.selection.removeAllRanges();
    current.selection.addRange(range);
  }

  // ---------- "/" commands ----------

  function startSlash() {
    if (!options.onSlash) return;
    const current = selectionIn(el);
    if (!current || !current.range.collapsed) return;
    const node = current.range.startContainer;
    const offset = current.range.startOffset - 1;
    if (node.nodeType !== 3 || node.nodeValue[offset] !== "/") return;
    const previous = offset > 0 ? node.nodeValue[offset - 1] : rangeFromStart(el, current.range).toString().slice(-2, -1);
    if (previous && !/\s/.test(previous)) return;
    slash = {
      node,
      offset,
      query: "",
      controller: null,
      anchorRect: caretRect(current.range) || el.getBoundingClientRect(),
    };
    const session = {
      targetEl: el,
      anchorRect: slash.anchorRect,
      attach: (menuController) => {
        if (slash) slash.controller = menuController;
      },
      // Remove the typed "/query" before the chosen command runs.
      consume: () => {
        if (!slash) return;
        const { node: textNode, offset: start, query } = slash;
        slash = null;
        if (textNode.isConnected) textNode.deleteData(start, Math.min(1 + query.length, textNode.length - start));
        markEmpty();
        flush();
      },
      text: () => read(),
      detach: () => {
        slash = null;
      },
    };
    options.onSlash(session);
  }

  function updateSlash() {
    const current = selectionIn(el);
    const { node, offset } = slash;
    if (!current || current.range.startContainer !== node || !node.isConnected ||
        node.nodeValue[offset] !== "/" || current.range.startOffset <= offset) {
      closeSlash();
      return;
    }
    const query = node.nodeValue.slice(offset + 1, current.range.startOffset);
    if (/\s\s|^\s/.test(query) || query.length > 24) {
      closeSlash();
      return;
    }
    slash.query = query;
    slash.controller?.setQuery(query);
  }

  function closeSlash() {
    if (!slash) return;
    const menu = slash.controller;
    slash = null;
    menu?.close();
  }

  if (autoFocus) {
    // A microtask, not a timer: keys typed right after Enter must already
    // land in the new block.
    queueMicrotask(() => {
      if (!el.isConnected) return;
      if (selectionRange) {
        el.focus({ preventScroll: true });
        setCaret(el, selectionRange.start);
      } else {
        focusEditable(el, "end");
      }
    });
  }

  return controller;
}
