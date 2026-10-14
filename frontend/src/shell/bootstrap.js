export function initializeAppShell({
  enhanceSelect,
  filterSelects,
  loadDocuments,
  navigationShell,
  refreshChangesPanel,
  refreshKnowledgeStatus,
  refreshOperationsWorkSnapshot,
  showLibrary,
  updateSaveState,
  windowRef,
}) {
  for (const select of filterSelects) enhanceSelect(select);

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
