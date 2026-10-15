import "../../dakit/collection.js";
import { cardKind } from "../../core/card-kind.js";
import { renderIcon } from "../../core/icons.js";
import { createPageHeader } from "../operations-overview.js";

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
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = archiveVisible
      ? "quiet-button"
      : "quiet-button workflow-archive-toggle";
    archive.textContent = headerModel.archiveAction;
    archive.setAttribute("aria-label", headerModel.archiveAction);
    archive.setAttribute("aria-pressed", String(archiveVisible));
    archive.addEventListener("click", () =>
      navigateCanonicalWorkspace(headerModel.archiveRoute),
    );
    // Board actions live in the toolbar directly above the columns: create
    // first, next to the filter it honours, the Archive switch trailing.
    archive.classList.add("workflow-board-toolbar-trail");
    const header = createPageHeader({
      title: headerModel.title,
      subtitle: archiveVisible || cards.length > 0 ? headerModel.summary : "",
      titleId: "workflow-board-title",
      className: "workflow-board-header",
    });
    section.append(header);

    if (displayedCards.length === 0 && !archiveVisible) {
      section.append(renderBoardToolbar(new Set(), archive));
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
      // Done/Parked narrows one archive list: a single-choice filter, so the
      // dakit segmented control as a radiogroup (docs/segmented.md).
      const wrap = document.createElement("div");
      wrap.className = "workflow-archive-tabs";
      const tabs = document.createElement("div");
      tabs.className = "dk-tabs";
      tabs.setAttribute("role", "radiogroup");
      tabs.setAttribute("aria-label", "Archive categories");
      for (
        const [category, label, count] of [
          ["done", "Done", archivedCards.length],
          ["parked", "Parked", parkedCards.length],
        ]
      ) {
        const checked = archiveCategory === category;
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "dk-tab archive-category-tab";
        tab.setAttribute("role", "radio");
        tab.setAttribute("aria-checked", String(checked));
        tab.tabIndex = checked ? 0 : -1;
        const quantity = document.createElement("span");
        quantity.className = "dk-count";
        quantity.textContent = String(count);
        tab.append(document.createTextNode(label), quantity);
        tab.addEventListener("click", () => {
          if (archiveCategory !== category) {
            archiveCategory = category;
            refreshDocuments();
          }
        });
        tabs.append(tab);
      }
      wrap.append(tabs);
      return wrap;
    }

    const today = todayIsoDate();
    if (archiveVisible) {
      const toolbar = document.createElement("div");
      toolbar.className = "workflow-board-filters";
      toolbar.append(renderArchiveCategoryTabs(), archive);
      section.append(toolbar);
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
    section.append(renderBoardToolbar(templateIds, archive));
    section.append(renderWorkflowBoard(visibleItems));
    return section;
  }

  // The work snapshot already carries the Template listing; the board's own
  // fetch only fills in when the snapshot has none.
  function templateMeta(templateId) {
    const meta = templateLabels.get(templateId);
    if (meta) return { id: templateId, ...meta };
    const template = (state.workSnapshot.templates || []).find(
      (candidate) => String(candidate?.id) === templateId,
    );
    return template
      ? {
          id: templateId,
          name: String(template.name || template.id),
          icon: String(template.icon || ""),
          type: String(template.type || ""),
        }
      : null;
  }

  function templateLabel(templateId) {
    return (
      templateMeta(templateId)?.name || `Template ${templateId.slice(0, 8)}`
    );
  }

  function renderBoardToolbar(templateIds, archive) {
    const toolbar = document.createElement("div");
    toolbar.className = "workflow-board-filters";
    // Without templated cards there is nothing to filter on, so the toolbar
    // carries only its actions rather than an always-empty select.
    if (templateIds.size > 0) toolbar.append(renderTemplateFilter(templateIds));
    // A filtered board creates into the Template it shows.
    toolbar.append(
      globalThis.dakitCollection.createButton({
        label: "Create card",
        onClick: () => openQuickWorkflowForm(
          templateFilter
            ? { template: templateMeta(templateFilter) || { id: templateFilter } }
            : undefined,
        ),
      }),
      archive,
    );
    return toolbar;
  }

  function renderTemplateFilter(templateIds) {
    const options = [...templateIds].sort((a, b) =>
      templateLabel(a).localeCompare(templateLabel(b)),
    );
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
    if (!templateLabelsRequested) {
      templateLabelsRequested = true;
      loadTemplateLabels();
    }
    return label;
  }

  // Display names (and badge icons) come from the same /api/templates
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
            icon: String(template.icon || ""),
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

  function nextTaskLabel(progress) {
    const next = progress?.nextDueTask;
    if (!next) return "";
    const title =
      typeof next === "string"
        ? next
        : next.description || next.title || "";
    return String(title || "").trim();
  }

  function renderWorkflowSurfaceCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `ops-workflow-card workflow-board-card ops-risk-${item.risk || "low"}`;
    card.dataset.cardId = item.cardId;
    // Cards made before Templates (the Trello import) name their kind with a
    // type tag; the badge then points at that kind's Template.
    const kind = item.templateId
      ? null
      : cardKind(state.workSnapshot.cardsById?.get(item.cardId), state.workSnapshot.templates);
    const templateId = String(item.templateId || kind?.templateId || "");
    const template = templateId ? templateMeta(templateId) : null;
    const templateName = item.templateId ? templateLabel(templateId) : kind?.name || "";
    card.setAttribute(
      "aria-label",
      templateName ? `Open ${templateName} card ${item.title}` : `Open card ${item.title}`,
    );
    if (item.meta) card.title = item.meta;
    card.addEventListener("click", () => openCardPanel(item.cardId));

    // One row opens the tile: where the card comes from (its Template badge),
    // when it is anchored, then progress at the far end. The badge replaces
    // the legacy `[Tag]` title prefix and opens its Template on click; its
    // name is what truncates when the column is narrow; only in a column too
    // narrow for the badge icon and the date does the count drop a line.
    const header = document.createElement("span");
    header.className = "workflow-card-header";
    const lead = document.createElement("span");
    lead.className = "workflow-card-lead";
    if (templateId) {
      const badge = document.createElement("span");
      badge.className = "workflow-card-template";
      if (template?.type) badge.dataset.templateType = template.type;
      const badgeLabel = document.createElement("span");
      badgeLabel.className = "workflow-card-template-label";
      badgeLabel.textContent = templateName;
      badge.append(
        renderIcon(template?.icon || kind?.icon || "card", { size: 14 }),
        badgeLabel,
      );
      badge.title = `View ${templateName} template`;
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        navigateCanonicalWorkspace("/templates", { templateId });
      });
      lead.append(badge);
    }
    if (item.anchorLabel) {
      const anchor = document.createElement("span");
      anchor.className = `workflow-card-anchor is-${item.anchorTone || "upcoming"}`;
      anchor.dataset.anchorDate = item.anchorDate || "";
      anchor.setAttribute(
        "aria-label",
        `Card date ${item.anchorDate || item.anchorLabel}`,
      );
      anchor.textContent = item.anchorLabel;
      lead.append(anchor);
    }
    if (item.issueNumber) {
      const issue = document.createElement("span");
      issue.className = "workflow-card-issue";
      issue.textContent = `#${String(item.issueNumber).replace(/^/, "")}`;
      issue.title = `Issue #${String(item.issueNumber).replace(/^/, "")}`;
      lead.append(issue);
    }
    if (lead.children.length > 0) header.append(lead);
    const countLabelText = cardTaskCountLabel(item.progress);
    if (countLabelText) {
      const count = document.createElement("span");
      count.className = "workflow-card-count";
      count.textContent = countLabelText;
      header.append(count);
    }
    if (header.children.length > 0) card.append(header);

    const title = document.createElement("strong");
    title.className = "workflow-card-title";
    title.textContent = item.title;
    card.append(title);

    if (item.subtitle) {
      const subtitle = document.createElement("span");
      subtitle.className = "workflow-card-subtitle";
      subtitle.textContent = item.subtitle;
      card.append(subtitle);
    }

    if (item.taskRelationshipsComplete === false) {
      const unavailable = document.createElement("span");
      unavailable.className = "workflow-card-count";
      unavailable.textContent = "Task relationships unavailable";
      card.append(unavailable);
    }

    const nextLabel = nextTaskLabel(item.progress);
    if (nextLabel) {
      const next = document.createElement("span");
      next.className = "workflow-card-next";
      next.textContent = `Next: ${nextLabel}`;
      next.title = next.textContent;
      card.append(next);
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
