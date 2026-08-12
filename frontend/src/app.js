import {
  addDaysIso,
  buildHomeAttentionItems,
  canonicalWorkspaceUrl,
  cardsHeaderViewModel,
  compareIsoDate,
  dedupeWorkTasks,
  deriveHomeWorkState,
  formatHomeCalendarDate,
  formatHomeShortDate,
  formatHomeTaskTiming,
  formatTaskDateMeta,
  groupCardItemsByStage,
  hasApprovedArtifactEvidence,
  hasTaskFileEvidence,
  isActiveWorkBundle,
  isArchivedWorkBundle,
  isBeforeIsoDate,
  isFollowUpDueTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  isoDayDistance,
  parseWorkspaceHash,
  summarizeBundleProgress,
  taskDate,
  taskProofState,
  taskRequiresApprovedArtifact,
  tasksFromWorkPayload,
  tasksSectionTitle,
  todayIsoDate,
  workBundleTitle,
  workTaskTitle,
  workflowTaskGroups,
  workspaceHashPath,
  workspaceRouteFor,
} from "./core/workspace.js";
import { createFinanceSurface } from "./surfaces/finance/index.js";
import { createHomeSurface } from "./surfaces/home.js";
import {
  createAdminSurface,
  createOperationsSurface,
} from "./surfaces/operations/index.js";
import { createPlanningSurface } from "./surfaces/planning.js";
import { createTasksSurface } from "./surfaces/tasks/index.js";
import { createWorkDetailSurface } from "./surfaces/work-detail/index.js";
import { createKnowledgeSurface } from "./surfaces/knowledge/index.js";
import { createDocumentEditor } from "./surfaces/document-editor/index.js";
import { createApiClient, resolveApiBase } from "./shell/api.js";
import { createFeedbackShell } from "./shell/feedback.js";
import { createPreferencesShell } from "./shell/preferences.js";
import { createAccountShell } from "./shell/account.js";
import { createNotificationsShell } from "./shell/notifications.js";
import { createNavigationShell } from "./shell/navigation.js";
import { initializeAppShell } from "./shell/bootstrap.js";
let knowledgeSurface;
let documentEditorSurface;
let navigationShell;

function getActiveWorkspaceRoute() {
  return navigationShell?.getActiveWorkspaceRoute() || null;
}
function getActiveWorkspaceRouteToken() {
  return navigationShell?.getActiveWorkspaceRouteToken() || 0;
}
function getPendingLegacyRoute() {
  return navigationShell?.getPendingLegacyRoute() || null;
}
function getWorkspaceEntityState() {
  return navigationShell?.getWorkspaceEntityState() || null;
}
function setWorkspaceEntityState(snapshot) {
  navigationShell?.setWorkspaceEntityState(snapshot);
}
function isWorkspaceRouteFresh(token) {
  return navigationShell?.isWorkspaceRouteFresh(token) || false;
}
function navigateCanonicalWorkspace(...args) {
  return navigationShell.navigateCanonicalWorkspace(...args);
}
function applyWorkspaceRoute(...args) {
  return navigationShell.applyWorkspaceRoute(...args);
}
function beginDocumentNavigation(...args) {
  return navigationShell.beginDocumentNavigation(...args);
}

function knowledgeCall(name, args) {
  return knowledgeSurface[name](...args);
}

function editorCall(name, args) {
  return documentEditorSurface[name](...args);
}

function loadDocuments(...args) { return knowledgeCall("loadDocuments", args); }
function refreshDocuments(...args) { return knowledgeCall("refreshDocuments", args); }
function renderDocsSurface(...args) { return knowledgeCall("renderDocsSurface", args); }
function renderProcessesSurface(...args) { return knowledgeCall("renderProcessesSurface", args); }
function renderUnifiedSearchSurface(...args) { return knowledgeCall("renderUnifiedSearchSurface", args); }
function resolveDocReference(...args) { return knowledgeCall("resolveDocReference", args); }
function openDocument(...args) { return knowledgeCall("openDocument", args); }
function localDocPathFromHref(...args) { return knowledgeCall("localDocPathFromHref", args); }
function docPathFromLocation(...args) { return knowledgeCall("docPathFromLocation", args); }
function folderPathFromLocation(...args) { return knowledgeCall("folderPathFromLocation", args); }
function folderExists(...args) { return knowledgeCall("folderExists", args); }
function setFolderUrl(...args) { return knowledgeCall("setFolderUrl", args); }
function showLibrary(...args) { return knowledgeCall("showLibrary", args); }
function syncLibraryPageTitle(...args) { return knowledgeCall("syncLibraryPageTitle", args); }
function clearSelection(...args) { return knowledgeCall("clearSelection", args); }
function clearDocumentFilters(...args) { return knowledgeCall("clearDocumentFilters", args); }
function enhanceSelect(...args) { return knowledgeCall("enhanceSelect", args); }
function humanizeOptionLabel(...args) {
  return knowledgeCall("humanizeOptionLabel", args);
}
function populateFilterOptions(...args) { return knowledgeCall("populateFilterOptions", args); }
function updateCustomSelect(...args) { return knowledgeCall("updateCustomSelect", args); }
function closeCustomSelects(...args) { return knowledgeCall("closeCustomSelects", args); }
function onFilterChange(...args) { return knowledgeCall("onFilterChange", args); }
function setFiltersExpanded(...args) { return knowledgeCall("setFiltersExpanded", args); }
function restoreFiltersExpanded(...args) { return knowledgeCall("restoreFiltersExpanded", args); }
function updateFilterSummary(...args) { return knowledgeCall("updateFilterSummary", args); }
function toggleCurrentDocPin(...args) { return knowledgeCall("toggleCurrentDocPin", args); }
function openDocMenu(...args) { return knowledgeCall("openDocMenu", args); }
function openQuickNav(...args) { return knowledgeCall("openQuickNav", args); }
function labelForPath(...args) { return knowledgeCall("labelForPath", args); }
function resolveMarkdownDocLink(...args) { return knowledgeCall("resolveMarkdownDocLink", args); }
function visibleDocUrl(...args) { return knowledgeCall("visibleDocUrl", args); }

function saveCurrentDocument(...args) { return editorCall("saveCurrentDocument", args); }
function discardDraft(...args) { return editorCall("discardDraft", args); }
function createDocument(...args) { return editorCall("createDocument", args); }
function syncTitleToMarkdown(...args) { return editorCall("syncTitleToMarkdown", args); }
function resizeDocumentTitle(...args) { return editorCall("resizeDocumentTitle", args); }
function storeDraft(...args) { return editorCall("storeDraft", args); }
function updateSaveState(...args) { return editorCall("updateSaveState", args); }
function canLeaveDocumentEditor(...args) { return editorCall("canLeaveDocumentEditor", args); }
function showCreate(...args) { return editorCall("showCreate", args); }
function setSaveState(...args) { return editorCall("setSaveState", args); }
function titleFromMarkdown(...args) { return editorCall("titleFromMarkdown", args); }
function listDraftPaths(...args) { return editorCall("listDraftPaths", args); }
function refreshChangesPanel(...args) { return editorCall("refreshChangesPanel", args); }
function saveAllDrafts(...args) { return editorCall("saveAllDrafts", args); }
function discardAllDrafts(...args) { return editorCall("discardAllDrafts", args); }
function renameCurrentDoc(...args) { return editorCall("renameCurrentDoc", args); }
function deleteCurrentDoc(...args) { return editorCall("deleteCurrentDoc", args); }
function refreshGitStatus(...args) { return editorCall("refreshGitStatus", args); }
function updateGithubLink(...args) { return editorCall("updateGithubLink", args); }
function gitPull(...args) { return editorCall("gitPull", args); }
function openCommitForm(...args) { return editorCall("openCommitForm", args); }
function closeCommitForm(...args) { return editorCall("closeCommitForm", args); }
function submitCommitForm(...args) { return editorCall("submitCommitForm", args); }
function toggleViewMode(...args) { return editorCall("toggleViewMode", args); }
function enterRenderedMode(...args) { return editorCall("enterRenderedMode", args); }
function updateViewToggleAvailability(...args) { return editorCall("updateViewToggleAvailability", args); }
function emptyNote(...args) { return editorCall("emptyNote", args); }
function escapeRegex(...args) { return editorCall("escapeRegex", args); }
function openLintReport(...args) { return editorCall("openLintReport", args); }
function handleClipboardPaste(...args) { return editorCall("handleClipboardPaste", args); }
function closeDiff(...args) { return editorCall("closeDiff", args); }
function closeLightbox(...args) { return editorCall("closeLightbox", args); }
function closeQuickNav(...args) { return knowledgeCall("closeQuickNav", args); }
function updateQuickNavMatches(...args) {
  return knowledgeCall("updateQuickNavMatches", args);
}

const API_BASE = resolveApiBase({ documentRef: document, windowRef: window });
const { apiUrl, request } = createApiClient({
  apiBase: API_BASE,
  fetchImpl: (...args) => fetch(...args),
  storage: localStorage,
});

const body = document.body;
const sidebar = document.querySelector("#sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const sidebarResize = document.querySelector("#sidebar-resize");
const mobileMenuButton = document.querySelector("#mobile-menu-button");
const sidebarCloseButton = document.querySelector("#sidebar-close-button");
const sidebarCollapseButton = document.querySelector(
  "#sidebar-collapse-button",
);
const themeToggleButton = document.querySelector("#theme-toggle-button");
const sidebarExpandButton = document.querySelector("#sidebar-expand-button");
const changesSection = document.querySelector("#changes-section");
const changesToggle = document.querySelector("#changes-toggle");
const changesCount = document.querySelector("#changes-count");
const changesList = document.querySelector("#changes-list");
const changesSaveAll = document.querySelector("#changes-save-all");
const changesDiscardAll = document.querySelector("#changes-discard-all");
const lintOpenButton = document.querySelector("#lint-open");
const lintSummary = document.querySelector("#lint-summary");
const lintModal = document.querySelector("#lint-modal");
const lintBackdrop = document.querySelector("#lint-backdrop");
const lintModalBody = document.querySelector("#lint-modal-body");
const lintModalClose = document.querySelector("#lint-modal-close");
lintOpenButton.addEventListener("click", openLintReport);
lintBackdrop.addEventListener("click", () => {
  lintModal.hidden = true;
});
lintModalClose.addEventListener("click", () => {
  lintModal.hidden = true;
});

const gitSection = document.querySelector("#git-section");
const gitStatusText = document.querySelector("#git-status-text");
const gitCommitButton = document.querySelector("#git-commit-button");
const gitPullButton = document.querySelector("#git-pull-button");
gitPullButton.addEventListener("click", gitPull);
const gitCommitModal = document.querySelector("#git-commit-modal");
const gitCommitBackdrop = document.querySelector("#git-commit-backdrop");
const gitCommitForm = document.querySelector("#git-commit-form");
const gitCommitFiles = document.querySelector("#git-commit-files");
const gitCommitMessage = document.querySelector("#git-commit-message");
const gitCommitCancel = document.querySelector("#git-commit-cancel");
const gitCommitSubmit = document.querySelector("#git-commit-submit");
const gitResult = document.querySelector("#git-result");
const mobileNewButton = document.querySelector("#mobile-new-button");
const operationsHomeButton = document.querySelector("#operations-home-button");
const newDocumentButton = document.querySelector("#new-document-button");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search-input");
const domainFilter = document.querySelector("#domain-filter");
const typeFilter = document.querySelector("#type-filter");
const systemFilter = document.querySelector("#system-filter");
const tagFilter = document.querySelector("#tag-filter");
const filterToggle = document.querySelector("#filter-toggle");
const filtersSection = document.querySelector("#filters-section");
const filterCount = document.querySelector("#filter-count");
const filterRow = document.querySelector("#filter-row");
const docTree = document.querySelector("#doc-tree");
const recentList = document.querySelector("#recent-list");
const recentlyViewedSection = document.querySelector(
  "#recently-viewed-section",
);
const recentlyViewedList = document.querySelector("#recently-viewed-list");

const helpModal = document.querySelector("#help-modal");
const helpBackdrop = document.querySelector("#help-backdrop");
const helpClose = document.querySelector("#help-close");
const helpButton = document.querySelector("#help-button");
helpBackdrop.addEventListener("click", () => {
  helpModal.hidden = true;
});
helpClose.addEventListener("click", () => {
  helpModal.hidden = true;
});
helpButton?.addEventListener("click", () => {
  helpModal.hidden = false;
  helpClose.focus();
});
const documentList = document.querySelector("#document-list");
const {
  confirmDialog,
  renderEntityLoadState,
  renderEntityLoadingState,
  reportError,
  showErrorToast,
  showUndoToast,
} = createFeedbackShell({
  clearTimeoutImpl: clearTimeout,
  documentRef: document,
  HTMLElementClass: HTMLElement,
  labelizeWorkValue,
  requestAnimationFrameImpl: requestAnimationFrame,
  setStatus,
  setTimeoutImpl: setTimeout,
});
const {
  canLeaveFinanceSurface,
  renderBookkeepingSurface,
  renderMailingExportsSurface,
  renderSponsorCrmSurface,
} = createFinanceSurface({
  documentList,
  escapeHtml,
  formatTaskDateMeta,
  getPendingLegacyRoute,
  humanizeOptionLabel,
  isWorkspaceRouteFresh,
  navigateCanonicalWorkspace,
  request,
  renderEntityLoadState,
  setPageTitle,
  workApiUrl,
});
const { renderCalendarSurface, renderNewsletterSurface } =
  createPlanningSurface({
    documentList,
    escapeHtml,
    request,
    setPageTitle,
    workApiUrl,
  });
const pageShell = document.querySelector(".page-shell");
const documentRowTemplate = document.querySelector("#document-row-template");
const breadcrumb = document.querySelector("#breadcrumb");
const toolbarTitle = document.querySelector("#toolbar-title");
const mobileTitle = document.querySelector("#mobile-title");
const statusText = document.querySelector("#status-text");
const libraryTitle = document.querySelector("#library-title");
const clearSelectionButton = document.querySelector("#clear-selection-button");
const backButton = document.querySelector("#back-button");
const saveState = document.querySelector("#save-state");
const discardButton = document.querySelector("#discard-button");
const saveButton = document.querySelector("#save-button");
const documentTitle = document.querySelector("#document-title");
const documentPath = document.querySelector("#document-path");
const editor = document.querySelector("#editor");
const editorView = document.querySelector("#editor-view");
const renderedView = document.querySelector("#rendered-view");
const viewToggleButton = document.querySelector("#view-toggle-button");
const docMenuButton = document.querySelector("#doc-menu-button");
const docPinButton = document.querySelector("#doc-pin-button");
const pinnedSection = document.querySelector("#pinned-section");
const pinnedList = document.querySelector("#pinned-list");
docPinButton.addEventListener("click", toggleCurrentDocPin);
const newDocForm = document.querySelector("#new-doc-form");
const newDocPath = document.querySelector("#new-doc-path");
const newDocTitle = document.querySelector("#new-doc-title");
const newDocType = document.querySelector("#new-doc-type");
const newDocSummary = document.querySelector("#new-doc-summary");
const workspaceNavButtons = [
  ...document.querySelectorAll("[data-workspace-view]"),
];
const tasksNavButton = document.querySelector("#tasks-nav-button");
const tasksNavSubmenu = document.querySelector("#tasks-nav-submenu");
const tasksNavSectionButtons = [
  ...document.querySelectorAll("#tasks-nav-submenu [data-tasks-section]"),
];
const docContextReturn = document.querySelector("#doc-context-return");
const {
  attachSidebarResize,
  closeSidebar,
  isMobileShell,
  openSidebar,
  restoreDarkMode,
  restoreSidebarCollapsed,
  restoreSidebarWidth,
  setDarkMode,
  setSidebarCollapsed,
  syncSidebarShellState,
  syncThemeToggleLabel,
} = createPreferencesShell({
  body,
  documentRef: document,
  getMobileWorkBellButton: () =>
    document.querySelector("#mobile-work-bell-button"),
  HTMLElementClass: HTMLElement,
  matchMedia: (query) => window.matchMedia(query),
  mobileMenuButton,
  mobileNewButton,
  pageShell,
  sidebar,
  sidebarExpandButton,
  sidebarResize,
  sidebarScrim,
  storage: localStorage,
  themeToggleButton,
});
const {
  activeWorkOwner,
  activeWorkOwnerId,
  closeSettingsMenu,
  currentOperatorFromPayload,
  getAccountIdentityState,
  isSettingsMenuOpen,
  readLocalPreviewContext,
  refreshAccountIdentity,
} = createAccountShell({
  canLeaveCurrentDocument,
  closeNotifications: (...args) => closeWorkBellPanel(...args),
  documentRef: document,
  fetchImpl: (...args) => fetch(...args),
  getActiveWorkspaceView: () => activeWorkspaceView,
  gitCommitButton,
  gitPullButton,
  HTMLElementClass: HTMLElement,
  isOperationsHomeVisible,
  locationRef: window.location,
  refreshDocuments,
  showWorkspaceSurface,
  syncThemeToggleLabel,
  themeToggleButton,
});
const notificationsShell = createNotificationsShell({
  closeSettingsMenu,
  documentRef: document,
  encodeURIComponentImpl: encodeURIComponent,
  formatHomeShortDate,
  formatTaskDateMeta,
  HTMLElementClass: HTMLElement,
  isWorkspaceRouteFresh,
  isoDayDistance,
  navigateCanonicalWorkspace,
  openTaskPanel: (...args) => openTaskPanel(...args),
  parseWorkspaceHash,
  request,
  todayIsoDate,
  workApiUrl,
});
const {
  closeWorkBellPanel,
  openWorkBellPanel,
  refreshWorkBell,
} = notificationsShell;
notificationsShell.bindToggle(canLeaveCurrentDocument);
const homeSurfaceState = {
  get workSnapshot() {
    return operationsWorkSnapshot;
  },
  set workSnapshot(snapshot) {
    operationsWorkSnapshot = snapshot;
  },
  get recurringSnapshot() {
    return operationsRecurringSnapshot;
  },
  get qualitySnapshot() {
    return operationsQualitySnapshot;
  },
  set qualitySnapshot(snapshot) {
    operationsQualitySnapshot = snapshot;
  },
  get accountIdentity() {
    return getAccountIdentityState();
  },
};
const {
  buildNeedsActionLane,
  buildOperationsHomeModel,
  buildProcessQualityModel,
  buildTaskProcessQualityFindings,
  refreshOperationsQualitySnapshot,
  refreshOperationsWorkSnapshot,
  renderOperationsHome,
} = createHomeSurface({
  activeWorkOwner,
  activeWorkOwnerId,
  addDaysIso,
  allWorkTasks,
  buildHomeAttentionItems,
  buildOperationsFutureSections,
  buildOperationsReferenceLinks,
  bundlesFromWorkPayload,
  clearSelectionButton,
  currentOperatorIdForTodayScope,
  currentOperatorIdFromPayload,
  dedupeOperationItems,
  deriveHomeWorkState,
  documentList,
  emptyOperationsQualitySnapshot,
  emptyOperationsWorkSnapshot,
  formatHomeCalendarDate,
  formatHomeTaskTiming,
  isActiveWorkBundle,
  isOpenWorkTask,
  isOperationsHomeVisible,
  isWorkflowTemplateDoc,
  isWorkspaceRouteFresh,
  libraryTitle,
  listDraftPaths,
  navigateCanonicalWorkspace,
  normalizeOperationsRecurringSnapshot,
  normalizeOperationsWorkSnapshot,
  normalizeTemplateMatchValue,
  openQuickTaskForm: (...args) => openQuickTaskForm(...args),
  openQuickWorkflowForm: (...args) => openQuickWorkflowForm(...args),
  openTaskPanel: (...args) => openTaskPanel(...args),
  operationItemFromBundle,
  operationItemFromTask,
  operationItemFromTemplate,
  readLocalPreviewContext,
  refreshAccountIdentity,
  refreshDocuments,
  refreshWorkBell,
  renderHonestState,
  renderOperationsRuntimeState,
  request,
  resolveBundleLabel: (...args) => resolveBundleLabel(...args),
  resolveDocReference,
  setPageTitle,
  setStatus,
  settledPayload,
  state: homeSurfaceState,
  summarizeWorkflowTemplate,
  tasksFromWorkPayload,
  todayIsoDate,
  usersFromWorkPayload,
  workApiUrl,
  workBundleTitle,
  workTaskTitle,
  workflowPriority,
});
const {
  refreshUsersSurface,
  renderAdminSurface,
  renderAdminSurfaceView,
  renderUsersSurfaceView,
} = createAdminSurface({
  apiUrl,
  buildOperationsHomeModel,
  clearSelectionButton,
  currentOperatorIdFromPayload,
  documentList,
  getActiveWorkspaceView: () => activeWorkspaceView,
  getOperationsQualitySnapshot: () => operationsQualitySnapshot,
  getOperationsRecurringSnapshot: () => operationsRecurringSnapshot,
  getOperationsWorkSnapshot: () => operationsWorkSnapshot,
  libraryTitle,
  listDraftPaths,
  refreshDocuments,
  renderHonestState,
  renderSurfaceHeader,
  request,
  setPageTitle,
  setStatus,
  settledPayload,
  showCreate,
  showErrorToast,
  showWorkspaceSurface,
  surfaceDescription,
  surfaceStatusText,
  usersFromWorkPayload,
  workApiUrl,
});
const taskPanel = document.querySelector("#task-panel");
const taskPanelTitle = document.querySelector("#task-panel-title");
const taskPanelBody = document.querySelector("#task-panel-body");
const taskPanelClose = document.querySelector("#task-panel-close");
const taskModalBackdrop = document.querySelector("#task-modal-backdrop");
const bundlePanel = document.querySelector("#bundle-panel");
const bundlePanelTitle = document.querySelector("#bundle-panel-title");
const bundlePanelBody = document.querySelector("#bundle-panel-body");
const bundlePanelClose = document.querySelector("#bundle-panel-close");
const bundleModalBackdrop = document.querySelector("#bundle-modal-backdrop");
const workDetailState = {
  get workSnapshot() {
    return operationsWorkSnapshot;
  },
  get qualitySnapshot() {
    return operationsQualitySnapshot;
  },
  get assistantSnapshot() {
    return operationsAssistantSnapshot;
  },
};
const {
  closeBundlePanel,
  closeTaskPanel,
  dedupeArtifacts,
  defaultNextFollowUpDate,
  getTaskRouteContext,
  handleWorkspaceEntityModalKeydown,
  hydrateBundlePanel,
  hydrateTaskPanel,
  openBundlePanel,
  openTaskPanel,
  prepareBundlePanel,
  prepareTaskPanel,
  renderArtifactList,
  resetBundlePanel,
  resetTaskPanel,
  resolveAssigneeLabel,
  resolveBundleLabel,
  resolveTaskQueueRouteContext,
  setTaskRouteContextFromRoute,
} = createWorkDetailSurface({
  addDaysIso,
  body,
  buildTaskProcessQualityFindings,
  bundlePanel,
  bundlePanelBody,
  bundlePanelClose,
  bundlePanelTitle,
  escapeHtml,
  fetchResource: (url, options) => fetch(url, options),
  FOCUSABLE_SELECTOR:
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  formatTaskDateMeta,
  getActiveTasksSection: () => activeTasksSection,
  getActiveWorkspaceRoute,
  getActiveWorkspaceRouteToken,
  getActiveWorkspaceView: () => activeWorkspaceView,
  getAllDocuments: () => knowledgeState.allDocuments,
  getCurrentOperator: () => getAccountIdentityState().user,
  hasApprovedArtifactEvidence,
  hasTaskFileEvidence,
  isArchivedWorkBundle,
  isWorkspaceRouteFresh,
  labelizeWorkValue,
  localDocPathFromHref,
  navigateCanonicalWorkspace,
  openDocument,
  openQualityFinding,
  parseWorkspaceHash,
  promptUser: (message, initialValue) => window.prompt(message, initialValue),
  refreshDocuments,
  refreshOperationsWorkSnapshot,
  refreshWorkBell,
  renderEntityLoadState,
  renderTasksSurface: (documents, section) =>
    renderTasksSurface(documents, section),
  reportError,
  request,
  resolveDocReference,
  scheduleAnimationFrame: (callback) => requestAnimationFrame(callback),
  setStatus,
  settledPayload,
  showUndoToast,
  state: workDetailState,
  summarizeBundleProgress,
  taskDate,
  taskPanel,
  taskPanelBody,
  taskPanelClose,
  taskPanelTitle,
  taskProofState,
  taskRequiresApprovedArtifact,
  tasksFromWorkPayload,
  todayIsoDate,
  workApiUrl,
  workBundleTitle,
  workTaskTitle,
  workflowTaskGroups,
});
taskPanelClose.addEventListener("click", closeTaskPanel);
taskModalBackdrop.addEventListener("click", closeTaskPanel);
bundlePanelClose.addEventListener("click", closeBundlePanel);
bundleModalBackdrop?.addEventListener("click", closeBundlePanel);
document.addEventListener("keydown", handleWorkspaceEntityModalKeydown);
const tasksSurfaceState = {
  get workSnapshot() {
    return operationsWorkSnapshot;
  },
  get recurringSnapshot() {
    return operationsRecurringSnapshot;
  },
  get qualitySnapshot() {
    return operationsQualitySnapshot;
  },
};
const {
  confirmLeaveRuntimeDraft,
  openQuickTaskForm,
  openQuickWorkflowForm,
  recurringConfigTitle,
  refreshRuntimeTemplates,
  renderTasksSurface,
  resolveTemplateRouteEntity,
  setRuntimeTemplateRoute,
} = createTasksSurface({
  addBeforeUnloadListener: (listener) =>
    window.addEventListener("beforeunload", listener),
  allWorkTasks,
  buildOperationsHomeModel,
  cardsHeaderViewModel,
  clearSelectionButton,
  compareIsoDate,
  confirmDialog,
  countLabel,
  debounce,
  documentList,
  escapeHtml,
  formatTaskDateMeta,
  getActiveTasksSection: () => activeTasksSection,
  getActiveWorkspaceRoute,
  getActiveWorkspaceRouteToken,
  getAllDocuments: () => knowledgeState.allDocuments,
  getPendingLegacyRoute,
  getTaskRouteContext,
  getWorkspaceEntityState,
  groupCardItemsByStage,
  isArchivedWorkBundle,
  isFollowUpDueTask,
  isOpenWorkTask,
  isOperationsHomeVisible,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  isWorkspaceRouteFresh,
  libraryTitle,
  listDraftPaths,
  navigateCanonicalWorkspace,
  openDocument,
  openBundlePanel,
  openTaskPanel,
  operationItemFromBundle,
  referenceCountLabel,
  refreshDocuments,
  refreshOperationsRecurringSnapshot,
  refreshOperationsWorkSnapshot,
  renderArtifactsSurface: (...args) => renderArtifactsSurface(...args),
  renderAssistantsSurface: (...args) => renderAssistantsSurface(...args),
  renderEntityLoadState,
  renderHonestState,
  renderOperationsRuntimeState,
  renderSurfaceHeader,
  reportError,
  resolveAssigneeLabel,
  request,
  scheduleAnimationFrame: (callback) => requestAnimationFrame(callback),
  setPageTitle,
  setStatus,
  setWorkspaceEntityState,
  shellBody: body,
  showErrorToast,
  sortWorkTasks,
  state: tasksSurfaceState,
  surfaceDescription,
  summarizeBundleProgress,
  taskDate,
  taskNextActionLabel,
  taskProofState,
  taskSourceLabel,
  tasksSectionTitle,
  tasksFromWorkPayload,
  todayIsoDate,
  workApiUrl,
  workBundleTitle,
  workTaskTitle,
});

const knowledgeState = {
  allDocuments: [],
  visibleDocuments: [],
  selectedFolder: "",
  currentTreePath: "",
  documentIdMap: new Map(),
  searchController: null,
  activeSearchSources: [],
  docReturnContext: null,
};
const documentState = {
  currentDoc: null,
  currentParsed: null,
  currentWarnings: [],
  lastSavedContent: "",
  hasDraft: false,
};
const qualityFiltersState = {
  get value() {
    return operationsQualityFilters;
  },
  set value(filters) {
    operationsQualityFilters = filters;
  },
};

const diffModal = document.querySelector("#diff-modal");
const diffTitle = document.querySelector("#diff-title");
const diffBody = document.querySelector("#diff-body");
const lightbox = document.querySelector("#lightbox");
const lightboxImg = document.querySelector("#lightbox-img");
const lightboxCaption = document.querySelector("#lightbox-caption");
const quickNav = document.querySelector("#quick-nav");
const quickNavInput = document.querySelector("#quick-nav-input");
const quickNavResults = document.querySelector("#quick-nav-results");
let operationsWorkSnapshot = emptyOperationsWorkSnapshot();
let operationsRecurringSnapshot = emptyOperationsRecurringSnapshot();
let operationsArtifactSnapshot = emptyOperationsArtifactSnapshot();
let operationsAssistantSnapshot = emptyOperationsAssistantSnapshot();
let operationsQualitySnapshot = emptyOperationsQualitySnapshot();
let intakeState = {
  filter: "actionable",
  selectedId: null,
  items: [],
  bundles: [],
  loaded: false,
  error: "",
};
let intakeMutationState = {
  itemId: "",
  action: "",
  values: {},
  error: "",
  busy: false,
  status: "",
};
let assistantQueueState = { filter: "podcast", selectedJobId: null };
// Dedicated Users surface snapshot (#95). Kept separate from the home work
// snapshot so create/edit/disable mutations can refresh just this surface
// without forcing the whole operations snapshot to reload.
let operationsQualityFilters = {
  severity: "",
  category: "",
  workflow: "",
  document: "",
};
let activeWorkspaceView = "home";
// Tasks sub-section (Queue / Workflows / Templates / Assistants / Artifacts).
// Only consulted when activeWorkspaceView === "tasks". The legacy top-level
// views (queue, workflows, templates, assistants, artifacts) now live behind
// the Tasks tab and are routed through this internal state.
let activeTasksSection = "queue";

const operationsSurfaceState = {
  get workSnapshot() {
    return operationsWorkSnapshot;
  },
  get artifactSnapshot() {
    return operationsArtifactSnapshot;
  },
  set artifactSnapshot(snapshot) {
    operationsArtifactSnapshot = snapshot;
  },
  get assistantSnapshot() {
    return operationsAssistantSnapshot;
  },
  set assistantSnapshot(snapshot) {
    operationsAssistantSnapshot = snapshot;
  },
  get intake() {
    return intakeState;
  },
  set intake(snapshot) {
    intakeState = snapshot;
  },
  get intakeMutation() {
    return intakeMutationState;
  },
  set intakeMutation(snapshot) {
    intakeMutationState = snapshot;
  },
  get assistantQueue() {
    return assistantQueueState;
  },
  set assistantQueue(snapshot) {
    assistantQueueState = snapshot;
  },
  get workspaceEntity() {
    return getWorkspaceEntityState();
  },
  set workspaceEntity(snapshot) {
    setWorkspaceEntityState(snapshot);
  },
};

const {
  refreshIntakeSnapshot,
  refreshOperationsArtifactSnapshot,
  refreshOperationsAssistantSnapshot,
  renderArtifactsSurface,
  renderAssistantsSurface,
  renderInboxSurface,
  resolveIntakeRouteEntity,
} = createOperationsSurface({
  assistantJobsFromPayload,
  clearSelectionButton,
  cssEscape: (value) => CSS.escape(value),
  dedupeArtifacts,
  defaultNextFollowUpDate,
  documentList,
  escapeHtml,
  getActiveWorkspaceRoute,
  getActiveWorkspaceView: () => activeWorkspaceView,
  isMobileShell,
  isOperationsHomeVisible,
  isWorkspaceRouteFresh,
  libraryTitle,
  navigateCanonicalWorkspace,
  openBundlePanel,
  openTaskPanel,
  promptUser: (message) => window.prompt(message),
  refreshDocuments,
  renderEntityLoadState,
  renderHonestState,
  reportError,
  request,
  scheduleAnimationFrame: (callback) => requestAnimationFrame(callback),
  setPageTitle,
  setStatus,
  showCreate,
  state: operationsSurfaceState,
  tasksFromWorkPayload,
  todayIsoDate,
  workApiUrl,
  workTaskTitle,
});

const customSelects = [];

knowledgeSurface = createKnowledgeSurface({
  apiUrl,
  assistantJobsFromPayload,
  basename,
  buildOperationsHomeModel,
  buildOperationsReferenceLinks,
  buildProcessQualityModel,
  bundlesFromWorkPayload,
  canLeaveCurrentDocument,
  cleanPath,
  clearSelectionButton,
  closeSidebar,
  closeWorkBellPanel,
  confirmDialog,
  customSelects,
  diffBody,
  diffModal,
  diffTitle,
  docContextReturn,
  docMenuButton,
  docPinButton,
  docTree,
  documentList,
  documentPath,
  documentRowTemplate,
  documentState,
  documentTitle,
  draftKey: (...args) => documentEditorSurface.draftKey(...args),
  domainFilter,
  editor,
  editorView,
  emptyNote: (...args) => emptyNote(...args),
  enterRenderedMode: (...args) => enterRenderedMode(...args),
  escapeRegex,
  filterCount,
  filterRow,
  filterToggle,
  filtersSection,
  knowledgeState,
  getActiveTasksSection: () => activeTasksSection,
  getActiveWorkspaceView: () => activeWorkspaceView,
  getOperationsQualitySnapshot: () => operationsQualitySnapshot,
  getOperationsRecurringSnapshot: () => operationsRecurringSnapshot,
  getOperationsWorkSnapshot: () => operationsWorkSnapshot,
  labelizeWorkValue,
  libraryTitle,
  listDraftPaths: (...args) => listDraftPaths(...args),
  navigateCanonicalWorkspace,
  openBundlePanel,
  openQuickWorkflowForm,
  openTaskPanel,
  qualityFiltersState,
  operationsViewPath,
  operationsViewTitle,
  pinnedList,
  pinnedSection,
  quickNav,
  quickNavInput,
  quickNavResults,
  recentList,
  recentlyViewedList,
  recentlyViewedSection,
  renderedView,
  refreshChangesPanel: (...args) => refreshChangesPanel(...args),
  refreshGitStatus: (...args) => refreshGitStatus(...args),
  refreshOperationsArtifactSnapshot,
  refreshOperationsAssistantSnapshot,
  refreshOperationsQualitySnapshot,
  refreshOperationsRecurringSnapshot,
  refreshOperationsWorkSnapshot,
  renameCurrentDoc: (...args) => renameCurrentDoc(...args),
  deleteCurrentDoc: (...args) => deleteCurrentDoc(...args),
  renderHonestState,
  renderOperationsReference,
  renderOperationsWorkspace,
  renderQualityFindingRow,
  renderSurfaceHeader,
  reportError,
  request,
  resetBundlePanel,
  resetTaskPanel,
  searchInput,
  setPageTitle,
  setSaveState: (...args) => setSaveState(...args),
  setStatus,
  setView,
  showOperationsHome,
  showWorkspaceSurface,
  surfaceDescription,
  surfaceStatusText,
  systemFilter,
  tagFilter,
  tasksFromWorkPayload,
  titleFromMarkdown: (...args) => titleFromMarkdown(...args),
  typeFilter,
  updateGithubLink: (...args) => updateGithubLink(...args),
  updateSaveState: (...args) => updateSaveState(...args),
  updateViewToggleAvailability: (...args) =>
    updateViewToggleAvailability(...args),
  workApiUrl,
  scheduleAnimationFrame: (callback) => requestAnimationFrame(callback),
  locationAdapter: window.location,
  historyAdapter: history,
  promptUser: (message, initialValue) => window.prompt(message, initialValue),
  storage: localStorage,
  viewportWidth: () => window.innerWidth,
  body,
});

documentEditorSurface = createDocumentEditor({
  beginDocumentNavigation,
  apiUrl,
  basename,
  body,
  canLeaveCurrentDocument,
  changesCount,
  changesDiscardAll,
  changesList,
  changesSaveAll,
  changesSection,
  cleanPath,
  closeSidebar,
  closeWorkBellPanel,
  confirmDialog,
  diffBody,
  diffModal,
  diffTitle,
  discardButton,
  docMenuButton,
  docTree,
  documentPath,
  documentState,
  documentTitle,
  domainFilter,
  editor,
  editorView,
  escapeHtml,
  gitCommitButton,
  gitCommitCancel,
  gitCommitFiles,
  gitCommitMessage,
  gitCommitModal,
  gitCommitSubmit,
  gitPullButton,
  gitResult,
  gitSection,
  gitStatusText,
  knowledgeState,
  labelForPath: (...args) => labelForPath(...args),
  lightbox,
  lightboxCaption,
  lightboxImg,
  lintModal,
  lintModalBody,
  lintOpenButton,
  lintSummary,
  loadDocuments: (...args) => loadDocuments(...args),
  newDocPath,
  newDocForm,
  newDocSummary,
  newDocTitle,
  newDocType,
  openDocument: (...args) => openDocument(...args),
  operationsViewPath,
  operationsViewTitle,
  fetchBacklinksForCurrentDoc: (...args) =>
    knowledgeSurface.fetchBacklinksForCurrentDoc(...args),
  refreshDocuments: (...args) => refreshDocuments(...args),
  renderGithubRawFooter: (...args) =>
    knowledgeSurface.renderGithubRawFooter(...args),
  renderLoomBlock: (...args) => knowledgeSurface.renderLoomBlock(...args),
  renderRelatedDocsBlock: (...args) =>
    knowledgeSurface.renderRelatedDocsBlock(...args),
  renderWarningsBlock: (...args) =>
    knowledgeSurface.renderWarningsBlock(...args),
  renderedView,
  reportError,
  request,
  resetBundlePanel,
  resetTaskPanel,
  resolveDocReference: (...args) => resolveDocReference(...args),
  resolveMarkdownDocLink: (...args) => resolveMarkdownDocLink(...args),
  saveButton,
  saveState,
  searchInput,
  setFolderUrl: (...args) => setFolderUrl(...args),
  setPageTitle,
  setStatus,
  setView,
  showLibrary: (...args) => showLibrary(...args),
  showUndoToast,
  systemFilter,
  tagFilter,
  typeFilter,
  updateCustomSelect: (...args) => updateCustomSelect(...args),
  updateFilterSummary: (...args) => updateFilterSummary(...args),
  viewToggleButton,
  visibleDocUrl: (...args) => visibleDocUrl(...args),
  showErrorToast,
  scheduleAnimationFrame: (callback) => requestAnimationFrame(callback),
  storage: localStorage,
  promptUser: (message, initialValue) => window.prompt(message, initialValue),
});

navigationShell = createNavigationShell({
  canLeaveCurrentDocument,
  canonicalWorkspaceUrl,
  clearDocumentFilters,
  closeSettingsMenu,
  closeSidebar,
  closeWorkBellPanel,
  docPathFromLocation,
  documentList,
  documentRef: document,
  folderExists,
  folderPathFromLocation,
  getAssistantQueueState: () => assistantQueueState,
  getIntakeState: () => intakeState,
  getKnowledgeState: () => knowledgeState,
  getTasksSectionForLegacyView: (view) =>
    LEGACY_VIEW_TO_TASKS_SECTION(view),
  historyRef: history,
  HTMLElementClass: HTMLElement,
  hydrateBundlePanel,
  hydrateTaskPanel,
  libraryTitle,
  locationRef: window.location,
  openDocument,
  openWorkBellPanel,
  operationsViewTitle,
  parseWorkspaceHash,
  prepareBundlePanel,
  prepareTaskPanel,
  refreshDocuments,
  refreshOperationsArtifactSnapshot,
  refreshOperationsAssistantSnapshot,
  refreshUsersSurface,
  refreshWorkBell,
  renderWorkspaceNav: () => {
    syncWorkspaceNav();
    return { activeWorkspaceView, activeTasksSection };
  },
  requestAnimationFrameImpl: requestAnimationFrame,
  resetBundlePanel,
  resetTaskPanel,
  resolveIntakeRouteEntity,
  resolveTaskQueueRouteContext,
  resolveTemplateRouteEntity,
  searchInput,
  setActiveTasksSection: (section) => {
    activeTasksSection = section;
  },
  setActiveWorkspaceView: (view) => {
    activeWorkspaceView = view;
  },
  setRuntimeTemplateRoute,
  setTaskRouteContextFromRoute,
  setView,
  showLibrary,
  showOperationsHome,
  workspaceRouteFor,
});
window.addEventListener(
  "popstate",
  navigationShell.scheduleCurrentBrowserLocation,
);
window.addEventListener(
  "hashchange",
  navigationShell.scheduleCurrentBrowserLocation,
);

mobileMenuButton.addEventListener("click", openSidebar);
sidebarCloseButton.addEventListener("click", closeSidebar);
sidebarScrim?.addEventListener("click", closeSidebar);
sidebarCollapseButton.addEventListener("click", () =>
  setSidebarCollapsed(true),
);
sidebarExpandButton.addEventListener("click", () => setSidebarCollapsed(false));
themeToggleButton.addEventListener("click", () =>
  setDarkMode(!body.classList.contains("dark")),
);
changesToggle.addEventListener("click", () => {
  const open = changesSection.classList.toggle("is-collapsed");
  changesToggle.setAttribute("aria-expanded", String(!open));
});
changesSaveAll.addEventListener("click", saveAllDrafts);
changesDiscardAll.addEventListener("click", discardAllDrafts);
gitCommitButton.addEventListener("click", openCommitForm);
gitCommitCancel.addEventListener("click", closeCommitForm);
gitCommitBackdrop.addEventListener("click", closeCommitForm);
document
  .querySelector("[data-action='cancel-commit']")
  .addEventListener("click", closeCommitForm);
gitCommitForm.addEventListener("submit", submitCommitForm);
for (const button of workspaceNavButtons) {
  button.addEventListener("click", () =>
    document.dispatchEvent(
      new CustomEvent("dataops:navigate-workspace", {
        detail: {
          view:
            button.dataset.workspaceTarget ||
            button.dataset.workspaceView ||
            "home",
        },
      }),
    ),
  );
}
tasksNavButton?.addEventListener("click", () => {
  const expanded = tasksNavButton.getAttribute("aria-expanded") === "true";
  setTasksNavExpanded(!expanded);
});
for (const button of tasksNavSectionButtons) {
  button.addEventListener("click", async () => {
    const section = button.dataset.tasksSection || "queue";
    if (section !== activeTasksSection && !(await confirmLeaveRuntimeDraft()))
      return;
    navigateCanonicalWorkspace(workspaceHashPath("tasks", section));
  });
}
document.addEventListener("dataops:navigate-workspace", (event) =>
  showWorkspaceSurface(event.detail?.view || "home"),
);
newDocumentButton.addEventListener("click", showCreate);
mobileNewButton.addEventListener("click", showCreate);
backButton.addEventListener("click", showLibrary);
clearSelectionButton.addEventListener("click", clearSelection);
saveButton.addEventListener("click", saveCurrentDocument);
discardButton.addEventListener("click", discardDraft);
viewToggleButton.addEventListener("click", toggleViewMode);
docMenuButton.addEventListener("click", openDocMenu);

documentTitle.addEventListener("input", syncTitleToMarkdown);
documentTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    editor.focus();
  }
});
window.addEventListener("resize", resizeDocumentTitle);
window.addEventListener("resize", syncSidebarShellState);
editor.addEventListener("input", () => {
  if (!documentState.currentDoc) return;
  storeDraft();
  updateSaveState();
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshDocuments();
  closeSidebar();
});

searchInput.addEventListener("input", debounce(refreshDocuments, 250));
filterToggle.addEventListener("click", () =>
  setFiltersExpanded(filterRow.hidden),
);
filtersSection.addEventListener("toggle", () =>
  setFiltersExpanded(filtersSection.open),
);
domainFilter.addEventListener("change", onFilterChange);
typeFilter.addEventListener("change", onFilterChange);
systemFilter.addEventListener("change", onFilterChange);
tagFilter.addEventListener("change", onFilterChange);

newDocForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createDocument();
});

document
  .querySelector("[data-action='cancel-create']")
  .addEventListener("click", showLibrary);
document.addEventListener("click", closeCustomSelects);
document.addEventListener("paste", handleClipboardPaste);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCustomSelects();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (event.shiftKey) {
      saveAllDrafts();
    } else if (documentState.currentDoc && !saveButton.disabled) {
      saveCurrentDocument();
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showLibrary();
    searchInput.focus();
    searchInput.select();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
    event.preventDefault();
    openQuickNav();
  }
  // `/` focuses sidebar search (when not already typing somewhere).
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const active = document.activeElement;
    const isTyping =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (!isTyping) {
      event.preventDefault();
      showLibrary();
      searchInput.focus();
      searchInput.select();
    }
  }
  // `?` opens shortcut help (Shift+/ also accepted in case the layout reports it differently).
  const isQuestion = event.key === "?" || (event.key === "/" && event.shiftKey);
  if (isQuestion && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const active = document.activeElement;
    const isTyping =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (!isTyping) {
      event.preventDefault();
      helpModal.hidden = false;
    }
  }
  if (event.key === "Escape" && helpModal && !helpModal.hidden) {
    event.preventDefault();
    helpModal.hidden = true;
  }
  if (event.key === "Escape" && notificationsShell.isOpen()) {
    event.preventDefault();
    closeWorkBellPanel();
  }
  if (event.key === "Escape" && isSettingsMenuOpen()) {
    event.preventDefault();
    closeSettingsMenu();
  }
});

initializeAppShell({
  attachSidebarResize,
  enhanceSelect,
  filterSelects: [
    domainFilter,
    typeFilter,
    systemFilter,
    tagFilter,
    newDocType,
  ],
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
  windowRef: window,
});

function renderOperationsWorkspace(documents) {
  syncWorkspaceNav();
  if (activeWorkspaceView === "home") {
    renderOperationsHome(documents);
    return;
  }
  if (activeWorkspaceView === "tasks") {
    renderTasksSurface(documents, activeTasksSection);
    return;
  }
  if (activeWorkspaceView === "inbox") {
    renderInboxSurface();
    return;
  }
  if (activeWorkspaceView === "docs") {
    renderDocsSurface(documents);
    return;
  }
  if (activeWorkspaceView === "admin") {
    renderAdminSurfaceView(documents);
    return;
  }
  if (activeWorkspaceView === "users") {
    renderUsersSurfaceView();
    return;
  }
  if (activeWorkspaceView === "bookkeeping") {
    renderBookkeepingSurface();
    return;
  }
  if (activeWorkspaceView === "sponsors") {
    renderSponsorCrmSurface();
    return;
  }
  if (activeWorkspaceView === "newsletter") {
    renderNewsletterSurface();
    return;
  }
  if (activeWorkspaceView === "calendar") {
    renderCalendarSurface();
    return;
  }
  if (activeWorkspaceView === "mailing-exports") {
    renderMailingExportsSurface();
    return;
  }
  renderOperationsHome(documents);
}

// Title/path helpers for the new Home / Tasks / Docs IA.
function operationsViewTitle(view, tasksSection) {
  if (view === "home") return "Today";
  if (view === "inbox") return "Inbox";
  if (view === "tasks") return tasksSectionTitle(tasksSection);
  if (view === "docs") return "Docs";
  if (view === "users") return "Users";
  if (view === "bookkeeping") return "Bookkeeping";
  if (view === "sponsors") return "Sponsors";
  if (view === "newsletter") return "Newsletter";
  if (view === "calendar") return "Calendar";
  if (view === "mailing-exports") return "Mailing exports";
  return "Home";
}

function operationsViewPath(view) {
  if (view === "home") return "Home";
  if (view === "inbox") return "Inbox";
  if (view === "tasks") return "Tasks";
  if (view === "docs") return "Docs";
  if (view === "users") return "Users";
  return "Workspace";
}

function surfaceDescription(view) {
  const descriptions = {
    queue:
      "Inspect tasks across cards by overdue, follow-up, waiting, missing proof, owner, source, and next action.",
    workflows:
      "Open active cards by stage, then inspect their tasks, proof, waiting, artifacts, and process context.",
    templates:
      "Create cards from reusable Templates and maintain recurring configuration.",
    assistants:
      "Card support jobs appear here only when the assistant job lifecycle is connected.",
    artifacts:
      "Review proof and operational outputs linked to cards and tasks.",
    processes:
      "SOPs, templates, and references are contextual support for work.",
    search:
      "Find Cards, Tasks, Artifacts, Assistant jobs, Templates, and Process Docs from one operator search.",
    admin:
      "Maintainer tools for process docs, content publishing, diagnostics, and configuration.",
  };
  return descriptions[view] || "";
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function referenceCountLabel(category, count) {
  const singular =
    {
      bundles: "bundle",
      tasks: "task",
      recurrences: "recurrence",
      schedules: "schedule",
      calendar: "calendar item",
      notifications: "notification",
    }[category] || category;
  return countLabel(count, singular, category);
}

function surfaceStatusText(view, model) {
  if (view === "assistants") {
    return operationsAssistantSnapshot.loaded
      ? `${countLabel(operationsAssistantSnapshot.jobs.length, "assistant job")}.`
      : "Assistant jobs not connected.";
  }
  if (view === "artifacts") {
    return operationsArtifactSnapshot.loaded
      ? `${countLabel(operationsArtifactSnapshot.artifacts.length, "artifact")} indexed.`
      : "Artifact index not connected.";
  }
  if (view === "processes") {
    return operationsQualitySnapshot.loaded
      ? `${countLabel(operationsQualitySnapshot.findings.length, "process quality finding")}.`
      : "Process quality report unavailable.";
  }
  if (view === "search") return "Unified operator search.";
  return "Card and task workspace.";
}

function renderSurfaceHeader(titleText, descriptionText) {
  const header = document.createElement("section");
  header.className = "ops-surface-header";
  const title = document.createElement("h3");
  title.textContent = titleText;
  const description = document.createElement("p");
  description.textContent = descriptionText;
  header.append(title, description);
  return header;
}

function renderHonestState(titleText, bodyText) {
  const state = document.createElement("div");
  state.className = "ops-honest-state";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const body = document.createElement("span");
  body.textContent = bodyText;
  state.append(title, body);
  return state;
}

function emptyOperationsWorkSnapshot() {
  return {
    loaded: false,
    currentOperatorId: "",
    todayTasks: [],
    overdueTasks: [],
    waitingTasks: [],
    bundles: [],
    users: [],
    bundleTasks: {},
    errors: [],
    // Per-source load state so a single failed endpoint degrades only its own
    // lane instead of hiding the whole work surface (see #97). Normalized to
    // the coarse `loaded` flag when a snapshot lacks these fields.
    todayLoaded: false,
    overdueLoaded: false,
    waitingLoaded: false,
    bundlesLoaded: false,
    usersLoaded: false,
  };
}

function emptyOperationsRecurringSnapshot() {
  return {
    loaded: false,
    recurringConfigs: [],
    errors: [],
  };
}

function emptyOperationsArtifactSnapshot() {
  return {
    loaded: false,
    artifacts: [],
    errors: [],
  };
}

function emptyOperationsAssistantSnapshot() {
  return {
    loaded: false,
    jobs: [],
    errors: [],
  };
}

function emptyOperationsQualitySnapshot() {
  return {
    loaded: false,
    ok: false,
    findings: [],
    summary: { total: 0, blocking: 0, warning: 0, info: 0, byCategory: {} },
    errors: [],
    validationErrors: [],
  };
}

async function refreshOperationsRecurringSnapshot(options = {}) {
  const snapshot = emptyOperationsRecurringSnapshot();
  try {
    const payload = await request(workApiUrl("/api/recurring"));
    snapshot.loaded = true;
    snapshot.recurringConfigs = recurringConfigsFromPayload(payload);
  } catch (err) {
    snapshot.errors = [err?.message || "Recurring API request failed"];
  }
  operationsRecurringSnapshot = normalizeOperationsRecurringSnapshot(snapshot);
  if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
}

function isOperationsHomeVisible() {
  return (
    body.dataset.view === "library" &&
    !knowledgeState.selectedFolder &&
    !searchInput.value.trim()
  );
}

function workApiUrl(path, params = {}) {
  const url = apiUrl(`/work${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, String(value));
  }
  return url;
}

function allWorkTasks(work = operationsWorkSnapshot) {
  return dedupeWorkTasks([
    ...tasksFromWorkPayload(work.todayTasks || []),
    ...tasksFromWorkPayload(work.overdueTasks || []),
    ...tasksFromWorkPayload(work.waitingTasks || []),
    ...Object.values(work.bundleTasks || {}).flatMap((tasks) =>
      tasksFromWorkPayload(tasks),
    ),
  ]);
}

// ---------- Quick create: ad-hoc task and workflow ----------

function settledPayload(result) {
  return result && result.status === "fulfilled" ? result.value : {};
}

function bundlesFromWorkPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.bundles)) return payload.bundles;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function usersFromWorkPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.users)) return payload.users;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function recurringConfigsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.recurringConfigs)) return payload.recurringConfigs;
  if (Array.isArray(payload.configs)) return payload.configs;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function assistantJobsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.assistantJobs)) return payload.assistantJobs;
  if (Array.isArray(payload.jobs)) return payload.jobs;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function currentOperatorIdFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.user && typeof payload.user === "object" && payload.user.id)
    return String(payload.user.id);
  if (payload.actor && typeof payload.actor === "object" && payload.actor.id)
    return String(payload.actor.id);
  if (payload.id) return String(payload.id);
  return "";
}

function normalizeOperationsRecurringSnapshot(input) {
  const snapshot = input && typeof input === "object" ? input : {};
  const configs = recurringConfigsFromPayload(
    snapshot.recurringConfigs || snapshot.configs || [],
  );
  const normalized = configs
    .filter((config) => config && typeof config === "object")
    .map((config) => ({
      ...config,
      enabled: config.enabled !== false,
    }))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return recurringConfigTitle(a).localeCompare(recurringConfigTitle(b));
    });
  return {
    loaded: Boolean(snapshot.loaded),
    configs: normalized,
    enabled: normalized.filter((config) => config.enabled !== false),
    disabled: normalized.filter((config) => config.enabled === false),
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
  };
}

function normalizeOperationsWorkSnapshot(input, options) {
  options = options || {};
  const today = options.today || todayIsoDate();
  const snapshot = input && typeof input === "object" ? input : {};
  const allTasks = dedupeWorkTasks([
    ...tasksFromWorkPayload(snapshot.tasks || []),
    ...tasksFromWorkPayload(snapshot.todayTasks || []),
    ...tasksFromWorkPayload(snapshot.overdueTasks || []),
    ...tasksFromWorkPayload(snapshot.waitingTasks || []),
  ]);
  const explicitToday = tasksFromWorkPayload(snapshot.todayTasks || []);
  const explicitOverdue = tasksFromWorkPayload(snapshot.overdueTasks || []);
  const explicitWaiting = tasksFromWorkPayload(snapshot.waitingTasks || []);
  const bundles = bundlesFromWorkPayload(snapshot.bundles || []);
  const users = usersFromWorkPayload(snapshot.users || []);
  const bundleTasks = normalizeBundleTaskMap(
    snapshot.bundleTasks || {},
    allTasks,
  );

  // Per-lane load state (#97): fall back to the coarse `loaded` flag when a
  // snapshot was built without per-source tracking (e.g. legacy test fixtures or
  // the buildOperationsHomeModel fallback path). When per-source flags ARE
  // present, use them directly so a single failed endpoint only degrades its lane.
  const laneLoaded = (flag) =>
    snapshot[flag] === undefined
      ? Boolean(snapshot.loaded)
      : Boolean(snapshot[flag]);
  const taskCount = (value, fallback) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const normalizedTodayTasks = dedupeWorkTasks([
    ...explicitToday,
    ...allTasks.filter((task) => isTaskDueToday(task, today)),
  ]);
  const normalizedOverdueTasks = dedupeWorkTasks([
    ...explicitOverdue,
    ...allTasks.filter((task) => isTaskOverdue(task, today)),
  ]);
  const normalizedWaitingTasks = dedupeWorkTasks([
    ...explicitWaiting,
    ...allTasks.filter((task) => isWaitingOrFollowUpTask(task)),
  ]);

  return {
    loaded: Boolean(snapshot.loaded),
    todayLoaded: laneLoaded("todayLoaded"),
    overdueLoaded: laneLoaded("overdueLoaded"),
    waitingLoaded: laneLoaded("waitingLoaded"),
    bundlesLoaded: laneLoaded("bundlesLoaded"),
    usersLoaded: laneLoaded("usersLoaded"),
    currentOperatorId: String(snapshot.currentOperatorId || ""),
    todayTasks: sortWorkTasks(normalizedTodayTasks, "today", today),
    overdueTasks: sortWorkTasks(normalizedOverdueTasks, "overdue", today),
    waitingTasks: sortWorkTasks(normalizedWaitingTasks, "waiting", today),
    todayTaskCount: taskCount(
      snapshot.todayTaskCount,
      normalizedTodayTasks.length,
    ),
    overdueTaskCount: taskCount(
      snapshot.overdueTaskCount,
      normalizedOverdueTasks.length,
    ),
    waitingTaskCount: taskCount(
      snapshot.waitingTaskCount,
      normalizedWaitingTasks.length,
    ),
    activeBundles: sortActiveWorkBundles(
      bundles.filter(isActiveWorkBundle),
      bundleTasks,
      today,
    ),
    bundles,
    bundlesById: new Map(
      bundles
        .filter((bundle) => bundle && bundle.id)
        .map((bundle) => [bundle.id, bundle]),
    ),
    users,
    usersById: new Map(
      users.filter((user) => user && user.id).map((user) => [user.id, user]),
    ),
    bundleTasks,
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
  };
}

function normalizeBundleTaskMap(bundleTasks, fallbackTasks) {
  const out = {};
  if (
    bundleTasks &&
    typeof bundleTasks === "object" &&
    !Array.isArray(bundleTasks)
  ) {
    for (const [bundleId, tasks] of Object.entries(bundleTasks)) {
      out[bundleId] = tasksFromWorkPayload(tasks);
    }
  }
  for (const task of tasksFromWorkPayload(fallbackTasks || [])) {
    if (!task || !task.bundleId) continue;
    if (!out[task.bundleId]) out[task.bundleId] = [];
    out[task.bundleId].push(task);
  }
  for (const [bundleId, tasks] of Object.entries(out))
    out[bundleId] = dedupeWorkTasks(tasks);
  return out;
}

function sortWorkTasks(tasks, mode, today) {
  const sorted = dedupeWorkTasks(tasks).filter(isOpenWorkTask);
  sorted.sort((a, b) => {
    const dateA = taskSortDate(a, mode);
    const dateB = taskSortDate(b, mode);
    const byDate = compareIsoDate(dateA, dateB);
    if (byDate !== 0) return byDate;
    if (mode === "overdue")
      return compareIsoDate(taskDate(a) || today, taskDate(b) || today);
    return workTaskTitle(a).localeCompare(workTaskTitle(b));
  });
  return sorted.slice(0, 12);
}

function taskSortDate(task, mode) {
  if (mode === "waiting") return task.followUpAt || task.date || "";
  return task.date || task.followUpAt || "";
}

function isCurrentOperatorTodayTask(task, currentOperatorId) {
  if (!isOpenWorkTask(task)) return false;
  const assigneeId = String(task.assigneeId || "");
  return !assigneeId || assigneeId === String(currentOperatorId || "");
}

function isTaskAssignedTo(task, userId) {
  return (
    isOpenWorkTask(task) &&
    String(task?.assigneeId || "") === String(userId || "")
  );
}

function currentOperatorIdForTodayScope(currentOperatorId) {
  const id = String(currentOperatorId || "").trim();
  if (!id || isSyntheticCurrentOperatorId(id)) return "";
  return id;
}

function isSyntheticCurrentOperatorId(currentOperatorId) {
  const id = String(currentOperatorId || "")
    .trim()
    .toLowerCase();
  return id === "portal-admin";
}

function sortActiveWorkBundles(bundles, bundleTasks, today) {
  const scored = bundles.map((bundle) => ({
    bundle,
    progress: summarizeBundleProgress(
      bundle,
      bundleTasks[bundle.id] || [],
      today,
    ),
  }));
  scored.sort((a, b) => {
    const riskOrder = { high: 0, medium: 1, low: 2 };
    const byRisk =
      (riskOrder[a.progress.risk] ?? 2) - (riskOrder[b.progress.risk] ?? 2);
    if (byRisk !== 0) return byRisk;
    const byDate = compareIsoDate(
      a.bundle.anchorDate || "",
      b.bundle.anchorDate || "",
    );
    if (byDate !== 0) return byDate;
    return workBundleTitle(a.bundle).localeCompare(workBundleTitle(b.bundle));
  });
  return scored.map((entry) => entry.bundle);
}

function taskSourceLabel(task) {
  if (task?.source) return labelizeWorkValue(task.source);
  if (task?.recurringConfigId) return "Recurring";
  if (task?.templateId || task?.bundleId) return "Card";
  return "Ad hoc";
}

function taskNextActionLabel(task, today) {
  const status = String(task?.status || "todo").toLowerCase();
  if (status === "waiting") {
    if (
      task?.followUpAt &&
      !isBeforeIsoDate(today, String(task.followUpAt).slice(0, 10))
    )
      return "Follow up";
    return "Mark response received";
  }
  const proof = taskProofState(task);
  if (!proof.ok) {
    const first = proof.missing[0] || "proof";
    return first === "required file" ? "Attach file" : `Add ${first}`;
  }
  return "Mark done";
}

function operationItemFromTask(task, options) {
  options = options || {};
  const today = options.today || todayIsoDate();
  const proof = taskProofState(task);
  const meta = [];
  if (task.date) meta.push(`Due ${formatTaskDateMeta(task.date, today)}`);
  if (task.status) meta.push(task.status);
  meta.push(task.bundleId ? "Card" : "Independent");
  meta.push(taskSourceLabel(task));
  if (task.assigneeId)
    meta.push(`Owner ${resolveAssigneeLabel(task.assigneeId)}`);
  meta.push(proof.label);
  meta.push(`Next: ${taskNextActionLabel(task, today)}`);
  const summary = task.waitingFor
    ? `Waiting for ${task.waitingFor}${task.followUpAt ? `; follow up ${formatTaskDateMeta(task.followUpAt, today)}` : ""}`
    : !proof.ok
      ? proof.label
      : task.comment ||
        task.instructionsUrl ||
        task.link ||
        "Ready for the next operating action.";
  return {
    title: workTaskTitle(task),
    summary,
    meta: meta.join(" - "),
    taskId: task.id,
    bundleId: task.bundleId,
    dueDate: taskDate(task),
    followUpDate: String(task.followUpAt || "").slice(0, 10),
    nextAction: taskNextActionLabel(task, today),
    proof,
    risk: options.overdue
      ? "high"
      : options.waiting || !proof.ok
        ? "medium"
        : "low",
  };
}

function operationItemFromBundle(bundle, tasks, options) {
  options = options || {};
  const today = options.today || todayIsoDate();
  const progress = summarizeBundleProgress(bundle, tasks, today);
  const summaryParts = [];
  if (bundle.stage) summaryParts.push(labelizeWorkValue(bundle.stage));
  if (bundle.anchorDate)
    summaryParts.push(`Anchor ${formatTaskDateMeta(bundle.anchorDate, today)}`);
  if (progress.nextDueTask)
    summaryParts.push(
      `Next: ${workTaskTitle(progress.nextDueTask)}${taskDate(progress.nextDueTask) ? ` (${formatTaskDateMeta(taskDate(progress.nextDueTask), today)})` : ""}`,
    );
  if (bundle.description) summaryParts.push(bundle.description);
  return {
    title: workBundleTitle(bundle),
    stage: bundle.stage || "",
    summary: summaryParts.join(" - "),
    meta: progress.label,
    bundleId: bundle.id,
    progress,
    risk: progress.risk,
  };
}

function labelizeWorkValue(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeTemplateMatchValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+task template$/i, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isWorkflowTemplateDoc(doc) {
  if (!doc || !doc.path) return false;
  return (
    doc.doc_type === "task-template" ||
    cleanPath(doc.path).startsWith("tasks/templates/")
  );
}

function summarizeWorkflowTemplate(doc) {
  const slug = workflowSlugFromDoc(doc);
  const tags = Array.isArray(doc.tags)
    ? doc.tags.filter((tag) => tag && tag !== "task-template")
    : [];
  return {
    title: (doc.title || basename(doc.path || "")).replace(
      /\s+Task Template$/i,
      "",
    ),
    summary: doc.summary || "Git-backed Card template.",
    path: doc.path,
    slug,
    tags,
    recurring: isRecurringWorkflowSlug(slug),
    atRisk: isAtRiskWorkflowSlug(slug),
  };
}

function workflowSlugFromDoc(doc) {
  const path = cleanPath(doc.path || "");
  const filename = path.split("/").pop() || "";
  return filename.replace(/\.md$/, "");
}

function workflowPriority(slug) {
  const order = [
    "newsletter",
    "podcast",
    "webinar",
    "workshop",
    "book-of-the-week",
    "course",
    "office-hours",
    "tax-report",
    "social-media",
    "oss",
    "maven-ll",
  ];
  const index = order.indexOf(slug);
  return index === -1 ? order.length : index;
}

function isRecurringWorkflowSlug(slug) {
  return ["newsletter", "social-media", "tax-report"].includes(slug);
}

function isAtRiskWorkflowSlug(slug) {
  return [
    "podcast",
    "webinar",
    "workshop",
    "newsletter",
    "tax-report",
  ].includes(slug);
}

function isFollowUpDoc(doc) {
  if (!doc || isWorkflowTemplateDoc(doc)) return false;
  const haystack =
    `${doc.title || ""} ${doc.summary || ""} ${(doc.tags || []).join(" ")} ${doc.path || ""}`.toLowerCase();
  return /\b(waiting|follow[- ]?up|remind|reminder|reach[- ]?out|contact|reply|email)\b/.test(
    haystack,
  );
}

function operationItemFromTemplate(template) {
  const badges = [];
  if (template.recurring) badges.push("Recurring");
  if (template.atRisk) badges.push("Watch");
  return {
    title: template.title,
    summary: template.summary,
    meta: badges.join(" · ") || "Template",
    path: template.path,
  };
}

function operationItemFromDoc(doc, meta) {
  return {
    title: doc.title || basename(doc.path || ""),
    summary: doc.summary || doc.path || "",
    meta,
    path: doc.path,
  };
}

function dedupeOperationItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.path || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildOperationsFutureSections() {
  return [
    {
      id: "inbox",
      title: "Inbox",
      status: "Not connected yet",
      body: "Telegram, email, manual notes, files, and assistant-ready inputs will land here when the durable inbox model ships in #31.",
    },
    {
      id: "assistant-jobs",
      title: "Assistant Jobs",
      status: "Not connected yet",
      body: "Assistant run status, approvals, retries, logs, and outputs will appear here after the assistant job lifecycle ships in #30.",
    },
  ];
}

function buildOperationsReferenceLinks(docs) {
  const indexed = [
    docs.find((doc) => doc.path === "content/tasks/templates/newsletter.md"),
    docs.find((doc) => doc.path === "content/tasks/templates/podcast.md"),
    docs.find(
      (doc) =>
        doc.path ===
        "content/finance/reference/invoices-receipts-and-statements.md",
    ),
    docs.find(
      (doc) => doc.path === "content/courses/reference/course-guide.md",
    ),
    docs.find((doc) => doc.path === "content/overview/reference/schedule.md"),
  ]
    .filter(Boolean)
    .map((doc) => ({
      title: doc.title || basename(doc.path),
      summary: doc.summary || doc.path,
      path: doc.path,
    }));

  const repoRefs = [
    [
      "DataOps V1 Goal",
      "https://github.com/DataTalksClub/dataops/blob/main/.goal-v1.md",
    ],
    [
      "Project Plan",
      "https://github.com/DataTalksClub/dataops/blob/main/PROJECT_PLAN.md",
    ],
    [
      "Portal Analysis",
      "https://github.com/DataTalksClub/dataops/blob/main/PORTAL_ANALYSIS.md",
    ],
    [
      "Merge Plan",
      "https://github.com/DataTalksClub/dataops/blob/main/_docs/MERGE_PLAN.md",
    ],
  ].map(([title, href]) => ({ title, href, summary: "Planning reference" }));

  return [...indexed, ...repoRefs];
}

function renderOperationsRuntimeState(runtime) {
  const errors = Array.isArray(runtime?.errors)
    ? runtime.errors.filter(Boolean)
    : [];
  if (runtime?.connected && errors.length === 0) return null;

  const section = document.createElement("section");
  section.className = "ops-runtime-state";
  section.setAttribute("aria-label", "Runtime data state");

  const title = document.createElement("strong");
  title.textContent = runtime?.connected
    ? "Live work data is partially unavailable"
    : "Live work data unavailable";
  const body = document.createElement("span");
  body.textContent = runtime?.connected
    ? "Some /work/api calls failed. Loaded tasks remain visible, and unavailable parts are not replaced with fake data."
    : "Operations Home could not load Card and Task data. Templates and internal Processes remain available from their dedicated views.";
  section.append(title, body);

  if (errors.length > 0) {
    const list = document.createElement("ul");
    for (const error of errors.slice(0, 3)) {
      const item = document.createElement("li");
      item.textContent = String(error);
      list.append(item);
    }
    section.append(list);
  }

  return section;
}

function renderOperationsFutureSections(sections) {
  const wrap = document.createElement("section");
  wrap.className = "ops-section ops-future-section";
  wrap.setAttribute("aria-label", "Future operations inputs");

  const header = document.createElement("div");
  header.className = "ops-section-header";
  const title = document.createElement("h3");
  title.textContent = "Incoming And Quality Signals";
  const meta = document.createElement("span");
  meta.textContent = "No fake data";
  header.append(title, meta);
  wrap.append(header);

  const grid = document.createElement("div");
  grid.className = "ops-future-grid";
  for (const section of sections || []) {
    const card = document.createElement("article");
    card.className = "ops-future-card";
    const cardTitle = document.createElement("strong");
    cardTitle.textContent = section.title;
    const status = document.createElement("small");
    status.textContent = section.status;
    const body = document.createElement("span");
    body.textContent = section.body;
    card.append(cardTitle, status, body);
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function renderProcessQualityHomeSection(quality) {
  const section = document.createElement("section");
  section.className = "ops-section ops-process-quality";
  section.setAttribute("aria-label", "Process quality");

  const header = document.createElement("div");
  header.className = "ops-section-header";
  const title = document.createElement("h3");
  title.textContent = "Process Quality";
  const meta = document.createElement("span");
  if (!quality.loaded) meta.textContent = "Report unavailable";
  else if (quality.activeWorkLoaded)
    meta.textContent = `${quality.activeBlockingCount} active blockers`;
  else meta.textContent = "Active impact unknown";
  header.append(title, meta);

  const drilldown = document.createElement("button");
  drilldown.type = "button";
  drilldown.className = "ops-quick-btn";
  drilldown.textContent = "Open drill-down";
  drilldown.addEventListener("click", () => showWorkspaceSurface("processes"));
  header.append(drilldown);
  section.append(header);

  if (!quality.loaded) {
    section.append(
      renderHonestState(
        "Process quality could not load",
        quality.errors[0] || "Validation could not run in this environment.",
      ),
    );
    return section;
  }
  if (!quality.activeWorkLoaded) {
    section.append(
      renderHonestState(
        "Active-work impact cannot be confirmed",
        "Live Task and Card data is unavailable. Template and Process Doc findings below are maintainer warnings, not confirmed production blockers.",
      ),
    );
  } else if (quality.activeFindings.length === 0) {
    section.append(
      renderHonestState(
        "No active process blockers",
        "Loaded Tasks and active Cards have no unresolved internal Process Doc or proof-guidance blockers.",
      ),
    );
  }

  const list = document.createElement("div");
  list.className = "ops-quality-list";
  const findings = quality.visibleHomeFindings;
  if (findings.length === 0) {
    list.append(
      renderHonestState(
        "No process quality findings",
        "The deterministic report returned no findings for Templates or Process Docs.",
      ),
    );
  } else {
    for (const finding of findings) {
      const displayFinding = quality.activeWorkLoaded
        ? finding
        : {
            ...finding,
            severity:
              finding.severity === "blocking" ? "warning" : finding.severity,
          };
      list.append(renderQualityFindingRow(displayFinding));
    }
  }
  section.append(list);
  return section;
}

function renderQualityFindingRow(finding) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `ops-quality-row ops-quality-${finding.severity || "warning"}`;
  row.addEventListener("click", () => openQualityFinding(finding));

  const head = document.createElement("div");
  head.className = "ops-quality-row-head";
  const title = document.createElement("strong");
  title.textContent = finding.title;
  const severity = document.createElement("span");
  severity.textContent = labelizeWorkValue(finding.severity || "warning");
  head.append(title, severity);

  const summary = document.createElement("small");
  summary.textContent =
    finding.summary || finding.docPath || finding.instructionDocId || "";

  const meta = document.createElement("div");
  meta.className = "ops-queue-meta";
  for (const value of [
    finding.category,
    finding.workflowSlug || finding.templateId,
    finding.taskId ? `task ${finding.taskId}` : "",
    finding.docPath || finding.docId || finding.instructionDocId,
    finding.nextAction,
  ]
    .filter(Boolean)
    .slice(0, 5)) {
    const chip = document.createElement("span");
    chip.textContent = value;
    meta.append(chip);
  }
  row.append(head, summary, meta);
  return row;
}

function openQualityFinding(finding) {
  if (finding.taskId) {
    openTaskPanel(finding.taskId);
    return;
  }
  if (finding.bundleId) {
    openBundlePanel(finding.bundleId);
    return;
  }
  const doc = finding.docPath
    ? { path: finding.docPath }
    : resolveDocReference(finding.docId || finding.instructionDocId);
  if (doc?.path) {
    openDocument(doc.path, {
      returnContext: finding.bundleId
        ? {
            type: "workflow",
            id: finding.bundleId,
            title: finding.workflowSlug || finding.templateId,
          }
        : null,
    });
    return;
  }
  if (finding.workflowSlug || finding.templateId)
    showWorkspaceSurface("templates");
}

function renderOperationalSurfaceStates() {
  const wrap = document.createElement("section");
  wrap.className = "ops-section ops-future-section";
  wrap.setAttribute("aria-label", "Operational surface states");
  const header = document.createElement("div");
  header.className = "ops-section-header";
  const title = document.createElement("h3");
  title.textContent = "Assistant, Artifact, Inbox, And Search States";
  const meta = document.createElement("span");
  meta.textContent = "Honest availability";
  header.append(title, meta);
  wrap.append(header);

  const grid = document.createElement("div");
  grid.className = "ops-future-grid";
  const states = [
    operationsAssistantSnapshot.loaded
      ? [
          "Assistants",
          `${operationsAssistantSnapshot.jobs.length} real job rows loaded.`,
        ]
      : [
          "Assistants",
          "Not connected; #30/#44 job lifecycle is not represented with fake rows.",
        ],
    operationsArtifactSnapshot.loaded
      ? [
          "Artifacts",
          `${operationsArtifactSnapshot.artifacts.length} artifact rows loaded from /work/api/artifacts.`,
        ]
      : [
          "Artifacts",
          "Cross-workflow artifact index not connected; task/workflow artifacts still appear in context.",
        ],
    [
      "Inbox",
      "Not connected; #31 raw Telegram/email/manual intake is not represented with fake rows.",
    ],
    [
      "Search",
      "Connected through /search with partial-source states when work APIs are unavailable.",
    ],
  ];
  for (const [stateTitle, stateBody] of states) {
    const card = document.createElement("article");
    card.className = "ops-future-card";
    const strong = document.createElement("strong");
    strong.textContent = stateTitle;
    const status = document.createElement("small");
    status.textContent =
      stateBody.startsWith("Not connected") || stateBody.startsWith("Docs-only")
        ? "Not connected yet"
        : "Connected";
    const body = document.createElement("span");
    body.textContent = stateBody;
    card.append(strong, status, body);
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function renderOperationsLane(lane) {
  const section = document.createElement("section");
  section.className = `ops-lane ops-lane-${lane.id}`;
  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = lane.title;
  const count = document.createElement("span");
  count.textContent = String(lane.items.length);
  header.append(title, count);
  section.append(header);

  const list = document.createElement("div");
  list.className = "ops-lane-list";
  if (lane.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ops-empty";
    empty.textContent = lane.empty;
    list.append(empty);
  } else {
    for (const item of lane.items.slice(0, 6))
      list.append(renderOperationsLaneItem(item));
  }
  section.append(list);
  return section;
}

function renderOperationsLaneItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ops-lane-item";
  if (item.risk) button.classList.add(`ops-risk-${item.risk}`);
  if (item.path) {
    button.addEventListener("click", () => openDocument(item.path));
  } else if (item.taskId) {
    button.addEventListener("click", () => openTaskPanel(item.taskId));
  } else if (item.bundleId) {
    button.addEventListener("click", () => openBundlePanel(item.bundleId));
  } else {
    button.disabled = true;
  }
  const title = document.createElement("strong");
  title.textContent = item.title;
  const summary = document.createElement("span");
  summary.textContent = item.summary || item.path || "";
  const meta = document.createElement("small");
  meta.textContent = item.meta || "";
  button.append(title, summary);
  if (item.nextAction) {
    const action = document.createElement("small");
    action.className = "ops-next-action";
    action.textContent = item.nextAction;
    button.append(action);
  }
  if (item.progress) {
    const progress = document.createElement("div");
    progress.className = "ops-progress";
    progress.setAttribute("aria-label", item.progress.label);
    const bar = document.createElement("i");
    bar.style.width = `${Math.max(0, Math.min(100, item.progress.percent || 0))}%`;
    progress.append(bar);
    button.append(progress);
  }
  button.append(meta);
  return button;
}

function renderOperationsReference(ref) {
  const el = ref.path
    ? document.createElement("button")
    : document.createElement("a");
  el.className = "ops-reference-link";
  if (ref.path) {
    el.type = "button";
    el.addEventListener("click", () => openDocument(ref.path));
  } else {
    el.href = ref.href;
    el.target = "_blank";
    el.rel = "noopener";
  }
  const title = document.createElement("strong");
  title.textContent = ref.title;
  const summary = document.createElement("span");
  summary.textContent = ref.summary || "";
  el.append(title, summary);
  return el;
}



// Refresh "Saved · 2 min ago" every minute so the relative time stays current.
setInterval(() => {
  if (documentState.currentDoc && editor.value === documentState.lastSavedContent) updateSaveState();
}, 60000);

async function canLeaveCurrentDocument() {
  if (!(await canLeaveFinanceSurface("navigation"))) return false;
  if (!(await confirmLeaveRuntimeDraft())) return false;
  return canLeaveDocumentEditor();
}

// Maps the legacy 9-view nav set onto the new Home / Tasks / Docs IA. Old
// programmatic callers (e.g. showWorkspaceSurface("queue")) still work: work
// views resolve into the Tasks tab at the matching sub-section, while the
// library surfaces (processes/search) route to Docs.
const TASKS_SECTION_BY_LEGACY_VIEW = {
  queue: "queue",
  workflows: "workflows",
  templates: "templates",
  assistants: "assistants",
  artifacts: "artifacts",
};
const LEGACY_VIEW_TO_TASKS_SECTION = (view) =>
  TASKS_SECTION_BY_LEGACY_VIEW[view] || null;

async function showOperationsHome(options = {}) {
  if (!(await canLeaveCurrentDocument())) return;
  return navigateCanonicalWorkspace(
    "/",
    {},
    {
      history:
        options.updateUrl === false
          ? "none"
          : options.replace
            ? "replace"
            : "push",
    },
  ).ready;
}

async function showWorkspaceSurface(view, options = {}) {
  const nextView = view || "home";
  if (!(await canLeaveCurrentDocument())) return;
  const tasksSection = LEGACY_VIEW_TO_TASKS_SECTION(nextView);
  const path = tasksSection
    ? workspaceHashPath("tasks", tasksSection)
    : nextView === "tasks"
      ? "/tasks"
      : workspaceHashPath(
          nextView === "processes" || nextView === "search" ? "docs" : nextView,
        );
  return navigateCanonicalWorkspace(path, options.params || {}, {
    history:
      options.updateUrl === false
        ? "none"
        : options.replace
          ? "replace"
          : "push",
  }).ready;
}

function syncWorkspaceNav() {
  body.dataset.workspaceView = activeWorkspaceView;
  searchInput.placeholder =
    activeWorkspaceView === "home" ? "Search" : "Search work and docs";
  for (const button of workspaceNavButtons) {
    const active =
      (button.dataset.workspaceView || "home") === activeWorkspaceView;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const tasksActive = activeWorkspaceView === "tasks";
  tasksNavButton?.classList.toggle("is-active", tasksActive);
  if (tasksActive) {
    tasksNavButton?.setAttribute("aria-current", "page");
    setTasksNavExpanded(true);
  } else {
    tasksNavButton?.removeAttribute("aria-current");
  }
  for (const button of tasksNavSectionButtons) {
    const active =
      tasksActive && button.dataset.tasksSection === activeTasksSection;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function setTasksNavExpanded(expanded) {
  if (!tasksNavButton || !tasksNavSubmenu) return;
  tasksNavButton.setAttribute("aria-expanded", String(expanded));
  tasksNavSubmenu.hidden = !expanded;
}

function setView(view) {
  body.dataset.view = view;
}

function setPageTitle(title, path) {
  toolbarTitle.textContent = title;
  mobileTitle.textContent = title;
  breadcrumb.textContent = path;
  resizeDocumentTitle();
}

function setStatus(message) {
  statusText.textContent = message;
}

function basename(path) {
  return cleanPath(path)
    .split("/")
    .pop()
    .replace(/\.md$/, "")
    .replaceAll("-", " ");
}

const warnedOutsideContent = new Set();
function cleanPath(path) {
  if (!path.startsWith("content/") && !warnedOutsideContent.has(path)) {
    warnedOutsideContent.add(path);
    console.warn(`Document path outside content/: ${path}`);
  }
  return path.replace(/^content\//, "");
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// ---------- Diff modal ----------

const diffBackdrop = document.querySelector("#diff-backdrop");
const diffClose = document.querySelector("#diff-close");
diffBackdrop.addEventListener("click", closeDiff);
diffClose.addEventListener("click", closeDiff);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !diffModal.hidden) {
    event.stopPropagation();
    closeDiff();
  }
});

// ---------- Lightbox ----------

lightbox.addEventListener("click", (event) => {
  if (!event.target.closest("img")) closeLightbox();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) {
    event.stopPropagation();
    closeLightbox();
  }
});

// ---------- Quick nav palette (Cmd/Ctrl+P) ----------

const quickNavBackdrop = document.querySelector("#quick-nav-backdrop");



quickNavBackdrop.addEventListener("click", closeQuickNav);
quickNavInput.addEventListener("input", () =>
  updateQuickNavMatches(quickNavInput.value),
);
quickNavInput.addEventListener("keydown", (event) => {
  knowledgeSurface.handleQuickNavKeydown(event);
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
