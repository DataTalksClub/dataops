// The block list's document model: markdown in, blocks out, and the edits
// the keyboard makes to them. Pure functions; block-editor.js renders them.

import { toVideoEmbed } from "./embeds.js";

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
export const blockId = () => `blk-${++blockCounter}-${Math.random().toString(36).slice(2, 7)}`;

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

export const CALLOUT_RE = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

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

export const TEXT_TYPES = new Set(["paragraph", "h1", "h2", "h3", "todo", "quote", "callout"]);

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
