export function createQuickTaskActions(context) {
  const {
    openBundlePanel,
    openTaskPanel,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    reportError,
    request,
    shellBody,
    todayIsoDate,
    workApiUrl,
  } = context;

  function openQuickTaskForm() {
    const overlay = createQuickFormOverlay("New task");
    const form = document.createElement("div");
    form.className = "quick-form";

    const descInput = createQuickInput("What needs doing?", "text", "");
    const dateInput = createQuickInput("Due date", "date", todayIsoDate());

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create task";
    createBtn.addEventListener("click", async () => {
      const description = descInput.input.value.trim();
      const date = dateInput.input.value;
      if (!description) {
        reportError("Task description is required.");
        return;
      }
      if (!date) {
        reportError("Due date is required.");
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      try {
        const created = await request(workApiUrl("/api/tasks"), {
          method: "POST",
          body: JSON.stringify({ description, date }),
        });
        overlay.remove();
        const task = created?.task || created;
        if (task?.id) openTaskPanel(task.id);
        refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create task: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create task";
      }
    });

    form.append(descInput.label, dateInput.label, createBtn);
    overlay.querySelector(".quick-form-body").append(form);
  }

  async function openQuickWorkflowForm(options = {}) {
    const requestedTemplate = options.template || null;
    const overlay = createQuickFormOverlay("Create card");
    const form = document.createElement("div");
    form.className = "quick-form";

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

    const anchorInput = createQuickInput("Anchor date", "date", todayIsoDate());
    const titleInput = createQuickInput("Card title (optional)", "text", "");

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create card";
    createBtn.disabled = true;

    form.append(selectLabel, titleInput.label, anchorInput.label, createBtn);
    overlay.querySelector(".quick-form-body").append(form);

    // Fetch live templates from the backend API (UUIDs, not doc slugs)
    let liveTemplates = [];
    try {
      const payload = await request(workApiUrl("/api/templates"));
      liveTemplates = Array.isArray(payload)
        ? payload
        : payload.templates || [];
    } catch {
      liveTemplates = [];
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
    if (liveTemplates.length > 0) createBtn.disabled = false;
    else {
      const emptyOpt = document.createElement("option");
      emptyOpt.textContent = "No templates available";
      templateSelect.append(emptyOpt);
    }

    createBtn.addEventListener("click", async () => {
      const templateId = templateSelect.value;
      const anchorDate = anchorInput.input.value;
      if (!templateId) {
        reportError("Select a template.");
        return;
      }
      if (!anchorDate) {
        reportError("Anchor date is required.");
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Starting...";
      try {
        const body = { templateId, anchorDate };
        const title = titleInput.input.value.trim();
        if (title) body.title = title;
        const result = await request(workApiUrl("/api/bundles"), {
          method: "POST",
          body: JSON.stringify(body),
        });
        const bundle = result?.bundle || result;
        overlay.remove();
        if (bundle?.id) openBundlePanel(bundle.id);
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create card: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create card";
      }
    });
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

  function openQuickRecurringForm() {
    const overlay = createQuickFormOverlay("New recurring operation");
    const form = document.createElement("div");
    form.className = "quick-form";

    const descriptionInput = createQuickInput("Description", "text", "");
    const scheduleLabel = document.createElement("label");
    scheduleLabel.className = "quick-form-label";
    scheduleLabel.textContent = "Schedule";
    const scheduleSelect = document.createElement("select");
    scheduleSelect.className = "quick-form-select";
    for (const [value, label] of [
      ["daily", "Daily"],
      ["weekly", "Weekly"],
      ["monthly", "Monthly"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      scheduleSelect.append(opt);
    }
    scheduleLabel.append(scheduleSelect);

    const timeInput = createQuickInput("Time", "time", "09:00");
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
      "1",
    );
    const monthDay = createQuickInput("Day of month", "number", "1");
    monthDay.input.min = "1";
    monthDay.input.max = "31";
    const enabled = createQuickCheckbox("Enabled", true);

    const syncScheduleFields = () => {
      weekday.label.hidden = scheduleSelect.value !== "weekly";
      monthDay.label.hidden = scheduleSelect.value !== "monthly";
    };
    scheduleSelect.addEventListener("change", syncScheduleFields);
    syncScheduleFields();

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create recurring";
    createBtn.addEventListener("click", async () => {
      const description = descriptionInput.input.value.trim();
      if (!description) {
        reportError("Recurring description is required.");
        return;
      }
      const cronExpression = cronExpressionFromRecurringForm(
        scheduleSelect.value,
        timeInput.input.value,
        weekday.input.value,
        monthDay.input.value,
      );
      if (!cronExpression) return;
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      try {
        await request(workApiUrl("/api/recurring"), {
          method: "POST",
          body: JSON.stringify({
            description,
            cronExpression,
            enabled: enabled.input.checked,
          }),
        });
        overlay.remove();
        await refreshOperationsRecurringSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create recurring operation: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create recurring";
      }
    });

    form.append(
      descriptionInput.label,
      scheduleLabel,
      timeInput.label,
      weekday.label,
      monthDay.label,
      enabled.label,
      createBtn,
    );
    overlay.querySelector(".quick-form-body").append(form);
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

  function cronExpressionFromRecurringForm(
    schedule,
    timeValue,
    weekday,
    dayOfMonth,
  ) {
    const time = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
    if (!time) {
      reportError("Choose a valid time.");
      return "";
    }
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      reportError("Choose a valid time.");
      return "";
    }
    if (schedule === "daily") return `${minute} ${hour} * * *`;
    if (schedule === "weekly") {
      const day = Number(weekday);
      if (day < 0 || day > 6) {
        reportError("Choose a valid weekday.");
        return "";
      }
      return `${minute} ${hour} * * ${day}`;
    }
    if (schedule === "monthly") {
      const day = Number(dayOfMonth);
      if (day < 1 || day > 31) {
        reportError("Choose a valid day of month.");
        return "";
      }
      return `${minute} ${hour} ${day} * *`;
    }
    reportError("Choose a recurring schedule.");
    return "";
  }

  function createQuickFormOverlay(titleText) {
    const overlay = document.createElement("div");
    overlay.className = "quick-form-overlay confirm-modal";
    overlay.hidden = false;

    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";
    backdrop.addEventListener("click", () => overlay.remove());

    const panel = document.createElement("div");
    panel.className = "confirm-panel quick-form-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "diff-header";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "quiet-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.append(title, closeBtn);

    const body = document.createElement("div");
    body.className = "quick-form-body";

    panel.append(header, body);
    overlay.append(backdrop, panel);
    shellBody.append(overlay);
    return overlay;
  }

  return {
    openQuickTaskForm,
    openQuickWorkflowForm,
  };
}
