import {
  editorFeedbackFor,
  editorMutationGuard,
  feedbackKindForError,
} from "./feedback.js";

export function createEditorChanges(context, services) {
  const {
    apiUrl, basename, changesCount, changesDiscardAll, changesList,
    changesSaveAll, changesSection, confirmDialog, docMenuButton,
    changesStatus, documentPath, documentState, documentTitle, editor,
    editorView,
    labelForPath, loadDocuments, openDocument, promptUser,
    refreshKnowledgeStatus: refreshKnowledgeStatusContext, request,
    setRouteTitle, showLibrary, storage,
  } = context;
  const {
    draftKey, listDraftPaths, recordPublication, showRevisionConflict, refreshKnowledgeStatus, refreshParsedFromApi, renderParsedDocument,
    showDiffForDraft, titleFromMarkdown, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);

  let hideEmptyChangesTimer;
  let documentMutationPending = "";

  function beginDocumentMutation(name) {
    if (documentMutationPending) return false;
    documentMutationPending = name;
    docMenuButton.disabled = true;
    docMenuButton.setAttribute("aria-busy", "true");
    return true;
  }

  function endDocumentMutation(name) {
    if (documentMutationPending !== name) return;
    documentMutationPending = "";
    docMenuButton.disabled = false;
    docMenuButton.removeAttribute("aria-busy");
  }

  function clearHideEmptyChangesTimer() {
    if (hideEmptyChangesTimer) {
      clearTimeout(hideEmptyChangesTimer);
      hideEmptyChangesTimer = null;
    }
  }

  function showChangesStatus(message, { isError = false } = {}) {
    changesStatus.textContent = message;
    changesStatus.hidden = !message;
    changesStatus.classList.toggle("is-error", isError);
    changesStatus.dataset.feedbackState = message
      ? isError
        ? "error"
        : "success"
      : "idle";
    changesStatus.setAttribute("role", isError ? "alert" : "status");
    changesStatus.setAttribute("aria-live", isError ? "assertive" : "polite");
    changesStatus.setAttribute("aria-atomic", "true");
  }

  function scheduleEmptyChangesDismissal() {
    clearHideEmptyChangesTimer();
    hideEmptyChangesTimer = setTimeout(() => {
      hideEmptyChangesTimer = null;
      if (listDraftPaths().length === 0) {
        showChangesStatus("");
        changesSection.hidden = true;
      }
    }, 4000);
  }

  function refreshChangesPanel({ keepVisibleAfterAction = false } = {}) {
    const paths = listDraftPaths();
    const draftSet = new Set(paths);
    changesCount.textContent = String(paths.length);
    clearHideEmptyChangesTimer();
    if (paths.length === 0) {
      changesList.replaceChildren();
      if (keepVisibleAfterAction) {
        changesSection.hidden = false;
        scheduleEmptyChangesDismissal();
        return;
      }
      showChangesStatus("");
      changesSection.hidden = true;
      return;
    }
    showChangesStatus("");
    changesSection.hidden = false;
    const items = paths.map((path) => {
      const row = document.createElement("div");
      row.className = "changes-row-wrap";
      const button = document.createElement("button");
      button.className = "changes-row";
      button.type = "button";
      button.title = path;
      const label = document.createElement("span");
      label.className = "changes-row-label";
      label.textContent = labelForPath(path);
      const sub = document.createElement("span");
      sub.className = "changes-row-path";
      sub.textContent = path;
      button.append(label, sub);
      button.addEventListener("click", () => openDocument(path));
      row.append(button);
      const diff = document.createElement("button");
      diff.className = "changes-row-diff";
      diff.type = "button";
      diff.textContent = "Diff";
      diff.title = "Show diff vs saved";
      diff.addEventListener("click", (event) => {
        event.stopPropagation();
        showDiffForDraft(path);
      });
      row.append(diff);
      const drop = document.createElement("button");
      drop.className = "changes-row-diff";
      drop.type = "button";
      drop.textContent = "×";
      drop.title = "Discard this draft";
      drop.addEventListener("click", async (event) => {
        event.stopPropagation();
        const ok = await confirmDialog(`Discard the local draft for ${path}?`, {
          okText: "Discard",
          danger: true,
        });
        if (!ok) return;
        storage.removeItem(draftKey(path));
        storage.removeItem(`dtc-doc-base:${path}`);
        if (documentState.currentDoc && documentState.currentDoc.path === path) {
          documentState.hasDraft = false;
          editor.value = documentState.lastSavedContent;
          documentTitle.value =
            titleFromMarkdown(editor.value) || basename(documentState.currentDoc.path);
          updateSaveState();
          if (editorView.dataset.mode === "rendered") {
            await refreshParsedFromApi();
            renderParsedDocument();
          }
        }
        refreshChangesPanel({ keepVisibleAfterAction: true });
        showChangesStatus("Draft discarded.");
      });
      row.append(drop);
      return row;
    });
    changesList.replaceChildren(...items);
  }

  async function saveAllDrafts() {
    const paths = listDraftPaths();
    if (paths.length === 0) return;
    if (paths.length > 5) {
      const ok = await confirmDialog(
        `Save all ${paths.length} drafts? This writes ${paths.length} files at once.`,
        { okText: "Save all" },
      );
      if (!ok) return;
    }
    changesSaveAll.disabled = true;
    changesSaveAll.classList.add("is-busy");
    changesDiscardAll.disabled = true;
    showChangesStatus("Saving drafts…");
    let failed = 0;
    let savedCount = 0;
    for (const path of paths) {
      const draft = storage.getItem(draftKey(path));
      if (draft === null) continue;
      try {
        const url = apiUrl("/docs");
        url.searchParams.set("path", path);
        const expectedRevision = storage.getItem(`dtc-doc-base:${path}`);
        const result = await request(url, {
          method: "PUT",
          body: JSON.stringify({ content: draft, expectedRevision }),
        });
        recordPublication(expectedRevision, result.revision);
        storage.removeItem(draftKey(path));
        storage.removeItem(`dtc-doc-base:${path}`);
        savedCount += 1;
        if (documentState.currentDoc && documentState.currentDoc.path === path) {
          documentState.lastSavedContent = draft;
          documentState.hasDraft = false;
        }
      } catch (err) {
        failed += 1;
        console.warn(`Save failed for ${path}:`, err);
      }
    }
    refreshChangesPanel();
    if (documentState.currentDoc) updateSaveState();
    changesSaveAll.disabled = false;
    changesSaveAll.classList.remove("is-busy");
    changesDiscardAll.disabled = false;
    if (failed) {
      refreshChangesPanel({ keepVisibleAfterAction: true });
      showChangesStatus(`Saved ${savedCount}, ${failed} failed.`, {
        isError: true,
      });
    } else {
      refreshChangesPanel({
        keepVisibleAfterAction: savedCount > 0,
      });
      showChangesStatus(
        `Saved ${savedCount} document${savedCount === 1 ? "" : "s"}.`,
      );
    }
    await loadDocuments();
    refreshKnowledgeStatus();
  }

  async function discardAllDrafts() {
    const paths = listDraftPaths();
    if (paths.length === 0) return;
    const ok = await confirmDialog(
      `Discard ${paths.length} unsaved draft${paths.length === 1 ? "" : "s"}?`,
      { okText: "Discard all", danger: true },
    );
    if (!ok) return;
    for (const path of paths) {
      storage.removeItem(draftKey(path));
      storage.removeItem(`dtc-doc-base:${path}`);
    }
    if (documentState.currentDoc) {
      documentState.hasDraft = false;
      editor.value = documentState.lastSavedContent;
      documentTitle.value =
        titleFromMarkdown(editor.value) || basename(documentState.currentDoc.path);
      updateSaveState();
    }
    refreshChangesPanel({ keepVisibleAfterAction: true });
    showChangesStatus(
      `Discarded ${paths.length} draft${paths.length === 1 ? "" : "s"}.`,
    );
  }

  async function renameCurrentDoc() {
    if (!documentState.currentDoc || !beginDocumentMutation("rename")) return;
    const oldPath = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    try {
      let newPath = promptUser("New path:", oldPath);
      if (!newPath) return;
      newPath = newPath.trim();
      if (newPath === oldPath) return;
      if (!newPath.startsWith("content/")) {
        showFeedback("Path must start with content/", { kind: "validation" });
        return;
      }
      const payload = await request(apiUrl("/docs/rename"), {
        method: "POST",
        body: JSON.stringify({ old_path: oldPath, new_path: newPath, expectedRevision: documentState.currentDoc.revision }),
      });
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
      recordPublication(documentState.currentDoc.revision, payload.revision);
      // Move any local draft over to the new key.
      const draft = storage.getItem(draftKey(oldPath));
      if (draft !== null) {
        storage.setItem(draftKey(newPath), draft);
        const base = storage.getItem(`dtc-doc-base:${oldPath}`);
        if (base) storage.setItem(`dtc-doc-base:${newPath}`, base);
        storage.removeItem(`dtc-doc-base:${oldPath}`);
        storage.removeItem(draftKey(oldPath));
      }
      documentState.currentDoc.path = payload.new_path;
      documentPath.textContent = payload.new_path;
      setRouteTitle(documentTitle.value);
      refreshChangesPanel();
      refreshKnowledgeStatus();
      await loadDocuments();
      if (!isFresh() || documentState.currentDoc?.path !== payload.new_path) return;
      showFeedback(`Renamed to ${payload.new_path}.`);
    } catch (err) {
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
      if (err.status === 409) { showRevisionConflict(); return; }
      showFeedback(`Rename failed: ${err.message}`, {
        kind: feedbackKindForError(err),
      });
    } finally {
      endDocumentMutation("rename");
    }
  }

  async function deleteCurrentDoc() {
    if (!documentState.currentDoc || !beginDocumentMutation("delete")) return;
    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    try {
      const ok = await confirmDialog(
        `Delete ${path}? You can restore an older version from File history.`,
        { okText: "Delete", danger: true },
      );
      if (!ok || !isFresh() || documentState.currentDoc?.path !== path) return;
      const payload = await request(`${apiUrl("/docs")}?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: documentState.currentDoc.revision }),
      });
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      recordPublication(documentState.currentDoc.revision, payload.revision);
      storage.removeItem(draftKey(path));
      storage.removeItem(`dtc-doc-base:${path}`);
      documentState.currentDoc = null;
      documentState.currentParsed = null;
      documentState.lastSavedContent = "";
      documentState.hasDraft = false;
      docMenuButton.hidden = true;
      documentTitle.value = "";
      documentTitle.disabled = true;
      editor.value = "";
      editor.disabled = true;
      refreshChangesPanel();
      refreshKnowledgeStatus();
      await loadDocuments();
      if (!isFresh()) return;
      showLibrary();
      refreshChangesPanel({ keepVisibleAfterAction: true });
      showChangesStatus(`Deleted ${path}.`);
    } catch (err) {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      if (err.status === 409) { showRevisionConflict(); return; }
      showFeedback(`Delete failed: ${err.message}`, {
        kind: feedbackKindForError(err),
      });
    } finally {
      endDocumentMutation("delete");
    }
  }

  function getDescendantIds(doc, allDocs) {
    const descendants = new Set();
    const queue = [doc.id, doc.path].filter(Boolean);
    while (queue.length > 0) {
      const parentRef = queue.shift();
      for (const d of allDocs) {
        if (
          (d.parent_id === parentRef || d.parent === parentRef) &&
          !descendants.has(d.id)
        ) {
          descendants.add(d.id);
          descendants.add(d.path);
          queue.push(d.id);
        }
      }
    }
    return descendants;
  }

  async function openMoveToDialog(doc) {
    const allDocs = context.knowledgeState?.allDocuments || [];
    const descendants = getDescendantIds(doc, allDocs);
    const candidates = [
      { id: "", title: "(Top-level / No parent)" },
      ...allDocs
        .filter((d) => d.id !== doc.id && d.path !== doc.path && !descendants.has(d.id))
        .map((d) => ({ id: d.id, title: d.title || basename(d.path) })),
    ];

    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "task-modal diff-modal doc-move-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Move document");

      const backdrop = document.createElement("div");
      backdrop.className = "task-modal-backdrop diff-backdrop";

      const panel = document.createElement("div");
      panel.className = "task-modal-panel diff-panel doc-move-panel";

      const header = document.createElement("header");
      header.className = "task-panel-header";
      const titleEl = document.createElement("strong");
      titleEl.textContent = `Move "${doc.title || basename(doc.path)}"`;
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "quiet-button";
      closeBtn.textContent = "Cancel";
      header.append(titleEl, closeBtn);

      const bodyEl = document.createElement("div");
      bodyEl.className = "task-panel-body doc-move-body";

      const label = document.createElement("label");
      label.className = "doc-move-label";
      label.textContent = "Select new parent page:";
      const select = document.createElement("select");
      select.className = "doc-move-select";
      candidates.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.title;
        if (doc.parent_id === c.id || doc.parent === c.id) {
          opt.selected = true;
        }
        select.append(opt);
      });
      label.append(select);
      bodyEl.append(label);

      const footer = document.createElement("div");
      footer.className = "doc-move-footer";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "quiet-button";
      cancelBtn.textContent = "Cancel";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "primary-button";
      confirmBtn.textContent = "Move page";
      footer.append(cancelBtn, confirmBtn);
      bodyEl.append(footer);

      panel.append(header, bodyEl);
      modal.append(backdrop, panel);
      document.body.append(modal);

      function cleanup(result) {
        modal.remove();
        resolve(result);
      }

      closeBtn.addEventListener("click", () => cleanup(undefined));
      cancelBtn.addEventListener("click", () => cleanup(undefined));
      backdrop.addEventListener("click", () => cleanup(undefined));
      confirmBtn.addEventListener("click", () => cleanup(select.value));
    });
  }

  async function moveCurrentDoc(targetParentId) {
    if (!documentState.currentDoc || !beginDocumentMutation("move")) return;
    const currentDoc = documentState.currentDoc;
    const oldPath = currentDoc.path;
    const isFresh = editorMutationGuard(context);

    try {
      let newParent = targetParentId;
      if (newParent === undefined) {
        newParent = await openMoveToDialog(currentDoc);
        if (newParent === undefined) return;
      }

      const payload = await request(apiUrl("/docs/move"), {
        method: "POST",
        body: JSON.stringify({
          path: oldPath,
          new_parent: newParent || null,
          expectedRevision: currentDoc.revision,
        }),
      });

      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
      recordPublication(currentDoc.revision, payload.revision);
      currentDoc.parent = payload.parent || undefined;
      currentDoc.parent_id = payload.parent || undefined;

      await loadDocuments();
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;

      const targetTitle = payload.parent
        ? (context.knowledgeState?.allDocuments?.find((d) => d.id === payload.parent)?.title || payload.parent)
        : "Top-level";
      showFeedback(`Moved to ${targetTitle}.`);
      if (editorView.dataset.mode === "rendered" && services.renderParsedDocument) {
        services.renderParsedDocument();
      }
    } catch (err) {
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
      if (err.status === 409) { showRevisionConflict(); return; }
      showFeedback(`Move failed: ${err.message}`, {
        kind: feedbackKindForError(err),
      });
    } finally {
      endDocumentMutation("move");
    }
  }

  async function createSubpage(parentDoc, initialTitle = "") {
    const parent = parentDoc || documentState.currentDoc;
    if (!parent) return;

    let title = initialTitle;
    if (!title) {
      title = (promptUser?.("Sub-page title:") || globalThis.prompt?.("Sub-page title:") || "").trim();
    }
    if (!title) return;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
    const parentPath = parent.path;
    const lastSlash = parentPath.lastIndexOf("/");
    const parentDir = lastSlash >= 0 ? parentPath.slice(0, lastSlash) : "content";
    const parentStem = (lastSlash >= 0 ? parentPath.slice(lastSlash + 1) : parentPath).replace(/\.md$/, "");
    let newPath = `${parentDir}/${parentStem}/${slug}.md`;

    const allDocs = context.knowledgeState?.allDocuments || [];
    let counter = 1;
    while (allDocs.some((d) => d.path === newPath)) {
      counter++;
      newPath = `${parentDir}/${parentStem}/${slug}-${counter}.md`;
    }

    try {
      showFeedback(`Creating sub-page "${title}"…`, { kind: "pending" });
      const payload = await request(apiUrl("/docs"), {
        method: "POST",
        body: JSON.stringify({
          path: newPath,
          title,
          doc_type: parent.doc_type || "doc",
          parent: parent.id || parent.path,
          scaffold: "minimal",
          absent: true,
          expectedRevision: parent.revision || "",
        }),
      });

      await loadDocuments();
      if (openDocument) {
        await openDocument(newPath);
      }
      showFeedback(`Created sub-page "${title}".`);
      return payload;
    } catch (err) {
      showFeedback(`Failed to create sub-page: ${err.message}`, {
        kind: feedbackKindForError(err),
      });
    }
  }

  return {
    createSubpage, deleteCurrentDoc, discardAllDrafts, moveCurrentDoc,
    openMoveToDialog, refreshChangesPanel, renameCurrentDoc, saveAllDrafts,
    showChangesStatus,
  };
}
