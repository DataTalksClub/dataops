import { attachEditable } from "./editable.js";
import { setStepAttrs } from "./procedure-model.js";

export function createStructuredEditor(context, services) {
  const { documentState } = context;
  const { commitProcedure } = services;
  const STEP_ACTIONS = [
    "navigate", "click", "type", "upload", "download", "copy",
    "paste", "submit", "verify", "wait", "other",
  ];

  // Every text block is always editable; see editable.js.
  function attachInlineEditor(el, options) {
    return attachEditable(el, {
      renderAtom: services.renderInlineAtom,
      resolveLink: services.resolveInlineLink,
      onActivity: services.markSaving,
      onFollowLink: followLink,
      ...options,
    });
  }

  function followLink(link) {
    const docPath = link.getAttribute("data-doc-path");
    if (docPath) {
      context.openDocument?.(docPath);
      return;
    }
    const href = link.getAttribute("href");
    if (href && href !== "#") globalThis.open?.(href, "_blank", "noopener");
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
