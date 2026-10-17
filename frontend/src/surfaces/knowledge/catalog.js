import {
  emptyOperationsDocsSnapshot,
  loadedOperationsDocsSnapshot,
  unavailableOperationsDocsSnapshot,
} from "../../core/operations-model.js";

export function createKnowledgeCatalog(context, services) {
  const {
    apiUrl,
    cleanPath,
    dispatchBootstrapSnapshots,
    knowledgeState,
    refreshOperationsQualitySnapshot,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    renderInBackground,
    request,
    setDocsAvailability,
    showsSharedSnapshots,
  } = context;
  const { populateFilterOptions } = services;
  let catalogRequestId = 0;

  async function loadDocuments(initialRoute) {
    const requestId = ++catalogRequestId;
    setDocsAvailability(emptyOperationsDocsSnapshot());

    if (initialRoute === undefined) {
      // An explicit refresh (document editor, history, changes): keep the
      // historical behavior of refreshing the shared snapshots alongside
      // the docs catalog.
      refreshOperationsWorkSnapshot({ background: true });
      refreshOperationsRecurringSnapshot({ background: true });
      refreshOperationsQualitySnapshot({ background: true });
    } else {
      // The bootstrap call: the startup orchestration defers the shared
      // snapshots on self-loading routes (CRM and friends fetch their own
      // data) and starts them immediately everywhere else, still in the
      // background so tasks and recurring work stay operational during a
      // docs outage. The docs catalog below always loads: docs availability
      // must never depend on routing.
      dispatchBootstrapSnapshots(initialRoute);
    }

    try {
      const payload = await request(apiUrl("/docs"));
      if (requestId !== catalogRequestId) return;
      knowledgeState.allDocuments = Array.isArray(payload?.documents)
        ? payload.documents
        : [];
      setDocsAvailability(loadedOperationsDocsSnapshot(knowledgeState.allDocuments));
      rebuildDocumentIdMap();
      populateFilterOptions();
      renderInBackground({ when: showsSharedSnapshots });
    } catch (error) {
      if (requestId !== catalogRequestId) return;
      // The bootstrap catalog request is the single source of docs
      // availability. Record the outage with the server's own message and
      // repaint, so the surface the operator is already looking at stops
      // reading like an empty corpus.
      knowledgeState.allDocuments = [];
      setDocsAvailability(unavailableOperationsDocsSnapshot(error));
      renderInBackground({ when: showsSharedSnapshots });
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

  return {
    loadDocuments,
    rebuildDocumentIdMap,
    resolveDocReference,
  };
}
