export function initializeAppShell({
  loadDocuments,
  navigationShell,
  refreshChangesPanel,
  refreshKnowledgeStatus,
  refreshOperationsWorkSnapshot,
  showLibrary,
  updateSaveState,
  windowRef,
}) {
  showLibrary({ updateUrl: false });
  refreshChangesPanel();
  updateSaveState();
  const documentsReady = loadDocuments();
  navigationShell.initializeRouting(documentsReady);
  refreshKnowledgeStatus();

  windowRef.__dataopsRefreshWork = function refreshOperationsWorkForTests() {
    return refreshOperationsWorkSnapshot({ rerender: true });
  };

  return { documentsReady };
}
