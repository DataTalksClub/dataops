export function createRecurringTasks(context) {
  const {
    confirmDialog,
    countLabel,
    openDocument,
    openQuickWorkflowForm,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    reportError,
    request,
    scheduleAnimationFrame,
    todayIsoDate,
    workApiUrl,
  } = context;
  const recurringDeleteErrors = new Map();

  function renderRecurringOperationsSection(recurring) {
    const section = document.createElement("section");
    section.className = "ops-section ops-recurring-section";
    section.setAttribute("aria-label", "Recurring operations");

    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Recurring Operations";
    const meta = document.createElement("span");
    const enabled = recurring?.enabled?.length || 0;
    const paused = recurring?.disabled?.length || 0;
    meta.textContent = recurring?.loaded
      ? `${enabled} enabled - ${paused} paused`
      : "Not loaded";
    header.append(title, meta);

    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "ops-quick-btn";
    generate.textContent = "Generate today";
    generate.addEventListener("click", () =>
      generateRecurringTasksForToday(generate),
    );
    header.append(generate);
    section.append(header);

    const list = document.createElement("div");
    list.className = "ops-recurring-list";
    const configs = Array.isArray(recurring?.configs)
      ? recurring.configs.slice(0, 6)
      : [];
    if (configs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ops-empty";
      empty.textContent = recurring?.errors?.length
        ? "Recurring configs could not be loaded."
        : "No recurring configs yet.";
      list.append(empty);
    } else {
      for (const config of configs)
        list.append(renderRecurringConfigItem(config));
    }
    section.append(list);
    return section;
  }

  function renderRecurringConfigItem(config) {
    const item = document.createElement("div");
    item.className = "ops-recurring-item";
    if (config.enabled === false) item.classList.add("is-paused");

    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = recurringConfigTitle(config);
    const meta = document.createElement("span");
    meta.textContent = formatRecurringSchedule(config.cronExpression || "");
    text.append(title, meta);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-action-btn";
    toggle.textContent = config.enabled === false ? "Resume" : "Pause";
    toggle.addEventListener("click", () =>
      toggleRecurringConfig(config.id, config.enabled === false, toggle),
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-action-btn danger-button";
    remove.textContent = "Delete schedule";
    remove.setAttribute(
      "aria-label",
      `Delete recurring schedule ${recurringConfigTitle(config)}`,
    );
    remove.addEventListener("click", () =>
      deleteRecurringConfigFromUi(config, remove),
    );

    const actions = document.createElement("div");
    actions.className = "recurring-row-actions";
    actions.append(toggle, remove);
    item.append(text, actions);
    const error = recurringDeleteErrors.get(config.id);
    if (error) {
      const guidance = document.createElement("p");
      guidance.className = "recurring-delete-guidance";
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
    button.disabled = true;
    button.textContent = "Deleting…";
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(config.id)}`),
        { method: "DELETE" },
      );
      recurringDeleteErrors.delete(config.id);
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (error) {
      const message =
        error.status === 409
          ? "This schedule has generated history and cannot be deleted. Pause it instead; generated tasks and notifications are preserved."
          : `${error.message || "Could not delete this schedule"} Select Delete schedule to retry.`;
      recurringDeleteErrors.set(config.id, message);
      await refreshOperationsRecurringSnapshot({ rerender: true });
      scheduleAnimationFrame(() =>
        document
          .querySelector(".recurring-delete-guidance[role='alert']")
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

  async function generateRecurringTasksForToday(button) {
    const originalText = button?.textContent || "Generate today";
    if (button) {
      button.disabled = true;
      button.textContent = "Generating...";
    }
    const today = todayIsoDate();
    try {
      await request(workApiUrl("/api/recurring/generate"), {
        method: "POST",
        body: JSON.stringify({ startDate: today, endDate: today }),
      });
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (err) {
      reportError(
        `Could not generate recurring tasks: ${err.message || "request failed"}`,
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function toggleRecurringConfig(configId, enabled, button) {
    const originalText = button?.textContent || (enabled ? "Resume" : "Pause");
    if (button) {
      button.disabled = true;
      button.textContent = enabled ? "Resuming..." : "Pausing...";
    }
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(configId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        },
      );
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (err) {
      reportError(
        `Could not update recurring operation: ${err.message || "request failed"}`,
      );
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
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

  function formatRecurringSchedule(cronExpression) {
    const parts = String(cronExpression || "")
      .trim()
      .split(/\s+/);
    if (parts.length !== 5) return cronExpression || "No schedule";
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (month !== "*") return cronExpression;
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${time}`;
    if (dayOfMonth === "*" && dayOfWeek !== "*")
      return `Weekly on ${weekdayName(dayOfWeek)} at ${time}`;
    if (dayOfMonth !== "*" && dayOfWeek === "*")
      return `Monthly on day ${dayOfMonth} at ${time}`;
    return cronExpression;
  }

  function weekdayName(value) {
    const names = {
      0: "Sunday",
      1: "Monday",
      2: "Tuesday",
      3: "Wednesday",
      4: "Thursday",
      5: "Friday",
      6: "Saturday",
    };
    return names[String(value)] || value;
  }

  return {
    recurringConfigTitle,
    renderRecurringOperationsSection,
    renderWorkflowTemplateCard,
  };
}
