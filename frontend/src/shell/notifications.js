import { createCollectionLoader } from "../core/collection-loader.js";

export function createNotificationsShell({
  closeSettingsMenu,
  documentRef,
  encodeURIComponentImpl,
  formatShortDate,
  formatTaskDateMeta,
  HTMLElementClass,
  isoDayDistance,
  openTaskPanel,
  requestAnimationFrameImpl,
  request,
  todayIsoDate,
  workApiUrl,
  shell = globalThis.dakitShell,
}) {
  const workBellButton = documentRef.querySelector("#work-bell-button");
  const workBellCount = workBellButton?.querySelector(".work-bell-count");
  const workBellPanel = documentRef.querySelector("#work-bell-panel");
  const workBellBody = documentRef.querySelector("#work-bell-body");
  const readAll = documentRef.querySelector("#work-bell-read-all");
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
  let panelSnapshot = null;
  let lastAnnouncement = 0;
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
    return relative ? `Due ${formatShortDate(date)}` : "";
  }

  function compareNotificationsNewestFirst(left, right) {
    return (
      String(right?.createdAt || "").localeCompare(
        String(left?.createdAt || ""),
      ) || String(left?.id || "").localeCompare(String(right?.id || ""))
    );
  }

  function syncWorkBellIndicators() {
    const count = notificationState.items.filter(
      (item) => !locallyDismissedIds.has(item.id),
    ).length;
    shell.setCount(workBellCount, count);
    readAll.hidden = count === 0;
  }

  function closeWorkBellPanel(options = {}) {
    if (workBellPanel.hidden) return;
    shell.closePopovers(options);
    pendingDismissFocusId = "";
    panelRenderVersion += 1;
  }

  function openWorkBellPanel() {
    panelSnapshot = notificationState;
    renderWorkBellPanel();
    shell.openPopover("work-bell-panel", { trigger: workBellButton });
  }

  async function dismissWorkNotification(notification, button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
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
    const current = panelSnapshot || notificationState;
    workBellBody.replaceChildren();
    if (panelSnapshot && panelSnapshot !== notificationState) {
      const count = notificationState.items.filter(
        (item) =>
          !locallyDismissedIds.has(item.id) &&
          !panelSnapshot.items.some((previous) => previous.id === item.id),
      ).length;
      if (count > 0) {
        const show = documentRef.createElement("button");
        show.className = "dk-button dk-button--secondary";
        show.textContent = `${count} new · Show`;
        show.addEventListener("click", () => {
          panelSnapshot = notificationState;
          renderWorkBellPanel();
        });
        workBellBody.append(show);
      }
    }
    if (current.failed && notificationState.items.length === 0) {
      const error = documentRef.createElement("div");
      error.className = "dk-callout dk-callout--danger";
      error.setAttribute("role", "alert");
      error.textContent = "Couldn't load notifications.";
      const retry = documentRef.createElement("button");
      retry.className = "dk-button dk-button--secondary";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => retryInitialNotifications(retry));
      error.append(retry);
      workBellBody.append(error);
      return;
    }
    if (!current.loaded && !current.failed) {
      for (let i = 0; i < 3; i++) {
        const row = documentRef.createElement("div");
        row.className = "dk-skeleton";
        row.setAttribute("aria-label", "Loading notifications");
        workBellBody.append(row);
      }
      return;
    }
    const items = current.items
      .filter((item) => !locallyDismissedIds.has(item.id))
      .sort(compareNotificationsNewestFirst);
    if (!items.length && current.complete && !current.failed) {
      const empty = documentRef.createElement("div");
      empty.className = "dk-empty";
      empty.textContent = "Nothing yet.";
      workBellBody.append(empty);
    }
    let previousDay = "";
    for (const notification of items) {
      const date = String(notification.createdAt || "").slice(0, 10);
      const days = date ? isoDayDistance(date, todayIsoDate()) : 2;
      const day = days === 0 ? "Today" : days === -1 ? "Yesterday" : "Earlier";
      if (day !== previousDay) {
        const label = documentRef.createElement("div");
        label.className = "dk-notif-panel__day";
        label.textContent = day;
        workBellBody.append(label);
        previousDay = day;
      }
      const item = documentRef.createElement("div");
      item.className = "dk-notif-item";
      item.dataset.unread = "true";
      const marker = documentRef.createElement("span");
      marker.className = "dk-notif-item__marker";
      marker.innerHTML =
        '<span class="dk-dot dk-dot--info"></span><span class="dk-visually-hidden">Unread:</span>';
      const main = documentRef.createElement("div");
      main.className = "dk-notif-item__main";
      const link = documentRef.createElement("a");
      link.className = "dk-notif-item__link";
      link.href = notification.taskId
        ? `/tasks?taskId=${encodeURIComponentImpl(notification.taskId)}`
        : "/tasks";
      link.textContent = notificationDisplayMessage(notification);
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await dismissWorkNotification(notification, dismiss);
        if (dismissErrors.has(notification.id)) return;
        closeWorkBellPanel();
        if (notification.taskId) openTaskPanel(notification.taskId);
      });
      const meta = documentRef.createElement("p");
      meta.className = "dk-notif-item__desc";
      meta.textContent = notification.dueAt
        ? notificationDueLabel(notification.dueAt)
        : "Workspace update";
      main.append(link, meta);
      const side = documentRef.createElement("div");
      side.className = "dk-notif-item__side";
      const time = documentRef.createElement("time");
      time.className = "dk-notif-item__time";
      time.dateTime = notification.createdAt || "";
      time.title = notification.createdAt || "";
      const minutes = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(notification.createdAt)) / 60000),
      );
      time.textContent = Number.isFinite(minutes)
        ? minutes < 60
          ? `${minutes}m`
          : minutes < 1440
            ? `${Math.floor(minutes / 60)}h`
            : `${Math.floor(minutes / 1440)}d`
        : "";
      const dismiss = documentRef.createElement("button");
      dismiss.type = "button";
      dismiss.className = "dk-icon-button dk-notif-item__read";
      dismiss.dataset.dismissNotification = notification.id;
      dismiss.setAttribute("aria-label", `Mark read: ${link.textContent}`);
      dismiss.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      dismiss.addEventListener("click", () =>
        dismissWorkNotification(notification, dismiss),
      );
      side.append(time, dismiss);
      item.append(marker, main, side);
      const failure = dismissErrors.get(notification.id);
      if (failure) {
        const error = documentRef.createElement("p");
        error.className = "notification-error";
        error.setAttribute("role", "alert");
        error.textContent = `${failure} Mark read to retry.`;
        main.append(error);
      }
      workBellBody.append(item);
    }
    scheduleDismissRecoveryFocus(version);
    if (current.moreAvailable) {
      const continuation = documentRef.createElement("div");
      continuation.className = "notification-continuation";
      const more = documentRef.createElement("button");
      more.className = "dk-button dk-button--secondary";
      more.textContent = current.failed
        ? "Retry next page"
        : current.loadingMore
          ? "Loading…"
          : "Load more";
      more.disabled = current.loadingMore;
      more.dataset.loadNotifications = current.failed ? "retry" : "next";
      more.addEventListener("click", () => loadMoreNotifications(more));
      if (current.failed) {
        const error = documentRef.createElement("p");
        error.className = "notification-error";
        error.setAttribute("role", "alert");
        error.textContent = "Could not load more notifications. Try again.";
        continuation.append(error);
        requestAnimationFrameImpl(() => { if (!workBellPanel.hidden) more.focus(); });
      }
      continuation.append(more);
      workBellBody.append(continuation);
    }
  }

  async function loadMoreNotifications(button) {
    button.disabled = true;
    button.textContent = "Loading…";
    notificationState = await notificationLoader.loadMore();
    panelSnapshot = notificationState;
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
    panelSnapshot = notificationState;
    syncWorkBellIndicators();
    renderWorkBellPanel();
  }

  async function refreshWorkBell() {
    const snapshot = await notificationLoader.load();
    const previousIds = new Set(notificationState.items.map((item) => item.id));
    const newCount = snapshot.items.filter(
      (item) => !previousIds.has(item.id),
    ).length;
    notificationState = snapshot;
    if (panelSnapshot && !panelSnapshot.loaded) panelSnapshot = snapshot;
    if (newCount && Date.now() - lastAnnouncement >= 60000) {
      shell.announce(`${newCount} new notifications`);
      lastAnnouncement = Date.now();
    }
    // A read item stays read while a stale refresh response is in flight.
    syncWorkBellIndicators();
    if (!workBellPanel.hidden) renderWorkBellPanel();
  }

  function bindToggle() {
    // The shared delegated listener opens the panel after this app listener.
    workBellButton.addEventListener("click", () => {
      if (workBellPanel.hidden) {
        panelSnapshot = notificationState;
        renderWorkBellPanel();
      }
    });
    readAll.addEventListener("click", async () => {
      readAll.disabled = true;
      const items = notificationState.items.filter(
        (item) => !locallyDismissedIds.has(item.id),
      );
      for (const item of items) await dismissWorkNotification(item, readAll);
      readAll.disabled = false;
    });
  }

  return {
    bindToggle,
    closeWorkBellPanel,
    isOpen: () => !workBellPanel.hidden,
    openWorkBellPanel,
    refreshWorkBell,
  };
}
