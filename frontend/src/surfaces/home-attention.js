// Presentation state survives Home rerenders and task-detail round trips.
export function createHomeAttentionView({
  activeWorkOwnerId,
  buildHomeAttentionItems,
  formatHomeTaskTiming,
  navigateCanonicalWorkspace,
  openTaskPanel,
  renderHonestState,
  resolveCardLabel,
}) {
  const expandedAttentionOwners = new Set();
  function renderHomeAttentionQueue(model) {
    const section = document.createElement("section");
    section.className = "home-attention";
    section.setAttribute("aria-labelledby", "home-attention-title");

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.id = "home-attention-title";
    title.textContent = "Needs your attention";
    header.append(title);
    section.append(header);

    const items = buildHomeAttentionItems(model);
    const ownerId = activeWorkOwnerId();
    const expanded = expandedAttentionOwners.has(ownerId);
    const count = document.createElement("p");
    count.className = "home-attention-count";
    count.setAttribute("aria-live", "polite");
    const complete = model.stats.todayLoaded && model.stats.overdueLoaded &&
      model.stats.waitingLoaded && model.stats.missingProofLoaded;
    const updateCount = (shown) => {
      count.textContent = `${shown} of ${items.length}${complete ? "" : " loaded"} attention items`;
    };
    updateCount(expanded ? items.length : Math.min(items.length, 6));
    header.append(count);
    let list;
    if (items.length === 0) {
      const empty = renderHonestState(
        model.stats.missingProofLoaded
          ? "No work needs your attention"
          : "Action queue unavailable",
        model.stats.missingProofLoaded
          ? "Nothing is overdue, due for follow-up, due today, or waiting on proof."
          : "Task data is still loading or unavailable; no false work items are shown.",
      );
      empty.classList.add("home-attention-empty");
      section.append(empty);
    } else {
      list = document.createElement("ul");
      list.id = "home-attention-list";
      list.className = "home-attention-list";
      for (const item of expanded ? items : items.slice(0, 6))
        list.append(renderHomeAttentionItem(item, model.today));
      section.append(list);
    }

    const footer = document.createElement("footer");
    if (items.length > 6) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "home-attention-expand home-quick-action";
      reveal.setAttribute("aria-controls", "home-attention-list");
      reveal.setAttribute("aria-expanded", String(expanded));
      reveal.textContent = expanded ? "Show fewer" : `Show ${items.length - 6} more`;
      reveal.addEventListener("click", () => {
        const shouldExpand = !expandedAttentionOwners.has(ownerId);
        if (shouldExpand) expandedAttentionOwners.add(ownerId);
        else expandedAttentionOwners.delete(ownerId);
        list.replaceChildren(...(shouldExpand ? items : items.slice(0, 6))
          .map((item) => renderHomeAttentionItem(item, model.today)));
        reveal.setAttribute("aria-expanded", String(shouldExpand));
        reveal.textContent = shouldExpand ? "Show fewer" : `Show ${items.length - 6} more`;
        updateCount(shouldExpand ? items.length : 6);
        // Start keyboard users at the first newly revealed task. The collapse
        // control stays mounted so collapsing never discards focused controls.
        if (shouldExpand) list.children[6].querySelector("button").focus();
      });
      footer.append(reveal);
    }
    const allTasks = document.createElement("button");
    allTasks.type = "button";
    allTasks.className = "home-view-all";
    allTasks.textContent = "View all tasks";
    allTasks.addEventListener(
      "click",
      () => navigateCanonicalWorkspace("/tasks").ready,
    );
    footer.append(allTasks);
    section.append(footer);
    return section;
  }

  function renderHomeAttentionItem(item, today) {
    const row = document.createElement("li");
    row.className = `home-attention-row home-attention-${item.priority}`;

    const marker = document.createElement("span");
    marker.className = "home-task-marker";
    marker.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "home-task-content";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const workflow = document.createElement("span");
    workflow.className = "home-task-workflow";
    workflow.textContent = item.cardId
      ? resolveCardLabel(item.cardId)
      : "Independent task";
    content.append(title, workflow);

    const state = document.createElement("div");
    state.className = "home-task-state";
    const timing = document.createElement("time");
    const timingDate =
      item.priority === "follow-up"
        ? item.followUpDate
        : item.dueDate || item.followUpDate;
    if (timingDate) timing.dateTime = timingDate;
    timing.textContent = formatHomeTaskTiming(item, today);
    state.append(timing);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "home-task-action";
    action.dataset.taskId = item.taskId;
    action.textContent = homeTaskActionLabel(item.nextAction);
    action.setAttribute("aria-label", `${action.textContent}: ${item.title}`);
    action.addEventListener("click", () => openTaskPanel(item.taskId));

    row.append(marker, content, state, action);
    return row;
  }

  function homeTaskActionLabel(value) {
    const label = String(value || "Open").trim();
    if (/^add /i.test(label)) return "Add proof";
    if (/^mark (done|response received)$/i.test(label)) return "Open";
    return label;
  }
  return { renderHomeAttentionQueue };
}
