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
    drag: null,
    lastFocusedStep: null,
    lastFocusedProcedure: null,
  };
  const invoke = (name) => (...args) => api[name](...args);
  const services = {
    addScreenshot: invoke("addScreenshot"),
    appendProcedureChildren: invoke("appendProcedureChildren"),
    attachInlineEditor: invoke("attachInlineEditor"),
    commitProcedure: invoke("commitProcedure"),
    createSubpage: invoke("createSubpage"),
    draftKey: invoke("draftKey"),
    emptyNote: invoke("emptyNote"),
    escapeHtmlAttr: invoke("escapeHtmlAttr"),
    escapeRegex: invoke("escapeRegex"),
    fileToBase64: invoke("fileToBase64"),
    listDraftPaths: invoke("listDraftPaths"),
    makeAttrRow: invoke("makeAttrRow"),
    markSaving: invoke("markSaving"),
    moveCurrentDoc: invoke("moveCurrentDoc"),
    openLightbox: invoke("openLightbox"),
    patchSectionInMarkdown: invoke("patchSectionInMarkdown"),
    readProcedureModel: invoke("readProcedureModel"),
    recordPublication: invoke("recordPublication"),
    refreshChangesPanel: invoke("refreshChangesPanel"),
    refreshKnowledgeStatus: invoke("refreshKnowledgeStatus"),
    refreshParsedFromApi: invoke("refreshParsedFromApi"),
    renderInlineAtom: invoke("renderInlineAtom"),
    renderMarkdown: invoke("renderMarkdown"),
    renderParsedDocument: invoke("renderParsedDocument"),
    renderStepBlock: invoke("renderStepBlock"),
    resizeDocumentTitle: invoke("resizeDocumentTitle"),
    resolveImageSrc: invoke("resolveImageSrc"),
    resolveInlineLink: invoke("resolveInlineLink"),
    restoreProcedure: invoke("restoreProcedure"),
    setMarkdownTitle: invoke("setMarkdownTitle"),
    showChangesStatus: invoke("showChangesStatus"),
    showDiffForDraft: invoke("showDiffForDraft"),
    showRevisionConflict: invoke("showRevisionConflict"),
    snapshotProcedure: invoke("snapshotProcedure"),
    storeDraft: invoke("storeDraft"),
    stripFrontmatter: invoke("stripFrontmatter"),
    stripLeadingHeading: invoke("stripLeadingHeading"),
    titleFromMarkdown: invoke("titleFromMarkdown"),
    toggleStepAttrEditor: invoke("toggleStepAttrEditor"),
    updateSaveState: invoke("updateSaveState"),
    uploadImage: invoke("uploadImage"),
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
    createSubpage: api.createSubpage,
    deleteCurrentDoc: api.deleteCurrentDoc,
    draftKey: api.draftKey,
    discardAllDrafts: api.discardAllDrafts,
    discardDraft: api.discardDraft,
    emptyNote: api.emptyNote,
    escapeRegex: api.escapeRegex,
    enterRenderedMode: api.enterRenderedMode,
    handleClipboardPaste: api.handleClipboardPaste,
    listDraftPaths: api.listDraftPaths,
    moveCurrentDoc: api.moveCurrentDoc,
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
