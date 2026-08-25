import { setControlPending } from "../operations-overview.js";

const RECURRING_ICONS = Object.freeze({
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  cadence:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  owner:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.2"/><path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5"/></svg>',
  active:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9.5 12 1.8 1.8 3.4-3.6"/></svg>',
  paused:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9v6M14.5 9v6"/></svg>',
});

// The fake-DOM test harness does not parse innerHTML, and neither should the
// text of a control depend on it: icons are their own element, labels are text.
function iconElement(name) {
  const icon = document.createElement("span");
  icon.className = "recurring-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = RECURRING_ICONS[name];
  return icon;
}

export function createRecurringTasks(context) {
  const {
    confirmDialog,
    countLabel,
    getActiveWorkspaceRouteToken,
    isWorkspaceRouteFresh,
    openDocument,
    openQuickWorkflowForm,
    openRecurringForm,
    refreshOperationsRecurringSnapshot,
    request,
    resolveAssigneeLabel,
    scheduleAnimationFrame,
    todayIsoDate,
    workApiUrl,
  } = context;
  // Row-owned recovery text. A schedule that fails to delete, pause or resume
  // says so in its own row, next to the control that was used, instead of in a
  // toast that disappears before it can be acted on.
  const recurringRowErrors = new Map();

  function textSpan(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span;
  }

  function renderRecurringSurface(model) {
    const wrap = document.createElement("div");
    wrap.className = "ops-recurring-surface";
    const recurring = model?.recurring;

    wrap.append(renderRecurringToolbar());
    for (const message of recurring?.errors || []) {
      const error = document.createElement("p");
      error.className = "ops-inline-error";
      error.setAttribute("role", "alert");
      error.textContent = message;
      wrap.append(error);
    }
    wrap.append(
      renderRecurringSummary(recurring),
      renderRecurringOperationsSection(recurring),
    );
    return wrap;
  }

  function renderRecurringToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "recurring-toolbar";
    toolbar.setAttribute("aria-label", "Recurring actions");

    const create = document.createElement("button");
    create.type = "button";
    create.className = "recurring-action recurring-action-primary";
    create.append(iconElement("add"), textSpan("New schedule"));
    create.addEventListener("click", () => openRecurringForm());

    toolbar.append(create);
    return toolbar;
  }

  function renderRecurringSummary(recurring) {
    const summary = document.createElement("section");
    summary.className = "recurring-summary";
    summary.setAttribute("aria-label", "Recurring summary");
    const today = todayIsoDate();
    const configs = Array.isArray(recurring?.configs) ? recurring.configs : [];
    const dueToday = configs.filter(
      (config) => config.enabled !== false && config.nextRunDate === today,
    ).length;
    const stats = [
      { id: "active", label: "Active", value: recurring?.enabled?.length || 0 },
      {
        id: "paused",
        label: "Paused",
        value: recurring?.disabled?.length || 0,
      },
      { id: "today", label: "Runs today", value: dueToday },
    ];
    for (const stat of stats) {
      const item = document.createElement("div");
      item.className = `recurring-summary-item recurring-summary-${stat.id}`;
      item.dataset.state = recurring?.loaded ? "ready" : "unavailable";
      const label = document.createElement("span");
      label.className = "recurring-summary-label";
      label.textContent = stat.label;
      const value = document.createElement("strong");
      value.textContent = recurring?.loaded ? String(stat.value) : "—";
      if (!recurring?.loaded)
        value.setAttribute("aria-label", `${stat.label} unavailable`);
      item.append(label, value);
      summary.append(item);
    }
    return summary;
  }

  function renderRecurringOperationsSection(recurring, options = {}) {
    const section = document.createElement("section");
    section.className = "ops-section ops-recurring-section";
    section.setAttribute("aria-label", "Recurring operations");

    const all = Array.isArray(recurring?.configs) ? recurring.configs : [];
    const configs = options.limit ? all.slice(0, options.limit) : all;

    const header = document.createElement("header");
    header.className = "recurring-section-header";
    const title = document.createElement("h3");
    title.textContent = "Schedules";
    const meta = document.createElement("span");
    meta.textContent = recurring?.loaded
      ? countLabel(configs.length, "schedule")
      : "Not loaded";
    header.append(title, meta);
    section.append(header);

    const list = document.createElement("ul");
    list.className = "ops-recurring-list";
    if (configs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ops-empty";
      empty.textContent = recurring?.errors?.length
        ? "Recurring configs could not be loaded."
        : "No recurring configs yet.";
      section.append(empty);
    } else {
      for (const config of configs)
        list.append(renderRecurringConfigItem(config));
      section.append(list);
    }

    const footer = document.createElement("footer");
    footer.className = "recurring-section-footer";
    footer.textContent =
      "Active schedules create their task on every matching day, during the daily 08:00 UTC run.";
    section.append(footer);
    return section;
  }

  function renderRecurringConfigItem(config) {
    const item = document.createElement("li");
    item.className = "ops-recurring-item";
    const paused = config.enabled === false;
    if (paused) item.classList.add("is-paused");

    const status = document.createElement("span");
    status.className = "recurring-status";
    status.append(iconElement(paused ? "paused" : "active"));
    const statusText = textSpan(paused ? "Paused" : "Active");
    statusText.className = "visually-hidden";
    status.append(statusText);
    status.title = statusText.textContent;

    const text = document.createElement("div");
    text.className = "recurring-item-text";
    const title = document.createElement("strong");
    title.textContent = recurringConfigTitle(config);
    text.append(title);

    const facts = document.createElement("div");
    facts.className = "recurring-item-facts";
    const owner = config.assigneeId
      ? resolveAssigneeLabel?.(config.assigneeId)
      : "";
    const facted = [
      ["cadence", config.scheduleLabel || config.cronExpression || ""],
      [
        "next",
        paused
          ? "Paused - no tasks generated"
          : config.nextRunLabel
            ? `Next ${config.nextRunLabel}`
            : "",
      ],
      ["owner", owner && owner !== "—" ? owner : "Unassigned"],
    ];
    for (const [icon, value] of facted) {
      if (!value) continue;
      const fact = document.createElement("span");
      fact.className = `recurring-fact recurring-fact-${icon}`;
      fact.append(iconElement(icon), textSpan(value));
      facts.append(fact);
    }
    text.append(facts);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "task-action-btn";
    edit.textContent = "Edit";
    edit.setAttribute(
      "aria-label",
      `Edit recurring schedule ${recurringConfigTitle(config)}`,
    );
    edit.addEventListener("click", () => openRecurringForm({ config }));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-action-btn";
    toggle.textContent = paused ? "Resume" : "Pause";
    toggle.setAttribute(
      "aria-label",
      `${paused ? "Resume" : "Pause"} recurring schedule ${recurringConfigTitle(config)}`,
    );
    toggle.addEventListener("click", () =>
      toggleRecurringConfig(config.id, paused, toggle),
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-action-btn danger-text-button";
    remove.textContent = "Delete";
    remove.setAttribute(
      "aria-label",
      `Delete recurring schedule ${recurringConfigTitle(config)}`,
    );
    remove.addEventListener("click", () =>
      deleteRecurringConfigFromUi(config, remove),
    );

    const actions = document.createElement("div");
    actions.className = "recurring-row-actions";
    actions.append(edit, toggle, remove);
    item.append(status, text, actions);
    const error = recurringRowErrors.get(config.id);
    if (error) {
      const guidance = document.createElement("p");
      guidance.className = "recurring-row-error recurring-delete-guidance";
      guidance.setAttribute("role", "alert");
      guidance.tabIndex = -1;
      guidance.textContent = error;
      item.append(guidance);
    }
    return item;
  }

  async function deleteRecurringConfigFromUi(config, button) {
    const confirmed = await confirmDialog(
      `Delete recurring schedule “${recurringConfigTitle(config)}”? This removes only the schedule. Tasks already generated from it are never deleted.`,
      { okText: "Delete schedule", danger: true },
    );
    if (!confirmed) return;
    const routeToken = getActiveWorkspaceRouteToken();
    setControlPending(button, { pending: true, pendingLabel: "Deleting…" });
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(config.id)}`),
        { method: "DELETE" },
      );
      recurringRowErrors.delete(config.id);
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshOperationsRecurringSnapshot({ rerender: false });
        return;
      }
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (error) {
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshOperationsRecurringSnapshot({ rerender: false });
        return;
      }
      const message =
        error.status === 409
          ? "This schedule has generated history and cannot be deleted. Pause it instead; generated tasks and notifications are preserved."
          : `${error.message || "Could not delete this schedule"} Select Delete schedule to retry.`;
      recurringRowErrors.set(config.id, message);
      await refreshOperationsRecurringSnapshot({ rerender: true });
      scheduleAnimationFrame(() =>
        document
          .querySelector(".recurring-row-error[role='alert']")
          ?.focus(),
      );
    }
  }

  function renderWorkflowTemplateCard(template) {
    const card = document.createElement("article");
    card.className = "ops-template-card";

    const title = document.createElement("strong");
    title.textContent = template.title;
    const summary = document.createElement("span");
    summary.textContent = template.summary;
    const chips = document.createElement("div");
    chips.className = "ops-card-chips";
    const chipValues = [
      template.recurring ? "Recurring" : "Manual",
      template.atRisk ? "Watch" : "",
      ...template.tags.slice(0, 2),
    ].filter(Boolean);
    for (const value of chipValues) {
      const chip = document.createElement("small");
      chip.textContent = value;
      chips.append(chip);
    }

    const actions = document.createElement("div");
    actions.className = "ops-template-actions";
    const start = document.createElement("button");
    start.type = "button";
    start.className = "task-action-btn is-primary";
    start.textContent = "Create card";
    start.addEventListener("click", () => openQuickWorkflowForm({ template }));
    const docs = document.createElement("button");
    docs.type = "button";
    docs.className = "task-action-btn";
    docs.textContent = "View process doc";
    docs.addEventListener("click", () => openDocument(template.path));
    actions.append(start, docs);

    card.append(title, summary, chips, actions);
    return card;
  }

  async function toggleRecurringConfig(configId, enabled, button) {
    const originalText = button?.textContent || (enabled ? "Resume" : "Pause");
    const routeToken = getActiveWorkspaceRouteToken();
    setControlPending(button, {
      pending: true,
      pendingLabel: enabled ? "Resuming…" : "Pausing…",
    });
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(configId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        },
      );
      recurringRowErrors.delete(configId);
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshOperationsRecurringSnapshot({ rerender: false });
        return;
      }
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (err) {
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshOperationsRecurringSnapshot({ rerender: false });
        return;
      }
      // The refreshed snapshot is authoritative: the row is re-rendered from
      // the server state and carries the failure with its own retry control.
      recurringRowErrors.set(
        configId,
        `Could not ${enabled ? "resume" : "pause"} this schedule: ${err.message || "request failed"} Select ${originalText} to retry.`,
      );
      setControlPending(button, { pending: false, label: originalText });
      await refreshOperationsRecurringSnapshot({ rerender: true });
      scheduleAnimationFrame(() =>
        document
          .querySelector(".recurring-row-error[role='alert']")
          ?.focus(),
      );
    }
  }

  function recurringConfigTitle(config) {
    return String(
      config?.description ||
        config?.name ||
        config?.id ||
        "Recurring operation",
    );
  }

  return {
    recurringConfigTitle,
    renderRecurringOperationsSection,
    renderRecurringSurface,
    renderWorkflowTemplateCard,
  };
}
