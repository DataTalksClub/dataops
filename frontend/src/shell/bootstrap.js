export function initializeAppShell({
  attachSidebarResize,
  enhanceSelect,
  filterSelects,
  loadDocuments,
  navigationShell,
  refreshChangesPanel,
  refreshGitStatus,
  refreshOperationsWorkSnapshot,
  restoreDarkMode,
  restoreSidebarCollapsed,
  restoreSidebarWidth,
  showLibrary,
  syncSidebarShellState,
  updateSaveState,
  windowRef,
}) {
  for (const select of filterSelects) enhanceSelect(select);
  restoreDarkMode();
  restoreSidebarCollapsed();
  restoreSidebarWidth();
  attachSidebarResize();
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
