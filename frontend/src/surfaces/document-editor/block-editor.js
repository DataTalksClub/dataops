import { focusEditable, plainTextLength } from "./editable.js";
import { toVideoEmbed } from "./embeds.js";
import { createSlashMenu } from "./slash-menu.js";

export function parseListItems(raw, type) {
  const lines = (raw || "").split("\n");
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (type === "numbered") {
      const match = line.match(/^(\s*)(\d+)\.\s*(.*)$/);
      if (match) {
        items.push({ indent: match[1] || "", num: match[2], text: match[3] || "" });
      } else {
        items.push({ indent: "", num: "1", text: line.trim() });
      }
    } else {
      const match = line.match(/^(\s*)([-*])\s*(.*)$/);
      if (match) {
        items.push({ indent: match[1] || "", bullet: match[2], text: match[3] || "" });
      } else {
        items.push({ indent: "", bullet: "-", text: line.trim() });
      }
    }
  }
  return items;
}

export function serializeListItems(items, type) {
  if (type === "numbered") {
    const counts = new Map();
    return items.map((item) => {
      const indent = item.indent || "";
      const depth = indent.length;
      for (const level of counts.keys()) if (level > depth) counts.delete(level);
      const num = (counts.get(depth) || 0) + 1;
      counts.set(depth, num);
      return `${indent}${num}. ${item.text || ""}`;
    }).join("\n");
  }
  return items.map((item) => {
    const bullet = item.bullet || "-";
    return `${item.indent || ""}${bullet} ${item.text || ""}`;
  }).join("\n");
}

let blockCounter = 0;
const blockId = () => `blk-${++blockCounter}-${Math.random().toString(36).slice(2, 7)}`;

const IMAGE_LINE = /^!\[[^\]\n]*\]\([^)\n]+\)$/;

export function parseMarkdownBlocks(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }

    const startLine = lines[i];

    // Fenced code block:
    if (/^```/.test(startLine)) {
      const buf = [startLine];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ id: blockId(), type: "code", raw: buf.join("\n") });
      continue;
    }

    // Callout or blockquote:
    if (/^>\s?/.test(startLine)) {
      const buf = [startLine];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const isCallout = buf.some((l) => /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(l));
      blocks.push({ id: blockId(), type: isCallout ? "callout" : "quote", raw: buf.join("\n") });
      continue;
    }

    // Heading:
    const hMatch = startLine.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      blocks.push({
        id: blockId(),
        type: `h${Math.min(3, hMatch[1].length)}`,
        level: hMatch[1].length,
        raw: startLine,
        text: hMatch[2],
      });
      i++;
      continue;
    }

    // Divider:
    if (/^(?:---|\*\*\*|___)\s*$/.test(startLine)) {
      blocks.push({ id: blockId(), type: "divider", raw: "---" });
      i++;
      continue;
    }

    // To-do item:
    const todoMatch = startLine.match(/^(\s*[-*]\s+)\[([ xX])\]\s*(.*)$/);
    if (todoMatch) {
      blocks.push({
        id: blockId(),
        type: "todo",
        checked: todoMatch[2].toLowerCase() === "x",
        text: todoMatch[3],
        raw: startLine,
      });
      i++;
      continue;
    }

    // List item (bullet or numbered):
    if (/^\s*[-*]\s+/.test(startLine)) {
      const buf = [startLine];
      i++;
      while (
        i < lines.length && lines[i].trim() && /^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+\[[ xX]\]/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ id: blockId(), type: "bullet", raw: buf.join("\n") });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(startLine)) {
      const buf = [startLine];
      i++;
      while (i < lines.length && lines[i].trim() && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ id: blockId(), type: "numbered", raw: buf.join("\n") });
      continue;
    }

    // A line holding only an image or only a video link is a media block.
    if (IMAGE_LINE.test(startLine.trim()) && !lines[i + 1]?.trim()) {
      blocks.push({ id: blockId(), type: "image", raw: startLine });
      i++;
      continue;
    }
    if (/^https?:\/\/\S+$/.test(startLine.trim()) && toVideoEmbed(startLine.trim()) &&
        !lines[i + 1]?.trim()) {
      blocks.push({ id: blockId(), type: "embed", raw: startLine });
      i++;
      continue;
    }

    // Standard paragraph:
    const buf = [startLine];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^(?:---|\*\*\*|___)\s*$/.test(lines[i]) &&
      !/^\s*[-*]\s+\[([ xX])\]/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ id: blockId(), type: "paragraph", raw: buf.join("\n") });
  }

  return blocks;
}

export function serializeBlocksToMarkdown(blocks) {
  return blocks
    .map((b) => b.raw || "")
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

// ---------- block model edits (Notion-style keyboard behaviour) ----------

const CALLOUT_RE = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

/** The editable text of a single-text block (no markdown block prefix). */
export function blockText(block) {
  const raw = block.raw || "";
  switch (block.type) {
    case "h1":
    case "h2":
    case "h3":
      return raw.replace(/^#{1,6}\s+/, "");
    case "todo":
      return raw.replace(/^\s*[-*]\s+\[[ xX]\]\s?/, "");
    case "quote":
      return raw.replace(/^>\s?/gm, "");
    case "callout":
      return raw.replace(/^>\s?/gm, "").replace(/^\s*\[![A-Z]+\]\s*\n?/i, "");
    case "code":
      return raw.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    case "bullet":
    case "numbered":
      return parseListItems(raw, block.type).map((item) => item.text).join("\n");
    case "divider":
      return "";
    default:
      return raw;
  }
}

/** Markdown for a block of `type` holding `text`. */
export function blockRaw(type, text = "", { checked = false, calloutKind = "NOTE", level } = {}) {
  const value = String(text ?? "");
  switch (type) {
    case "h1":
    case "h2":
    case "h3":
      return `${"#".repeat(level || Number(type.slice(1)))} ${value}`;
    case "todo":
      return `- [${checked ? "x" : " "}] ${value}`;
    case "bullet":
      return value.split("\n").map((line) => `- ${line}`).join("\n");
    case "numbered":
      return value.split("\n").map((line, index) => `${index + 1}. ${line}`).join("\n");
    case "quote":
      return value.split("\n").map((line) => `> ${line}`).join("\n");
    case "callout":
      return `> [!${calloutKind}]\n${value.split("\n").map((line) => `> ${line}`).join("\n")}`;
    case "code":
      return `\`\`\`\n${value}\n\`\`\``;
    case "divider":
      return "---";
    default:
      return value;
  }
}

export function makeBlock(type, text = "", options = {}) {
  const raw = blockRaw(type, text, options);
  if (type === "paragraph" || type === "image" || type === "embed") {
    return { id: blockId(), type, raw };
  }
  const parsed = parseMarkdownBlocks(raw)[0] || {};
  return { ...parsed, id: blockId(), type, raw };
}

/** Turn a block into another type, keeping its text. */
export function convertBlock(block, type) {
  const options = {};
  if (type === "callout") {
    options.calloutKind = (block.raw || "").match(CALLOUT_RE)?.[1]?.toUpperCase() || "NOTE";
  }
  if (type === "todo-done") return makeBlock("todo", blockText(block), { checked: true });
  return makeBlock(type, blockText(block), options);
}

const TEXT_TYPES = new Set(["paragraph", "h1", "h2", "h3", "todo", "quote", "callout"]);

export function isTextBlock(block) {
  return TEXT_TYPES.has(block?.type);
}

/**
 * Enter at the caret: the block keeps `before`, a new block gets `after`.
 * Headings continue as paragraphs, to-dos as unchecked to-dos.
 */
export function splitBlock(blocks, index, before, after) {
  const block = blocks[index];
  const keepType = block.type === "callout" || block.type === "quote" ? block.type : block.type;
  blocks[index] = {
    ...makeBlock(keepType, before, {
      checked: block.checked,
      level: block.level,
      calloutKind: (block.raw || "").match(CALLOUT_RE)?.[1]?.toUpperCase(),
    }),
    id: block.id,
  };
  const nextType = block.type === "todo" ? "todo" : "paragraph";
  blocks.splice(index + 1, 0, makeBlock(nextType, after));
  return index + 1;
}

/**
 * Backspace at the start of a block. A formatted block first becomes a
 * paragraph; a paragraph joins the text block before it. Returns where the
 * caret goes, or null when nothing changed.
 */
export function mergeBlockBackward(blocks, index, text) {
  const block = blocks[index];
  if (block.type !== "paragraph") {
    blocks[index] = { ...makeBlock("paragraph", text), id: block.id };
    return { index, at: "start" };
  }
  const previous = blocks[index - 1];
  if (!previous) return null;
  if (previous.type === "divider") {
    blocks.splice(index - 1, 1);
    return { index: index - 1, at: "start" };
  }
  if (previous.type === "bullet" || previous.type === "numbered") {
    const items = parseListItems(previous.raw, previous.type);
    const last = items.at(-1);
    const prefix = last.text;
    last.text += text;
    blocks[index - 1] = { ...previous, raw: serializeListItems(items, previous.type) };
    blocks.splice(index, 1);
    return { index: index - 1, item: items.length - 1, prefix };
  }
  if (!isTextBlock(previous)) {
    if (!text.trim()) blocks.splice(index, 1);
    return { index: index - 1, at: "end" };
  }
  const head = blockText(previous);
  blocks[index - 1] = {
    ...makeBlock(previous.type, head + text, {
      checked: previous.checked,
      level: previous.level,
      calloutKind: (previous.raw || "").match(CALLOUT_RE)?.[1]?.toUpperCase(),
    }),
    id: previous.id,
  };
  blocks.splice(index, 1);
  return { index: index - 1, prefix: head };
}

/**
 * Take list item `itemIndex` out of the list at `index` as a paragraph,
 * splitting the list around it. Returns the paragraph's block index.
 */
export function liftListItem(blocks, index, itemIndex, text) {
  const block = blocks[index];
  const items = parseListItems(block.raw, block.type);
  const before = items.slice(0, itemIndex);
  const after = items.slice(itemIndex + 1);
  const replacement = [];
  if (before.length) replacement.push({ ...block, raw: serializeListItems(before, block.type) });
  replacement.push(makeBlock("paragraph", text));
  if (after.length) {
    // The lifted item's children move up a level with it.
    const liftedDepth = (items[itemIndex].indent || "").length;
    for (const item of after) {
      if ((item.indent || "").length <= liftedDepth) break;
      item.indent = (item.indent || "").slice(2);
    }
    replacement.push({ id: blockId(), type: block.type, raw: serializeListItems(after, block.type) });
  }
  blocks.splice(index, 1, ...replacement);
  return index + (before.length ? 1 : 0);
}

// ---------- rendering ----------

export function createBlockEditor(context, services) {
  const { renderMarkdown, attachInlineEditor } = services;
  const slashMenu = createSlashMenu({ additionalBlockTypes: services.slashMenuItems });
  let dragBlockIndex = null;

  function renderBlocksContainer({
    blocks,
    focusBlockIndex = -1,
    focus = null,
    onChange,
    onMoveBlock,
    onInsertBlock,
    onDeleteBlock,
    onReplaceBlocks = null,
  }) {
    const container = document.createElement("div");
    container.className = "notion-blocks-container";
    // Structural edits (split, merge, convert) need a callback that writes
    // the whole list; without one (the newsletter composer) blocks keep the
    // click-to-edit behaviour of the editor they were given.
    const structural = typeof onReplaceBlocks === "function";
    const replace = (focusTarget) => onReplaceBlocks(blocks, { focus: focusTarget });

    blocks.forEach((block, idx) => {
      container.append(renderSingleBlock({
        block,
        index: idx,
        container,
        blocks,
        onChange,
        onMoveBlock,
        onInsertBlock,
        onDeleteBlock,
        structural,
        replace,
      }));
    });

    const addRow = document.createElement("div");
    addRow.className = "notion-add-block-row";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "notion-add-row-btn";
    addBtn.textContent = structural ? "" : "+ Click or type '/' to add a block…";
    addBtn.setAttribute("aria-label", "Add a block at the end");
    addBtn.addEventListener("click", () => {
      if (structural) {
        const last = blocks.at(-1);
        if (last && last.type === "paragraph" && !blockText(last).trim()) {
          replace({ index: blocks.length - 1, at: "start" });
          return;
        }
        blocks.push(makeBlock("paragraph", ""));
        replace({ index: blocks.length - 1, at: "start" });
        return;
      }
      slashMenu.open({
        targetEl: addBtn,
        onSelect: (item) => {
          if (item.type === "page") {
            if (services.createSubpage) services.createSubpage(context.documentState?.currentDoc);
            return;
          }
          onInsertBlock(blocks.length, item.template ?? "");
        },
      });
    });
    addRow.append(addBtn);
    container.append(addRow);

    const target = focus || (focusBlockIndex >= 0 ? { index: focusBlockIndex, at: "end" } : null);
    if (target) {
      queueMicrotask(() => {
        if (!container.isConnected) return;
        focusBlockTarget(container, target);
      });
    }

    return container;
  }

  function focusBlockTarget(container, target) {
    const blockEl = container.querySelectorAll(":scope > .notion-block")[target.index];
    if (!blockEl) return;
    let editable = target.item != null
      ? blockEl.querySelectorAll(".notion-list-item-text")[target.item]
      : blockEl.querySelector(".inline-editable");
    if (!editable) return;
    if (editable.__editable) {
      let at = target.at ?? "end";
      if (target.prefix != null) {
        at = editable.__editable.mode === "rich" ? plainTextLength(target.prefix) : target.prefix.length;
      }
      focusEditable(editable, at);
      return;
    }
    editable.click();
    editable.querySelector(".inline-editor")?.select?.();
  }

  function renderNotionListBlock({ block, blockIndex, onChange, onDeleteBlock, onInsertBlock, structural, blocks, replace }) {
    const listEl = document.createElement(block.type === "numbered" ? "ol" : "ul");
    listEl.className = `notion-list notion-${block.type}-list`;
    let items = parseListItems(block.raw, block.type);
    if (items.length === 0) items = [{ indent: "", text: "", bullet: "-", num: "1" }];
    const write = () => {
      block.raw = serializeListItems(items, block.type);
      onChange(blockIndex, block.raw, { rerender: false });
    };

    function renderListItems(focusIndex = -1, focusSelection = null) {
      listEl.replaceChildren();
      const listStack = [listEl];
      items.forEach((item, itemIdx) => {
        const depth = Math.floor((item.indent || "").length / 2);
        while (listStack.length > depth + 1) listStack.pop();
        while (listStack.length < depth + 1) {
          const parentItem = listStack.at(-1).lastElementChild;
          if (!parentItem) break;
          const nestedList = document.createElement(block.type === "numbered" ? "ol" : "ul");
          nestedList.className = listEl.className;
          parentItem.append(nestedList);
          listStack.push(nestedList);
        }
        const targetList = listStack.at(-1);
        const li = document.createElement("li");
        li.className = "notion-list-item";
        li.dataset.itemIndex = String(itemIdx);
        if (block.type === "numbered") li.value = targetList.children.length + 1;

        const textSpan = document.createElement("span");
        textSpan.className = "notion-list-item-text";
        if (!item.text) {
          if (!structural) {
            const placeholder = document.createElement("span");
            placeholder.className = "notion-item-placeholder";
            placeholder.textContent = "List item…";
            textSpan.append(placeholder);
          }
        } else {
          textSpan.append(renderMarkdown(item.text));
        }

        const restoreItem = () => {
          textSpan.replaceChildren();
          if (!item.text) {
            const placeholder = document.createElement("span");
            placeholder.className = "notion-item-placeholder";
            placeholder.textContent = "List item…";
            textSpan.append(placeholder);
          } else {
            textSpan.append(renderMarkdown(item.text));
          }
        };

        attachInlineEditor(textSpan, {
          getValue: () => item.text || "",
          commit: (newText) => {
            item.text = newText;
            write();
          },
          restore: restoreItem,
          multiline: false,
          singleLine: true,
          commitOnEnter: true,
          autoSize: false,
          showHint: false,
          placeholder: "List",
          placeholderOnFocus: true,
          autoFocus: itemIdx === focusIndex,
          selectionRange: itemIdx === focusIndex ? focusSelection : null,
          onSplit: structural ? (before, after) => {
            if (!before.trim() && !after.trim() && !item.indent) {
              // Enter on an empty item leaves the list.
              const at = liftListItem(blocks, blockIndex, itemIdx, "");
              replace({ index: at, at: "start" });
              return;
            }
            item.text = before;
            items.splice(itemIdx + 1, 0, block.type === "numbered"
              ? { indent: item.indent, num: "1", text: after }
              : { indent: item.indent, bullet: item.bullet || "-", text: after });
            write();
            renderListItems(itemIdx + 1, { start: 0, end: 0 });
          } : undefined,
          onEnterNewBlock: structural ? undefined : () => {
            const newItem = block.type === "numbered"
              ? { indent: item.indent, num: String(itemIdx + 2), text: "" }
              : { indent: item.indent, bullet: item.bullet || "-", text: "" };
            items.splice(itemIdx + 1, 0, newItem);
            write();
            renderListItems(itemIdx + 1);
          },
          onMergePrevious: structural ? (text) => {
            item.text = text;
            if (item.indent && item.indent.length >= 2) {
              item.indent = item.indent.slice(2);
              write();
              renderListItems(itemIdx, { start: 0, end: 0 });
              return;
            }
            // Backspace at the start of a top-level item makes it a paragraph.
            const at = liftListItem(blocks, blockIndex, itemIdx, text);
            replace({ index: at, at: "start" });
          } : undefined,
          onDeleteBlock: () => {
            if (item.indent && item.indent.length >= 2) {
              item.indent = item.indent.slice(2);
              write();
              renderListItems(itemIdx);
              return;
            }
            if (structural) {
              const at = liftListItem(blocks, blockIndex, itemIdx, "");
              replace({ index: at, at: "start" });
              return;
            }
            if (items.length > 1) {
              items.splice(itemIdx, 1);
              write();
              renderListItems(Math.max(0, itemIdx - 1));
            } else {
              onDeleteBlock(blockIndex);
            }
          },
          onIndent: (selection) => {
            const maxIndent = itemIdx > 0 ? (items[itemIdx - 1].indent || "").length + 2 : 0;
            if ((item.indent || "").length + 2 <= maxIndent) {
              item.indent = (item.indent || "") + "  ";
              write();
            }
            renderListItems(itemIdx, selection);
          },
          onOutdent: (selection) => {
            if (item.indent && item.indent.length >= 2) {
              item.indent = item.indent.slice(2);
              write();
            }
            renderListItems(itemIdx, selection);
          },
          onSlash: (session) => {
            if (session) return;
            slashMenu.open({
              targetEl: textSpan,
              onSelect: (menuItem) => {
                if (menuItem.type === "page") {
                  if (services.createSubpage) services.createSubpage(context.documentState?.currentDoc);
                  return;
                }
                if (!item.text.trim()) {
                  if (items.length === 1) {
                    onChange(blockIndex, menuItem.template, { focusBlockIndex: blockIndex });
                    return;
                  }
                  items.splice(itemIdx, 1);
                  write();
                }
                onInsertBlock(blockIndex + 1, menuItem.template);
              },
            });
          },
        });

        li.append(textSpan);
        targetList.append(li);
      });
    }

    renderListItems(-1);
    return listEl;
  }

  function textBlockKeyboard({ block, index, blocks, structural, replace }) {
    if (!structural) return {};
    return {
      onSplit: (before, after) => {
        const next = splitBlock(blocks, index, before, after);
        replace({ index: next, at: "start" });
      },
      onMergePrevious: (text) => {
        const target = mergeBlockBackward(blocks, index, text);
        if (target) replace(target);
      },
      onDeleteBlock: () => {
        if (block.type !== "paragraph") {
          blocks[index] = { ...makeBlock("paragraph", ""), id: block.id };
          replace({ index, at: "start" });
          return;
        }
        if (blocks.length === 1) return;
        blocks.splice(index, 1);
        replace({ index: Math.max(0, index - 1), at: index === 0 ? "start" : "end" });
      },
      onBlockShortcut: (type, rest) => {
        if (block.type !== "paragraph") return false;
        const converted = type === "todo-done"
          ? makeBlock("todo", rest, { checked: true })
          : makeBlock(type, rest);
        blocks[index] = { ...converted, id: block.id };
        if (type === "divider") {
          blocks.splice(index + 1, 0, makeBlock("paragraph", ""));
          replace({ index: index + 1, at: "start" });
        } else if (type === "bullet" || type === "numbered") {
          replace({ index, item: 0, at: "start" });
        } else if (type === "code") {
          replace({ index, at: 4 });
        } else {
          replace({ index, at: "start" });
        }
        return true;
      },
    };
  }

  function renderSingleBlock({
    block, index, container, blocks, onChange, onMoveBlock, onInsertBlock, onDeleteBlock,
    structural, replace,
  }) {
    const el = document.createElement("div");
    el.className = `notion-block notion-block-${block.type}`;
    el.dataset.blockId = block.id;
    el.dataset.blockType = block.type;

    const gutter = document.createElement("div");
    gutter.className = "notion-block-gutter";
    gutter.contentEditable = "false";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "notion-block-btn notion-block-add";
    addBtn.textContent = "+";
    addBtn.title = "Add block below";
    addBtn.setAttribute("aria-label", "Add block below");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (structural) {
        blocks.splice(index + 1, 0, makeBlock("paragraph", ""));
        replace({ index: index + 1, at: "start" });
        return;
      }
      slashMenu.open({
        targetEl: addBtn,
        onSelect: (item) => {
          if (item.type === "page") {
            if (services.createSubpage) services.createSubpage(context.documentState?.currentDoc);
            return;
          }
          onInsertBlock(index + 1, item.template || "");
        },
      });
    });

    const dragHandle = document.createElement("span");
    dragHandle.className = "notion-block-btn notion-block-drag";
    dragHandle.textContent = "⠿";
    dragHandle.title = "Drag to reorder";
    dragHandle.setAttribute("draggable", "true");
    dragHandle.setAttribute("aria-label", "Drag to reorder");
    dragHandle.addEventListener("dragstart", (e) => {
      dragBlockIndex = index;
      el.classList.add("is-dragging");
      try {
        e.dataTransfer.setData("text/plain", String(index));
        e.dataTransfer.effectAllowed = "move";
      } catch {}
    });
    dragHandle.addEventListener("dragend", () => {
      el.classList.remove("is-dragging");
      dragBlockIndex = null;
      container.querySelectorAll(".drop-above, .drop-below").forEach((node) => {
        node.classList.remove("drop-above", "drop-below");
      });
    });

    gutter.append(addBtn, dragHandle);
    el.append(gutter);

    el.addEventListener("dragover", (e) => {
      if (dragBlockIndex == null || dragBlockIndex === index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = el.getBoundingClientRect();
      const above = e.clientY - rect.top < rect.height / 2;
      el.classList.toggle("drop-above", above);
      el.classList.toggle("drop-below", !above);
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-above", "drop-below");
    });
    el.addEventListener("drop", (e) => {
      if (dragBlockIndex == null || dragBlockIndex === index) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const above = e.clientY - rect.top < rect.height / 2;
      const targetIdx = above ? index : index + 1;
      const fromIdx = dragBlockIndex;
      el.classList.remove("drop-above", "drop-below");
      dragBlockIndex = null;
      onMoveBlock(fromIdx, targetIdx > fromIdx ? targetIdx - 1 : targetIdx);
    });

    const content = document.createElement("div");
    content.className = "notion-block-content";
    const keyboard = textBlockKeyboard({ block, index, blocks, structural, replace });

    if (block.type === "todo") {
      const label = document.createElement("div");
      label.className = "notion-todo-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "notion-todo-checkbox";
      checkbox.checked = Boolean(block.checked);
      checkbox.setAttribute("aria-label", "Done");
      checkbox.addEventListener("change", () => {
        const nextChecked = checkbox.checked;
        const newRaw = block.raw.replace(/\[[ xX]\]/, nextChecked ? "[x]" : "[ ]");
        block.checked = nextChecked;
        block.raw = newRaw;
        textSpan.classList.toggle("is-done", nextChecked);
        onChange(index, newRaw, { rerender: !structural });
      });

      const textSpan = document.createElement("span");
      textSpan.className = `notion-todo-text${block.checked ? " is-done" : ""}`;
      textSpan.append(renderMarkdown(block.text || ""));

      attachInlineEditor(textSpan, {
        getValue: () => block.text || "",
        commit: (newText) => {
          const value = structural ? newText : newText.trim();
          const newRaw = `- ${block.checked ? "[x]" : "[ ]"} ${value}`;
          block.text = value;
          block.raw = newRaw;
          onChange(index, newRaw, { rerender: !structural });
        },
        restore: () => textSpan.replaceChildren(renderMarkdown(block.text || "")),
        multiline: false,
        singleLine: true,
        placeholder: "To-do",
        ...keyboard,
        onSlash: (session) => {
          if (session) return;
          slashMenu.open({
            targetEl: textSpan,
            onSelect: (item) => {
              block.raw = item.template;
              onChange(index, item.template, { focusBlockIndex: index });
            },
          });
        },
      });

      label.append(checkbox, textSpan);
      content.append(label);
    } else if (block.type === "callout") {
      const callout = document.createElement("div");
      const calloutKind = (block.raw.match(CALLOUT_RE)?.[1] || "NOTE").toUpperCase();
      callout.className = `notion-callout notion-callout-${calloutKind.toLowerCase()}`;
      const icon = document.createElement("span");
      icon.className = "notion-callout-icon";
      icon.contentEditable = "false";
      icon.textContent = calloutKind === "IMPORTANT" ? "⭐" :
        calloutKind === "TIP" ? "💡" :
        calloutKind === "WARNING" ? "⚠️" :
        calloutKind === "CAUTION" ? "🚨" : "💡";
      const body = document.createElement("div");
      body.className = "notion-callout-body";
      let cleanText = blockText(block);
      body.append(renderMarkdown(cleanText));

      attachInlineEditor(body, {
        getValue: () => cleanText,
        commit: (newText) => {
          const trimmed = structural ? newText : newText.trim();
          const newRaw = blockRaw("callout", trimmed, { calloutKind });
          cleanText = trimmed;
          block.raw = newRaw;
          onChange(index, newRaw, { rerender: !structural });
        },
        restore: () => body.replaceChildren(renderMarkdown(cleanText)),
        multiline: true,
        placeholder: "Callout",
        ...keyboard,
      });

      callout.append(icon, body);
      content.append(callout);
    } else if (block.type === "divider") {
      const hr = document.createElement("hr");
      hr.className = "notion-divider";
      content.append(hr);
    } else if (block.type === "image" && services.renderImageBlock) {
      content.append(services.renderImageBlock(block));
    } else if (block.type === "embed") {
      const embed = toVideoEmbed(block.raw.trim());
      const wrap = document.createElement("div");
      wrap.className = "block-video-embed";
      const iframe = document.createElement("iframe");
      iframe.src = embed?.src || "about:blank";
      iframe.allow = "fullscreen; autoplay; encrypted-media";
      iframe.allowFullscreen = true;
      iframe.loading = "lazy";
      iframe.title = block.raw.trim();
      wrap.append(iframe);
      content.append(wrap);
    } else if (block.type === "bullet" || block.type === "numbered") {
      content.append(renderNotionListBlock({
        block, blockIndex: index, onChange, onDeleteBlock, onInsertBlock, structural, blocks, replace,
      }));
    } else {
      // Paragraph, heading, quote, code.
      const inner = document.createElement("div");
      inner.className = `notion-text-content ${block.type}`;
      const isHeading = /^h[1-6]$/.test(block.type);
      const level = block.level || (isHeading ? Number(block.type.slice(1)) : 0);
      if (isHeading) {
        inner.setAttribute("role", "heading");
        inner.setAttribute("aria-level", String(level));
      }
      inner.append(renderMarkdown(block.raw));
      const isQuote = block.type === "quote";
      const textOnly = structural && (isHeading || isQuote || block.type === "paragraph");

      attachInlineEditor(inner, {
        getValue: () => (textOnly ? blockText(block) : isHeading ? block.raw.replace(/^#{1,6}\s+/, "") : block.raw),
        commit: (newText) => {
          const newRaw = isHeading
            ? `${"#".repeat(level)} ${newText}`
            : textOnly && isQuote ? blockRaw("quote", newText) : newText;
          block.raw = newRaw;
          onChange(index, newRaw, { rerender: !structural });
        },
        restore: () => inner.replaceChildren(renderMarkdown(block.raw)),
        multiline: !isHeading,
        singleLine: isHeading,
        placeholder: isHeading ? `Heading ${level}` : structural ? "Type '/' for commands" : "Start writing…",
        placeholderOnFocus: !isHeading,
        ...(textOnly ? keyboard : {}),
        onSlash: (session) => {
          if (session) return;
          slashMenu.open({
            targetEl: inner,
            onSelect: (item) => {
              block.raw = item.template;
              onChange(index, item.template, { focusBlockIndex: index });
            },
          });
        },
        ...(structural ? {} : {
          onDeleteBlock: () => onDeleteBlock(index),
          onEnterNewBlock: () => onInsertBlock(index + 1, ""),
        }),
      });

      content.append(inner);
    }

    el.append(content);
    return el;
  }

  return {
    renderBlocksContainer,
    parseMarkdownBlocks,
    serializeBlocksToMarkdown,
    slashMenu,
  };
}
