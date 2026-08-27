import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";

export function createProcedureRenderer(context, services, editorState) {
  const {
    apiUrl, documentState, editor, renderedView, request, showUndoToast,
  } = context;
  const {
    addGroup, addProse, addStep, applyProcedureRewrite,
    applyStepBodyEdit, attachInlineEditor, deleteGroup, deleteProse,
    deleteStep, fileToBase64, onGroupDragEnd, onGroupDragLeave,
    onGroupDragOver, onGroupDragStart, onGroupDrop, onStepDragEnd,
    onStepDragLeave, onStepDragOver, onStepDragStart, onStepDrop,
    patchGroupTitleInMarkdown, pill, renderMarkdown, renderProseBlock,
    renderScreenshot, renumberProcedure, restoreProcedure,
    snapshotProcedure, storeDraft, toggleStepAttrEditor, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);

  function appendProcedureChildren(container, procedure) {
    container.append(renderTodoBlock(procedure));

    const groups = Array.isArray(procedure.groups) ? procedure.groups : [];
    if (groups.length) {
      for (const g of groups) container.append(renderGroupBlock(g, procedure));
    } else {
      const flatSteps = Array.isArray(procedure.flat_steps)
        ? procedure.flat_steps
        : [];
      for (const s of flatSteps) container.append(renderStepBlock(s, procedure));
      container.append(makeAddStepButton(procedure, null));
    }

    const prose = Array.isArray(procedure.prose) ? procedure.prose : [];
    prose.forEach((p, idx) =>
      container.append(renderProseBlock(p, idx, procedure)),
    );
    container.append(makeAddProseButton(procedure));
  }

  function makeAddGroupButton(procedure) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step block-add-group";
    btn.textContent = "+ New group";
    btn.addEventListener("click", () => addGroup(procedure));
    return btn;
  }

  function makeAddProseButton(procedure) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step block-add-prose";
    btn.textContent = "+ New free-form block";
    btn.addEventListener("click", () => addProse(procedure));
    return btn;
  }

  function renderTodoBlock(procedure) {
    const todos = Array.isArray(procedure.todos) ? procedure.todos : [];
    const block = document.createElement("aside");
    block.className = "block-todos";

    const head = document.createElement("header");
    head.className = "block-todos-header";
    const heading = document.createElement("h3");
    heading.textContent = "TODO";
    head.append(heading);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "block-todo-add";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => {
      procedure.todos = procedure.todos || [];
      procedure.todos.push("Describe what's missing.");
      applyProcedureRewrite(procedure, null);
      // Open the inline editor for the new TODO.
      const items = renderedView.querySelectorAll(
        ".block-todos .block-todo-text",
      );
      items[items.length - 1]?.click();
    });
    head.append(addBtn);
    block.append(head);

    if (todos.length === 0) {
      block.classList.add("is-empty");
      const empty = document.createElement("div");
      empty.className = "block-todo-empty";
      empty.textContent = "No TODOs yet.";
      block.append(empty);
      return block;
    }

    const list = document.createElement("ul");
    todos.forEach((t, idx) => {
      const li = document.createElement("li");
      li.className = "block-todo-item";
      const text = document.createElement("span");
      text.className = "block-todo-text";
      text.textContent = t;
      attachInlineEditor(text, {
        getValue: () => procedure.todos[idx] || "",
        commit: (value) => applyTodoEdit(procedure, idx, value),
        restore: () => {
          text.textContent = procedure.todos[idx] || "";
        },
        multiline: false,
      });
      li.append(text);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "block-step-delete";
      del.title = "Delete TODO";
      del.setAttribute("aria-label", "Delete TODO");
      del.textContent = "×";
      del.addEventListener("click", () => deleteTodo(procedure, idx));
      li.append(del);
      list.append(li);
    });
    block.append(list);
    return block;
  }

  function applyTodoEdit(procedure, idx, newValue) {
    procedure.todos = procedure.todos || [];
    procedure.todos[idx] = newValue;
    applyProcedureRewrite(procedure, null);
  }

  function deleteTodo(procedure, idx) {
    const snapshot = snapshotProcedure(procedure);
    procedure.todos = (procedure.todos || []).filter((_, i) => i !== idx);
    applyProcedureRewrite(procedure, null);
    showUndoToast("TODO removed.", () => restoreProcedure(procedure, snapshot));
  }

  function makeProcedureToolbar(procedure) {
    const wrap = document.createElement("div");
    wrap.className = "block-procedure-toolbar";
    return wrap;
  }

  function wrapInGroup(procedure) {
    const steps = procedure.flat_steps || [];
    if (steps.length === 0) return;
    procedure.groups = [{ title: "Steps", steps }];
    procedure.flat_steps = [];
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function flattenSingleGroup(procedure) {
    const groups = procedure.groups || [];
    if (groups.length !== 1) return;
    procedure.flat_steps = groups[0].steps || [];
    procedure.groups = [];
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function makeAddStepButton(procedure, group) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step";
    btn.textContent = "+ New step";
    btn.addEventListener("click", () => addStep(procedure, group));
    return btn;
  }

  function renderGroupBlock(group, procedure) {
    const block = document.createElement("section");
    block.className = "block-group";

    const header = document.createElement("header");
    header.className = "block-group-header";
    const text = document.createElement("div");
    text.className = "block-group-text";
    const title = document.createElement("h3");
    title.textContent = group.title || "";
    attachInlineEditor(title, {
      getValue: () => group.title || "",
      commit: (value) => applyGroupTitleEdit(group, value),
      restore: () => {
        title.textContent = group.title || "";
      },
      multiline: false,
      editorClass: "block-group-title-editor",
    });
    text.append(title);
    header.append(text);
    block.append(header);

    for (const s of group.steps || [])
      block.append(renderStepBlock(s, procedure));
    if (procedure) block.append(makeAddStepButton(procedure, group));
    return block;
  }

  function applyGroupTitleEdit(group, newTitle) {
    const oldTitle = group.title || "";
    if (newTitle === oldTitle) return;
    group.title = newTitle;
    const updated = patchGroupTitleInMarkdown(editor.value, oldTitle, newTitle);
    if (updated == null) {
      showFeedback(`Could not locate group "${oldTitle}"; edit not saved.`, {
        kind: "error",
      });
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function renderStepBlock(step, procedure) {
    const block = document.createElement("article");
    block.className = "block-step";
    block.dataset.stepId = String(step.id);
    if (procedure) {
      block.addEventListener("dragover", (event) =>
        onStepDragOver(event, step, block, procedure),
      );
      block.addEventListener("dragleave", (event) =>
        onStepDragLeave(event, block),
      );
      block.addEventListener("drop", (event) =>
        onStepDrop(event, step, block, procedure),
      );
      block.addEventListener("focusin", () => {
        editorState.lastFocusedStep = step;
        editorState.lastFocusedProcedure = procedure;
      });
      block.addEventListener("click", () => {
        editorState.lastFocusedStep = step;
        editorState.lastFocusedProcedure = procedure;
      });
    }

    const header = document.createElement("header");
    header.className = "block-step-header";

    if (procedure) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag";
      handle.title = "Drag to reorder";
      handle.setAttribute("aria-label", "Drag step to reorder");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onStepDragStart(event, step, block, procedure),
      );
      handle.addEventListener("dragend", onStepDragEnd);
      header.append(handle);
    }

    const numChip = document.createElement("span");
    numChip.className = "block-step-num";
    numChip.textContent = String(step.rendered_number ?? step.id);
    header.append(numChip);

    const label = document.createElement("span");
    label.className = "block-step-label";
    label.textContent = "Step";
    header.append(label);

    const attrs = step.attrs || {};
    if (attrs.action) header.append(pill("action", attrs.action));
    if (attrs.tool) header.append(pill("tool", attrs.tool));
    if (Array.isArray(attrs.systems)) {
      for (const sys of attrs.systems) header.append(pill("system", sys));
    }

    for (const w of documentState.currentWarnings) {
      if (!w.startsWith(`step id=${step.id}:`)) continue;
      const chip = document.createElement("span");
      chip.className = "block-step-warning";
      chip.title = w;
      chip.textContent = "⚠";
      header.append(chip);
    }

    if (procedure) {
      const spacer = document.createElement("span");
      spacer.className = "block-step-spacer";
      header.append(spacer);

      const attrBtn = document.createElement("button");
      attrBtn.type = "button";
      attrBtn.className = "block-step-attr";
      attrBtn.title = "Edit step attributes";
      attrBtn.setAttribute("aria-label", "Edit step attributes");
      attrBtn.textContent = "⚙";
      attrBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleStepAttrEditor(block, step, procedure);
      });
      header.append(attrBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete step";
      delBtn.setAttribute("aria-label", "Delete step");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStep(procedure, step);
      });
      header.append(delBtn);
    }

    block.append(header);

    const body = document.createElement("div");
    body.className = "block-step-body";
    body.append(renderMarkdown(step.body_md || ""));
    attachInlineEditor(body, {
      getValue: () => (step.body_md || "").replace(/^ /, ""),
      commit: (value) => applyStepBodyEdit(step, value),
      restore: () => body.replaceChildren(renderMarkdown(step.body_md || "")),
      multiline: true,
    });
    block.append(body);

    const shots = Array.isArray(step.screenshots) ? step.screenshots : [];
    shots.forEach((shot, idx) =>
      block.append(renderScreenshot(shot, step, idx, procedure)),
    );
    for (const embed of extractVideoEmbeds(step.body_md || "")) {
      block.append(renderVideoEmbed(embed));
    }
    if (procedure) block.append(makeAddScreenshotButton(step, procedure));
    return block;
  }

  function extractVideoEmbeds(text) {
    const embeds = [];
    const seen = new Set();
    const urlRe = /\bhttps?:\/\/[^\s)\]]+/g;
    for (const match of text.matchAll(urlRe)) {
      const url = match[0].replace(/[.,;]+$/, "");
      if (seen.has(url)) continue;
      const e = toVideoEmbed(url);
      if (e) {
        seen.add(url);
        embeds.push(e);
      }
    }
    return embeds;
  }

  function toVideoEmbed(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\//, "");
        if (id)
          return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
      }
      if (u.hostname.endsWith("youtube.com") && u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        if (id)
          return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
      }
      if (u.hostname === "vimeo.com") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        if (id)
          return { src: `https://player.vimeo.com/video/${id}`, kind: "vimeo" };
      }
    } catch {}
    return null;
  }

  function renderVideoEmbed(embed) {
    const wrap = document.createElement("div");
    wrap.className = "block-video-embed";
    const iframe = document.createElement("iframe");
    iframe.src = embed.src;
    iframe.allow = "fullscreen; autoplay; encrypted-media";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    wrap.append(iframe);
    return wrap;
  }

  function makeAddScreenshotButton(step, procedure) {
    const wrap = document.createElement("div");
    wrap.className = "block-screenshot-add";
    const btn = document.createElement("label");
    btn.className = "block-add-step block-add-screenshot";
    btn.textContent = "+ Add screenshot";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      addScreenshot(step, procedure, file);
      input.value = "";
    });
    btn.append(input);
    wrap.append(btn);
    return wrap;
  }

  async function addScreenshot(step, procedure, file) {
    if (!documentState.currentDoc) return;
    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    const isCurrentDocument = () =>
      isFresh() && documentState.currentDoc?.path === path;
    showFeedback("Uploading image…", { kind: "pending" });
    const addBtn = renderedView.querySelector(
      `.block-step[data-step-id="${step.id}"] .block-add-screenshot`,
    );
    const input = addBtn?.querySelector?.("input");
    addBtn?.classList.add("is-busy");
    if (input) input.disabled = true;
    try {
      const data = await fileToBase64(file);
      if (!isCurrentDocument()) return;
      const payload = await request(apiUrl("/images"), {
        method: "POST",
        body: JSON.stringify({
          doc_path: path,
          filename: file.name,
          data,
        }),
      });
      if (!isCurrentDocument()) return;
      step.screenshots = step.screenshots || [];
      step.screenshots.push({ src: payload.absolute_path, alt: "", caption: "" });
      applyProcedureRewrite(procedure, null);
      showFeedback(`Uploaded ${payload.absolute_path}`);
    } catch (err) {
      if (!isCurrentDocument()) return;
      showFeedback(`Upload failed: ${err.message}`, { kind: "error" });
    } finally {
      if (!isCurrentDocument()) return;
      addBtn?.classList.remove("is-busy");
      if (input) input.disabled = false;
    }
  }

  // ---------- Lint dashboard ----------


  return {
    addScreenshot, appendProcedureChildren, renderGroupBlock,
    renderStepBlock,
  };
}
