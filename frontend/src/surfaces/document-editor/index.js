import { createEditorChanges } from "./changes.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { writeEditorFeedback } from "./feedback.js";
import { createEditorHistory } from "./history.js";
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
    showEditorFeedback: (message, options) =>
      writeEditorFeedback(context.editorInlineStatus, message, options),
  };
  const editorState = {
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
    refreshKnowledgeStatus: invoke("refreshKnowledgeStatus"),
    recordPublication: invoke("recordPublication"),
    showRevisionConflict: invoke("showRevisionConflict"),
    refreshParsedFromApi: invoke("refreshParsedFromApi"),
    showChangesStatus: invoke("showChangesStatus"),
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
  Object.assign(api, createEditorHistory(editorContext, services));
  Object.assign(api, createDocumentRenderer(editorContext, services));
  Object.assign(api, createProcedureRenderer(editorContext, services, editorState));
  Object.assign(api, createEditorReviewMedia(editorContext, services, editorState));
  Object.assign(api, createStructuredEditor(editorContext, services, editorState));
  Object.assign(api, createProcedureMarkdown(editorContext, services, editorState));
  Object.assign(api, createEditorMarkdown(editorContext, services));

  return {
    canLeaveDocumentEditor: api.canLeaveDocumentEditor,
    closeDiff: api.closeDiff,
    closeLightbox: api.closeLightbox,
    closeHistory: api.closeHistory,
    createDocument: api.createDocument,
    deleteCurrentDoc: api.deleteCurrentDoc,
    draftKey: api.draftKey,
    discardAllDrafts: api.discardAllDrafts,
    discardDraft: api.discardDraft,
    emptyNote: api.emptyNote,
    escapeRegex: api.escapeRegex,
    enterRenderedMode: api.enterRenderedMode,
    handleClipboardPaste: api.handleClipboardPaste,
    listDraftPaths: api.listDraftPaths,
    openHistory: api.openHistory,
    openLintReport: api.openLintReport,
    refreshChangesPanel: api.refreshChangesPanel,
    refreshKnowledgeStatus: api.refreshKnowledgeStatus,
    renameCurrentDoc: api.renameCurrentDoc,
    resizeDocumentTitle: api.resizeDocumentTitle,
    saveAllDrafts: api.saveAllDrafts,
    saveCurrentDocument: api.saveCurrentDocument,
    setSaveState: api.setSaveState,
    showCreate: api.showCreate,
    storeDraft: api.storeDraft,
    syncTitleToMarkdown: api.syncTitleToMarkdown,
    titleFromMarkdown: api.titleFromMarkdown,
    toggleViewMode: api.toggleViewMode,
    updateSaveState: api.updateSaveState,
    updateViewToggleAvailability: api.updateViewToggleAvailability,
  };
}
