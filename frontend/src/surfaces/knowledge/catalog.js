export function createKnowledgeCatalog(context, services) {
  const {
    apiUrl,
    basename,
    docPinButton,
    documentState,
    knowledgeState,
    pinnedList,
    pinnedSection,
    recentList,
    recentlyViewedList,
    recentlyViewedSection,
    refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot,
    refreshOperationsQualitySnapshot,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    request,
    setStatus,
    storage,
  } = context;
  const {
    openDocument,
    populateFilterOptions,
    rebuildDocumentIdMap,
    refreshDocuments,
    relativeTime,
  } = services;

  const PIN_KEY = "dtc-pinned";
  const RECENTLY_VIEWED_KEY = "dtc-recently-viewed";
  const RECENTLY_VIEWED_MAX = 8;

  async function loadDocuments() {
    setStatus("Loading documents...");
    const skeleton = document.querySelector("#tree-skeleton");
    if (skeleton) skeleton.hidden = false;

    // Work APIs are independent of the Git-backed docs API. Start their
    // bootstrap requests before awaiting docs so Home, Inbox, assistants,
    // artifacts, and recurring work remain operational during a docs outage.
    refreshOperationsWorkSnapshot({ rerender: true });
    refreshOperationsRecurringSnapshot({ rerender: true });
    refreshOperationsArtifactSnapshot({ rerender: true });
    refreshOperationsAssistantSnapshot({ rerender: true });
    refreshOperationsQualitySnapshot({ rerender: true });

    try {
      const payload = await request(apiUrl("/docs"));
      knowledgeState.allDocuments = payload.documents || [];
      rebuildDocumentIdMap();
      populateFilterOptions();
      refreshDocuments();
      renderRecentDocs();
      renderRecentlyViewed();
      renderPinned();
    } catch (error) {
      setStatus(error.message);
    } finally {
      if (skeleton) skeleton.hidden = true;
    }
  }

  function readPins() {
    try {
      const raw = storage.getItem(PIN_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch {
      return new Set();
    }
  }

  function writePins(set) {
    try {
      storage.setItem(PIN_KEY, JSON.stringify([...set]));
    } catch {}
  }

  function toggleCurrentDocPin() {
    if (!documentState.currentDoc) return;
    const pins = readPins();
    if (pins.has(documentState.currentDoc.path)) pins.delete(documentState.currentDoc.path);
    else pins.add(documentState.currentDoc.path);
    writePins(pins);
    renderPinned();
    updatePinButton();
  }

  function updatePinButton() {
    if (!documentState.currentDoc) {
      docPinButton.hidden = true;
      return;
    }
    docPinButton.hidden = false;
    const pinned = readPins().has(documentState.currentDoc.path);
    docPinButton.textContent = pinned ? "Pinned" : "Pin";
    docPinButton.title = pinned ? "Unpin from sidebar" : "Pin to sidebar";
    docPinButton.setAttribute(
      "aria-label",
      pinned ? "Unpin from sidebar" : "Pin to sidebar",
    );
    docPinButton.classList.toggle("is-pinned", pinned);
  }

  function renderPinned() {
    const pins = readPins();
    if (pins.size === 0) {
      pinnedSection.hidden = true;
      pinnedList.replaceChildren();
      return;
    }
    pinnedSection.hidden = false;
    const rows = [...pins].map((path) => {
      const doc = knowledgeState.allDocuments.find((d) => d.path === path) || {
        path,
        title: basename(path),
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = path;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(path);
      const star = document.createElement("span");
      star.className = "recent-row-when";
      star.textContent = "Pinned";
      btn.append(label, star);
      btn.addEventListener("click", () => openDocument(path));
      return btn;
    });
    pinnedList.replaceChildren(...rows);
  }

  function pushRecentlyViewed(path) {
    try {
      const raw = storage.getItem(RECENTLY_VIEWED_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter((p) => p !== path);
      filtered.unshift(path);
      storage.setItem(
        RECENTLY_VIEWED_KEY,
        JSON.stringify(filtered.slice(0, RECENTLY_VIEWED_MAX)),
      );
    } catch {}
  }

  function renderRecentlyViewed() {
    let list = [];
    try {
      list = JSON.parse(storage.getItem(RECENTLY_VIEWED_KEY) || "[]");
    } catch {}
    if (list.length === 0) {
      recentlyViewedSection.hidden = true;
      return;
    }
    recentlyViewedSection.hidden = false;
    const rows = list.map((path) => {
      const doc = knowledgeState.allDocuments.find((d) => d.path === path) || {
        path,
        title: basename(path),
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = path;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(path);
      btn.append(label);
      btn.addEventListener("click", () => openDocument(path));
      return btn;
    });
    recentlyViewedList.replaceChildren(...rows);
  }

  function renderRecentDocs() {
    const sorted = knowledgeState.allDocuments
      .filter((d) => typeof d.updated === "number")
      .slice()
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 8);
    const rows = sorted.map((doc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = `${doc.path} · ${relativeTime(doc.updated)}`;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(doc.path);
      const when = document.createElement("span");
      when.className = "recent-row-when";
      when.textContent = relativeTime(doc.updated);
      btn.append(label, when);
      btn.addEventListener("click", () => openDocument(doc.path));
      return btn;
    });
    recentList.replaceChildren(...rows);
  }


  return {
    loadDocuments,
    pushRecentlyViewed,
    renderPinned,
    renderRecentDocs,
    renderRecentlyViewed,
    toggleCurrentDocPin,
    updatePinButton,
  };
}
