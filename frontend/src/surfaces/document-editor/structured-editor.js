export function createStructuredEditor(context, services, editorState) {
  const {
    documentState, editor, renderedView, setStatus, showUndoToast,
  } = context;
  const {
    addScreenshot, applyProcedureRewrite, renderStepBlock, renumberProcedure,
    storeDraft, updateSaveState,
  } = services;
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
      autoSize = false,
      commitOnEnter = false,
      editorClass,
      hintClass,
      hintText,
      showHint = true,
    },
  ) {
    el.tabIndex = 0;
    el.title = "Click to edit";
    el.classList.add("inline-editable");
    el.addEventListener("click", (event) => {
      if (event.target.closest("a, button, img, .inline-editor")) return;
      if (el.classList.contains("editing")) return;
      enter();
    });
    el.addEventListener("keydown", (event) => {
      if (event.target !== el) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        enter();
      }
    });

    function enter() {
      el.classList.add("editing");
      const original = getValue();
      const originalHeight = Math.ceil(el.getBoundingClientRect().height);
      const editor = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) editor.type = "text";
      editor.className = `inline-editor ${editorClass || ""}`.trim();
      editor.value = original;
      if (multiline) {
        editor.rows = Math.max(2, (editor.value.match(/\n/g) || []).length + 1);
      }
      if (autoSize) {
        editor.style.minHeight = `${originalHeight}px`;
        editor.style.overflow = "hidden";
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
      if (autoSize) resizeInlineEditor(editor);
      editor.focus();
      if (multiline) {
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
        } else if (event.key === "Enter") {
          if (commitOnEnter && !event.shiftKey) {
            event.preventDefault();
            doCommit();
            return;
          }
          if (multiline && !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          doCommit();
        }
      });
    }
  }

  function resizeInlineEditor(editor) {
    editor.style.height = "auto";
    editor.style.height = `${editor.scrollHeight}px`;
  }

  function applyStepBodyEdit(step, newBody) {
    step.body_md = newBody;
    const updated = patchStepBodyInMarkdown(
      editor.value,
      step.id,
      newBody,
      step.rendered_number ?? step.id,
    );
    if (updated == null) {
      setStatus(
        `Could not locate step ${step.id} in raw markdown; edit not saved.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function patchStepBodyInMarkdown(markdown, stepId, newBodyMd, renderedNum) {
    const re = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(re);
    if (!match) return null;
    const openMarker = match[1];
    const inner = match[2];
    const closeMarker = match[3];

    // Split inner into "body lines" (before any screenshot block) and the
    // remaining screenshot/extra content. The screenshot block opens with a
    // `<!-- sop-screenshot-start -->` marker, indented or not.
    const screenshotIdx = inner.search(/^\s*<!--\s*sop-screenshot-start\s*-->/m);
    let tail = "";
    if (screenshotIdx !== -1) {
      tail = "\n" + inner.slice(screenshotIdx);
    }

    const formattedBody = formatStepBody(newBodyMd, renderedNum);
    const replaced = openMarker + formattedBody + tail + closeMarker;
    return markdown.replace(re, () => replaced);
  }

  function formatStepBody(bodyMd, renderedNum) {
    const lines = bodyMd.split("\n");
    if (lines.length === 0) return `${renderedNum}.  `;
    const first = lines[0];
    const rest = lines.slice(1);
    const out = [`${renderedNum}.  ${first}`];
    for (const line of rest) {
      if (!line.trim()) {
        out.push("");
        continue;
      }
      // Continuation lines need 4-space indent so GitHub keeps them inside the
      // numbered-list item.
      out.push(`    ${line}`);
    }
    return out.join("\n");
  }

  function onStepDragStart(event, step, blockEl, procedure) {
    editorState.dragStep = { step, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    // Required for Firefox.
    try {
      event.dataTransfer.setData("text/plain", String(step.id));
    } catch {}
  }

  function onStepDragEnd() {
    if (editorState.dragStep && editorState.dragStep.blockEl)
      editorState.dragStep.blockEl.classList.remove("is-dragging");
    editorState.dragStep = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onStepDragOver(event, _step, blockEl, procedure) {
    // Detect a file drag from the OS.
    if (
      event.dataTransfer &&
      (event.dataTransfer.types || []).includes("Files")
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      blockEl.classList.add("drop-file");
      return;
    }
    if (!editorState.dragStep || editorState.dragStep.procedure !== procedure) return;
    if (editorState.dragStep.blockEl === blockEl) return;
    // Reject mixing flat and grouped (spec disallows mixed procedures).
    const src = containerOfStep(procedure, editorState.dragStep.step);
    const tgt = containerOfBlock(blockEl);
    if (!src || !tgt) return;
    if ((src === "flat") !== (tgt === "flat")) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onStepDragLeave(event, blockEl) {
    // Only remove the indicator if we've left the block entirely.
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below", "drop-file");
    }
  }

  function onStepDrop(event, target, blockEl, procedure) {
    // File drop from OS?
    blockEl.classList.remove("drop-file");
    if (
      event.dataTransfer &&
      event.dataTransfer.files &&
      event.dataTransfer.files.length
    ) {
      event.preventDefault();
      for (const file of event.dataTransfer.files) {
        if (!file.type.startsWith("image/")) continue;
        addScreenshot(target, procedure, file);
        break; // upload one at a time for now
      }
      return;
    }
    if (!editorState.dragStep || editorState.dragStep.procedure !== procedure) return;
    event.preventDefault();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = editorState.dragStep.step;
    editorState.dragStep = null;
    if (dragged === target) return;

    const srcContainer = containerOfStep(procedure, dragged);
    const tgtContainer = containerOfStep(procedure, target);
    if (!srcContainer || !tgtContainer) return;
    if ((srcContainer === "flat") !== (tgtContainer === "flat")) return;

    const srcList = stepListOf(procedure, srcContainer);
    const tgtList = stepListOf(procedure, tgtContainer);
    const fromIdx = srcList.indexOf(dragged);
    if (fromIdx === -1) return;
    srcList.splice(fromIdx, 1);
    // Index in target list may have shifted if same list and the source came
    // before the target. After splice it is fine because target is still in
    // the tgtList (different list, or same list with target index updated).
    let toIdx = tgtList.indexOf(target);
    if (toIdx === -1) {
      // target was the dragged step itself (shouldn't happen but be safe)
      toIdx = tgtList.length;
    } else if (!above) {
      toIdx += 1;
    }
    tgtList.splice(toIdx, 0, dragged);

    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function onGroupDragStart(event, group, blockEl, procedure) {
    editorState.dragGroup = { group, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "group");
    } catch {}
    event.stopPropagation();
  }

  function onGroupDragEnd() {
    if (editorState.dragGroup && editorState.dragGroup.blockEl)
      editorState.dragGroup.blockEl.classList.remove("is-dragging");
    editorState.dragGroup = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onGroupDragOver(event, _group, blockEl, procedure) {
    if (!editorState.dragGroup || editorState.dragGroup.procedure !== procedure) return;
    if (editorState.dragGroup.blockEl === blockEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.stopPropagation();
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onGroupDragLeave(event, blockEl) {
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onGroupDrop(event, target, blockEl, procedure) {
    if (!editorState.dragGroup || editorState.dragGroup.procedure !== procedure) return;
    event.preventDefault();
    event.stopPropagation();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = editorState.dragGroup.group;
    editorState.dragGroup = null;
    if (dragged === target) return;

    const list = procedure.groups || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);

    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function onProseDragStart(event, prose, blockEl, procedure) {
    editorState.dragProse = { prose, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "prose");
    } catch {}
  }

  function onProseDragEnd() {
    if (editorState.dragProse && editorState.dragProse.blockEl)
      editorState.dragProse.blockEl.classList.remove("is-dragging");
    editorState.dragProse = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onProseDragOver(event, _prose, blockEl, procedure) {
    if (!editorState.dragProse || editorState.dragProse.procedure !== procedure) return;
    if (editorState.dragProse.blockEl === blockEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onProseDragLeave(event, blockEl) {
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onProseDrop(event, target, blockEl, procedure) {
    if (!editorState.dragProse || editorState.dragProse.procedure !== procedure) return;
    event.preventDefault();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = editorState.dragProse.prose;
    editorState.dragProse = null;
    if (dragged === target) return;

    const list = procedure.prose || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);

    applyProcedureRewrite(procedure, null);
  }

  function containerOfStep(procedure, step) {
    for (const g of procedure.groups || []) {
      if ((g.steps || []).includes(step)) return g;
    }
    if ((procedure.flat_steps || []).includes(step)) return "flat";
    return null;
  }

  function containerOfBlock(blockEl) {
    // A step block inside .block-group belongs to that group; otherwise flat.
    const groupEl = blockEl.closest(".block-group");
    if (groupEl) {
      // Locate the matching parsed group by title (titles are stable within a doc).
      const title = groupEl.querySelector("h3")?.textContent || "";
      if (
        documentState.currentParsed &&
        documentState.currentParsed.sections &&
        documentState.currentParsed.sections.procedure
      ) {
        const proc = documentState.currentParsed.sections.procedure;
        for (const g of proc.groups || []) {
          if ((g.title || "") === title) return g;
        }
      }
      return null;
    }
    return "flat";
  }

  function stepListOf(procedure, container) {
    if (container === "flat")
      return (procedure.flat_steps = procedure.flat_steps || []);
    if (container && typeof container === "object")
      return (container.steps = container.steps || []);
    return [];
  }

  function addStep(procedure, group) {
    const nextId = nextStepId(procedure);
    const newStep = {
      id: nextId,
      rendered_number: nextId,
      attrs: {},
      body_md: "Describe this step.",
      screenshots: [],
    };
    if (group) {
      group.steps = group.steps || [];
      group.steps.push(newStep);
    } else {
      procedure.flat_steps = procedure.flat_steps || [];
      procedure.flat_steps.push(newStep);
    }
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, newStep.id);
  }

  function deleteStep(procedure, step) {
    const num = step.rendered_number ?? step.id;
    const snapshot = snapshotProcedure(procedure);
    for (const g of procedure.groups || []) {
      g.steps = (g.steps || []).filter((s) => s !== step);
    }
    procedure.flat_steps = (procedure.flat_steps || []).filter((s) => s !== step);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
    showUndoToast(`Step ${num} deleted.`, () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function addGroup(procedure) {
    const nextId = nextStepId(procedure);
    const newGroup = {
      title: "New group",
      steps: [
        {
          id: nextId,
          rendered_number: nextId,
          attrs: {},
          body_md: "Describe this step.",
          screenshots: [],
        },
      ],
    };
    procedure.groups = procedure.groups || [];
    procedure.groups.push(newGroup);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, newGroup.steps[0].id);
  }

  function deleteGroup(procedure, group) {
    const count = (group.steps || []).length;
    const title = group.title || "(untitled)";
    const snapshot = snapshotProcedure(procedure);
    procedure.groups = (procedure.groups || []).filter((g) => g !== group);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
    showUndoToast(
      count
        ? `Group "${title}" (${count} step${count === 1 ? "" : "s"}) deleted.`
        : `Group "${title}" deleted.`,
      () => restoreProcedure(procedure, snapshot),
    );
  }

  function addProse(procedure) {
    const newProse = {
      after_step_id: null,
      body_md: "New free-form text. Click to edit.",
    };
    procedure.prose = procedure.prose || [];
    procedure.prose.push(newProse);
    applyProcedureRewrite(procedure, null);
    // Open the newly-added prose for editing.
    const blocks = renderedView.querySelectorAll(
      ".block-prose .block-prose-body",
    );
    const last = blocks[blocks.length - 1];
    if (last) {
      last.scrollIntoView({ behavior: "smooth", block: "center" });
      last.click();
    }
  }

  function deleteProse(procedure, prose) {
    const snapshot = snapshotProcedure(procedure);
    procedure.prose = (procedure.prose || []).filter((p) => p !== prose);
    applyProcedureRewrite(procedure, null);
    showUndoToast("Free-form block deleted.", () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function toggleStepAttrEditor(blockEl, step, procedure) {
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
      step.attrs = newAttrs;
      editor.remove();
      applyProcedureRewrite(procedure, null);
    });

    blockEl.querySelector(".block-step-header").after(editor);
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

  function snapshotProcedure(procedure) {
    return JSON.parse(
      JSON.stringify({
        groups: procedure.groups || [],
        flat_steps: procedure.flat_steps || [],
        prose: procedure.prose || [],
        todos: procedure.todos || [],
      }),
    );
  }

  function restoreProcedure(procedure, snapshot) {
    procedure.groups = snapshot.groups;
    procedure.flat_steps = snapshot.flat_steps;
    procedure.prose = snapshot.prose;
    procedure.todos = snapshot.todos;
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function nextStepId(procedure) {
    let max = 0;
    for (const g of procedure.groups || []) {
      for (const s of g.steps || []) max = Math.max(max, s.id);
    }
    for (const s of procedure.flat_steps || []) max = Math.max(max, s.id);
    return max + 1;
  }


  return {
    addGroup, addProse, addStep, applyStepBodyEdit, attachInlineEditor,
    deleteGroup, deleteProse, deleteStep, formatStepBody, makeAttrRow, nextStepId,
    onGroupDragEnd, onGroupDragLeave, onGroupDragOver, onGroupDragStart,
    onGroupDrop, onProseDragEnd, onProseDragLeave, onProseDragOver,
    onProseDragStart, onProseDrop, onStepDragEnd, onStepDragLeave,
    onStepDragOver, onStepDragStart, onStepDrop, restoreProcedure,
    snapshotProcedure, toggleStepAttrEditor,
  };
}
