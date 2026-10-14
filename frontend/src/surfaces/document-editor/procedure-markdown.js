import { editorFeedbackFor } from "./feedback.js";
import { emitProcedure, parseProcedure } from "./procedure-model.js";

function sectionPattern(name) {
  return new RegExp(
    `(<!--\\s*sop-section-start:\\s*${name}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-section-end\\s*-->)`,
  );
}

/** The text between a section's markers, or null when it has none. */
export function readSectionBody(markdown, name) {
  const match = String(markdown ?? "").match(sectionPattern(name));
  return match ? match[2] : null;
}

export function patchSectionInMarkdown(markdown, name, newBodyMd) {
  const re = sectionPattern(name);
  if (!re.test(markdown)) return null;
  return markdown.replace(re, (_, open, _body, close) => `${open}${newBodyMd}${close}`);
}

export function createProcedureMarkdown(context, services) {
  const { editor, renderedView } = context;
  const { renderParsedDocument, storeDraft, updateSaveState } = services;
  const showFeedback = editorFeedbackFor(context);

  function readProcedureModel() {
    const body = readSectionBody(editor.value, "procedure");
    return body == null ? null : parseProcedure(body);
  }

  /**
   * Write an edited procedure model back into the document. Text edits pass
   * `rerender: false` so the block being typed in keeps its DOM and caret.
   */
  function commitProcedure(model, { rerender = true, focus = null } = {}) {
    const updated = patchSectionInMarkdown(editor.value, "procedure", emitProcedure(model));
    if (updated == null) {
      showFeedback("Could not locate procedure section; edit not saved.", { kind: "error" });
      return false;
    }
    if (updated !== editor.value) {
      editor.value = updated;
      storeDraft();
      updateSaveState();
    }
    if (rerender) {
      renderParsedDocument();
      if (focus) focusProcedureItem(focus);
    }
    return true;
  }

  function focusProcedureItem(focus) {
    let target = null;
    if (focus.stepId != null) {
      target = renderedView.querySelector(
        `.block-step[data-step-id="${focus.stepId}"] .block-step-body`,
      );
    }
    if (target) {
      target.scrollIntoView?.({ behavior: "smooth", block: "center" });
      target.click?.();
    }
  }

  function snapshotProcedure() {
    return readSectionBody(editor.value, "procedure");
  }

  function restoreProcedure(snapshot) {
    if (snapshot == null) return;
    const updated = patchSectionInMarkdown(editor.value, "procedure", snapshot);
    if (updated == null) return;
    editor.value = updated;
    storeDraft();
    updateSaveState();
    renderParsedDocument();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  return {
    commitProcedure, escapeHtmlAttr, escapeRegex, patchSectionInMarkdown,
    readProcedureModel, restoreProcedure, snapshotProcedure,
  };
}
