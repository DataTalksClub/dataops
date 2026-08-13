import { createAccountShell } from "../shell/account.js";
import { createNotificationsShell } from "../shell/notifications.js";
import { createPreferencesShell } from "../shell/preferences.js";

export function createApplicationShells(context) {
  const {
    canLeaveCurrentDocument,
    documentRef,
    dom,
    fetchImpl,
    formatHomeShortDate,
    formatTaskDateMeta,
    HTMLElementClass,
    isOperationsHomeVisible,
    isWorkspaceRouteFresh,
    isoDayDistance,
    localStorageRef,
    navigateCanonicalWorkspace,
    openTaskPanel,
    parseWorkspaceHash,
    requestAnimationFrameImpl,
    refreshDocuments,
    request,
    showWorkspaceSurface,
    todayIsoDate,
    windowRef,
    workApiUrl,
    workspaceState,
  } = context;
  const preferences = createPreferencesShell({
    body: dom.body,
    documentRef,
    getMobileWorkBellButton: () =>
      documentRef.querySelector("#mobile-work-bell-button"),
    HTMLElementClass,
    matchMedia: (query) => windowRef.matchMedia(query),
    mobileMenuButton: dom.mobileMenuButton,
    mobileNewButton: dom.mobileNewButton,
    pageShell: dom.pageShell,
    sidebar: dom.sidebar,
    sidebarExpandButton: dom.sidebarExpandButton,
    sidebarResize: dom.sidebarResize,
    sidebarScrim: dom.sidebarScrim,
    storage: localStorageRef,
    themeToggleButton: dom.themeToggleButton,
  });

  let notifications;
  const account = createAccountShell({
    canLeaveCurrentDocument,
    closeNotifications: (...args) =>
      notifications.closeWorkBellPanel(...args),
    documentRef,
    fetchImpl,
    getActiveWorkspaceView: () => workspaceState.activeWorkspaceView,
    gitCommitButton: dom.gitCommitButton,
    gitPullButton: dom.gitPullButton,
    HTMLElementClass,
    isOperationsHomeVisible,
    locationRef: windowRef.location,
    refreshDocuments,
    showWorkspaceSurface,
    syncThemeToggleLabel: preferences.syncThemeToggleLabel,
    themeToggleButton: dom.themeToggleButton,
  });
  notifications = createNotificationsShell({
    closeSettingsMenu: account.closeSettingsMenu,
    documentRef,
    encodeURIComponentImpl: encodeURIComponent,
    formatHomeShortDate,
    formatTaskDateMeta,
    HTMLElementClass,
    isWorkspaceRouteFresh,
    isoDayDistance,
    navigateCanonicalWorkspace,
    openTaskPanel,
    parseWorkspaceHash,
    requestAnimationFrameImpl,
    request,
    todayIsoDate,
    workApiUrl,
  });
  notifications.bindToggle(canLeaveCurrentDocument);
  return { account, notifications, preferences };
}
