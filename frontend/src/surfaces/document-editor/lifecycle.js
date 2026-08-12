export function createEditorLifecycle(context, services) {
  const {
    apiUrl, basename, beginDocumentNavigation, canLeaveCurrentDocument,
    closeSidebar, confirmDialog, discardButton, documentState,
    documentTitle, editor, editorView, knowledgeState, loadDocuments,
    newDocForm, newDocPath, newDocSummary, newDocTitle, newDocType,
    openDocument,
    request, saveButton, saveState, setPageTitle, setStatus, setView,
    storage,
  } = context;
  const {
    refreshChangesPanel, refreshGitStatus, refreshParsedFromApi,
    renderParsedDocument, updateViewToggleAvailability,
  } = services;

  const DRAFT_PREFIX = "dtc-doc-draft:";

  async function saveCurrentDocument() {
    if (!documentState.currentDoc) return;

    const url = apiUrl("/docs");
    url.searchParams.set("path", documentState.currentDoc.path);
    saveButton.disabled = true;
    setSaveState("Saving...");

    try {
      const payload = await request(url, {
        method: "PUT",
        body: JSON.stringify({ content: editor.value }),
      });

      documentState.currentDoc.updated = payload.updated;
      documentState.lastSavedContent = editor.value;
      storage.removeItem(draftKey(documentState.currentDoc.path));
      documentState.hasDraft = false;
      documentState.currentParsed = null;
      updateViewToggleAvailability();
      if (editorView.dataset.mode === "rendered") {
        // Body changed; reparse via API.
        await refreshParsedFromApi();
        renderParsedDocument();
      }
      updateSaveState();
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      documentState.currentWarnings = warnings;
      if (warnings.length) {
        flashSaveState(
          `Saved with ${warnings.length} lint warning${warnings.length === 1 ? "" : "s"}`,
        );
        setStatus(
          `Saved · ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ""}`,
        );
      } else {
        flashSaveState("Saved");
        setStatus(`Saved ${documentState.currentDoc.path}.`);
      }
      if (editorView.dataset.mode === "rendered") renderParsedDocument();
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (error) {
      setStatus(error.message);
      updateSaveState();
    }
  }

  function discardDraft() {
    if (!documentState.currentDoc) return;
    storage.removeItem(draftKey(documentState.currentDoc.path));
    documentState.hasDraft = false;
    editor.value = documentState.lastSavedContent;
    documentTitle.value =
      titleFromMarkdown(editor.value) || basename(documentState.currentDoc.path);
    updateSaveState();
    refreshChangesPanel();
  }

  async function createDocument() {
    let path = newDocPath.value.trim();
    const title = newDocTitle.value.trim();
    const docType = newDocType.value;
    const summary = newDocSummary.value.trim();
    const scaffold =
      document.querySelector('input[name="scaffold"]:checked')?.value || "full";

    if (!path) {
      setStatus("Path is required.");
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

      newDocForm.reset();
      await loadDocuments();
      await openDocument(payload.path);
      setStatus(`Created ${payload.path}.`);
    } catch (error) {
      setStatus(error.message);
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
    setPageTitle(title, documentState.currentDoc.path);
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
      saveButton.disabled = true;
      discardButton.disabled = true;
      setSaveState("");
      saveState.classList.remove("has-changes");
      return;
    }

    const hasChanges = editor.value !== documentState.lastSavedContent;
    saveButton.disabled = !hasChanges;
    discardButton.disabled = !documentState.hasDraft;
    if (hasChanges) {
      setSaveState("Unsaved changes");
    } else {
      setSaveState("");
    }
    saveState.classList.toggle("has-changes", hasChanges);
  }

  function flashSaveState(message, duration = 1800) {
    setSaveState(message);
    saveState.classList.add("flash");
    if (flashSaveState._timer) clearTimeout(flashSaveState._timer);
    flashSaveState._timer = setTimeout(() => {
      saveState.classList.remove("flash");
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
    setPageTitle("New page", "Create");
    setView("create");
    closeSidebar();
    newDocPath.focus();
  }

  function setSaveState(message) {
    saveState.textContent = message;
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
