import { focusEditable, plainTextLength } from "./editable.js";
import {
  blockId,
  blockRaw,
  blockText,
  CALLOUT_RE,
  convertBlock,
  liftListItem,
  makeBlock,
  mergeBlockBackward,
  parseListItems,
  parseMarkdownBlocks,
  serializeBlocksToMarkdown,
  serializeListItems,
  splitBlock,
} from "./block-model.js";
import { toVideoEmbed } from "./embeds.js";
import { pickImageFiles, promptInline } from "./inline-prompt.js";
import { createSlashMenu, DOCUMENT_BLOCKS } from "./slash-menu.js";

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
      // "+" opens the menu by typing the "/" it listens for.
      if (target.slash) editable.ownerDocument.execCommand("insertText", false, "/");
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
            if (session) {
              if (!structural) return;
              slashMenu.open({
                targetEl: session.targetEl,
                anchorRect: session.anchorRect,
                inline: session,
                items: DOCUMENT_BLOCKS,
                onSelect: (choice) => {
                  if (item.text.trim()) {
                    applySlashChoice(choice, blocks, blockIndex, replace, session.anchorRect);
                    return;
                  }
                  const at = liftListItem(blocks, blockIndex, itemIdx, "");
                  applySlashChoice(choice, blocks, at, replace, session.anchorRect);
                },
              });
              return;
            }
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

  /**
   * Apply a "/" choice at block `index`: an empty block turns into the
   * chosen type, a block with text gets the new block below it.
   */
  async function applySlashChoice(item, blocks, index, replace, anchorRect) {
    const current = blocks[index];
    const empty = !blockText(current).trim() && current.type !== "divider";
    const place = (block) => {
      if (empty) {
        blocks[index] = { ...block, id: current.id };
        return index;
      }
      blocks.splice(index + 1, 0, block);
      return index + 1;
    };
    if (item.type === "page") {
      services.createSubpage?.(context.documentState?.currentDoc);
      return;
    }
    if (item.type === "image") {
      const files = await pickImageFiles();
      if (files.length) services.insertImageBlocks?.(files, blocks, index, empty, replace);
      return;
    }
    if (item.type === "embed") {
      const url = await promptInline({
        anchorRect, placeholder: "Paste a Loom, YouTube or Vimeo link", submitLabel: "Embed",
      });
      if (!url || !toVideoEmbed(url)) {
        replace({ index, at: "end" });
        return;
      }
      const at = place({ ...makeBlock("embed", url) });
      blocks.splice(at + 1, 0, makeBlock("paragraph", ""));
      replace({ index: at + 1, at: "start" });
      return;
    }
    if (item.type === "divider") {
      const at = place(makeBlock("divider"));
      blocks.splice(at + 1, 0, makeBlock("paragraph", ""));
      replace({ index: at + 1, at: "start" });
      return;
    }
    const at = place(empty ? convertBlock(current, item.type) : makeBlock(item.type, ""));
    const isList = item.type === "bullet" || item.type === "numbered";
    if (isList) replace({ index: at, item: 0, at: "end" });
    else if (item.type === "code") replace({ index: at, at: 4 });
    else replace({ index: at, at: "end" });
  }

  function openSlash(session, blocks, index, replace) {
    slashMenu.open({
      targetEl: session.targetEl,
      anchorRect: session.anchorRect,
      inline: session,
      items: DOCUMENT_BLOCKS,
      onSelect: (item) => applySlashChoice(item, blocks, index, replace, session.anchorRect),
    });
  }

  function textBlockKeyboard({ block, index, blocks, structural, replace }) {
    if (!structural) return {};
    return {
      onSlash: (session) => {
        if (session) openSlash(session, blocks, index, replace);
      },
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
        replace({ index: index + 1, at: "start", slash: true });
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
        onSlash: structural ? keyboard.onSlash : () => {
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
        onSlash: structural ? (textOnly ? keyboard.onSlash : undefined) : () => {
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
