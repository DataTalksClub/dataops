import {
  emptyOperationsDocsSnapshot,
  loadedOperationsDocsSnapshot,
  unavailableOperationsDocsSnapshot,
} from "../../core/operations-model.js";

export function createKnowledgeCatalog(context, services) {
  const {
    apiUrl,
    cleanPath,
    knowledgeState,
    refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot,
    refreshOperationsQualitySnapshot,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    request,
    setDocsAvailability,
    setStatus,
  } = context;
  const {
    populateFilterOptions,
    refreshDocuments,
  } = services;

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

  return {
    loadDocuments,
    rebuildDocumentIdMap,
    resolveDocReference,
  };
}
