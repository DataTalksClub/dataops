import { createAccountShell } from "../shell/account.js";
import { createNotificationsShell } from "../shell/notifications.js";
import { createPreferencesShell } from "../shell/preferences.js";

export function createApplicationShells(context) {
  const {
    canLeaveCurrentDocument,
    documentRef,
    dom,
    fetchImpl,
    formatShortDate,
    formatTaskDateMeta,
    HTMLElementClass,
    isOperationsWorkspaceVisible,
    isoDayDistance,
    localStorageRef,
    openTaskPanel,
    requestAnimationFrameImpl,
    refreshDocuments,
    request,
    showWorkspaceSurface,
    todayIsoDate,
    windowRef,
    workApiUrl,
  } = context;
  const preferences = createPreferencesShell({
    documentRef,
    matchMedia: (query) => windowRef.matchMedia(query),
  });

  let notifications;
  const account = createAccountShell({
    canLeaveCurrentDocument,
    closeNotifications: (...args) =>
      notifications.closeWorkBellPanel(...args),
    documentRef,
    fetchImpl,
    historyButton: dom.historyButton,
    knowledgeStatusButton: dom.knowledgeStatusButton,
    HTMLElementClass,
    isOperationsWorkspaceVisible,
    locationRef: windowRef.location,
    refreshDocuments,
    showWorkspaceSurface,
    themeToggleButton: dom.themeToggleButton,
  });
  notifications = createNotificationsShell({
    closeSettingsMenu: account.closeSettingsMenu,
    documentRef,
    encodeURIComponentImpl: encodeURIComponent,
    formatShortDate,
    formatTaskDateMeta,
    HTMLElementClass,
    isoDayDistance,
    openTaskPanel,
    requestAnimationFrameImpl,
    request,
    todayIsoDate,
    workApiUrl,
  });
  notifications.bindToggle();
  return { account, notifications, preferences };
}
