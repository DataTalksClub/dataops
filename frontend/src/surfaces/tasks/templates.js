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
    sort: "used",
    error: "",
    batchReview: null,
    batchBusy: false,
    batchMessage: "",
    batchApplyResults: null,
  };

  // Search and sort redraw only the rows, never the whole surface. Re-rendering
  // the surface would replace the search input mid-keystroke and drop focus
  // after the first character.
  let listFrame = null;
  let resultCount = null;

  // The Templates page has three jobs, in this order: start a Card from a
  // Template, see what a Template does, and reconcile live Cards when the
  // definition changed upstream. Everything on this surface is laid out in that
  // order, so the most-wanted answer is never the smallest text on screen.
  const TEMPLATE_SORTS = [
    { id: "used", label: "Most used" },
    { id: "name", label: "Name A–Z" },
    { id: "changed", label: "Recently changed" },
  ];

  const TRIGGER_LABELS = {
    manual: "Manual",
    scheduled: "Scheduled",
    recurring: "Recurring",
    event: "Event",
  };

  // One icon language: authored emoji stay in the data, but the UI draws from
  // the family 24-grid stroke glyphs (stroke 1.8) like every other row.
  // Namespaces degrade gracefully for DOM shims without createElementNS.
  function strokeIcon(pathData) {
    const svgNs = "http://www.w3.org/2000/svg";
    const make = (tag) =>
      typeof document.createElementNS === "function"
        ? document.createElementNS(svgNs, tag)
        : document.createElement(tag);
    const icon = make("svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    const path = make("path");
    path.setAttribute("d", pathData);
    icon.append(path);
    return icon;
  }

  function templateIcon() {
    const icon = strokeIcon("M6 3h9l4 4v14H6ZM14 3v5h5M9 12h7M9 16h7");
    icon.classList.add("runtime-template-icon");
    return icon;
  }

  // A row list of nine identical document glyphs carried no information and
  // pushed the least useful thing on the row to the front. The trigger is the
  // facet that actually varies, so it gets the leading glyph.
  const TRIGGER_GLYPHS = {
    manual: "M5 12h14M13 6l6 6-6 6",
    scheduled: "M4 8h16M4 8V6M4 8v2M20 8v2M8 4v4M16 4v4M7 12h10v8H7Z",
    recurring: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4",
    event: "M12 4v8M12 12l-3 3M12 12l3 3M5 19h14",
  };

  function triggerIcon(triggerType) {
    const icon = strokeIcon(TRIGGER_GLYPHS[triggerType] || TRIGGER_GLYPHS.manual);
    icon.classList.add("runtime-template-trigger-icon");
    return icon;
  }

  function triggerLabel(triggerType) {
    return TRIGGER_LABELS[triggerType] || TRIGGER_LABELS.manual;
  }

  // Slugs are maintainer vocabulary. Rows and headings say what an operator
  // reads; the raw slug stays in the definition detail where provenance lives.
  function humanize(value) {
    return String(value || "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (character) => character.toUpperCase());
  }

  function dayOffsetLabel(offsetDays) {
    const days = Number(offsetDays || 0);
    if (days === 0) return "Day 0";
    if (days > 0) return `+${days} ${days === 1 ? "day" : "days"}`;
    return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} before`;
  }

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
    surface.append(renderTemplateDocReference(model));
    return surface;
  }

  // Process docs are reference reading, not a Template you act on. They used to
  // occupy a full second panel at the same weight as the Templates themselves,
  // which made an empty link-out look like the page's second half. Reference
  // reading now reads as reference.
  function renderTemplateDocReference(model) {
    const support = document.createElement("aside");
    support.className = "runtime-template-support";
    const docs = model.templates.filter((template) => !template.recurring);
    if (!docs.length) {
      // A bordered panel with a header bar and no body reads as a section that
      // failed to load. Nothing published is not a section; it is one line.
      support.classList.add("is-empty");
      const note = document.createElement("p");
      note.textContent = "No Template process docs published yet.";
      support.append(note);
      return support;
    }
    const section = document.createElement("div");
    section.className = "ops-section";
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "Template process docs";
    const guidance = document.createElement("span");
    guidance.textContent = "Read the written procedure behind a Template.";
    heading.append(title, guidance);
    header.append(heading);
    section.append(header);
    const grid = document.createElement("div");
    grid.className = "ops-template-grid";
    for (const template of docs) grid.append(renderWorkflowTemplateCard(template));
    section.append(grid);
    support.append(section);
    return support;
  }

  function renderRuntimeTemplateInspector() {
    const section = document.createElement("section");
    section.className = "ops-section runtime-template-inspector";
    section.classList.toggle("has-selection", Boolean(runtimeState.selectedId));
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "Authored templates";
    const guidance = document.createElement("span");
    // Operator language. What an operator wants to know is what a Template is
    // and what opening one gets them; where the definition is authored is
    // maintainer detail and lives in the pane foot.
    guidance.textContent = "A reusable definition. Open one to see its steps, then start a Card.";
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
        "Loading Authored templates",
        "Fetching the current deployed projections.",
      ));
      return section;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "runtime-template-toolbar";

    // The result count sits with the controls that change it, so the list never
    // silently shrinks under a search.
    resultCount = document.createElement("span");
    resultCount.className = "runtime-template-result-count";
    resultCount.setAttribute("role", "status");

    const sort = document.createElement("label");
    sort.className = "runtime-template-sort";
    const sortLabel = document.createElement("span");
    sortLabel.textContent = "Sort";
    const sortSelect = document.createElement("select");
    sortSelect.setAttribute("aria-label", "Sort Templates");
    for (const option of TEMPLATE_SORTS) {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      if (option.id === runtimeState.sort) element.selected = true;
      sortSelect.append(element);
    }
    sortSelect.addEventListener("change", () => {
      runtimeState.sort = sortSelect.value;
      refreshTemplateList();
    });
    sort.append(sortLabel, sortSelect);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "runtime-template-search";
    search.setAttribute("aria-label", "Search Authored templates");
    search.placeholder = "Search Templates";
    search.value = runtimeState.search;
    search.addEventListener("input", debounce(() => {
      runtimeState.search = search.value.trim().toLowerCase();
      refreshTemplateList();
    }, 150));
    toolbar.append(resultCount, sort, search);
    section.append(toolbar);

    const layout = document.createElement("div");
    layout.className = "runtime-template-layout";
    layout.classList.toggle("is-detail", Boolean(runtimeState.selectedId));
    const list = document.createElement("div");
    list.className = "runtime-template-list";
    listFrame = list;
    renderTemplateRows(list);
    layout.append(list, renderTemplateDetail());
    section.append(layout);
    return section;
  }

  // Repaint the rows and the result count in place. The search input keeps focus
  // and the caret because nothing it owns is replaced.
  function refreshTemplateList() {
    if (!listFrame) return;
    renderTemplateRows(listFrame);
  }

  function renderTemplateRows(list) {
    const templates = visibleTemplates();
    list.replaceChildren();
    if (!templates.length) {
      list.append(renderHonestState(
        "No Authored templates match",
        runtimeState.search
          ? "Broaden the search, or clear it to see every Template."
          : "The deployment has not published any Templates yet.",
      ));
    }
    for (const template of templates) list.append(renderTemplateRow(template));
    if (resultCount) {
      const total = runtimeState.templates.length;
      resultCount.textContent = runtimeState.search || templates.length !== total
        ? `${countLabel(templates.length, "Template")} of ${total}`
        : countLabel(total, "Template");
    }
  }

  // Row anatomy follows the work queue, which is the app's strongest list:
  // name, then the facts that change the decision as quiet separated chips,
  // then one sentence of consequence. The whole row is the affordance and says
  // so on hover, because there is no second control to aim at.
  function renderTemplateRow(template) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = template.id === runtimeState.selectedId;
    button.className = `runtime-template-row${selected ? " is-selected" : ""}`;
    button.setAttribute("aria-pressed", String(selected));
    const facts = templateFacts(template);

    const name = document.createElement("strong");
    name.appendChild(triggerIcon(template.triggerType));
    name.append(document.createTextNode(template.name || "Unnamed template"));

    const meta = document.createElement("div");
    meta.className = "runtime-template-meta";
    const chips = [
      [countLabel(facts.steps, "step"), ""],
      [triggerLabel(template.triggerType), ""],
      [facts.cards.length ? countLabel(facts.cards.length, "live Card") : "No live Cards", ""],
      [
        facts.behind ? `${countLabel(facts.behind, "Card")} behind` : "",
        facts.behind ? "is-attention" : "",
      ],
    ];
    for (const [value, attention] of chips) {
      if (!value) continue;
      const chip = document.createElement("span");
      chip.className = attention ? `runtime-template-chip ${attention}` : "runtime-template-chip";
      chip.textContent = value;
      meta.append(chip);
    }

    const summary = document.createElement("small");
    summary.textContent = templateRowSummary(facts);

    const open = document.createElement("span");
    open.className = "runtime-template-row-open";
    open.setAttribute("aria-hidden", "true");
    open.textContent = "Inspect";

    button.append(name, meta, summary, open);
    button.addEventListener("click", () => {
      if (template.id === runtimeState.selectedId) return;
      navigateCanonicalWorkspace("/templates", { templateId: template.id });
    });
    return button;
  }

  function renderTemplateDetail() {
    const selected = runtimeState.templates.find((template) => template.id === runtimeState.selectedId);
    if (!selected) {
      // The unselected pane used to hold the largest, boldest text on the page,
      // and that text was an instruction about the UI rather than a fact about
      // the operator's work. It is now the quietest thing in the pane.
      const empty = document.createElement("div");
      empty.className =
        "runtime-template-projection runtime-template-readonly runtime-template-empty";
      const glyph = document.createElement("span");
      glyph.className = "runtime-template-empty-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.appendChild(templateIcon());
      const prompt = document.createElement("p");
      prompt.textContent = "Select an authored template";
      const hint = document.createElement("span");
      hint.textContent = "Inspect what it runs, then create a Card.";
      empty.append(glyph, prompt, hint);
      return empty;
    }

    const facts = templateFacts(selected);
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
    heading.appendChild(templateIcon());
    heading.append(document.createTextNode(selected.name || selected.id));
    const guidance = document.createElement("p");
    guidance.textContent = `${triggerLabel(selected.triggerType)} · ${
      facts.cards.length
        ? `Last used ${relativeDayLabel(facts.lastUsed) || "recently"}`
        : "Not started yet"
    }`;
    title.append(heading, guidance);
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary-button";
    create.textContent = "Create card";
    create.addEventListener("click", () => openQuickWorkflowForm({ template: selected }));
    header.append(title, create);

    // Three numbers an operator weighs before committing to a run, stated once
    // at the top of the pane instead of being re-derived from the rows below.
    const factsStrip = document.createElement("dl");
    factsStrip.className = "runtime-template-facts";
    appendDefinition(factsStrip, "Steps", countLabel(facts.steps, "task"));
    appendDefinition(factsStrip, "Live Cards", countLabel(facts.cards.length, "Card"));
    appendDefinition(
      factsStrip,
      "Behind revision",
      facts.behind ? countLabel(facts.behind, "Card") : "None",
      facts.behind ? "is-attention" : "is-quiet",
    );

    // What the Template does comes before where it came from. Provenance is
    // maintainer detail and belongs at the foot of the pane.
    const stepsSection = document.createElement("section");
    stepsSection.className = "runtime-template-block";
    const stepsHeading = document.createElement("h5");
    stepsHeading.textContent = "What a new Card runs";
    const tasks = document.createElement("ol");
    tasks.className = "runtime-template-readonly-tasks";
    for (const task of selected.taskDefinitions || []) {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = task.description || task.refId || "Untitled task";
      const meta = document.createElement("span");
      meta.textContent = dayOffsetLabel(task.offsetDays);
      item.append(name, meta);
      tasks.append(item);
    }
    if (!(selected.taskDefinitions || []).length) {
      tasks.append(renderHonestState(
        "This Template defines no steps",
        "A Card created from it will start empty.",
      ));
    }
    stepsSection.append(stepsHeading, tasks);

    const cardUpdates = renderTemplateCardUpdates(selected);

    const definitionSection = document.createElement("section");
    definitionSection.className = "runtime-template-block runtime-template-provenance";
    const provenanceNote = document.createElement("p");
    provenanceNote.textContent =
      "This definition is projected from reviewed YAML. Changes take effect through the deployment workflow.";
    const definition = document.createElement("dl");
    definition.className = "runtime-template-definition";
    // Provenance only. Steps and trigger are already stated in the fact strip
    // and the heading; repeating them here just made the foot longer.
    appendDefinition(definition, "Type", humanize(selected.type));
    appendDefinition(definition, "Source", selected.sourcePath || "Authored workflow template");
    appendDefinition(
      definition,
      "Revision",
      selected.sourceRevision ? String(selected.sourceRevision).slice(0, 12) : "Unavailable",
      selected.sourceRevision ? "runtime-template-mono" : "",
    );
    definitionSection.append(definition, provenanceNote);

    detail.append(back, header, factsStrip, stepsSection, cardUpdates, definitionSection);
    return detail;
  }

  function cardsForTemplate(templateId) {
    return (state.workSnapshot?.cards || [])
      .filter((card) => card.templateId === templateId && card.status !== "archived");
  }

  // Every row and the inspector read these same four facts. The row must be
  // scannable, so it needs the two questions an operator actually asks before
  // starting work: how big is this, and is anything already running from it.
  function templateFacts(template) {
    const steps = (template.taskDefinitions || []).length;
    const cards = cardsForTemplate(template.id);
    // Same staleness predicate the backend uses to decide whether a Card can be
    // left alone: a Card is behind when it was projected from a different
    // definition revision or version, or carries no snapshot at all. This only
    // ranks rows; the reviewed preview remains the authority for applying.
    const behind = cards.filter((card) => (
      (card.templateSourceRevision || null) !== (template.sourceRevision || null)
      || Number(card.templateVersion || 0) !== Number(template.version || 0)
      || !card.templateDefinitionSnapshot
    )).length;
    const lastUsed = cards.reduce((latest, card) => (
      !latest || String(card.updatedAt || "") > String(latest) ? card.updatedAt || "" : latest
    ), "");
    return { steps, cards, behind, lastUsed };
  }

  function relativeDayLabel(timestamp) {
    if (!timestamp) return "";
    const then = Date.parse(timestamp);
    if (Number.isNaN(then)) return "";
    const days = Math.max(0, Math.round((Date.now() - then) / 86400000));
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return humanize(String(timestamp).slice(0, 7));
  }

  // The one sentence an operator wants before clicking: what this Template is
  // currently doing in the world.
  function templateRowSummary(facts) {
    if (!facts.cards.length) return "No Cards yet. New Cards start from this revision.";
    const live = countLabel(facts.cards.length, "active Card");
    const used = relativeDayLabel(facts.lastUsed);
    if (facts.behind) {
      return `${live} · ${countLabel(facts.behind, "Card")} behind the current revision.`;
    }
    return `${live} · all current${used ? ` · last used ${used}` : ""}.`;
  }

  function sortTemplates(templates) {
    const facts = new Map(templates.map((template) => [template.id, templateFacts(template)]));
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
    if (runtimeState.sort === "name") return [...templates].sort(byName);
    if (runtimeState.sort === "changed") {
      return [...templates].sort((a, b) => (
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || byName(a, b)
      ));
    }
    // Default: the Templates already carrying live work float up, because that
    // is where an operator returning to a run is looking.
    return [...templates].sort((a, b) => {
      const left = facts.get(a.id);
      const right = facts.get(b.id);
      return right.behind - left.behind
        || right.cards.length - left.cards.length
        || String(right.lastUsed || "").localeCompare(String(left.lastUsed || ""))
        || byName(a, b);
    });
  }

  function visibleTemplates() {
    const matched = runtimeState.templates.filter((template) => {
      const text = [template.name, template.type, template.triggerType, ...(template.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !runtimeState.search || text.includes(runtimeState.search);
    });
    return sortTemplates(matched);
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

  // The live Cards, named, with the one fact that decides whether the operator
// needs the review step: whether the Card was projected from this revision.
  function renderTemplateLiveCards(template, cards) {
    const list = document.createElement("ul");
    list.className = "runtime-template-live-cards";
    const facts = templateFacts(template);
    const shown = cards.slice(0, 5);
    for (const card of shown) {
      const behind = !card.templateDefinitionSnapshot
        || (card.templateSourceRevision || null) !== (template.sourceRevision || null)
        || Number(card.templateVersion || 0) !== Number(template.version || 0);
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = card.title || card.id;
      const meta = document.createElement("span");
      meta.textContent = behind
        ? "Behind this revision"
        : `Current · ${countLabel(Number(card.openTaskCount || 0), "open task")}`;
      if (behind) meta.className = "is-attention";
      item.append(name, meta);
      list.append(item);
    }
    if (facts.cards.length > shown.length) {
      const rest = document.createElement("li");
      rest.className = "runtime-template-live-cards-more";
      rest.textContent =
        `+${facts.cards.length - shown.length} more from this Template`;
      list.append(rest);
    }
    return list;
  }

  function renderTemplateCardUpdates(template) {
    const section = document.createElement("section");
    section.className = "runtime-template-block runtime-template-card-updates";
    const heading = document.createElement("div");
    heading.className = "runtime-template-card-updates-heading";
    const title = document.createElement("h5");
    title.textContent = "Live Cards";
    const cards = cardsForTemplate(template.id);
    const count = document.createElement("span");
    count.textContent = countLabel(cards.length, "active Card");
    heading.append(title, count);
    section.append(heading);
    if (!cards.length) {
      section.append(renderHonestState(
        "No active Cards use this Template",
        "New Cards will start at the current Authored revision.",
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
      // Naming the live Cards answers "what is already running from this?"
      // without opening the reviewed preview, which is the expensive step.
      section.append(renderTemplateLiveCards(template, cards));
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

  // The preview request stays bounded; the pane names the first few live Cards
  // and the review list is what an operator works through explicitly.
  const BATCH_REVIEW_LIMIT = 25;

  async function reviewTemplateCards(template, cards) {
    runtimeState.batchBusy = true;
    runtimeState.batchMessage = "Loading reviewed differences…";
    runtimeState.batchApplyResults = null;
    renderTasksSurface(getAllDocuments(), "templates");
    try {
      const payload = await request(workApiUrl("/api/cards/template-updates/preview"), {
        method: "POST",
        body: JSON.stringify({ cardIds: cards.slice(0, BATCH_REVIEW_LIMIT).map(({ id }) => id) }),
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

  function appendDefinition(list, label, value, valueClass) {
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value || "None";
    if (valueClass) definition.className = valueClass;
    list.append(term, definition);
  }

  // Day offsets read as a position in a run, not a signed integer: one day
  // ahead is "+1 day", and a step that has to happen beforehand says so rather
  // than rendering "-5 days" with no hint of what the sign meant.
  function dayOffsetLabel(offsetDays) {
    const days = Number(offsetDays || 0);
    if (days === 0) return "Day 0";
    if (days > 0) return `+${days} ${days === 1 ? "day" : "days"}`;
    const magnitude = Math.abs(days);
    return `${magnitude} ${magnitude === 1 ? "day" : "days"} before`;
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
