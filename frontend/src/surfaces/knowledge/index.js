import { createKnowledgeCatalog } from "./catalog.js";
import { createKnowledgeFilters } from "./filters.js";
import { createKnowledgeMenus } from "./menus.js";
import { createKnowledgeNavigation } from "./navigation.js";
import { createProcessDocsSurface } from "./process-docs.js";
import { createKnowledgeReferences } from "./references.js";
import { createKnowledgeSearch } from "./search.js";
import { createKnowledgeTree } from "./tree.js";

export function createKnowledgeSurface(context) {
  const api = {};
  const scrollPositions = new Map();
  const invoke = (name) => (...args) => api[name](...args);

  Object.assign(
    api,
    createKnowledgeFilters(context, {
      refreshDocuments: invoke("refreshDocuments"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeTree(context, {
      openDocument: invoke("openDocument"),
      openFolderMenu: invoke("openFolderMenu"),
      refreshDocuments: invoke("refreshDocuments"),
      scrollPositions,
      setFolderUrl: invoke("setFolderUrl"),
      setHighlightedText: invoke("setHighlightedText"),
      syncLibraryPageTitle: invoke("syncLibraryPageTitle"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeCatalog(context, {
      openDocument: invoke("openDocument"),
      populateFilterOptions: invoke("populateFilterOptions"),
      rebuildDocumentIdMap: invoke("rebuildDocumentIdMap"),
      refreshDocuments: invoke("refreshDocuments"),
      relativeTime: invoke("relativeTime"),
    }),
  );
  Object.assign(
    api,
    createProcessDocsSurface(context, {
      refreshDocuments: invoke("refreshDocuments"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeSearch(context, {
      filterDocuments: invoke("filterDocuments"),
      openDocument: invoke("openDocument"),
      renderDocuments: invoke("renderDocuments"),
      renderTree: invoke("renderTree"),
      setHighlightedText: invoke("setHighlightedText"),
      syncLibraryPageTitle: invoke("syncLibraryPageTitle"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeMenus(context, {
      loadDocuments: invoke("loadDocuments"),
      showLibrary: invoke("showLibrary"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeNavigation(context, {
      captureScrollPosition: invoke("captureScrollPosition"),
      filterDocuments: invoke("filterDocuments"),
      pushRecentlyViewed: invoke("pushRecentlyViewed"),
      refreshDocuments: invoke("refreshDocuments"),
      renderPinned: invoke("renderPinned"),
      renderRecentlyViewed: invoke("renderRecentlyViewed"),
      renderTree: invoke("renderTree"),
      scrollPositions,
      updateCurrentTreeSelection: invoke("updateCurrentTreeSelection"),
      updatePinButton: invoke("updatePinButton"),
    }),
  );
  Object.assign(
    api,
    createKnowledgeReferences(context, {
      apiUrl: context.apiUrl,
      openDocument: invoke("openDocument"),
      resolveDocReference: invoke("resolveDocReference"),
    }),
  );

  api.labelForPath = (path) => {
    const known = context.knowledgeState.allDocuments.find(
      (document) => document.path === path,
    );
    return known?.title || context.basename(path);
  };
  api.getAllDocuments = () => context.knowledgeState.allDocuments;
  api.getSelectedFolder = () => context.knowledgeState.selectedFolder;
  api.setSelectedFolder = (path) => {
    context.knowledgeState.selectedFolder = path;
  };

  return {
    clearDocumentFilters: api.clearDocumentFilters,
    clearSelection: api.clearSelection,
    closeQuickNav: api.closeQuickNav,
    closeCustomSelects: api.closeCustomSelects,
    docPathFromLocation: api.docPathFromLocation,
    enhanceSelect: api.enhanceSelect,
    filterDocuments: api.filterDocuments,
    folderExists: api.folderExists,
    folderPathFromLocation: api.folderPathFromLocation,
    fetchBacklinksForCurrentDoc: api.fetchBacklinksForCurrentDoc,
    getAllDocuments: api.getAllDocuments,
    getSelectedFolder: api.getSelectedFolder,
    humanizeOptionLabel: api.humanizeOptionLabel,
    handleQuickNavKeydown: api.handleQuickNavKeydown,
    labelForPath: api.labelForPath,
    loadDocuments: api.loadDocuments,
    localDocPathFromHref: api.localDocPathFromHref,
    onFilterChange: api.onFilterChange,
    openDocument: api.openDocument,
    openDocMenu: api.openDocMenu,
    openQuickNav: api.openQuickNav,
    populateFilterOptions: api.populateFilterOptions,
    refreshDocuments: api.refreshDocuments,
    renderDocsSurface: api.renderDocsSurface,
    renderGithubRawFooter: api.renderGithubRawFooter,
    renderLoomBlock: api.renderLoomBlock,
    renderProcessesSurface: api.renderProcessesSurface,
    renderRelatedDocsBlock: api.renderRelatedDocsBlock,
    renderUnifiedSearchSurface: api.renderUnifiedSearchSurface,
    renderWarningsBlock: api.renderWarningsBlock,
    resolveDocReference: api.resolveDocReference,
    resolveMarkdownDocLink: api.resolveMarkdownDocLink,
    restoreFiltersExpanded: api.restoreFiltersExpanded,
    setFiltersExpanded: api.setFiltersExpanded,
    setFolderUrl: api.setFolderUrl,
    setSelectedFolder: api.setSelectedFolder,
    showLibrary: api.showLibrary,
    syncLibraryPageTitle: api.syncLibraryPageTitle,
    toggleCurrentDocPin: api.toggleCurrentDocPin,
    updateFilterSummary: api.updateFilterSummary,
    updateQuickNavMatches: api.updateQuickNavMatches,
    visibleDocUrl: api.visibleDocUrl,
  };
}
