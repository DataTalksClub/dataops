export function createCardsSurface(context) {
  const {
    cardsHeaderViewModel,
    countLabel,
    getActiveWorkspaceRoute,
    groupCardItemsByMonth,
    groupCardItemsByStage,
    isArchivedWorkCard,
    isParkedWorkCard,
    navigateCanonicalWorkspace,
    openCardPanel,
    openQuickWorkflowForm,
    operationItemFromCard,
    refreshDocuments,
    renderHonestState,
    request,
    state,
    todayIsoDate,
    workApiUrl,
  } = context;

  // The template filter lives in this closure because the surface object is
  // created once per session: snapshot re-renders rebuild the DOM, not the
  // filter memory. An empty value means every card is shown.
  let templateFilter = "";
  let templateLabels = new Map();
  let templateLabelsRequested = false;
  // The Archive view holds two categories: done Cards and parked Cards with
  // open work remaining. The selected tab survives re-renders like the filter.
  let archiveCategory = "done";

  function renderWorkflowsSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-workflows-board";
    section.setAttribute("aria-labelledby", "workflow-board-title");
    const cards = state.workSnapshot.activeCards || [];
    const archivedCards = (state.workSnapshot.cards || []).filter(
      isArchivedWorkCard,
    );
    const parkedCards = (state.workSnapshot.cards || []).filter(
      isParkedWorkCard,
    );
    const archiveVisible = getActiveWorkspaceRoute()?.path === "/cards/archive";
    const archiveCards = archiveCategory === "parked" ? parkedCards : archivedCards;
    const displayedCards = archiveVisible ? archiveCards : cards;
    const headerModel = cardsHeaderViewModel({
      archiveVisible,
      activeCount: cards.length,
      archivedCount: archivedCards.length,
      parkedCount: parkedCards.length,
    });
    const header = document.createElement("header");
    header.className = "workflow-board-header";
    const heading = document.createElement("div");
    const title = document.createElement("h1");
    title.id = "workflow-board-title";
    title.textContent = headerModel.title;
    heading.append(title);
    // An empty board states its emptiness once, in the panel below; a
    // "0 active cards" meta line would only restate it.
    if (archiveVisible || cards.length > 0) {
      const summary = document.createElement("p");
      summary.textContent = headerModel.summary;
      heading.append(summary);
    }
    const actions = document.createElement("div");
    actions.className = "workflow-board-actions";
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "quiet-button";
    archive.textContent = headerModel.archiveAction;
    archive.setAttribute("aria-pressed", String(archiveVisible));
    archive.addEventListener("click", () =>
      navigateCanonicalWorkspace(headerModel.archiveRoute),
    );
    const start = document.createElement("button");
    start.type = "button";
    start.className = "primary-button";
    start.textContent = "Create card";
    start.addEventListener("click", () => openQuickWorkflowForm());
    actions.append(archive);
    if (headerModel.createVisible) actions.append(start);
    header.append(heading, actions);
    section.append(header);

    if (displayedCards.length === 0 && !archiveVisible) {
      const sourceComplete =
        state.workSnapshot.cardsComplete === true;
      const loaded = Boolean(state.workSnapshot.cardsLoaded);
      // The honest state is the board's one empty statement; empty stage
      // columns would only restate it per column.
      section.append(
        renderHonestState(
          sourceComplete ? "No active cards" : "Card availability is unknown",
          sourceComplete
            ? "Create a card from a Template when new work arrives."
            : loaded
              ? "The loaded page has no active Cards, but remaining pages have not been evaluated."
              : "Live card data is unavailable.",
        ),
      );
      return section;
    }

    function renderArchiveCategoryTabs() {
      const tabs = document.createElement("div");
      tabs.className = "workflow-archive-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Archive categories");
      for (
        const [category, label, count] of [
          ["done", "Done", archivedCards.length],
          ["parked", "Parked", parkedCards.length],
        ]
      ) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "archive-category-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(archiveCategory === category));
        tab.textContent = `${label} (${count})`;
        tab.addEventListener("click", () => {
          if (archiveCategory !== category) {
            archiveCategory = category;
            refreshDocuments();
          }
        });
        tabs.append(tab);
      }
      return tabs;
    }

    const today = todayIsoDate();
    if (archiveVisible) {
      section.append(renderArchiveCategoryTabs());
      const parked = archiveCategory === "parked";
      if (archiveCards.length === 0) {
        const sourceComplete =
          state.workSnapshot.cardsComplete === true;
        section.append(
          renderHonestState(
            sourceComplete
              ? parked ? "No parked cards" : "Archive is empty"
              : "Archive availability is unknown",
            sourceComplete
              ? parked
                ? "Cards appear here after an active Card is parked. Resume returns them to the board."
                : "Cards appear here after all of their Tasks are complete."
              : `Card collection data is incomplete, so remaining ${parked ? "parked" : "archived"} Cards cannot be ruled out.`,
          ),
        );
        return section;
      }
      const archiveItems = archiveCards.map((card) =>
        operationItemFromCard(
          card,
          state.workSnapshot.cardTasks[card.id] || [],
          {
            today,
            cardTasksComplete:
              state.workSnapshot.cardTasksComplete !== false,
          },
        ),
      );
      for (const group of groupCardItemsByMonth(archiveItems, parked ? "anchorDate" : "completedAt")) {
        const month = document.createElement("section");
        month.className = "cards-archive-month";
        const monthTitle = document.createElement("h3");
        monthTitle.className = "cards-archive-month-title";
        monthTitle.id = `cards-archive-${group.key}`;
        monthTitle.textContent = group.label;
        const monthCount = document.createElement("span");
        monthCount.textContent = countLabel(group.items.length, "card");
        monthTitle.append(monthCount);
        month.setAttribute("aria-labelledby", monthTitle.id);
        const archiveGrid = document.createElement("div");
        archiveGrid.className = "cards-archive-grid";
        for (const item of group.items)
          archiveGrid.append(renderWorkflowSurfaceCard(item));
        month.append(monthTitle, archiveGrid);
        section.append(month);
      }
      return section;
    }

    const boardItems = cards.map((card) => {
      const tasks = state.workSnapshot.cardTasks[card.id] || [];
      return operationItemFromCard(card, tasks, {
        today,
        cardTasksComplete:
          state.workSnapshot.cardTasksComplete !== false,
      });
    });
    // A Card's Template is the parent it was instantiated from; the board
    // renders derived items, so the template reference rides along by id.
    const templateIds = new Set(
      cards.map((card) => String(card?.templateId || "")).filter(Boolean),
    );
    // A filter whose Template no longer backs any Card heals back to "all"
    // before it can blank the board.
    if (templateFilter && !templateIds.has(templateFilter)) {
      templateFilter = "";
    }
    const templateByCardId = new Map(
      cards
        .filter((card) => card && card.id)
        .map((card) => [card.id, String(card.templateId || "")]),
    );
    const visibleItems = templateFilter
      ? boardItems.filter(
          (item) => templateByCardId.get(item.cardId) === templateFilter,
        )
      : boardItems;
    const filterBar = renderTemplateFilterBar(templateIds, {
      shown: visibleItems.length,
      total: boardItems.length,
    });
    if (filterBar) section.append(filterBar);
    section.append(renderWorkflowBoard(visibleItems));
    return section;
  }

  function templateMeta(templateId) {
    const meta = templateLabels.get(templateId);
    return meta ? { id: templateId, ...meta } : null;
  }

  function templateLabel(templateId) {
    return (
      templateMeta(templateId)?.name || `Template ${templateId.slice(0, 8)}`
    );
  }

  function renderTemplateFilterBar(templateIds, counts) {
    const options = [...templateIds].sort((a, b) =>
      templateLabel(a).localeCompare(templateLabel(b)),
    );
    // Without templated cards there is nothing to filter on, so the board
    // renders without the control rather than as an always-empty select.
    if (options.length === 0) return null;
    const filters = document.createElement("div");
    filters.className = "workflow-board-filters";
    const label = document.createElement("label");
    label.className = "workflow-board-filter";
    const name = document.createElement("span");
    name.textContent = "Template";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Filter cards by template");
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All templates";
    select.append(all);
    for (const id of options) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = templateLabel(id);
      select.append(option);
    }
    select.value = templateFilter;
    select.addEventListener("change", () => {
      templateFilter = select.value;
      refreshDocuments();
    });
    label.append(name, select);
    filters.append(label);
    if (templateFilter) {
      const newCardBtn = document.createElement("button");
      newCardBtn.type = "button";
      newCardBtn.className = "workflow-board-filter-action";
      newCardBtn.textContent = "+ New card from template";
      newCardBtn.addEventListener("click", () => {
        openQuickWorkflowForm({
          template: templateMeta(templateFilter) || { id: templateFilter },
        });
      });
      filters.append(newCardBtn);

      const shown = document.createElement("span");
      shown.className = "workflow-board-filter-count";
      shown.textContent = `${countLabel(counts.shown, "card")} of ${counts.total} shown`;
      filters.append(shown);
    }
    if (!templateLabelsRequested) {
      templateLabelsRequested = true;
      loadTemplateLabels();
    }
    return filters;
  }

  // Display names (and badge emoji) come from the same /api/templates
  // listing the create-card form uses. Until it answers, options fall back
  // to a short id; one refresh swaps the labels in when the listing arrives.
  async function loadTemplateLabels() {
    let payload;
    try {
      payload = await request(workApiUrl("/api/templates"));
    } catch {
      return;
    }
    const templates = Array.isArray(payload)
      ? payload
      : payload?.templates || [];
    const next = new Map(
      templates
        .filter((template) => template && template.id)
        .map((template) => [
          String(template.id),
          {
            id: String(template.id),
            name: String(template.name || template.title || template.id),
            emoji: String(template.emoji || ""),
            type: String(template.type || ""),
          },
        ]),
    );
    const improved = [...next].some(
      ([id, meta]) => templateLabels.get(id)?.name !== meta.name,
    );
    templateLabels = next;
    if (improved) refreshDocuments();
  }

  function renderWorkflowBoard(items) {
    const board = document.createElement("div");
    board.className = "ops-workflows-grid";
    // The board scrolls sideways on narrow screens; a focusable region lets
    // keyboard users reach every stage column with the arrow keys.
    board.setAttribute("role", "region");
    board.setAttribute("aria-label", "Active card board");
    board.tabIndex = 0;
    const scrollHint = document.createElement("p");
    scrollHint.className = "workflow-board-scroll-hint";
    scrollHint.textContent = "Swipe horizontally to view each stage.";
    board.append(scrollHint);
    for (const { stage, label, items: stageItems } of groupCardItemsByStage(
      items,
    )) {
      const column = document.createElement("section");
      column.className = "workflow-board-column";
      column.dataset.stage = stage;
      column.setAttribute("aria-labelledby", `workflow-column-${stage}`);
      const columnHeader = document.createElement("header");
      columnHeader.className = "workflow-column-header";
      const columnTitle = document.createElement("h3");
      columnTitle.id = `workflow-column-${stage}`;
      columnTitle.textContent = label;
      const columnCount = document.createElement("span");
      columnCount.textContent = String(stageItems.length);
      columnCount.setAttribute(
        "aria-label",
        countLabel(stageItems.length, "card"),
      );
      columnHeader.append(columnTitle, columnCount);
      const list = document.createElement("div");
      list.className = "workflow-board-list";
      // The column count in the header already says zero; a sentence per
      // empty column restates the board-level empty state six times.
      if (stageItems.length > 0) {
        for (const item of stageItems)
          list.append(renderWorkflowSurfaceCard(item));
      }
      column.append(columnHeader, list);
      board.append(column);
    }
    return board;
  }

  function cardTaskCountLabel(progress) {
    if (!progress || typeof progress.total !== "number") return "";
    if (progress.total === 0) return "No tasks loaded";
    return `${progress.done || 0}/${progress.total} tasks`;
  }

  function cardFlags(progress) {
    if (!progress) return [];
    const flags = [
      { count: progress.overdue, label: "overdue", tone: "danger" },
      { count: progress.waiting, label: "waiting", tone: "waiting" },
      { count: progress.missingProof, label: "missing proof", tone: "warning" },
    ].filter((flag) => Number(flag.count) > 0);
    if (Number(progress.total) > 0 && Number(progress.percent) >= 100) {
      flags.push({ count: 0, label: "completion", tone: "success" });
    }
    return flags;
  }

  function renderWorkflowSurfaceCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `ops-workflow-card workflow-board-card ops-risk-${item.risk || "low"}`;
    card.dataset.cardId = item.cardId;
    const templateId = String(item.templateId || "");
    const template = templateId ? templateMeta(templateId) : null;
    const templateName = templateId ? templateLabel(templateId) : "";
    card.setAttribute(
      "aria-label",
      templateName ? `Open ${templateName} card ${item.title}` : `Open card ${item.title}`,
    );
    if (item.meta) card.title = item.meta;
    card.addEventListener("click", () => openCardPanel(item.cardId));

    // The Template badge replaces the legacy `[Tag]` title prefix: the card
    // shows which Template it was created from, and opens it on click.
    if (templateId) {
      const badge = document.createElement("span");
      badge.className = "workflow-card-template";
      if (template?.type) badge.dataset.templateType = template.type;
      badge.textContent = template?.emoji
        ? `${template.emoji} ${templateName}`
        : templateName;
      badge.title = `View ${templateName} template`;
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        navigateCanonicalWorkspace("/templates", { templateId });
      });
      card.append(badge);
    }

    const header = document.createElement("span");
    header.className = "workflow-card-header";
    let headerFilled = false;
    if (item.anchorLabel) {
      const anchor = document.createElement("span");
      anchor.className = `workflow-card-anchor is-${item.anchorTone || "upcoming"}`;
      anchor.dataset.anchorDate = item.anchorDate || "";
      anchor.setAttribute(
        "aria-label",
        `Card date ${item.anchorDate || item.anchorLabel}`,
      );
      anchor.textContent = item.anchorLabel;
      header.append(anchor);
      headerFilled = true;
    }
    const countLabelText = cardTaskCountLabel(item.progress);
    if (countLabelText) {
      const count = document.createElement("span");
      count.className = "workflow-card-count";
      count.textContent = countLabelText;
      header.append(count);
      headerFilled = true;
    }
    if (headerFilled) card.append(header);

    const title = document.createElement("strong");
    title.className = "workflow-card-title";
    title.textContent = item.title;
    card.append(title);

    if (item.taskRelationshipsComplete === false) {
      const unavailable = document.createElement("span");
      unavailable.className = "workflow-card-count";
      unavailable.textContent = "Task relationships unavailable";
      card.append(unavailable);
    }

    if (item.progress) {
      const percent = Number(item.progress.percent) || 0;
      const progress = document.createElement("div");
      progress.className = `ops-progress${percent >= 100 ? " is-complete" : ""}`;
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", `${item.title} progress`);
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(percent));
      const fill = document.createElement("i");
      fill.style.width = `${percent}%`;
      progress.append(fill);
      card.append(progress);
    }

    const flags = cardFlags(item.progress);
    if (flags.length > 0) {
      const flagRow = document.createElement("small");
      flagRow.className = "workflow-card-flags";
      for (const flag of flags) {
        const chip = document.createElement("span");
        chip.className = `workflow-card-flag is-${flag.tone}`;
        chip.textContent = Number(flag.count) > 0
          ? `${flag.count} ${flag.label}`
          : flag.label;
        flagRow.append(chip);
      }
      card.append(flagRow);
    }
    return card;
  }

  return { renderWorkflowsSurface };
}
