import { editorMutationGuard, feedbackKindForError } from "./feedback.js";

export function createEditorLifecycle(context, services) {
  const {
    apiUrl, basename, beginDocumentNavigation, canLeaveCurrentDocument,
    closeSidebar, confirmDialog, documentState,
    documentTitle, editor, editorDiscardButton, editorSaveButton,
    editorSaveState, editorView, knowledgeState, loadDocuments,
    newDocForm, newDocPath, newDocSummary, newDocTitle, newDocType,
    openDocument,
    request, setRouteTitle, setView, showEditorFeedback,
    storage,
  } = context;
  const {
    refreshChangesPanel, refreshGitStatus, refreshParsedFromApi,
    renderParsedDocument, showChangesStatus, updateViewToggleAvailability,
  } = services;

  const DRAFT_PREFIX = "dtc-doc-draft:";
  let saveInFlight = false;
  let createInFlight = false;

  function setCreateBusy(busy) {
    const submit = newDocForm.querySelector?.('button[type="submit"]');
    if (submit) {
      submit.disabled = busy;
      submit.classList.toggle("is-busy", busy);
      if (busy) submit.setAttribute("aria-busy", "true");
      else submit.removeAttribute("aria-busy");
    }
    if (busy) newDocForm.setAttribute?.("aria-busy", "true");
    else newDocForm.removeAttribute?.("aria-busy");
  }

  async function saveCurrentDocument() {
    if (!documentState.currentDoc || saveInFlight) return;
    saveInFlight = true;

    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    const isCurrentDocument = () =>
      isFresh() && documentState.currentDoc?.path === path;
    const content = editor.value;
    const url = apiUrl("/docs");
    url.searchParams.set("path", path);
    editorSaveButton.disabled = true;
    setSaveState("Saving...");
    showEditorFeedback("Saving…", { kind: "pending" });

    try {
      const payload = await request(url, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      if (!isCurrentDocument()) return;

      documentState.currentDoc.updated = payload.updated;
      documentState.lastSavedContent = content;
      storage.removeItem(draftKey(path));
      documentState.hasDraft = false;
      documentState.currentParsed = null;
      updateViewToggleAvailability();
      if (editorView.dataset.mode === "rendered") {
        // Body changed; reparse via API.
        await refreshParsedFromApi();
        if (!isCurrentDocument()) return;
        renderParsedDocument();
      }
      updateSaveState();
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      documentState.currentWarnings = warnings;
      if (warnings.length) {
        flashSaveState(
          `Saved with ${warnings.length} lint warning${warnings.length === 1 ? "" : "s"}`,
        );
        showEditorFeedback(
          `Saved · ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ""}`,
          { kind: "warning" },
        );
      } else {
        flashSaveState("Saved");
        showEditorFeedback(`Saved ${path}.`);
      }
      if (editorView.dataset.mode === "rendered") renderParsedDocument();
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
      if (!isCurrentDocument()) return;
      restoreMutationFocus();
    } catch (error) {
      if (!isCurrentDocument()) return;
      showEditorFeedback(error.message, { kind: feedbackKindForError(error) });
      updateSaveState();
      restoreMutationFocus();
    } finally {
      saveInFlight = false;
    }
  }

  async function discardDraft() {
    if (!documentState.currentDoc) return;

    const confirmed = await confirmDialog(
      `Discard the local draft for ${documentState.currentDoc.path}?`,
      { okText: "Discard", danger: true },
    );
    if (!confirmed) return;

    storage.removeItem(draftKey(documentState.currentDoc.path));
    documentState.hasDraft = false;
    editor.value = documentState.lastSavedContent;
    documentTitle.value =
      titleFromMarkdown(editor.value) || basename(documentState.currentDoc.path);
    updateSaveState();
    refreshChangesPanel({ keepVisibleAfterAction: true });
    showChangesStatus("Draft discarded.");
    restoreMutationFocus();
  }

  async function createDocument() {
    if (createInFlight) return;
    const isFresh = editorMutationGuard(context);
    let path = newDocPath.value.trim();
    const title = newDocTitle.value.trim();
    const docType = newDocType.value;
    const summary = newDocSummary.value.trim();
    const scaffold =
      document.querySelector('input[name="scaffold"]:checked')?.value || "full";

    if (!path) {
      setCreateStatus("Path is required.", "error");
      return;
    }
    // Normalise so the user gets a friendly hint instead of a backend 400.
    path = path.replace(/^\/+/, "");
    if (!path.startsWith("content/")) {
      path = `content/${path}`;
    }
    if (!path.endsWith(".md")) {
      path += ".md";
    }

    createInFlight = true;
    setCreateBusy(true);
    setCreateStatus("Creating…", "pending");
    try {
      const payload = await request(apiUrl("/docs"), {
        method: "POST",
        body: JSON.stringify({
          path,
          title,
          doc_type: docType,
          summary,
          scaffold,
        }),
      });
      if (!isFresh()) return;

      newDocForm.reset();
      setCreateStatus("");
      await loadDocuments();
      if (!isFresh()) return;
      await openDocument(payload.path);
      if (documentState.currentDoc?.path !== payload.path) return;
      showEditorFeedback(`Created ${payload.path}.`);
    } catch (error) {
      if (!isFresh()) return;
      setCreateStatus(error.message, feedbackKindForError(error));
    } finally {
      createInFlight = false;
      setCreateBusy(false);
    }
  }

  function syncTitleToMarkdown() {
    if (!documentState.currentDoc) return;
    const title = normalizedDocumentTitle() || basename(documentState.currentDoc.path);
    if (documentTitle.value !== title) documentTitle.value = title;
    resizeDocumentTitle();
    editor.value = setMarkdownTitle(editor.value, title);
    storeDraft();
    updateSaveState();
    setRouteTitle(title);
  }

  function normalizedDocumentTitle() {
    return documentTitle.value.replace(/\s+/g, " ").trim();
  }

  function resizeDocumentTitle() {
    if (getComputedStyle(documentTitle).display === "none") return;
    const fallbackHeight =
      parseFloat(getComputedStyle(documentTitle).lineHeight) || 32;
    documentTitle.style.height = "auto";
    documentTitle.style.height = `${Math.max(documentTitle.scrollHeight, fallbackHeight)}px`;
  }

  function setMarkdownTitle(markdown, title) {
    let next = markdown;

    const fmMatch = next.match(/^---\n[\s\S]*?\n---/);
    if (fmMatch) {
      const fm = fmMatch[0];
      const updated = /\ntitle:\s*/.test(fm)
        ? fm.replace(/(\ntitle:\s*).*/, `$1"${title}"`)
        : fm.replace(/^---\n/, `---\ntitle: "${title}"\n`);
      next = updated + next.slice(fm.length);
    }

    const bodyOffset = next.match(/^---\n[\s\S]*?\n---\n?/)?.[0].length || 0;
    const body = next.slice(bodyOffset);

    // Replace H1 only if it is the first non-empty line of the body.
    const topH1 = body.match(/^(\s*)#\s+.+/);
    if (topH1) {
      const rewritten = `${topH1[1]}# ${title}` + body.slice(topH1[0].length);
      return next.slice(0, bodyOffset) + rewritten;
    }

    // Prepend an H1 only when the body is empty/whitespace.
    if (/^\s*$/.test(body)) {
      return next.slice(0, bodyOffset) + `# ${title}\n`;
    }

    // Body has content but no top-level H1 — leave the document alone.
    return next;
  }

  function storeDraft() {
    const wasDraft = documentState.hasDraft;
    storage.setItem(draftKey(documentState.currentDoc.path), editor.value);
    documentState.hasDraft = true;
    if (!wasDraft) refreshChangesPanel();
  }

  function updateSaveState() {
    if (!documentState.currentDoc) {
      editorSaveButton.disabled = true;
      editorDiscardButton.disabled = true;
      setSaveState("");
      return;
    }

    const hasChanges = editor.value !== documentState.lastSavedContent;
    editorSaveButton.disabled = !hasChanges;
    editorDiscardButton.disabled = !documentState.hasDraft;
    if (hasChanges) {
      setSaveState("Unsaved changes");
    } else {
      setSaveState("");
    }
  }

  function flashSaveState(message, duration = 1800) {
    setSaveState(message);
    if (flashSaveState._timer) clearTimeout(flashSaveState._timer);
    flashSaveState._timer = setTimeout(() => {
      updateSaveState();
    }, duration);
  }

  async function canLeaveDocumentEditor() {
    if (!documentState.currentDoc || editor.value === documentState.lastSavedContent) return true;
    return await confirmDialog(
      "This page has unsaved local changes. Leave it anyway?",
      { okText: "Leave", danger: true },
    );
  }

  async function showCreate() {
    if (!(await canLeaveCurrentDocument())) return;
    beginDocumentNavigation();
    if (!newDocPath.value.trim()) {
      const base = knowledgeState.selectedFolder ? `content/${knowledgeState.selectedFolder}` : "content";
      newDocPath.value = `${base}/new-document.md`;
    }
    setRouteTitle("New page");
    setView("create");
    closeSidebar();
    setCreateStatus("");
    newDocPath.focus();
  }

  function setCreateStatus(message, kind = "") {
    const status = newDocForm.querySelector?.(".status-text");
    if (!status) return;
    status.classList.add("create-status");
    const assertive = ["validation", "conflict", "error"].includes(kind);
    const state = message ? kind || "success" : "idle";
    status.classList.toggle("is-error", assertive);
    status.classList.toggle("is-warning", kind === "warning");
    status.textContent = message || "Create a Markdown document in this repository.";
    status.hidden = false;
    status.dataset.feedbackState = state;
    status.setAttribute("role", assertive ? "alert" : "status");
    status.setAttribute("aria-live", assertive ? "assertive" : "polite");
    status.setAttribute("aria-atomic", "true");
  }

  function setSaveState(message) {
    editorSaveState.textContent = message;
  }

  function restoreMutationFocus() {
    editorSaveState.focus();
  }

  function titleFromMarkdown(markdown) {
    const frontmatterTitle = markdown.match(
      /^---[\s\S]*?\ntitle:\s*"?([^"\n]+)"?[\s\S]*?\n---/,
    );
    if (frontmatterTitle) return frontmatterTitle[1].trim();
    const heading = markdown.match(/^#\s+(.+)$/m);
    return heading ? heading[1].trim() : "";
  }

  function draftKey(path) {
    return `dtc-doc-draft:${path}`;
  }

  // ---------- Pending changes panel ----------

  function listDraftPaths() {
    const paths = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(DRAFT_PREFIX)) {
          paths.push(key.slice(DRAFT_PREFIX.length));
        }
      }
    } catch {}
    paths.sort();
    return paths;
  }


  return {
    canLeaveDocumentEditor, createDocument, discardDraft, draftKey,
    listDraftPaths, resizeDocumentTitle, saveCurrentDocument, setMarkdownTitle,
    setSaveState,
    showCreate, storeDraft, syncTitleToMarkdown, titleFromMarkdown,
    updateSaveState,
  };
}
