import { createSlashMenu } from "./slash-menu.js";

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
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: "code",
        raw: buf.join("\n"),
      });
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
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: isCallout ? "callout" : "quote",
        raw: buf.join("\n"),
      });
      continue;
    }

    // Heading:
    const hMatch = startLine.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: `h${level}`,
        raw: startLine,
        text: hMatch[2],
      });
      i++;
      continue;
    }

    // Divider:
    if (/^(?:---|\*\*\*|___)\s*$/.test(startLine)) {
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: "divider",
        raw: "---",
      });
      i++;
      continue;
    }

    // To-do item:
    const todoMatch = startLine.match(/^(\s*[-*]\s+)\[([ xX])\]\s*(.*)$/);
    if (todoMatch) {
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
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
      while (i < lines.length && lines[i].trim() && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: "bullet",
        raw: buf.join("\n"),
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(startLine)) {
      const buf = [startLine];
      i++;
      while (i < lines.length && lines[i].trim() && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({
        id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
        type: "numbered",
        raw: buf.join("\n"),
      });
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
    blocks.push({
      id: `blk-${blocks.length}-${Math.random().toString(36).slice(2, 7)}`,
      type: "paragraph",
      raw: buf.join("\n"),
    });
  }

  return blocks;
}

export function serializeBlocksToMarkdown(blocks) {
  return blocks
    .map((b) => b.raw || "")
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

export function createBlockEditor(context, services) {
  const { renderMarkdown, attachInlineEditor } = services;
  const slashMenu = createSlashMenu();
  let dragBlockIndex = null;

  function renderBlocksContainer({
    blocks,
    onChange,
    onMoveBlock,
    onInsertBlock,
    onDeleteBlock,
  }) {
    const container = document.createElement("div");
    container.className = "notion-blocks-container";

    blocks.forEach((block, idx) => {
      const blockEl = renderSingleBlock({
        block,
        index: idx,
        total: blocks.length,
        container,
        blocks,
        onChange,
        onMoveBlock,
        onInsertBlock,
        onDeleteBlock,
      });
      container.append(blockEl);
    });

    // An empty block at the end that allows quick creation on click or slash
    const addRow = document.createElement("div");
    addRow.className = "notion-add-block-row";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "notion-add-row-btn";
    addBtn.textContent = "+ Click or type '/' to add a block…";
    addBtn.addEventListener("click", () => {
      slashMenu.open({
        targetEl: addBtn,
        onSelect: (item) => {
          onInsertBlock(blocks.length, item.template || "New text block");
        },
      });
    });
    addRow.append(addBtn);
    container.append(addRow);

    return container;
  }

  function renderSingleBlock({
    block,
    index,
    total,
    container,
    blocks,
    onChange,
    onMoveBlock,
    onInsertBlock,
    onDeleteBlock,
  }) {
    const el = document.createElement("div");
    el.className = `notion-block notion-block-${block.type}`;
    el.dataset.blockId = block.id;
    el.dataset.blockType = block.type;
    el.tabIndex = 0;

    // Notion-style gutter with + button and drag handle
    const gutter = document.createElement("div");
    gutter.className = "notion-block-gutter";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "notion-block-btn notion-block-add";
    addBtn.textContent = "+";
    addBtn.title = "Add block below (or type '/')";
    addBtn.setAttribute("aria-label", "Add block below");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      slashMenu.open({
        targetEl: addBtn,
        onSelect: (item) => {
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

    // Drag-over targets on the block element
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
      if (!el.contains(e.relatedTarget)) {
        el.classList.remove("drop-above", "drop-below");
      }
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

    // Content container
    const content = document.createElement("div");
    content.className = "notion-block-content";

    if (block.type === "todo") {
      const label = document.createElement("label");
      label.className = "notion-todo-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "notion-todo-checkbox";
      checkbox.checked = Boolean(block.checked);
      checkbox.addEventListener("change", () => {
        const nextChecked = checkbox.checked;
        const mark = nextChecked ? "[x]" : "[ ]";
        const newRaw = block.raw.replace(/\[[ xX]\]/, mark);
        block.checked = nextChecked;
        block.raw = newRaw;
        onChange(index, newRaw);
      });

      const textSpan = document.createElement("span");
      textSpan.className = `notion-todo-text${block.checked ? " is-done" : ""}`;
      textSpan.append(renderMarkdown(block.text || ""));

      attachInlineEditor(textSpan, {
        getValue: () => block.text || "",
        commit: (newText) => {
          const mark = block.checked ? "[x]" : "[ ]";
          const newRaw = `- ${mark} ${newText.trim()}`;
          block.text = newText.trim();
          block.raw = newRaw;
          onChange(index, newRaw);
        },
        restore: () => {
          textSpan.replaceChildren(renderMarkdown(block.text || ""));
        },
        multiline: false,
        onSlash: () => {
          slashMenu.open({
            targetEl: textSpan,
            onSelect: (item) => {
              block.raw = item.template;
              onChange(index, item.template);
            },
          });
        },
      });

      label.append(checkbox, textSpan);
      content.append(label);
    } else if (block.type === "callout") {
      const callout = document.createElement("div");
      const matchKind = block.raw.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
      const calloutKind = matchKind ? matchKind[1].toUpperCase() : "NOTE";
      callout.className = `notion-callout notion-callout-${calloutKind.toLowerCase()}`;
      const icon = document.createElement("span");
      icon.className = "notion-callout-icon";
      icon.textContent = calloutKind === "IMPORTANT" ? "⭐" :
                         calloutKind === "TIP" ? "💡" :
                         calloutKind === "WARNING" ? "⚠️" :
                         calloutKind === "CAUTION" ? "🚨" : "💡";
      const body = document.createElement("div");
      body.className = "notion-callout-body";
      let cleanText = block.raw
        .replace(/^>\s?/gm, "")
        .replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i, "")
        .trim();
      body.append(renderMarkdown(cleanText));

      attachInlineEditor(body, {
        getValue: () => cleanText,
        commit: (newText) => {
          const trimmed = newText.trim();
          const newRaw = `> [!${calloutKind}]\n> ${trimmed.replace(/\n/g, "\n> ")}`;
          block.raw = newRaw;
          onChange(index, newRaw);
        },
        restore: () => {
          body.replaceChildren(renderMarkdown(cleanText));
        },
        multiline: true,
      });

      callout.append(icon, body);
      content.append(callout);
    } else if (block.type === "divider") {
      const hr = document.createElement("hr");
      hr.className = "notion-divider";
      content.append(hr);
    } else {
      // General paragraph, heading, list, quote, code
      const inner = document.createElement("div");
      inner.className = `notion-text-content ${block.type}`;
      inner.append(renderMarkdown(block.raw));

      attachInlineEditor(inner, {
        getValue: () => block.raw,
        commit: (newRaw) => {
          block.raw = newRaw;
          onChange(index, newRaw);
        },
        restore: () => {
          inner.replaceChildren(renderMarkdown(block.raw));
        },
        multiline: block.type !== "h1" && block.type !== "h2" && block.type !== "h3",
        singleLine: block.type === "h1" || block.type === "h2" || block.type === "h3",
        onSlash: () => {
          slashMenu.open({
            targetEl: inner,
            onSelect: (item) => {
              block.raw = item.template;
              onChange(index, item.template);
            },
          });
        },
        onDeleteBlock: () => {
          onDeleteBlock(index);
        },
        onEnterNewBlock: () => {
          onInsertBlock(index + 1, "");
        },
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
