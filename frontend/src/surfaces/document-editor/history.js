export function createEditorHistory(context, services) {
  const { apiUrl, request, documentState, editor, storage, confirmDialog, openDocument,
    loadDocuments, historyModal, historyClose, historyPath, historySearchForm,
    historyStatus, historyVersions, historyComparison, knowledgeStatusText } = context;
  const documentRef = context.documentRef || document;
  let generation = 0;
  let revision;
  let cursor = null;
  let loading = false;
  let restoring = false;
  let returnFocus;

  function node(tag, text, className) {
    const result = documentRef.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function action(text, handler) {
    const button = node("button", text, "quiet-button");
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }
  function status(text, error = false) {
    historyStatus.textContent = text;
    historyStatus.setAttribute("role", error ? "alert" : "status");
  }
  async function refreshKnowledgeStatus() {
    try {
      const state = await request(apiUrl("/knowledge/status"));
      const exported = state.exported;
      knowledgeStatusText.textContent = exported
        ? `Saved files are available. Last GitHub export: ${new Date(exported.at).toLocaleString()}${state.exportLag ? " · newer saves await daily export" : " · up to date"}.`
        : "Saved files are available. Daily GitHub export has not completed yet.";
    } catch {
      knowledgeStatusText.textContent = "Daily GitHub export status unavailable. File saves and history are independent of GitHub.";
    }
  }
  async function openHistory() {
    returnFocus = documentRef.activeElement;
    historyModal.hidden = false;
    historyPath.value = documentState.currentDoc?.path || historyPath.value || "";
    historyPath.focus();
    if (historyPath.value) await loadHistory();
    else { status("Enter a file path to view its history, including deleted files."); historyVersions.replaceChildren(); }
  }
  function closeHistory() {
    generation++;
    loading = false;
    historyModal.hidden = true;
    returnFocus?.focus();
  }
  function historyUrl(endpoint, path, version) {
    const url = apiUrl(endpoint);
    url.searchParams.set("path", path);
    if (version) url.searchParams.set("revision", version);
    return url;
  }
  async function loadHistory(more = false) {
    if (loading || restoring) return;
    const path = historyPath.value.trim();
    if (!path) { status("Enter a file path.", true); return; }
    const token = ++generation;
    loading = true;
    status("Loading file history…");
    if (!more) { historyVersions.replaceChildren(); historyComparison.hidden = true; cursor = null; }
    try {
      const url = historyUrl("/knowledge/history", path);
      if (more && cursor) url.searchParams.set("cursor", cursor);
      const [publication, result] = await Promise.all([request(apiUrl("/knowledge/publication")), request(url)]);
      if (token !== generation) return;
      revision = publication.revision;
      if (!Array.isArray(result.versions)) throw new Error("History response is incomplete");
      historyVersions.querySelector?.(".history-more")?.remove();
      for (const version of result.versions) {
        const row = node("article", "", "history-version");
        row.append(node("strong", `${version.operation}${version.deleted ? " · deleted" : ""}`));
        row.append(node("p", `${version.actor} · ${new Date(version.time).toLocaleString()}`));
        row.append(node("p", version.message || ""));
        row.append(node("code", version.revision));
        if (!version.deleted) {
          row.append(action(version.binary ? "Download version" : "Compare version", () => inspectVersion(path, version)));
          row.append(action("Restore version", () => restoreVersion(path, version)));
        }
        historyVersions.append(row);
      }
      cursor = result.cursor || null;
      if (cursor) { const moreButton = action("Load older versions", () => loadHistory(true)); moreButton.classList.add("history-more"); historyVersions.append(moreButton); }
      status(historyVersions.children.length ? "Each restore creates a new saved version. GitHub receives the current files daily." : "No saved versions for this path.");
    } catch (error) {
      if (token !== generation) return;
      status(`History unavailable: ${error.message}`, true);
      historyVersions.append(action("Retry history", () => loadHistory()));
    } finally { if (token === generation) loading = false; }
  }
  async function inspectVersion(path, version) {
    const token = generation;
    status(version.binary ? "Downloading version…" : "Loading comparison…");
    try {
      if (version.binary) {
        // Fetch the short-lived URL with cookie or bearer authentication, then
        // download directly from private S3. No binary bytes traverse Lambda.
        const result = await request(historyUrl("/knowledge/download", path, version.revision));
        if (token !== generation) return;
        if (!result.url) throw new Error("Download response is incomplete");
        const link = node("a");
        link.href = result.url;
        link.download = path.split("/").pop();
        link.click();
        status("Download requested. File history remains available."); return;
      }
      const blob = await request(historyUrl("/knowledge/version", path, version.revision), { responseType: "blob" });
      if (token !== generation) return;
      const historical = await blob.text();
      // The current version endpoint supports all text formats, not just Markdown docs.
      let current;
      try { current = await (await request(historyUrl("/knowledge/version", path, revision), { responseType: "blob" })).text(); }
      catch (error) { if (error.status !== 404) throw error; current = "File is deleted in the current publication."; }
      if (token !== generation) return;
      const left = node("section"); left.append(node("h3", "Selected version"), node("pre", historical));
      const right = node("section"); right.append(node("h3", "Current saved file"), node("pre", current));
      historyComparison.replaceChildren(left, right); historyComparison.hidden = false;
      status(historical === current
        ? "This version matches the current saved file."
        : "Compare the selected version with the current saved file below. Unsaved drafts are unchanged.");
    } catch (error) { if (token === generation) status(`Version unavailable: ${error.message}`, true); }
  }
  async function restoreVersion(path, version) {
    if (restoring || loading) return;
    const token = generation;
    const dirty = documentState.currentDoc?.path === path && editor.value !== documentState.lastSavedContent;
    const message = `Restore ${path} from ${new Date(version.time).toLocaleString()}? This creates a new saved version.`;
    const confirmed = await confirmDialog(message + (dirty ? " Your unsaved draft stays in this browser." : ""),
      { okText: "Restore version", danger: true });
    if (!confirmed || token !== generation || restoring) return;
    restoring = true;
    status("Restoring version…");
    try {
      const result = await request(historyUrl("/knowledge/restore", path), { method: "POST", body: JSON.stringify({ version: version.revision, expectedRevision: revision }) });
      if (token !== generation) return;
      revision = result.revision;
      await loadDocuments();
      if (token !== generation) return;
      if (!dirty && /\.md$/i.test(path)) { closeHistory(); await openDocument(path); }
      else { restoring = false; await loadHistory(); status("Restored as a new saved version. Your local draft is unchanged."); }
      refreshKnowledgeStatus();
    } catch (error) {
      if (token === generation) status(error.status === 409
        ? "A newer save exists. Reload history before restoring; your draft is unchanged."
        : `Restore failed: ${error.message}`, true);
      if (token === generation) historyVersions.append(action("Reload history", () => loadHistory()));
    } finally { restoring = false; }
  }
  historySearchForm?.addEventListener("submit", (event) => { event.preventDefault(); loadHistory(); });
  historyModal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHistory();
    if (event.key !== "Tab") return;
    const focusable = [...historyModal.querySelectorAll("button, input, a")].filter((item) => !item.disabled);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  return { openHistory, closeHistory, refreshKnowledgeStatus };
}
