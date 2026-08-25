export function initializeAppShell({
  enhanceSelect,
  filterSelects,
  loadDocuments,
  navigationShell,
  refreshChangesPanel,
  refreshGitStatus,
  refreshOperationsWorkSnapshot,
  restoreDarkMode,
  restoreSidebarCollapsed,
  showLibrary,
  syncSidebarShellState,
  updateSaveState,
  windowRef,
}) {
  for (const select of filterSelects) enhanceSelect(select);
  restoreDarkMode();
  restoreSidebarCollapsed();
  syncSidebarShellState();

  showLibrary({ updateUrl: false });
  refreshChangesPanel();
  updateSaveState();
  const documentsReady = loadDocuments();
  navigationShell.initializeRouting(documentsReady);
  refreshGitStatus();

  windowRef.__dataopsRefreshWork = function refreshOperationsWorkForTests() {
    return refreshOperationsWorkSnapshot({ rerender: true });
  };

  return { documentsReady };
}
