export function createKnowledgeTree(context, services) {
  const {
    basename,
    cleanPath,
    clearSelectionButton,
    docTree,
    documentList,
    documentRowTemplate,
    documentState,
    draftKey,
    editor,
    editorView,
    knowledgeState,
    libraryTitle,
    scheduleAnimationFrame,
    searchInput,
    setStatus,
    setView,
    storage,
  } = context;
  const {
    openDocument,
    openFolderMenu,
    refreshDocuments,
    scrollPositions,
    setFolderUrl,
    setHighlightedText,
    syncLibraryPageTitle,
  } = services;

  const LIST_LIMIT = 120;

  function renderDocuments(documents, title) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = title;
    const hasFilter = !!(knowledgeState.selectedFolder || searchInput.value.trim());
    clearSelectionButton.hidden = !hasFilter;

    if (documents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = searchInput.value.trim()
        ? "No documents match your search."
        : knowledgeState.selectedFolder
          ? "No documents in this folder yet."
          : "No documents yet. Create your first page from the sidebar.";
      documentList.replaceChildren(empty);
      return;
    }

    const rows = documents.slice(0, LIST_LIMIT).map(renderDocumentRow);
    if (documents.length > LIST_LIMIT) {
      const more = document.createElement("div");
      more.className = "list-more";
      more.textContent = `Showing ${LIST_LIMIT} of ${documents.length}. Refine your search to see more.`;
      rows.push(more);
    }
    documentList.replaceChildren(...rows);
  }

  function renderDocumentRow(doc) {
    const row = documentRowTemplate.content.firstElementChild.cloneNode(true);
    const query = searchInput.value.trim();
    setHighlightedText(
      row.querySelector("h3"),
      doc.title || basename(doc.path),
      query,
    );
    setHighlightedText(
      row.querySelector("p"),
      doc.description || doc.summary || "No summary yet.",
      query,
    );
    row.querySelector(".doc-path").textContent = doc.path;
    row.querySelector(".doc-domain").textContent = doc.domain || "docs";
    row.querySelector(".doc-type").textContent = doc.doc_type || "doc";

    row.addEventListener("click", () => openDocument(doc.path));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDocument(doc.path);
      }
    });

    return row;
  }

  function renderTree(documents, options = {}) {
    const filter = searchInput.value.trim().toLowerCase();
    if (filter) {
      const matches = documents
        .filter((d) => {
          const hay = `${(d.title || "").toLowerCase()} ${d.path.toLowerCase()}`;
          return hay.includes(filter);
        })
        .slice(0, 50);
      const wrap = document.createElement("div");
      wrap.className = "tree-children";
      for (const doc of matches) wrap.append(renderTreeFile(doc));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-filter-empty";
        empty.textContent = "No matching pages.";
        wrap.append(empty);
      }
      docTree.replaceChildren(wrap);
      return;
    }
    docTree.replaceChildren(renderTreeChildren(buildTree(documents), ""));
    if (options.revealCurrent) scrollCurrentTreeFileIntoView();
  }

  function buildTree(documents) {
    const root = { folders: new Map(), files: [] };

    for (const doc of documents) {
      const parts = cleanPath(doc.path).split("/");
      let node = root;

      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) {
          node.folders.set(part, { folders: new Map(), files: [] });
        }
        node = node.folders.get(part);
      }

      node.files.push(doc);
    }

    return root;
  }

  function renderTreeChildren(node, path) {
    const list = document.createElement("div");
    list.className = "tree-children";

    for (const [folderName, child] of [...node.folders.entries()].sort()) {
      const folderPath = path ? `${path}/${folderName}` : folderName;
      list.append(renderFolder(folderName, folderPath, child));
    }

    for (const doc of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      list.append(renderTreeFile(doc));
    }

    return list;
  }

  function renderFolder(name, path, node) {
    const details = document.createElement("details");
    details.className = "tree-folder";
    const startOpen = isFolderOpen(path) || isCurrentDocFolder(path);
    details.open = startOpen;

    const summary = document.createElement("summary");
    summary.classList.toggle("is-selected", knowledgeState.selectedFolder === path);

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = name;
    summary.append(chevron, label);

    summary.addEventListener("click", (event) => {
      if (event.target.closest(".chevron")) {
        // Let <details> handle expand/collapse from the disclosure control.
        return;
      }
      event.preventDefault();
      knowledgeState.selectedFolder = path;
      searchInput.value = "";
      details.open = true;
      hydrate();
      setFolderUrl(path);
      setView("library");
      syncLibraryPageTitle();
      refreshDocuments();
    });

    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "tree-folder-menu";
    menu.title = "Folder actions";
    menu.textContent = "⋯";
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openFolderMenu(menu, path);
    });
    summary.append(menu);

    details.append(summary);

    // Lazy: only build children DOM the first time the folder is opened.
    let hydrated = false;
    const childrenSlot = document.createElement("div");
    childrenSlot.className = "tree-children-slot";
    details.append(childrenSlot);

    const hydrate = () => {
      if (hydrated) return;
      hydrated = true;
      childrenSlot.replaceWith(renderTreeChildren(node, path));
    };

    if (startOpen) hydrate();
    details.addEventListener("toggle", () => {
      if (details.open) hydrate();
    });

    return details;
  }

  function renderTreeFile(doc) {
    const button = document.createElement("button");
    button.className = "tree-file";
    button.type = "button";
    button.dataset.path = doc.path;
    button.classList.toggle("is-current", doc.path === knowledgeState.currentTreePath);
    const label = document.createElement("span");
    label.className = "tree-file-label";
    label.textContent = doc.title || basename(doc.path);
    button.append(label);
    if (storage.getItem(draftKey(doc.path)) !== null) {
      button.classList.add("has-draft");
      const dot = document.createElement("span");
      dot.className = "tree-file-dot";
      dot.title = "Unsaved local draft";
      button.append(dot);
    }
    if (typeof doc.updated === "number") {
      button.title = `Last saved ${relativeTime(doc.updated)}`;
    }
    button.addEventListener("click", () => openDocument(doc.path));
    return button;
  }

  function rebuildDocumentIdMap() {
    knowledgeState.documentIdMap = new Map();
    for (const doc of knowledgeState.allDocuments) {
      if (doc.id) knowledgeState.documentIdMap.set(String(doc.id), doc);
      if (Array.isArray(doc.aliases)) {
        for (const alias of doc.aliases) {
          if (alias) knowledgeState.documentIdMap.set(String(alias), doc);
        }
      }
      knowledgeState.documentIdMap.set(doc.path, doc);
      knowledgeState.documentIdMap.set(cleanPath(doc.path), doc);
    }
  }

  function resolveDocReference(ref) {
    const key = String(ref || "").trim();
    if (!key) return null;
    return (
      knowledgeState.documentIdMap.get(key) || knowledgeState.documentIdMap.get(key.replace(/^\/+/, "")) || null
    );
  }

  function relativeTime(epoch) {
    const now = Date.now() / 1000;
    const diff = Math.max(0, now - epoch);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
    const d = new Date(epoch * 1000);
    return d.toLocaleDateString();
  }

  function isFolderOpen(path) {
    if (!knowledgeState.selectedFolder) return false;
    return knowledgeState.selectedFolder === path || knowledgeState.selectedFolder.startsWith(`${path}/`);
  }

  function isCurrentDocFolder(path) {
    if (!knowledgeState.currentTreePath) return false;
    return cleanPath(knowledgeState.currentTreePath).startsWith(`${path}/`);
  }

  function scrollCurrentTreeFileIntoView() {
    scheduleAnimationFrame(() => {
      const current = docTree.querySelector(".tree-file.is-current");
      if (current) current.scrollIntoView({ block: "center" });
    });
  }

  function updateCurrentTreeSelection() {
    for (const btn of docTree.querySelectorAll(".tree-file")) {
      btn.classList.toggle("is-current", btn.dataset.path === knowledgeState.currentTreePath);
    }
  }

  function captureScrollPosition() {
    if (!documentState.currentDoc) return;
    const scrollEl = editorView.dataset.mode === "rendered" ? editorView : editor;
    if (scrollEl) {
      scrollPositions.set(
        documentState.currentDoc.path,
        scrollEl.scrollTop || 0,
      );
    }
  }


  return {
    captureScrollPosition,
    rebuildDocumentIdMap,
    relativeTime,
    renderDocuments,
    renderTree,
    resolveDocReference,
    updateCurrentTreeSelection,
  };
}
