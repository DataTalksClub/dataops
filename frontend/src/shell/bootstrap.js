export function initializeAppShell({
  loadDocuments,
  navigationShell,
  refreshChangesPanel,
  refreshKnowledgeStatus,
  refreshOperationsWorkSnapshot,
  refreshUsersSurface,
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

  // The same background refresh the bootstrap runs, so a test can make data
  // land while the operator is mid-interaction.
  windowRef.__dataopsRefreshWork = function refreshOperationsWorkForTests() {
    return refreshOperationsWorkSnapshot({ background: true });
  };
  windowRef.__dataopsRefreshUsers = function refreshUsersForTests() {
    return refreshUsersSurface({ background: true });
  };

  return { documentsReady };
}
