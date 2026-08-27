const SELECTORS = Object.freeze({
  sidebar: "#sidebar",
  sidebarScrim: "#sidebar-scrim",
  mobileMenuButton: "#mobile-menu-button",
  sidebarCloseButton: "#sidebar-close-button",
  sidebarCollapseButton: "#sidebar-collapse-button",
  themeToggleButton: "#theme-toggle-button",
  sidebarExpandButton: "#sidebar-expand-button",
  changesSection: "#changes-section",
  changesCount: "#changes-count",
  changesStatus: "#changes-status",
  changesList: "#changes-list",
  changesSaveAll: "#changes-save-all",
  changesDiscardAll: "#changes-discard-all",
  lintOpenButton: "#lint-open",
  lintSummary: "#lint-summary",
  lintModal: "#lint-modal",
  lintBackdrop: "#lint-backdrop",
  lintModalBody: "#lint-modal-body",
  lintModalClose: "#lint-modal-close",
  gitSection: "#git-section",
  gitStatusText: "#git-status-text",
  gitCommitButton: "#git-commit-button",
  gitPullButton: "#git-pull-button",
  gitCommitModal: "#git-commit-modal",
  gitCommitBackdrop: "#git-commit-backdrop",
  gitCommitForm: "#git-commit-form",
  gitCommitFiles: "#git-commit-files",
  gitCommitMessage: "#git-commit-message",
  gitCommitCancel: "#git-commit-cancel",
  gitCommitSubmit: "#git-commit-submit",
  cancelCommitButton: "[data-action='cancel-commit']",
  gitResult: "#git-result",
  operationsHomeButton: "#operations-home-button",
  searchForm: "#search-form",
  searchInput: "#search-input",
  domainFilter: "#domain-filter",
  typeFilter: "#type-filter",
  systemFilter: "#system-filter",
  tagFilter: "#tag-filter",
  filtersSection: "#filters-section",
  filterCount: "#filter-count",
  clearFiltersButton: "#clear-filters-button",
  helpModal: "#help-modal",
  helpBackdrop: "#help-backdrop",
  helpClose: "#help-close",
  helpButton: "#help-button",
  documentList: "#document-list",
  pageShell: ".page-shell",
  documentRowTemplate: "#document-row-template",
  mobileTitle: "#mobile-title",
  editorInlineStatus: "#editor-inline-status",
  editorSaveState: "#editor-save-state",
  editorDiscardButton: "#editor-discard-button",
  editorSaveButton: "#editor-save-button",
  documentTitle: "#document-title",
  documentPath: "#document-path",
  editor: "#editor",
  editorView: "#editor-view",
  renderedView: "#rendered-view",
  viewToggleButton: "#view-toggle-button",
  docMenuButton: "#doc-menu-button",
  newDocForm: "#new-doc-form",
  newDocPath: "#new-doc-path",
  newDocTitle: "#new-doc-title",
  newDocType: "#new-doc-type",
  newDocSummary: "#new-doc-summary",
  cancelCreateButton: "[data-action='cancel-create']",
  tasksNavButton: "#tasks-nav-button",
  tasksNavSubmenu: "#tasks-nav-submenu",
  docContextReturn: "#doc-context-return",
  docState: "#doc-state",
  taskPanel: "#task-panel",
  taskPanelTitle: "#task-panel-title",
  taskPanelBody: "#task-panel-body",
  taskPanelClose: "#task-panel-close",
  taskModalBackdrop: "#task-modal-backdrop",
  cardPanel: "#card-panel",
  cardPanelTitle: "#card-panel-title",
  cardPanelBody: "#card-panel-body",
  cardPanelClose: "#card-panel-close",
  cardModalBackdrop: "#card-modal-backdrop",
  diffModal: "#diff-modal",
  diffTitle: "#diff-title",
  diffBody: "#diff-body",
  diffBackdrop: "#diff-backdrop",
  diffClose: "#diff-close",
  lightbox: "#lightbox",
  lightboxImg: "#lightbox-img",
  lightboxCaption: "#lightbox-caption",
  quickNav: "#quick-nav",
  quickNavInput: "#quick-nav-input",
  quickNavResults: "#quick-nav-results",
  quickNavBackdrop: "#quick-nav-backdrop",
});

export function queryAppDom(documentRef) {
  const dom = { body: documentRef.body };
  for (const [name, selector] of Object.entries(SELECTORS)) {
    dom[name] = documentRef.querySelector(selector);
  }
  dom.workspaceNavButtons = [
    ...documentRef.querySelectorAll("[data-workspace-view]"),
  ];
  dom.tasksNavSectionButtons = [
    ...documentRef.querySelectorAll(
      "#tasks-nav-submenu [data-tasks-section]",
    ),
  ];
  return dom;
}

export function bindAppDomEvents(context) {
  const { documentRef, dom, handlers, windowRef } = context;
  dom.lintOpenButton.addEventListener("click", handlers.openLintReport);
  dom.lintBackdrop.addEventListener("click", handlers.hideLintModal);
  dom.lintModalClose.addEventListener("click", handlers.hideLintModal);
  dom.gitPullButton.addEventListener("click", handlers.gitPull);
  dom.helpBackdrop.addEventListener("click", handlers.hideHelpModal);
  dom.helpClose.addEventListener("click", handlers.hideHelpModal);
  dom.helpButton?.addEventListener("click", handlers.showHelpModal);
  dom.taskPanelClose.addEventListener("click", handlers.closeTaskPanel);
  dom.taskModalBackdrop.addEventListener("click", handlers.closeTaskPanel);
  dom.cardPanelClose.addEventListener("click", handlers.closeCardPanel);
  dom.cardModalBackdrop?.addEventListener(
    "click",
    handlers.closeCardPanel,
  );
  documentRef.addEventListener(
    "keydown",
    handlers.handleWorkspaceEntityModalKeydown,
  );
  windowRef.addEventListener(
    "popstate",
    handlers.scheduleCurrentBrowserLocation,
  );
  windowRef.addEventListener(
    "hashchange",
    handlers.scheduleCurrentBrowserLocation,
  );
  dom.mobileMenuButton.addEventListener("click", handlers.openSidebar);
  dom.sidebarCloseButton.addEventListener("click", handlers.closeSidebar);
  dom.sidebarScrim?.addEventListener("click", handlers.closeSidebar);
  dom.sidebarCollapseButton.addEventListener("click", () =>
    handlers.setSidebarCollapsed(true),
  );
  dom.sidebarExpandButton.addEventListener("click", () =>
    handlers.setSidebarCollapsed(false),
  );
  dom.themeToggleButton.addEventListener("click", handlers.toggleDarkMode);
  dom.changesSaveAll.addEventListener("click", handlers.saveAllDrafts);
  dom.changesDiscardAll.addEventListener("click", handlers.discardAllDrafts);
  dom.gitCommitButton.addEventListener("click", handlers.openCommitForm);
  dom.gitCommitCancel.addEventListener("click", handlers.closeCommitForm);
  dom.gitCommitBackdrop.addEventListener("click", handlers.closeCommitForm);
  dom.cancelCommitButton.addEventListener(
    "click",
    handlers.closeCommitForm,
  );
  dom.gitCommitForm.addEventListener("submit", handlers.submitCommitForm);
  for (const button of dom.workspaceNavButtons) {
    button.addEventListener("click", () => handlers.workspaceButton(button));
  }
  dom.tasksNavButton?.addEventListener("click", handlers.toggleTasksNav);
  for (const button of dom.tasksNavSectionButtons) {
    button.addEventListener("click", () =>
      handlers.openTasksSection(button.dataset.tasksSection || "queue"),
    );
  }
  documentRef.addEventListener(
    "dataops:navigate-workspace",
    handlers.navigateWorkspaceEvent,
  );
  dom.editorSaveButton.addEventListener("click", handlers.saveCurrentDocument);
  dom.editorDiscardButton.addEventListener("click", handlers.discardDraft);
  dom.viewToggleButton.addEventListener("click", handlers.toggleViewMode);
  dom.docMenuButton.addEventListener("click", handlers.openDocMenu);
  dom.documentTitle.addEventListener("input", handlers.syncTitleToMarkdown);
  dom.documentTitle.addEventListener("keydown", handlers.documentTitleKeydown);
  windowRef.addEventListener("resize", handlers.resizeDocumentTitle);
  windowRef.addEventListener("resize", handlers.syncSidebarShellState);
  dom.editor.addEventListener("input", handlers.editorInput);
  dom.searchForm.addEventListener("submit", handlers.searchSubmit);
  dom.searchInput.addEventListener("input", handlers.searchInput);
  dom.domainFilter.addEventListener("change", handlers.onFilterChange);
  dom.typeFilter.addEventListener("change", handlers.onFilterChange);
  dom.systemFilter.addEventListener("change", handlers.onFilterChange);
  dom.tagFilter.addEventListener("change", handlers.onFilterChange);
  dom.clearFiltersButton.addEventListener("click", handlers.clearDocumentFilters);
  dom.newDocForm.addEventListener("submit", handlers.createDocument);
  dom.cancelCreateButton.addEventListener("click", handlers.showLibrary);
  documentRef.addEventListener("click", handlers.closeCustomSelects);
  documentRef.addEventListener("paste", handlers.handleClipboardPaste);
  documentRef.addEventListener("keydown", handlers.globalKeydown);
  dom.diffBackdrop.addEventListener("click", handlers.closeDiff);
  dom.diffClose.addEventListener("click", handlers.closeDiff);
  dom.lightbox.addEventListener("click", handlers.lightboxClick);
  dom.quickNavBackdrop.addEventListener("click", handlers.closeQuickNav);
  dom.quickNavInput.addEventListener("input", handlers.quickNavInput);
  dom.quickNavInput.addEventListener("keydown", handlers.quickNavKeydown);
}
