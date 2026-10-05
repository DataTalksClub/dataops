import { createCollectionLoader } from "../core/collection-loader.js";

export function createNotificationsShell({
  closeSettingsMenu,
  documentRef,
  encodeURIComponentImpl,
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
}) {
  const workBellButton = documentRef.querySelector("#work-bell-button");
  const workBellCount = workBellButton?.querySelector(".work-bell-count");
  const mobileWorkBellButton = documentRef.querySelector(
    "#mobile-work-bell-button",
  );
  const mobileWorkBellCount = mobileWorkBellButton?.querySelector(
    ".work-bell-count",
  );
  const workBellPanel = documentRef.querySelector("#work-bell-panel");
  const workBellBody = documentRef.querySelector("#work-bell-body");
  const workBellClose = documentRef.querySelector("#work-bell-close");
  const notificationLoader = createCollectionLoader({
    request,
    collection: "notifications",
    createUrl: ({ cursor, limit }) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return workApiUrl(`/api/notifications?${query}`);
    },
  });
  let notificationState = notificationLoader.getSnapshot();
  const dismissErrors = new Map();
  const locallyDismissedIds = new Set();
  let opener = null;
  let pendingDismissFocusId = "";
  let panelRenderVersion = 0;

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

  function compareNotificationsNewestFirst(left, right) {
    return (
      String(right?.createdAt || "").localeCompare(
        String(left?.createdAt || ""),
      ) || String(left?.id || "").localeCompare(String(right?.id || ""))
    );
  }

  function syncWorkBellIndicators() {
    const count = [...notificationState.items].filter(
      (item) => !locallyDismissedIds.has(item.id),
    ).length;
    const indicatorText =
      notificationState.failed && count === 0 ? "!" : String(count);
    for (const indicator of [workBellCount, mobileWorkBellCount]) {
      if (!indicator) continue;
      indicator.textContent = indicatorText;
      indicator.classList.toggle(
        "is-visible",
        Boolean(notificationState.failed && count === 0) || count > 0,
      );
      indicator.classList.toggle(
        "is-error",
        Boolean(notificationState.failed && count === 0),
      );
    }
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
    pendingDismissFocusId = "";
    panelRenderVersion += 1;
    if (options.restoreFocus !== false && opener?.isConnected) opener.focus();
    opener = null;
  }

  function openWorkBellPanel() {
    opener =
      documentRef.activeElement instanceof HTMLElementClass
        ? documentRef.activeElement
        : workBellButton;
    renderWorkBellPanel();
    workBellPanel.hidden = false;
    workBellClose.focus();
  }

  async function dismissWorkNotification(notification, button) {
    button.disabled = true;
    button.textContent = "Dismissing…";
    try {
      await request(
        workApiUrl(
          `/api/notifications/${encodeURIComponentImpl(notification.id)}/dismiss`,
        ),
        { method: "PUT" },
      );
      locallyDismissedIds.add(notification.id);
      dismissErrors.delete(notification.id);
      pendingDismissFocusId = "";
      syncWorkBellIndicators();
      renderWorkBellPanel();
    } catch (error) {
      dismissErrors.set(
        notification.id,
        error.message || "Notification could not be dismissed",
      );
      pendingDismissFocusId = notification.id;
      renderWorkBellPanel();
    }
  }

  function scheduleDismissRecoveryFocus(version) {
    const notificationId = pendingDismissFocusId;
    if (!notificationId) return;
    requestAnimationFrameImpl(() => {
      if (
        version !== panelRenderVersion ||
        workBellPanel.hidden ||
        pendingDismissFocusId !== notificationId
      )
        return;
      const recovery = [
        ...workBellBody.querySelectorAll("[data-dismiss-notification]"),
      ].find(
        (candidate) =>
          candidate.dataset.dismissNotification === notificationId &&
          candidate.isConnected &&
          candidate.offsetParent !== null,
      );
      recovery?.focus();
    });
  }

  function renderWorkBellPanel() {
    const version = ++panelRenderVersion;
    workBellBody.replaceChildren();
    if (notificationState.failed && notificationState.items.length === 0) {
      const outage = documentRef.createElement("div");
      outage.className = "work-bell-empty is-error";
      const message = documentRef.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = `Notifications unavailable: ${notificationState.error}`;
      const retry = documentRef.createElement("button");
      retry.type = "button";
      retry.className = "work-bell-action";
      retry.dataset.retryNotifications = "true";
      retry.textContent = "Retry notifications";
      retry.addEventListener("click", () => {
        void retryInitialNotifications(retry);
      });
      outage.append(message, retry);
      workBellBody.append(outage);
      return;
    }
    if (
      !notificationState.loaded &&
      !notificationState.failed &&
      notificationState.items.length === 0
    ) {
      const loading = documentRef.createElement("p");
      loading.className = "work-bell-empty";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading notifications…";
      workBellBody.append(loading);
      return;
    }
    const visibleNotifications = notificationState.items.filter(
      (item) => !locallyDismissedIds.has(item.id),
    );
    visibleNotifications.sort(compareNotificationsNewestFirst);
    if (
      visibleNotifications.length === 0 &&
      notificationState.complete &&
      !notificationState.failed
    ) {
      const empty = documentRef.createElement("div");
      empty.className = "work-bell-empty-state";
      empty.innerHTML = `
        <span class="work-bell-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="m7 13 3 3 7-8" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>
        <strong>You’re all caught up.</strong>
        <p class="work-bell-empty">No active notifications.</p>
      `;
      workBellBody.append(empty);
    }
    for (const notification of visibleNotifications) {
      const item = documentRef.createElement("div");
      item.className = "work-bell-item";
      item.classList.add(notificationUrgencyClass(notification));
      const message = documentRef.createElement("div");
      message.className = "work-bell-item-message";
      const icon = documentRef.createElement("span");
      icon.className = "work-bell-item-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = notification.taskId
        ? '<svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17h.01"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
      const text = documentRef.createElement("span");
      text.textContent = notificationDisplayMessage(notification);
      message.append(icon, text);
      item.append(message);
      const meta = documentRef.createElement("div");
      meta.className = "work-bell-item-meta";
      if (notification.dueAt) {
        meta.textContent = notificationDueLabel(notification.dueAt);
      } else if (notification.createdAt) {
        const date = String(notification.createdAt).slice(0, 10);
        meta.textContent = `Added ${formatHomeShortDate(date)}`;
      }
      item.append(meta);
      const actions = documentRef.createElement("div");
      actions.className = "work-bell-item-actions";
      if (notification.taskId) {
        const open = documentRef.createElement("button");
        open.type = "button";
        open.className = "work-bell-action work-bell-action-primary";
        open.textContent = "Open task";
        open.addEventListener("click", () => {
          closeWorkBellPanel({ updateUrl: false });
          openTaskPanel(notification.taskId);
        });
        actions.append(open);
      }
      const dismiss = documentRef.createElement("button");
      dismiss.type = "button";
      dismiss.className = "work-bell-action";
      dismiss.textContent = "Dismiss";
      dismiss.dataset.dismissNotification = notification.id;
      dismiss.setAttribute(
        "aria-label",
        `Dismiss notification: ${
          notification.message || notification.type || notification.id
        }`,
      );
      dismiss.addEventListener("click", () => {
        dismissWorkNotification(notification, dismiss);
      });
      actions.append(dismiss);
      item.append(actions);
      const failure = dismissErrors.get(notification.id);
      if (failure) {
        const error = documentRef.createElement("p");
        error.className = "work-bell-item-error";
        error.setAttribute("role", "alert");
        error.textContent = `${failure} Select Dismiss to retry.`;
        item.append(error);
      }
      workBellBody.append(item);
    }
    if (
      pendingDismissFocusId &&
      !visibleNotifications.some((item) => item.id === pendingDismissFocusId)
    ) {
      pendingDismissFocusId = "";
    }
    scheduleDismissRecoveryFocus(version);

    const continuation = documentRef.createElement("div");
    continuation.className = "work-bell-continuation";
    if (notificationState.loading || notificationState.loadingMore) {
      const loading = documentRef.createElement("p");
      loading.className = "work-bell-empty";
      loading.setAttribute("role", "status");
      loading.textContent = notificationState.loadingMore
        ? "Loading more notifications…"
        : "Loading notifications…";
      continuation.append(loading);
    } else if (
      notificationState.failed &&
      notificationState.moreAvailable
    ) {
      const error = documentRef.createElement("p");
      error.className = "work-bell-item-error";
      error.setAttribute("role", "alert");
      error.textContent = `More notifications are available, but loading failed: ${notificationState.error}`;
      const retry = documentRef.createElement("button");
      retry.type = "button";
      retry.className = "work-bell-action";
      retry.dataset.loadNotifications = "retry";
      retry.textContent = "Retry next page";
      retry.addEventListener("click", () => {
        loadMoreNotifications(retry);
      });
      continuation.append(error, retry);
    } else if (notificationState.moreAvailable) {
      const available = documentRef.createElement("p");
      available.className = "work-bell-empty";
      available.textContent = "More notifications are available.";
      const loadMore = documentRef.createElement("button");
      loadMore.type = "button";
      loadMore.className = "work-bell-action";
      loadMore.dataset.loadNotifications = "next";
      loadMore.textContent = "Load more";
      loadMore.addEventListener("click", () => {
        loadMoreNotifications(loadMore);
      });
      continuation.append(available, loadMore);
    } else if (
      notificationState.complete &&
      visibleNotifications.length > 0
    ) {
      const exhausted = documentRef.createElement("p");
      exhausted.className = "work-bell-empty";
      exhausted.textContent = "All notifications loaded.";
      continuation.append(exhausted);
    }
    if (continuation.children.length > 0) workBellBody.append(continuation);
  }

  async function loadMoreNotifications(button) {
    button.disabled = true;
    button.textContent = "Loading…";
    notificationState = await notificationLoader.loadMore();
    syncWorkBellIndicators();
    renderWorkBellPanel();
  }

  async function retryInitialNotifications(button) {
    button.disabled = true;
    button.textContent = "Retrying…";
    const pendingLoad = notificationLoader.load();
    notificationState = notificationLoader.getSnapshot();
    syncWorkBellIndicators();
    renderWorkBellPanel();
    notificationState = await pendingLoad;
    syncWorkBellIndicators();
    renderWorkBellPanel();
  }

  async function refreshWorkBell(options = {}) {
    if (options.token && !isWorkspaceRouteFresh(options.token)) return;
    const snapshot = await notificationLoader.load();
    if (options.token && !isWorkspaceRouteFresh(options.token)) return;
    notificationState = snapshot;
    locallyDismissedIds.clear();
    syncWorkBellIndicators();
    if (!workBellPanel.hidden) renderWorkBellPanel();
  }

  function bindToggle(canLeaveCurrentDocument) {
    const toggle = async () => {
      if (workBellPanel.hidden) {
        if (!(await canLeaveCurrentDocument())) return false;
        await navigateCanonicalWorkspace("/notifications").ready;
        return true;
      }
      closeWorkBellPanel();
      return true;
    };
    workBellButton.addEventListener("click", toggle);
    mobileWorkBellButton?.addEventListener("click", toggle);
    workBellClose.addEventListener("click", closeWorkBellPanel);
  }

  return {
    bindToggle,
    closeWorkBellPanel,
    getMobileWorkBellButton: () => mobileWorkBellButton,
    isOpen: () => !workBellPanel.hidden,
    openWorkBellPanel,
    refreshWorkBell,
  };
}
