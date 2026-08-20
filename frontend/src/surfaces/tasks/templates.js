export function createTemplatesSurface(context) {
  const {
    countLabel,
    debounce,
    getAllDocuments,
    getWorkspaceEntityState,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openQuickWorkflowForm,
    renderHonestState,
    renderEntityLoadState,
    renderTasksSurface,
    renderWorkflowTemplateCard,
    request,
    refreshOperationsWorkSnapshot,
    setWorkspaceEntityState,
    state,
    workApiUrl,
  } = context;

  let runtimeState = {
    loaded: false,
    templates: [],
    selectedId: null,
    search: "",
    error: "",
    batchReview: null,
    batchBusy: false,
    batchMessage: "",
    batchApplyResults: null,
  };

  async function refreshRuntimeTemplates(options = {}) {
    const token = options.token;
    try {
      const payload = await request(workApiUrl("/api/templates"));
      if (token && !isWorkspaceRouteFresh(token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: true,
        templates: Array.isArray(payload) ? payload : payload.templates || [],
        error: "",
      };
    } catch (error) {
      if (token && !isWorkspaceRouteFresh(token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: true,
        error: error.message || "Runtime templates are unavailable.",
      };
    }
  }

  function renderTemplatesSurface(model) {
    const surface = document.createElement("section");
    surface.className = "ops-split-surface";
    surface.append(renderRuntimeTemplateInspector());

    const support = document.createElement("div");
    support.className = "runtime-template-support";
    const section = document.createElement("div");
    section.className = "ops-section";
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Template process docs";
    const meta = document.createElement("span");
    const templates = model.templates.filter((template) => !template.recurring);
    meta.textContent = `${countLabel(templates.length, "template")} indexed`;
    header.append(title, meta);
    section.append(header);
    const grid = document.createElement("div");
    grid.className = "ops-template-grid";
    for (const template of templates) grid.append(renderWorkflowTemplateCard(template));
    if (!grid.children.length) {
      grid.append(renderHonestState(
        "No template process docs indexed",
        "Runtime projections remain available in the Git-authored template inspector.",
      ));
    }
    section.append(grid);
    support.append(section);
    surface.append(support);
    return surface;
  }

  function renderRuntimeTemplateInspector() {
    const section = document.createElement("section");
    section.className = "ops-section runtime-template-inspector";
    section.classList.toggle("has-selection", Boolean(runtimeState.selectedId));
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "Git-authored templates";
    const guidance = document.createElement("span");
    guidance.textContent =
      "Read-only runtime projections. Maintainers edit YAML in the private knowledge repository.";
    heading.append(title, guidance);
    header.append(heading);
    section.append(header);

    const entity = getWorkspaceEntityState();
    if (
      runtimeState.selectedId
      && entity?.kind === "template"
      && entity.status !== "ready"
    ) {
      const state = document.createElement("div");
      renderEntityLoadState(state, {
        ...entity,
        retry: () => navigateCanonicalWorkspace(
          "/templates",
          { templateId: runtimeState.selectedId },
          { history: "none" },
        ),
        returnToList: () => navigateCanonicalWorkspace("/templates"),
      });
      section.append(state);
      return section;
    }

    if (runtimeState.error) {
      section.append(renderHonestState("Runtime templates unavailable", runtimeState.error));
      return section;
    }
    if (!runtimeState.loaded) {
      section.append(renderHonestState(
        "Loading Git-authored templates",
        "Fetching the current deployed projections.",
      ));
      return section;
    }

    const search = document.createElement("input");
    search.type = "search";
    search.className = "runtime-template-search";
    search.setAttribute("aria-label", "Search Git-authored templates");
    search.placeholder = "Search Git-authored templates";
    search.value = runtimeState.search;
    search.addEventListener("input", debounce(() => {
      runtimeState.search = search.value.trim().toLowerCase();
      renderTasksSurface(getAllDocuments(), "templates");
    }, 150));
    section.append(search);

    const layout = document.createElement("div");
    layout.className = "runtime-template-layout";
    layout.classList.toggle("is-detail", Boolean(runtimeState.selectedId));
    const list = document.createElement("div");
    list.className = "runtime-template-list";
    const templates = runtimeState.templates.filter((template) => {
      const text = [template.name, template.type, template.triggerType, ...(template.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !runtimeState.search || text.includes(runtimeState.search);
    });
    if (!templates.length) {
      list.append(renderHonestState(
        "No Git-authored templates match",
        "Broaden the search or verify the deployment projection.",
      ));
    }
    for (const template of templates) list.append(renderTemplateRow(template));
    layout.append(list, renderTemplateDetail());
    section.append(layout);
    return section;
  }

  function renderTemplateRow(template) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `runtime-template-row ${template.id === runtimeState.selectedId ? "is-selected" : ""}`;
    button.setAttribute("aria-pressed", String(template.id === runtimeState.selectedId));
    const name = document.createElement("strong");
    name.textContent = template.emoji
      ? `${template.emoji} ${template.name}`
      : template.name || "Unnamed template";
    const meta = document.createElement("span");
    meta.textContent = [
      template.type || "untyped",
      countLabel((template.taskDefinitions || []).length, "task"),
      template.triggerType || "manual",
    ].join(" · ");
    button.append(name, meta);
    button.addEventListener("click", () => {
      if (template.id === runtimeState.selectedId) return;
      navigateCanonicalWorkspace("/templates", { templateId: template.id });
    });
    return button;
  }

  function renderTemplateDetail() {
    const selected = runtimeState.templates.find((template) => template.id === runtimeState.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "runtime-template-projection runtime-template-readonly";
      empty.append(renderHonestState(
        "Select a Git-authored template",
        "Inspect its deployed definition or create a Card from it.",
      ));
      return empty;
    }

    const detail = document.createElement("article");
    detail.className = "runtime-template-projection runtime-template-readonly";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "runtime-mobile-back";
    back.textContent = "Back to template list";
    back.addEventListener("click", () => navigateCanonicalWorkspace(
      "/templates",
      {},
      { restoreFocus: { kind: "runtime-template-list" } },
    ));

    const header = document.createElement("header");
    const title = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = selected.emoji
      ? `${selected.emoji} ${selected.name}`
      : selected.name || selected.id;
    const guidance = document.createElement("p");
    guidance.textContent =
      "This definition is projected from reviewed YAML. Changes take effect through the deployment workflow.";
    title.append(heading, guidance);
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary-button";
    create.textContent = "Create card";
    create.addEventListener("click", () => openQuickWorkflowForm({ template: selected }));
    header.append(title, create);

    const definition = document.createElement("dl");
    definition.className = "runtime-template-definition";
    appendDefinition(definition, "Type", selected.type);
    appendDefinition(definition, "Trigger", selected.triggerType || "manual");
    appendDefinition(definition, "Tasks", String((selected.taskDefinitions || []).length));
    appendDefinition(definition, "Source", selected.sourcePath || "Git-authored workflow template");
    appendDefinition(
      definition,
      "Revision",
      selected.sourceRevision ? String(selected.sourceRevision).slice(0, 12) : "Unavailable",
    );
    const cardUpdates = renderTemplateCardUpdates(selected);

    const tasks = document.createElement("ol");
    tasks.className = "runtime-template-readonly-tasks";
    for (const task of selected.taskDefinitions || []) {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = task.description || task.refId || "Untitled task";
      const meta = document.createElement("span");
      meta.textContent = `${Number(task.offsetDays || 0) >= 0 ? "+" : ""}${Number(task.offsetDays || 0)} days`;
      item.append(name, meta);
      tasks.append(item);
    }
    detail.append(back, header, definition, cardUpdates, tasks);
    return detail;
  }

  function cardsForTemplate(templateId) {
    return (state.workSnapshot?.cards || [])
      .filter((card) => card.templateId === templateId && card.status !== "archived")
      .slice(0, 25);
  }

  function batchPreviewSummary(preview) {
    const counts = preview?.counts || {};
    const changed = Number(counts.cardFields || 0)
      + Number(counts.added || 0)
      + Number(counts.updated || 0)
      + Number(counts.archived || 0)
      + Number(counts.retainedCompleted || 0);
    if (preview?.state === "current") return "Current";
    return `${changed} changes · Template v${preview?.targetTemplateVersion || "?"}`;
  }

  function renderTemplateCardUpdates(template) {
    const section = document.createElement("section");
    section.className = "runtime-template-card-updates";
    const heading = document.createElement("div");
    heading.className = "runtime-template-card-updates-heading";
    const title = document.createElement("h5");
    title.textContent = "Existing Cards";
    const cards = cardsForTemplate(template.id);
    const count = document.createElement("span");
    count.textContent = countLabel(cards.length, "active Card");
    heading.append(title, count);
    section.append(heading);
    if (!cards.length) {
      section.append(renderHonestState(
        "No active Cards use this Template",
        "New Cards will start at the current Git-authored revision.",
      ));
      return section;
    }

    const review = runtimeState.batchReview?.templateId === template.id
      ? runtimeState.batchReview
      : null;
    if (runtimeState.batchMessage) {
      const message = document.createElement("p");
      message.className = "runtime-template-batch-message";
      message.setAttribute("role", "status");
      message.textContent = runtimeState.batchMessage;
      section.append(message);
    }
    if (!review) {
      const guidance = document.createElement("p");
      guidance.textContent = "Preview current Template differences, then explicitly select the Cards to update.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-action-btn";
      button.textContent = `Review ${countLabel(cards.length, "Card")} for updates`;
      button.disabled = runtimeState.batchBusy;
      button.addEventListener("click", () => reviewTemplateCards(template, cards));
      section.append(guidance, button);
      return section;
    }

    if (runtimeState.batchApplyResults) {
      const results = document.createElement("ul");
      results.className = "runtime-template-batch-results";
      for (const result of runtimeState.batchApplyResults) {
        const item = document.createElement("li");
        const card = cards.find(({ id }) => id === result.cardId);
        const label = card?.title || result.cardId;
        item.className = `is-${result.status}`;
        item.textContent = result.status === "failed"
          ? `${label}: conflict — reload before retrying`
          : `${label}: ${result.status}`;
        results.append(item);
      }
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "task-action-btn";
      reload.textContent = "Reload batch previews";
      reload.disabled = runtimeState.batchBusy;
      reload.addEventListener("click", () => reviewTemplateCards(template, cards));
      section.append(results, reload);
      return section;
    }

    const selectedIds = new Set(review.selectedIds || []);
    const list = document.createElement("div");
    list.className = "runtime-template-card-update-list";
    for (const result of review.results || []) {
      const row = document.createElement("label");
      row.className = "runtime-template-card-update-row";
      const card = cards.find(({ id }) => id === result.cardId);
      const preview = result.preview;
      const selectable = result.status === "ready" && preview?.state !== "current";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = !selectable || runtimeState.batchBusy;
      checkbox.checked = selectedIds.has(result.cardId);
      checkbox.setAttribute("aria-label", `Select ${card?.title || result.cardId}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIds.add(result.cardId);
        else selectedIds.delete(result.cardId);
        runtimeState.batchReview.selectedIds = [...selectedIds];
        renderTasksSurface(getAllDocuments(), "templates");
      });
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = card?.title || result.cardId;
      const meta = document.createElement("small");
      meta.textContent = result.status === "ready"
        ? batchPreviewSummary(preview)
        : result.error || "Preview failed";
      text.append(name, meta);
      row.append(checkbox, text);
      list.append(row);
    }
    section.append(list);

    const actions = document.createElement("div");
    actions.className = "runtime-template-card-update-actions";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary-button";
    apply.textContent = runtimeState.batchBusy
      ? "Applying…"
      : `Apply ${countLabel(selectedIds.size, "selected Card")}`;
    apply.disabled = runtimeState.batchBusy || selectedIds.size === 0;
    apply.addEventListener("click", () => applyTemplateCardBatch(template, review));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "task-action-btn";
    cancel.textContent = "Cancel batch review";
    cancel.disabled = runtimeState.batchBusy;
    cancel.addEventListener("click", () => {
      runtimeState.batchReview = null;
      runtimeState.batchMessage = "";
      runtimeState.batchApplyResults = null;
      renderTasksSurface(getAllDocuments(), "templates");
    });
    actions.append(apply, cancel);
    section.append(actions);
    return section;
  }

  async function reviewTemplateCards(template, cards) {
    runtimeState.batchBusy = true;
    runtimeState.batchMessage = "Loading reviewed differences…";
    runtimeState.batchApplyResults = null;
    renderTasksSurface(getAllDocuments(), "templates");
    try {
      const payload = await request(workApiUrl("/api/cards/template-updates/preview"), {
        method: "POST",
        body: JSON.stringify({ cardIds: cards.map(({ id }) => id) }),
      });
      runtimeState.batchReview = {
        templateId: template.id,
        results: payload.results || [],
        selectedIds: [],
      };
      const actionable = runtimeState.batchReview.results.filter((result) => (
        result.status === "ready" && result.preview?.state !== "current"
      )).length;
      runtimeState.batchMessage = actionable
        ? `${countLabel(actionable, "Card")} can be selected. Nothing is selected automatically.`
        : "Every reviewed Card is current.";
    } catch (error) {
      runtimeState.batchReview = null;
      runtimeState.batchMessage = `Could not preview Card updates: ${error.message || "request failed"}`;
    } finally {
      runtimeState.batchBusy = false;
      renderTasksSurface(getAllDocuments(), "templates");
    }
  }

  async function applyTemplateCardBatch(template, review) {
    const selected = new Set(review.selectedIds || []);
    const updates = (review.results || [])
      .filter((result) => selected.has(result.cardId) && result.preview?.previewToken)
      .map((result) => ({ cardId: result.cardId, previewToken: result.preview.previewToken }));
    if (!updates.length) return;
    runtimeState.batchBusy = true;
    runtimeState.batchMessage = `Applying ${countLabel(updates.length, "reviewed Card")}…`;
    renderTasksSurface(getAllDocuments(), "templates");
    try {
      const payload = await request(workApiUrl("/api/cards/template-updates/apply"), {
        method: "POST",
        body: JSON.stringify({ updates }),
      });
      runtimeState.batchApplyResults = payload.results || [];
      const applied = runtimeState.batchApplyResults.filter(({ status }) => status === "applied").length;
      const conflicts = runtimeState.batchApplyResults.filter(({ status }) => status === "failed").length;
      runtimeState.batchMessage = [
        `${countLabel(applied, "Card")} applied`,
        conflicts ? `${countLabel(conflicts, "conflict")} needs a fresh preview` : "no conflicts",
      ].join(" · ");
      await refreshOperationsWorkSnapshot({ rerender: false });
    } catch (error) {
      runtimeState.batchMessage = `Could not apply reviewed Cards: ${error.message || "request failed"}`;
    } finally {
      runtimeState.batchBusy = false;
      renderTasksSurface(getAllDocuments(), "templates");
    }
  }

  function appendDefinition(list, label, value) {
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value || "None";
    list.append(term, definition);
  }

  async function resolveTemplateRouteEntity(route, token) {
    await refreshRuntimeTemplates({ token });
    if (!isWorkspaceRouteFresh(token)) return;
    const templateId = route.params.get("templateId");
    if (!templateId) {
      setWorkspaceEntityState(null);
      runtimeState.selectedId = null;
      renderTasksSurface(getAllDocuments(), "templates");
      return;
    }
    let template = runtimeState.templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      try {
        const payload = await request(workApiUrl(`/api/templates/${encodeURIComponent(templateId)}`));
        if (!isWorkspaceRouteFresh(token)) return;
        template = payload.template || payload;
        runtimeState.templates = [template, ...runtimeState.templates];
      } catch (error) {
        if (!isWorkspaceRouteFresh(token)) return;
        setWorkspaceEntityState({
          kind: "template",
          id: templateId,
          status: error.status === 404 ? "not-found" : "error",
          error: error.message,
        });
      }
    }
    if (template) {
      setWorkspaceEntityState({ kind: "template", id: templateId, status: "ready" });
    }
    runtimeState.selectedId = templateId;
    renderTasksSurface(getAllDocuments(), "templates");
  }

  function setRuntimeTemplateRoute(route, entity) {
    runtimeState.selectedId = route?.tasksSection === "templates"
      ? (entity?.templateId ?? route.params.get("templateId"))
      : null;
    if (runtimeState.batchReview?.templateId !== runtimeState.selectedId) {
      runtimeState.batchReview = null;
      runtimeState.batchMessage = "";
      runtimeState.batchApplyResults = null;
    }
  }

  return {
    getRuntimeTemplateState: () => runtimeState,
    refreshRuntimeTemplates,
    renderTemplatesSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  };
}
