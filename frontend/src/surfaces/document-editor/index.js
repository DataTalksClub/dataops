import { createEditorChanges } from "./changes.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { createEditorGit } from "./git.js";
import { createEditorLifecycle } from "./lifecycle.js";
import { createEditorMarkdown } from "./markdown.js";
import { createProcedureMarkdown } from "./procedure-markdown.js";
import { createProcedureRenderer } from "./procedure-renderer.js";
import { createEditorReviewMedia } from "./review-media.js";
import { createStructuredEditor } from "./structured-editor.js";

export function createDocumentEditor(context) {
  const api = {};
  const editorContext = {
    ...context,
    setStatus: (message) => {
      context.setStatus(message);
      writeEditorInlineStatus(context.editorInlineStatus, message);
    },
  };
  const editorState = {
    githubBase: "",
    gitBranch: "main",
    dragStep: null,
    lastFocusedStep: null,
    lastFocusedProcedure: null,
    dragGroup: null,
    dragProse: null,
    dragShot: null,
  };
  const invoke = (name) => (...args) => api[name](...args);
  const services = {
    addGroup: invoke("addGroup"),
    addProse: invoke("addProse"),
    addScreenshot: invoke("addScreenshot"),
    addStep: invoke("addStep"),
    appendProcedureChildren: invoke("appendProcedureChildren"),
    applyProcedureRewrite: invoke("applyProcedureRewrite"),
    applyStepBodyEdit: invoke("applyStepBodyEdit"),
    attachInlineEditor: invoke("attachInlineEditor"),
    deleteGroup: invoke("deleteGroup"),
    deleteProse: invoke("deleteProse"),
    deleteStep: invoke("deleteStep"),
    draftKey: invoke("draftKey"),
    emptyNote: invoke("emptyNote"),
    escapeRegex: invoke("escapeRegex"),
    escapeHtmlAttr: invoke("escapeHtmlAttr"),
    fileToBase64: invoke("fileToBase64"),
    formatStepBody: invoke("formatStepBody"),
    makeAttrRow: invoke("makeAttrRow"),
    listDraftPaths: invoke("listDraftPaths"),
    onGroupDragEnd: invoke("onGroupDragEnd"),
    onGroupDragLeave: invoke("onGroupDragLeave"),
    onGroupDragOver: invoke("onGroupDragOver"),
    onGroupDragStart: invoke("onGroupDragStart"),
    onGroupDrop: invoke("onGroupDrop"),
    onProseDragEnd: invoke("onProseDragEnd"),
    onProseDragLeave: invoke("onProseDragLeave"),
    onProseDragOver: invoke("onProseDragOver"),
    onProseDragStart: invoke("onProseDragStart"),
    onProseDrop: invoke("onProseDrop"),
    onStepDragEnd: invoke("onStepDragEnd"),
    onStepDragLeave: invoke("onStepDragLeave"),
    onStepDragOver: invoke("onStepDragOver"),
    onStepDragStart: invoke("onStepDragStart"),
    onStepDrop: invoke("onStepDrop"),
    openLightbox: invoke("openLightbox"),
    patchGroupTitleInMarkdown: invoke("patchGroupTitleInMarkdown"),
    patchSectionInMarkdown: invoke("patchSectionInMarkdown"),
    pill: invoke("pill"),
    refreshChangesPanel: invoke("refreshChangesPanel"),
    refreshGitStatus: invoke("refreshGitStatus"),
    refreshParsedFromApi: invoke("refreshParsedFromApi"),
    renderMarkdown: invoke("renderMarkdown"),
    renderParsedDocument: invoke("renderParsedDocument"),
    renderProseBlock: invoke("renderProseBlock"),
    renderScreenshot: invoke("renderScreenshot"),
    renderStepBlock: invoke("renderStepBlock"),
    renumberProcedure: invoke("renumberProcedure"),
    resolveImageSrc: invoke("resolveImageSrc"),
    restoreProcedure: invoke("restoreProcedure"),
    showDiffForDraft: invoke("showDiffForDraft"),
    snapshotProcedure: invoke("snapshotProcedure"),
    resizeDocumentTitle: invoke("resizeDocumentTitle"),
    setMarkdownTitle: invoke("setMarkdownTitle"),
    storeDraft: invoke("storeDraft"),
    stripFrontmatter: invoke("stripFrontmatter"),
    stripLeadingHeading: invoke("stripLeadingHeading"),
    titleFromMarkdown: invoke("titleFromMarkdown"),
    toggleStepAttrEditor: invoke("toggleStepAttrEditor"),
    updateSaveState: invoke("updateSaveState"),
    updateViewToggleAvailability: invoke("updateViewToggleAvailability"),
  };

  Object.assign(api, createEditorLifecycle(editorContext, services));
  Object.assign(api, createEditorChanges(editorContext, services));
  Object.assign(api, createEditorGit(editorContext, services, editorState));
  Object.assign(api, createDocumentRenderer(editorContext, services, editorState));
  Object.assign(api, createProcedureRenderer(editorContext, services, editorState));
  Object.assign(api, createEditorReviewMedia(editorContext, services, editorState));
  Object.assign(api, createStructuredEditor(editorContext, services, editorState));
  Object.assign(api, createProcedureMarkdown(editorContext, services, editorState));
  Object.assign(api, createEditorMarkdown(editorContext, services));

  return {
    canLeaveDocumentEditor: api.canLeaveDocumentEditor,
    closeDiff: api.closeDiff,
    closeLightbox: api.closeLightbox,
    closeCommitForm: api.closeCommitForm,
    createDocument: api.createDocument,
    deleteCurrentDoc: api.deleteCurrentDoc,
    draftKey: api.draftKey,
    discardAllDrafts: api.discardAllDrafts,
    discardDraft: api.discardDraft,
    emptyNote: api.emptyNote,
    escapeRegex: api.escapeRegex,
    enterRenderedMode: api.enterRenderedMode,
    gitPull: api.gitPull,
    handleClipboardPaste: api.handleClipboardPaste,
    listDraftPaths: api.listDraftPaths,
    openCommitForm: api.openCommitForm,
    openLintReport: api.openLintReport,
    refreshChangesPanel: api.refreshChangesPanel,
    refreshGitStatus: api.refreshGitStatus,
    renameCurrentDoc: api.renameCurrentDoc,
    resizeDocumentTitle: api.resizeDocumentTitle,
    saveAllDrafts: api.saveAllDrafts,
    saveCurrentDocument: api.saveCurrentDocument,
    setSaveState: api.setSaveState,
    showCreate: api.showCreate,
    storeDraft: api.storeDraft,
    submitCommitForm: api.submitCommitForm,
    syncTitleToMarkdown: api.syncTitleToMarkdown,
    titleFromMarkdown: api.titleFromMarkdown,
    toggleViewMode: api.toggleViewMode,
    updateGithubLink: api.updateGithubLink,
    updateSaveState: api.updateSaveState,
    updateViewToggleAvailability: api.updateViewToggleAvailability,
  };
}

/**
 * Write the editor-owned inline status.
 *
 * The editor owns `#editor-inline-status` in the markup; nothing relocates
 * shell nodes at runtime.
 */
function writeEditorInlineStatus(status, message) {
  if (!status) return;
  const text = String(message || "").trim();
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle(
    "is-error",
    /(?:failed|error|unavailable|required|denied|conflict|could not|cannot|not found)/i.test(
      text,
    ),
  );
}
