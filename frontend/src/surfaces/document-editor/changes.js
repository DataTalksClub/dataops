export function createEditorChanges(context, services) {
  const {
    apiUrl, basename, changesCount, changesDiscardAll, changesList,
    changesSaveAll, changesSection, confirmDialog, docMenuButton,
    changesStatus, documentPath, documentState, documentTitle, editor,
    editorView,
    labelForPath, loadDocuments, openDocument, promptUser,
    refreshGitStatus: refreshGitStatusContext, reportError, request,
    setRouteTitle, setStatus, showLibrary, storage,
  } = context;
  const {
    draftKey, listDraftPaths, refreshGitStatus, refreshParsedFromApi, renderParsedDocument,
    showDiffForDraft, titleFromMarkdown, updateSaveState,
  } = services;

  let hideEmptyChangesTimer;

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
    if (!documentState.currentDoc) return;
    const oldPath = documentState.currentDoc.path;
    let newPath = promptUser("New path:", oldPath);
    if (!newPath) return;
    newPath = newPath.trim();
    if (newPath === oldPath) return;
    if (!newPath.startsWith("content/")) {
      setStatus("Path must start with content/");
      return;
    }
    try {
      const payload = await request(apiUrl("/docs/rename"), {
        method: "POST",
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
      });
      // Move any local draft over to the new key.
      const draft = storage.getItem(draftKey(oldPath));
      if (draft !== null) {
        storage.setItem(draftKey(newPath), draft);
        storage.removeItem(draftKey(oldPath));
      }
      documentState.currentDoc.path = payload.new_path;
      documentPath.textContent = payload.new_path;
      setRouteTitle(documentTitle.value);
      setStatus(`Renamed to ${payload.new_path}.`);
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (err) {
      reportError(`Rename failed: ${err.message}`);
    }
  }

  async function deleteCurrentDoc() {
    if (!documentState.currentDoc) return;
    const ok = await confirmDialog(
      `Delete ${documentState.currentDoc.path}? You can recover it from git if needed.`,
      { okText: "Delete", danger: true },
    );
    if (!ok) return;
    const path = documentState.currentDoc.path;
    try {
      await request(`${apiUrl("/docs")}?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
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
      setStatus(`Deleted ${path}.`);
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
      showLibrary();
    } catch (err) {
      reportError(`Delete failed: ${err.message}`);
    }
  }


  return {
    deleteCurrentDoc, discardAllDrafts, refreshChangesPanel,
    renameCurrentDoc, saveAllDrafts, showChangesStatus,
  };
}
