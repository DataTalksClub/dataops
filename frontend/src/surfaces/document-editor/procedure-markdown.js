import { editorFeedbackFor } from "./feedback.js";
import { focusEditable, plainTextLength } from "./editable.js";
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

  /**
   * Focus an item after a re-render. Items are found by position because a
   * re-render parses fresh objects: { kind: "step", id } (ids are renumbered
   * in document order), { kind: "prose" | "group" | "todo", index }. The caret
   * goes to `at` ("start", "end", a visible-text offset), after the markdown
   * `prefix`, or selects the whole text with `select`.
   */
  function focusProcedureItem(focus) {
    const section = renderedView.querySelector('.block-section[data-section="procedure"]');
    if (!section) return;
    let target = null;
    if (focus.kind === "step") {
      target = section.querySelector(`.block-step[data-step-id="${focus.id}"] .block-step-body`);
    } else if (focus.kind === "prose") {
      target = section.querySelectorAll(".block-prose-body")[focus.index];
    } else if (focus.kind === "group") {
      target = section.querySelectorAll(".block-group-title")[focus.index];
    } else if (focus.kind === "todo") {
      target = section.querySelectorAll(".block-todo-text")[focus.index];
    }
    if (!target) return;
    let at = focus.at ?? "end";
    if (focus.prefix != null) {
      at = target.__editable?.mode === "rich" ? plainTextLength(focus.prefix) : focus.prefix.length;
    }
    focusEditable(target, at);
    if (focus.select) target.ownerDocument.getSelection?.()?.selectAllChildren(target);
    if (focus.slash) target.ownerDocument.execCommand("insertText", false, "/");
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

  return {
    commitProcedure, escapeRegex, focusProcedureItem, patchSectionInMarkdown,
    readProcedureModel, restoreProcedure, snapshotProcedure,
  };
}
