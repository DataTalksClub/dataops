import {
  emptyOperationsDocsSnapshot,
  loadedOperationsDocsSnapshot,
  unavailableOperationsDocsSnapshot,
} from "../../core/operations-model.js";

export function createKnowledgeCatalog(context, services) {
  const {
    apiUrl,
    basename,
    cleanPath,
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
    setDocsAvailability,
    setStatus,
    storage,
  } = context;
  const {
    openDocument,
    populateFilterOptions,
    refreshDocuments,
  } = services;

  const PIN_KEY = "dtc-pinned";
  const RECENTLY_VIEWED_KEY = "dtc-recently-viewed";
  const RECENTLY_VIEWED_MAX = 8;

  async function loadDocuments() {
    setStatus("Loading documents...");
    setDocsAvailability(emptyOperationsDocsSnapshot());

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
      setDocsAvailability(loadedOperationsDocsSnapshot(knowledgeState.allDocuments));
      rebuildDocumentIdMap();
      populateFilterOptions();
      refreshDocuments();
      renderRecentDocs();
      renderRecentlyViewed();
      renderPinned();
    } catch (error) {
      // The bootstrap catalog request is the single source of docs
      // availability. Record the outage with the server's own message and
      // repaint, so the surface the operator is already looking at stops
      // reading like an empty corpus.
      knowledgeState.allDocuments = [];
      setDocsAvailability(unavailableOperationsDocsSnapshot(error));
      refreshDocuments();
    }
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
      knowledgeState.documentIdMap.get(key) ||
      knowledgeState.documentIdMap.get(key.replace(/^\/+/, "")) ||
      null
    );
  }

  function relativeTime(epoch) {
    const now = Date.now() / 1000;
    const diff = Math.max(0, now - epoch);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
    const date = new Date(epoch * 1000);
    return date.toLocaleDateString();
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
    rebuildDocumentIdMap,
    relativeTime,
    resolveDocReference,
    renderPinned,
    renderRecentDocs,
    renderRecentlyViewed,
    toggleCurrentDocPin,
    updatePinButton,
  };
}
