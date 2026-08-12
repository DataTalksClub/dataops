export function createKnowledgeNavigation(context, services) {
  const {
    apiUrl,
    basename,
    beginDocumentNavigation,
    body,
    canLeaveCurrentDocument,
    closeSidebar,
    closeWorkBellPanel,
    cleanPath,
    docContextReturn,
    docMenuButton,
    documentPath,
    documentState,
    documentTitle,
    draftKey,
    editor,
    editorView,
    enterRenderedMode,
    getActiveTasksSection,
    getActiveWorkspaceView,
    historyAdapter,
    knowledgeState,
    locationAdapter,
    openBundlePanel,
    openTaskPanel,
    operationsViewPath,
    operationsViewTitle,
    quickNav,
    quickNavInput,
    quickNavResults,
    refreshChangesPanel,
    request,
    scheduleAnimationFrame,
    searchInput,
    setPageTitle,
    setSaveState,
    setStatus,
    setView,
    showOperationsHome,
    storage,
    titleFromMarkdown,
    updateGithubLink,
    updateSaveState,
    updateViewToggleAvailability,
  } = context;
  const {
    captureScrollPosition,
    filterDocuments,
    pushRecentlyViewed,
    refreshDocuments,
    renderPinned,
    renderRecentlyViewed,
    renderTree,
    scrollPositions,
    updateCurrentTreeSelection,
    updatePinButton,
  } = services;

  let _quickNavIndex = 0;
  let _quickNavMatches = [];

  async function openDocument(path, options = {}) {
    if (!(await canLeaveCurrentDocument())) return;
    beginDocumentNavigation();
    captureScrollPosition();
    knowledgeState.docReturnContext = options.returnContext || null;
    renderDocReturnContext();

    documentTitle.disabled = true;
    editor.disabled = true;
    setSaveState("Loading...");
    setView("editor");
    setPageTitle(basename(path), path);
    documentPath.textContent = path;

    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      const payload = await request(url);

      documentState.currentDoc = { path: payload.path, updated: payload.updated };
      knowledgeState.currentTreePath = payload.path;
      if (options.updateUrl !== false) setDocumentUrl(payload.path);
      documentState.currentParsed = payload.parsed || null;
      documentState.currentWarnings = [];
      documentState.lastSavedContent = payload.content;
      docMenuButton.hidden = false;
      updateGithubLink();
      updatePinButton();
      pushRecentlyViewed(payload.path);
      renderRecentlyViewed();
      if (options.revealInTree) {
        renderTree(filterDocuments(knowledgeState.allDocuments), { revealCurrent: true });
      } else {
        updateCurrentTreeSelection();
      }

      const draft = storage.getItem(draftKey(payload.path));
      documentState.hasDraft = draft !== null;
      refreshChangesPanel();
      editor.value = draft ?? payload.content;
      editor.disabled = false;
      documentTitle.disabled = false;
      documentTitle.value =
        titleFromMarkdown(editor.value) || basename(payload.path);
      documentPath.textContent = payload.path;

      updateSaveState();
      setPageTitle(documentTitle.value, payload.path);
      renderDocReturnContext();
      updateViewToggleAvailability();
      // Default to the block view when the doc has parseable sections, so
      // SOPs read as structured content rather than raw markdown.
      enterRenderedMode();
      const restoreTop = scrollPositions.get(payload.path) || 0;
      const scrollEl =
        editorView.dataset.mode === "rendered" ? editorView : editor;
      if (scrollEl) {
        // Defer to next frame so layout has settled.
        scheduleAnimationFrame(() => {
          scrollEl.scrollTop = restoreTop;
        });
      }
    } catch (error) {
      setStatus(error.message);
      setSaveState("");
      documentTitle.disabled = !documentState.currentDoc;
      editor.disabled = !documentState.currentDoc;
    }
  }

  function renderDocReturnContext() {
    if (!docContextReturn) return;
    docContextReturn.replaceChildren();
    if (!knowledgeState.docReturnContext) {
      docContextReturn.hidden = true;
      return;
    }
    docContextReturn.hidden = false;
    const text = document.createElement("span");
    text.textContent =
      knowledgeState.docReturnContext.type === "workflow"
        ? `Opened from Card: ${knowledgeState.docReturnContext.title || knowledgeState.docReturnContext.id || "Card"}`
        : `Opened from task: ${knowledgeState.docReturnContext.title || knowledgeState.docReturnContext.id || "Task"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet-button";
    button.textContent =
      knowledgeState.docReturnContext.type === "workflow" ? "Back to Card" : "Back to Task";
    button.addEventListener("click", () => {
      const context = knowledgeState.docReturnContext;
      knowledgeState.docReturnContext = null;
      renderDocReturnContext();
      showOperationsHome().then(() => {
        if (context?.type === "workflow" && context.id)
          openBundlePanel(context.id);
        else if (context?.type === "task" && context.id)
          openTaskPanel(context.id);
      });
    });
    docContextReturn.append(text, button);
  }

  function localDocPathFromHref(href) {
    const value = String(href || "").trim();
    if (!value) return "";
    if (value.startsWith("content/") && value.endsWith(".md")) return value;
    if (value.startsWith("/content/") && value.endsWith(".md"))
      return value.replace(/^\/+/, "");
    try {
      const url = new URL(value, locationAdapter.origin);
      const path = decodeURIComponent(url.pathname || "").replace(/^\/+/, "");
      if (path.startsWith("content/") && path.endsWith(".md")) return path;
      if (path.endsWith(".md")) return `content/${path}`;
    } catch {}
    return "";
  }

  function docPathFromLocation() {
    const raw = decodeURIComponent(locationAdapter.pathname || "/").replace(
      /^\/+|\/+$/g,
      "",
    );
    if (!raw || raw === "login" || raw === "logout") return "";
    if (raw.startsWith("content/")) return raw;
    if (!raw.endsWith(".md")) return "";
    return `content/${raw}`;
  }

  function folderPathFromLocation() {
    const raw = decodeURIComponent(locationAdapter.pathname || "/").replace(
      /^\/+|\/+$/g,
      "",
    );
    if (!raw || raw === "login" || raw === "logout" || raw.endsWith(".md"))
      return "";
    return raw.replace(/^content\//, "");
  }

  function folderExists(path) {
    if (!path) return false;
    return knowledgeState.allDocuments.some((doc) => cleanPath(doc.path).startsWith(`${path}/`));
  }

  function setDocumentUrl(path) {
    const visible = "/" + path.replace(/^content\//, "");
    if (
      locationAdapter.pathname !== visible ||
      locationAdapter.search ||
      locationAdapter.hash
    ) {
      historyAdapter.pushState({ path }, "", visible);
    }
  }

  function setFolderUrl(path) {
    const visible = path ? `/${path}` : "/";
    if (
      locationAdapter.pathname !== visible ||
      locationAdapter.search ||
      locationAdapter.hash
    ) {
      historyAdapter.pushState({ folder: path }, "", visible);
    }
  }

  function openQuickNav() {
    quickNav.hidden = false;
    quickNavInput.value = "";
    _quickNavIndex = 0;
    updateQuickNavMatches("");
    quickNavInput.focus();
  }

  function closeQuickNav() {
    quickNav.hidden = true;
  }

  function updateQuickNavMatches(query) {
    const q = query.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/) : [];
    const scored = knowledgeState.allDocuments
      .map((doc) => {
        const hay = `${(doc.title || "").toLowerCase()} ${doc.path.toLowerCase()}`;
        if (!q) return { doc, score: 0 };
        let score = 0;
        for (const t of tokens) {
          const idx = hay.indexOf(t);
          if (idx === -1) return null;
          score -= idx; // earlier = better
          if ((doc.title || "").toLowerCase().includes(t)) score += 50;
        }
        return { doc, score };
      })
      .filter(Boolean);
    scored.sort(
      (a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path),
    );
    _quickNavMatches = scored.slice(0, 30).map((s) => s.doc);
    _quickNavIndex = 0;
    renderQuickNavResults();
  }

  function renderQuickNavResults() {
    if (_quickNavMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quick-nav-empty";
      empty.textContent = "No matches.";
      quickNavResults.replaceChildren(empty);
      return;
    }
    const rows = _quickNavMatches.map((doc, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "quick-nav-row" + (i === _quickNavIndex ? " is-active" : "");
      const title = document.createElement("span");
      title.className = "quick-nav-title";
      title.textContent = doc.title || basename(doc.path);
      const path = document.createElement("span");
      path.className = "quick-nav-path";
      path.textContent = doc.path;
      row.append(title, path);
      row.addEventListener("click", () => {
        closeQuickNav();
        openDocument(doc.path);
      });
      return row;
    });
    quickNavResults.replaceChildren(...rows);
    rows[_quickNavIndex]?.scrollIntoView({ block: "nearest" });
  }

  function handleQuickNavKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeQuickNav();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      _quickNavIndex = Math.min(
        _quickNavMatches.length - 1,
        _quickNavIndex + 1,
      );
      renderQuickNavResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      _quickNavIndex = Math.max(0, _quickNavIndex - 1);
      renderQuickNavResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = _quickNavMatches[_quickNavIndex];
      if (target) {
        closeQuickNav();
        openDocument(target.path);
      }
    }
  }

  function showLibrary(options = {}) {
    setView("library");
    if (options.updateUrl !== false) setFolderUrl(knowledgeState.selectedFolder);
    syncLibraryPageTitle();
    closeWorkBellPanel();
    closeSidebar();
  }

  function syncLibraryPageTitle() {
    if (body.dataset.view !== "library") return;
    if (!knowledgeState.selectedFolder && !searchInput.value.trim()) {
      setPageTitle(
        operationsViewTitle(getActiveWorkspaceView(), getActiveTasksSection()),
        getActiveWorkspaceView() === "home"
          ? "Home"
          : operationsViewPath(getActiveWorkspaceView()),
      );
      return;
    }
    setPageTitle("", "");
  }

  function clearSelection() {
    knowledgeState.selectedFolder = "";
    searchInput.value = "";
    setFolderUrl("");
    refreshDocuments();
  }

  return {
    clearSelection,
    closeQuickNav,
    docPathFromLocation,
    folderExists,
    folderPathFromLocation,
    handleQuickNavKeydown,
    localDocPathFromHref,
    openDocument,
    openQuickNav,
    setFolderUrl,
    showLibrary,
    syncLibraryPageTitle,
    updateQuickNavMatches,
  };
}
