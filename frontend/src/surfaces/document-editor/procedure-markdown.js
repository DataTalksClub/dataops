export function createProcedureMarkdown(context, services, editorState) {
  const {
    editor, renderedView, setStatus, showUndoToast,
  } = context;
  const {
    attachInlineEditor, deleteProse, formatStepBody, onProseDragEnd,
    onProseDragLeave, onProseDragOver, onProseDragStart, onProseDrop,
    openLightbox, renderMarkdown, renderParsedDocument,
    resolveImageSrc, restoreProcedure, snapshotProcedure, storeDraft,
    updateSaveState,
  } = services;

  function renumberProcedure(procedure) {
    let n = 0;
    for (const g of procedure.groups || []) {
      for (const s of g.steps || []) {
        n += 1;
        s.id = n;
        s.rendered_number = n;
      }
    }
    for (const s of procedure.flat_steps || []) {
      n += 1;
      s.id = n;
      s.rendered_number = n;
    }
  }

  function applyProcedureRewrite(procedure, focusStepId) {
    const newBody = emitProcedureSectionBody(procedure);
    const updated = patchSectionInMarkdown(editor.value, "procedure", newBody);
    if (updated == null) {
      setStatus("Could not locate procedure section; structural edit not saved.");
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
    renderParsedDocument();
    if (focusStepId != null) {
      // After re-render, find the new step's body and open the inline editor.
      const block = renderedView.querySelector(
        `.block-step[data-step-id="${focusStepId}"] .block-step-body`,
      );
      if (block) {
        block.scrollIntoView({ behavior: "smooth", block: "center" });
        block.click();
      }
    }
  }

  function emitProcedureSectionBody(procedure) {
    const out = ["## Procedure", ""];
    const todos = procedure.todos || [];
    for (const t of todos) out.push(`<!-- sop-todo: "${escapeAttr(t)}" -->`);
    if (todos.length) out.push("");

    const groups = procedure.groups || [];
    if (groups.length) {
      for (const g of groups) {
        out.push(`<!-- sop-group-start: "${escapeAttr(g.title || "")}" -->`);
        out.push(`### ${g.title || ""}`);
        out.push("");
        for (const s of g.steps || []) out.push(emitStepBlock(s));
        out.push(`<!-- sop-group-end -->`);
        out.push("");
      }
    }
    for (const s of procedure.flat_steps || []) out.push(emitStepBlock(s));

    for (const p of procedure.prose || []) {
      out.push(`<!-- sop-prose-start -->`);
      out.push(p.body_md || "");
      out.push(`<!-- sop-prose-end -->`);
      out.push("");
    }
    return out.join("\n").replace(/\n+$/, "");
  }

  function emitStepBlock(step) {
    const attrParts = [`id=${step.id}`];
    for (const [k, v] of Object.entries(step.attrs || {})) {
      if (Array.isArray(v)) {
        if (v.length) attrParts.push(`${k}="${escapeAttr(v.join(","))}"`);
      } else if (v != null && v !== "") {
        attrParts.push(`${k}="${escapeAttr(String(v))}"`);
      }
    }
    const lines = [];
    lines.push(`<!-- sop-step-start ${attrParts.join(" ")} -->`);
    const renderedNum = step.rendered_number ?? step.id;
    const bodyText = (step.body_md || "").replace(/^ /, "");
    lines.push(formatStepBody(bodyText, renderedNum));
    for (const shot of step.screenshots || []) {
      lines.push("");
      lines.push("    <!-- sop-screenshot-start -->");
      if (shot.src) lines.push(`    ![${shot.alt || ""}](${shot.src})`);
      if (shot.caption) {
        lines.push("    <!-- sop-caption-start -->");
        lines.push(`    ${shot.caption}`);
        lines.push("    <!-- sop-caption-end -->");
      }
      lines.push("    <!-- sop-screenshot-end -->");
    }
    lines.push(`<!-- sop-step-end -->`);
    lines.push("");
    return lines.join("\n");
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '\\"');
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function patchSectionInMarkdown(markdown, name, newBodyMd) {
    const re = new RegExp(
      `(<!--\\s*sop-section-start:\\s*${name}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-section-end\\s*-->)`,
    );
    if (!re.test(markdown)) return null;
    return markdown.replace(
      re,
      (_, open, _body, close) => `${open}${newBodyMd}${close}`,
    );
  }

  function patchProseInMarkdown(markdown, index, newBodyMd) {
    const re =
      /<!--\s*sop-prose-start\s*-->\n([\s\S]*?)\n<!--\s*sop-prose-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const next = markdown.replace(re, (full, _body) => {
      if (i++ === index) {
        replaced = true;
        return `<!-- sop-prose-start -->\n${newBodyMd}\n<!-- sop-prose-end -->`;
      }
      return full;
    });
    return replaced ? next : null;
  }

  function patchGroupTitleInMarkdown(markdown, oldTitle, newTitle) {
    const escapedOld = escapeRegex(oldTitle);
    const markerRe = new RegExp(
      `(<!--\\s*sop-group-start:\\s*")${escapedOld}("\\s*-->)`,
    );
    if (!markerRe.test(markdown)) return null;
    let next = markdown.replace(markerRe, `$1${newTitle.replace(/"/g, '\\"')}$2`);
    // Also update the visible "### <title>" line if it sits inside this group.
    const headingRe = new RegExp(`(\\n)###\\s+${escapedOld}(\\s*\\n)`);
    next = next.replace(headingRe, `$1### ${newTitle}$2`);
    return next;
  }

  function patchCaptionInMarkdown(markdown, stepId, screenshotIndex, newCaption) {
    const stepRe = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(stepRe);
    if (!match) return null;
    let inner = match[2];
    const shotRe =
      /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const newInner = inner.replace(shotRe, (full, shotBody) => {
      if (i++ !== screenshotIndex) return full;
      replaced = true;
      const captionRe =
        /<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->/;
      const replacement = newCaption
        ? `<!-- sop-caption-start -->\n    ${newCaption}\n    <!-- sop-caption-end -->`
        : null;
      if (captionRe.test(shotBody)) {
        const newBody = replacement
          ? shotBody.replace(captionRe, replacement)
          : shotBody.replace(
              /\s*<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->\s*/,
              "",
            );
        return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
      }
      if (!replacement) return full;
      // Insert a caption before the screenshot-end marker.
      const insertedBody = shotBody.replace(
        /(\n\s*)$/,
        (_, ws) => `\n    ${replacement}${ws}`,
      );
      return `<!-- sop-screenshot-start -->\n${insertedBody}<!-- sop-screenshot-end -->`;
    });
    if (!replaced) return null;
    return markdown.replace(
      stepRe,
      (_, openMarker, _inner, closeMarker) =>
        `${openMarker}${newInner}${closeMarker}`,
    );
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function renderProseBlock(prose, index, procedure) {
    const block = document.createElement("aside");
    block.className = "block-prose";
    if (procedure) {
      block.addEventListener("dragover", (event) =>
        onProseDragOver(event, prose, block, procedure),
      );
      block.addEventListener("dragleave", (event) =>
        onProseDragLeave(event, block),
      );
      block.addEventListener("drop", (event) =>
        onProseDrop(event, prose, block, procedure),
      );
    }

    const headerRow = document.createElement("div");
    headerRow.className = "block-prose-header";
    if (procedure) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag block-prose-drag";
      handle.title = "Drag to reorder";
      handle.setAttribute("aria-label", "Drag free-form block");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onProseDragStart(event, prose, block, procedure),
      );
      handle.addEventListener("dragend", onProseDragEnd);
      headerRow.append(handle);
    }
    const label = document.createElement("span");
    label.className = "block-prose-label";
    label.textContent = "Free-form";
    headerRow.append(label);
    if (procedure) {
      const spacer = document.createElement("span");
      spacer.className = "block-step-spacer";
      headerRow.append(spacer);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete free-form block";
      delBtn.setAttribute("aria-label", "Delete free-form block");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProse(procedure, prose);
      });
      headerRow.append(delBtn);
    }
    block.append(headerRow);

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "block-prose-body";
    bodyWrap.append(renderMarkdown(prose.body_md || ""));
    attachInlineEditor(bodyWrap, {
      getValue: () => prose.body_md || "",
      commit: (value) => applyProseEdit(prose, index, value),
      restore: () =>
        bodyWrap.replaceChildren(renderMarkdown(prose.body_md || "")),
      multiline: true,
    });
    block.append(bodyWrap);
    return block;
  }

  function applyProseEdit(prose, index, newBody) {
    prose.body_md = newBody;
    const updated = patchProseInMarkdown(editor.value, index, newBody);
    if (updated == null) {
      setStatus(`Could not locate prose block #${index + 1}; edit not saved.`);
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function renderScreenshot(shot, step, screenshotIndex, procedure) {
    const figure = document.createElement("figure");
    figure.className = "block-screenshot";
    figure.tabIndex = 0;
    if (procedure) {
      figure.addEventListener("dragover", (event) =>
        onScreenshotDragOver(event, shot, figure, step, procedure),
      );
      figure.addEventListener("dragleave", (event) =>
        onScreenshotDragLeave(event, figure),
      );
      figure.addEventListener("drop", (event) =>
        onScreenshotDrop(event, shot, figure, step, procedure),
      );
    }

    const toolbar = document.createElement("div");
    toolbar.className = "block-screenshot-toolbar";
    if (procedure && (step.screenshots || []).length > 1) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag block-screenshot-drag";
      handle.title = "Drag to reorder screenshot";
      handle.setAttribute("aria-label", "Drag screenshot");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onScreenshotDragStart(event, shot, figure, step, procedure),
      );
      handle.addEventListener("dragend", onScreenshotDragEnd);
      toolbar.append(handle);
    }
    if (procedure) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete screenshot";
      delBtn.setAttribute("aria-label", "Delete screenshot");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteScreenshot(step, shot, procedure);
      });
      toolbar.append(delBtn);
    }
    if (toolbar.children.length) figure.append(toolbar);

    const noteToggle = document.createElement("button");
    noteToggle.type = "button";
    noteToggle.className = "block-screenshot-note-toggle";
    noteToggle.textContent = "Text";
    noteToggle.title = "Show image text";
    noteToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      figure.classList.toggle("is-note-visible");
    });
    figure.append(noteToggle);

    if (shot.src) {
      const img = document.createElement("img");
      img.src = resolveImageSrc(shot.src);
      img.alt = shot.alt || "";
      img.loading = "lazy";
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        openLightbox(img.src, shot.caption || shot.alt || "");
      });
      figure.append(img);
    }
    const cap = document.createElement("figcaption");
    cap.className = "block-screenshot-note";
    cap.textContent = shot.caption || (step ? "Add caption…" : "");
    if (!shot.caption) cap.classList.add("is-placeholder");
    if (step) {
      attachInlineEditor(cap, {
        getValue: () => shot.caption || "",
        commit: (value) =>
          applyCaptionEdit(step, screenshotIndex, shot, value, cap),
        restore: () => {
          cap.textContent = shot.caption || "Add caption…";
          cap.classList.toggle("is-placeholder", !shot.caption);
        },
        multiline: true,
      });
    }
    const notes = document.createElement("div");
    notes.className = "block-screenshot-notes";
    notes.append(cap);

    if (step) {
      const alt = document.createElement("div");
      alt.className = "block-screenshot-alt block-screenshot-note";
      alt.textContent = shot.alt || "Add alt text for accessibility…";
      if (!shot.alt) alt.classList.add("is-placeholder");
      attachInlineEditor(alt, {
        getValue: () => shot.alt || "",
        commit: (value) => applyAltEdit(step, screenshotIndex, shot, value),
        restore: () => {
          alt.textContent = shot.alt || "Add alt text for accessibility…";
          alt.classList.toggle("is-placeholder", !shot.alt);
        },
        multiline: false,
      });
      notes.append(alt);
    }
    figure.append(notes);
    return figure;
  }

  function deleteScreenshot(step, shot, procedure) {
    const snapshot = snapshotProcedure(procedure);
    step.screenshots = (step.screenshots || []).filter((s) => s !== shot);
    applyProcedureRewrite(procedure, null);
    showUndoToast("Screenshot deleted.", () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function onScreenshotDragStart(event, shot, figEl, step, procedure) {
    editorState.dragShot = { shot, step, procedure, figEl };
    figEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "screenshot");
    } catch {}
    event.stopPropagation();
  }

  function onScreenshotDragEnd() {
    if (editorState.dragShot && editorState.dragShot.figEl)
      editorState.dragShot.figEl.classList.remove("is-dragging");
    editorState.dragShot = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onScreenshotDragOver(event, _shot, figEl, step, procedure) {
    if (!editorState.dragShot) return;
    if (editorState.dragShot.step !== step) return;
    if (editorState.dragShot.figEl === figEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.stopPropagation();
    const rect = figEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    figEl.classList.toggle("drop-above", above);
    figEl.classList.toggle("drop-below", !above);
  }

  function onScreenshotDragLeave(event, figEl) {
    if (!figEl.contains(event.relatedTarget)) {
      figEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onScreenshotDrop(event, target, figEl, step, procedure) {
    if (!editorState.dragShot || editorState.dragShot.step !== step) return;
    event.preventDefault();
    event.stopPropagation();
    const above = figEl.classList.contains("drop-above");
    figEl.classList.remove("drop-above", "drop-below");
    const dragged = editorState.dragShot.shot;
    editorState.dragShot = null;
    if (dragged === target) return;

    const list = step.screenshots || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);

    applyProcedureRewrite(procedure, null);
  }

  function applyAltEdit(step, screenshotIndex, shot, newAlt) {
    shot.alt = newAlt;
    const updated = patchAltInMarkdown(
      editor.value,
      step.id,
      screenshotIndex,
      newAlt,
      shot.src,
    );
    if (updated == null) {
      setStatus(
        `Could not locate alt for screenshot #${screenshotIndex + 1} on step ${step.id}.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function patchAltInMarkdown(markdown, stepId, screenshotIndex, newAlt, src) {
    const stepRe = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(stepRe);
    if (!match) return null;
    let inner = match[2];
    const shotRe =
      /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const newInner = inner.replace(shotRe, (full, shotBody) => {
      if (i++ !== screenshotIndex) return full;
      replaced = true;
      const imgRe = /!\[[^\]]*\]\(([^)]+)\)/;
      const newBody = shotBody.replace(imgRe, `![${newAlt}](${src})`);
      return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
    });
    if (!replaced) return null;
    return markdown.replace(
      stepRe,
      (_, openMarker, _inner, closeMarker) =>
        `${openMarker}${newInner}${closeMarker}`,
    );
  }

  function applyCaptionEdit(step, screenshotIndex, shot, newCaption, capEl) {
    shot.caption = newCaption;
    const updated = patchCaptionInMarkdown(
      editor.value,
      step.id,
      screenshotIndex,
      newCaption,
    );
    if (updated == null) {
      setStatus(
        `Could not locate caption #${screenshotIndex + 1} on step ${step.id}; edit not saved.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }


  return {
    applyProcedureRewrite, escapeHtmlAttr, escapeRegex, patchGroupTitleInMarkdown,
    patchSectionInMarkdown, renderProseBlock, renderScreenshot,
    renumberProcedure,
  };
}
