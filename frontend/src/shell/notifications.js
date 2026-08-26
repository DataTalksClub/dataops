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
  let notifications = [];
  let notificationError = "";
  const dismissErrors = new Map();
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

  function syncWorkBellIndicators() {
    const count = notifications.length;
    const indicatorText = notificationError ? "!" : String(count);
    for (const indicator of [workBellCount, mobileWorkBellCount]) {
      if (!indicator) continue;
      indicator.textContent = indicatorText;
      indicator.classList.toggle(
        "is-visible",
        Boolean(notificationError) || count > 0,
      );
      indicator.classList.toggle("is-error", Boolean(notificationError));
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
      notifications = notifications.filter(
        (item) => item.id !== notification.id,
      );
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
    if (notificationError) {
      const empty = documentRef.createElement("p");
      empty.className = "work-bell-empty is-error";
      empty.textContent = `Notifications unavailable: ${notificationError}`;
      workBellBody.append(empty);
      return;
    }
    if (notifications.length === 0) {
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
      return;
    }
    for (const notification of notifications) {
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
      !notifications.some((item) => item.id === pendingDismissFocusId)
    ) {
      pendingDismissFocusId = "";
    }
    scheduleDismissRecoveryFocus(version);
  }

  async function refreshWorkBell(options = {}) {
    try {
      const payload = await request(workApiUrl("/api/notifications"));
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      notifications = Array.isArray(payload)
        ? payload
        : payload.notifications || [];
      notificationError = "";
    } catch (error) {
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      notifications = [];
      notificationError =
        error?.message || "Notifications API request failed";
    }
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
