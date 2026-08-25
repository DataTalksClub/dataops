import {
  createFormFeedback,
  reportFieldValidation,
  setControlPending,
} from "../operations-overview.js";

const QUICK_FORM_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let quickFormTitleSequence = 0;

export function createQuickTaskActions(context) {
  const {
    describeRecurringRun,
    getActiveWorkspaceRouteToken,
    isWorkspaceRouteFresh,
    openCardPanel,
    openTaskPanel,
    refreshDocuments,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    request,
    shellBody,
    state,
    todayIsoDate,
    workApiUrl,
  } = context;

  function addConflictReviewAction(feedback, label, onReview) {
    for (const stale of feedback.node.querySelectorAll(".quick-form-retry"))
      stale.remove();
    const review = document.createElement("button");
    review.type = "button";
    review.className = "quiet-button quick-form-retry";
    review.textContent = label;
    review.addEventListener("click", onReview);
    feedback.node.append(review);
  }

  function openQuickTaskForm() {
    const overlay = createQuickFormOverlay("New task");
    const form = document.createElement("form");
    form.className = "quick-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const descInput = createQuickInput("What needs doing?", "text", "");
    const dateInput = createQuickInput("Due date", "date", todayIsoDate());
    const feedback = createFormFeedback();

    const createBtn = document.createElement("button");
    createBtn.type = "submit";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create task";
    let taskSubmitInFlight = false;
    const submitTask = async () => {
      // Implicit form submission can still occur while the visual submit
      // button is disabled, so the operation owns its own duplicate guard.
      if (taskSubmitInFlight) return;
      const description = descInput.input.value.trim();
      const date = dateInput.input.value;
      const invalid = reportFieldValidation([
        [descInput, description ? "" : "Task description is required."],
        [dateInput, date ? "" : "Due date is required."],
      ]);
      if (invalid) {
        feedback.clear();
        return;
      }
      taskSubmitInFlight = true;
      setControlPending(createBtn, {
        pending: true,
        pendingLabel: "Creating task…",
      });
      feedback.pending("Creating task…");
      const routeToken = getActiveWorkspaceRouteToken();
      try {
        const created = await request(workApiUrl("/api/tasks"), {
          method: "POST",
          body: JSON.stringify({ description, date }),
        });
        overlay.close();
        const task = created?.task || created;
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshOperationsWorkSnapshot({ rerender: false });
          return;
        }
        if (task?.id) openTaskPanel(task.id);
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        if (!isWorkspaceRouteFresh(routeToken)) {
          overlay.close();
          return;
        }
        if (err.status === 409) {
          feedback
            .conflict(
              `The work API reported a conflict while creating this Task: ${err.message || "conflict"}` +
                ` The entries in this draft are retained. Select Create task to retry,` +
                ` Close to discard this draft, or Review current work to reload the queue.`,
            )
            .focus();
          addConflictReviewAction(
            feedback,
            "Review current work",
            async () => {
              overlay.close();
              await refreshOperationsWorkSnapshot({ rerender: true });
            },
          );
        } else {
          feedback
            .failure(
              `Could not create task: ${err.message || "request failed"} Select Create task to retry.`,
            )
            .focus();
        }
        setControlPending(createBtn, { pending: false, label: "Create task" });
      } finally {
        taskSubmitInFlight = false;
      }
    };
    form.addEventListener("submit", submitTask);

    form.append(descInput.label, dateInput.label, feedback.node, createBtn);
    overlay.querySelector(".quick-form-body").append(form);
    descInput.input.focus();
    descInput.input.focus();
  }

  async function openQuickWorkflowForm(options = {}) {
    const requestedTemplate = options.template || null;
    const overlay = createQuickFormOverlay("Create card");
    const form = document.createElement("form");
    form.className = "quick-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const selectLabel = document.createElement("label");
    selectLabel.className = "quick-form-label";
    selectLabel.textContent = "Template";
    const templateSelect = document.createElement("select");
    templateSelect.className = "quick-form-select";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading templates...";
    templateSelect.append(loadingOpt);
    templateSelect.disabled = true;
    selectLabel.append(templateSelect);

    const anchorInput = createQuickInput(
      "Anchor date",
      "date",
      options.anchorDate || todayIsoDate(),
    );
    const titleInput = createQuickInput(
      "Card title (optional)",
      "text",
      options.title || "",
    );
    const templateControl = { label: selectLabel, input: templateSelect };
    const templateState = document.createElement("p");
    templateState.className = "quick-form-state";
    templateState.setAttribute("role", "status");
    templateState.setAttribute("aria-live", "polite");
    templateState.textContent = "Loading templates…";
    const feedback = createFormFeedback();

    const createBtn = document.createElement("button");
    createBtn.type = "submit";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create card";
    createBtn.disabled = true;
    let cardSubmitInFlight = false;

    form.append(
      selectLabel,
      templateState,
      titleInput.label,
      anchorInput.label,
      feedback.node,
      createBtn,
    );
    overlay.querySelector(".quick-form-body").append(form);
    titleInput.input.focus();
    titleInput.input.focus();

    // Fetch live templates from the backend API (UUIDs, not doc slugs)
    let liveTemplates = [];
    try {
      const payload = await request(workApiUrl("/api/templates"));
      liveTemplates = Array.isArray(payload)
        ? payload
        : payload.templates || [];
    } catch (error) {
      templateSelect.replaceChildren();
      const unavailable = document.createElement("option");
      unavailable.value = "";
      unavailable.textContent = "Templates unavailable";
      templateSelect.append(unavailable);
      templateSelect.disabled = true;
      createBtn.disabled = true;
      // The form stays open and offers its own recovery: a card cannot be
      // created without templates, but the operator does not lose the dialog.
      feedback
        .failure(
          `Templates could not be loaded: ${error.message || "request failed"}`,
        )
        .focus();
      templateState.textContent = "No templates are available to select.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button quick-form-retry";
      retry.textContent = "Retry loading templates";
      retry.addEventListener("click", () => {
        overlay.close();
        openQuickWorkflowForm(options);
      });
      feedback.node.append(retry);
      return;
    }

    templateSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select template...";
    templateSelect.append(placeholder);
    for (const template of liveTemplates) {
      const opt = document.createElement("option");
      opt.value = template.id;
      opt.textContent = template.name || template.title || template.id;
      templateSelect.append(opt);
    }
    const matchedTemplate = findLiveWorkflowTemplate(
      liveTemplates,
      requestedTemplate,
    );
    if (matchedTemplate?.id) {
      templateSelect.value = matchedTemplate.id;
      if (!titleInput.input.value && requestedTemplate?.title)
        titleInput.input.value = requestedTemplate.title;
    }
    templateSelect.disabled = false;
    templateState.textContent =
      liveTemplates.length > 0
        ? `${liveTemplates.length} ${liveTemplates.length === 1 ? "template" : "templates"} available.`
        : "No templates are deployed, so no card can be created yet.";
    if (liveTemplates.length > 0) createBtn.disabled = false;
    else {
      const emptyOpt = document.createElement("option");
      emptyOpt.textContent = "No templates available";
      templateSelect.append(emptyOpt);
      templateSelect.disabled = true;
    }

    const submitCard = async () => {
      if (cardSubmitInFlight) return;
      const templateId = templateSelect.value;
      const anchorDate = anchorInput.input.value;
      const invalid = reportFieldValidation([
        [templateControl, templateId ? "" : "Select a template."],
        [anchorInput, anchorDate ? "" : "Anchor date is required."],
      ]);
      if (invalid) {
        feedback.clear();
        return;
      }
      cardSubmitInFlight = true;
      setControlPending(createBtn, {
        pending: true,
        pendingLabel: "Creating card…",
      });
      feedback.pending("Creating card…");
      const routeToken = getActiveWorkspaceRouteToken();
      try {
        const body = { templateId, anchorDate };
        const title = titleInput.input.value.trim();
        if (title) body.title = title;
        const result = await request(workApiUrl("/api/cards"), {
          method: "POST",
          body: JSON.stringify(body),
        });
        const card = result?.card || result;
        overlay.close();
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshOperationsWorkSnapshot({ rerender: false });
          return;
        }
        if (card?.id) openCardPanel(card.id);
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        if (!isWorkspaceRouteFresh(routeToken)) {
          overlay.close();
          return;
        }
        if (err.status === 409 || err.code === "template_version_conflict") {
          feedback
            .conflict(
              `The Template changed since this form was opened: ${err.message || "version conflict"}` +
                ` The entries in this draft are retained. Select Create card to retry,` +
                ` Close to discard this draft, or Review latest Templates to load the current list.`,
            )
            .focus();
          addConflictReviewAction(
            feedback,
            "Review latest Templates",
            () => {
              const selectedTemplate =
                liveTemplates.find((template) => template.id === templateId) ||
                requestedTemplate;
              options.template = selectedTemplate;
              options.title = titleInput.input.value;
              options.anchorDate = anchorDate;
              overlay.close();
              openQuickWorkflowForm(options);
            },
          );
        } else {
          feedback
            .failure(
              `Could not create card: ${err.message || "request failed"} Select Create card to retry.`,
            )
            .focus();
        }
        setControlPending(createBtn, { pending: false, label: "Create card" });
      } finally {
        cardSubmitInFlight = false;
      }
    };
    form.addEventListener("submit", submitCard);
  }

  function findLiveWorkflowTemplate(liveTemplates, requestedTemplate) {
    if (!requestedTemplate || !Array.isArray(liveTemplates)) return null;
    const wantedId = normalizeTemplateMatchValue(
      requestedTemplate.templateId ||
        requestedTemplate.sourceTemplateId ||
        requestedTemplate.canonicalTemplateId,
    );
    if (wantedId) {
      const idMatches = liveTemplates.filter(
        (template) => normalizeTemplateMatchValue(template.id) === wantedId,
      );
      return idMatches.length === 1 ? idMatches[0] : null;
    }

    const wantedSlug = normalizeTemplateMatchValue(
      requestedTemplate.slug || requestedTemplate.type,
    );
    if (!wantedSlug) return null;
    const slugMatches = liveTemplates.filter((template) => {
      const templateSlug = normalizeTemplateMatchValue(
        template.slug || template.type,
      );
      return templateSlug === wantedSlug;
    });
    return slugMatches.length === 1 ? slugMatches[0] : null;
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

  function openRecurringForm(options = {}) {
    const config = options.config || null;
    const editing = Boolean(config?.id);
    const preset = recurringFormPreset(config);
    const overlay = createQuickFormOverlay(
      editing ? "Edit recurring schedule" : "New recurring schedule",
    );
    const form = document.createElement("form");
    form.className = "quick-form recurring-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const intro = document.createElement("p");
    intro.className = "recurring-form-intro";
    intro.textContent =
      "A schedule creates one task on every day it matches. The time is a label for the team, not the moment it runs.";

    const description = createQuickInput(
      "Description",
      "text",
      preset.description,
    );
    description.label.classList.add("recurring-form-wide");
    description.input.placeholder = "What should be done each time?";

    const repeat = createQuickSelect(
      "Repeats",
      [
        ["daily", "Every day"],
        ["weekly", "Every week"],
        ["monthly", "Every month"],
        ["custom", "Custom cron"],
      ],
      preset.schedule,
    );
    repeat.input.value = preset.schedule;
    const timeInput = createQuickInput("Time", "time", preset.time);
    const weekday = createQuickSelect(
      "Weekday",
      [
        ["1", "Monday"],
        ["2", "Tuesday"],
        ["3", "Wednesday"],
        ["4", "Thursday"],
        ["5", "Friday"],
        ["6", "Saturday"],
        ["0", "Sunday"],
      ],
      preset.weekday,
    );
    weekday.input.value = preset.weekday;
    const monthDay = createQuickInput(
      "Day of month",
      "number",
      preset.monthDay,
    );
    monthDay.input.min = "1";
    monthDay.input.max = "31";
    const cronInput = createQuickInput(
      "Cron expression",
      "text",
      preset.cronExpression,
    );
    cronInput.label.classList.add("recurring-form-wide");
    cronInput.input.placeholder = "minute hour day-of-month month day-of-week";

    const assignee = createQuickSelect(
      "Assignee",
      recurringAssigneeOptions(preset.assigneeId),
      preset.assigneeId,
    );
    assignee.input.value = preset.assigneeId;
    const enabled = createQuickCheckbox(
      editing ? "Active" : "Activate immediately",
      preset.enabled,
    );
    enabled.label.classList.add("recurring-form-wide");

    const cadence = document.createElement("div");
    cadence.className = "recurring-form-grid";
    cadence.append(
      repeat.label,
      timeInput.label,
      weekday.label,
      monthDay.label,
      cronInput.label,
    );

    const preview = document.createElement("p");
    preview.className = "recurring-form-preview";
    preview.setAttribute("aria-live", "polite");

    const currentCron = () =>
      repeat.input.value === "custom"
        ? String(cronInput.input.value || "")
            .trim()
            .replace(/\s+/g, " ")
        : buildRecurringCron(
            repeat.input.value,
            timeInput.input.value,
            weekday.input.value,
            monthDay.input.value,
          );

    const syncForm = () => {
      const mode = repeat.input.value;
      weekday.label.hidden = mode !== "weekly";
      monthDay.label.hidden = mode !== "monthly";
      timeInput.label.hidden = mode === "custom";
      cronInput.label.hidden = mode !== "custom";
      const run = describeRecurringRun(currentCron(), todayIsoDate());
      preview.textContent = run.nextDate
        ? `${run.summary} - next task ${run.nextLabel}`
        : run.summary || "Choose a schedule.";
    };
    for (const control of [
      repeat.input,
      timeInput.input,
      weekday.input,
      monthDay.input,
      cronInput.input,
    ]) {
      control.addEventListener("change", syncForm);
      control.addEventListener("input", syncForm);
    }
    syncForm();

    const feedback = createFormFeedback();
    feedback.node.classList.add("recurring-form-feedback");
    const failForm = (message) => {
      feedback.failure(message).focus();
    };

    const submitLabel = editing ? "Save schedule" : "Create schedule";
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "primary-button";
    submitBtn.textContent = submitLabel;
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "quiet-button";
    cancelBtn.textContent = "Cancel";
    let reloadScheduleOnCancel = false;
    cancelBtn.addEventListener("click", async () => {
      if (!reloadScheduleOnCancel) {
        overlay.close();
        return;
      }
      const routeToken = getActiveWorkspaceRouteToken();
      overlay.close();
      await refreshOperationsRecurringSnapshot({ rerender: false });
      if (isWorkspaceRouteFresh(routeToken)) refreshDocuments();
    });
    const footer = document.createElement("div");
    footer.className = "recurring-form-footer";
    footer.append(cancelBtn, submitBtn);

    let scheduleSubmitInFlight = false;
    const submitSchedule = async () => {
      if (scheduleSubmitInFlight) return;
      const descriptionValue = description.input.value.trim();
      const cronExpression = currentCron();
      const cronComplete =
        Boolean(cronExpression) && cronExpression.split(" ").length === 5;
      const cronField = repeat.input.value === "custom" ? cronInput : repeat;
      const invalid = reportFieldValidation([
        [description, descriptionValue ? "" : "Recurring description is required."],
        [cronField, cronComplete ? "" : "Cron expression needs five fields."],
      ]);
      if (invalid) {
        feedback.clear();
        return;
      }
      const body = {
        description: descriptionValue,
        cronExpression,
        enabled: enabled.input.checked,
      };
      const assigneeId = assignee.input.value;
      if (assigneeId || preset.assigneeId) body.assigneeId = assigneeId;
      scheduleSubmitInFlight = true;
      setControlPending(submitBtn, {
        pending: true,
        pendingLabel: editing ? "Saving schedule…" : "Creating schedule…",
      });
      feedback.pending(editing ? "Saving schedule…" : "Creating schedule…");
      const routeToken = getActiveWorkspaceRouteToken();
      try {
        await request(
          workApiUrl(
            editing
              ? `/api/recurring/${encodeURIComponent(config.id)}`
              : "/api/recurring",
          ),
          {
            method: editing ? "PUT" : "POST",
            body: JSON.stringify(body),
          },
        );
        overlay.close();
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshOperationsRecurringSnapshot({ rerender: false });
          return;
        }
        await refreshOperationsRecurringSnapshot({ rerender: true });
      } catch (err) {
        if (!isWorkspaceRouteFresh(routeToken)) {
          overlay.close();
          return;
        }
        // A conflict keeps the entered schedule and says what changed under it;
        // any other failure is retryable with the same values.
        const conflict =
          `This schedule changed since the form was opened: ${err.message || "version conflict"}` +
          ` Your values are kept. Select Cancel to discard this draft and reload schedules,` +
          ` or ${submitLabel} to apply them anyway.`;
        const failure =
          `Could not ${editing ? "save" : "create"} recurring schedule:` +
          ` ${err.message || "request failed"} Select ${submitLabel} to retry.`;
        reloadScheduleOnCancel = err.status === 409;
        if (err.status === 409) {
          feedback.conflict(conflict).focus();
        } else {
          failForm(failure);
        }
        setControlPending(submitBtn, { pending: false, label: submitLabel });
      } finally {
        scheduleSubmitInFlight = false;
      }
    };
    form.addEventListener("submit", submitSchedule);

    form.append(
      intro,
      description.label,
      cadence,
      preview,
      assignee.label,
      enabled.label,
      feedback.node,
      footer,
    );
    overlay.querySelector(".quick-form-body").append(form);
    description.input.focus();
    return overlay;
  }

  // Owners come from the loaded work snapshot so the picker shows names, never
  // raw ids. An id with no matching user stays selectable so editing a config
  // never silently reassigns it.
  function recurringAssigneeOptions(selectedId) {
    const users = Array.isArray(state?.workSnapshot?.users)
      ? state.workSnapshot.users
      : [];
    const options = [["", "Unassigned"]];
    for (const user of users) {
      if (!user?.id) continue;
      options.push([
        String(user.id),
        user.name || user.email || String(user.id),
      ]);
    }
    if (selectedId && !options.some(([value]) => value === selectedId)) {
      options.push([selectedId, `Unknown user (${selectedId})`]);
    }
    return options;
  }

  function buildRecurringCron(schedule, timeValue, weekday, dayOfMonth) {
    const time = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
    if (!time) return "";
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
    if (schedule === "daily") return `${minute} ${hour} * * *`;
    if (schedule === "weekly") {
      const day = Number(weekday);
      if (!Number.isInteger(day) || day < 0 || day > 6) return "";
      return `${minute} ${hour} * * ${day}`;
    }
    if (schedule === "monthly") {
      const day = Number(dayOfMonth);
      if (!Number.isInteger(day) || day < 1 || day > 31) return "";
      return `${minute} ${hour} ${day} * *`;
    }
    return "";
  }

  // Recurring configs are stored as cron. Map the common shapes back onto the
  // form controls and fall back to the raw expression for anything else.
  function recurringFormPreset(config) {
    const preset = {
      description: String(config?.description || config?.name || ""),
      assigneeId: String(config?.assigneeId || ""),
      enabled: config ? config.enabled !== false : true,
      schedule: "daily",
      time: "09:00",
      weekday: "1",
      monthDay: "1",
      cronExpression: String(config?.cronExpression || ""),
    };
    const parts = preset.cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return preset;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const numeric = (value) => /^\d+$/.test(value);
    if (!numeric(minute) || !numeric(hour) || month !== "*") {
      preset.schedule = "custom";
      return preset;
    }
    preset.time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (dayOfMonth === "*" && dayOfWeek === "*") preset.schedule = "daily";
    else if (dayOfMonth === "*" && numeric(dayOfWeek)) {
      preset.schedule = "weekly";
      preset.weekday = dayOfWeek;
    } else if (numeric(dayOfMonth) && dayOfWeek === "*") {
      preset.schedule = "monthly";
      preset.monthDay = dayOfMonth;
    } else preset.schedule = "custom";
    return preset;
  }

  function createQuickInput(labelText, type, value) {
    const label = document.createElement("label");
    label.className = "quick-form-label";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    label.append(input);
    return { label, input };
  }

  function createQuickSelect(labelText, options, value) {
    const label = document.createElement("label");
    label.className = "quick-form-label";
    label.textContent = labelText;
    const input = document.createElement("select");
    input.className = "quick-form-select";
    for (const [optionValue, optionLabel] of options) {
      const opt = document.createElement("option");
      opt.value = optionValue;
      opt.textContent = optionLabel;
      if (optionValue === value) opt.selected = true;
      input.append(opt);
    }
    label.append(input);
    return { label, input };
  }

  function createQuickCheckbox(labelText, checked) {
    const label = document.createElement("label");
    label.className = "quick-form-label quick-form-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    label.append(input, document.createTextNode(labelText));
    return { label, input };
  }

  function createQuickFormOverlay(titleText) {
    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "quick-form-overlay confirm-modal";
    overlay.hidden = false;
    let closed = false;
    overlay.close = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      if (
        opener &&
        opener.isConnected !== false &&
        typeof opener.focus === "function"
      ) {
        opener.focus();
      }
    };

    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";
    backdrop.addEventListener("click", () => overlay.close());

    const panel = document.createElement("div");
    panel.className = "confirm-panel quick-form-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const titleId = `quick-form-title-${++quickFormTitleSequence}`;
    panel.setAttribute("aria-labelledby", titleId);

    const header = document.createElement("div");
    header.className = "diff-header";
    const title = document.createElement("strong");
    title.setAttribute("id", titleId);
    title.textContent = titleText;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "quiet-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.close());
    header.append(title, closeBtn);

    const body = document.createElement("div");
    body.className = "quick-form-body";

    panel.append(header, body);
    overlay.append(backdrop, panel);
    overlay.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        overlay.close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = [...panel.querySelectorAll(QUICK_FORM_FOCUSABLE_SELECTOR)]
        .filter(isQuickFormFocusable);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables.at(-1);
      const active = document.activeElement;
      const activeInside = isQuickFormDescendant(panel, active);
      if (event.shiftKey && (active === first || !activeInside)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !activeInside)
      ) {
        event.preventDefault();
        first.focus();
      }
    });
    shellBody.append(overlay);
    return overlay;
  }

  function isQuickFormFocusable(element) {
    if (element.disabled || element.hidden) return false;
    let ancestor = element.parentElement;
    while (ancestor) {
      if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true")
        return false;
      ancestor = ancestor.parentElement;
    }
    return (
      typeof element.offsetParent === "undefined" ||
      element.offsetParent !== null
    );
  }

  function isQuickFormDescendant(root, element) {
    let current = element;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  }

  return {
    openQuickTaskForm,
    openQuickWorkflowForm,
    openRecurringForm,
  };
}
