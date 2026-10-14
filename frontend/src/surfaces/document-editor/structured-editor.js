import { setStepAttrs } from "./procedure-model.js";

export function createStructuredEditor(context, services) {
  const { documentState } = context;
  const { commitProcedure } = services;
  const STEP_ACTIONS = [
    "navigate", "click", "type", "upload", "download", "copy",
    "paste", "submit", "verify", "wait", "other",
  ];

  function attachInlineEditor(
    el,
    {
      getValue,
      commit,
      restore,
      multiline = true,
      singleLine = false,
      autoSize = true,
      commitOnEnter = false,
      autoFocus = false,
      editorClass,
      hintClass,
      hintText,
      showHint = true,
      onSlash,
      onDeleteBlock,
      onEnterNewBlock,
      onIndent,
      onOutdent,
      placeholder = "",
      selectionRange = null,
    },
  ) {
    el.tabIndex = 0;
    el.title = "Click to edit";
    el.classList.add("inline-editable");
    el.addEventListener("click", (event) => {
      if (event.target.closest("a, button, img, .inline-editor, .notion-block-gutter")) return;
      if (el.classList.contains("editing")) return;
      event.preventDefault();
      enter();
    });
    el.addEventListener("keydown", (event) => {
      if (event.target !== el) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        enter();
      }
    });

    if (autoFocus) {
      setTimeout(() => {
        if (el.isConnected && !el.classList.contains("editing")) {
          enter();
        }
      }, 0);
    }

    function enter() {
      el.classList.add("editing");
      const original = getValue();
      const originalHeight = Math.ceil(el.getBoundingClientRect().height);
      const editor = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) editor.type = "text";
      editor.className = `inline-editor ${editorClass || ""}`.trim();
      editor.value = original;
      editor.placeholder = placeholder;
      editor.style.width = "100%";
      editor.style.boxSizing = "border-box";
      if (multiline) {
        editor.rows = Math.max(2, (editor.value.match(/\n/g) || []).length + 1);
        if (autoSize) {
          editor.style.minHeight = `${Math.max(originalHeight, 44)}px`;
          editor.style.overflow = "hidden";
        }
      }

      const hint = document.createElement("div");
      hint.className = `inline-edit-hint ${hintClass || ""}`.trim();
      hint.textContent = showHint
        ? hintText ||
          (commitOnEnter
            ? "Enter to save · Esc to cancel"
            : multiline
              ? "Cmd/Ctrl+Enter to save · Esc to cancel"
              : "Enter to save · Esc to cancel")
        : "";

      if (showHint) el.replaceChildren(editor, hint);
      else el.replaceChildren(editor);
      if (autoSize) {
        resizeInlineEditor(editor);
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(() => resizeInlineEditor(editor));
        }
      }
      editor.focus();
      if (selectionRange) {
        editor.setSelectionRange(selectionRange.start, selectionRange.end);
      } else if (multiline) {
        editor.setSelectionRange(editor.value.length, editor.value.length);
      } else {
        editor.select();
      }

      let done = false;
      const doCommit = () => {
        if (done) return;
        done = true;
        const newValue = singleLine
          ? editor.value.replace(/\s*\n+\s*/g, " ")
          : editor.value;
        el.classList.remove("editing");
        if (newValue !== original) commit(newValue);
        restore();
      };
      const doCancel = () => {
        if (done) return;
        done = true;
        el.classList.remove("editing");
        restore();
      };

      editor.addEventListener("blur", doCommit);
      if (autoSize) {
        editor.addEventListener("input", () => resizeInlineEditor(editor));
      }
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          doCancel();
        } else if (event.key === "/" && (editor.value === "" || editor.selectionStart === 0)) {
          if (onSlash) {
            event.preventDefault();
            onSlash();
          }
        } else if (event.key === "Backspace" && editor.value === "") {
          if (onDeleteBlock) {
            event.preventDefault();
            done = true;
            el.classList.remove("editing");
            restore();
            onDeleteBlock();
          }
        } else if (event.key === "Tab") {
          if (event.shiftKey) {
            if (onOutdent) {
              event.preventDefault();
              const selection = { start: editor.selectionStart, end: editor.selectionEnd };
              doCommit();
              onOutdent(selection);
            }
          } else {
            if (onIndent) {
              event.preventDefault();
              const selection = { start: editor.selectionStart, end: editor.selectionEnd };
              doCommit();
              onIndent(selection);
            }
          }
        } else if (event.key === "Enter") {
          if (commitOnEnter && !event.shiftKey) {
            event.preventDefault();
            doCommit();
            if (onEnterNewBlock) onEnterNewBlock();
            return;
          }
          if (multiline && !(event.metaKey || event.ctrlKey)) {
            if (event.shiftKey && onEnterNewBlock) {
              event.preventDefault();
              doCommit();
              onEnterNewBlock();
            }
            return;
          }
          event.preventDefault();
          doCommit();
          if (onEnterNewBlock) onEnterNewBlock();
        }
      });
    }
  }

  function resizeInlineEditor(editor) {
    if (!editor) return;
    editor.style.height = "auto";
    const nextHeight = Math.max(44, editor.scrollHeight || 0);
    editor.style.height = `${nextHeight}px`;
  }

  function toggleStepAttrEditor(blockEl, step, model) {
    const existing = blockEl.querySelector(".block-step-attr-editor");
    if (existing) {
      existing.remove();
      return;
    }

    const editor = document.createElement("form");
    editor.className = "block-step-attr-editor";

    const attrs = step.attrs || {};
    const allowedSystems =
      (documentState.currentParsed &&
        documentState.currentParsed.frontmatter &&
        documentState.currentParsed.frontmatter.systems) ||
      [];

    // action
    const actionRow = makeAttrRow("Action");
    const actionSel = document.createElement("select");
    actionSel.innerHTML =
      `<option value="">(none)</option>` +
      STEP_ACTIONS.map(
        (a) =>
          `<option value="${a}"${a === attrs.action ? " selected" : ""}>${a}</option>`,
      ).join("");
    actionRow.append(actionSel);
    editor.append(actionRow);

    // tool
    const toolRow = makeAttrRow("Tool");
    const toolInput = document.createElement("input");
    toolInput.type = "text";
    toolInput.value = attrs.tool || "";
    toolInput.placeholder = "Free text, e.g. ‘drag-and-drop’";
    toolRow.append(toolInput);
    editor.append(toolRow);

    // systems (multi-select)
    const sysRow = makeAttrRow("Systems");
    const sysWrap = document.createElement("div");
    sysWrap.className = "block-step-attr-systems";
    const selected = new Set(Array.isArray(attrs.systems) ? attrs.systems : []);
    if (allowedSystems.length === 0) {
      const note = document.createElement("span");
      note.className = "block-step-attr-note";
      note.textContent = "Add systems to the doc frontmatter to enable.";
      sysWrap.append(note);
    } else {
      for (const sys of allowedSystems) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "block-step-attr-chip";
        btn.textContent = sys;
        btn.dataset.system = sys;
        btn.classList.toggle("is-selected", selected.has(sys));
        btn.addEventListener("click", () => {
          if (selected.has(sys)) selected.delete(sys);
          else selected.add(sys);
          btn.classList.toggle("is-selected", selected.has(sys));
        });
        sysWrap.append(btn);
      }
    }
    sysRow.append(sysWrap);
    editor.append(sysRow);

    // actions
    const actionsRow = document.createElement("div");
    actionsRow.className = "block-step-attr-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => editor.remove());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "Apply";
    actionsRow.append(cancel, save);
    editor.append(actionsRow);

    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const newAttrs = {};
      const actionVal = actionSel.value.trim();
      if (actionVal) newAttrs.action = actionVal;
      const toolVal = toolInput.value.trim();
      if (toolVal) newAttrs.tool = toolVal;
      const sysList = Array.from(selected);
      if (sysList.length) newAttrs.systems = sysList;
      setStepAttrs(step, newAttrs);
      editor.remove();
      commitProcedure(model);
    });

    blockEl.querySelector(".block-step-body").after(editor);
  }

  function makeAttrRow(label) {
    const row = document.createElement("label");
    row.className = "block-step-attr-row";
    const span = document.createElement("span");
    span.className = "block-step-attr-label";
    span.textContent = label;
    row.append(span);
    return row;
  }


  return { attachInlineEditor, makeAttrRow, toggleStepAttrEditor };
}
