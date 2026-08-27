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
    refreshGitStatus: refreshGitStatusContext, request,
    setRouteTitle, showLibrary, storage,
  } = context;
  const {
    draftKey, listDraftPaths, refreshGitStatus, refreshParsedFromApi, renderParsedDocument,
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
        await request(url, {
          method: "PUT",
          body: JSON.stringify({ content: draft }),
        });
        storage.removeItem(draftKey(path));
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
    refreshGitStatus();
  }

  async function discardAllDrafts() {
    const paths = listDraftPaths();
    if (paths.length === 0) return;
    const ok = await confirmDialog(
      `Discard ${paths.length} unsaved draft${paths.length === 1 ? "" : "s"}?`,
      { okText: "Discard all", danger: true },
    );
    if (!ok) return;
    for (const path of paths) storage.removeItem(draftKey(path));
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
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
      });
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
      // Move any local draft over to the new key.
      const draft = storage.getItem(draftKey(oldPath));
      if (draft !== null) {
        storage.setItem(draftKey(newPath), draft);
        storage.removeItem(draftKey(oldPath));
      }
      documentState.currentDoc.path = payload.new_path;
      documentPath.textContent = payload.new_path;
      setRouteTitle(documentTitle.value);
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
      if (!isFresh() || documentState.currentDoc?.path !== payload.new_path) return;
      showFeedback(`Renamed to ${payload.new_path}.`);
    } catch (err) {
      if (!isFresh() || documentState.currentDoc?.path !== oldPath) return;
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
        `Delete ${path}? You can recover it from git if needed.`,
        { okText: "Delete", danger: true },
      );
      if (!ok || !isFresh() || documentState.currentDoc?.path !== path) return;
      await request(`${apiUrl("/docs")}?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      storage.removeItem(draftKey(path));
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
      refreshGitStatus();
      await loadDocuments();
      if (!isFresh()) return;
      showLibrary();
      refreshChangesPanel({ keepVisibleAfterAction: true });
      showChangesStatus(`Deleted ${path}.`);
    } catch (err) {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      showFeedback(`Delete failed: ${err.message}`, {
        kind: feedbackKindForError(err),
      });
    } finally {
      endDocumentMutation("delete");
    }
  }


  return {
    deleteCurrentDoc, discardAllDrafts, refreshChangesPanel,
    renameCurrentDoc, saveAllDrafts, showChangesStatus,
  };
}
