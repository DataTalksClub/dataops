export function createKnowledgeMenus(context, services) {
  const {
    apiUrl,
    confirmDialog,
    deleteCurrentDoc,
    diffBody,
    diffClose,
    diffModal,
    diffTitle,
    docMenuButton,
    documentPath,
    documentState,
    documentTitle,
    draftKey,
    editor,
    emptyNote,
    knowledgeState,
    listDraftPaths,
    promptUser,
    refreshChangesPanel,
    refreshGitStatus,
    renameCurrentDoc,
    reportError,
    request,
    setPageTitle,
    setStatus,
    storage,
    viewportWidth,
  } = context;
  const { loadDocuments, showLibrary } = services;

  function openFolderMenu(anchorEl, folderPath) {
    const existing = document.querySelector(".doc-menu-popover");
    if (existing) {
      existing.remove();
      return;
    }
    const popover = document.createElement("div");
    popover.className = "doc-menu-popover";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "doc-menu-item";
    renameBtn.textContent = "Rename…";
    renameBtn.addEventListener("click", () => {
      popover.remove();
      renameFolder(folderPath);
    });
    popover.append(renameBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "doc-menu-item is-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      popover.remove();
      deleteFolder(folderPath);
    });
    popover.append(delBtn);

    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${rect.left}px`;
    document.body.append(popover);

    const close = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== anchorEl) {
        popover.remove();
        document.removeEventListener("click", close, true);
      }
    };
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }

  async function renameFolder(folderPath) {
    const fullOld = `content/${folderPath}`;
    let fullNew = promptUser("New folder path:", fullOld);
    if (!fullNew) return;
    fullNew = fullNew.trim();
    if (fullNew === fullOld) return;
    if (!fullNew.startsWith("content/")) {
      setStatus("Folder path must start with content/");
      return;
    }
    try {
      const payload = await request(apiUrl("/folders/rename"), {
        method: "POST",
        body: JSON.stringify({ old_path: fullOld, new_path: fullNew }),
      });
      // Rewrite any open doc + drafts under the renamed prefix.
      const oldPrefix = `${payload.old_path}/`;
      const newPrefix = `${payload.new_path}/`;
      if (documentState.currentDoc && documentState.currentDoc.path.startsWith(oldPrefix)) {
        documentState.currentDoc.path = newPrefix + documentState.currentDoc.path.slice(oldPrefix.length);
        documentPath.textContent = documentState.currentDoc.path;
        setPageTitle(documentTitle.value, documentState.currentDoc.path);
      }
      const drafts = listDraftPaths();
      for (const p of drafts) {
        if (p.startsWith(oldPrefix)) {
          const newPath = newPrefix + p.slice(oldPrefix.length);
          storage.setItem(
            draftKey(newPath),
            storage.getItem(draftKey(p)),
          );
          storage.removeItem(draftKey(p));
        }
      }
      knowledgeState.selectedFolder = "";
      setStatus(`Renamed ${payload.old_path} → ${payload.new_path}`);
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (err) {
      reportError(`Rename failed: ${err.message}`);
    }
  }

  async function deleteFolder(folderPath) {
    const fullPath = `content/${folderPath}`;
    const fileCount = knowledgeState.allDocuments.filter((d) =>
      d.path.startsWith(fullPath + "/"),
    ).length;
    const ok = await confirmDialog(
      `Delete ${fullPath} and its ${fileCount} doc${fileCount === 1 ? "" : "s"}? You can recover it from git if needed.`,
      { okText: "Delete", danger: true },
    );
    if (!ok) return;
    try {
      const payload = await request(
        `${apiUrl("/folders")}?path=${encodeURIComponent(fullPath)}`,
        { method: "DELETE" },
      );
      const prefix = `${payload.deleted}/`;
      if (
        documentState.currentDoc &&
        (documentState.currentDoc.path === payload.deleted ||
          documentState.currentDoc.path.startsWith(prefix))
      ) {
        documentState.currentDoc = null;
        documentState.currentParsed = null;
        documentState.lastSavedContent = "";
        documentState.hasDraft = false;
        docMenuButton.hidden = true;
        documentTitle.value = "";
        documentTitle.disabled = true;
        editor.value = "";
        editor.disabled = true;
        showLibrary();
      }
      // Clean drafts under the prefix.
      for (const p of listDraftPaths()) {
        if (p === payload.deleted || p.startsWith(prefix)) {
          storage.removeItem(draftKey(p));
        }
      }
      if (knowledgeState.selectedFolder.startsWith(folderPath)) knowledgeState.selectedFolder = "";
      setStatus(
        `Deleted ${payload.deleted} (${payload.files} file${payload.files === 1 ? "" : "s"}).`,
      );
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (err) {
      reportError(`Delete failed: ${err.message}`);
    }
  }

  // ---------- Doc actions menu ----------

  function openDocMenu(event) {
    if (!documentState.currentDoc) return;
    const existing = document.querySelector(".doc-menu-popover");
    if (existing) {
      existing.remove();
      return;
    }
    const popover = document.createElement("div");
    popover.className = "doc-menu-popover";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "doc-menu-item";
    renameBtn.textContent = "Rename…";
    renameBtn.addEventListener("click", () => {
      popover.remove();
      renameCurrentDoc();
    });
    popover.append(renameBtn);

    const historyBtn = document.createElement("button");
    historyBtn.type = "button";
    historyBtn.className = "doc-menu-item";
    historyBtn.textContent = "History";
    historyBtn.addEventListener("click", () => {
      popover.remove();
      showDocHistory(documentState.currentDoc.path);
    });
    popover.append(historyBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "doc-menu-item is-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      popover.remove();
      deleteCurrentDoc();
    });
    popover.append(delBtn);

    const rect = docMenuButton.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${viewportWidth() - rect.right}px`;
    document.body.append(popover);

    const closeOnOutside = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== docMenuButton) {
        popover.remove();
        document.removeEventListener("click", closeOnOutside, true);
      }
    };
    // Defer attaching so the current click doesn't immediately close it.
    setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
  }

  async function showDocHistory(path) {
    diffTitle.textContent = `History · ${path}`;
    diffBody.replaceChildren();
    diffBody.append(emptyNote("Loading…"));
    diffModal.hidden = false;
    diffClose?.focus?.();
    try {
      const url = apiUrl("/git/log");
      url.searchParams.set("path", path);
      const payload = await request(url);
      const commits = payload.commits || [];
      if (commits.length === 0) {
        diffBody.replaceChildren(emptyNote("No commits found."));
        return;
      }
      const rows = commits.map((c) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-ctx";
        row.textContent = `${c.sha}  ${c.date}  ${c.author}  ${c.subject}`;
        return row;
      });
      diffBody.replaceChildren(...rows);
    } catch (err) {
      diffBody.replaceChildren(emptyNote(`History failed: ${err.message}`));
    }
  }


  return { openDocMenu, openFolderMenu };
}
