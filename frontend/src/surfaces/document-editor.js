export function createDocumentEditor(context) {
  const {
    beginDocumentNavigation,
    apiUrl,
    basename,
    body,
    canLeaveCurrentDocument,
    changesCount,
    changesDiscardAll,
    changesList,
    changesSaveAll,
    changesSection,
    cleanPath,
    closeSidebar,
    closeWorkBellPanel,
    confirmDialog,
    diffBody,
    diffModal,
    diffTitle,
    discardButton,
    docMenuButton,
    docTree,
    documentPath,
    documentState,
    documentTitle,
    domainFilter,
    editor,
    editorView,
    escapeHtml,
    gitCommitButton,
    gitCommitCancel,
    gitCommitFiles,
    gitCommitMessage,
    gitCommitModal,
    gitCommitSubmit,
    gitPullButton,
    gitResult,
    gitSection,
    gitStatusText,
    knowledgeState,
    labelForPath,
    lightbox,
    lightboxCaption,
    lightboxImg,
    lintModal,
    lintModalBody,
    lintOpenButton,
    lintSummary,
    loadDocuments,
    newDocPath,
    newDocForm,
    newDocSummary,
    newDocTitle,
    newDocType,
    openDocument,
    operationsViewPath,
    operationsViewTitle,
    fetchBacklinksForCurrentDoc,
    refreshDocuments,
    renderGithubRawFooter,
    renderLoomBlock,
    renderRelatedDocsBlock,
    renderWarningsBlock,
    renderedView,
    reportError,
    request,
    resetBundlePanel,
    resetTaskPanel,
    resolveDocReference,
    resolveMarkdownDocLink,
    saveButton,
    saveState,
    searchInput,
    setFolderUrl,
    setPageTitle,
    setStatus,
    setView,
    showLibrary,
    showUndoToast,
    systemFilter,
    tagFilter,
    typeFilter,
    updateCustomSelect,
    updateFilterSummary,
    viewToggleButton,
    visibleDocUrl,
    showErrorToast,
    scheduleAnimationFrame,
    storage,
    promptUser
  } = context;

  const DRAFT_PREFIX = "dtc-doc-draft:";
  let _githubBase = "";
  let _gitBranch = "main";
  let _dragStep = null;
  let _lastFocusedStep = null;
  let _lastFocusedProcedure = null;
  let _dragGroup = null;
  let _dragProse = null;
  let _dragShot = null;
  const DOC_TYPES = [
  "sop",
  "checklist",
  "template",
  "reference",
  "playbook",
  "prompt",
];
  const STEP_ACTIONS = [
  "navigate",
  "click",
  "type",
  "upload",
  "download",
  "copy",
  "paste",
  "submit",
  "verify",
  "wait",
  "other",
];

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

  function refreshChangesPanel() {
    const paths = listDraftPaths();
    const draftSet = new Set(paths);
    // Sync the per-file dot in the doc tree.
    for (const btn of docTree.querySelectorAll(".tree-file")) {
      const path = btn.dataset.path;
      const has = draftSet.has(path);
      if (has !== btn.classList.contains("has-draft")) {
        btn.classList.toggle("has-draft", has);
        const existing = btn.querySelector(".tree-file-dot");
        if (has && !existing) {
          const dot = document.createElement("span");
          dot.className = "tree-file-dot";
          dot.title = "Unsaved local draft";
          btn.append(dot);
        } else if (!has && existing) {
          existing.remove();
        }
      }
    }
    changesCount.textContent = String(paths.length);
    if (paths.length === 0) {
      changesSection.hidden = true;
      changesList.replaceChildren();
      return;
    }
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
        refreshChangesPanel();
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
    setStatus(
      failed
        ? `Saved ${savedCount}, ${failed} failed.`
        : `Saved ${savedCount} document${savedCount === 1 ? "" : "s"}.`,
    );
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
    refreshChangesPanel();
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
      setPageTitle(documentTitle.value, payload.new_path);
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

  async function refreshGitStatus() {
    try {
      const url = apiUrl("/git/status");
      const payload = await request(url);
      if (!payload.ok) {
        setGitState({
          ok: false,
          message: payload.error || "Git not available",
          count: 0,
        });
        return;
      }
      const count = payload.count || 0;
      const branch = payload.branch || "?";
      _githubBase = payload.github || "";
      _gitBranch = payload.branch || "main";
      updateGithubLink();
      setGitState({
        ok: true,
        count,
        message:
          count === 0
            ? `On ${branch} · nothing to commit`
            : `On ${branch} · ${count} file${count === 1 ? "" : "s"} changed`,
      });
    } catch (err) {
      setGitState({
        ok: false,
        message: err.message || "git endpoint unreachable",
        count: 0,
      });
    }
  }

  function updateGithubLink() {
    // GitHub URLs are used by the Git panel and API, but the main reading UI
    // intentionally avoids extra repository shortcuts.
  }

  function setGitState({ ok, count, message }) {
    gitSection.classList.toggle("git-ok", !!ok && count > 0);
    gitSection.classList.toggle("git-clean", !!ok && count === 0);
    gitSection.classList.toggle("git-unavailable", !ok);
    gitStatusText.textContent = message;
    gitCommitButton.disabled = !ok;
  }

  async function gitPull() {
    gitPullButton.classList.add("is-busy");
    showGitResult("Pulling…", null);
    try {
      const payload = await request(apiUrl("/git/pull"), { method: "POST" });
      if (payload.ok) {
        showGitResult(payload.stdout || "Up to date.", "success");
      } else {
        showGitResult(payload.stderr || "Pull failed", "error");
      }
    } catch (err) {
      showGitResult(`Pull failed: ${err.message}`, "error");
    } finally {
      gitPullButton.classList.remove("is-busy");
      refreshGitStatus();
      await loadDocuments();
    }
  }

  async function openCommitForm() {
    // Refresh first so the file list and default message are up to date.
    let payload;
    try {
      payload = await request(apiUrl("/git/status"));
    } catch (err) {
      showGitResult(`Failed to get status: ${err.message}`, "error");
      return;
    }
    if (!payload || !payload.ok) {
      showGitResult(payload?.error || "Git unavailable", "error");
      return;
    }
    const files = payload.files || [];
    gitResult.hidden = true;
    gitCommitSubmit.disabled = files.length === 0;
    gitCommitFiles.replaceChildren(
      ...(files.length
        ? files.map((f) => {
            const row = document.createElement("div");
            row.className = "git-commit-file";
            const status = document.createElement("span");
            status.className = `git-commit-file-status status-${(f.status || "?").trim().replace(/[^A-Za-z]/g, "") || "u"}`;
            status.textContent = f.status || "?";
            const path = document.createElement("span");
            path.className = "git-commit-file-path";
            path.textContent = f.path;
            row.append(status, path);
            return row;
          })
        : [emptyNote("No changed files.")]),
    );
    gitCommitMessage.value = files.length ? defaultCommitMessage(files) : "";
    gitCommitModal.hidden = false;
    if (files.length) {
      gitCommitMessage.focus();
      gitCommitMessage.select();
    }
  }

  function closeCommitForm() {
    gitCommitModal.hidden = true;
  }

  async function submitCommitForm(event) {
    event.preventDefault();
    const message = gitCommitMessage.value.trim();
    gitCommitSubmit.disabled = true;
    gitCommitSubmit.classList.add("is-busy");
    gitCommitCancel.disabled = true;
    showGitResult("Committing…", null);
    try {
      const payload = await request(apiUrl("/git/commit"), {
        method: "POST",
        body: JSON.stringify({ message: message || undefined, push: true }),
      });
      if (payload.ok && payload.committed) {
        showGitResult(
          payload.pushed
            ? `Committed and pushed · ${payload.message}`
            : `Committed locally · ${payload.message}`,
          "success",
        );
        closeCommitForm();
      } else if (payload.ok) {
        showGitResult(payload.reason || "Nothing to commit.", null);
      } else {
        const failedStep = (payload.steps || []).find((s) => s.exit !== 0);
        const detail = failedStep
          ? `${failedStep.step}: ${failedStep.stderr || failedStep.stdout}`
          : "see server logs";
        showGitResult(`Failed (${detail})`, "error");
      }
    } catch (err) {
      showGitResult(`Failed: ${err.message}`, "error");
    } finally {
      gitCommitSubmit.disabled = false;
      gitCommitSubmit.classList.remove("is-busy");
      gitCommitCancel.disabled = false;
      refreshGitStatus();
    }
  }

  function showGitResult(text, kind) {
    gitResult.classList.remove("git-result-error", "git-result-success");
    if (kind === "error") gitResult.classList.add("git-result-error");
    if (kind === "success") gitResult.classList.add("git-result-success");
    gitResult.textContent = text;
    gitResult.hidden = false;
  }

  function defaultCommitMessage(files) {
    const docFiles = files.filter(
      (f) => f.path.startsWith("content/") && f.path.endsWith(".md"),
    );
    if (docFiles.length === 1) {
      const path = docFiles[0].path;
      return `Update ${path.split("/").pop().replace(/\.md$/, "").replaceAll("-", " ")}`;
    }
    if (docFiles.length > 1) {
      return `Update ${docFiles.length} docs`;
    }
    return `Update ${files.length} file${files.length === 1 ? "" : "s"}`;
  }

  // ---------- View toggle + rendered block view ----------
  
  function toggleViewMode() {
    if (!documentState.currentDoc) return;
    enterRenderedMode();
  }

  async function enterRenderedMode() {
    editorView.dataset.mode = "rendered";
    viewToggleButton.hidden = true;
    // If the user edited in raw mode without saving, re-parse the current
    // textarea content so the block view reflects the latest draft.
    if (documentState.currentDoc && editor.value && editor.value !== documentState.lastSavedContent) {
      await reparseEditorContent();
    }
    renderParsedDocument();
  }

  async function reparseEditorContent() {
    try {
      const payload = await request(apiUrl("/parse"), {
        method: "POST",
        body: JSON.stringify({ content: editor.value }),
      });
      if (payload.parsed) documentState.currentParsed = payload.parsed;
    } catch {}
  }

  function exitRenderedMode() {
    editorView.dataset.mode = "raw";
    viewToggleButton.hidden = true;
    renderedView.replaceChildren();
    resizeDocumentTitle();
  }

  function updateViewToggleAvailability() {
    // Show the toggle for any open doc — structured SOPs render as blocks,
    // others render the full body as plain markdown.
    const available = !!documentState.currentDoc;
    viewToggleButton.hidden = true;
    if (available && editorView.dataset.mode !== "rendered") enterRenderedMode();
  }

  async function refreshParsedFromApi() {
    if (!documentState.currentDoc) return;
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", documentState.currentDoc.path);
      const payload = await request(url);
      documentState.currentParsed = payload.parsed || null;
      updateViewToggleAvailability();
    } catch {
      documentState.currentParsed = null;
    }
  }

  function renderParsedDocument() {
    const sections = (documentState.currentParsed && documentState.currentParsed.sections) || {};
    const blocks = [];
    const fm = (documentState.currentParsed && documentState.currentParsed.frontmatter) || {};
    const loomBlock = renderLoomBlock(fm);
    blocks.push(renderTitleBlock(fm));
    blocks.push(renderFrontmatterBlock(fm));
    blocks.push(renderRelatedDocsBlock(fm));
    blocks.push(renderWarningsBlock());
    if (Object.keys(sections).length === 0) {
      // Plain markdown (template, reference, etc.) — render the body as one
      // big rendered block, no editing controls.
      const body = stripFrontmatter(editor.value || "");
      const wrap = document.createElement("div");
      wrap.className = "block-plain-body";
      wrap.append(renderMarkdown(stripLeadingHeading(body)));
      blocks.push(wrap);
      blocks.push(loomBlock);
      blocks.push(renderGithubRawFooter(_githubBase, _gitBranch));
      renderedView.replaceChildren(...blocks.filter(Boolean));
      return;
    }
  
    const order = [
      "summary",
      "prerequisites",
      "procedure",
      "validation",
      "troubleshooting",
      "references",
    ];
    const seen = new Set();
    for (const name of order) {
      if (sections[name]) {
        blocks.push(renderSectionBlock(name, sections[name]));
        seen.add(name);
      }
    }
    for (const [name, sec] of Object.entries(sections)) {
      if (seen.has(name)) continue;
      blocks.push(renderSectionBlock(name, sec));
    }
  
    const backlinksHost = document.createElement("section");
    backlinksHost.className = "block-backlinks";
    backlinksHost.id = "backlinks-host";
    blocks.push(backlinksHost);
    blocks.push(loomBlock);
    blocks.push(renderGithubRawFooter(_githubBase, _gitBranch));
  
    renderedView.replaceChildren(...blocks.filter(Boolean));
    // Async-fetch backlinks separately so the main render isn't blocked.
    fetchBacklinksForCurrentDoc();
  }

  function emptyNote(text) {
    const div = document.createElement("div");
    div.className = "rendered-empty";
    div.textContent = text;
    return div;
  }

  function renderTitleBlock(fm) {
    const wrap = document.createElement("div");
    wrap.className = "block-title-wrap";
    const h1 = document.createElement("h1");
    h1.className = "block-title";
    h1.textContent =
      fm.title || (documentState.currentDoc ? basename(documentState.currentDoc.path) : "Untitled");
    attachInlineEditor(h1, {
      getValue: () => fm.title || "",
      commit: (value) => applyTitleEdit(fm, value),
      restore: () => {
        h1.textContent =
          fm.title || (documentState.currentDoc ? basename(documentState.currentDoc.path) : "Untitled");
      },
      multiline: true,
      singleLine: true,
      autoSize: true,
      commitOnEnter: true,
      editorClass: "block-title-editor",
      showHint: false,
    });
    wrap.append(h1);
    const stats = computeDocStats();
    if (stats) {
      const meta = document.createElement("div");
      meta.className = "block-title-stats";
      meta.textContent = stats;
      wrap.append(meta);
    }
    return wrap;
  }

  function computeDocStats() {
    if (!documentState.currentParsed) return "";
    const proc = documentState.currentParsed.sections?.procedure;
    if (!proc || proc.raw) return "";
    let steps = 0;
    let groups = (proc.groups || []).length;
    let shots = 0;
    for (const g of proc.groups || []) {
      steps += (g.steps || []).length;
      for (const s of g.steps || []) shots += (s.screenshots || []).length;
    }
    for (const s of proc.flat_steps || []) {
      steps += 1;
      shots += (s.screenshots || []).length;
    }
    const parts = [];
    if (steps) parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
    if (groups) parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
    if (shots) parts.push(`${shots} screenshot${shots === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  function applyTitleEdit(fm, newTitle) {
    const title = newTitle.trim();
    if (!title) return;
    fm.title = title;
    // Update frontmatter scalar and body H1.
    let next = patchFrontmatterScalar(editor.value, "title", title, {
      quoted: true,
    });
    next = setMarkdownTitle(next, title);
    editor.value = next;
    if (documentState.currentDoc) {
      documentTitle.value = title;
      setPageTitle(title, documentState.currentDoc.path);
    }
    storeDraft();
    updateSaveState();
  }

  function renderFrontmatterBlock(fm) {
    if (!fm) fm = {};
    const wrap = document.createElement("div");
    wrap.className = "fm-block";
  
    const row = document.createElement("div");
    row.className = "fm-row";
  
    if (fm.doc_type) row.append(pill("type", fm.doc_type));
    if (Array.isArray(fm.systems)) {
      for (const s of fm.systems) row.append(pill("system", s));
    }
    if (Array.isArray(fm.tags)) {
      for (const t of fm.tags) row.append(pill("tag", t));
    }
  
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "fm-edit";
    editBtn.textContent = row.children.length ? "Edit" : "+ Metadata";
    editBtn.title = "Edit doc metadata";
    editBtn.addEventListener("click", () => toggleFrontmatterEditor(wrap, fm));
    row.append(editBtn);
  
    wrap.append(row);
    return wrap;
  }

  function toggleFrontmatterEditor(wrap, fm) {
    const existing = wrap.querySelector(".fm-editor");
    if (existing) {
      existing.remove();
      return;
    }
    const editor = document.createElement("form");
    editor.className = "fm-editor";
  
    const docTypeRow = makeAttrRow("Doc type");
    const sel = document.createElement("select");
    sel.innerHTML = DOC_TYPES.map(
      (t) =>
        `<option value="${t}"${t === fm.doc_type ? " selected" : ""}>${t}</option>`,
    ).join("");
    docTypeRow.append(sel);
    editor.append(docTypeRow);
  
    const summaryRow = makeAttrRow("Summary");
    const sumInput = document.createElement("textarea");
    sumInput.rows = 2;
    sumInput.value = fm.summary || "";
    summaryRow.append(sumInput);
    editor.append(summaryRow);
  
    const tagsRow = makeAttrRow("Tags");
    const tagsEditor = makeChipListEditor(
      Array.isArray(fm.tags) ? fm.tags.slice() : [],
    );
    tagsRow.append(tagsEditor.element);
    editor.append(tagsRow);
  
    const systemsRow = makeAttrRow("Systems");
    const systemsEditor = makeChipListEditor(
      Array.isArray(fm.systems) ? fm.systems.slice() : [],
    );
    systemsRow.append(systemsEditor.element);
    editor.append(systemsRow);
  
    const actionsRow = document.createElement("div");
    actionsRow.className = "block-step-attr-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => editor.remove());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "Apply";
    actionsRow.append(cancel, save);
    editor.append(actionsRow);
  
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const updates = {
        doc_type: sel.value,
        summary: sumInput.value.trim(),
        tags: tagsEditor.getValues(),
        systems: systemsEditor.getValues(),
      };
      applyFrontmatterEdit(fm, updates);
      editor.remove();
    });
  
    wrap.append(editor);
  }

  function makeChipListEditor(initial) {
    const wrap = document.createElement("div");
    wrap.className = "fm-chips-editor";
    const chips = [...initial];
  
    const render = () => {
      wrap.replaceChildren();
      for (let i = 0; i < chips.length; i++) {
        const chip = document.createElement("span");
        chip.className = "fm-chip";
        chip.textContent = chips[i];
        const x = document.createElement("button");
        x.type = "button";
        x.className = "fm-chip-x";
        x.textContent = "×";
        x.addEventListener("click", () => {
          chips.splice(i, 1);
          render();
        });
        chip.append(x);
        wrap.append(chip);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.className = "fm-chip-input";
      input.placeholder = "+ Add";
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          const v = input.value.trim().replace(/,$/, "");
          if (v) {
            chips.push(v);
            render();
            // Refocus the (new) input element.
            wrap.querySelector(".fm-chip-input")?.focus();
          }
        } else if (event.key === "Backspace" && !input.value && chips.length) {
          chips.pop();
          render();
          wrap.querySelector(".fm-chip-input")?.focus();
        }
      });
      wrap.append(input);
    };
    render();
    return { element: wrap, getValues: () => chips.slice() };
  }

  function applyFrontmatterEdit(fm, updates) {
    let next = editor.value;
    next = patchFrontmatterScalar(next, "doc_type", updates.doc_type);
    next = patchFrontmatterScalar(next, "summary", updates.summary, {
      quoted: true,
    });
    next = patchFrontmatterList(next, "tags", updates.tags);
    next = patchFrontmatterList(next, "systems", updates.systems);
    editor.value = next;
    if (documentState.currentParsed && documentState.currentParsed.frontmatter) {
      Object.assign(documentState.currentParsed.frontmatter, {
        doc_type: updates.doc_type,
        summary: updates.summary,
        tags: updates.tags,
        systems: updates.systems,
      });
    }
    storeDraft();
    updateSaveState();
    renderParsedDocument();
  }

  function _frontmatterRange(markdown) {
    if (!markdown.startsWith("---\n")) return null;
    const end = markdown.indexOf("\n---\n", 4);
    if (end === -1) return null;
    return { start: 4, end };
  }

  function patchFrontmatterScalar(markdown, key, value, options = {}) {
    const range = _frontmatterRange(markdown);
    if (!range) return markdown;
    const body = markdown.slice(range.start, range.end);
    const before = markdown.slice(0, range.start);
    const after = markdown.slice(range.end);
    const re = new RegExp(`^${escapeRegex(key)}:\\s*.*$`, "m");
    const formatted = options.quoted
      ? `${key}: "${(value || "").replace(/"/g, '\\"')}"`
      : `${key}: ${value}`;
    if (re.test(body)) {
      return before + body.replace(re, formatted) + after;
    }
    // Insert at end of frontmatter.
    const trimmed = body.endsWith("\n") ? body : body + "\n";
    return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
  }

  function patchFrontmatterList(markdown, key, items) {
    const range = _frontmatterRange(markdown);
    if (!range) return markdown;
    const before = markdown.slice(0, range.start);
    const body = markdown.slice(range.start, range.end);
    const after = markdown.slice(range.end);
  
    // Match either `key: [...]` inline OR `key:\n  - item\n  - item`.
    const blockRe = new RegExp(
      `^${escapeRegex(key)}:[\\t ]*(?:\\[[^\\]]*\\])?(?:\\n[\\t ]+-[^\\n]*)*`,
      "m",
    );
    const formatted =
      items && items.length
        ? `${key}:\n` +
          items.map((v) => `  - ${JSON.stringify(String(v))}`).join("\n")
        : `${key}: []`;
    if (blockRe.test(body)) {
      return before + body.replace(blockRe, formatted) + after;
    }
    const trimmed = body.endsWith("\n") ? body : body + "\n";
    return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
  }

  function pill(kind, text) {
    const span = document.createElement("span");
    span.className = `fm-pill fm-pill-${kind}`;
    span.textContent = text;
    return span;
  }

  function renderSectionBlock(name, section) {
    const block = document.createElement("section");
    block.className = "block-section";
    block.dataset.section = name;
  
    const header = document.createElement("header");
    header.className = "block-section-header";
    const label = document.createElement("span");
    label.className = "block-section-label";
    label.textContent = "Section";
    const title = document.createElement("h2");
    title.textContent =
      headingFromBody(section.body_md) || humanSectionName(name);
    attachInlineEditor(title, {
      getValue: () => headingFromBody(section.body_md) || humanSectionName(name),
      commit: (value) => applySectionHeadingEdit(name, section, value),
      restore: () => {
        title.textContent =
          headingFromBody(section.body_md) || humanSectionName(name);
      },
      multiline: false,
      editorClass: "block-section-title-editor",
    });
    header.append(label, title);
    block.append(header);
  
    const body = document.createElement("div");
    body.className = "block-section-body";
  
    if (name === "procedure" && section.raw === false) {
      appendProcedureChildren(body, section);
    } else if (section.raw === true) {
      body.append(renderMarkdown(section.body_md || ""));
      body.classList.add("is-raw");
      attachInlineEditor(body, {
        getValue: () => section.body_md || "",
        commit: (value) => applySectionBodyEdit(name, section, value, true),
        restore: () => {
          body.replaceChildren(renderMarkdown(section.body_md || ""));
          body.classList.add("is-raw");
        },
        multiline: true,
      });
    } else {
      body.append(renderMarkdown(stripLeadingHeading(section.body_md || "")));
      attachInlineEditor(body, {
        getValue: () => stripLeadingHeading(section.body_md || ""),
        commit: (value) => applySectionBodyEdit(name, section, value, false),
        restore: () =>
          body.replaceChildren(
            renderMarkdown(stripLeadingHeading(section.body_md || "")),
          ),
        multiline: true,
      });
    }
  
    block.append(body);
    return block;
  }

  function headingFromBody(bodyMd) {
    if (!bodyMd) return "";
    const m = bodyMd.match(/^##\s+(.+)$/m);
    return m ? m[1].trim() : "";
  }

  function applySectionHeadingEdit(name, section, newHeading) {
    const heading = newHeading.trim() || humanSectionName(name);
    const restOfBody = stripLeadingHeading(section.body_md || "");
    section.body_md = `## ${heading}\n\n${restOfBody}`.replace(/\n+$/, "");
    const updated = patchSectionInMarkdown(editor.value, name, section.body_md);
    if (updated == null) {
      setStatus(`Could not locate section ${name}; heading not saved.`);
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function applySectionBodyEdit(name, section, newBody, isRaw) {
    // Reconstruct the body_md for the section (with the visible heading on top
    // for non-raw sections; raw sections are opaque).
    let combined;
    if (isRaw) {
      combined = newBody;
    } else {
      const heading = `## ${humanSectionName(name)}`;
      const trimmed = newBody.replace(/^\n+/, "");
      combined = `${heading}\n\n${trimmed}`;
    }
    section.body_md = combined;
  
    const updated = patchSectionInMarkdown(editor.value, name, combined);
    if (updated == null) {
      setStatus(`Could not locate section ${name}; edit not saved.`);
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function humanSectionName(name) {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function appendProcedureChildren(container, procedure) {
    container.append(renderTodoBlock(procedure));
  
    const groups = Array.isArray(procedure.groups) ? procedure.groups : [];
    if (groups.length) {
      for (const g of groups) container.append(renderGroupBlock(g, procedure));
    } else {
      const flatSteps = Array.isArray(procedure.flat_steps)
        ? procedure.flat_steps
        : [];
      for (const s of flatSteps) container.append(renderStepBlock(s, procedure));
      container.append(makeAddStepButton(procedure, null));
    }
  
    const prose = Array.isArray(procedure.prose) ? procedure.prose : [];
    prose.forEach((p, idx) =>
      container.append(renderProseBlock(p, idx, procedure)),
    );
    container.append(makeAddProseButton(procedure));
  }

  function makeAddGroupButton(procedure) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step block-add-group";
    btn.textContent = "+ New group";
    btn.addEventListener("click", () => addGroup(procedure));
    return btn;
  }

  function makeAddProseButton(procedure) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step block-add-prose";
    btn.textContent = "+ New free-form block";
    btn.addEventListener("click", () => addProse(procedure));
    return btn;
  }

  function renderTodoBlock(procedure) {
    const todos = Array.isArray(procedure.todos) ? procedure.todos : [];
    const block = document.createElement("aside");
    block.className = "block-todos";
  
    const head = document.createElement("header");
    head.className = "block-todos-header";
    const heading = document.createElement("h3");
    heading.textContent = "TODO";
    head.append(heading);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "block-todo-add";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => {
      procedure.todos = procedure.todos || [];
      procedure.todos.push("Describe what's missing.");
      applyProcedureRewrite(procedure, null);
      // Open the inline editor for the new TODO.
      const items = renderedView.querySelectorAll(
        ".block-todos .block-todo-text",
      );
      items[items.length - 1]?.click();
    });
    head.append(addBtn);
    block.append(head);
  
    if (todos.length === 0) {
      block.classList.add("is-empty");
      const empty = document.createElement("div");
      empty.className = "block-todo-empty";
      empty.textContent = "No TODOs yet.";
      block.append(empty);
      return block;
    }
  
    const list = document.createElement("ul");
    todos.forEach((t, idx) => {
      const li = document.createElement("li");
      li.className = "block-todo-item";
      const text = document.createElement("span");
      text.className = "block-todo-text";
      text.textContent = t;
      attachInlineEditor(text, {
        getValue: () => procedure.todos[idx] || "",
        commit: (value) => applyTodoEdit(procedure, idx, value),
        restore: () => {
          text.textContent = procedure.todos[idx] || "";
        },
        multiline: false,
      });
      li.append(text);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "block-step-delete";
      del.title = "Delete TODO";
      del.setAttribute("aria-label", "Delete TODO");
      del.textContent = "×";
      del.addEventListener("click", () => deleteTodo(procedure, idx));
      li.append(del);
      list.append(li);
    });
    block.append(list);
    return block;
  }

  function applyTodoEdit(procedure, idx, newValue) {
    procedure.todos = procedure.todos || [];
    procedure.todos[idx] = newValue;
    applyProcedureRewrite(procedure, null);
  }

  function deleteTodo(procedure, idx) {
    const snapshot = snapshotProcedure(procedure);
    procedure.todos = (procedure.todos || []).filter((_, i) => i !== idx);
    applyProcedureRewrite(procedure, null);
    showUndoToast("TODO removed.", () => restoreProcedure(procedure, snapshot));
  }

  function makeProcedureToolbar(procedure) {
    const wrap = document.createElement("div");
    wrap.className = "block-procedure-toolbar";
    return wrap;
  }

  function wrapInGroup(procedure) {
    const steps = procedure.flat_steps || [];
    if (steps.length === 0) return;
    procedure.groups = [{ title: "Steps", steps }];
    procedure.flat_steps = [];
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function flattenSingleGroup(procedure) {
    const groups = procedure.groups || [];
    if (groups.length !== 1) return;
    procedure.flat_steps = groups[0].steps || [];
    procedure.groups = [];
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function makeAddStepButton(procedure, group) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-add-step";
    btn.textContent = "+ New step";
    btn.addEventListener("click", () => addStep(procedure, group));
    return btn;
  }

  function renderGroupBlock(group, procedure) {
    const block = document.createElement("section");
    block.className = "block-group";
  
    const header = document.createElement("header");
    header.className = "block-group-header";
    const text = document.createElement("div");
    text.className = "block-group-text";
    const title = document.createElement("h3");
    title.textContent = group.title || "";
    attachInlineEditor(title, {
      getValue: () => group.title || "",
      commit: (value) => applyGroupTitleEdit(group, value),
      restore: () => {
        title.textContent = group.title || "";
      },
      multiline: false,
      editorClass: "block-group-title-editor",
    });
    text.append(title);
    header.append(text);
    block.append(header);
  
    for (const s of group.steps || [])
      block.append(renderStepBlock(s, procedure));
    if (procedure) block.append(makeAddStepButton(procedure, group));
    return block;
  }

  function applyGroupTitleEdit(group, newTitle) {
    const oldTitle = group.title || "";
    if (newTitle === oldTitle) return;
    group.title = newTitle;
    const updated = patchGroupTitleInMarkdown(editor.value, oldTitle, newTitle);
    if (updated == null) {
      setStatus(`Could not locate group "${oldTitle}"; edit not saved.`);
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function renderStepBlock(step, procedure) {
    const block = document.createElement("article");
    block.className = "block-step";
    block.dataset.stepId = String(step.id);
    if (procedure) {
      block.addEventListener("dragover", (event) =>
        onStepDragOver(event, step, block, procedure),
      );
      block.addEventListener("dragleave", (event) =>
        onStepDragLeave(event, block),
      );
      block.addEventListener("drop", (event) =>
        onStepDrop(event, step, block, procedure),
      );
      block.addEventListener("focusin", () => {
        _lastFocusedStep = step;
        _lastFocusedProcedure = procedure;
      });
      block.addEventListener("click", () => {
        _lastFocusedStep = step;
        _lastFocusedProcedure = procedure;
      });
    }
  
    const header = document.createElement("header");
    header.className = "block-step-header";
  
    if (procedure) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag";
      handle.title = "Drag to reorder";
      handle.setAttribute("aria-label", "Drag step to reorder");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onStepDragStart(event, step, block, procedure),
      );
      handle.addEventListener("dragend", onStepDragEnd);
      header.append(handle);
    }
  
    const numChip = document.createElement("span");
    numChip.className = "block-step-num";
    numChip.textContent = String(step.rendered_number ?? step.id);
    header.append(numChip);
  
    const label = document.createElement("span");
    label.className = "block-step-label";
    label.textContent = "Step";
    header.append(label);
  
    const attrs = step.attrs || {};
    if (attrs.action) header.append(pill("action", attrs.action));
    if (attrs.tool) header.append(pill("tool", attrs.tool));
    if (Array.isArray(attrs.systems)) {
      for (const sys of attrs.systems) header.append(pill("system", sys));
    }
  
    for (const w of documentState.currentWarnings) {
      if (!w.startsWith(`step id=${step.id}:`)) continue;
      const chip = document.createElement("span");
      chip.className = "block-step-warning";
      chip.title = w;
      chip.textContent = "⚠";
      header.append(chip);
    }
  
    if (procedure) {
      const spacer = document.createElement("span");
      spacer.className = "block-step-spacer";
      header.append(spacer);
  
      const attrBtn = document.createElement("button");
      attrBtn.type = "button";
      attrBtn.className = "block-step-attr";
      attrBtn.title = "Edit step attributes";
      attrBtn.setAttribute("aria-label", "Edit step attributes");
      attrBtn.textContent = "⚙";
      attrBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleStepAttrEditor(block, step, procedure);
      });
      header.append(attrBtn);
  
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete step";
      delBtn.setAttribute("aria-label", "Delete step");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStep(procedure, step);
      });
      header.append(delBtn);
    }
  
    block.append(header);
  
    const body = document.createElement("div");
    body.className = "block-step-body";
    body.append(renderMarkdown(step.body_md || ""));
    attachInlineEditor(body, {
      getValue: () => (step.body_md || "").replace(/^ /, ""),
      commit: (value) => applyStepBodyEdit(step, value),
      restore: () => body.replaceChildren(renderMarkdown(step.body_md || "")),
      multiline: true,
    });
    block.append(body);
  
    const shots = Array.isArray(step.screenshots) ? step.screenshots : [];
    shots.forEach((shot, idx) =>
      block.append(renderScreenshot(shot, step, idx, procedure)),
    );
    for (const embed of extractVideoEmbeds(step.body_md || "")) {
      block.append(renderVideoEmbed(embed));
    }
    if (procedure) block.append(makeAddScreenshotButton(step, procedure));
    return block;
  }

  function extractVideoEmbeds(text) {
    const embeds = [];
    const seen = new Set();
    const urlRe = /\bhttps?:\/\/[^\s)\]]+/g;
    for (const match of text.matchAll(urlRe)) {
      const url = match[0].replace(/[.,;]+$/, "");
      if (seen.has(url)) continue;
      const e = toVideoEmbed(url);
      if (e) {
        seen.add(url);
        embeds.push(e);
      }
    }
    return embeds;
  }

  function toVideoEmbed(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\//, "");
        if (id)
          return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
      }
      if (u.hostname.endsWith("youtube.com") && u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        if (id)
          return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
      }
      if (u.hostname === "vimeo.com") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        if (id)
          return { src: `https://player.vimeo.com/video/${id}`, kind: "vimeo" };
      }
    } catch {}
    return null;
  }

  function renderVideoEmbed(embed) {
    const wrap = document.createElement("div");
    wrap.className = "block-video-embed";
    const iframe = document.createElement("iframe");
    iframe.src = embed.src;
    iframe.allow = "fullscreen; autoplay; encrypted-media";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    wrap.append(iframe);
    return wrap;
  }

  function makeAddScreenshotButton(step, procedure) {
    const wrap = document.createElement("div");
    wrap.className = "block-screenshot-add";
    const btn = document.createElement("label");
    btn.className = "block-add-step block-add-screenshot";
    btn.textContent = "+ Add screenshot";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      addScreenshot(step, procedure, file);
      input.value = "";
    });
    btn.append(input);
    wrap.append(btn);
    return wrap;
  }

  async function addScreenshot(step, procedure, file) {
    if (!documentState.currentDoc) return;
    setStatus("Uploading image…");
    const addBtn = renderedView.querySelector(
      `.block-step[data-step-id="${step.id}"] .block-add-screenshot`,
    );
    addBtn?.classList.add("is-busy");
    try {
      const data = await fileToBase64(file);
      const payload = await request(apiUrl("/images"), {
        method: "POST",
        body: JSON.stringify({
          doc_path: documentState.currentDoc.path,
          filename: file.name,
          data,
        }),
      });
      step.screenshots = step.screenshots || [];
      step.screenshots.push({ src: payload.path, alt: "", caption: "" });
      applyProcedureRewrite(procedure, null);
      setStatus(`Uploaded ${payload.absolute_path}`);
    } catch (err) {
      reportError(`Upload failed: ${err.message}`);
    } finally {
      addBtn?.classList.remove("is-busy");
    }
  }

  // ---------- Lint dashboard ----------
  
  async function openLintReport() {
    lintModal.hidden = false;
    lintOpenButton.classList.add("is-busy");
    lintModalBody.replaceChildren(emptyNote("Running lint…"));
    try {
      const payload = await request(apiUrl("/lint"));
      const docs = payload.docs || [];
      if (docs.length === 0) {
        lintModalBody.replaceChildren(
          emptyNote("No violations across the corpus 🎉"),
        );
        lintSummary.textContent = "clean";
        return;
      }
      const total = payload.total_violations || 0;
      lintSummary.textContent = `${docs.length} docs · ${total} violations`;
      const rows = docs.map((entry) => {
        const wrap = document.createElement("div");
        wrap.className = "lint-row";
        const heading = document.createElement("button");
        heading.type = "button";
        heading.className = "lint-row-path";
        heading.textContent = entry.path;
        heading.addEventListener("click", () => {
          lintModal.hidden = true;
          openDocument(entry.path);
        });
        wrap.append(heading);
        const list = document.createElement("ul");
        list.className = "lint-row-violations";
        for (const v of entry.violations) {
          const li = document.createElement("li");
          li.textContent = v;
          list.append(li);
        }
        wrap.append(list);
        return wrap;
      });
      lintModalBody.replaceChildren(...rows);
    } catch (err) {
      lintModalBody.replaceChildren(emptyNote(`Lint failed: ${err.message}`));
    } finally {
      lintOpenButton.classList.remove("is-busy");
    }
  }

  async function showDiffForDraft(path) {
    const draft = storage.getItem(draftKey(path)) ?? "";
    let saved = "";
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      const payload = await request(url);
      saved = payload.content || "";
    } catch (err) {
      saved = "";
    }
    diffTitle.textContent = path;
    diffBody.replaceChildren(...renderUnifiedDiff(saved, draft));
    diffModal.hidden = false;
  }

  function closeDiff() {
    diffModal.hidden = true;
  }

  function renderUnifiedDiff(a, b) {
    const aLines = a.split("\n");
    const bLines = b.split("\n");
    const lcs = lcsLengths(aLines, bLines);
    const ops = [];
    let i = aLines.length,
      j = bLines.length;
    while (i > 0 && j > 0) {
      if (aLines[i - 1] === bLines[j - 1]) {
        ops.push({ type: " ", line: aLines[i - 1] });
        i--;
        j--;
      } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
        ops.push({ type: "-", line: aLines[i - 1] });
        i--;
      } else {
        ops.push({ type: "+", line: bLines[j - 1] });
        j--;
      }
    }
    while (i > 0) {
      ops.push({ type: "-", line: aLines[i - 1] });
      i--;
    }
    while (j > 0) {
      ops.push({ type: "+", line: bLines[j - 1] });
      j--;
    }
    ops.reverse();
  
    const nodes = [];
    for (const op of ops) {
      const span = document.createElement("div");
      span.className =
        "diff-line diff-" +
        (op.type === "+" ? "add" : op.type === "-" ? "del" : "ctx");
      span.textContent = (op.type === " " ? "  " : op.type + " ") + op.line;
      nodes.push(span);
    }
    if (nodes.length === 0) {
      const span = document.createElement("div");
      span.className = "diff-line diff-ctx";
      span.textContent = "(no changes)";
      nodes.push(span);
    }
    return nodes;
  }

  function lcsLengths(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1] + 1
            : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp;
  }

  function openLightbox(src, caption) {
    lightboxImg.src = src;
    lightboxCaption.textContent = caption || "";
    lightboxCaption.hidden = !caption;
    lightbox.hidden = false;
  }

  function closeLightbox() {
    lightbox.hidden = true;
  }

  function handleClipboardPaste(event) {
    // Only intercept when we're in block view with a step focused or remembered.
    if (editorView.dataset.mode !== "rendered") return;
    if (!_lastFocusedStep || !_lastFocusedProcedure) return;
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && file.type.startsWith("image/")) {
        event.preventDefault();
        // Provide a default filename if the OS gave none.
        if (!file.name || file.name === "image.png") {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const ext = file.type.split("/")[1] || "png";
          Object.defineProperty(file, "name", { value: `paste-${ts}.${ext}` });
        }
        addScreenshot(_lastFocusedStep, _lastFocusedProcedure, file);
        return;
      }
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || "";
        const idx = String(result).indexOf(",");
        resolve(idx === -1 ? String(result) : String(result).slice(idx + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Generic click-to-edit helper. `el` becomes a textarea/input when clicked.
  // `getValue` returns the current value to seed the editor;
  // `commit(value)` is called with the new value when the user confirms;
  // `restore()` rebuilds the read-only view (called whether or not committed);
  // `options` controls multi-line vs single-line and the editor class.
  function attachInlineEditor(
    el,
    {
      getValue,
      commit,
      restore,
      multiline = true,
      singleLine = false,
      autoSize = false,
      commitOnEnter = false,
      editorClass,
      hintClass,
      hintText,
      showHint = true,
    },
  ) {
    el.tabIndex = 0;
    el.title = "Click to edit";
    el.classList.add("inline-editable");
    el.addEventListener("click", (event) => {
      if (event.target.closest("a, button, img, .inline-editor")) return;
      if (el.classList.contains("editing")) return;
      enter();
    });
    el.addEventListener("keydown", (event) => {
      if (event.target !== el) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        enter();
      }
    });
  
    function enter() {
      el.classList.add("editing");
      const original = getValue();
      const originalHeight = Math.ceil(el.getBoundingClientRect().height);
      const editor = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) editor.type = "text";
      editor.className = `inline-editor ${editorClass || ""}`.trim();
      editor.value = original;
      if (multiline) {
        editor.rows = Math.max(2, (editor.value.match(/\n/g) || []).length + 1);
      }
      if (autoSize) {
        editor.style.minHeight = `${originalHeight}px`;
        editor.style.overflow = "hidden";
      }
  
      const hint = document.createElement("div");
      hint.className = `inline-edit-hint ${hintClass || ""}`.trim();
      hint.textContent = showHint
        ? hintText ||
          (commitOnEnter
            ? "Enter to save · Esc to cancel"
            : multiline
              ? "Cmd/Ctrl+Enter to save · Esc to cancel"
              : "Enter to save · Esc to cancel")
        : "";
  
      if (showHint) el.replaceChildren(editor, hint);
      else el.replaceChildren(editor);
      if (autoSize) resizeInlineEditor(editor);
      editor.focus();
      if (multiline) {
        editor.setSelectionRange(editor.value.length, editor.value.length);
      } else {
        editor.select();
      }
  
      let done = false;
      const doCommit = () => {
        if (done) return;
        done = true;
        const newValue = singleLine
          ? editor.value.replace(/\s*\n+\s*/g, " ")
          : editor.value;
        el.classList.remove("editing");
        if (newValue !== original) commit(newValue);
        restore();
      };
      const doCancel = () => {
        if (done) return;
        done = true;
        el.classList.remove("editing");
        restore();
      };
  
      editor.addEventListener("blur", doCommit);
      if (autoSize) {
        editor.addEventListener("input", () => resizeInlineEditor(editor));
      }
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          doCancel();
        } else if (event.key === "Enter") {
          if (commitOnEnter && !event.shiftKey) {
            event.preventDefault();
            doCommit();
            return;
          }
          if (multiline && !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          doCommit();
        }
      });
    }
  }

  function resizeInlineEditor(editor) {
    editor.style.height = "auto";
    editor.style.height = `${editor.scrollHeight}px`;
  }

  function applyStepBodyEdit(step, newBody) {
    step.body_md = newBody;
    const updated = patchStepBodyInMarkdown(
      editor.value,
      step.id,
      newBody,
      step.rendered_number ?? step.id,
    );
    if (updated == null) {
      setStatus(
        `Could not locate step ${step.id} in raw markdown; edit not saved.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function patchStepBodyInMarkdown(markdown, stepId, newBodyMd, renderedNum) {
    const re = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(re);
    if (!match) return null;
    const openMarker = match[1];
    const inner = match[2];
    const closeMarker = match[3];
  
    // Split inner into "body lines" (before any screenshot block) and the
    // remaining screenshot/extra content. The screenshot block opens with a
    // `<!-- sop-screenshot-start -->` marker, indented or not.
    const screenshotIdx = inner.search(/^\s*<!--\s*sop-screenshot-start\s*-->/m);
    let tail = "";
    if (screenshotIdx !== -1) {
      tail = "\n" + inner.slice(screenshotIdx);
    }
  
    const formattedBody = formatStepBody(newBodyMd, renderedNum);
    const replaced = openMarker + formattedBody + tail + closeMarker;
    return markdown.replace(re, () => replaced);
  }

  function formatStepBody(bodyMd, renderedNum) {
    const lines = bodyMd.split("\n");
    if (lines.length === 0) return `${renderedNum}.  `;
    const first = lines[0];
    const rest = lines.slice(1);
    const out = [`${renderedNum}.  ${first}`];
    for (const line of rest) {
      if (!line.trim()) {
        out.push("");
        continue;
      }
      // Continuation lines need 4-space indent so GitHub keeps them inside the
      // numbered-list item.
      out.push(`    ${line}`);
    }
    return out.join("\n");
  }

  function onStepDragStart(event, step, blockEl, procedure) {
    _dragStep = { step, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    // Required for Firefox.
    try {
      event.dataTransfer.setData("text/plain", String(step.id));
    } catch {}
  }

  function onStepDragEnd() {
    if (_dragStep && _dragStep.blockEl)
      _dragStep.blockEl.classList.remove("is-dragging");
    _dragStep = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onStepDragOver(event, _step, blockEl, procedure) {
    // Detect a file drag from the OS.
    if (
      event.dataTransfer &&
      (event.dataTransfer.types || []).includes("Files")
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      blockEl.classList.add("drop-file");
      return;
    }
    if (!_dragStep || _dragStep.procedure !== procedure) return;
    if (_dragStep.blockEl === blockEl) return;
    // Reject mixing flat and grouped (spec disallows mixed procedures).
    const src = containerOfStep(procedure, _dragStep.step);
    const tgt = containerOfBlock(blockEl);
    if (!src || !tgt) return;
    if ((src === "flat") !== (tgt === "flat")) return;
  
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onStepDragLeave(event, blockEl) {
    // Only remove the indicator if we've left the block entirely.
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below", "drop-file");
    }
  }

  function onStepDrop(event, target, blockEl, procedure) {
    // File drop from OS?
    blockEl.classList.remove("drop-file");
    if (
      event.dataTransfer &&
      event.dataTransfer.files &&
      event.dataTransfer.files.length
    ) {
      event.preventDefault();
      for (const file of event.dataTransfer.files) {
        if (!file.type.startsWith("image/")) continue;
        addScreenshot(target, procedure, file);
        break; // upload one at a time for now
      }
      return;
    }
    if (!_dragStep || _dragStep.procedure !== procedure) return;
    event.preventDefault();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = _dragStep.step;
    _dragStep = null;
    if (dragged === target) return;
  
    const srcContainer = containerOfStep(procedure, dragged);
    const tgtContainer = containerOfStep(procedure, target);
    if (!srcContainer || !tgtContainer) return;
    if ((srcContainer === "flat") !== (tgtContainer === "flat")) return;
  
    const srcList = stepListOf(procedure, srcContainer);
    const tgtList = stepListOf(procedure, tgtContainer);
    const fromIdx = srcList.indexOf(dragged);
    if (fromIdx === -1) return;
    srcList.splice(fromIdx, 1);
    // Index in target list may have shifted if same list and the source came
    // before the target. After splice it is fine because target is still in
    // the tgtList (different list, or same list with target index updated).
    let toIdx = tgtList.indexOf(target);
    if (toIdx === -1) {
      // target was the dragged step itself (shouldn't happen but be safe)
      toIdx = tgtList.length;
    } else if (!above) {
      toIdx += 1;
    }
    tgtList.splice(toIdx, 0, dragged);
  
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function onGroupDragStart(event, group, blockEl, procedure) {
    _dragGroup = { group, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "group");
    } catch {}
    event.stopPropagation();
  }

  function onGroupDragEnd() {
    if (_dragGroup && _dragGroup.blockEl)
      _dragGroup.blockEl.classList.remove("is-dragging");
    _dragGroup = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onGroupDragOver(event, _group, blockEl, procedure) {
    if (!_dragGroup || _dragGroup.procedure !== procedure) return;
    if (_dragGroup.blockEl === blockEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.stopPropagation();
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onGroupDragLeave(event, blockEl) {
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onGroupDrop(event, target, blockEl, procedure) {
    if (!_dragGroup || _dragGroup.procedure !== procedure) return;
    event.preventDefault();
    event.stopPropagation();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = _dragGroup.group;
    _dragGroup = null;
    if (dragged === target) return;
  
    const list = procedure.groups || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);
  
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function onProseDragStart(event, prose, blockEl, procedure) {
    _dragProse = { prose, procedure, blockEl };
    blockEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "prose");
    } catch {}
  }

  function onProseDragEnd() {
    if (_dragProse && _dragProse.blockEl)
      _dragProse.blockEl.classList.remove("is-dragging");
    _dragProse = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onProseDragOver(event, _prose, blockEl, procedure) {
    if (!_dragProse || _dragProse.procedure !== procedure) return;
    if (_dragProse.blockEl === blockEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = blockEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    blockEl.classList.toggle("drop-above", above);
    blockEl.classList.toggle("drop-below", !above);
  }

  function onProseDragLeave(event, blockEl) {
    if (!blockEl.contains(event.relatedTarget)) {
      blockEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onProseDrop(event, target, blockEl, procedure) {
    if (!_dragProse || _dragProse.procedure !== procedure) return;
    event.preventDefault();
    const above = blockEl.classList.contains("drop-above");
    blockEl.classList.remove("drop-above", "drop-below");
    const dragged = _dragProse.prose;
    _dragProse = null;
    if (dragged === target) return;
  
    const list = procedure.prose || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);
  
    applyProcedureRewrite(procedure, null);
  }

  function containerOfStep(procedure, step) {
    for (const g of procedure.groups || []) {
      if ((g.steps || []).includes(step)) return g;
    }
    if ((procedure.flat_steps || []).includes(step)) return "flat";
    return null;
  }

  function containerOfBlock(blockEl) {
    // A step block inside .block-group belongs to that group; otherwise flat.
    const groupEl = blockEl.closest(".block-group");
    if (groupEl) {
      // Locate the matching parsed group by title (titles are stable within a doc).
      const title = groupEl.querySelector("h3")?.textContent || "";
      if (
        documentState.currentParsed &&
        documentState.currentParsed.sections &&
        documentState.currentParsed.sections.procedure
      ) {
        const proc = documentState.currentParsed.sections.procedure;
        for (const g of proc.groups || []) {
          if ((g.title || "") === title) return g;
        }
      }
      return null;
    }
    return "flat";
  }

  function stepListOf(procedure, container) {
    if (container === "flat")
      return (procedure.flat_steps = procedure.flat_steps || []);
    if (container && typeof container === "object")
      return (container.steps = container.steps || []);
    return [];
  }

  function addStep(procedure, group) {
    const nextId = nextStepId(procedure);
    const newStep = {
      id: nextId,
      rendered_number: nextId,
      attrs: {},
      body_md: "Describe this step.",
      screenshots: [],
    };
    if (group) {
      group.steps = group.steps || [];
      group.steps.push(newStep);
    } else {
      procedure.flat_steps = procedure.flat_steps || [];
      procedure.flat_steps.push(newStep);
    }
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, newStep.id);
  }

  function deleteStep(procedure, step) {
    const num = step.rendered_number ?? step.id;
    const snapshot = snapshotProcedure(procedure);
    for (const g of procedure.groups || []) {
      g.steps = (g.steps || []).filter((s) => s !== step);
    }
    procedure.flat_steps = (procedure.flat_steps || []).filter((s) => s !== step);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
    showUndoToast(`Step ${num} deleted.`, () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function addGroup(procedure) {
    const nextId = nextStepId(procedure);
    const newGroup = {
      title: "New group",
      steps: [
        {
          id: nextId,
          rendered_number: nextId,
          attrs: {},
          body_md: "Describe this step.",
          screenshots: [],
        },
      ],
    };
    procedure.groups = procedure.groups || [];
    procedure.groups.push(newGroup);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, newGroup.steps[0].id);
  }

  function deleteGroup(procedure, group) {
    const count = (group.steps || []).length;
    const title = group.title || "(untitled)";
    const snapshot = snapshotProcedure(procedure);
    procedure.groups = (procedure.groups || []).filter((g) => g !== group);
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
    showUndoToast(
      count
        ? `Group "${title}" (${count} step${count === 1 ? "" : "s"}) deleted.`
        : `Group "${title}" deleted.`,
      () => restoreProcedure(procedure, snapshot),
    );
  }

  function addProse(procedure) {
    const newProse = {
      after_step_id: null,
      body_md: "New free-form text. Click to edit.",
    };
    procedure.prose = procedure.prose || [];
    procedure.prose.push(newProse);
    applyProcedureRewrite(procedure, null);
    // Open the newly-added prose for editing.
    const blocks = renderedView.querySelectorAll(
      ".block-prose .block-prose-body",
    );
    const last = blocks[blocks.length - 1];
    if (last) {
      last.scrollIntoView({ behavior: "smooth", block: "center" });
      last.click();
    }
  }

  function deleteProse(procedure, prose) {
    const snapshot = snapshotProcedure(procedure);
    procedure.prose = (procedure.prose || []).filter((p) => p !== prose);
    applyProcedureRewrite(procedure, null);
    showUndoToast("Free-form block deleted.", () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function toggleStepAttrEditor(blockEl, step, procedure) {
    const existing = blockEl.querySelector(".block-step-attr-editor");
    if (existing) {
      existing.remove();
      return;
    }
  
    const editor = document.createElement("form");
    editor.className = "block-step-attr-editor";
  
    const attrs = step.attrs || {};
    const allowedSystems =
      (documentState.currentParsed &&
        documentState.currentParsed.frontmatter &&
        documentState.currentParsed.frontmatter.systems) ||
      [];
  
    // action
    const actionRow = makeAttrRow("Action");
    const actionSel = document.createElement("select");
    actionSel.innerHTML =
      `<option value="">(none)</option>` +
      STEP_ACTIONS.map(
        (a) =>
          `<option value="${a}"${a === attrs.action ? " selected" : ""}>${a}</option>`,
      ).join("");
    actionRow.append(actionSel);
    editor.append(actionRow);
  
    // tool
    const toolRow = makeAttrRow("Tool");
    const toolInput = document.createElement("input");
    toolInput.type = "text";
    toolInput.value = attrs.tool || "";
    toolInput.placeholder = "Free text, e.g. ‘drag-and-drop’";
    toolRow.append(toolInput);
    editor.append(toolRow);
  
    // systems (multi-select)
    const sysRow = makeAttrRow("Systems");
    const sysWrap = document.createElement("div");
    sysWrap.className = "block-step-attr-systems";
    const selected = new Set(Array.isArray(attrs.systems) ? attrs.systems : []);
    if (allowedSystems.length === 0) {
      const note = document.createElement("span");
      note.className = "block-step-attr-note";
      note.textContent = "Add systems to the doc frontmatter to enable.";
      sysWrap.append(note);
    } else {
      for (const sys of allowedSystems) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "block-step-attr-chip";
        btn.textContent = sys;
        btn.dataset.system = sys;
        btn.classList.toggle("is-selected", selected.has(sys));
        btn.addEventListener("click", () => {
          if (selected.has(sys)) selected.delete(sys);
          else selected.add(sys);
          btn.classList.toggle("is-selected", selected.has(sys));
        });
        sysWrap.append(btn);
      }
    }
    sysRow.append(sysWrap);
    editor.append(sysRow);
  
    // actions
    const actionsRow = document.createElement("div");
    actionsRow.className = "block-step-attr-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => editor.remove());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "Apply";
    actionsRow.append(cancel, save);
    editor.append(actionsRow);
  
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const newAttrs = {};
      const actionVal = actionSel.value.trim();
      if (actionVal) newAttrs.action = actionVal;
      const toolVal = toolInput.value.trim();
      if (toolVal) newAttrs.tool = toolVal;
      const sysList = Array.from(selected);
      if (sysList.length) newAttrs.systems = sysList;
      step.attrs = newAttrs;
      editor.remove();
      applyProcedureRewrite(procedure, null);
    });
  
    blockEl.querySelector(".block-step-header").after(editor);
  }

  function makeAttrRow(label) {
    const row = document.createElement("label");
    row.className = "block-step-attr-row";
    const span = document.createElement("span");
    span.className = "block-step-attr-label";
    span.textContent = label;
    row.append(span);
    return row;
  }

  function snapshotProcedure(procedure) {
    return JSON.parse(
      JSON.stringify({
        groups: procedure.groups || [],
        flat_steps: procedure.flat_steps || [],
        prose: procedure.prose || [],
        todos: procedure.todos || [],
      }),
    );
  }

  function restoreProcedure(procedure, snapshot) {
    procedure.groups = snapshot.groups;
    procedure.flat_steps = snapshot.flat_steps;
    procedure.prose = snapshot.prose;
    procedure.todos = snapshot.todos;
    renumberProcedure(procedure);
    applyProcedureRewrite(procedure, null);
  }

  function nextStepId(procedure) {
    let max = 0;
    for (const g of procedure.groups || []) {
      for (const s of g.steps || []) max = Math.max(max, s.id);
    }
    for (const s of procedure.flat_steps || []) max = Math.max(max, s.id);
    return max + 1;
  }

  function renumberProcedure(procedure) {
    let n = 0;
    for (const g of procedure.groups || []) {
      for (const s of g.steps || []) {
        n += 1;
        s.id = n;
        s.rendered_number = n;
      }
    }
    for (const s of procedure.flat_steps || []) {
      n += 1;
      s.id = n;
      s.rendered_number = n;
    }
  }

  function applyProcedureRewrite(procedure, focusStepId) {
    const newBody = emitProcedureSectionBody(procedure);
    const updated = patchSectionInMarkdown(editor.value, "procedure", newBody);
    if (updated == null) {
      setStatus("Could not locate procedure section; structural edit not saved.");
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
    renderParsedDocument();
    if (focusStepId != null) {
      // After re-render, find the new step's body and open the inline editor.
      const block = renderedView.querySelector(
        `.block-step[data-step-id="${focusStepId}"] .block-step-body`,
      );
      if (block) {
        block.scrollIntoView({ behavior: "smooth", block: "center" });
        block.click();
      }
    }
  }

  function emitProcedureSectionBody(procedure) {
    const out = ["## Procedure", ""];
    const todos = procedure.todos || [];
    for (const t of todos) out.push(`<!-- sop-todo: "${escapeAttr(t)}" -->`);
    if (todos.length) out.push("");
  
    const groups = procedure.groups || [];
    if (groups.length) {
      for (const g of groups) {
        out.push(`<!-- sop-group-start: "${escapeAttr(g.title || "")}" -->`);
        out.push(`### ${g.title || ""}`);
        out.push("");
        for (const s of g.steps || []) out.push(emitStepBlock(s));
        out.push(`<!-- sop-group-end -->`);
        out.push("");
      }
    }
    for (const s of procedure.flat_steps || []) out.push(emitStepBlock(s));
  
    for (const p of procedure.prose || []) {
      out.push(`<!-- sop-prose-start -->`);
      out.push(p.body_md || "");
      out.push(`<!-- sop-prose-end -->`);
      out.push("");
    }
    return out.join("\n").replace(/\n+$/, "");
  }

  function emitStepBlock(step) {
    const attrParts = [`id=${step.id}`];
    for (const [k, v] of Object.entries(step.attrs || {})) {
      if (Array.isArray(v)) {
        if (v.length) attrParts.push(`${k}="${escapeAttr(v.join(","))}"`);
      } else if (v != null && v !== "") {
        attrParts.push(`${k}="${escapeAttr(String(v))}"`);
      }
    }
    const lines = [];
    lines.push(`<!-- sop-step-start ${attrParts.join(" ")} -->`);
    const renderedNum = step.rendered_number ?? step.id;
    const bodyText = (step.body_md || "").replace(/^ /, "");
    lines.push(formatStepBody(bodyText, renderedNum));
    for (const shot of step.screenshots || []) {
      lines.push("");
      lines.push("    <!-- sop-screenshot-start -->");
      if (shot.src) lines.push(`    ![${shot.alt || ""}](${shot.src})`);
      if (shot.caption) {
        lines.push("    <!-- sop-caption-start -->");
        lines.push(`    ${shot.caption}`);
        lines.push("    <!-- sop-caption-end -->");
      }
      lines.push("    <!-- sop-screenshot-end -->");
    }
    lines.push(`<!-- sop-step-end -->`);
    lines.push("");
    return lines.join("\n");
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '\\"');
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function patchSectionInMarkdown(markdown, name, newBodyMd) {
    const re = new RegExp(
      `(<!--\\s*sop-section-start:\\s*${name}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-section-end\\s*-->)`,
    );
    if (!re.test(markdown)) return null;
    return markdown.replace(
      re,
      (_, open, _body, close) => `${open}${newBodyMd}${close}`,
    );
  }

  function patchProseInMarkdown(markdown, index, newBodyMd) {
    const re =
      /<!--\s*sop-prose-start\s*-->\n([\s\S]*?)\n<!--\s*sop-prose-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const next = markdown.replace(re, (full, _body) => {
      if (i++ === index) {
        replaced = true;
        return `<!-- sop-prose-start -->\n${newBodyMd}\n<!-- sop-prose-end -->`;
      }
      return full;
    });
    return replaced ? next : null;
  }

  function patchGroupTitleInMarkdown(markdown, oldTitle, newTitle) {
    const escapedOld = escapeRegex(oldTitle);
    const markerRe = new RegExp(
      `(<!--\\s*sop-group-start:\\s*")${escapedOld}("\\s*-->)`,
    );
    if (!markerRe.test(markdown)) return null;
    let next = markdown.replace(markerRe, `$1${newTitle.replace(/"/g, '\\"')}$2`);
    // Also update the visible "### <title>" line if it sits inside this group.
    const headingRe = new RegExp(`(\\n)###\\s+${escapedOld}(\\s*\\n)`);
    next = next.replace(headingRe, `$1### ${newTitle}$2`);
    return next;
  }

  function patchCaptionInMarkdown(markdown, stepId, screenshotIndex, newCaption) {
    const stepRe = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(stepRe);
    if (!match) return null;
    let inner = match[2];
    const shotRe =
      /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const newInner = inner.replace(shotRe, (full, shotBody) => {
      if (i++ !== screenshotIndex) return full;
      replaced = true;
      const captionRe =
        /<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->/;
      const replacement = newCaption
        ? `<!-- sop-caption-start -->\n    ${newCaption}\n    <!-- sop-caption-end -->`
        : null;
      if (captionRe.test(shotBody)) {
        const newBody = replacement
          ? shotBody.replace(captionRe, replacement)
          : shotBody.replace(
              /\s*<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->\s*/,
              "",
            );
        return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
      }
      if (!replacement) return full;
      // Insert a caption before the screenshot-end marker.
      const insertedBody = shotBody.replace(
        /(\n\s*)$/,
        (_, ws) => `\n    ${replacement}${ws}`,
      );
      return `<!-- sop-screenshot-start -->\n${insertedBody}<!-- sop-screenshot-end -->`;
    });
    if (!replaced) return null;
    return markdown.replace(
      stepRe,
      (_, openMarker, _inner, closeMarker) =>
        `${openMarker}${newInner}${closeMarker}`,
    );
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function renderProseBlock(prose, index, procedure) {
    const block = document.createElement("aside");
    block.className = "block-prose";
    if (procedure) {
      block.addEventListener("dragover", (event) =>
        onProseDragOver(event, prose, block, procedure),
      );
      block.addEventListener("dragleave", (event) =>
        onProseDragLeave(event, block),
      );
      block.addEventListener("drop", (event) =>
        onProseDrop(event, prose, block, procedure),
      );
    }
  
    const headerRow = document.createElement("div");
    headerRow.className = "block-prose-header";
    if (procedure) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag block-prose-drag";
      handle.title = "Drag to reorder";
      handle.setAttribute("aria-label", "Drag free-form block");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onProseDragStart(event, prose, block, procedure),
      );
      handle.addEventListener("dragend", onProseDragEnd);
      headerRow.append(handle);
    }
    const label = document.createElement("span");
    label.className = "block-prose-label";
    label.textContent = "Free-form";
    headerRow.append(label);
    if (procedure) {
      const spacer = document.createElement("span");
      spacer.className = "block-step-spacer";
      headerRow.append(spacer);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete free-form block";
      delBtn.setAttribute("aria-label", "Delete free-form block");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProse(procedure, prose);
      });
      headerRow.append(delBtn);
    }
    block.append(headerRow);
  
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "block-prose-body";
    bodyWrap.append(renderMarkdown(prose.body_md || ""));
    attachInlineEditor(bodyWrap, {
      getValue: () => prose.body_md || "",
      commit: (value) => applyProseEdit(prose, index, value),
      restore: () =>
        bodyWrap.replaceChildren(renderMarkdown(prose.body_md || "")),
      multiline: true,
    });
    block.append(bodyWrap);
    return block;
  }

  function applyProseEdit(prose, index, newBody) {
    prose.body_md = newBody;
    const updated = patchProseInMarkdown(editor.value, index, newBody);
    if (updated == null) {
      setStatus(`Could not locate prose block #${index + 1}; edit not saved.`);
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function renderScreenshot(shot, step, screenshotIndex, procedure) {
    const figure = document.createElement("figure");
    figure.className = "block-screenshot";
    figure.tabIndex = 0;
    if (procedure) {
      figure.addEventListener("dragover", (event) =>
        onScreenshotDragOver(event, shot, figure, step, procedure),
      );
      figure.addEventListener("dragleave", (event) =>
        onScreenshotDragLeave(event, figure),
      );
      figure.addEventListener("drop", (event) =>
        onScreenshotDrop(event, shot, figure, step, procedure),
      );
    }
  
    const toolbar = document.createElement("div");
    toolbar.className = "block-screenshot-toolbar";
    if (procedure && (step.screenshots || []).length > 1) {
      const handle = document.createElement("span");
      handle.className = "block-step-drag block-screenshot-drag";
      handle.title = "Drag to reorder screenshot";
      handle.setAttribute("aria-label", "Drag screenshot");
      handle.textContent = "⋮⋮";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) =>
        onScreenshotDragStart(event, shot, figure, step, procedure),
      );
      handle.addEventListener("dragend", onScreenshotDragEnd);
      toolbar.append(handle);
    }
    if (procedure) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "block-step-delete";
      delBtn.title = "Delete screenshot";
      delBtn.setAttribute("aria-label", "Delete screenshot");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteScreenshot(step, shot, procedure);
      });
      toolbar.append(delBtn);
    }
    if (toolbar.children.length) figure.append(toolbar);
  
    const noteToggle = document.createElement("button");
    noteToggle.type = "button";
    noteToggle.className = "block-screenshot-note-toggle";
    noteToggle.textContent = "Text";
    noteToggle.title = "Show image text";
    noteToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      figure.classList.toggle("is-note-visible");
    });
    figure.append(noteToggle);
  
    if (shot.src) {
      const img = document.createElement("img");
      img.src = resolveImageSrc(shot.src);
      img.alt = shot.alt || "";
      img.loading = "lazy";
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        openLightbox(img.src, shot.caption || shot.alt || "");
      });
      figure.append(img);
    }
    const cap = document.createElement("figcaption");
    cap.className = "block-screenshot-note";
    cap.textContent = shot.caption || (step ? "Add caption…" : "");
    if (!shot.caption) cap.classList.add("is-placeholder");
    if (step) {
      attachInlineEditor(cap, {
        getValue: () => shot.caption || "",
        commit: (value) =>
          applyCaptionEdit(step, screenshotIndex, shot, value, cap),
        restore: () => {
          cap.textContent = shot.caption || "Add caption…";
          cap.classList.toggle("is-placeholder", !shot.caption);
        },
        multiline: true,
      });
    }
    const notes = document.createElement("div");
    notes.className = "block-screenshot-notes";
    notes.append(cap);
  
    if (step) {
      const alt = document.createElement("div");
      alt.className = "block-screenshot-alt block-screenshot-note";
      alt.textContent = shot.alt || "Add alt text for accessibility…";
      if (!shot.alt) alt.classList.add("is-placeholder");
      attachInlineEditor(alt, {
        getValue: () => shot.alt || "",
        commit: (value) => applyAltEdit(step, screenshotIndex, shot, value),
        restore: () => {
          alt.textContent = shot.alt || "Add alt text for accessibility…";
          alt.classList.toggle("is-placeholder", !shot.alt);
        },
        multiline: false,
      });
      notes.append(alt);
    }
    figure.append(notes);
    return figure;
  }

  function deleteScreenshot(step, shot, procedure) {
    const snapshot = snapshotProcedure(procedure);
    step.screenshots = (step.screenshots || []).filter((s) => s !== shot);
    applyProcedureRewrite(procedure, null);
    showUndoToast("Screenshot deleted.", () =>
      restoreProcedure(procedure, snapshot),
    );
  }

  function onScreenshotDragStart(event, shot, figEl, step, procedure) {
    _dragShot = { shot, step, procedure, figEl };
    figEl.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", "screenshot");
    } catch {}
    event.stopPropagation();
  }

  function onScreenshotDragEnd() {
    if (_dragShot && _dragShot.figEl)
      _dragShot.figEl.classList.remove("is-dragging");
    _dragShot = null;
    for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
      el.classList.remove("drop-above", "drop-below");
    }
  }

  function onScreenshotDragOver(event, _shot, figEl, step, procedure) {
    if (!_dragShot) return;
    if (_dragShot.step !== step) return;
    if (_dragShot.figEl === figEl) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.stopPropagation();
    const rect = figEl.getBoundingClientRect();
    const above = event.clientY - rect.top < rect.height / 2;
    figEl.classList.toggle("drop-above", above);
    figEl.classList.toggle("drop-below", !above);
  }

  function onScreenshotDragLeave(event, figEl) {
    if (!figEl.contains(event.relatedTarget)) {
      figEl.classList.remove("drop-above", "drop-below");
    }
  }

  function onScreenshotDrop(event, target, figEl, step, procedure) {
    if (!_dragShot || _dragShot.step !== step) return;
    event.preventDefault();
    event.stopPropagation();
    const above = figEl.classList.contains("drop-above");
    figEl.classList.remove("drop-above", "drop-below");
    const dragged = _dragShot.shot;
    _dragShot = null;
    if (dragged === target) return;
  
    const list = step.screenshots || [];
    const fromIdx = list.indexOf(dragged);
    if (fromIdx === -1) return;
    list.splice(fromIdx, 1);
    let toIdx = list.indexOf(target);
    if (toIdx === -1) toIdx = list.length;
    else if (!above) toIdx += 1;
    list.splice(toIdx, 0, dragged);
  
    applyProcedureRewrite(procedure, null);
  }

  function applyAltEdit(step, screenshotIndex, shot, newAlt) {
    shot.alt = newAlt;
    const updated = patchAltInMarkdown(
      editor.value,
      step.id,
      screenshotIndex,
      newAlt,
      shot.src,
    );
    if (updated == null) {
      setStatus(
        `Could not locate alt for screenshot #${screenshotIndex + 1} on step ${step.id}.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function patchAltInMarkdown(markdown, stepId, screenshotIndex, newAlt, src) {
    const stepRe = new RegExp(
      `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
    );
    const match = markdown.match(stepRe);
    if (!match) return null;
    let inner = match[2];
    const shotRe =
      /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
    let i = 0;
    let replaced = false;
    const newInner = inner.replace(shotRe, (full, shotBody) => {
      if (i++ !== screenshotIndex) return full;
      replaced = true;
      const imgRe = /!\[[^\]]*\]\(([^)]+)\)/;
      const newBody = shotBody.replace(imgRe, `![${newAlt}](${src})`);
      return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
    });
    if (!replaced) return null;
    return markdown.replace(
      stepRe,
      (_, openMarker, _inner, closeMarker) =>
        `${openMarker}${newInner}${closeMarker}`,
    );
  }

  function applyCaptionEdit(step, screenshotIndex, shot, newCaption, capEl) {
    shot.caption = newCaption;
    const updated = patchCaptionInMarkdown(
      editor.value,
      step.id,
      screenshotIndex,
      newCaption,
    );
    if (updated == null) {
      setStatus(
        `Could not locate caption #${screenshotIndex + 1} on step ${step.id}; edit not saved.`,
      );
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function resolveImageSrc(src) {
    if (!src) return "";
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith("/")) return src;
    if (!documentState.currentDoc) return src;
    // Resolve relative path against the current doc's directory; both live
    // under content/, which the frontend container serves at /content/.
    const docDir = documentState.currentDoc.path.split("/").slice(0, -1).join("/");
    const stack = docDir.split("/").filter(Boolean);
    for (const part of src.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return "/" + stack.join("/");
  }

  function stripFrontmatter(md) {
    if (!md.startsWith("---\n")) return md;
    const end = md.indexOf("\n---\n", 4);
    if (end === -1) return md;
    return md.slice(end + 5).replace(/^\n+/, "");
  }

  function stripLeadingHeading(md) {
    // Sections include their visible ## Heading line first; drop it because
    // the block header already shows the name.
    return md.replace(/^##\s+[^\n]*\n+/, "");
  }

  // ---------- Minimal markdown renderer for block bodies ----------
  
  function renderMarkdown(markdown) {
    const wrap = document.createElement("div");
    wrap.className = "md";
    const html = markdownToHtml(markdown || "");
    wrap.innerHTML = html;
    wrap.querySelectorAll("[data-doc-path]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const path = link.getAttribute("data-doc-path");
        if (path) openDocument(path);
      });
    });
    return wrap;
  }

  function markdownToHtml(md) {
    if (!md) return "";
    const escaped = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const lines = escaped.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      // Blockquote
      if (/^&gt;\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^&gt;\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
        continue;
      }
      // Fenced code
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // close fence
        out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
        continue;
      }
      // Numbered list
      if (/^\s*\d+\.\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*\d+\.\s/, ""));
          i++;
        }
        out.push(
          `<ol>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ol>`,
        );
        continue;
      }
      // Bulleted list
      if (/^\s*[-*]\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*[-*]\s/, ""));
          i++;
        }
        out.push(
          `<ul>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ul>`,
        );
        continue;
      }
      // Heading
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        const level = Math.min(6, h[1].length);
        out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
        i++;
        continue;
      }
      // Table: pipe-delimited rows with a separator row underneath.
      if (
        line.trim().startsWith("|") &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const headerCells = splitTableRow(line);
        i += 2; // skip header + separator
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
        out.push(`<table>${thead}${tbody}</table>`);
        continue;
      }
      // Paragraph (collect until blank line)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^[#>`\-*]/.test(lines[i].trim()[0]) &&
        !/^\s*\d+\.\s/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
    }
    return out.join("\n");
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  }

  function inlineMd(text) {
    let s = text;
    // Internal wiki links: [[doc-id]] or [[doc-id|Custom label]].
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawRef, rawLabel) => {
      const ref = String(rawRef || "").trim();
      const doc = resolveDocReference(ref);
      if (!doc) {
        const label = rawLabel || ref;
        return `<span class="broken-doc-link" title="Missing doc: ${escapeHtmlAttr(ref)}">${escapeHtml(label)}</span>`;
      }
      const label = rawLabel || doc.title || ref;
      return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
    });
    // Inline image
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const resolved = resolveImageSrc(src);
      return `<img src="${resolved}" alt="${alt}" loading="lazy">`;
    });
    // Link
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const doc = resolveMarkdownDocLink(href);
      if (doc) {
        return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
      }
      const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
      const target = /^(https?:|mailto:)/i.test(href)
        ? ' target="_blank" rel="noopener"'
        : "";
      return `<a href="${safe}"${target}>${label}</a>`;
    });
    // Bold then italic
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // Inline code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }

  return {
    canLeaveDocumentEditor,
    closeDiff,
    closeLightbox,
    closeCommitForm,
    createDocument,
    deleteCurrentDoc,
    draftKey,
    discardAllDrafts,
    discardDraft,
    emptyNote,
    escapeRegex,
    enterRenderedMode,
    gitPull,
    handleClipboardPaste,
    listDraftPaths,
    openCommitForm,
    openLintReport,
    refreshChangesPanel,
    refreshGitStatus,
    renameCurrentDoc,
    resizeDocumentTitle,
    saveAllDrafts,
    saveCurrentDocument,
    setSaveState,
    showCreate,
    storeDraft,
    submitCommitForm,
    syncTitleToMarkdown,
    titleFromMarkdown,
    toggleViewMode,
    updateGithubLink,
    updateSaveState,
    updateViewToggleAvailability
  };
}
