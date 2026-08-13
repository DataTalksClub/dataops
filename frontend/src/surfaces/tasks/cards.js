export function createCardsSurface(context) {
  const {
    cardsHeaderViewModel,
    countLabel,
    getActiveWorkspaceRoute,
    groupCardItemsByMonth,
    groupCardItemsByStage,
    isArchivedWorkCard,
    navigateCanonicalWorkspace,
    openCardPanel,
    openQuickWorkflowForm,
    operationItemFromCard,
    renderHonestState,
    state,
    todayIsoDate,
  } = context;

  function renderWorkflowsSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-workflows-board";
    section.setAttribute("aria-labelledby", "workflow-board-title");
    const cards = state.workSnapshot.activeCards || [];
    const archivedCards = (state.workSnapshot.cards || []).filter(
      isArchivedWorkCard,
    );
    const archiveVisible = getActiveWorkspaceRoute()?.path === "/cards/archive";
    const displayedCards = archiveVisible ? archivedCards : cards;
    const headerModel = cardsHeaderViewModel({
      archiveVisible,
      activeCount: cards.length,
      archivedCount: archivedCards.length,
    });
    const header = document.createElement("header");
    header.className = "workflow-board-header";
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.className = "workflow-board-eyebrow";
    eyebrow.textContent = headerModel.eyebrow;
    const title = document.createElement("h2");
    title.id = "workflow-board-title";
    title.textContent = headerModel.title;
    const summary = document.createElement("p");
    summary.textContent = headerModel.summary;
    heading.append(eyebrow, title, summary);
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

    if (displayedCards.length === 0) {
      section.append(
        archiveVisible
          ? renderHonestState(
              "Archive is empty",
              "Cards appear here after all of their Tasks are complete.",
            )
          : renderHonestState(
              "No active cards",
              state.workSnapshot.cardsLoaded
                ? "Create a card from a Template when new work arrives."
                : "Live card data is unavailable.",
            ),
      );
      return section;
    }

    const today = todayIsoDate();
    if (archiveVisible) {
      const archiveItems = archivedCards.map((card) =>
        operationItemFromCard(
          card,
          state.workSnapshot.cardTasks[card.id] || [],
          { today },
        ),
      );
      for (const group of groupCardItemsByMonth(archiveItems)) {
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

    const board = document.createElement("div");
    board.className = "ops-workflows-grid";
    board.setAttribute("aria-label", "Active card board");
    const items = cards.map((card) => {
      const tasks = state.workSnapshot.cardTasks[card.id] || [];
      return operationItemFromCard(card, tasks, { today });
    });
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
      if (stageItems.length === 0) {
        const empty = document.createElement("p");
        empty.className = "workflow-column-empty";
        empty.textContent = "No cards";
        list.append(empty);
      } else {
        for (const item of stageItems)
          list.append(renderWorkflowSurfaceCard(item));
      }
      column.append(columnHeader, list);
      board.append(column);
    }
    section.append(board);
    return section;
  }

  function cardTaskCountLabel(progress) {
    if (!progress || typeof progress.total !== "number") return "";
    if (progress.total === 0) return "No tasks loaded";
    return `${progress.done || 0}/${progress.total} tasks`;
  }

  function cardFlags(progress) {
    if (!progress) return [];
    return [
      { count: progress.overdue, label: "overdue", tone: "danger" },
      { count: progress.waiting, label: "waiting", tone: "info" },
      { count: progress.missingProof, label: "missing proof", tone: "warning" },
    ].filter((flag) => Number(flag.count) > 0);
  }

  function renderWorkflowSurfaceCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `ops-workflow-card workflow-board-card ops-risk-${item.risk || "low"}`;
    card.dataset.cardId = item.cardId;
    if (item.meta) card.title = item.meta;
    card.addEventListener("click", () => openCardPanel(item.cardId));

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

    if (item.progress) {
      const percent = Number(item.progress.percent) || 0;
      const progress = document.createElement("div");
      progress.className = `ops-progress${percent >= 100 ? " is-complete" : ""}`;
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
        chip.textContent = `${flag.count} ${flag.label}`;
        flagRow.append(chip);
      }
      card.append(flagRow);
    }
    return card;
  }

  return { renderWorkflowsSurface };
}
