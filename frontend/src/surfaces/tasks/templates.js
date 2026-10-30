import { SPLIT_BACK_ICON } from "../split-back-icon.js";
import { browserRequirementParts } from "../../core/task-display.js";

export function createTemplatesSurface(context) {
  const {
    countLabel,
    getAllDocuments,
    getWorkspaceEntityState,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openQuickWorkflowForm,
    renderHonestState,
    renderEntityLoadState,
    renderTasksSurface,
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
    error: "",
    batchReview: null,
    batchBusy: false,
    batchMessage: "",
    batchApplyResults: null,
    editorBusy: false,
    editorMessage: "",
    editorOpen: false,
  };

  // Selecting a Template re-renders the whole surface (route change plus a
  // fresh fetch), which recreates the list element and resets its scroll to
  // the top. Track the scroll offset so a Template at the bottom of a long
  // list stays where the operator left it.
  let listScrollTop = 0;

  // The Templates page has two jobs, in this order: start a Card from a
  // Template, and reconcile live Cards when the definition changed upstream.
  // Everything on this surface is laid out in that order, so the most-wanted
  // answer is never the smallest text on screen.

  const TRIGGER_LABELS = {
    manual: "Manual",
    scheduled: "Scheduled",
    recurring: "Recurring",
    event: "Event",
  };

  // One icon language: the UI draws from the family 24-grid stroke glyphs
  // (stroke 1.8) like every other row.
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

  function dayOffsetLabel(offsetDays, anchor) {
    const days = Number(offsetDays || 0);
    const prefix = anchor === "end" ? "END " : "";
    if (days === 0) return `${prefix}Day 0`;
    if (days > 0) return `${prefix}+${days} ${days === 1 ? "day" : "days"}`;
    const magnitude = Math.abs(days);
    return `${prefix}${magnitude} ${magnitude === 1 ? "day" : "days"} before`;
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

  function renderTemplatesSurface() {
    return renderRuntimeTemplateInspector();
  }

  // The inspector keeps one stable shell across loading, error, and ready
  // states: header, list, detail. Only the list region swaps its content, so
  // opening Templates never flashes one interface and then another.
  function renderRuntimeTemplateInspector() {
    const section = document.createElement("section");
    section.className = "runtime-template-inspector dk-fill";
    section.setAttribute("aria-label", "Authored templates");

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

    // The route decides which pane a phone shows (dakit list–detail split).
    const layout = document.createElement("div");
    layout.className = "dk-split";
    layout.dataset.view = runtimeState.selectedId ? "detail" : "list";
    const pane = document.createElement("section");
    pane.className = "dk-split__list";
    pane.setAttribute("aria-labelledby", "runtime-templates-title");
    const head = document.createElement("header");
    head.className = "dk-split__head";
    const title = document.createElement("h2");
    title.className = "dk-split__title";
    title.id = "runtime-templates-title";
    title.textContent = "Authored templates";
    head.append(title);
    if (runtimeState.loaded && !runtimeState.error) {
      const count = document.createElement("span");
      count.className = "dk-split__count";
      count.textContent = String(orderedTemplates().length);
      head.append(count);
    }
    const list = document.createElement("div");
    list.className = "dk-split__scroll";
    list.addEventListener("scroll", () => {
      listScrollTop = list.scrollTop || 0;
    }, { passive: true });
    if (runtimeState.error) {
      list.append(renderHonestState("Runtime templates unavailable", runtimeState.error));
    } else if (!runtimeState.loaded) {
      const loading = document.createElement("p");
      loading.className = "runtime-template-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading templates…";
      list.append(loading);
    } else {
      renderTemplateRows(list);
    }
    pane.append(head, list);
    layout.append(pane, renderTemplateDetail());
    section.append(layout);
    return section;
  }

  function renderTemplateRows(list) {
    const templates = orderedTemplates();
    list.replaceChildren();
    if (!templates.length) {
      list.append(renderHonestState(
        "No Authored templates",
        "The deployment has not published any Templates yet.",
      ));
    }
    for (const template of templates) list.append(renderTemplateRow(template));
    // The list element is recreated on every surface render; without this a
    // selection made at the bottom jumps the scroll back to the top.
    list.scrollTop = listScrollTop;
  }

  // Row anatomy follows the work queue, which is the app's strongest list:
  // name, then the facts that change the decision as quiet separated chips,
  // then one sentence of consequence. The whole row is the affordance and says
  // so on hover, because there is no second control to aim at.
  function renderTemplateRow(template) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = template.id === runtimeState.selectedId;
    button.className = "dk-split__item runtime-template-row";
    if (selected) button.setAttribute("aria-current", "true");
    const facts = templateFacts(template);

    const name = document.createElement("span");
    name.className = "dk-split__name";
    name.appendChild(triggerIcon(template.triggerType));
    name.append(document.createTextNode(template.name || "Unnamed template"));

    const meta = document.createElement("div");
    meta.className = "runtime-template-meta";
    const chips = [
      [countLabel(facts.steps, "step"), ""],
      [triggerLabel(template.triggerType), ""],
      [facts.cards.length ? countLabel(facts.cards.length, "live card") : "No live cards", ""],
      [
        facts.behind ? `${countLabel(facts.behind, "card")} behind` : "",
        facts.behind ? "is-attention" : "",
      ],
    ];
    for (const [value, attention] of chips) {
      if (!value) continue;
      const chip = document.createElement("span");
      chip.className = attention ? `runtime-template-chip ${attention}` : "runtime-template-chip";
      if (/^\d/.test(value)) {
        const quantity = document.createElement("span");
        quantity.className = "dk-mono";
        quantity.textContent = value.match(/^\d+/)[0];
        chip.append(quantity, document.createTextNode(value.slice(quantity.textContent.length)));
      } else chip.textContent = value;
      meta.append(chip);
    }

    const summary = document.createElement("small");
    summary.textContent = templateRowSummary(facts);

    button.append(name, meta, summary);
    button.addEventListener("click", () => {
      if (template.id === runtimeState.selectedId) return;
      listScrollTop = button.closest(".dk-split__scroll")?.scrollTop || 0;
      navigateCanonicalWorkspace("/templates", { templateId: template.id });
    });
    return button;
  }

  function renderTemplateDetail() {
    const selected = runtimeState.templates.find((template) => template.id === runtimeState.selectedId);
    const pane = document.createElement("section");
    pane.className = "dk-split__detail runtime-template-projection";
    pane.setAttribute("aria-label", "Selected template");
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "dk-split__empty";
      const state = document.createElement("div");
      state.className = "dk-empty";
      const prompt = document.createElement("p");
      prompt.className = "dk-empty__title";
      prompt.textContent = "Choose a template";
      const hint = document.createElement("p");
      hint.className = "dk-empty__desc";
      hint.textContent = "Choose a template from the list to preview its steps and existing cards. Use Start card in the preview when you’re ready to begin.";
      state.append(prompt, hint);
      empty.append(state);
      pane.append(empty);
      return pane;
    }

    const facts = templateFacts(selected);
    const detail = document.createElement("article");
    detail.className = "dk-split__scroll runtime-template-preview";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "dk-split__back";
    back.setAttribute("aria-label", "Back to Templates");
    back.innerHTML = `${SPLIT_BACK_ICON}Templates`;
    back.addEventListener("click", () => navigateCanonicalWorkspace(
      "/templates",
      {},
      { restoreFocus: { kind: "split-list" } },
    ));

    const header = document.createElement("header");
    header.className = "dk-split__head";
    const heading = document.createElement("h2");
    heading.className = "dk-split__title runtime-template-title";
    heading.tabIndex = -1;
    heading.appendChild(templateIcon());
    heading.append(document.createTextNode(selected.name || selected.id));
    const guidance = document.createElement("p");
    guidance.className = "runtime-template-guidance";
    guidance.textContent = `${triggerLabel(selected.triggerType)} · ${
      facts.cards.length
        ? `Last used ${relativeDayLabel(facts.lastUsed) || "recently"}`
        : "Not started yet"
    }`;
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary-button";
    create.textContent = "Start card";
    create.addEventListener("click", () => openQuickWorkflowForm({ template: selected }));
    header.append(back, heading, create);

    // What the Template does comes before where it came from. Provenance is
    // maintainer detail and belongs at the foot of the pane.
    const stepsSection = document.createElement("section");
    stepsSection.className = "runtime-template-block";
    const stepsHeading = document.createElement("h5");
    stepsHeading.textContent = "What a new card runs";
    const tasks = document.createElement("ol");
    tasks.className = "runtime-template-readonly-tasks";
    for (const task of selected.taskDefinitions || []) {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = task.description || task.refId || "Untitled task";
      const meta = document.createElement("span");
      // The authored execution need rides the step line, so an operator
      // starting a card knows which steps need a browser before they exist.
      const browser = browserRequirementParts(task.browserRequirement);
      meta.textContent = browser.classified
        ? `${dayOffsetLabel(task.offsetDays, task.anchor)} · ${browser.label}`
        : dayOffsetLabel(task.offsetDays, task.anchor);
      item.append(name, meta);
      tasks.append(item);
    }
    if (!(selected.taskDefinitions || []).length) {
      tasks.append(renderHonestState(
        "This template defines no steps",
        "A card started from it will be empty.",
      ));
    }
    stepsSection.append(stepsHeading, tasks);

    const cardUpdates = renderTemplateCardUpdates(selected);

    const definitionSection = document.createElement("details");
    definitionSection.className = "runtime-template-block runtime-template-provenance";
    const definitionSummary = document.createElement("summary");
    definitionSummary.textContent = "Definition details";
    const provenanceNote = document.createElement("p");
    provenanceNote.textContent =
      "Git seed lives in dataops-knowledge at workflow-templates/<type>.yaml (see Source). "
      + "Saving below pins the whole definition over that seed; new cards use the pin immediately. "
      + "Reset restores the Git base. CLI: dataops templates update|reset.";
    const definition = document.createElement("dl");
    definition.className = "runtime-template-definition";
    // Provenance only. Steps and trigger are already stated in the fact strip
    // and the heading; repeating them here just made the foot longer.
    appendDefinition(definition, "Type", humanize(selected.type));
    appendDefinition(definition, "Source", selected.sourcePath || "Authored workflow template");
    const overviewDocs = [
      ...(Array.isArray(selected.sourceDocIds) ? selected.sourceDocIds : []),
      ...(Array.isArray(selected.references)
        ? selected.references.map((ref) =>
          typeof ref === "string" ? ref : ref?.name || ref?.title || ref?.url || "",
        )
        : []),
    ].filter(Boolean);
    if (overviewDocs.length > 0) {
      appendDefinition(definition, "Process docs", overviewDocs.join(", "));
    }
    appendDefinition(
      definition,
      "Revision",
      selected.sourceRevision ? String(selected.sourceRevision).slice(0, 12) : "Unavailable",
      selected.sourceRevision ? "runtime-template-mono" : "",
    );
    appendDefinition(
      definition,
      "Git blob",
      selected.sourceBlobSha ? String(selected.sourceBlobSha).slice(0, 12) : "Unavailable",
      selected.sourceBlobSha ? "runtime-template-mono" : "",
    );
    definitionSection.append(definitionSummary, definition, provenanceNote);

    const editorSection = renderTemplateEditor(selected);

    detail.append(guidance, stepsSection, cardUpdates, editorSection, definitionSection);
    pane.append(header, detail);
    return pane;
  }

  const TEMPLATE_EDITOR_SERVER_FIELDS = new Set([
    "id", "version", "revision", "origin", "pinned", "base", "baseSourceRevision", "baseSourceBlobSha",
    "sourcePath", "sourceRevision", "sourceBlobSha", "createdAt", "updatedAt", "PK", "SK",
  ]);

  function definitionPayloadFromTemplate(template) {
    const clean = { ...template };
    for (const field of TEMPLATE_EDITOR_SERVER_FIELDS) delete clean[field];
    return clean;
  }

  function renderTemplateEditor(template) {
    const section = document.createElement("details");
    section.className = "runtime-template-block runtime-template-editor";
    section.open = Boolean(runtimeState.editorOpen && runtimeState.selectedId === template.id);
    const summary = document.createElement("summary");
    summary.textContent = "Edit definition (web)";
    section.append(summary);

    const help = document.createElement("p");
    help.className = "runtime-template-editor-help";
    const gitPath = template.sourcePath
      || `workflow-templates/${template.type || "template"}.yaml`;
    help.textContent =
      `Edit the JSON definition and Save to pin it in DataOps (durable). `
      + `Git seed path: ${gitPath}. Push that YAML in dataops-knowledge when you want the seed updated; `
      + `pin wins for new cards until you Reset to Git base. Same payload as `
      + `dataops templates update --file.`;
    section.append(help);

    const textarea = document.createElement("textarea");
    textarea.className = "dk-input runtime-template-editor-json";
    textarea.rows = 18;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", "Template definition JSON");
    textarea.value = JSON.stringify(definitionPayloadFromTemplate(template), null, 2);
    textarea.disabled = runtimeState.editorBusy;
    section.append(textarea);

    const actions = document.createElement("div");
    actions.className = "runtime-template-editor-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.textContent = runtimeState.editorBusy ? "Saving…" : "Save pin";
    save.disabled = runtimeState.editorBusy;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "dk-button";
    reset.textContent = "Reset to Git base";
    reset.disabled = runtimeState.editorBusy || template.origin !== "git";
    reset.title = template.origin === "git"
      ? "Drop the pin and restore the authored YAML seed"
      : "Only Git-origin templates can be reset";
    actions.append(save, reset);
    section.append(actions);

    if (runtimeState.editorMessage) {
      const msg = document.createElement("p");
      msg.className = "runtime-template-editor-message";
      msg.setAttribute("role", "status");
      msg.textContent = runtimeState.editorMessage;
      section.append(msg);
    }

    section.addEventListener("toggle", () => {
      runtimeState.editorOpen = section.open;
    });

    save.addEventListener("click", async () => {
      let definition;
      try {
        definition = JSON.parse(textarea.value);
      } catch (error) {
        runtimeState.editorMessage = `Invalid JSON: ${error.message || "parse failed"}`;
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
        return;
      }
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        runtimeState.editorMessage = "Definition must be a JSON object.";
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
        return;
      }
      runtimeState.editorBusy = true;
      runtimeState.editorMessage = "Saving pin…";
      runtimeState.editorOpen = true;
      renderTasksSurface(getAllDocuments(), "templates");
      try {
        const payload = await request(workApiUrl(`/api/templates/${encodeURIComponent(template.id)}`), {
          method: "PUT",
          body: JSON.stringify({
            definition,
            expectedVersion: template.version,
            revision: template.revision,
          }),
        });
        const next = payload?.template || payload;
        runtimeState.editorMessage =
          `Pinned ${next?.type || template.type} to version ${next?.version ?? "?"}. New cards use this definition.`;
        runtimeState.editorBusy = false;
        await refreshRuntimeTemplates({ force: true });
        if (next?.id) runtimeState.selectedId = next.id;
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
      } catch (error) {
        runtimeState.editorBusy = false;
        runtimeState.editorMessage = `Save failed: ${error.message || "request failed"}`;
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
      }
    });

    reset.addEventListener("click", async () => {
      if (!window.confirm("Reset this template to the Git YAML seed and drop the pin?")) return;
      runtimeState.editorBusy = true;
      runtimeState.editorMessage = "Resetting to Git base…";
      runtimeState.editorOpen = true;
      renderTasksSurface(getAllDocuments(), "templates");
      try {
        const payload = await request(workApiUrl(`/api/templates/${encodeURIComponent(template.id)}/reset`), {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: template.version,
            revision: template.revision,
          }),
        });
        const next = payload?.template || payload;
        runtimeState.editorMessage = payload?.applied === false
          ? "Already on the Git base."
          : `Reset ${next?.type || template.type} to the Git seed.`;
        runtimeState.editorBusy = false;
        await refreshRuntimeTemplates({ force: true });
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
      } catch (error) {
        runtimeState.editorBusy = false;
        runtimeState.editorMessage = `Reset failed: ${error.message || "request failed"}`;
        runtimeState.editorOpen = true;
        renderTasksSurface(getAllDocuments(), "templates");
      }
    });

    return section;
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
  // currently doing in the world. The chips above already carry the counts,
  // so the sentence says what to do about them, never the numbers again.
  function templateRowSummary(facts) {
    if (!facts.cards.length) return "New cards start from this revision.";
    if (facts.behind) return "Open it to review the behind cards for updates.";
    const used = relativeDayLabel(facts.lastUsed);
    return `All cards current${used ? ` · last used ${used}` : ""}.`;
  }

  // One fixed ordering: the Templates already carrying live work float up,
  // because that is where an operator returning to a run is looking.
  function orderedTemplates() {
    const facts = new Map(runtimeState.templates.map((template) => [template.id, templateFacts(template)]));
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
    return [...runtimeState.templates].sort((a, b) => {
      const left = facts.get(a.id);
      const right = facts.get(b.id);
      return right.behind - left.behind
        || right.cards.length - left.cards.length
        || String(right.lastUsed || "").localeCompare(String(left.lastUsed || ""))
        || byName(a, b);
    });
  }

  function batchPreviewSummary(preview) {
    const counts = preview?.counts || {};
    const changed = Number(counts.cardFields || 0)
      + Number(counts.added || 0)
      + Number(counts.updated || 0)
      + Number(counts.skipped || 0)
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
      const button = document.createElement("button");
      button.type = "button";
      const name = document.createElement("strong");
      name.textContent = card.title || card.id;
      const meta = document.createElement("span");
      meta.textContent = behind
        ? "Behind this revision"
        : `Current · ${countLabel(Number(card.openTaskCount || 0), "open task")}`;
      if (behind) meta.className = "is-attention";
      button.append(name, meta);
      button.addEventListener("click", () => {
        navigateCanonicalWorkspace("/cards", { cardId: card.id });
      });
      item.append(button);
      list.append(item);
    }
    if (facts.cards.length > shown.length) {
      const rest = document.createElement("li");
      rest.className = "runtime-template-live-cards-more";
      rest.textContent =
        `+${facts.cards.length - shown.length} more from this template`;
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
    title.textContent = "Live cards";
    const cards = cardsForTemplate(template.id);
    const count = document.createElement("span");
    count.textContent = countLabel(cards.length, "active card");
    heading.append(title, count);
    section.append(heading);
    if (!cards.length) {
      section.append(renderHonestState(
        "No active cards use this template",
        "New cards will start at the current authored revision.",
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
      guidance.textContent = "Preview current template differences, then select the cards to update.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-action-btn";
      button.textContent = `Review ${countLabel(cards.length, "card")} for updates`;
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
      : `Apply ${countLabel(selectedIds.size, "selected card")}`;
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
        ? `${countLabel(actionable, "card")} can be selected. Nothing is selected automatically.`
        : "Every reviewed card is current.";
    } catch (error) {
      runtimeState.batchReview = null;
      runtimeState.batchMessage = `Could not preview card updates: ${error.message || "request failed"}`;
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
    runtimeState.batchMessage = `Applying ${countLabel(updates.length, "reviewed card")}…`;
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
        `${countLabel(applied, "card")} applied`,
        conflicts ? `${countLabel(conflicts, "conflict")} needs a fresh preview` : "no conflicts",
      ].join(" · ");
      await refreshOperationsWorkSnapshot({ rerender: false });
    } catch (error) {
      runtimeState.batchMessage = `Could not apply reviewed cards: ${error.message || "request failed"}`;
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
