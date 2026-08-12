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
import { createAdminSurface } from "./surfaces/admin.js";
import { createFinanceSurface } from "./surfaces/finance.js";
import { createHomeSurface } from "./surfaces/home.js";
import { createOperationsSurface } from "./surfaces/operations.js";
import { createPlanningSurface } from "./surfaces/planning.js";
import { createTasksSurface } from "./surfaces/tasks.js";
import { createWorkDetailSurface } from "./surfaces/work-detail.js";

const API_BASE = resolveApiBase();

function resolveApiBase() {
  const meta = document.querySelector('meta[name="api-base"]')?.content?.trim();
  if (meta) return meta;
  // Default: same origin. The frontend server proxies /docs and /search to
  // the lambda backend, so we never need to cross origins from the browser.
  try {
    return window.location.origin;
  } catch {}
  return "";
}

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
  canLeaveFinanceSurface,
  renderBookkeepingSurface,
  renderMailingExportsSurface,
  renderSponsorCrmSurface,
} = createFinanceSurface({
  documentList,
  escapeHtml,
  formatTaskDateMeta,
  getPendingLegacyRoute: () => pendingLegacyRoute,
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
    return accountIdentityState;
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
  getActiveWorkspaceRoute: () => activeWorkspaceRoute,
  getActiveWorkspaceView: () => activeWorkspaceView,
  getAllDocuments: () => allDocuments,
  getCurrentOperator: () => accountIdentityState.user,
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
  getActiveWorkspaceRoute: () => activeWorkspaceRoute,
  getActiveWorkspaceRouteToken: () => activeWorkspaceRouteToken,
  getAllDocuments: () => allDocuments,
  getPendingLegacyRoute: () => pendingLegacyRoute,
  getTaskRouteContext,
  getWorkspaceEntityState: () => workspaceEntityState,
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
  setWorkspaceEntityState: (snapshot) => {
    workspaceEntityState = snapshot;
  },
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

const workBellButton = document.querySelector("#work-bell-button");
const workBellCount = workBellButton?.querySelector(".work-bell-count");
const mobileWorkBellButton = document.querySelector("#mobile-work-bell-button");
const mobileWorkBellCount =
  mobileWorkBellButton?.querySelector(".work-bell-count");
const workBellPanel = document.querySelector("#work-bell-panel");
const workBellBody = document.querySelector("#work-bell-body");
const workBellClose = document.querySelector("#work-bell-close");
async function toggleWorkBellPanel() {
  if (workBellPanel.hidden) {
    if (!(await canLeaveCurrentDocument())) return false;
    await navigateCanonicalWorkspace("/notifications").ready;
    return true;
  }
  closeWorkBellPanel();
  return true;
}
workBellButton.addEventListener("click", toggleWorkBellPanel);
mobileWorkBellButton?.addEventListener("click", toggleWorkBellPanel);
workBellClose.addEventListener("click", closeWorkBellPanel);

const settingsButton = document.querySelector("#settings-button");
const mobileSettingsButton = document.querySelector("#mobile-settings-button");
const settingsMenu = document.querySelector("#settings-menu");
const settingsMenuClose = document.querySelector("#settings-menu-close");
const settingsAdminButton = document.querySelector("#settings-admin-button");
const settingsUsersButton = document.querySelector("#settings-users-button");
const settingsSignOutButton = document.querySelector(
  "#settings-sign-out-button",
);
const accountIdentity = document.querySelector("#account-identity");
const accountWorkScopeList = document.querySelector("#account-work-scope-list");
const accountMenuAvatarNodes = [
  ...document.querySelectorAll("[data-account-menu-avatar]"),
];
const accountMenuNameNodes = [
  ...document.querySelectorAll("[data-account-menu-name]"),
];
const accountActorAvatarNode = document.querySelector(
  "[data-account-actor-avatar]",
);
const accountActorNameNode = document.querySelector(
  "[data-account-actor-name]",
);
const accountMetaNode = document.querySelector("[data-account-meta]");
const settingsButtons = [settingsButton, mobileSettingsButton].filter(Boolean);
let settingsMenuOpener = null;

function openSettingsMenu() {
  settingsMenuOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : settingsButton;
  closeWorkBellPanel();
  syncThemeToggleLabel();
  renderAccountIdentity();
  settingsMenu.hidden = false;
  for (const button of settingsButtons) {
    button.setAttribute("aria-expanded", "true");
  }
  settingsMenuClose.focus();
}

function closeSettingsMenu() {
  settingsMenu.hidden = true;
  for (const button of settingsButtons) {
    button.setAttribute("aria-expanded", "false");
  }
  if (settingsMenuOpener?.isConnected) settingsMenuOpener.focus();
  settingsMenuOpener = null;
}

function accountInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function activeWorkOwner() {
  const selectedId = String(accountIdentityState.selectedOwnerId || "");
  return (
    accountIdentityState.members.find(
      (member) => String(member.id || "") === selectedId,
    ) ||
    accountIdentityState.user ||
    null
  );
}

function activeWorkOwnerId() {
  return String(activeWorkOwner()?.id || "");
}

function renderAccountIdentity() {
  const actor = accountIdentityState.user;
  const actorName = actor?.name || "Account";
  const workOwner = activeWorkOwner();
  const menuName = workOwner?.name || actorName;
  const menuInitials = accountInitials(workOwner?.name || actor?.name);
  for (const node of accountMenuAvatarNodes) node.textContent = menuInitials;
  for (const node of accountMenuNameNodes) node.textContent = menuName;
  if (accountActorAvatarNode)
    accountActorAvatarNode.textContent = accountInitials(actor?.name);
  if (accountActorNameNode) accountActorNameNode.textContent = actorName;
  for (const button of settingsButtons) {
    const scopeDiffers =
      actor && workOwner && String(actor.id) !== String(workOwner.id);
    button.title = scopeDiffers
      ? `Showing ${menuName}’s work · Signed in as ${actorName}`
      : `Account: ${actorName}`;
    button.setAttribute(
      "aria-label",
      scopeDiffers
        ? `Showing work for ${menuName}; signed in as ${actorName}`
        : `Account for ${actorName}`,
    );
  }

  if (accountIdentity) {
    accountIdentity.dataset.state = actor
      ? "ready"
      : accountIdentityState.loaded
        ? "unavailable"
        : "loading";
  }
  if (accountMetaNode) {
    if (actor?.email) accountMetaNode.textContent = actor.email;
    else if (!accountIdentityState.loaded)
      accountMetaNode.textContent = "Loading signed-in identity…";
    else
      accountMetaNode.textContent =
        accountIdentityState.error || "Signed-in identity unavailable";
  }

  if (!accountWorkScopeList) return;
  if (!accountIdentityState.loaded) {
    const loading = document.createElement("p");
    loading.className = "account-scope-loading";
    loading.textContent = "Loading workspace members…";
    accountWorkScopeList.replaceChildren(loading);
    return;
  }

  const members = [...accountIdentityState.members]
    .filter((member) => member && member.id && member.disabled !== true)
    .sort((left, right) => {
      if (String(left.id) === String(actor?.id || "")) return -1;
      if (String(right.id) === String(actor?.id || "")) return 1;
      return String(left.name || "").localeCompare(String(right.name || ""));
    });
  if (members.length === 0) {
    const empty = document.createElement("p");
    empty.className = "account-scope-loading";
    empty.textContent = "No workspace members available.";
    accountWorkScopeList.replaceChildren(empty);
    return;
  }

  const options = members.map((member) => {
    const isActor = String(member.id) === String(actor?.id || "");
    const isSelected =
      String(member.id) === String(accountIdentityState.selectedOwnerId || "");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "account-scope-option";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(isSelected));
    button.setAttribute(
      "aria-label",
      `${isSelected ? "Showing" : "Show"} work for ${member.name || "workspace member"}`,
    );

    const avatar = document.createElement("span");
    avatar.className = "account-avatar account-scope-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = accountInitials(member.name);
    const copy = document.createElement("span");
    copy.className = "account-scope-copy";
    const name = document.createElement("strong");
    name.textContent = member.name || "Workspace member";
    const detail = document.createElement("small");
    detail.textContent = isActor ? "My work" : "Teammate’s work";
    copy.append(name, detail);
    const check = document.createElement("span");
    check.className = "account-scope-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = isSelected ? "✓" : "";
    button.append(avatar, copy, check);
    button.addEventListener("click", () => {
      if (
        String(accountIdentityState.selectedOwnerId || "") === String(member.id)
      ) {
        closeSettingsMenu();
        return;
      }
      accountIdentityState.selectedOwnerId = String(member.id);
      renderAccountIdentity();
      closeSettingsMenu();
      if (activeWorkspaceView === "home" && isOperationsHomeVisible())
        refreshDocuments();
    });
    return button;
  });
  accountWorkScopeList.replaceChildren(...options);
}

function currentOperatorFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.user && typeof payload.user === "object") return payload.user;
  if (payload.actor && typeof payload.actor === "object") return payload.actor;
  return payload.id ? payload : null;
}

async function readLocalPreviewContext() {
  if (
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  )
    return null;
  try {
    const response = await fetch("/__dataops/dev-context", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function localPreviewActor(members, payload) {
  const actorEmail = String(payload?.actorEmail || "")
    .trim()
    .toLowerCase();
  if (!actorEmail) return null;
  const user = members.find(
    (member) =>
      String(member?.email || "")
        .trim()
        .toLowerCase() === actorEmail,
  );
  return user ? { user, localPreview: payload?.localPreview === true } : null;
}

async function refreshAccountIdentity(mePayload, members, localContext) {
  const availableMembers = Array.isArray(members)
    ? members.filter((member) => member && member.id)
    : [];
  let actor = currentOperatorFromPayload(mePayload);
  let localPreview = false;
  if (actor?.id) {
    actor =
      availableMembers.find(
        (member) => String(member.id) === String(actor.id),
      ) || actor;
  } else {
    const preview = localPreviewActor(
      availableMembers,
      localContext || (await readLocalPreviewContext()),
    );
    actor = preview?.user || null;
    localPreview = Boolean(preview?.localPreview);
  }

  const priorOwnerId = String(accountIdentityState.selectedOwnerId || "");
  const selectedOwnerId = availableMembers.some(
    (member) => String(member.id) === priorOwnerId,
  )
    ? priorOwnerId
    : String(actor?.id || "");
  accountIdentityState = {
    loaded: true,
    localPreview,
    user: actor,
    members: availableMembers,
    selectedOwnerId,
    error: actor ? "" : "Signed-in identity unavailable",
  };
  renderAccountIdentity();
}

function toggleSettingsMenu() {
  if (settingsMenu.hidden) openSettingsMenu();
  else closeSettingsMenu();
}

settingsButton.addEventListener("click", toggleSettingsMenu);
mobileSettingsButton?.addEventListener("click", toggleSettingsMenu);
settingsMenuClose.addEventListener("click", closeSettingsMenu);
settingsAdminButton.addEventListener("click", () => {
  closeSettingsMenu();
  showWorkspaceSurface("admin");
});
settingsUsersButton.addEventListener("click", () => {
  closeSettingsMenu();
  showWorkspaceSurface("users");
});
settingsSignOutButton.addEventListener("click", async () => {
  if (!(await canLeaveCurrentDocument())) return;
  settingsSignOutButton.disabled = true;
  settingsSignOutButton.querySelector("span").textContent =
    "Ending this browser session…";
  window.location.assign("/logout");
});
// Close the dropdown when the theme toggle or a git action is invoked, then
// let the existing handlers run. Stop propagation so the outside-click closer
// does not also fire on the same event.
for (const el of [themeToggleButton, gitPullButton, gitCommitButton]) {
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSettingsMenu();
  });
}
document.addEventListener("click", (event) => {
  if (settingsMenu.hidden) return;
  if (settingsMenu.contains(event.target)) return;
  if (settingsButtons.some((button) => button.contains(event.target))) return;
  closeSettingsMenu();
});
let workBellNotifications = [];
let workBellError = "";
const workBellDismissErrors = new Map();
let workBellOpener = null;

let lastSidebarOpener = null;

let allDocuments = [];
let visibleDocuments = [];
let selectedFolder = "";
let currentTreePath = "";
let documentIdMap = new Map();
let currentDoc = null;
let currentParsed = null;
let currentWarnings = [];
let lastSavedContent = "";
let hasDraft = false;
let searchController = null;
let activeSearchSources = [];
let operationsWorkSnapshot = emptyOperationsWorkSnapshot();
let operationsRecurringSnapshot = emptyOperationsRecurringSnapshot();
let operationsArtifactSnapshot = emptyOperationsArtifactSnapshot();
let operationsAssistantSnapshot = emptyOperationsAssistantSnapshot();
let operationsQualitySnapshot = emptyOperationsQualitySnapshot();
let accountIdentityState = {
  loaded: false,
  localPreview: false,
  user: null,
  members: [],
  selectedOwnerId: "",
  error: "",
};
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
let pendingLegacyRoute = null;
let activeWorkspaceRouteToken = 0;
let activeWorkspaceRoute = null;
let locationRouteTimer = null;
let initialRouteReady = false;
let workspaceEntityState = null;
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
    return workspaceEntityState;
  },
  set workspaceEntity(snapshot) {
    workspaceEntityState = snapshot;
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
  getActiveWorkspaceRoute: () => activeWorkspaceRoute,
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

let docReturnContext = null;
const DRAFT_PREFIX = "dtc-doc-draft:";
const customSelects = [];
const LIST_LIMIT = 120;

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
  if (!currentDoc) return;
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
    } else if (currentDoc && !saveButton.disabled) {
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
  if (event.key === "Escape" && workBellPanel && !workBellPanel.hidden) {
    event.preventDefault();
    closeWorkBellPanel();
  }
  if (event.key === "Escape" && settingsMenu && !settingsMenu.hidden) {
    event.preventDefault();
    closeSettingsMenu();
  }
});

enhanceSelect(domainFilter);
enhanceSelect(typeFilter);
enhanceSelect(systemFilter);
enhanceSelect(tagFilter);
enhanceSelect(newDocType);
restoreDarkMode();
restoreSidebarCollapsed();
restoreSidebarWidth();
attachSidebarResize();
syncSidebarShellState();

function setDarkMode(on) {
  body.classList.toggle("dark", on);
  syncThemeToggleLabel(on);
  try {
    localStorage.setItem("dtc-theme", on ? "dark" : "light");
  } catch {}
}

// Keeps the relocated theme-toggle control (now inside the Settings dropdown)
// in sync: label, title, and checked state reflect the current theme.
function syncThemeToggleLabel(on = body.classList.contains("dark")) {
  themeToggleButton.title = on ? "Switch to light mode" : "Switch to dark mode";
  const label = themeToggleButton.querySelector(".settings-theme-label");
  if (label) label.textContent = on ? "Light mode" : "Dark mode";
  else themeToggleButton.textContent = on ? "Light mode" : "Dark mode";
  themeToggleButton.setAttribute("aria-label", themeToggleButton.title);
  themeToggleButton.setAttribute("aria-pressed", String(on));
}

function restoreDarkMode() {
  try {
    const saved = localStorage.getItem("dtc-theme");
    if (saved === "dark") setDarkMode(true);
    else setDarkMode(false);
  } catch {
    setDarkMode(false);
  }
}
showLibrary({ updateUrl: false });
refreshChangesPanel();
updateSaveState();
const documentsReady = loadDocuments();
// Hash workspace routes do not depend on the Git-backed document catalog.
// Open them immediately so a slow/unavailable docs provider cannot strand the
// entire app on the legacy "Loading documents" shell. Legacy pathname-based
// document links still wait for the catalog so they can resolve honestly.
// Defer route parsing until this script has initialized its route-definition
// constants. This still runs in the next microtask and does not wait for docs.
const initialRouteReadyPromise = Promise.resolve().then(() =>
  window.location.hash || window.location.pathname === "/"
    ? openInitialRoute()
    : documentsReady.then(() => openInitialRoute()),
);
initialRouteReadyPromise.then(() => {
  initialRouteReady = true;
});
refreshGitStatus();

// Test-only seam: force a fresh work-snapshot fetch + re-render of Operations
// Home. Specs use this to recover from a hydrated-but-stale snapshot (the home
// fetched its snapshot before the spec created its task). Not user-facing.
if (typeof window !== "undefined") {
  window.__dataopsRefreshWork = function refreshOperationsWorkForTests() {
    return refreshOperationsWorkSnapshot({ rerender: true });
  };
}

function setSidebarCollapsed(collapsed) {
  body.classList.toggle("sidebar-collapsed", collapsed);
  sidebarExpandButton.hidden = !collapsed;
  try {
    localStorage.setItem("dtc-sidebar-collapsed", collapsed ? "1" : "0");
  } catch {}
}

function restoreSidebarCollapsed() {
  try {
    if (localStorage.getItem("dtc-sidebar-collapsed") === "1") {
      setSidebarCollapsed(true);
    }
  } catch {}
}

function restoreSidebarWidth() {
  try {
    const w = parseInt(localStorage.getItem("dtc-sidebar-width") || "0", 10);
    if (w >= 180 && w <= 600) setSidebarWidth(w);
  } catch {}
}

function setSidebarWidth(px) {
  document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
}

function attachSidebarResize() {
  let dragging = false;
  let startX = 0;
  let startW = 0;
  sidebarResize.addEventListener("pointerdown", (event) => {
    if (body.classList.contains("sidebar-collapsed")) return;
    if (window.matchMedia("(max-width: 820px)").matches) return;
    dragging = true;
    startX = event.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.body.classList.add("is-resizing-sidebar");
    sidebarResize.setPointerCapture(event.pointerId);
  });
  sidebarResize.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const next = Math.max(
      200,
      Math.min(560, startW + (event.clientX - startX)),
    );
    setSidebarWidth(next);
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing-sidebar");
    try {
      sidebarResize.releasePointerCapture(event.pointerId);
    } catch {}
    const w = parseInt(sidebar.getBoundingClientRect().width, 10);
    try {
      localStorage.setItem("dtc-sidebar-width", String(w));
    } catch {}
  };
  sidebarResize.addEventListener("pointerup", endDrag);
  sidebarResize.addEventListener("pointercancel", endDrag);
}

async function loadDocuments() {
  setStatus("Loading documents...");
  const skeleton = document.querySelector("#tree-skeleton");
  if (skeleton) skeleton.hidden = false;

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
    allDocuments = payload.documents || [];
    rebuildDocumentIdMap();
    populateFilterOptions();
    refreshDocuments();
    renderRecentDocs();
    renderRecentlyViewed();
    renderPinned();
  } catch (error) {
    setStatus(error.message);
  } finally {
    if (skeleton) skeleton.hidden = true;
  }
}

async function openInitialRoute() {
  let workspaceRoute = parseWorkspaceHash();
  if (workspaceRoute && !workspaceRoute.invalid) {
    if (workspaceRoute.normalized) {
      history.replaceState(history.state, "", workspaceRoute.canonicalUrl);
      workspaceRoute = parseWorkspaceHash();
    }
    await applyWorkspaceRoute(workspaceRoute);
    return;
  }
  if (window.location.hash || window.location.pathname === "/") {
    await applyWorkspaceRoute(replaceWithWorkspaceHome());
    return;
  }
  const docPath = docPathFromLocation();
  if (docPath) {
    const exists = allDocuments.some((doc) => doc.path === docPath);
    if (exists)
      await openDocument(docPath, { updateUrl: false, revealInTree: true });
    return;
  }
  const folderPath = folderPathFromLocation();
  if (folderPath && folderExists(folderPath)) {
    selectedFolder = folderPath;
    showLibrary({ updateUrl: false });
    refreshDocuments();
    return;
  }
  await showOperationsHome({ replace: true });
}

async function applyCurrentBrowserLocation() {
  let workspaceRoute = parseWorkspaceHash();
  if (workspaceRoute && !workspaceRoute.invalid) {
    if (workspaceRoute.normalized) {
      history.replaceState(history.state, "", workspaceRoute.canonicalUrl);
      workspaceRoute = parseWorkspaceHash();
    }
    await applyWorkspaceRoute(workspaceRoute);
    return;
  }
  if (window.location.hash || window.location.pathname === "/") {
    await applyWorkspaceRoute(replaceWithWorkspaceHome());
    return;
  }
  const docPath = docPathFromLocation();
  if (docPath) {
    openDocument(docPath, { updateUrl: false });
    return;
  }
  selectedFolder = folderPathFromLocation();
  showLibrary({ updateUrl: false });
  refreshDocuments();
}

function scheduleCurrentBrowserLocation() {
  if (!initialRouteReady) {
    // The initial workspace shell is committed synchronously, while its
    // hydration promise settles on a later microtask. Preserve any hash change
    // that lands in that window instead of leaving the visible route stale.
    initialRouteReadyPromise.then(() => scheduleCurrentBrowserLocation());
    return;
  }
  if (locationRouteTimer) clearTimeout(locationRouteTimer);
  locationRouteTimer = setTimeout(() => {
    locationRouteTimer = null;
    applyCurrentBrowserLocation();
  }, 0);
}

window.addEventListener("popstate", scheduleCurrentBrowserLocation);

window.addEventListener("hashchange", scheduleCurrentBrowserLocation);

const PIN_KEY = "dtc-pinned";

function readPins() {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function writePins(set) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify([...set]));
  } catch {}
}

function toggleCurrentDocPin() {
  if (!currentDoc) return;
  const pins = readPins();
  if (pins.has(currentDoc.path)) pins.delete(currentDoc.path);
  else pins.add(currentDoc.path);
  writePins(pins);
  renderPinned();
  updatePinButton();
}

function updatePinButton() {
  if (!currentDoc) {
    docPinButton.hidden = true;
    return;
  }
  docPinButton.hidden = false;
  const pinned = readPins().has(currentDoc.path);
  docPinButton.textContent = pinned ? "Pinned" : "Pin";
  docPinButton.title = pinned ? "Unpin from sidebar" : "Pin to sidebar";
  docPinButton.setAttribute(
    "aria-label",
    pinned ? "Unpin from sidebar" : "Pin to sidebar",
  );
  docPinButton.classList.toggle("is-pinned", pinned);
}

function renderPinned() {
  const pins = readPins();
  if (pins.size === 0) {
    pinnedSection.hidden = true;
    pinnedList.replaceChildren();
    return;
  }
  pinnedSection.hidden = false;
  const rows = [...pins].map((path) => {
    const doc = allDocuments.find((d) => d.path === path) || {
      path,
      title: basename(path),
    };
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-row";
    btn.title = path;
    const label = document.createElement("span");
    label.className = "recent-row-label";
    label.textContent = doc.title || basename(path);
    const star = document.createElement("span");
    star.className = "recent-row-when";
    star.textContent = "Pinned";
    btn.append(label, star);
    btn.addEventListener("click", () => openDocument(path));
    return btn;
  });
  pinnedList.replaceChildren(...rows);
}

const RECENTLY_VIEWED_KEY = "dtc-recently-viewed";
const RECENTLY_VIEWED_MAX = 8;

function pushRecentlyViewed(path) {
  try {
    const raw = localStorage.getItem(RECENTLY_VIEWED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const filtered = list.filter((p) => p !== path);
    filtered.unshift(path);
    localStorage.setItem(
      RECENTLY_VIEWED_KEY,
      JSON.stringify(filtered.slice(0, RECENTLY_VIEWED_MAX)),
    );
  } catch {}
}

function renderRecentlyViewed() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY) || "[]");
  } catch {}
  if (list.length === 0) {
    recentlyViewedSection.hidden = true;
    return;
  }
  recentlyViewedSection.hidden = false;
  const rows = list.map((path) => {
    const doc = allDocuments.find((d) => d.path === path) || {
      path,
      title: basename(path),
    };
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-row";
    btn.title = path;
    const label = document.createElement("span");
    label.className = "recent-row-label";
    label.textContent = doc.title || basename(path);
    btn.append(label);
    btn.addEventListener("click", () => openDocument(path));
    return btn;
  });
  recentlyViewedList.replaceChildren(...rows);
}

function renderRecentDocs() {
  const sorted = allDocuments
    .filter((d) => typeof d.updated === "number")
    .slice()
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 8);
  const rows = sorted.map((doc) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-row";
    btn.title = `${doc.path} · ${relativeTime(doc.updated)}`;
    const label = document.createElement("span");
    label.className = "recent-row-label";
    label.textContent = doc.title || basename(doc.path);
    const when = document.createElement("span");
    when.className = "recent-row-when";
    when.textContent = relativeTime(doc.updated);
    btn.append(label, when);
    btn.addEventListener("click", () => openDocument(doc.path));
    return btn;
  });
  recentList.replaceChildren(...rows);
}

async function refreshDocuments() {
  const query = searchInput.value.trim();
  const localFiltered = filterDocuments(allDocuments);

  if (searchController) {
    searchController.abort();
    searchController = null;
  }

  try {
    if (query) {
      const controller = new AbortController();
      searchController = controller;

      const url = apiUrl("/search");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "80");
      if (domainFilter.value)
        url.searchParams.set("domain", domainFilter.value);
      if (typeFilter.value) url.searchParams.set("doc_type", typeFilter.value);
      if (systemFilter.value)
        url.searchParams.set("system", systemFilter.value);
      if (tagFilter.value) url.searchParams.set("tag", tagFilter.value);

      url.searchParams.set("source", "docs");
      const [docsResult, workResult] = await Promise.allSettled([
        request(url, { signal: controller.signal }),
        loadUnifiedWorkSearch(query, controller.signal),
      ]);
      if (searchController !== controller) return;
      searchController = null;

      const payload =
        docsResult.status === "fulfilled"
          ? docsResult.value
          : {
              results: [],
              sources: [
                {
                  source: "docs",
                  status: "unavailable",
                  error:
                    docsResult.reason?.message || "Document search unavailable",
                },
              ],
            };
      const workSearch =
        workResult.status === "fulfilled"
          ? workResult.value
          : {
              results: [],
              sources: [
                {
                  source: "work",
                  status: "unavailable",
                  error:
                    workResult.reason?.message || "Work search unavailable",
                },
              ],
            };
      const results = [
        ...(Array.isArray(payload.results) ? payload.results : []),
        ...workSearch.results,
      ].slice(0, 80);
      activeSearchSources = [
        ...(Array.isArray(payload.sources) ? payload.sources : []),
        ...workSearch.sources,
      ];
      visibleDocuments = results;
      selectedFolder = "";
      renderTree(localFiltered);
      renderUnifiedSearchResults(results, activeSearchSources, query);
      const unavailable = activeSearchSources.filter(
        (source) => source.status === "unavailable",
      ).length;
      setStatus(
        `${results.length} search results${unavailable ? ` · ${unavailable} source issues` : ""}.`,
      );
      syncLibraryPageTitle();
      return;
    }

    renderTree(localFiltered);

    if (!selectedFolder) {
      // No folder or search: show the daily operations workspace and skip
      // rendering the (potentially huge) document list.
      visibleDocuments = [];
      renderOperationsWorkspace(localFiltered);
      syncLibraryPageTitle();
      return;
    }

    visibleDocuments = localFiltered.filter((doc) =>
      cleanPath(doc.path).startsWith(`${selectedFolder}/`),
    );
    renderDocuments(visibleDocuments, selectedFolder);
    setStatus(`${visibleDocuments.length} documents shown.`);
    syncLibraryPageTitle();
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message);
  }
}

async function loadUnifiedWorkSearch(query, signal) {
  const definitions = [
    {
      source: "tasks",
      path: "/api/tasks?startDate=2000-01-01&endDate=2100-12-31",
      items: tasksFromWorkPayload,
      type: "task",
    },
    {
      source: "workflows",
      path: "/api/bundles",
      items: bundlesFromWorkPayload,
      type: "workflow",
    },
    {
      source: "templates",
      path: "/api/templates",
      items: (payload) =>
        Array.isArray(payload) ? payload : payload?.templates || [],
      type: "template",
    },
    {
      source: "artifacts",
      path: "/api/artifacts",
      items: (payload) =>
        Array.isArray(payload) ? payload : payload?.artifacts || [],
      type: "artifact",
    },
    {
      source: "assistant-jobs",
      path: "/api/assistant-jobs",
      items: assistantJobsFromPayload,
      type: "assistant-job",
    },
  ];
  const settled = await Promise.allSettled(
    definitions.map((definition) =>
      request(workApiUrl(definition.path), { signal }),
    ),
  );
  const wanted = query.toLowerCase();
  const results = [];
  const sources = [];
  settled.forEach((result, index) => {
    const definition = definitions[index];
    if (result.status === "rejected") {
      sources.push({
        source: definition.source,
        status: "unavailable",
        error: result.reason?.message || "Work source unavailable",
      });
      return;
    }
    const matches = definition
      .items(result.value)
      .filter((item) =>
        [
          item.id,
          item.title,
          item.name,
          item.description,
          item.status,
          item.assistantType,
          item.storageUri,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(wanted),
      );
    sources.push({
      source: definition.source,
      status: "ok",
      count: matches.length,
    });
    for (const item of matches)
      results.push(unifiedWorkSearchResult(definition.type, item));
  });
  return { results, sources };
}

function unifiedWorkSearchResult(type, item) {
  const id = item.id;
  const title =
    item.title || item.name || item.description || item.storageUri || id;
  const route =
    type === "task"
      ? { kind: "task", taskId: id }
      : type === "workflow"
        ? { kind: "workflow", bundleId: id }
        : type === "template"
          ? { kind: "template", templateId: id, templateType: item.type }
          : type === "assistant-job"
            ? {
                kind: "assistant-job",
                assistantJobId: id,
                taskId: item.taskId,
                bundleId: item.bundleId,
              }
            : {
                kind: "artifact",
                artifactId: id,
                taskId: item.taskId,
                bundleId: item.bundleId,
              };
  return {
    type,
    id,
    title,
    context:
      item.description ||
      item.summary ||
      item.assistantType ||
      item.storageUri ||
      "",
    source: type,
    source_label: labelizeWorkValue(type),
    route,
    fields: {
      status: item.status || "",
      due_date: item.date || "",
      workflow_title: item.bundleId || "",
    },
  };
}

function filterDocuments(documents) {
  return documents.filter((doc) => {
    if (domainFilter.value && doc.domain !== domainFilter.value) return false;
    if (typeFilter.value && doc.doc_type !== typeFilter.value) return false;
    if (
      systemFilter.value &&
      !(Array.isArray(doc.systems) && doc.systems.includes(systemFilter.value))
    )
      return false;
    if (
      tagFilter.value &&
      !(Array.isArray(doc.tags) && doc.tags.includes(tagFilter.value))
    )
      return false;
    return true;
  });
}

function onFilterChange() {
  updateFilterSummary();
  refreshDocuments();
}

function activeFilterCount() {
  return [domainFilter, typeFilter, systemFilter, tagFilter].filter(
    (select) => !!select.value,
  ).length;
}

function updateFilterSummary() {
  const count = activeFilterCount();
  filterCount.hidden = count === 0;
  filterCount.textContent = count ? String(count) : "";
  filterToggle.classList.toggle("has-filters", count > 0);
}

function setFiltersExpanded(expanded) {
  if (filtersSection.open !== expanded) filtersSection.open = expanded;
  filterRow.hidden = !expanded;
  filterToggle.setAttribute("aria-expanded", String(expanded));
  try {
    localStorage.setItem("dtc-filters-expanded", expanded ? "1" : "0");
  } catch {}
}

function restoreFiltersExpanded() {
  let expanded = false;
  try {
    expanded = localStorage.getItem("dtc-filters-expanded") === "1";
  } catch {}
  setFiltersExpanded(expanded || activeFilterCount() > 0);
}

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

function renderDocsSurface(documents) {
  const model = buildOperationsHomeModel(documents, {
    draftPaths: listDraftPaths(),
    workSnapshot: operationsWorkSnapshot,
    recurringSnapshot: operationsRecurringSnapshot,
    qualitySnapshot: operationsQualitySnapshot,
  });
  documentList.classList.add("is-operations-home");
  documentList.classList.remove("is-unified-search");
  libraryTitle.textContent = "Docs";
  setPageTitle("Docs", "Docs");
  clearSelectionButton.hidden = true;
  setStatus(surfaceStatusText("processes", model));

  const wrap = document.createElement("div");
  wrap.className = "operations-home ops-surface ops-surface-docs";
  wrap.append(renderSurfaceHeader("Docs", surfaceDescription("processes")));
  wrap.append(renderProcessesSurface(documents, model));
  documentList.replaceChildren(wrap);
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

function renderProcessesSurface(documents, model) {
  const section = document.createElement("section");
  section.className = "ops-processes-surface";
  const quality =
    model?.quality ||
    buildProcessQualityModel(operationsQualitySnapshot, operationsWorkSnapshot);
  const note = renderHonestState(
    "Processes support work",
    "Use internal Process Docs from Task or Card context first. Findings below focus on runnable Template/Card risk and maintainer gaps.",
  );
  section.append(note);

  section.append(renderProcessQualityDrilldown(quality));

  const grid = document.createElement("div");
  grid.className = "ops-reference-grid";
  for (const ref of buildOperationsReferenceLinks(documents))
    grid.append(renderOperationsReference(ref));
  section.append(grid);
  return section;
}

function renderProcessQualityDrilldown(quality) {
  const wrap = document.createElement("section");
  wrap.className = "ops-section ops-quality-drilldown";
  wrap.setAttribute("aria-label", "Process quality drill-down");

  const header = document.createElement("div");
  header.className = "ops-section-header";
  const title = document.createElement("h3");
  title.textContent = "Quality Findings";
  const meta = document.createElement("span");
  meta.textContent = quality.loaded
    ? `${quality.totalFindings} findings - ${quality.summary?.blocking || 0} blocking in template/report data`
    : "Report unavailable";
  header.append(title, meta);
  wrap.append(header);

  if (!quality.loaded) {
    wrap.append(
      renderHonestState(
        "Process quality report unavailable",
        quality.errors[0] || "Validation could not run.",
      ),
    );
    return wrap;
  }
  if (!quality.activeWorkLoaded) {
    wrap.append(
      renderHonestState(
        "Live work unavailable",
        "Active Task/Card impact cannot be confirmed. Severity below reflects Template and Process Doc risk only.",
      ),
    );
  }

  const filters = document.createElement("div");
  filters.className = "ops-quality-filters";
  const findings = quality.maintainerFindings;
  const filterDefs = [
    [
      "severity",
      "Severity",
      ["", ...uniqueSorted(findings.map((finding) => finding.severity))],
    ],
    [
      "category",
      "Category",
      ["", ...uniqueSorted(findings.map((finding) => finding.category))],
    ],
    [
      "workflow",
      "Workflow",
      [
        "",
        ...uniqueSorted(
          findings
            .map((finding) => finding.workflowSlug || finding.templateId)
            .filter(Boolean),
        ),
      ],
    ],
    [
      "document",
      "Document",
      [
        "",
        ...uniqueSorted(
          findings
            .map(
              (finding) =>
                finding.docPath || finding.docId || finding.instructionDocId,
            )
            .filter(Boolean),
        ),
      ],
    ],
  ];
  for (const [key, labelText, values] of filterDefs) {
    const label = document.createElement("label");
    label.className = "ops-quality-filter";
    label.textContent = labelText;
    const select = document.createElement("select");
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value ? value : "All";
      select.append(option);
    }
    select.value = operationsQualityFilters[key] || "";
    select.addEventListener("change", () => {
      operationsQualityFilters = {
        ...operationsQualityFilters,
        [key]: select.value,
      };
      refreshDocuments();
    });
    label.append(select);
    filters.append(label);
  }
  wrap.append(filters);

  const filtered = filterQualityFindings(findings, operationsQualityFilters);
  const list = document.createElement("div");
  list.className = "ops-quality-list";
  if (filtered.length === 0) {
    list.append(
      renderHonestState(
        "No findings match filters",
        "Change filters to inspect other process quality findings.",
      ),
    );
  } else {
    for (const finding of filtered.slice(0, 80))
      list.append(renderQualityFindingRow(finding));
    if (filtered.length > 80) {
      const more = document.createElement("p");
      more.className = "ops-empty";
      more.textContent = `Showing 80 of ${filtered.length} findings. Narrow the filters to inspect the rest.`;
      list.append(more);
    }
  }
  wrap.append(list);
  return wrap;
}

function filterQualityFindings(findings, filters) {
  return findings.filter((finding) => {
    if (filters.severity && finding.severity !== filters.severity) return false;
    if (filters.category && finding.category !== filters.category) return false;
    if (
      filters.workflow &&
      ![finding.workflowSlug, finding.templateId].includes(filters.workflow)
    )
      return false;
    if (
      filters.document &&
      ![finding.docPath, finding.docId, finding.instructionDocId].includes(
        filters.document,
      )
    )
      return false;
    return true;
  });
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function renderUnifiedSearchSurface(documents) {
  const section = document.createElement("section");
  section.className = "ops-state-list";
  const searchState = activeSearchSources.some(
    (source) => source.status === "unavailable",
  )
    ? "Search is showing partial source availability from the latest query."
    : "Use the sidebar search to find executable work and process context together.";
  section.append(renderHonestState("Operator search", searchState));
  const action = document.createElement("button");
  action.type = "button";
  action.className = "ops-quick-btn";
  action.textContent = "Focus search";
  action.addEventListener("click", () => {
    searchInput.focus();
    searchInput.select();
  });
  section.append(action);
  const refs = document.createElement("div");
  refs.className = "ops-reference-grid";
  for (const ref of buildOperationsReferenceLinks(documents).slice(0, 4))
    refs.append(renderOperationsReference(ref));
  section.append(refs);
  return section;
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
    !selectedFolder &&
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

// ---------- Task action panel ----------

function renderEntityLoadState(
  container,
  { kind, id, status, error, retry, returnToList },
) {
  const state = document.createElement("section");
  state.className = `entity-route-state entity-route-${status}`;
  state.tabIndex = -1;
  state.setAttribute("role", status === "error" ? "alert" : "status");
  const heading = document.createElement("h3");
  heading.textContent =
    status === "not-found"
      ? `${labelizeWorkValue(kind)} not found`
      : status === "mismatch"
        ? "Task and card do not match"
        : `${labelizeWorkValue(kind)} unavailable`;
  const detail = document.createElement("p");
  detail.textContent =
    status === "not-found"
      ? `No ${kind} exists with ID ${id}. It may be stale or no longer available.`
      : `${error || `Could not load ${kind}.`} Requested ID: ${id}.`;
  const actions = document.createElement("div");
  actions.className = "entity-route-actions";
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.textContent = "Retry";
  retryButton.addEventListener("click", retry);
  const returnButton = document.createElement("button");
  returnButton.type = "button";
  returnButton.textContent = `Return to ${kind === "intake" ? "Inbox" : kind === "template" ? "templates" : kind === "card" || kind === "task/card" ? "cards" : `${kind}s`}`;
  returnButton.addEventListener("click", returnToList);
  actions.append(retryButton, returnButton);
  state.append(heading, detail, actions);
  container.replaceChildren(state);
  requestAnimationFrame(() => state.focus());
  return state;
}

function renderEntityLoadingState(container, kind, id) {
  const state = document.createElement("section");
  state.className = "entity-route-state entity-route-loading";
  state.setAttribute("role", "status");
  state.textContent = `Loading ${kind} ${id}…`;
  container.replaceChildren(state);
}

async function refreshWorkBell(options = {}) {
  try {
    const payload = await request(workApiUrl("/api/notifications"));
    if (options.token && !isWorkspaceRouteFresh(options.token)) return;
    workBellNotifications = Array.isArray(payload)
      ? payload
      : payload.notifications || [];
    workBellError = "";
  } catch (err) {
    if (options.token && !isWorkspaceRouteFresh(options.token)) return;
    workBellNotifications = [];
    workBellError = err?.message || "Notifications API request failed";
  }
  syncWorkBellIndicators();
  if (!workBellPanel.hidden) renderWorkBellPanel();
}

function syncWorkBellIndicators() {
  const count = workBellNotifications.length;
  const indicatorText = workBellError ? "!" : String(count);
  for (const indicator of [workBellCount, mobileWorkBellCount]) {
    if (!indicator) continue;
    indicator.textContent = indicatorText;
    indicator.classList.toggle(
      "is-visible",
      Boolean(workBellError) || count > 0,
    );
    indicator.classList.toggle("is-error", Boolean(workBellError));
  }
}

function openWorkBellPanel() {
  workBellOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : workBellButton;
  renderWorkBellPanel();
  workBellPanel.hidden = false;
  workBellClose.focus();
}

function closeWorkBellPanel(options = {}) {
  if (workBellPanel.hidden) return;
  const route = parseWorkspaceHash();
  if (
    options.updateUrl !== false &&
    route &&
    !route.invalid &&
    route.path === "/notifications"
  ) {
    navigateCanonicalWorkspace("/");
    return;
  }
  workBellPanel.hidden = true;
  if (options.restoreFocus !== false && workBellOpener?.isConnected)
    workBellOpener.focus();
  workBellOpener = null;
}

function renderWorkBellPanel() {
  workBellBody.replaceChildren();
  if (workBellError) {
    const empty = document.createElement("p");
    empty.className = "work-bell-empty is-error";
    empty.textContent = `Notifications unavailable: ${workBellError}`;
    workBellBody.append(empty);
    return;
  }
  if (workBellNotifications.length === 0) {
    const empty = document.createElement("div");
    empty.className = "work-bell-empty-state";
    empty.innerHTML =
      '<span class="work-bell-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 13 3 3 7-8"/><circle cx="12" cy="12" r="9"/></svg></span><strong>You’re all caught up.</strong><p class="work-bell-empty">No active notifications.</p>';
    workBellBody.append(empty);
    return;
  }
  for (const notification of workBellNotifications) {
    const item = document.createElement("div");
    item.className = "work-bell-item";
    item.classList.add(notificationUrgencyClass(notification));
    const message = document.createElement("div");
    message.className = "work-bell-item-message";
    const icon = document.createElement("span");
    icon.className = "work-bell-item-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = notification.taskId
      ? '<svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17h.01"/></svg>'
      : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    const text = document.createElement("span");
    text.textContent = notificationDisplayMessage(notification);
    message.append(icon, text);
    item.append(message);
    const meta = document.createElement("div");
    meta.className = "work-bell-item-meta";
    const metaParts = [];
    if (notification.dueAt)
      metaParts.push(notificationDueLabel(notification.dueAt));
    else if (notification.createdAt)
      metaParts.push(
        `Added ${formatHomeShortDate(String(notification.createdAt).slice(0, 10))}`,
      );
    meta.textContent = metaParts.join(" · ");
    item.append(meta);
    const actions = document.createElement("div");
    actions.className = "work-bell-item-actions";
    if (notification.taskId) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "work-bell-action work-bell-action-primary";
      open.textContent = "Open task";
      open.addEventListener("click", () => {
        closeWorkBellPanel({ updateUrl: false });
        openTaskPanel(notification.taskId);
      });
      actions.append(open);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "work-bell-action";
    dismiss.textContent = "Dismiss";
    dismiss.dataset.dismissNotification = notification.id;
    dismiss.setAttribute(
      "aria-label",
      `Dismiss notification: ${notification.message || notification.type || notification.id}`,
    );
    dismiss.addEventListener("click", () =>
      dismissWorkNotification(notification, dismiss),
    );
    actions.append(dismiss);
    item.append(actions);
    const failure = workBellDismissErrors.get(notification.id);
    if (failure) {
      const error = document.createElement("p");
      error.className = "work-bell-item-error";
      error.setAttribute("role", "alert");
      error.textContent = `${failure} Select Dismiss to retry.`;
      item.append(error);
    }
    workBellBody.append(item);
  }
}

function notificationDisplayMessage(notification) {
  const message = String(
    notification?.message || notification?.type || "Notification",
  );
  if (notification?.type === "recurring-due") {
    return message
      .replace(/^Recurring task generated:\s*/i, "")
      .replace(/\s+for\s+\d{4}-\d{2}-\d{2}\s*$/i, "");
  }
  return message;
}

function notificationDueLabel(value) {
  const date = String(value || "").slice(0, 10);
  const relative = formatTaskDateMeta(date, todayIsoDate());
  if (relative === "Today") return "Due today";
  if (relative === "Yesterday") return "Due yesterday";
  if (relative === "Tomorrow") return "Due tomorrow";
  return relative ? `Due ${formatHomeShortDate(date)}` : "";
}

function notificationUrgencyClass(notification) {
  const dueDate = String(notification?.dueAt || "").slice(0, 10);
  if (!dueDate) return "is-info";
  const days = isoDayDistance(dueDate, todayIsoDate());
  if (days < 0) return "is-overdue";
  if (days === 0) return "is-due";
  return "is-info";
}

async function dismissWorkNotification(notification, button) {
  button.disabled = true;
  button.textContent = "Dismissing…";
  try {
    await request(
      workApiUrl(
        `/api/notifications/${encodeURIComponent(notification.id)}/dismiss`,
      ),
      { method: "PUT" },
    );
    workBellNotifications = workBellNotifications.filter(
      (item) => item.id !== notification.id,
    );
    workBellDismissErrors.delete(notification.id);
    syncWorkBellIndicators();
    renderWorkBellPanel();
  } catch (error) {
    workBellDismissErrors.set(
      notification.id,
      error.message || "Notification could not be dismissed",
    );
    renderWorkBellPanel();
    [...workBellBody.querySelectorAll("[data-dismiss-notification]")]
      .find(
        (candidate) =>
          candidate.dataset.dismissNotification === notification.id,
      )
      ?.focus();
  }
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

function renderUnifiedSearchResults(results, sources, query) {
  documentList.classList.remove("is-operations-home");
  documentList.classList.add("is-unified-search");
  libraryTitle.textContent = "Search results";
  clearSelectionButton.hidden = false;

  const wrap = document.createElement("div");
  wrap.className = "unified-search-results";
  const sourceState = renderSearchSourceState(sources);
  if (sourceState) wrap.append(sourceState);

  const safeResults = Array.isArray(results) ? results : [];
  if (safeResults.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query
      ? "No work or process context matches this search."
      : "Search for Cards, Tasks, Artifacts, Assistant jobs, Templates, or Process Docs.";
    wrap.append(empty);
    documentList.replaceChildren(wrap);
    return;
  }

  for (const group of groupSearchResults(safeResults)) {
    const section = document.createElement("section");
    section.className = "unified-search-group";
    const header = document.createElement("div");
    header.className = "unified-search-group-header";
    const title = document.createElement("h3");
    title.textContent = group.label;
    const count = document.createElement("span");
    count.textContent = String(group.items.length);
    header.append(title, count);
    section.append(header);
    for (const result of group.items)
      section.append(renderUnifiedSearchRow(result, query));
    wrap.append(section);
  }
  documentList.replaceChildren(wrap);
}

function renderSearchSourceState(sources) {
  const unavailable = (sources || []).filter(
    (source) => source && source.status === "unavailable",
  );
  if (unavailable.length === 0) return null;
  const section = document.createElement("section");
  section.className = "ops-runtime-state search-source-state";
  const title = document.createElement("strong");
  title.textContent = "Partial search results";
  const body = document.createElement("span");
  body.textContent =
    "Some work sources could not load. Document results and any loaded work sources remain visible.";
  section.append(title, body);
  const list = document.createElement("ul");
  for (const source of unavailable.slice(0, 5)) {
    const item = document.createElement("li");
    item.textContent = `${source.source || "source"}: ${source.error || "unavailable"}`;
    list.append(item);
  }
  section.append(list);
  return section;
}

function groupSearchResults(results) {
  const labels = {
    task: "Tasks",
    workflow: "Cards",
    template: "Runtime Templates",
    doc: "Process Docs",
    artifact: "Artifacts",
    file: "Files",
    "assistant-job": "Assistant Jobs",
  };
  const order = [
    "task",
    "workflow",
    "template",
    "doc",
    "artifact",
    "file",
    "assistant-job",
  ];
  const groups = new Map();
  for (const result of results) {
    const type = result?.type || "doc";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(result);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .map(([type, items]) => ({
      type,
      label: labels[type] || labelizeWorkValue(type),
      items,
    }));
}

function renderUnifiedSearchRow(result, query) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `unified-search-row result-${String(result.type || "doc").replace(/[^a-z0-9-]/gi, "-")}`;
  row.addEventListener("click", () => openUnifiedSearchResult(result));

  const main = document.createElement("div");
  main.className = "unified-search-main";
  const title = document.createElement("h3");
  setHighlightedText(
    title,
    result.title || result.id || result.path || "Untitled result",
    query,
  );
  const summary = document.createElement("p");
  setHighlightedText(
    summary,
    result.context || result.description || result.summary || "",
    query,
  );
  main.append(title, summary);

  const meta = document.createElement("div");
  meta.className = "unified-search-meta";
  const chips = [
    result.source_label || result.source || "",
    result.doc_type || result.fields?.status || result.fields?.stage || "",
    result.fields?.due_date ? `due ${result.fields.due_date}` : "",
    result.fields?.assignee ? `owner ${result.fields.assignee}` : "",
    result.fields?.workflow_title ? `card ${result.fields.workflow_title}` : "",
    result.fields?.proof || "",
    result.path || "",
  ].filter(Boolean);
  for (const chipText of chips.slice(0, 6)) {
    const chip = document.createElement("span");
    chip.textContent = chipText;
    meta.append(chip);
  }

  const action = document.createElement("span");
  action.className = "unified-search-action";
  action.textContent = result.action_label || "Open";
  row.append(main, meta, action);
  return row;
}

function openUnifiedSearchResult(result) {
  const route = result?.route || {};
  const kind = route.kind || result?.type;
  if (kind === "doc" && (route.path || result.path)) {
    openDocument(route.path || result.path);
    return;
  }
  if (kind === "task" && route.taskId) {
    openTaskPanel(route.taskId);
    return;
  }
  if ((kind === "workflow" || kind === "bundle") && route.bundleId) {
    openBundlePanel(route.bundleId);
    return;
  }
  if (kind === "template") {
    openQuickWorkflowForm({
      template: {
        templateId: route.templateId || result.id,
        type: route.templateType || result.fields?.template_type,
        title: result.title,
      },
    });
    return;
  }
  if (kind === "assistant-job") {
    navigateCanonicalWorkspace("/assistants", {
      assistantJobId: route.assistantJobId || result.id,
    });
    return;
  }
  if ((kind === "artifact" || kind === "file") && route.taskId) {
    openTaskPanel(route.taskId);
    return;
  }
  if ((kind === "artifact" || kind === "file") && route.bundleId) {
    openBundlePanel(route.bundleId);
    return;
  }
  if (kind === "artifact" || kind === "file") showWorkspaceSurface("artifacts");
}

function renderDocuments(documents, title) {
  documentList.classList.remove("is-operations-home");
  documentList.classList.remove("is-unified-search");
  libraryTitle.textContent = title;
  const hasFilter = !!(selectedFolder || searchInput.value.trim());
  clearSelectionButton.hidden = !hasFilter;

  if (documents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = searchInput.value.trim()
      ? "No documents match your search."
      : selectedFolder
        ? "No documents in this folder yet."
        : "No documents yet. Create your first page from the sidebar.";
    documentList.replaceChildren(empty);
    return;
  }

  const rows = documents.slice(0, LIST_LIMIT).map(renderDocumentRow);
  if (documents.length > LIST_LIMIT) {
    const more = document.createElement("div");
    more.className = "list-more";
    more.textContent = `Showing ${LIST_LIMIT} of ${documents.length}. Refine your search to see more.`;
    rows.push(more);
  }
  documentList.replaceChildren(...rows);
}

function renderDocumentRow(doc) {
  const row = documentRowTemplate.content.firstElementChild.cloneNode(true);
  const query = searchInput.value.trim();
  setHighlightedText(
    row.querySelector("h3"),
    doc.title || basename(doc.path),
    query,
  );
  setHighlightedText(
    row.querySelector("p"),
    doc.description || doc.summary || "No summary yet.",
    query,
  );
  row.querySelector(".doc-path").textContent = doc.path;
  row.querySelector(".doc-domain").textContent = doc.domain || "docs";
  row.querySelector(".doc-type").textContent = doc.doc_type || "doc";

  row.addEventListener("click", () => openDocument(doc.path));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDocument(doc.path);
    }
  });

  return row;
}

function renderTree(documents, options = {}) {
  const filter = searchInput.value.trim().toLowerCase();
  if (filter) {
    const matches = documents
      .filter((d) => {
        const hay = `${(d.title || "").toLowerCase()} ${d.path.toLowerCase()}`;
        return hay.includes(filter);
      })
      .slice(0, 50);
    const wrap = document.createElement("div");
    wrap.className = "tree-children";
    for (const doc of matches) wrap.append(renderTreeFile(doc));
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-filter-empty";
      empty.textContent = "No matching pages.";
      wrap.append(empty);
    }
    docTree.replaceChildren(wrap);
    return;
  }
  docTree.replaceChildren(renderTreeChildren(buildTree(documents), ""));
  if (options.revealCurrent) scrollCurrentTreeFileIntoView();
}

function buildTree(documents) {
  const root = { folders: new Map(), files: [] };

  for (const doc of documents) {
    const parts = cleanPath(doc.path).split("/");
    let node = root;

    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) {
        node.folders.set(part, { folders: new Map(), files: [] });
      }
      node = node.folders.get(part);
    }

    node.files.push(doc);
  }

  return root;
}

function renderTreeChildren(node, path) {
  const list = document.createElement("div");
  list.className = "tree-children";

  for (const [folderName, child] of [...node.folders.entries()].sort()) {
    const folderPath = path ? `${path}/${folderName}` : folderName;
    list.append(renderFolder(folderName, folderPath, child));
  }

  for (const doc of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
    list.append(renderTreeFile(doc));
  }

  return list;
}

function renderFolder(name, path, node) {
  const details = document.createElement("details");
  details.className = "tree-folder";
  const startOpen = isFolderOpen(path) || isCurrentDocFolder(path);
  details.open = startOpen;

  const summary = document.createElement("summary");
  summary.classList.toggle("is-selected", selectedFolder === path);

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = name;
  summary.append(chevron, label);

  summary.addEventListener("click", (event) => {
    if (event.target.closest(".chevron")) {
      // Let <details> handle expand/collapse from the disclosure control.
      return;
    }
    event.preventDefault();
    selectedFolder = path;
    searchInput.value = "";
    details.open = true;
    hydrate();
    setFolderUrl(path);
    setView("library");
    syncLibraryPageTitle();
    refreshDocuments();
  });

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "tree-folder-menu";
  menu.title = "Folder actions";
  menu.textContent = "⋯";
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    openFolderMenu(menu, path);
  });
  summary.append(menu);

  details.append(summary);

  // Lazy: only build children DOM the first time the folder is opened.
  let hydrated = false;
  const childrenSlot = document.createElement("div");
  childrenSlot.className = "tree-children-slot";
  details.append(childrenSlot);

  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    childrenSlot.replaceWith(renderTreeChildren(node, path));
  };

  if (startOpen) hydrate();
  details.addEventListener("toggle", () => {
    if (details.open) hydrate();
  });

  return details;
}

function renderTreeFile(doc) {
  const button = document.createElement("button");
  button.className = "tree-file";
  button.type = "button";
  button.dataset.path = doc.path;
  button.classList.toggle("is-current", doc.path === currentTreePath);
  const label = document.createElement("span");
  label.className = "tree-file-label";
  label.textContent = doc.title || basename(doc.path);
  button.append(label);
  if (localStorage.getItem(draftKey(doc.path)) !== null) {
    button.classList.add("has-draft");
    const dot = document.createElement("span");
    dot.className = "tree-file-dot";
    dot.title = "Unsaved local draft";
    button.append(dot);
  }
  if (typeof doc.updated === "number") {
    button.title = `Last saved ${relativeTime(doc.updated)}`;
  }
  button.addEventListener("click", () => openDocument(doc.path));
  return button;
}

function rebuildDocumentIdMap() {
  documentIdMap = new Map();
  for (const doc of allDocuments) {
    if (doc.id) documentIdMap.set(String(doc.id), doc);
    if (Array.isArray(doc.aliases)) {
      for (const alias of doc.aliases) {
        if (alias) documentIdMap.set(String(alias), doc);
      }
    }
    documentIdMap.set(doc.path, doc);
    documentIdMap.set(cleanPath(doc.path), doc);
  }
}

function resolveDocReference(ref) {
  const key = String(ref || "").trim();
  if (!key) return null;
  return (
    documentIdMap.get(key) || documentIdMap.get(key.replace(/^\/+/, "")) || null
  );
}

function relativeTime(epoch) {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - epoch);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString();
}

function isFolderOpen(path) {
  if (!selectedFolder) return false;
  return selectedFolder === path || selectedFolder.startsWith(`${path}/`);
}

function isCurrentDocFolder(path) {
  if (!currentTreePath) return false;
  return cleanPath(currentTreePath).startsWith(`${path}/`);
}

function scrollCurrentTreeFileIntoView() {
  requestAnimationFrame(() => {
    const current = docTree.querySelector(".tree-file.is-current");
    if (current) current.scrollIntoView({ block: "center" });
  });
}

function updateCurrentTreeSelection() {
  for (const btn of docTree.querySelectorAll(".tree-file")) {
    btn.classList.toggle("is-current", btn.dataset.path === currentTreePath);
  }
}

const _scrollPositions = new Map();

function captureScrollPosition() {
  if (!currentDoc) return;
  const scrollEl = editorView.dataset.mode === "rendered" ? editorView : editor;
  if (scrollEl) _scrollPositions.set(currentDoc.path, scrollEl.scrollTop || 0);
}

async function openDocument(path, options = {}) {
  if (!(await canLeaveCurrentDocument())) return;
  ++activeWorkspaceRouteToken;
  activeWorkspaceRoute = null;
  resetTaskPanel();
  resetBundlePanel();
  closeWorkBellPanel({ updateUrl: false, restoreFocus: false });
  captureScrollPosition();
  docReturnContext = options.returnContext || null;
  renderDocReturnContext();

  documentTitle.disabled = true;
  editor.disabled = true;
  setSaveState("Loading...");
  setView("editor");
  setPageTitle(basename(path), path);
  documentPath.textContent = path;

  try {
    const url = apiUrl("/docs");
    url.searchParams.set("path", path);
    const payload = await request(url);

    currentDoc = { path: payload.path, updated: payload.updated };
    currentTreePath = payload.path;
    if (options.updateUrl !== false) setDocumentUrl(payload.path);
    currentParsed = payload.parsed || null;
    currentWarnings = [];
    lastSavedContent = payload.content;
    docMenuButton.hidden = false;
    updateGithubLink();
    updatePinButton();
    pushRecentlyViewed(payload.path);
    renderRecentlyViewed();
    if (options.revealInTree) {
      renderTree(filterDocuments(allDocuments), { revealCurrent: true });
    } else {
      updateCurrentTreeSelection();
    }

    const draft = localStorage.getItem(draftKey(payload.path));
    hasDraft = draft !== null;
    refreshChangesPanel();
    editor.value = draft ?? payload.content;
    editor.disabled = false;
    documentTitle.disabled = false;
    documentTitle.value =
      titleFromMarkdown(editor.value) || basename(payload.path);
    documentPath.textContent = payload.path;

    updateSaveState();
    setPageTitle(documentTitle.value, payload.path);
    renderDocReturnContext();
    updateViewToggleAvailability();
    // Default to the block view when the doc has parseable sections, so
    // SOPs read as structured content rather than raw markdown.
    enterRenderedMode();
    const restoreTop = _scrollPositions.get(payload.path) || 0;
    const scrollEl =
      editorView.dataset.mode === "rendered" ? editorView : editor;
    if (scrollEl) {
      // Defer to next frame so layout has settled.
      requestAnimationFrame(() => {
        scrollEl.scrollTop = restoreTop;
      });
    }
  } catch (error) {
    setStatus(error.message);
    setSaveState("");
    documentTitle.disabled = !currentDoc;
    editor.disabled = !currentDoc;
  }
}

function renderDocReturnContext() {
  if (!docContextReturn) return;
  docContextReturn.replaceChildren();
  if (!docReturnContext) {
    docContextReturn.hidden = true;
    return;
  }
  docContextReturn.hidden = false;
  const text = document.createElement("span");
  text.textContent =
    docReturnContext.type === "workflow"
      ? `Opened from Card: ${docReturnContext.title || docReturnContext.id || "Card"}`
      : `Opened from task: ${docReturnContext.title || docReturnContext.id || "Task"}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet-button";
  button.textContent =
    docReturnContext.type === "workflow" ? "Back to Card" : "Back to Task";
  button.addEventListener("click", () => {
    const context = docReturnContext;
    docReturnContext = null;
    renderDocReturnContext();
    showOperationsHome().then(() => {
      if (context?.type === "workflow" && context.id)
        openBundlePanel(context.id);
      else if (context?.type === "task" && context.id)
        openTaskPanel(context.id);
    });
  });
  docContextReturn.append(text, button);
}

function localDocPathFromHref(href) {
  const value = String(href || "").trim();
  if (!value) return "";
  if (value.startsWith("content/") && value.endsWith(".md")) return value;
  if (value.startsWith("/content/") && value.endsWith(".md"))
    return value.replace(/^\/+/, "");
  try {
    const url = new URL(value, window.location.origin);
    const path = decodeURIComponent(url.pathname || "").replace(/^\/+/, "");
    if (path.startsWith("content/") && path.endsWith(".md")) return path;
    if (path.endsWith(".md")) return `content/${path}`;
  } catch {}
  return "";
}

function docPathFromLocation() {
  const raw = decodeURIComponent(window.location.pathname || "/").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!raw || raw === "login" || raw === "logout") return "";
  if (raw.startsWith("content/")) return raw;
  if (!raw.endsWith(".md")) return "";
  return `content/${raw}`;
}

function folderPathFromLocation() {
  const raw = decodeURIComponent(window.location.pathname || "/").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!raw || raw === "login" || raw === "logout" || raw.endsWith(".md"))
    return "";
  return raw.replace(/^content\//, "");
}

function folderExists(path) {
  if (!path) return false;
  return allDocuments.some((doc) => cleanPath(doc.path).startsWith(`${path}/`));
}

function setDocumentUrl(path) {
  const visible = "/" + path.replace(/^content\//, "");
  if (
    window.location.pathname !== visible ||
    window.location.search ||
    window.location.hash
  ) {
    history.pushState({ path }, "", visible);
  }
}

function setFolderUrl(path) {
  const visible = path ? `/${path}` : "/";
  if (
    window.location.pathname !== visible ||
    window.location.search ||
    window.location.hash
  ) {
    history.pushState({ folder: path }, "", visible);
  }
}

function replaceWithWorkspaceHome() {
  const target = canonicalWorkspaceUrl("/");
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== target)
    history.replaceState(
      { workspace: "home", tasksSection: "queue" },
      "",
      target,
    );
  return parseWorkspaceHash("#/");
}

function isWorkspaceRouteFresh(token) {
  return token === activeWorkspaceRouteToken;
}

function visibleEntityFocusTarget(restoreFocus) {
  if (restoreFocus?.kind === "runtime-template-list") {
    const search = document.querySelector(".runtime-template-search");
    return search instanceof HTMLElement &&
      search.isConnected &&
      search.offsetParent !== null
      ? search
      : null;
  }
  if (!restoreFocus?.id) return null;
  const candidates =
    restoreFocus.kind === "workflow"
      ? [...document.querySelectorAll(".ops-workflow-card[data-bundle-id]")]
      : restoreFocus.surface === "workflows"
        ? [
            ...document.querySelectorAll(
              ".bundle-checklist-label[data-task-id]",
            ),
          ]
        : [...document.querySelectorAll(".ops-queue-row[data-task-id]")];
  const dataKey = restoreFocus.kind === "workflow" ? "bundleId" : "taskId";
  return (
    candidates.find(
      (candidate) =>
        candidate.dataset[dataKey] === restoreFocus.id &&
        candidate.isConnected &&
        candidate.offsetParent !== null,
    ) || null
  );
}

function restoreWorkspaceEntityFocus(restoreFocus, token) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      if (!isWorkspaceRouteFresh(token)) {
        resolve();
        return;
      }
      const recreatedRow = visibleEntityFocusTarget(restoreFocus);
      const target = recreatedRow || libraryTitle;
      if (target === libraryTitle) target.tabIndex = -1;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
      resolve();
    });
  });
}

function commitWorkspaceRoute(route, token, options = {}) {
  activeWorkspaceRoute = route;
  pendingLegacyRoute = { ...route, token };
  workspaceEntityState = null;
  if (route.view === "tasks") activeTasksSection = route.tasksSection;
  intakeState.selectedId =
    route.view === "inbox" ? route.params.get("intakeId") : null;
  assistantQueueState.selectedJobId =
    route.tasksSection === "assistants"
      ? route.params.get("assistantJobId")
      : null;
  setRuntimeTemplateRoute(route, options.entity);
  setTaskRouteContextFromRoute(route);

  resetTaskPanel();
  resetBundlePanel();
  closeWorkBellPanel({ updateUrl: false, restoreFocus: false });
  closeSettingsMenu();

  const requestedView =
    route.view === "tasks" && route.tasksSection !== "queue"
      ? route.tasksSection
      : route.view;
  const tasksSection = LEGACY_VIEW_TO_TASKS_SECTION(requestedView);
  if (tasksSection) {
    activeWorkspaceView = "tasks";
    activeTasksSection = tasksSection;
  } else if (requestedView === "tasks") {
    activeWorkspaceView = "tasks";
    activeTasksSection = "queue";
  } else if (requestedView === "processes" || requestedView === "search") {
    activeWorkspaceView = "docs";
  } else {
    activeWorkspaceView = requestedView || "home";
  }
  syncWorkspaceNav();
  libraryTitle.textContent = operationsViewTitle(
    activeWorkspaceView,
    activeTasksSection,
  );
  selectedFolder = "";
  searchInput.value = "";
  clearDocumentFilters();
  setView("library");
  // Each top-level area owns the complete main canvas. Clear the old route
  // before dispatch so none of its status, filters, headings, or content can
  // travel into the next view while that renderer starts.
  documentList.replaceChildren();
  refreshDocuments();
  closeSidebar();

  const bundleId = ["/cards", "/cards/archive"].includes(route.path)
    ? route.params.get("cardId")
    : "";
  const taskId = route.params.get("taskId");
  if (bundleId) prepareBundlePanel(bundleId);
  if (taskId) prepareTaskPanel(taskId);
  if (route.path === "/notifications") openWorkBellPanel();
}

function hydrateWorkspaceRoute(route, token) {
  const jobs = [];
  if (route.path === "/inbox")
    jobs.push(resolveIntakeRouteEntity(route, token));
  if (route.path === "/tasks")
    jobs.push(resolveTaskQueueRouteContext(route, token));
  if (route.path === "/templates")
    jobs.push(resolveTemplateRouteEntity(route, token));
  if (route.path === "/assistants")
    jobs.push(refreshOperationsAssistantSnapshot({ rerender: true, token }));
  if (route.path === "/notifications") jobs.push(refreshWorkBell({ token }));
  if (route.path === "/artifacts")
    jobs.push(refreshOperationsArtifactSnapshot({ rerender: true }));
  if (route.path === "/users")
    jobs.push(refreshUsersSurface({ rerender: true }));
  const bundleId = ["/cards", "/cards/archive"].includes(route.path)
    ? route.params.get("cardId")
    : "";
  const taskId = route.params.get("taskId");
  if (bundleId) jobs.push(hydrateBundlePanel(bundleId, token));
  if (taskId)
    jobs.push(
      hydrateTaskPanel(taskId, token, { expectedBundleId: bundleId || "" }),
    );
  if (route.path === "/recurring") {
    requestAnimationFrame(() => {
      if (!isWorkspaceRouteFresh(token)) return;
      const recurring = document.querySelector(".ops-recurring-section");
      if (recurring) {
        recurring.tabIndex = -1;
        recurring.focus();
      }
    });
  }
  return Promise.allSettled(jobs);
}

function navigateCanonicalWorkspace(path, params = {}, options = {}) {
  const route = options.route || workspaceRouteFor(path, params);
  if (!route || route.invalid)
    return {
      route,
      token: activeWorkspaceRouteToken,
      ready: Promise.resolve(),
    };
  const token = ++activeWorkspaceRouteToken;
  const visible = route.canonicalUrl;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const historyMode = options.history || "push";
  if (historyMode !== "none" && current !== visible) {
    history[historyMode === "replace" ? "replaceState" : "pushState"](
      { workspace: route.view, tasksSection: route.tasksSection },
      "",
      visible,
    );
  }
  commitWorkspaceRoute(route, token, options);
  const hydration =
    options.hydrate === false
      ? Promise.resolve()
      : hydrateWorkspaceRoute(route, token);
  const ready = hydration.then(() =>
    options.restoreFocus
      ? restoreWorkspaceEntityFocus(options.restoreFocus, token)
      : undefined,
  );
  return { route, token, ready };
}

async function applyWorkspaceRoute(route) {
  if (!route || route.invalid) return;
  const previousRoute = activeWorkspaceRoute;
  if (initialRouteReady && !(await canLeaveCurrentDocument())) {
    if (previousRoute?.canonicalUrl) {
      history.replaceState(
        {
          workspace: previousRoute.view,
          tasksSection: previousRoute.tasksSection,
        },
        "",
        previousRoute.canonicalUrl,
      );
    }
    return;
  }
  await navigateCanonicalWorkspace(route.path, route.params, {
    route,
    history: "none",
  }).ready;
}
async function saveCurrentDocument() {
  if (!currentDoc) return;

  const url = apiUrl("/docs");
  url.searchParams.set("path", currentDoc.path);
  saveButton.disabled = true;
  setSaveState("Saving...");

  try {
    const payload = await request(url, {
      method: "PUT",
      body: JSON.stringify({ content: editor.value }),
    });

    currentDoc.updated = payload.updated;
    lastSavedContent = editor.value;
    localStorage.removeItem(draftKey(currentDoc.path));
    hasDraft = false;
    currentParsed = null;
    updateViewToggleAvailability();
    if (editorView.dataset.mode === "rendered") {
      // Body changed; reparse via API.
      await refreshParsedFromApi();
      renderParsedDocument();
    }
    updateSaveState();
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    currentWarnings = warnings;
    if (warnings.length) {
      flashSaveState(
        `Saved with ${warnings.length} lint warning${warnings.length === 1 ? "" : "s"}`,
      );
      setStatus(
        `Saved · ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ""}`,
      );
    } else {
      flashSaveState("Saved");
      setStatus(`Saved ${currentDoc.path}.`);
    }
    if (editorView.dataset.mode === "rendered") renderParsedDocument();
    refreshChangesPanel();
    refreshGitStatus();
    await loadDocuments();
  } catch (error) {
    setStatus(error.message);
    updateSaveState();
  }
}

function discardDraft() {
  if (!currentDoc) return;
  localStorage.removeItem(draftKey(currentDoc.path));
  hasDraft = false;
  editor.value = lastSavedContent;
  documentTitle.value =
    titleFromMarkdown(editor.value) || basename(currentDoc.path);
  updateSaveState();
  refreshChangesPanel();
}

async function createDocument() {
  let path = newDocPath.value.trim();
  const title = newDocTitle.value.trim();
  const docType = newDocType.value;
  const summary = newDocSummary.value.trim();
  const scaffold =
    document.querySelector('input[name="scaffold"]:checked')?.value || "full";

  if (!path) {
    setStatus("Path is required.");
    return;
  }
  // Normalise so the user gets a friendly hint instead of a backend 400.
  path = path.replace(/^\/+/, "");
  if (!path.startsWith("content/")) {
    path = `content/${path}`;
  }
  if (!path.endsWith(".md")) {
    path += ".md";
  }

  try {
    const payload = await request(apiUrl("/docs"), {
      method: "POST",
      body: JSON.stringify({
        path,
        title,
        doc_type: docType,
        summary,
        scaffold,
      }),
    });

    newDocForm.reset();
    await loadDocuments();
    await openDocument(payload.path);
    setStatus(`Created ${payload.path}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function syncTitleToMarkdown() {
  if (!currentDoc) return;
  const title = normalizedDocumentTitle() || basename(currentDoc.path);
  if (documentTitle.value !== title) documentTitle.value = title;
  resizeDocumentTitle();
  editor.value = setMarkdownTitle(editor.value, title);
  storeDraft();
  updateSaveState();
  setPageTitle(title, currentDoc.path);
}

function normalizedDocumentTitle() {
  return documentTitle.value.replace(/\s+/g, " ").trim();
}

function resizeDocumentTitle() {
  if (getComputedStyle(documentTitle).display === "none") return;
  const fallbackHeight =
    parseFloat(getComputedStyle(documentTitle).lineHeight) || 32;
  documentTitle.style.height = "auto";
  documentTitle.style.height = `${Math.max(documentTitle.scrollHeight, fallbackHeight)}px`;
}

function setMarkdownTitle(markdown, title) {
  let next = markdown;

  const fmMatch = next.match(/^---\n[\s\S]*?\n---/);
  if (fmMatch) {
    const fm = fmMatch[0];
    const updated = /\ntitle:\s*/.test(fm)
      ? fm.replace(/(\ntitle:\s*).*/, `$1"${title}"`)
      : fm.replace(/^---\n/, `---\ntitle: "${title}"\n`);
    next = updated + next.slice(fm.length);
  }

  const bodyOffset = next.match(/^---\n[\s\S]*?\n---\n?/)?.[0].length || 0;
  const body = next.slice(bodyOffset);

  // Replace H1 only if it is the first non-empty line of the body.
  const topH1 = body.match(/^(\s*)#\s+.+/);
  if (topH1) {
    const rewritten = `${topH1[1]}# ${title}` + body.slice(topH1[0].length);
    return next.slice(0, bodyOffset) + rewritten;
  }

  // Prepend an H1 only when the body is empty/whitespace.
  if (/^\s*$/.test(body)) {
    return next.slice(0, bodyOffset) + `# ${title}\n`;
  }

  // Body has content but no top-level H1 — leave the document alone.
  return next;
}

function storeDraft() {
  const wasDraft = hasDraft;
  localStorage.setItem(draftKey(currentDoc.path), editor.value);
  hasDraft = true;
  if (!wasDraft) refreshChangesPanel();
}

function updateSaveState() {
  if (!currentDoc) {
    saveButton.disabled = true;
    discardButton.disabled = true;
    setSaveState("");
    saveState.classList.remove("has-changes");
    return;
  }

  const hasChanges = editor.value !== lastSavedContent;
  saveButton.disabled = !hasChanges;
  discardButton.disabled = !hasDraft;
  if (hasChanges) {
    setSaveState("Unsaved changes");
  } else {
    setSaveState("");
  }
  saveState.classList.toggle("has-changes", hasChanges);
}

// Refresh "Saved · 2 min ago" every minute so the relative time stays current.
setInterval(() => {
  if (currentDoc && editor.value === lastSavedContent) updateSaveState();
}, 60000);

function flashSaveState(message, duration = 1800) {
  setSaveState(message);
  saveState.classList.add("flash");
  if (flashSaveState._timer) clearTimeout(flashSaveState._timer);
  flashSaveState._timer = setTimeout(() => {
    saveState.classList.remove("flash");
    updateSaveState();
  }, duration);
}

async function canLeaveCurrentDocument() {
  if (!(await canLeaveFinanceSurface("navigation"))) return false;
  if (!(await confirmLeaveRuntimeDraft())) return false;
  if (!currentDoc || editor.value === lastSavedContent) return true;
  return await confirmDialog(
    "This page has unsaved local changes. Leave it anyway?",
    { okText: "Leave", danger: true },
  );
}

function showLibrary(options = {}) {
  setView("library");
  if (options.updateUrl !== false) setFolderUrl(selectedFolder);
  syncLibraryPageTitle();
  closeWorkBellPanel();
  closeSidebar();
}

function syncLibraryPageTitle() {
  if (body.dataset.view !== "library") return;
  if (!selectedFolder && !searchInput.value.trim()) {
    setPageTitle(
      operationsViewTitle(activeWorkspaceView, activeTasksSection),
      activeWorkspaceView === "home"
        ? "Home"
        : operationsViewPath(activeWorkspaceView),
    );
    return;
  }
  setPageTitle("", "");
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

async function showCreate() {
  if (!(await canLeaveCurrentDocument())) return;
  ++activeWorkspaceRouteToken;
  activeWorkspaceRoute = null;
  resetTaskPanel();
  resetBundlePanel();
  closeWorkBellPanel({ updateUrl: false, restoreFocus: false });
  if (!newDocPath.value.trim()) {
    const base = selectedFolder ? `content/${selectedFolder}` : "content";
    newDocPath.value = `${base}/new-document.md`;
  }
  setPageTitle("New page", "Create");
  setView("create");
  closeSidebar();
  newDocPath.focus();
}

function clearSelection() {
  selectedFolder = "";
  searchInput.value = "";
  setFolderUrl("");
  refreshDocuments();
}

function clearDocumentFilters() {
  for (const select of [domainFilter, typeFilter, systemFilter, tagFilter]) {
    select.value = "";
    const entry = customSelects.find((item) => item.select === select);
    if (entry) updateCustomSelect(entry.root);
  }
  updateFilterSummary();
}

function setView(view) {
  body.dataset.view = view;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isMobileShell() {
  return window.matchMedia("(max-width: 820px)").matches;
}

function syncSidebarShellState() {
  const open = body.classList.contains("sidebar-open");
  if (!isMobileShell()) {
    body.classList.remove("sidebar-open");
    sidebarScrim.hidden = true;
    mobileMenuButton.setAttribute("aria-expanded", "false");
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("aria-hidden");
    sidebar.inert = false;
    pageShell.inert = false;
    if (mobileWorkBellButton) mobileWorkBellButton.inert = false;
    mobileNewButton.inert = false;
    document.removeEventListener("keydown", handleSidebarKeydown);
    return;
  }
  sidebarScrim.hidden = !open;
  mobileMenuButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    sidebar.removeAttribute("aria-hidden");
    sidebar.inert = false;
  } else {
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    sidebar.setAttribute("aria-hidden", "true");
    sidebar.inert = true;
  }
  pageShell.inert = open;
  if (mobileWorkBellButton) mobileWorkBellButton.inert = open;
  mobileNewButton.inert = open;
}

function openSidebar() {
  lastSidebarOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : mobileMenuButton;
  body.classList.add("sidebar-open");
  syncSidebarShellState();
  document.addEventListener("keydown", handleSidebarKeydown);
  const first = sidebar.querySelector(FOCUSABLE_SELECTOR);
  first?.focus();
}

function closeSidebar() {
  if (!body.classList.contains("sidebar-open")) return;
  body.classList.remove("sidebar-open");
  syncSidebarShellState();
  document.removeEventListener("keydown", handleSidebarKeydown);
  const focusTarget = lastSidebarOpener?.isConnected
    ? lastSidebarOpener
    : mobileMenuButton;
  if (focusTarget instanceof HTMLElement) focusTarget.focus();
  lastSidebarOpener = null;
}

function handleSidebarKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSidebar();
    return;
  }
  if (event.key !== "Tab") return;

  const focusables = [...sidebar.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null,
  );
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !sidebar.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !sidebar.contains(active))
  ) {
    event.preventDefault();
    first.focus();
  }
}

function setPageTitle(title, path) {
  toolbarTitle.textContent = title;
  mobileTitle.textContent = title;
  breadcrumb.textContent = path;
  resizeDocumentTitle();
}

function enhanceSelect(select) {
  const root = document.createElement("div");
  root.className = "custom-select";

  const button = document.createElement("button");
  button.className = "custom-select-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  const arrow = document.createElement("span");
  arrow.className = "custom-select-arrow";
  arrow.setAttribute("aria-hidden", "true");
  button.append(label, arrow);

  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.setAttribute("role", "listbox");

  const commit = (value) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    updateCustomSelect(root);
    closeCustomSelects();
    button.focus();
  };

  const renderOptions = () => {
    menu.replaceChildren(
      ...[...select.options].map((option) => {
        const item = document.createElement("button");
        item.className = "custom-select-option";
        item.type = "button";
        item.tabIndex = -1;
        item.setAttribute("role", "option");
        item.dataset.value = option.value;
        item.textContent = option.textContent;
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          commit(option.value);
        });
        return item;
      }),
    );
  };

  renderOptions();

  const openMenu = () => {
    closeCustomSelects();
    root.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    const items = [...menu.querySelectorAll(".custom-select-option")];
    const selectedIdx = items.findIndex(
      (el) => el.dataset.value === select.value,
    );
    items[Math.max(0, selectedIdx)]?.focus();
  };

  const closeMenu = () => {
    closeCustomSelects();
    button.focus();
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (root.classList.contains("is-open")) closeMenu();
    else openMenu();
  });

  button.addEventListener("keydown", (event) => {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      openMenu();
    }
  });

  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll(".custom-select-option")];
    const idx = items.indexOf(document.activeElement);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(items.length - 1, Math.max(0, idx) + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.max(0, (idx < 0 ? items.length : idx) - 1)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (idx >= 0) commit(items[idx].dataset.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "Tab") {
      closeCustomSelects();
    }
  });

  root.append(button, menu);
  select.classList.add("native-select");
  select.after(root);
  customSelects.push({ root, select, label, button, renderOptions });
  updateCustomSelect(root);
}

function setSelectOptions(select, values, allLabel = "All") {
  const previous = select.value;
  const items = [
    new Option(allLabel, ""),
    ...values.map((v) => new Option(humanizeOptionLabel(v), v)),
  ];
  select.replaceChildren(...items);
  select.value = values.includes(previous) ? previous : "";

  const entry = customSelects.find((c) => c.select === select);
  if (entry) {
    entry.renderOptions();
    updateCustomSelect(entry.root);
  }
}

function humanizeOptionLabel(value) {
  return value
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function populateFilterOptions() {
  const domains = [
    ...new Set(allDocuments.map((d) => d.domain).filter(Boolean)),
  ].sort();
  const types = [
    ...new Set(allDocuments.map((d) => d.doc_type).filter(Boolean)),
  ].sort();
  const systems = [
    ...new Set(allDocuments.flatMap((d) => d.systems || []).filter(Boolean)),
  ].sort();
  const tags = [
    ...new Set(allDocuments.flatMap((d) => d.tags || []).filter(Boolean)),
  ].sort();
  setSelectOptions(domainFilter, domains);
  setSelectOptions(typeFilter, types);
  setSelectOptions(systemFilter, systems);
  setSelectOptions(tagFilter, tags);
  updateFilterSummary();
  restoreFiltersExpanded();
}

function updateCustomSelect(root) {
  const item = customSelects.find((entry) => entry.root === root);
  if (!item) return;

  const selected = item.select.selectedOptions[0];
  item.label.textContent = selected?.textContent || "";
  item.root.querySelectorAll(".custom-select-option").forEach((option) => {
    const isSelected = option.dataset.value === item.select.value;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-selected", String(isSelected));
  });
}

function closeCustomSelects() {
  customSelects.forEach(({ root, button }) => {
    root.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
}

function setStatus(message) {
  statusText.textContent = message;
}

function setSaveState(message) {
  saveState.textContent = message;
}

function titleFromMarkdown(markdown) {
  const frontmatterTitle = markdown.match(
    /^---[\s\S]*?\ntitle:\s*"?([^"\n]+)"?[\s\S]*?\n---/,
  );
  if (frontmatterTitle) return frontmatterTitle[1].trim();
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : "";
}

function setHighlightedText(el, text, query) {
  const safe = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (!query) {
    el.textContent = text;
    return;
  }
  const tokens = query.split(/\s+/).filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) {
    el.textContent = text;
    return;
  }
  const re = new RegExp(`(${tokens.join("|")})`, "gi");
  el.innerHTML = safe.replace(re, "<mark>$1</mark>");
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

function draftKey(path) {
  return `dtc-doc-draft:${path}`;
}

function apiUrl(path) {
  return new URL(path, API_BASE);
}

async function request(url, options = {}) {
  const token = (() => {
    try {
      return localStorage.getItem("dataops_token");
    } catch {
      return null;
    }
  })();
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (token && !headers.Authorization && !headers.authorization)
    headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    ...options,
    headers,
  });

  const text = await response.text();
  let payload = null;
  let parsedJson = false;
  if (text) {
    try {
      payload = JSON.parse(text);
      parsedJson = true;
    } catch {
      // Non-JSON response (HTML error page, plain text, etc.).
    }
  }

  if (text && !parsedJson) {
    const fallback = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const error = new Error(
      response.ok ? "Unexpected non-JSON API response" : fallback,
    );
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const fallback = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const error = new Error(payload?.error || fallback);
    error.status = response.status;
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }

  return payload || {};
}

function resultCount(items, noun) {
  if (items.length === 1) return `1 ${noun} found.`;
  return `${items.length} ${noun}s found.`;
}

// ---------- Pending changes panel ----------

function listDraftPaths() {
  const paths = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) {
        paths.push(key.slice(DRAFT_PREFIX.length));
      }
    }
  } catch {}
  paths.sort();
  return paths;
}

function refreshChangesPanel() {
  const paths = listDraftPaths();
  const draftSet = new Set(paths);
  // Sync the per-file dot in the doc tree.
  for (const btn of docTree.querySelectorAll(".tree-file")) {
    const path = btn.dataset.path;
    const has = draftSet.has(path);
    if (has !== btn.classList.contains("has-draft")) {
      btn.classList.toggle("has-draft", has);
      const existing = btn.querySelector(".tree-file-dot");
      if (has && !existing) {
        const dot = document.createElement("span");
        dot.className = "tree-file-dot";
        dot.title = "Unsaved local draft";
        btn.append(dot);
      } else if (!has && existing) {
        existing.remove();
      }
    }
  }
  changesCount.textContent = String(paths.length);
  if (paths.length === 0) {
    changesSection.hidden = true;
    changesList.replaceChildren();
    return;
  }
  changesSection.hidden = false;
  const items = paths.map((path) => {
    const row = document.createElement("div");
    row.className = "changes-row-wrap";
    const button = document.createElement("button");
    button.className = "changes-row";
    button.type = "button";
    button.title = path;
    const label = document.createElement("span");
    label.className = "changes-row-label";
    label.textContent = labelForPath(path);
    const sub = document.createElement("span");
    sub.className = "changes-row-path";
    sub.textContent = path;
    button.append(label, sub);
    button.addEventListener("click", () => openDocument(path));
    row.append(button);
    const diff = document.createElement("button");
    diff.className = "changes-row-diff";
    diff.type = "button";
    diff.textContent = "Diff";
    diff.title = "Show diff vs saved";
    diff.addEventListener("click", (event) => {
      event.stopPropagation();
      showDiffForDraft(path);
    });
    row.append(diff);
    const drop = document.createElement("button");
    drop.className = "changes-row-diff";
    drop.type = "button";
    drop.textContent = "×";
    drop.title = "Discard this draft";
    drop.addEventListener("click", async (event) => {
      event.stopPropagation();
      const ok = await confirmDialog(`Discard the local draft for ${path}?`, {
        okText: "Discard",
        danger: true,
      });
      if (!ok) return;
      localStorage.removeItem(draftKey(path));
      if (currentDoc && currentDoc.path === path) {
        hasDraft = false;
        editor.value = lastSavedContent;
        documentTitle.value =
          titleFromMarkdown(editor.value) || basename(currentDoc.path);
        updateSaveState();
        if (editorView.dataset.mode === "rendered") {
          await refreshParsedFromApi();
          renderParsedDocument();
        }
      }
      refreshChangesPanel();
    });
    row.append(drop);
    return row;
  });
  changesList.replaceChildren(...items);
}

function labelForPath(path) {
  const known = allDocuments.find((d) => d.path === path);
  if (known && known.title) return known.title;
  return basename(path);
}

async function saveAllDrafts() {
  const paths = listDraftPaths();
  if (paths.length === 0) return;
  if (paths.length > 5) {
    const ok = await confirmDialog(
      `Save all ${paths.length} drafts? This writes ${paths.length} files at once.`,
      { okText: "Save all" },
    );
    if (!ok) return;
  }
  changesSaveAll.disabled = true;
  changesSaveAll.classList.add("is-busy");
  changesDiscardAll.disabled = true;
  let failed = 0;
  let savedCount = 0;
  for (const path of paths) {
    const draft = localStorage.getItem(draftKey(path));
    if (draft === null) continue;
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      await request(url, {
        method: "PUT",
        body: JSON.stringify({ content: draft }),
      });
      localStorage.removeItem(draftKey(path));
      savedCount += 1;
      if (currentDoc && currentDoc.path === path) {
        lastSavedContent = draft;
        hasDraft = false;
      }
    } catch (err) {
      failed += 1;
      console.warn(`Save failed for ${path}:`, err);
    }
  }
  refreshChangesPanel();
  if (currentDoc) updateSaveState();
  changesSaveAll.disabled = false;
  changesSaveAll.classList.remove("is-busy");
  changesDiscardAll.disabled = false;
  setStatus(
    failed
      ? `Saved ${savedCount}, ${failed} failed.`
      : `Saved ${savedCount} document${savedCount === 1 ? "" : "s"}.`,
  );
  await loadDocuments();
  refreshGitStatus();
}

async function discardAllDrafts() {
  const paths = listDraftPaths();
  if (paths.length === 0) return;
  const ok = await confirmDialog(
    `Discard ${paths.length} unsaved draft${paths.length === 1 ? "" : "s"}?`,
    { okText: "Discard all", danger: true },
  );
  if (!ok) return;
  for (const path of paths) localStorage.removeItem(draftKey(path));
  if (currentDoc) {
    hasDraft = false;
    editor.value = lastSavedContent;
    documentTitle.value =
      titleFromMarkdown(editor.value) || basename(currentDoc.path);
    updateSaveState();
  }
  refreshChangesPanel();
}

// ---------- Git commit + push ----------

// ---------- Folder actions menu ----------

function openFolderMenu(anchorEl, folderPath) {
  const existing = document.querySelector(".doc-menu-popover");
  if (existing) {
    existing.remove();
    return;
  }
  const popover = document.createElement("div");
  popover.className = "doc-menu-popover";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "doc-menu-item";
  renameBtn.textContent = "Rename…";
  renameBtn.addEventListener("click", () => {
    popover.remove();
    renameFolder(folderPath);
  });
  popover.append(renameBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "doc-menu-item is-danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => {
    popover.remove();
    deleteFolder(folderPath);
  });
  popover.append(delBtn);

  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${rect.left}px`;
  document.body.append(popover);

  const close = (ev) => {
    if (!popover.contains(ev.target) && ev.target !== anchorEl) {
      popover.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

async function renameFolder(folderPath) {
  const fullOld = `content/${folderPath}`;
  let fullNew = window.prompt("New folder path:", fullOld);
  if (!fullNew) return;
  fullNew = fullNew.trim();
  if (fullNew === fullOld) return;
  if (!fullNew.startsWith("content/")) {
    setStatus("Folder path must start with content/");
    return;
  }
  try {
    const payload = await request(apiUrl("/folders/rename"), {
      method: "POST",
      body: JSON.stringify({ old_path: fullOld, new_path: fullNew }),
    });
    // Rewrite any open doc + drafts under the renamed prefix.
    const oldPrefix = `${payload.old_path}/`;
    const newPrefix = `${payload.new_path}/`;
    if (currentDoc && currentDoc.path.startsWith(oldPrefix)) {
      currentDoc.path = newPrefix + currentDoc.path.slice(oldPrefix.length);
      documentPath.textContent = currentDoc.path;
      setPageTitle(documentTitle.value, currentDoc.path);
    }
    const drafts = listDraftPaths();
    for (const p of drafts) {
      if (p.startsWith(oldPrefix)) {
        const newPath = newPrefix + p.slice(oldPrefix.length);
        localStorage.setItem(
          draftKey(newPath),
          localStorage.getItem(draftKey(p)),
        );
        localStorage.removeItem(draftKey(p));
      }
    }
    selectedFolder = "";
    setStatus(`Renamed ${payload.old_path} → ${payload.new_path}`);
    refreshChangesPanel();
    refreshGitStatus();
    await loadDocuments();
  } catch (err) {
    reportError(`Rename failed: ${err.message}`);
  }
}

async function deleteFolder(folderPath) {
  const fullPath = `content/${folderPath}`;
  const fileCount = allDocuments.filter((d) =>
    d.path.startsWith(fullPath + "/"),
  ).length;
  const ok = await confirmDialog(
    `Delete ${fullPath} and its ${fileCount} doc${fileCount === 1 ? "" : "s"}? You can recover it from git if needed.`,
    { okText: "Delete", danger: true },
  );
  if (!ok) return;
  try {
    const payload = await request(
      `${apiUrl("/folders")}?path=${encodeURIComponent(fullPath)}`,
      { method: "DELETE" },
    );
    const prefix = `${payload.deleted}/`;
    if (
      currentDoc &&
      (currentDoc.path === payload.deleted ||
        currentDoc.path.startsWith(prefix))
    ) {
      currentDoc = null;
      currentParsed = null;
      lastSavedContent = "";
      hasDraft = false;
      docMenuButton.hidden = true;
      documentTitle.value = "";
      documentTitle.disabled = true;
      editor.value = "";
      editor.disabled = true;
      showLibrary();
    }
    // Clean drafts under the prefix.
    for (const p of listDraftPaths()) {
      if (p === payload.deleted || p.startsWith(prefix)) {
        localStorage.removeItem(draftKey(p));
      }
    }
    if (selectedFolder.startsWith(folderPath)) selectedFolder = "";
    setStatus(
      `Deleted ${payload.deleted} (${payload.files} file${payload.files === 1 ? "" : "s"}).`,
    );
    refreshChangesPanel();
    refreshGitStatus();
    await loadDocuments();
  } catch (err) {
    reportError(`Delete failed: ${err.message}`);
  }
}

// ---------- Doc actions menu ----------

function openDocMenu(event) {
  if (!currentDoc) return;
  const existing = document.querySelector(".doc-menu-popover");
  if (existing) {
    existing.remove();
    return;
  }
  const popover = document.createElement("div");
  popover.className = "doc-menu-popover";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "doc-menu-item";
  renameBtn.textContent = "Rename…";
  renameBtn.addEventListener("click", () => {
    popover.remove();
    renameCurrentDoc();
  });
  popover.append(renameBtn);

  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.className = "doc-menu-item";
  historyBtn.textContent = "History";
  historyBtn.addEventListener("click", () => {
    popover.remove();
    showDocHistory(currentDoc.path);
  });
  popover.append(historyBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "doc-menu-item is-danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => {
    popover.remove();
    deleteCurrentDoc();
  });
  popover.append(delBtn);

  const rect = docMenuButton.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.right = `${window.innerWidth - rect.right}px`;
  document.body.append(popover);

  const closeOnOutside = (ev) => {
    if (!popover.contains(ev.target) && ev.target !== docMenuButton) {
      popover.remove();
      document.removeEventListener("click", closeOnOutside, true);
    }
  };
  // Defer attaching so the current click doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
}

async function showDocHistory(path) {
  diffTitle.textContent = `History · ${path}`;
  diffBody.replaceChildren();
  diffBody.append(emptyNote("Loading…"));
  diffModal.hidden = false;
  try {
    const url = apiUrl("/git/log");
    url.searchParams.set("path", path);
    const payload = await request(url);
    const commits = payload.commits || [];
    if (commits.length === 0) {
      diffBody.replaceChildren(emptyNote("No commits found."));
      return;
    }
    const rows = commits.map((c) => {
      const row = document.createElement("div");
      row.className = "diff-line diff-ctx";
      row.textContent = `${c.sha}  ${c.date}  ${c.author}  ${c.subject}`;
      return row;
    });
    diffBody.replaceChildren(...rows);
  } catch (err) {
    diffBody.replaceChildren(emptyNote(`History failed: ${err.message}`));
  }
}

async function renameCurrentDoc() {
  if (!currentDoc) return;
  const oldPath = currentDoc.path;
  let newPath = window.prompt("New path:", oldPath);
  if (!newPath) return;
  newPath = newPath.trim();
  if (newPath === oldPath) return;
  if (!newPath.startsWith("content/")) {
    setStatus("Path must start with content/");
    return;
  }
  try {
    const payload = await request(apiUrl("/docs/rename"), {
      method: "POST",
      body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
    // Move any local draft over to the new key.
    const draft = localStorage.getItem(draftKey(oldPath));
    if (draft !== null) {
      localStorage.setItem(draftKey(newPath), draft);
      localStorage.removeItem(draftKey(oldPath));
    }
    currentDoc.path = payload.new_path;
    documentPath.textContent = payload.new_path;
    setPageTitle(documentTitle.value, payload.new_path);
    setStatus(`Renamed to ${payload.new_path}.`);
    refreshChangesPanel();
    refreshGitStatus();
    await loadDocuments();
  } catch (err) {
    reportError(`Rename failed: ${err.message}`);
  }
}

async function deleteCurrentDoc() {
  if (!currentDoc) return;
  const ok = await confirmDialog(
    `Delete ${currentDoc.path}? You can recover it from git if needed.`,
    { okText: "Delete", danger: true },
  );
  if (!ok) return;
  const path = currentDoc.path;
  try {
    await request(`${apiUrl("/docs")}?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    localStorage.removeItem(draftKey(path));
    currentDoc = null;
    currentParsed = null;
    lastSavedContent = "";
    hasDraft = false;
    docMenuButton.hidden = true;
    documentTitle.value = "";
    documentTitle.disabled = true;
    editor.value = "";
    editor.disabled = true;
    setStatus(`Deleted ${path}.`);
    refreshChangesPanel();
    refreshGitStatus();
    await loadDocuments();
    showLibrary();
  } catch (err) {
    reportError(`Delete failed: ${err.message}`);
  }
}

let _githubBase = "";
let _gitBranch = "main";

async function refreshGitStatus() {
  try {
    const url = apiUrl("/git/status");
    const payload = await request(url);
    if (!payload.ok) {
      setGitState({
        ok: false,
        message: payload.error || "Git not available",
        count: 0,
      });
      return;
    }
    const count = payload.count || 0;
    const branch = payload.branch || "?";
    _githubBase = payload.github || "";
    _gitBranch = payload.branch || "main";
    updateGithubLink();
    setGitState({
      ok: true,
      count,
      message:
        count === 0
          ? `On ${branch} · nothing to commit`
          : `On ${branch} · ${count} file${count === 1 ? "" : "s"} changed`,
    });
  } catch (err) {
    setGitState({
      ok: false,
      message: err.message || "git endpoint unreachable",
      count: 0,
    });
  }
}

function updateGithubLink() {
  // GitHub URLs are used by the Git panel and API, but the main reading UI
  // intentionally avoids extra repository shortcuts.
}

function setGitState({ ok, count, message }) {
  gitSection.classList.toggle("git-ok", !!ok && count > 0);
  gitSection.classList.toggle("git-clean", !!ok && count === 0);
  gitSection.classList.toggle("git-unavailable", !ok);
  gitStatusText.textContent = message;
  gitCommitButton.disabled = !ok;
}

async function gitPull() {
  gitPullButton.classList.add("is-busy");
  showGitResult("Pulling…", null);
  try {
    const payload = await request(apiUrl("/git/pull"), { method: "POST" });
    if (payload.ok) {
      showGitResult(payload.stdout || "Up to date.", "success");
    } else {
      showGitResult(payload.stderr || "Pull failed", "error");
    }
  } catch (err) {
    showGitResult(`Pull failed: ${err.message}`, "error");
  } finally {
    gitPullButton.classList.remove("is-busy");
    refreshGitStatus();
    await loadDocuments();
  }
}

async function openCommitForm() {
  // Refresh first so the file list and default message are up to date.
  let payload;
  try {
    payload = await request(apiUrl("/git/status"));
  } catch (err) {
    showGitResult(`Failed to get status: ${err.message}`, "error");
    return;
  }
  if (!payload || !payload.ok) {
    showGitResult(payload?.error || "Git unavailable", "error");
    return;
  }
  const files = payload.files || [];
  gitResult.hidden = true;
  gitCommitSubmit.disabled = files.length === 0;
  gitCommitFiles.replaceChildren(
    ...(files.length
      ? files.map((f) => {
          const row = document.createElement("div");
          row.className = "git-commit-file";
          const status = document.createElement("span");
          status.className = `git-commit-file-status status-${(f.status || "?").trim().replace(/[^A-Za-z]/g, "") || "u"}`;
          status.textContent = f.status || "?";
          const path = document.createElement("span");
          path.className = "git-commit-file-path";
          path.textContent = f.path;
          row.append(status, path);
          return row;
        })
      : [emptyNote("No changed files.")]),
  );
  gitCommitMessage.value = files.length ? defaultCommitMessage(files) : "";
  gitCommitModal.hidden = false;
  if (files.length) {
    gitCommitMessage.focus();
    gitCommitMessage.select();
  }
}

function closeCommitForm() {
  gitCommitModal.hidden = true;
}

async function submitCommitForm(event) {
  event.preventDefault();
  const message = gitCommitMessage.value.trim();
  gitCommitSubmit.disabled = true;
  gitCommitSubmit.classList.add("is-busy");
  gitCommitCancel.disabled = true;
  showGitResult("Committing…", null);
  try {
    const payload = await request(apiUrl("/git/commit"), {
      method: "POST",
      body: JSON.stringify({ message: message || undefined, push: true }),
    });
    if (payload.ok && payload.committed) {
      showGitResult(
        payload.pushed
          ? `Committed and pushed · ${payload.message}`
          : `Committed locally · ${payload.message}`,
        "success",
      );
      closeCommitForm();
    } else if (payload.ok) {
      showGitResult(payload.reason || "Nothing to commit.", null);
    } else {
      const failedStep = (payload.steps || []).find((s) => s.exit !== 0);
      const detail = failedStep
        ? `${failedStep.step}: ${failedStep.stderr || failedStep.stdout}`
        : "see server logs";
      showGitResult(`Failed (${detail})`, "error");
    }
  } catch (err) {
    showGitResult(`Failed: ${err.message}`, "error");
  } finally {
    gitCommitSubmit.disabled = false;
    gitCommitSubmit.classList.remove("is-busy");
    gitCommitCancel.disabled = false;
    refreshGitStatus();
  }
}

function showGitResult(text, kind) {
  gitResult.classList.remove("git-result-error", "git-result-success");
  if (kind === "error") gitResult.classList.add("git-result-error");
  if (kind === "success") gitResult.classList.add("git-result-success");
  gitResult.textContent = text;
  gitResult.hidden = false;
}

function defaultCommitMessage(files) {
  const docFiles = files.filter(
    (f) => f.path.startsWith("content/") && f.path.endsWith(".md"),
  );
  if (docFiles.length === 1) {
    const path = docFiles[0].path;
    return `Update ${path.split("/").pop().replace(/\.md$/, "").replaceAll("-", " ")}`;
  }
  if (docFiles.length > 1) {
    return `Update ${docFiles.length} docs`;
  }
  return `Update ${files.length} file${files.length === 1 ? "" : "s"}`;
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// ---------- View toggle + rendered block view ----------

function toggleViewMode() {
  if (!currentDoc) return;
  enterRenderedMode();
}

async function enterRenderedMode() {
  editorView.dataset.mode = "rendered";
  viewToggleButton.hidden = true;
  // If the user edited in raw mode without saving, re-parse the current
  // textarea content so the block view reflects the latest draft.
  if (currentDoc && editor.value && editor.value !== lastSavedContent) {
    await reparseEditorContent();
  }
  renderParsedDocument();
}

async function reparseEditorContent() {
  try {
    const payload = await request(apiUrl("/parse"), {
      method: "POST",
      body: JSON.stringify({ content: editor.value }),
    });
    if (payload.parsed) currentParsed = payload.parsed;
  } catch {}
}

function exitRenderedMode() {
  editorView.dataset.mode = "raw";
  viewToggleButton.hidden = true;
  renderedView.replaceChildren();
  resizeDocumentTitle();
}

function updateViewToggleAvailability() {
  // Show the toggle for any open doc — structured SOPs render as blocks,
  // others render the full body as plain markdown.
  const available = !!currentDoc;
  viewToggleButton.hidden = true;
  if (available && editorView.dataset.mode !== "rendered") enterRenderedMode();
}

async function refreshParsedFromApi() {
  if (!currentDoc) return;
  try {
    const url = apiUrl("/docs");
    url.searchParams.set("path", currentDoc.path);
    const payload = await request(url);
    currentParsed = payload.parsed || null;
    updateViewToggleAvailability();
  } catch {
    currentParsed = null;
  }
}

function renderParsedDocument() {
  const sections = (currentParsed && currentParsed.sections) || {};
  const blocks = [];
  const fm = (currentParsed && currentParsed.frontmatter) || {};
  const loomBlock = renderLoomBlock(fm);
  blocks.push(renderTitleBlock(fm));
  blocks.push(renderFrontmatterBlock(fm));
  blocks.push(renderRelatedDocsBlock(fm));
  blocks.push(renderWarningsBlock());
  if (Object.keys(sections).length === 0) {
    // Plain markdown (template, reference, etc.) — render the body as one
    // big rendered block, no editing controls.
    const body = stripFrontmatter(editor.value || "");
    const wrap = document.createElement("div");
    wrap.className = "block-plain-body";
    wrap.append(renderMarkdown(stripLeadingHeading(body)));
    blocks.push(wrap);
    blocks.push(loomBlock);
    blocks.push(renderGithubRawFooter());
    renderedView.replaceChildren(...blocks.filter(Boolean));
    return;
  }

  const order = [
    "summary",
    "prerequisites",
    "procedure",
    "validation",
    "troubleshooting",
    "references",
  ];
  const seen = new Set();
  for (const name of order) {
    if (sections[name]) {
      blocks.push(renderSectionBlock(name, sections[name]));
      seen.add(name);
    }
  }
  for (const [name, sec] of Object.entries(sections)) {
    if (seen.has(name)) continue;
    blocks.push(renderSectionBlock(name, sec));
  }

  const backlinksHost = document.createElement("section");
  backlinksHost.className = "block-backlinks";
  backlinksHost.id = "backlinks-host";
  blocks.push(backlinksHost);
  blocks.push(loomBlock);
  blocks.push(renderGithubRawFooter());

  renderedView.replaceChildren(...blocks.filter(Boolean));
  // Async-fetch backlinks separately so the main render isn't blocked.
  fetchBacklinksForCurrentDoc();
}

function renderGithubRawFooter() {
  if (!currentDoc || !_githubBase) return null;
  const githubBase = _githubBase.replace(/\/$/, "");
  const link = document.createElement("a");
  link.className = "doc-source-footer";
  link.href = `${githubBase}/blob/${encodeURIComponent(_gitBranch).replaceAll("%2F", "/")}/${currentDoc.path}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "See on GitHub";
  return link;
}

async function fetchBacklinksForCurrentDoc() {
  if (!currentDoc) return;
  const host = renderedView.querySelector("#backlinks-host");
  if (!host) return;
  try {
    const url = apiUrl("/docs/backlinks");
    url.searchParams.set("path", currentDoc.path);
    const payload = await request(url);
    const links = payload.backlinks || [];
    if (links.length === 0) {
      host.hidden = true;
      return;
    }
    const head = document.createElement("h3");
    head.textContent = `Referenced by (${links.length})`;
    const list = document.createElement("ul");
    for (const l of links) {
      const li = document.createElement("li");
      const a = document.createElement("button");
      a.type = "button";
      a.className = "block-backlinks-row";
      a.textContent = l.title || basename(l.path);
      a.title = l.path;
      a.addEventListener("click", () => openDocument(l.path));
      li.append(a);
      list.append(li);
    }
    host.replaceChildren(head, list);
  } catch {
    host.hidden = true;
  }
}

function emptyNote(text) {
  const div = document.createElement("div");
  div.className = "rendered-empty";
  div.textContent = text;
  return div;
}

function renderRelatedDocsBlock(fm) {
  const items = Array.isArray(fm.related_docs)
    ? fm.related_docs.filter(Boolean)
    : [];
  if (items.length === 0) return null;
  const wrap = document.createElement("aside");
  wrap.className = "block-related";
  const head = document.createElement("h3");
  head.textContent = `Related docs (${items.length})`;
  wrap.append(head);
  const list = document.createElement("ul");
  for (const rel of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "block-related-row";
    btn.textContent = rel;
    btn.title = "Open related doc";
    btn.addEventListener("click", () => {
      const resolved = resolveRelatedPath(rel);
      openDocument(resolved);
    });
    li.append(btn);
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}

function resolveRelatedPath(rel) {
  if (rel.startsWith("content/") || rel.startsWith("docs/")) return rel;
  // Try resolving relative to the current doc's directory.
  if (currentDoc) {
    const docDir = currentDoc.path.split("/").slice(0, -1).join("/");
    const stack = docDir.split("/").filter(Boolean);
    for (const part of rel.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return stack.join("/");
  }
  return rel;
}

function renderWarningsBlock() {
  if (!currentWarnings.length) return null;
  const wrap = document.createElement("aside");
  wrap.className = "block-warnings";
  const head = document.createElement("h3");
  head.textContent = `Lint warnings (${currentWarnings.length})`;
  wrap.append(head);
  const list = document.createElement("ul");
  for (const w of currentWarnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}

function renderLoomBlock(fm) {
  const looms = Array.isArray(fm.loom) ? fm.loom.filter(Boolean) : [];
  if (looms.length === 0) return null;
  const wrap = document.createElement("aside");
  wrap.className = "block-loom";
  const head = document.createElement("h3");
  head.textContent = `Loom recordings (${looms.length})`;
  wrap.append(head);
  const list = document.createElement("ul");
  for (const url of looms) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = shortLoomLabel(url);
    li.append(a);

    const embedUrl = toLoomEmbedUrl(url);
    if (embedUrl) {
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "block-loom-play";
      playBtn.textContent = "▶︎ Play inline";
      const slot = document.createElement("div");
      slot.className = "block-loom-embed";
      slot.hidden = true;
      playBtn.addEventListener("click", () => {
        if (slot.hidden) {
          if (!slot.firstChild) {
            const iframe = document.createElement("iframe");
            iframe.src = embedUrl;
            iframe.allowFullscreen = true;
            iframe.allow = "fullscreen";
            slot.append(iframe);
          }
          slot.hidden = false;
          playBtn.textContent = "Hide";
        } else {
          slot.hidden = true;
          playBtn.textContent = "▶︎ Play inline";
        }
      });
      li.append(" ", playBtn, slot);
    }
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}

function toLoomEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("loom.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] !== "share" || !parts[1]) return null;
    return `https://www.loom.com/embed/${parts[1]}`;
  } catch {
    return null;
  }
}

function shortLoomLabel(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.split("/").filter(Boolean).pop() || "";
    if (id.length > 8)
      return `${u.hostname.replace("www.", "")} · ${id.slice(0, 8)}…`;
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

function renderTitleBlock(fm) {
  const wrap = document.createElement("div");
  wrap.className = "block-title-wrap";
  const h1 = document.createElement("h1");
  h1.className = "block-title";
  h1.textContent =
    fm.title || (currentDoc ? basename(currentDoc.path) : "Untitled");
  attachInlineEditor(h1, {
    getValue: () => fm.title || "",
    commit: (value) => applyTitleEdit(fm, value),
    restore: () => {
      h1.textContent =
        fm.title || (currentDoc ? basename(currentDoc.path) : "Untitled");
    },
    multiline: true,
    singleLine: true,
    autoSize: true,
    commitOnEnter: true,
    editorClass: "block-title-editor",
    showHint: false,
  });
  wrap.append(h1);
  const stats = computeDocStats();
  if (stats) {
    const meta = document.createElement("div");
    meta.className = "block-title-stats";
    meta.textContent = stats;
    wrap.append(meta);
  }
  return wrap;
}

function computeDocStats() {
  if (!currentParsed) return "";
  const proc = currentParsed.sections?.procedure;
  if (!proc || proc.raw) return "";
  let steps = 0;
  let groups = (proc.groups || []).length;
  let shots = 0;
  for (const g of proc.groups || []) {
    steps += (g.steps || []).length;
    for (const s of g.steps || []) shots += (s.screenshots || []).length;
  }
  for (const s of proc.flat_steps || []) {
    steps += 1;
    shots += (s.screenshots || []).length;
  }
  const parts = [];
  if (steps) parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
  if (groups) parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
  if (shots) parts.push(`${shots} screenshot${shots === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function applyTitleEdit(fm, newTitle) {
  const title = newTitle.trim();
  if (!title) return;
  fm.title = title;
  // Update frontmatter scalar and body H1.
  let next = patchFrontmatterScalar(editor.value, "title", title, {
    quoted: true,
  });
  next = setMarkdownTitle(next, title);
  editor.value = next;
  if (currentDoc) {
    documentTitle.value = title;
    setPageTitle(title, currentDoc.path);
  }
  storeDraft();
  updateSaveState();
}

function renderFrontmatterBlock(fm) {
  if (!fm) fm = {};
  const wrap = document.createElement("div");
  wrap.className = "fm-block";

  const row = document.createElement("div");
  row.className = "fm-row";

  if (fm.doc_type) row.append(pill("type", fm.doc_type));
  if (Array.isArray(fm.systems)) {
    for (const s of fm.systems) row.append(pill("system", s));
  }
  if (Array.isArray(fm.tags)) {
    for (const t of fm.tags) row.append(pill("tag", t));
  }

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "fm-edit";
  editBtn.textContent = row.children.length ? "Edit" : "+ Metadata";
  editBtn.title = "Edit doc metadata";
  editBtn.addEventListener("click", () => toggleFrontmatterEditor(wrap, fm));
  row.append(editBtn);

  wrap.append(row);
  return wrap;
}

const DOC_TYPES = [
  "sop",
  "checklist",
  "template",
  "reference",
  "playbook",
  "prompt",
];

function toggleFrontmatterEditor(wrap, fm) {
  const existing = wrap.querySelector(".fm-editor");
  if (existing) {
    existing.remove();
    return;
  }
  const editor = document.createElement("form");
  editor.className = "fm-editor";

  const docTypeRow = makeAttrRow("Doc type");
  const sel = document.createElement("select");
  sel.innerHTML = DOC_TYPES.map(
    (t) =>
      `<option value="${t}"${t === fm.doc_type ? " selected" : ""}>${t}</option>`,
  ).join("");
  docTypeRow.append(sel);
  editor.append(docTypeRow);

  const summaryRow = makeAttrRow("Summary");
  const sumInput = document.createElement("textarea");
  sumInput.rows = 2;
  sumInput.value = fm.summary || "";
  summaryRow.append(sumInput);
  editor.append(summaryRow);

  const tagsRow = makeAttrRow("Tags");
  const tagsEditor = makeChipListEditor(
    Array.isArray(fm.tags) ? fm.tags.slice() : [],
  );
  tagsRow.append(tagsEditor.element);
  editor.append(tagsRow);

  const systemsRow = makeAttrRow("Systems");
  const systemsEditor = makeChipListEditor(
    Array.isArray(fm.systems) ? fm.systems.slice() : [],
  );
  systemsRow.append(systemsEditor.element);
  editor.append(systemsRow);

  const actionsRow = document.createElement("div");
  actionsRow.className = "block-step-attr-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet-button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => editor.remove());
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "Apply";
  actionsRow.append(cancel, save);
  editor.append(actionsRow);

  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    const updates = {
      doc_type: sel.value,
      summary: sumInput.value.trim(),
      tags: tagsEditor.getValues(),
      systems: systemsEditor.getValues(),
    };
    applyFrontmatterEdit(fm, updates);
    editor.remove();
  });

  wrap.append(editor);
}

function makeChipListEditor(initial) {
  const wrap = document.createElement("div");
  wrap.className = "fm-chips-editor";
  const chips = [...initial];

  const render = () => {
    wrap.replaceChildren();
    for (let i = 0; i < chips.length; i++) {
      const chip = document.createElement("span");
      chip.className = "fm-chip";
      chip.textContent = chips[i];
      const x = document.createElement("button");
      x.type = "button";
      x.className = "fm-chip-x";
      x.textContent = "×";
      x.addEventListener("click", () => {
        chips.splice(i, 1);
        render();
      });
      chip.append(x);
      wrap.append(chip);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.className = "fm-chip-input";
    input.placeholder = "+ Add";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        const v = input.value.trim().replace(/,$/, "");
        if (v) {
          chips.push(v);
          render();
          // Refocus the (new) input element.
          wrap.querySelector(".fm-chip-input")?.focus();
        }
      } else if (event.key === "Backspace" && !input.value && chips.length) {
        chips.pop();
        render();
        wrap.querySelector(".fm-chip-input")?.focus();
      }
    });
    wrap.append(input);
  };
  render();
  return { element: wrap, getValues: () => chips.slice() };
}

function applyFrontmatterEdit(fm, updates) {
  let next = editor.value;
  next = patchFrontmatterScalar(next, "doc_type", updates.doc_type);
  next = patchFrontmatterScalar(next, "summary", updates.summary, {
    quoted: true,
  });
  next = patchFrontmatterList(next, "tags", updates.tags);
  next = patchFrontmatterList(next, "systems", updates.systems);
  editor.value = next;
  if (currentParsed && currentParsed.frontmatter) {
    Object.assign(currentParsed.frontmatter, {
      doc_type: updates.doc_type,
      summary: updates.summary,
      tags: updates.tags,
      systems: updates.systems,
    });
  }
  storeDraft();
  updateSaveState();
  renderParsedDocument();
}

function _frontmatterRange(markdown) {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return { start: 4, end };
}

function patchFrontmatterScalar(markdown, key, value, options = {}) {
  const range = _frontmatterRange(markdown);
  if (!range) return markdown;
  const body = markdown.slice(range.start, range.end);
  const before = markdown.slice(0, range.start);
  const after = markdown.slice(range.end);
  const re = new RegExp(`^${escapeRegex(key)}:\\s*.*$`, "m");
  const formatted = options.quoted
    ? `${key}: "${(value || "").replace(/"/g, '\\"')}"`
    : `${key}: ${value}`;
  if (re.test(body)) {
    return before + body.replace(re, formatted) + after;
  }
  // Insert at end of frontmatter.
  const trimmed = body.endsWith("\n") ? body : body + "\n";
  return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
}

function patchFrontmatterList(markdown, key, items) {
  const range = _frontmatterRange(markdown);
  if (!range) return markdown;
  const before = markdown.slice(0, range.start);
  const body = markdown.slice(range.start, range.end);
  const after = markdown.slice(range.end);

  // Match either `key: [...]` inline OR `key:\n  - item\n  - item`.
  const blockRe = new RegExp(
    `^${escapeRegex(key)}:[\\t ]*(?:\\[[^\\]]*\\])?(?:\\n[\\t ]+-[^\\n]*)*`,
    "m",
  );
  const formatted =
    items && items.length
      ? `${key}:\n` +
        items.map((v) => `  - ${JSON.stringify(String(v))}`).join("\n")
      : `${key}: []`;
  if (blockRe.test(body)) {
    return before + body.replace(blockRe, formatted) + after;
  }
  const trimmed = body.endsWith("\n") ? body : body + "\n";
  return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
}

function pill(kind, text) {
  const span = document.createElement("span");
  span.className = `fm-pill fm-pill-${kind}`;
  span.textContent = text;
  return span;
}

function renderSectionBlock(name, section) {
  const block = document.createElement("section");
  block.className = "block-section";
  block.dataset.section = name;

  const header = document.createElement("header");
  header.className = "block-section-header";
  const label = document.createElement("span");
  label.className = "block-section-label";
  label.textContent = "Section";
  const title = document.createElement("h2");
  title.textContent =
    headingFromBody(section.body_md) || humanSectionName(name);
  attachInlineEditor(title, {
    getValue: () => headingFromBody(section.body_md) || humanSectionName(name),
    commit: (value) => applySectionHeadingEdit(name, section, value),
    restore: () => {
      title.textContent =
        headingFromBody(section.body_md) || humanSectionName(name);
    },
    multiline: false,
    editorClass: "block-section-title-editor",
  });
  header.append(label, title);
  block.append(header);

  const body = document.createElement("div");
  body.className = "block-section-body";

  if (name === "procedure" && section.raw === false) {
    appendProcedureChildren(body, section);
  } else if (section.raw === true) {
    body.append(renderMarkdown(section.body_md || ""));
    body.classList.add("is-raw");
    attachInlineEditor(body, {
      getValue: () => section.body_md || "",
      commit: (value) => applySectionBodyEdit(name, section, value, true),
      restore: () => {
        body.replaceChildren(renderMarkdown(section.body_md || ""));
        body.classList.add("is-raw");
      },
      multiline: true,
    });
  } else {
    body.append(renderMarkdown(stripLeadingHeading(section.body_md || "")));
    attachInlineEditor(body, {
      getValue: () => stripLeadingHeading(section.body_md || ""),
      commit: (value) => applySectionBodyEdit(name, section, value, false),
      restore: () =>
        body.replaceChildren(
          renderMarkdown(stripLeadingHeading(section.body_md || "")),
        ),
      multiline: true,
    });
  }

  block.append(body);
  return block;
}

function headingFromBody(bodyMd) {
  if (!bodyMd) return "";
  const m = bodyMd.match(/^##\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

function applySectionHeadingEdit(name, section, newHeading) {
  const heading = newHeading.trim() || humanSectionName(name);
  const restOfBody = stripLeadingHeading(section.body_md || "");
  section.body_md = `## ${heading}\n\n${restOfBody}`.replace(/\n+$/, "");
  const updated = patchSectionInMarkdown(editor.value, name, section.body_md);
  if (updated == null) {
    setStatus(`Could not locate section ${name}; heading not saved.`);
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function applySectionBodyEdit(name, section, newBody, isRaw) {
  // Reconstruct the body_md for the section (with the visible heading on top
  // for non-raw sections; raw sections are opaque).
  let combined;
  if (isRaw) {
    combined = newBody;
  } else {
    const heading = `## ${humanSectionName(name)}`;
    const trimmed = newBody.replace(/^\n+/, "");
    combined = `${heading}\n\n${trimmed}`;
  }
  section.body_md = combined;

  const updated = patchSectionInMarkdown(editor.value, name, combined);
  if (updated == null) {
    setStatus(`Could not locate section ${name}; edit not saved.`);
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function humanSectionName(name) {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function appendProcedureChildren(container, procedure) {
  container.append(renderTodoBlock(procedure));

  const groups = Array.isArray(procedure.groups) ? procedure.groups : [];
  if (groups.length) {
    for (const g of groups) container.append(renderGroupBlock(g, procedure));
  } else {
    const flatSteps = Array.isArray(procedure.flat_steps)
      ? procedure.flat_steps
      : [];
    for (const s of flatSteps) container.append(renderStepBlock(s, procedure));
    container.append(makeAddStepButton(procedure, null));
  }

  const prose = Array.isArray(procedure.prose) ? procedure.prose : [];
  prose.forEach((p, idx) =>
    container.append(renderProseBlock(p, idx, procedure)),
  );
  container.append(makeAddProseButton(procedure));
}

function makeAddGroupButton(procedure) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "block-add-step block-add-group";
  btn.textContent = "+ New group";
  btn.addEventListener("click", () => addGroup(procedure));
  return btn;
}

function makeAddProseButton(procedure) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "block-add-step block-add-prose";
  btn.textContent = "+ New free-form block";
  btn.addEventListener("click", () => addProse(procedure));
  return btn;
}

function renderTodoBlock(procedure) {
  const todos = Array.isArray(procedure.todos) ? procedure.todos : [];
  const block = document.createElement("aside");
  block.className = "block-todos";

  const head = document.createElement("header");
  head.className = "block-todos-header";
  const heading = document.createElement("h3");
  heading.textContent = "TODO";
  head.append(heading);
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "block-todo-add";
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", () => {
    procedure.todos = procedure.todos || [];
    procedure.todos.push("Describe what's missing.");
    applyProcedureRewrite(procedure, null);
    // Open the inline editor for the new TODO.
    const items = renderedView.querySelectorAll(
      ".block-todos .block-todo-text",
    );
    items[items.length - 1]?.click();
  });
  head.append(addBtn);
  block.append(head);

  if (todos.length === 0) {
    block.classList.add("is-empty");
    const empty = document.createElement("div");
    empty.className = "block-todo-empty";
    empty.textContent = "No TODOs yet.";
    block.append(empty);
    return block;
  }

  const list = document.createElement("ul");
  todos.forEach((t, idx) => {
    const li = document.createElement("li");
    li.className = "block-todo-item";
    const text = document.createElement("span");
    text.className = "block-todo-text";
    text.textContent = t;
    attachInlineEditor(text, {
      getValue: () => procedure.todos[idx] || "",
      commit: (value) => applyTodoEdit(procedure, idx, value),
      restore: () => {
        text.textContent = procedure.todos[idx] || "";
      },
      multiline: false,
    });
    li.append(text);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "block-step-delete";
    del.title = "Delete TODO";
    del.setAttribute("aria-label", "Delete TODO");
    del.textContent = "×";
    del.addEventListener("click", () => deleteTodo(procedure, idx));
    li.append(del);
    list.append(li);
  });
  block.append(list);
  return block;
}

function applyTodoEdit(procedure, idx, newValue) {
  procedure.todos = procedure.todos || [];
  procedure.todos[idx] = newValue;
  applyProcedureRewrite(procedure, null);
}

function deleteTodo(procedure, idx) {
  const snapshot = snapshotProcedure(procedure);
  procedure.todos = (procedure.todos || []).filter((_, i) => i !== idx);
  applyProcedureRewrite(procedure, null);
  showUndoToast("TODO removed.", () => restoreProcedure(procedure, snapshot));
}

function makeProcedureToolbar(procedure) {
  const wrap = document.createElement("div");
  wrap.className = "block-procedure-toolbar";
  return wrap;
}

function wrapInGroup(procedure) {
  const steps = procedure.flat_steps || [];
  if (steps.length === 0) return;
  procedure.groups = [{ title: "Steps", steps }];
  procedure.flat_steps = [];
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
}

function flattenSingleGroup(procedure) {
  const groups = procedure.groups || [];
  if (groups.length !== 1) return;
  procedure.flat_steps = groups[0].steps || [];
  procedure.groups = [];
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
}

function makeAddStepButton(procedure, group) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "block-add-step";
  btn.textContent = "+ New step";
  btn.addEventListener("click", () => addStep(procedure, group));
  return btn;
}

function renderGroupBlock(group, procedure) {
  const block = document.createElement("section");
  block.className = "block-group";

  const header = document.createElement("header");
  header.className = "block-group-header";
  const text = document.createElement("div");
  text.className = "block-group-text";
  const title = document.createElement("h3");
  title.textContent = group.title || "";
  attachInlineEditor(title, {
    getValue: () => group.title || "",
    commit: (value) => applyGroupTitleEdit(group, value),
    restore: () => {
      title.textContent = group.title || "";
    },
    multiline: false,
    editorClass: "block-group-title-editor",
  });
  text.append(title);
  header.append(text);
  block.append(header);

  for (const s of group.steps || [])
    block.append(renderStepBlock(s, procedure));
  if (procedure) block.append(makeAddStepButton(procedure, group));
  return block;
}

function applyGroupTitleEdit(group, newTitle) {
  const oldTitle = group.title || "";
  if (newTitle === oldTitle) return;
  group.title = newTitle;
  const updated = patchGroupTitleInMarkdown(editor.value, oldTitle, newTitle);
  if (updated == null) {
    setStatus(`Could not locate group "${oldTitle}"; edit not saved.`);
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function renderStepBlock(step, procedure) {
  const block = document.createElement("article");
  block.className = "block-step";
  block.dataset.stepId = String(step.id);
  if (procedure) {
    block.addEventListener("dragover", (event) =>
      onStepDragOver(event, step, block, procedure),
    );
    block.addEventListener("dragleave", (event) =>
      onStepDragLeave(event, block),
    );
    block.addEventListener("drop", (event) =>
      onStepDrop(event, step, block, procedure),
    );
    block.addEventListener("focusin", () => {
      _lastFocusedStep = step;
      _lastFocusedProcedure = procedure;
    });
    block.addEventListener("click", () => {
      _lastFocusedStep = step;
      _lastFocusedProcedure = procedure;
    });
  }

  const header = document.createElement("header");
  header.className = "block-step-header";

  if (procedure) {
    const handle = document.createElement("span");
    handle.className = "block-step-drag";
    handle.title = "Drag to reorder";
    handle.setAttribute("aria-label", "Drag step to reorder");
    handle.textContent = "⋮⋮";
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) =>
      onStepDragStart(event, step, block, procedure),
    );
    handle.addEventListener("dragend", onStepDragEnd);
    header.append(handle);
  }

  const numChip = document.createElement("span");
  numChip.className = "block-step-num";
  numChip.textContent = String(step.rendered_number ?? step.id);
  header.append(numChip);

  const label = document.createElement("span");
  label.className = "block-step-label";
  label.textContent = "Step";
  header.append(label);

  const attrs = step.attrs || {};
  if (attrs.action) header.append(pill("action", attrs.action));
  if (attrs.tool) header.append(pill("tool", attrs.tool));
  if (Array.isArray(attrs.systems)) {
    for (const sys of attrs.systems) header.append(pill("system", sys));
  }

  for (const w of currentWarnings) {
    if (!w.startsWith(`step id=${step.id}:`)) continue;
    const chip = document.createElement("span");
    chip.className = "block-step-warning";
    chip.title = w;
    chip.textContent = "⚠";
    header.append(chip);
  }

  if (procedure) {
    const spacer = document.createElement("span");
    spacer.className = "block-step-spacer";
    header.append(spacer);

    const attrBtn = document.createElement("button");
    attrBtn.type = "button";
    attrBtn.className = "block-step-attr";
    attrBtn.title = "Edit step attributes";
    attrBtn.setAttribute("aria-label", "Edit step attributes");
    attrBtn.textContent = "⚙";
    attrBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleStepAttrEditor(block, step, procedure);
    });
    header.append(attrBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "block-step-delete";
    delBtn.title = "Delete step";
    delBtn.setAttribute("aria-label", "Delete step");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteStep(procedure, step);
    });
    header.append(delBtn);
  }

  block.append(header);

  const body = document.createElement("div");
  body.className = "block-step-body";
  body.append(renderMarkdown(step.body_md || ""));
  attachInlineEditor(body, {
    getValue: () => (step.body_md || "").replace(/^ /, ""),
    commit: (value) => applyStepBodyEdit(step, value),
    restore: () => body.replaceChildren(renderMarkdown(step.body_md || "")),
    multiline: true,
  });
  block.append(body);

  const shots = Array.isArray(step.screenshots) ? step.screenshots : [];
  shots.forEach((shot, idx) =>
    block.append(renderScreenshot(shot, step, idx, procedure)),
  );
  for (const embed of extractVideoEmbeds(step.body_md || "")) {
    block.append(renderVideoEmbed(embed));
  }
  if (procedure) block.append(makeAddScreenshotButton(step, procedure));
  return block;
}

function extractVideoEmbeds(text) {
  const embeds = [];
  const seen = new Set();
  const urlRe = /\bhttps?:\/\/[^\s)\]]+/g;
  for (const match of text.matchAll(urlRe)) {
    const url = match[0].replace(/[.,;]+$/, "");
    if (seen.has(url)) continue;
    const e = toVideoEmbed(url);
    if (e) {
      seen.add(url);
      embeds.push(e);
    }
  }
  return embeds;
}

function toVideoEmbed(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id)
        return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (u.hostname.endsWith("youtube.com") && u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id)
        return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (u.hostname === "vimeo.com") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id)
        return { src: `https://player.vimeo.com/video/${id}`, kind: "vimeo" };
    }
  } catch {}
  return null;
}

function renderVideoEmbed(embed) {
  const wrap = document.createElement("div");
  wrap.className = "block-video-embed";
  const iframe = document.createElement("iframe");
  iframe.src = embed.src;
  iframe.allow = "fullscreen; autoplay; encrypted-media";
  iframe.allowFullscreen = true;
  iframe.loading = "lazy";
  wrap.append(iframe);
  return wrap;
}

function makeAddScreenshotButton(step, procedure) {
  const wrap = document.createElement("div");
  wrap.className = "block-screenshot-add";
  const btn = document.createElement("label");
  btn.className = "block-add-step block-add-screenshot";
  btn.textContent = "+ Add screenshot";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    addScreenshot(step, procedure, file);
    input.value = "";
  });
  btn.append(input);
  wrap.append(btn);
  return wrap;
}

async function addScreenshot(step, procedure, file) {
  if (!currentDoc) return;
  setStatus("Uploading image…");
  const addBtn = renderedView.querySelector(
    `.block-step[data-step-id="${step.id}"] .block-add-screenshot`,
  );
  addBtn?.classList.add("is-busy");
  try {
    const data = await fileToBase64(file);
    const payload = await request(apiUrl("/images"), {
      method: "POST",
      body: JSON.stringify({
        doc_path: currentDoc.path,
        filename: file.name,
        data,
      }),
    });
    step.screenshots = step.screenshots || [];
    step.screenshots.push({ src: payload.path, alt: "", caption: "" });
    applyProcedureRewrite(procedure, null);
    setStatus(`Uploaded ${payload.absolute_path}`);
  } catch (err) {
    reportError(`Upload failed: ${err.message}`);
  } finally {
    addBtn?.classList.remove("is-busy");
  }
}

// ---------- Lint dashboard ----------

async function openLintReport() {
  lintModal.hidden = false;
  lintOpenButton.classList.add("is-busy");
  lintModalBody.replaceChildren(emptyNote("Running lint…"));
  try {
    const payload = await request(apiUrl("/lint"));
    const docs = payload.docs || [];
    if (docs.length === 0) {
      lintModalBody.replaceChildren(
        emptyNote("No violations across the corpus 🎉"),
      );
      lintSummary.textContent = "clean";
      return;
    }
    const total = payload.total_violations || 0;
    lintSummary.textContent = `${docs.length} docs · ${total} violations`;
    const rows = docs.map((entry) => {
      const wrap = document.createElement("div");
      wrap.className = "lint-row";
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "lint-row-path";
      heading.textContent = entry.path;
      heading.addEventListener("click", () => {
        lintModal.hidden = true;
        openDocument(entry.path);
      });
      wrap.append(heading);
      const list = document.createElement("ul");
      list.className = "lint-row-violations";
      for (const v of entry.violations) {
        const li = document.createElement("li");
        li.textContent = v;
        list.append(li);
      }
      wrap.append(list);
      return wrap;
    });
    lintModalBody.replaceChildren(...rows);
  } catch (err) {
    lintModalBody.replaceChildren(emptyNote(`Lint failed: ${err.message}`));
  } finally {
    lintOpenButton.classList.remove("is-busy");
  }
}

// ---------- Diff modal ----------

const diffModal = document.querySelector("#diff-modal");
const diffBackdrop = document.querySelector("#diff-backdrop");
const diffTitle = document.querySelector("#diff-title");
const diffBody = document.querySelector("#diff-body");
const diffClose = document.querySelector("#diff-close");
diffBackdrop.addEventListener("click", closeDiff);
diffClose.addEventListener("click", closeDiff);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !diffModal.hidden) {
    event.stopPropagation();
    closeDiff();
  }
});

async function showDiffForDraft(path) {
  const draft = localStorage.getItem(draftKey(path)) ?? "";
  let saved = "";
  try {
    const url = apiUrl("/docs");
    url.searchParams.set("path", path);
    const payload = await request(url);
    saved = payload.content || "";
  } catch (err) {
    saved = "";
  }
  diffTitle.textContent = path;
  diffBody.replaceChildren(...renderUnifiedDiff(saved, draft));
  diffModal.hidden = false;
}

function closeDiff() {
  diffModal.hidden = true;
}

function renderUnifiedDiff(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const lcs = lcsLengths(aLines, bLines);
  const ops = [];
  let i = aLines.length,
    j = bLines.length;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: " ", line: aLines[i - 1] });
      i--;
      j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.push({ type: "-", line: aLines[i - 1] });
      i--;
    } else {
      ops.push({ type: "+", line: bLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ type: "-", line: aLines[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.push({ type: "+", line: bLines[j - 1] });
    j--;
  }
  ops.reverse();

  const nodes = [];
  for (const op of ops) {
    const span = document.createElement("div");
    span.className =
      "diff-line diff-" +
      (op.type === "+" ? "add" : op.type === "-" ? "del" : "ctx");
    span.textContent = (op.type === " " ? "  " : op.type + " ") + op.line;
    nodes.push(span);
  }
  if (nodes.length === 0) {
    const span = document.createElement("div");
    span.className = "diff-line diff-ctx";
    span.textContent = "(no changes)";
    nodes.push(span);
  }
  return nodes;
}

function lcsLengths(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

// ---------- Confirmation modal ----------

const confirmModal = document.querySelector("#confirm-modal");
const confirmMessage = document.querySelector("#confirm-message");
const confirmBackdrop = document.querySelector("#confirm-backdrop");
const confirmOk = document.querySelector("#confirm-ok");
const confirmCancel = document.querySelector("#confirm-cancel");
let _confirmResolve = null;
let _confirmOpener = null;

confirmBackdrop.addEventListener("click", () => resolveConfirm(false));
confirmCancel.addEventListener("click", () => resolveConfirm(false));
confirmOk.addEventListener("click", () => resolveConfirm(true));
document.addEventListener("keydown", (event) => {
  if (confirmModal.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    resolveConfirm(false);
  } else if (event.key === "Tab") {
    event.preventDefault();
    const next =
      document.activeElement === confirmCancel && !event.shiftKey
        ? confirmOk
        : confirmCancel;
    next.focus();
  }
});

function confirmDialog(
  message,
  { okText = "Confirm", cancelText = "Cancel", danger = false } = {},
) {
  return new Promise((resolve) => {
    _confirmOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    confirmMessage.textContent = message;
    confirmOk.textContent = okText;
    confirmCancel.textContent = cancelText;
    confirmOk.classList.toggle("is-danger", !!danger);
    confirmModal.hidden = false;
    _confirmResolve = resolve;
    confirmCancel.focus();
  });
}

function resolveConfirm(value) {
  if (_confirmResolve) {
    const resolve = _confirmResolve;
    const opener = _confirmOpener;
    _confirmResolve = null;
    _confirmOpener = null;
    confirmModal.hidden = true;
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      resolve(value);
    });
  }
}

// ---------- Lightbox ----------

const lightbox = document.querySelector("#lightbox");
const lightboxImg = document.querySelector("#lightbox-img");
const lightboxCaption = document.querySelector("#lightbox-caption");
lightbox.addEventListener("click", (event) => {
  if (!event.target.closest("img")) closeLightbox();
});

function openLightbox(src, caption) {
  lightboxImg.src = src;
  lightboxCaption.textContent = caption || "";
  lightboxCaption.hidden = !caption;
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) {
    event.stopPropagation();
    closeLightbox();
  }
});

// ---------- Quick nav palette (Cmd/Ctrl+P) ----------

const quickNav = document.querySelector("#quick-nav");
const quickNavBackdrop = document.querySelector("#quick-nav-backdrop");
const quickNavInput = document.querySelector("#quick-nav-input");
const quickNavResults = document.querySelector("#quick-nav-results");
let _quickNavIndex = 0;
let _quickNavMatches = [];

quickNavBackdrop.addEventListener("click", closeQuickNav);
quickNavInput.addEventListener("input", () =>
  updateQuickNavMatches(quickNavInput.value),
);
quickNavInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeQuickNav();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    _quickNavIndex = Math.min(_quickNavMatches.length - 1, _quickNavIndex + 1);
    renderQuickNavResults();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    _quickNavIndex = Math.max(0, _quickNavIndex - 1);
    renderQuickNavResults();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const target = _quickNavMatches[_quickNavIndex];
    if (target) {
      closeQuickNav();
      openDocument(target.path);
    }
  }
});

function openQuickNav() {
  quickNav.hidden = false;
  quickNavInput.value = "";
  _quickNavIndex = 0;
  updateQuickNavMatches("");
  quickNavInput.focus();
}

function closeQuickNav() {
  quickNav.hidden = true;
}

function updateQuickNavMatches(query) {
  const q = query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/) : [];
  const scored = allDocuments
    .map((doc) => {
      const hay = `${(doc.title || "").toLowerCase()} ${doc.path.toLowerCase()}`;
      if (!q) return { doc, score: 0 };
      let score = 0;
      for (const t of tokens) {
        const idx = hay.indexOf(t);
        if (idx === -1) return null;
        score -= idx; // earlier = better
        if ((doc.title || "").toLowerCase().includes(t)) score += 50;
      }
      return { doc, score };
    })
    .filter(Boolean);
  scored.sort(
    (a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path),
  );
  _quickNavMatches = scored.slice(0, 30).map((s) => s.doc);
  _quickNavIndex = 0;
  renderQuickNavResults();
}

function renderQuickNavResults() {
  if (_quickNavMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "quick-nav-empty";
    empty.textContent = "No matches.";
    quickNavResults.replaceChildren(empty);
    return;
  }
  const rows = _quickNavMatches.map((doc, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "quick-nav-row" + (i === _quickNavIndex ? " is-active" : "");
    const title = document.createElement("span");
    title.className = "quick-nav-title";
    title.textContent = doc.title || basename(doc.path);
    const path = document.createElement("span");
    path.className = "quick-nav-path";
    path.textContent = doc.path;
    row.append(title, path);
    row.addEventListener("click", () => {
      closeQuickNav();
      openDocument(doc.path);
    });
    return row;
  });
  quickNavResults.replaceChildren(...rows);
  rows[_quickNavIndex]?.scrollIntoView({ block: "nearest" });
}

function handleClipboardPaste(event) {
  // Only intercept when we're in block view with a step focused or remembered.
  if (editorView.dataset.mode !== "rendered") return;
  if (!_lastFocusedStep || !_lastFocusedProcedure) return;
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) {
      event.preventDefault();
      // Provide a default filename if the OS gave none.
      if (!file.name || file.name === "image.png") {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const ext = file.type.split("/")[1] || "png";
        Object.defineProperty(file, "name", { value: `paste-${ts}.${ext}` });
      }
      addScreenshot(_lastFocusedStep, _lastFocusedProcedure, file);
      return;
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const idx = String(result).indexOf(",");
      resolve(idx === -1 ? String(result) : String(result).slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Generic click-to-edit helper. `el` becomes a textarea/input when clicked.
// `getValue` returns the current value to seed the editor;
// `commit(value)` is called with the new value when the user confirms;
// `restore()` rebuilds the read-only view (called whether or not committed);
// `options` controls multi-line vs single-line and the editor class.
function attachInlineEditor(
  el,
  {
    getValue,
    commit,
    restore,
    multiline = true,
    singleLine = false,
    autoSize = false,
    commitOnEnter = false,
    editorClass,
    hintClass,
    hintText,
    showHint = true,
  },
) {
  el.tabIndex = 0;
  el.title = "Click to edit";
  el.classList.add("inline-editable");
  el.addEventListener("click", (event) => {
    if (event.target.closest("a, button, img, .inline-editor")) return;
    if (el.classList.contains("editing")) return;
    enter();
  });
  el.addEventListener("keydown", (event) => {
    if (event.target !== el) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      enter();
    }
  });

  function enter() {
    el.classList.add("editing");
    const original = getValue();
    const originalHeight = Math.ceil(el.getBoundingClientRect().height);
    const editor = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) editor.type = "text";
    editor.className = `inline-editor ${editorClass || ""}`.trim();
    editor.value = original;
    if (multiline) {
      editor.rows = Math.max(2, (editor.value.match(/\n/g) || []).length + 1);
    }
    if (autoSize) {
      editor.style.minHeight = `${originalHeight}px`;
      editor.style.overflow = "hidden";
    }

    const hint = document.createElement("div");
    hint.className = `inline-edit-hint ${hintClass || ""}`.trim();
    hint.textContent = showHint
      ? hintText ||
        (commitOnEnter
          ? "Enter to save · Esc to cancel"
          : multiline
            ? "Cmd/Ctrl+Enter to save · Esc to cancel"
            : "Enter to save · Esc to cancel")
      : "";

    if (showHint) el.replaceChildren(editor, hint);
    else el.replaceChildren(editor);
    if (autoSize) resizeInlineEditor(editor);
    editor.focus();
    if (multiline) {
      editor.setSelectionRange(editor.value.length, editor.value.length);
    } else {
      editor.select();
    }

    let done = false;
    const doCommit = () => {
      if (done) return;
      done = true;
      const newValue = singleLine
        ? editor.value.replace(/\s*\n+\s*/g, " ")
        : editor.value;
      el.classList.remove("editing");
      if (newValue !== original) commit(newValue);
      restore();
    };
    const doCancel = () => {
      if (done) return;
      done = true;
      el.classList.remove("editing");
      restore();
    };

    editor.addEventListener("blur", doCommit);
    if (autoSize) {
      editor.addEventListener("input", () => resizeInlineEditor(editor));
    }
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        doCancel();
      } else if (event.key === "Enter") {
        if (commitOnEnter && !event.shiftKey) {
          event.preventDefault();
          doCommit();
          return;
        }
        if (multiline && !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        doCommit();
      }
    });
  }
}

function resizeInlineEditor(editor) {
  editor.style.height = "auto";
  editor.style.height = `${editor.scrollHeight}px`;
}

function applyStepBodyEdit(step, newBody) {
  step.body_md = newBody;
  const updated = patchStepBodyInMarkdown(
    editor.value,
    step.id,
    newBody,
    step.rendered_number ?? step.id,
  );
  if (updated == null) {
    setStatus(
      `Could not locate step ${step.id} in raw markdown; edit not saved.`,
    );
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function patchStepBodyInMarkdown(markdown, stepId, newBodyMd, renderedNum) {
  const re = new RegExp(
    `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
  );
  const match = markdown.match(re);
  if (!match) return null;
  const openMarker = match[1];
  const inner = match[2];
  const closeMarker = match[3];

  // Split inner into "body lines" (before any screenshot block) and the
  // remaining screenshot/extra content. The screenshot block opens with a
  // `<!-- sop-screenshot-start -->` marker, indented or not.
  const screenshotIdx = inner.search(/^\s*<!--\s*sop-screenshot-start\s*-->/m);
  let tail = "";
  if (screenshotIdx !== -1) {
    tail = "\n" + inner.slice(screenshotIdx);
  }

  const formattedBody = formatStepBody(newBodyMd, renderedNum);
  const replaced = openMarker + formattedBody + tail + closeMarker;
  return markdown.replace(re, () => replaced);
}

function formatStepBody(bodyMd, renderedNum) {
  const lines = bodyMd.split("\n");
  if (lines.length === 0) return `${renderedNum}.  `;
  const first = lines[0];
  const rest = lines.slice(1);
  const out = [`${renderedNum}.  ${first}`];
  for (const line of rest) {
    if (!line.trim()) {
      out.push("");
      continue;
    }
    // Continuation lines need 4-space indent so GitHub keeps them inside the
    // numbered-list item.
    out.push(`    ${line}`);
  }
  return out.join("\n");
}

// ---------- Add / delete steps ----------

// ---------- Drag-reorder ----------

let _dragStep = null;
let _lastFocusedStep = null;
let _lastFocusedProcedure = null;

function onStepDragStart(event, step, blockEl, procedure) {
  _dragStep = { step, procedure, blockEl };
  blockEl.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  // Required for Firefox.
  try {
    event.dataTransfer.setData("text/plain", String(step.id));
  } catch {}
}

function onStepDragEnd() {
  if (_dragStep && _dragStep.blockEl)
    _dragStep.blockEl.classList.remove("is-dragging");
  _dragStep = null;
  for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

function onStepDragOver(event, _step, blockEl, procedure) {
  // Detect a file drag from the OS.
  if (
    event.dataTransfer &&
    (event.dataTransfer.types || []).includes("Files")
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    blockEl.classList.add("drop-file");
    return;
  }
  if (!_dragStep || _dragStep.procedure !== procedure) return;
  if (_dragStep.blockEl === blockEl) return;
  // Reject mixing flat and grouped (spec disallows mixed procedures).
  const src = containerOfStep(procedure, _dragStep.step);
  const tgt = containerOfBlock(blockEl);
  if (!src || !tgt) return;
  if ((src === "flat") !== (tgt === "flat")) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = blockEl.getBoundingClientRect();
  const above = event.clientY - rect.top < rect.height / 2;
  blockEl.classList.toggle("drop-above", above);
  blockEl.classList.toggle("drop-below", !above);
}

function onStepDragLeave(event, blockEl) {
  // Only remove the indicator if we've left the block entirely.
  if (!blockEl.contains(event.relatedTarget)) {
    blockEl.classList.remove("drop-above", "drop-below", "drop-file");
  }
}

function onStepDrop(event, target, blockEl, procedure) {
  // File drop from OS?
  blockEl.classList.remove("drop-file");
  if (
    event.dataTransfer &&
    event.dataTransfer.files &&
    event.dataTransfer.files.length
  ) {
    event.preventDefault();
    for (const file of event.dataTransfer.files) {
      if (!file.type.startsWith("image/")) continue;
      addScreenshot(target, procedure, file);
      break; // upload one at a time for now
    }
    return;
  }
  if (!_dragStep || _dragStep.procedure !== procedure) return;
  event.preventDefault();
  const above = blockEl.classList.contains("drop-above");
  blockEl.classList.remove("drop-above", "drop-below");
  const dragged = _dragStep.step;
  _dragStep = null;
  if (dragged === target) return;

  const srcContainer = containerOfStep(procedure, dragged);
  const tgtContainer = containerOfStep(procedure, target);
  if (!srcContainer || !tgtContainer) return;
  if ((srcContainer === "flat") !== (tgtContainer === "flat")) return;

  const srcList = stepListOf(procedure, srcContainer);
  const tgtList = stepListOf(procedure, tgtContainer);
  const fromIdx = srcList.indexOf(dragged);
  if (fromIdx === -1) return;
  srcList.splice(fromIdx, 1);
  // Index in target list may have shifted if same list and the source came
  // before the target. After splice it is fine because target is still in
  // the tgtList (different list, or same list with target index updated).
  let toIdx = tgtList.indexOf(target);
  if (toIdx === -1) {
    // target was the dragged step itself (shouldn't happen but be safe)
    toIdx = tgtList.length;
  } else if (!above) {
    toIdx += 1;
  }
  tgtList.splice(toIdx, 0, dragged);

  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
}

// ---------- Drag-reorder for groups + prose ----------

let _dragGroup = null;
let _dragProse = null;

function onGroupDragStart(event, group, blockEl, procedure) {
  _dragGroup = { group, procedure, blockEl };
  blockEl.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  try {
    event.dataTransfer.setData("text/plain", "group");
  } catch {}
  event.stopPropagation();
}

function onGroupDragEnd() {
  if (_dragGroup && _dragGroup.blockEl)
    _dragGroup.blockEl.classList.remove("is-dragging");
  _dragGroup = null;
  for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

function onGroupDragOver(event, _group, blockEl, procedure) {
  if (!_dragGroup || _dragGroup.procedure !== procedure) return;
  if (_dragGroup.blockEl === blockEl) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.stopPropagation();
  const rect = blockEl.getBoundingClientRect();
  const above = event.clientY - rect.top < rect.height / 2;
  blockEl.classList.toggle("drop-above", above);
  blockEl.classList.toggle("drop-below", !above);
}

function onGroupDragLeave(event, blockEl) {
  if (!blockEl.contains(event.relatedTarget)) {
    blockEl.classList.remove("drop-above", "drop-below");
  }
}

function onGroupDrop(event, target, blockEl, procedure) {
  if (!_dragGroup || _dragGroup.procedure !== procedure) return;
  event.preventDefault();
  event.stopPropagation();
  const above = blockEl.classList.contains("drop-above");
  blockEl.classList.remove("drop-above", "drop-below");
  const dragged = _dragGroup.group;
  _dragGroup = null;
  if (dragged === target) return;

  const list = procedure.groups || [];
  const fromIdx = list.indexOf(dragged);
  if (fromIdx === -1) return;
  list.splice(fromIdx, 1);
  let toIdx = list.indexOf(target);
  if (toIdx === -1) toIdx = list.length;
  else if (!above) toIdx += 1;
  list.splice(toIdx, 0, dragged);

  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
}

function onProseDragStart(event, prose, blockEl, procedure) {
  _dragProse = { prose, procedure, blockEl };
  blockEl.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  try {
    event.dataTransfer.setData("text/plain", "prose");
  } catch {}
}

function onProseDragEnd() {
  if (_dragProse && _dragProse.blockEl)
    _dragProse.blockEl.classList.remove("is-dragging");
  _dragProse = null;
  for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

function onProseDragOver(event, _prose, blockEl, procedure) {
  if (!_dragProse || _dragProse.procedure !== procedure) return;
  if (_dragProse.blockEl === blockEl) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = blockEl.getBoundingClientRect();
  const above = event.clientY - rect.top < rect.height / 2;
  blockEl.classList.toggle("drop-above", above);
  blockEl.classList.toggle("drop-below", !above);
}

function onProseDragLeave(event, blockEl) {
  if (!blockEl.contains(event.relatedTarget)) {
    blockEl.classList.remove("drop-above", "drop-below");
  }
}

function onProseDrop(event, target, blockEl, procedure) {
  if (!_dragProse || _dragProse.procedure !== procedure) return;
  event.preventDefault();
  const above = blockEl.classList.contains("drop-above");
  blockEl.classList.remove("drop-above", "drop-below");
  const dragged = _dragProse.prose;
  _dragProse = null;
  if (dragged === target) return;

  const list = procedure.prose || [];
  const fromIdx = list.indexOf(dragged);
  if (fromIdx === -1) return;
  list.splice(fromIdx, 1);
  let toIdx = list.indexOf(target);
  if (toIdx === -1) toIdx = list.length;
  else if (!above) toIdx += 1;
  list.splice(toIdx, 0, dragged);

  applyProcedureRewrite(procedure, null);
}

function containerOfStep(procedure, step) {
  for (const g of procedure.groups || []) {
    if ((g.steps || []).includes(step)) return g;
  }
  if ((procedure.flat_steps || []).includes(step)) return "flat";
  return null;
}

function containerOfBlock(blockEl) {
  // A step block inside .block-group belongs to that group; otherwise flat.
  const groupEl = blockEl.closest(".block-group");
  if (groupEl) {
    // Locate the matching parsed group by title (titles are stable within a doc).
    const title = groupEl.querySelector("h3")?.textContent || "";
    if (
      currentParsed &&
      currentParsed.sections &&
      currentParsed.sections.procedure
    ) {
      const proc = currentParsed.sections.procedure;
      for (const g of proc.groups || []) {
        if ((g.title || "") === title) return g;
      }
    }
    return null;
  }
  return "flat";
}

function stepListOf(procedure, container) {
  if (container === "flat")
    return (procedure.flat_steps = procedure.flat_steps || []);
  if (container && typeof container === "object")
    return (container.steps = container.steps || []);
  return [];
}

function addStep(procedure, group) {
  const nextId = nextStepId(procedure);
  const newStep = {
    id: nextId,
    rendered_number: nextId,
    attrs: {},
    body_md: "Describe this step.",
    screenshots: [],
  };
  if (group) {
    group.steps = group.steps || [];
    group.steps.push(newStep);
  } else {
    procedure.flat_steps = procedure.flat_steps || [];
    procedure.flat_steps.push(newStep);
  }
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, newStep.id);
}

function deleteStep(procedure, step) {
  const num = step.rendered_number ?? step.id;
  const snapshot = snapshotProcedure(procedure);
  for (const g of procedure.groups || []) {
    g.steps = (g.steps || []).filter((s) => s !== step);
  }
  procedure.flat_steps = (procedure.flat_steps || []).filter((s) => s !== step);
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
  showUndoToast(`Step ${num} deleted.`, () =>
    restoreProcedure(procedure, snapshot),
  );
}

function addGroup(procedure) {
  const nextId = nextStepId(procedure);
  const newGroup = {
    title: "New group",
    steps: [
      {
        id: nextId,
        rendered_number: nextId,
        attrs: {},
        body_md: "Describe this step.",
        screenshots: [],
      },
    ],
  };
  procedure.groups = procedure.groups || [];
  procedure.groups.push(newGroup);
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, newGroup.steps[0].id);
}

function deleteGroup(procedure, group) {
  const count = (group.steps || []).length;
  const title = group.title || "(untitled)";
  const snapshot = snapshotProcedure(procedure);
  procedure.groups = (procedure.groups || []).filter((g) => g !== group);
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
  showUndoToast(
    count
      ? `Group "${title}" (${count} step${count === 1 ? "" : "s"}) deleted.`
      : `Group "${title}" deleted.`,
    () => restoreProcedure(procedure, snapshot),
  );
}

function addProse(procedure) {
  const newProse = {
    after_step_id: null,
    body_md: "New free-form text. Click to edit.",
  };
  procedure.prose = procedure.prose || [];
  procedure.prose.push(newProse);
  applyProcedureRewrite(procedure, null);
  // Open the newly-added prose for editing.
  const blocks = renderedView.querySelectorAll(
    ".block-prose .block-prose-body",
  );
  const last = blocks[blocks.length - 1];
  if (last) {
    last.scrollIntoView({ behavior: "smooth", block: "center" });
    last.click();
  }
}

function deleteProse(procedure, prose) {
  const snapshot = snapshotProcedure(procedure);
  procedure.prose = (procedure.prose || []).filter((p) => p !== prose);
  applyProcedureRewrite(procedure, null);
  showUndoToast("Free-form block deleted.", () =>
    restoreProcedure(procedure, snapshot),
  );
}

const STEP_ACTIONS = [
  "navigate",
  "click",
  "type",
  "upload",
  "download",
  "copy",
  "paste",
  "submit",
  "verify",
  "wait",
  "other",
];

function toggleStepAttrEditor(blockEl, step, procedure) {
  const existing = blockEl.querySelector(".block-step-attr-editor");
  if (existing) {
    existing.remove();
    return;
  }

  const editor = document.createElement("form");
  editor.className = "block-step-attr-editor";

  const attrs = step.attrs || {};
  const allowedSystems =
    (currentParsed &&
      currentParsed.frontmatter &&
      currentParsed.frontmatter.systems) ||
    [];

  // action
  const actionRow = makeAttrRow("Action");
  const actionSel = document.createElement("select");
  actionSel.innerHTML =
    `<option value="">(none)</option>` +
    STEP_ACTIONS.map(
      (a) =>
        `<option value="${a}"${a === attrs.action ? " selected" : ""}>${a}</option>`,
    ).join("");
  actionRow.append(actionSel);
  editor.append(actionRow);

  // tool
  const toolRow = makeAttrRow("Tool");
  const toolInput = document.createElement("input");
  toolInput.type = "text";
  toolInput.value = attrs.tool || "";
  toolInput.placeholder = "Free text, e.g. ‘drag-and-drop’";
  toolRow.append(toolInput);
  editor.append(toolRow);

  // systems (multi-select)
  const sysRow = makeAttrRow("Systems");
  const sysWrap = document.createElement("div");
  sysWrap.className = "block-step-attr-systems";
  const selected = new Set(Array.isArray(attrs.systems) ? attrs.systems : []);
  if (allowedSystems.length === 0) {
    const note = document.createElement("span");
    note.className = "block-step-attr-note";
    note.textContent = "Add systems to the doc frontmatter to enable.";
    sysWrap.append(note);
  } else {
    for (const sys of allowedSystems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "block-step-attr-chip";
      btn.textContent = sys;
      btn.dataset.system = sys;
      btn.classList.toggle("is-selected", selected.has(sys));
      btn.addEventListener("click", () => {
        if (selected.has(sys)) selected.delete(sys);
        else selected.add(sys);
        btn.classList.toggle("is-selected", selected.has(sys));
      });
      sysWrap.append(btn);
    }
  }
  sysRow.append(sysWrap);
  editor.append(sysRow);

  // actions
  const actionsRow = document.createElement("div");
  actionsRow.className = "block-step-attr-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet-button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => editor.remove());
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary-button";
  save.textContent = "Apply";
  actionsRow.append(cancel, save);
  editor.append(actionsRow);

  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    const newAttrs = {};
    const actionVal = actionSel.value.trim();
    if (actionVal) newAttrs.action = actionVal;
    const toolVal = toolInput.value.trim();
    if (toolVal) newAttrs.tool = toolVal;
    const sysList = Array.from(selected);
    if (sysList.length) newAttrs.systems = sysList;
    step.attrs = newAttrs;
    editor.remove();
    applyProcedureRewrite(procedure, null);
  });

  blockEl.querySelector(".block-step-header").after(editor);
}

function makeAttrRow(label) {
  const row = document.createElement("label");
  row.className = "block-step-attr-row";
  const span = document.createElement("span");
  span.className = "block-step-attr-label";
  span.textContent = label;
  row.append(span);
  return row;
}

function snapshotProcedure(procedure) {
  return JSON.parse(
    JSON.stringify({
      groups: procedure.groups || [],
      flat_steps: procedure.flat_steps || [],
      prose: procedure.prose || [],
      todos: procedure.todos || [],
    }),
  );
}

function restoreProcedure(procedure, snapshot) {
  procedure.groups = snapshot.groups;
  procedure.flat_steps = snapshot.flat_steps;
  procedure.prose = snapshot.prose;
  procedure.todos = snapshot.todos;
  renumberProcedure(procedure);
  applyProcedureRewrite(procedure, null);
}

const undoToast = document.querySelector("#undo-toast");
const undoToastText = document.querySelector("#undo-toast-text");
const undoToastButton = document.querySelector("#undo-toast-button");
let _undoTimer = null;
let _undoAction = null;

undoToastButton.addEventListener("click", () => {
  if (_undoAction) {
    const action = _undoAction;
    _undoAction = null;
    hideUndoToast();
    action();
  }
});

function showUndoToast(message, restoreFn) {
  undoToastText.textContent = message;
  _undoAction = restoreFn;
  undoToast.hidden = false;
  if (_undoTimer) clearTimeout(_undoTimer);
  _undoTimer = setTimeout(hideUndoToast, 8000);
}

function hideUndoToast() {
  undoToast.hidden = true;
  _undoAction = null;
  if (_undoTimer) {
    clearTimeout(_undoTimer);
    _undoTimer = null;
  }
}

const errorToast = document.querySelector("#error-toast");
const errorToastText = document.querySelector("#error-toast-text");
const errorToastClose = document.querySelector("#error-toast-close");
let _errorTimer = null;
errorToastClose.addEventListener("click", () => {
  errorToast.hidden = true;
});

function showErrorToast(message) {
  errorToastText.textContent = message;
  errorToast.hidden = false;
  if (_errorTimer) clearTimeout(_errorTimer);
  _errorTimer = setTimeout(() => {
    errorToast.hidden = true;
  }, 10000);
}

function reportError(message) {
  setStatus(message);
  showErrorToast(message);
}

function nextStepId(procedure) {
  let max = 0;
  for (const g of procedure.groups || []) {
    for (const s of g.steps || []) max = Math.max(max, s.id);
  }
  for (const s of procedure.flat_steps || []) max = Math.max(max, s.id);
  return max + 1;
}

function renumberProcedure(procedure) {
  let n = 0;
  for (const g of procedure.groups || []) {
    for (const s of g.steps || []) {
      n += 1;
      s.id = n;
      s.rendered_number = n;
    }
  }
  for (const s of procedure.flat_steps || []) {
    n += 1;
    s.id = n;
    s.rendered_number = n;
  }
}

function applyProcedureRewrite(procedure, focusStepId) {
  const newBody = emitProcedureSectionBody(procedure);
  const updated = patchSectionInMarkdown(editor.value, "procedure", newBody);
  if (updated == null) {
    setStatus("Could not locate procedure section; structural edit not saved.");
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
  renderParsedDocument();
  if (focusStepId != null) {
    // After re-render, find the new step's body and open the inline editor.
    const block = renderedView.querySelector(
      `.block-step[data-step-id="${focusStepId}"] .block-step-body`,
    );
    if (block) {
      block.scrollIntoView({ behavior: "smooth", block: "center" });
      block.click();
    }
  }
}

function emitProcedureSectionBody(procedure) {
  const out = ["## Procedure", ""];
  const todos = procedure.todos || [];
  for (const t of todos) out.push(`<!-- sop-todo: "${escapeAttr(t)}" -->`);
  if (todos.length) out.push("");

  const groups = procedure.groups || [];
  if (groups.length) {
    for (const g of groups) {
      out.push(`<!-- sop-group-start: "${escapeAttr(g.title || "")}" -->`);
      out.push(`### ${g.title || ""}`);
      out.push("");
      for (const s of g.steps || []) out.push(emitStepBlock(s));
      out.push(`<!-- sop-group-end -->`);
      out.push("");
    }
  }
  for (const s of procedure.flat_steps || []) out.push(emitStepBlock(s));

  for (const p of procedure.prose || []) {
    out.push(`<!-- sop-prose-start -->`);
    out.push(p.body_md || "");
    out.push(`<!-- sop-prose-end -->`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}

function emitStepBlock(step) {
  const attrParts = [`id=${step.id}`];
  for (const [k, v] of Object.entries(step.attrs || {})) {
    if (Array.isArray(v)) {
      if (v.length) attrParts.push(`${k}="${escapeAttr(v.join(","))}"`);
    } else if (v != null && v !== "") {
      attrParts.push(`${k}="${escapeAttr(String(v))}"`);
    }
  }
  const lines = [];
  lines.push(`<!-- sop-step-start ${attrParts.join(" ")} -->`);
  const renderedNum = step.rendered_number ?? step.id;
  const bodyText = (step.body_md || "").replace(/^ /, "");
  lines.push(formatStepBody(bodyText, renderedNum));
  for (const shot of step.screenshots || []) {
    lines.push("");
    lines.push("    <!-- sop-screenshot-start -->");
    if (shot.src) lines.push(`    ![${shot.alt || ""}](${shot.src})`);
    if (shot.caption) {
      lines.push("    <!-- sop-caption-start -->");
      lines.push(`    ${shot.caption}`);
      lines.push("    <!-- sop-caption-end -->");
    }
    lines.push("    <!-- sop-screenshot-end -->");
  }
  lines.push(`<!-- sop-step-end -->`);
  lines.push("");
  return lines.join("\n");
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '\\"');
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function patchSectionInMarkdown(markdown, name, newBodyMd) {
  const re = new RegExp(
    `(<!--\\s*sop-section-start:\\s*${name}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-section-end\\s*-->)`,
  );
  if (!re.test(markdown)) return null;
  return markdown.replace(
    re,
    (_, open, _body, close) => `${open}${newBodyMd}${close}`,
  );
}

function patchProseInMarkdown(markdown, index, newBodyMd) {
  const re =
    /<!--\s*sop-prose-start\s*-->\n([\s\S]*?)\n<!--\s*sop-prose-end\s*-->/g;
  let i = 0;
  let replaced = false;
  const next = markdown.replace(re, (full, _body) => {
    if (i++ === index) {
      replaced = true;
      return `<!-- sop-prose-start -->\n${newBodyMd}\n<!-- sop-prose-end -->`;
    }
    return full;
  });
  return replaced ? next : null;
}

function patchGroupTitleInMarkdown(markdown, oldTitle, newTitle) {
  const escapedOld = escapeRegex(oldTitle);
  const markerRe = new RegExp(
    `(<!--\\s*sop-group-start:\\s*")${escapedOld}("\\s*-->)`,
  );
  if (!markerRe.test(markdown)) return null;
  let next = markdown.replace(markerRe, `$1${newTitle.replace(/"/g, '\\"')}$2`);
  // Also update the visible "### <title>" line if it sits inside this group.
  const headingRe = new RegExp(`(\\n)###\\s+${escapedOld}(\\s*\\n)`);
  next = next.replace(headingRe, `$1### ${newTitle}$2`);
  return next;
}

function patchCaptionInMarkdown(markdown, stepId, screenshotIndex, newCaption) {
  const stepRe = new RegExp(
    `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
  );
  const match = markdown.match(stepRe);
  if (!match) return null;
  let inner = match[2];
  const shotRe =
    /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
  let i = 0;
  let replaced = false;
  const newInner = inner.replace(shotRe, (full, shotBody) => {
    if (i++ !== screenshotIndex) return full;
    replaced = true;
    const captionRe =
      /<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->/;
    const replacement = newCaption
      ? `<!-- sop-caption-start -->\n    ${newCaption}\n    <!-- sop-caption-end -->`
      : null;
    if (captionRe.test(shotBody)) {
      const newBody = replacement
        ? shotBody.replace(captionRe, replacement)
        : shotBody.replace(
            /\s*<!--\s*sop-caption-start\s*-->[\s\S]*?<!--\s*sop-caption-end\s*-->\s*/,
            "",
          );
      return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
    }
    if (!replacement) return full;
    // Insert a caption before the screenshot-end marker.
    const insertedBody = shotBody.replace(
      /(\n\s*)$/,
      (_, ws) => `\n    ${replacement}${ws}`,
    );
    return `<!-- sop-screenshot-start -->\n${insertedBody}<!-- sop-screenshot-end -->`;
  });
  if (!replaced) return null;
  return markdown.replace(
    stepRe,
    (_, openMarker, _inner, closeMarker) =>
      `${openMarker}${newInner}${closeMarker}`,
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderProseBlock(prose, index, procedure) {
  const block = document.createElement("aside");
  block.className = "block-prose";
  if (procedure) {
    block.addEventListener("dragover", (event) =>
      onProseDragOver(event, prose, block, procedure),
    );
    block.addEventListener("dragleave", (event) =>
      onProseDragLeave(event, block),
    );
    block.addEventListener("drop", (event) =>
      onProseDrop(event, prose, block, procedure),
    );
  }

  const headerRow = document.createElement("div");
  headerRow.className = "block-prose-header";
  if (procedure) {
    const handle = document.createElement("span");
    handle.className = "block-step-drag block-prose-drag";
    handle.title = "Drag to reorder";
    handle.setAttribute("aria-label", "Drag free-form block");
    handle.textContent = "⋮⋮";
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) =>
      onProseDragStart(event, prose, block, procedure),
    );
    handle.addEventListener("dragend", onProseDragEnd);
    headerRow.append(handle);
  }
  const label = document.createElement("span");
  label.className = "block-prose-label";
  label.textContent = "Free-form";
  headerRow.append(label);
  if (procedure) {
    const spacer = document.createElement("span");
    spacer.className = "block-step-spacer";
    headerRow.append(spacer);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "block-step-delete";
    delBtn.title = "Delete free-form block";
    delBtn.setAttribute("aria-label", "Delete free-form block");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProse(procedure, prose);
    });
    headerRow.append(delBtn);
  }
  block.append(headerRow);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "block-prose-body";
  bodyWrap.append(renderMarkdown(prose.body_md || ""));
  attachInlineEditor(bodyWrap, {
    getValue: () => prose.body_md || "",
    commit: (value) => applyProseEdit(prose, index, value),
    restore: () =>
      bodyWrap.replaceChildren(renderMarkdown(prose.body_md || "")),
    multiline: true,
  });
  block.append(bodyWrap);
  return block;
}

function applyProseEdit(prose, index, newBody) {
  prose.body_md = newBody;
  const updated = patchProseInMarkdown(editor.value, index, newBody);
  if (updated == null) {
    setStatus(`Could not locate prose block #${index + 1}; edit not saved.`);
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function renderScreenshot(shot, step, screenshotIndex, procedure) {
  const figure = document.createElement("figure");
  figure.className = "block-screenshot";
  figure.tabIndex = 0;
  if (procedure) {
    figure.addEventListener("dragover", (event) =>
      onScreenshotDragOver(event, shot, figure, step, procedure),
    );
    figure.addEventListener("dragleave", (event) =>
      onScreenshotDragLeave(event, figure),
    );
    figure.addEventListener("drop", (event) =>
      onScreenshotDrop(event, shot, figure, step, procedure),
    );
  }

  const toolbar = document.createElement("div");
  toolbar.className = "block-screenshot-toolbar";
  if (procedure && (step.screenshots || []).length > 1) {
    const handle = document.createElement("span");
    handle.className = "block-step-drag block-screenshot-drag";
    handle.title = "Drag to reorder screenshot";
    handle.setAttribute("aria-label", "Drag screenshot");
    handle.textContent = "⋮⋮";
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) =>
      onScreenshotDragStart(event, shot, figure, step, procedure),
    );
    handle.addEventListener("dragend", onScreenshotDragEnd);
    toolbar.append(handle);
  }
  if (procedure) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "block-step-delete";
    delBtn.title = "Delete screenshot";
    delBtn.setAttribute("aria-label", "Delete screenshot");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteScreenshot(step, shot, procedure);
    });
    toolbar.append(delBtn);
  }
  if (toolbar.children.length) figure.append(toolbar);

  const noteToggle = document.createElement("button");
  noteToggle.type = "button";
  noteToggle.className = "block-screenshot-note-toggle";
  noteToggle.textContent = "Text";
  noteToggle.title = "Show image text";
  noteToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    figure.classList.toggle("is-note-visible");
  });
  figure.append(noteToggle);

  if (shot.src) {
    const img = document.createElement("img");
    img.src = resolveImageSrc(shot.src);
    img.alt = shot.alt || "";
    img.loading = "lazy";
    img.addEventListener("click", (event) => {
      event.stopPropagation();
      openLightbox(img.src, shot.caption || shot.alt || "");
    });
    figure.append(img);
  }
  const cap = document.createElement("figcaption");
  cap.className = "block-screenshot-note";
  cap.textContent = shot.caption || (step ? "Add caption…" : "");
  if (!shot.caption) cap.classList.add("is-placeholder");
  if (step) {
    attachInlineEditor(cap, {
      getValue: () => shot.caption || "",
      commit: (value) =>
        applyCaptionEdit(step, screenshotIndex, shot, value, cap),
      restore: () => {
        cap.textContent = shot.caption || "Add caption…";
        cap.classList.toggle("is-placeholder", !shot.caption);
      },
      multiline: true,
    });
  }
  const notes = document.createElement("div");
  notes.className = "block-screenshot-notes";
  notes.append(cap);

  if (step) {
    const alt = document.createElement("div");
    alt.className = "block-screenshot-alt block-screenshot-note";
    alt.textContent = shot.alt || "Add alt text for accessibility…";
    if (!shot.alt) alt.classList.add("is-placeholder");
    attachInlineEditor(alt, {
      getValue: () => shot.alt || "",
      commit: (value) => applyAltEdit(step, screenshotIndex, shot, value),
      restore: () => {
        alt.textContent = shot.alt || "Add alt text for accessibility…";
        alt.classList.toggle("is-placeholder", !shot.alt);
      },
      multiline: false,
    });
    notes.append(alt);
  }
  figure.append(notes);
  return figure;
}

function deleteScreenshot(step, shot, procedure) {
  const snapshot = snapshotProcedure(procedure);
  step.screenshots = (step.screenshots || []).filter((s) => s !== shot);
  applyProcedureRewrite(procedure, null);
  showUndoToast("Screenshot deleted.", () =>
    restoreProcedure(procedure, snapshot),
  );
}

let _dragShot = null;

function onScreenshotDragStart(event, shot, figEl, step, procedure) {
  _dragShot = { shot, step, procedure, figEl };
  figEl.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  try {
    event.dataTransfer.setData("text/plain", "screenshot");
  } catch {}
  event.stopPropagation();
}

function onScreenshotDragEnd() {
  if (_dragShot && _dragShot.figEl)
    _dragShot.figEl.classList.remove("is-dragging");
  _dragShot = null;
  for (const el of renderedView.querySelectorAll(".drop-above, .drop-below")) {
    el.classList.remove("drop-above", "drop-below");
  }
}

function onScreenshotDragOver(event, _shot, figEl, step, procedure) {
  if (!_dragShot) return;
  if (_dragShot.step !== step) return;
  if (_dragShot.figEl === figEl) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.stopPropagation();
  const rect = figEl.getBoundingClientRect();
  const above = event.clientY - rect.top < rect.height / 2;
  figEl.classList.toggle("drop-above", above);
  figEl.classList.toggle("drop-below", !above);
}

function onScreenshotDragLeave(event, figEl) {
  if (!figEl.contains(event.relatedTarget)) {
    figEl.classList.remove("drop-above", "drop-below");
  }
}

function onScreenshotDrop(event, target, figEl, step, procedure) {
  if (!_dragShot || _dragShot.step !== step) return;
  event.preventDefault();
  event.stopPropagation();
  const above = figEl.classList.contains("drop-above");
  figEl.classList.remove("drop-above", "drop-below");
  const dragged = _dragShot.shot;
  _dragShot = null;
  if (dragged === target) return;

  const list = step.screenshots || [];
  const fromIdx = list.indexOf(dragged);
  if (fromIdx === -1) return;
  list.splice(fromIdx, 1);
  let toIdx = list.indexOf(target);
  if (toIdx === -1) toIdx = list.length;
  else if (!above) toIdx += 1;
  list.splice(toIdx, 0, dragged);

  applyProcedureRewrite(procedure, null);
}

function applyAltEdit(step, screenshotIndex, shot, newAlt) {
  shot.alt = newAlt;
  const updated = patchAltInMarkdown(
    editor.value,
    step.id,
    screenshotIndex,
    newAlt,
    shot.src,
  );
  if (updated == null) {
    setStatus(
      `Could not locate alt for screenshot #${screenshotIndex + 1} on step ${step.id}.`,
    );
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function patchAltInMarkdown(markdown, stepId, screenshotIndex, newAlt, src) {
  const stepRe = new RegExp(
    `(<!--\\s*sop-step-start\\b[^>]*\\bid=${stepId}\\b[^>]*-->\\n)([\\s\\S]*?)(\\n<!--\\s*sop-step-end\\s*-->)`,
  );
  const match = markdown.match(stepRe);
  if (!match) return null;
  let inner = match[2];
  const shotRe =
    /<!--\s*sop-screenshot-start\s*-->\n([\s\S]*?)<!--\s*sop-screenshot-end\s*-->/g;
  let i = 0;
  let replaced = false;
  const newInner = inner.replace(shotRe, (full, shotBody) => {
    if (i++ !== screenshotIndex) return full;
    replaced = true;
    const imgRe = /!\[[^\]]*\]\(([^)]+)\)/;
    const newBody = shotBody.replace(imgRe, `![${newAlt}](${src})`);
    return `<!-- sop-screenshot-start -->\n${newBody}<!-- sop-screenshot-end -->`;
  });
  if (!replaced) return null;
  return markdown.replace(
    stepRe,
    (_, openMarker, _inner, closeMarker) =>
      `${openMarker}${newInner}${closeMarker}`,
  );
}

function applyCaptionEdit(step, screenshotIndex, shot, newCaption, capEl) {
  shot.caption = newCaption;
  const updated = patchCaptionInMarkdown(
    editor.value,
    step.id,
    screenshotIndex,
    newCaption,
  );
  if (updated == null) {
    setStatus(
      `Could not locate caption #${screenshotIndex + 1} on step ${step.id}; edit not saved.`,
    );
    return;
  }
  editor.value = updated;
  storeDraft();
  updateSaveState();
}

function resolveImageSrc(src) {
  if (!src) return "";
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/")) return src;
  if (!currentDoc) return src;
  // Resolve relative path against the current doc's directory; both live
  // under content/, which the frontend container serves at /content/.
  const docDir = currentDoc.path.split("/").slice(0, -1).join("/");
  const stack = docDir.split("/").filter(Boolean);
  for (const part of src.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

function stripFrontmatter(md) {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---\n", 4);
  if (end === -1) return md;
  return md.slice(end + 5).replace(/^\n+/, "");
}

function stripLeadingHeading(md) {
  // Sections include their visible ## Heading line first; drop it because
  // the block header already shows the name.
  return md.replace(/^##\s+[^\n]*\n+/, "");
}

// ---------- Minimal markdown renderer for block bodies ----------

function renderMarkdown(markdown) {
  const wrap = document.createElement("div");
  wrap.className = "md";
  const html = markdownToHtml(markdown || "");
  wrap.innerHTML = html;
  wrap.querySelectorAll("[data-doc-path]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const path = link.getAttribute("data-doc-path");
      if (path) openDocument(path);
    });
  });
  return wrap;
}

function markdownToHtml(md) {
  if (!md) return "";
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = escaped.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Blockquote
    if (/^&gt;\s/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^&gt;\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
      continue;
    }
    // Fenced code
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // close fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s/, ""));
        i++;
      }
      out.push(
        `<ol>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ol>`,
      );
      continue;
    }
    // Bulleted list
    if (/^\s*[-*]\s/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*]\s/, ""));
        i++;
      }
      out.push(
        `<ul>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ul>`,
      );
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = Math.min(6, h[1].length);
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }
    // Table: pipe-delimited rows with a separator row underneath.
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const headerCells = splitTableRow(line);
      i += 2; // skip header + separator
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // Paragraph (collect until blank line)
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^[#>`\-*]/.test(lines[i].trim()[0]) &&
      !/^\s*\d+\.\s/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function inlineMd(text) {
  let s = text;
  // Internal wiki links: [[doc-id]] or [[doc-id|Custom label]].
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawRef, rawLabel) => {
    const ref = String(rawRef || "").trim();
    const doc = resolveDocReference(ref);
    if (!doc) {
      const label = rawLabel || ref;
      return `<span class="broken-doc-link" title="Missing doc: ${escapeHtmlAttr(ref)}">${escapeHtml(label)}</span>`;
    }
    const label = rawLabel || doc.title || ref;
    return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
  });
  // Inline image
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const resolved = resolveImageSrc(src);
    return `<img src="${resolved}" alt="${alt}" loading="lazy">`;
  });
  // Link
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const doc = resolveMarkdownDocLink(href);
    if (doc) {
      return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
    }
    const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
    const target = /^(https?:|mailto:)/i.test(href)
      ? ' target="_blank" rel="noopener"'
      : "";
    return `<a href="${safe}"${target}>${label}</a>`;
  });
  // Bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

function visibleDocUrl(path) {
  return "/" + String(path || "").replace(/^content\//, "");
}

function resolveMarkdownDocLink(href) {
  if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
  if (href.startsWith("doc:")) return resolveDocReference(href.slice(4));
  const clean = href.split("#")[0].split("?")[0];
  if (!clean.endsWith(".md")) return null;
  if (clean.startsWith("/"))
    return resolveDocReference(clean.replace(/^\/+/, ""));
  if (currentDoc) {
    const docDir = currentDoc.path.split("/").slice(0, -1).join("/");
    const stack = docDir.split("/").filter(Boolean);
    for (const part of clean.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return resolveDocReference(stack.join("/"));
  }
  return resolveDocReference(clean);
}
