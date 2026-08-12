export function createCardsSurface(context) {
  const {
    cardsHeaderViewModel,
    countLabel,
    getActiveWorkspaceRoute,
    groupCardItemsByStage,
    isArchivedWorkBundle,
    navigateCanonicalWorkspace,
    openBundlePanel,
    openQuickWorkflowForm,
    operationItemFromBundle,
    renderHonestState,
    state,
    todayIsoDate,
  } = context;

  function renderWorkflowsSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-workflows-board";
    section.setAttribute("aria-labelledby", "workflow-board-title");
    const bundles = state.workSnapshot.activeBundles || [];
    const archivedCards = (state.workSnapshot.bundles || []).filter(
      isArchivedWorkBundle,
    );
    const archiveVisible = getActiveWorkspaceRoute()?.path === "/cards/archive";
    const displayedCards = archiveVisible ? archivedCards : bundles;
    const headerModel = cardsHeaderViewModel({
      archiveVisible,
      activeCount: bundles.length,
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
              state.workSnapshot.bundlesLoaded
                ? "Create a card from a Template when new work arrives."
                : "Live card data is unavailable.",
            ),
      );
      return section;
    }

    const today = todayIsoDate();
    if (archiveVisible) {
      const archiveGrid = document.createElement("div");
      archiveGrid.className = "cards-archive-grid";
      archiveGrid.setAttribute("aria-label", "Archived cards");
      for (const bundle of archivedCards) {
        const tasks = state.workSnapshot.bundleTasks[bundle.id] || [];
        const item = operationItemFromBundle(bundle, tasks, { today });
        archiveGrid.append(renderWorkflowSurfaceCard(item));
      }
      section.append(archiveGrid);
      return section;
    }

    const board = document.createElement("div");
    board.className = "ops-workflows-grid";
    board.setAttribute("aria-label", "Active card board");
    const items = bundles.map((bundle) => {
      const tasks = state.workSnapshot.bundleTasks[bundle.id] || [];
      return operationItemFromBundle(bundle, tasks, { today });
    });
    for (const { stage, label, items: stageItems } of groupCardItemsByStage(
      items,
    )) {
      const column = document.createElement("section");
      column.className = "workflow-board-column";
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

  function renderWorkflowSurfaceCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `ops-workflow-card workflow-board-card ops-risk-${item.risk || "low"}`;
    card.dataset.bundleId = item.bundleId;
    card.addEventListener("click", () => openBundlePanel(item.bundleId));
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("small");
    meta.textContent = item.meta || "";
    card.append(title);
    if (item.progress) {
      const progress = document.createElement("div");
      progress.className = "ops-progress";
      const fill = document.createElement("i");
      fill.style.width = `${item.progress.percent || 0}%`;
      progress.append(fill);
      card.append(progress);
    }
    card.append(meta);
    return card;
  }

  return { renderWorkflowsSurface };
}
