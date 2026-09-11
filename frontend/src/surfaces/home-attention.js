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
  const COLLAPSED_ROW_COUNT = 6;

  function renderHomeAttentionQueue(model) {
    const section = document.createElement("section");
    section.className = "home-attention";
    section.setAttribute("aria-labelledby", "home-attention-title");

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.id = "home-attention-title";
    title.textContent = "Needs your attention";
    header.append(title);

    const items = buildHomeAttentionItems(model);
    const ownerId = activeWorkOwnerId();
    const expanded = expandedAttentionOwners.has(ownerId);
    const count = document.createElement("p");
    count.className = "home-attention-count";
    count.setAttribute("aria-live", "polite");
    const complete = model.stats.todayLoaded && model.stats.overdueLoaded &&
      model.stats.waitingLoaded && model.stats.missingProofLoaded;
    // Honest shown/total: the operator sees how much of the queue is on
    // screen, and an incomplete queue never reads as the whole queue.
    const updateCount = (shown) => {
      count.textContent = `Showing ${shown} of ${items.length}${
        complete ? "" : " loaded"
      }`;
    };
    updateCount(expanded ? items.length : Math.min(items.length, COLLAPSED_ROW_COUNT));
    header.append(count);
    section.append(header);
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
      for (const item of expanded
        ? items
        : items.slice(0, COLLAPSED_ROW_COUNT))
        list.append(renderHomeAttentionItem(item, model));
      section.append(list);
    }

    const footer = document.createElement("footer");
    if (items.length > COLLAPSED_ROW_COUNT) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "home-attention-expand home-quick-action";
      reveal.setAttribute("aria-controls", "home-attention-list");
      reveal.setAttribute("aria-expanded", String(expanded));
      reveal.textContent = expanded
        ? "Show fewer"
        : `Show ${items.length - COLLAPSED_ROW_COUNT} more`;
      reveal.addEventListener("click", () => {
        const shouldExpand = !expandedAttentionOwners.has(ownerId);
        if (shouldExpand) expandedAttentionOwners.add(ownerId);
        else expandedAttentionOwners.delete(ownerId);
        list.replaceChildren(...(shouldExpand
          ? items
          : items.slice(0, COLLAPSED_ROW_COUNT))
          .map((item) => renderHomeAttentionItem(item, model)));
        reveal.setAttribute("aria-expanded", String(shouldExpand));
        reveal.textContent = shouldExpand
          ? "Show fewer"
          : `Show ${items.length - COLLAPSED_ROW_COUNT} more`;
        updateCount(shouldExpand ? items.length : COLLAPSED_ROW_COUNT);
        // Start keyboard users at the first newly revealed task. The collapse
        // control stays mounted so collapsing never discards focused controls.
        if (shouldExpand) {
          list.children[COLLAPSED_ROW_COUNT].querySelector("button").focus();
        }
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

  function renderHomeAttentionItem(item, model) {
    const row = document.createElement("li");
    row.className = `home-attention-row home-attention-${item.priority}`;

    const marker = document.createElement("span");
    marker.className = "home-task-marker";
    marker.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "home-task-content";
    const title = document.createElement("strong");
    title.textContent = item.title;
    content.append(title);
    const context = homeTaskContext(item, model);
    if (context) {
      const contextLine = document.createElement("span");
      contextLine.className = "home-task-context";
      contextLine.textContent = context;
      content.append(contextLine);
    }

    const card = document.createElement("span");
    card.className = "home-task-card";
    card.textContent = item.cardId ? resolveCardLabel(item.cardId) : "—";

    const state = document.createElement("div");
    state.className = "home-task-state";
    const timing = document.createElement("time");
    const timingDate =
      item.priority === "follow-up"
        ? item.followUpDate
        : item.dueDate || item.followUpDate;
    if (timingDate) timing.dateTime = timingDate;
    timing.textContent = homeTaskTimingText(item, model.today);
    state.append(timing);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "home-task-action";
    action.dataset.taskId = item.taskId;
    action.textContent = homeTaskActionLabel(item.nextAction);
    action.setAttribute("aria-label", `${action.textContent}: ${item.title}`);
    action.addEventListener("click", () => openTaskPanel(item.taskId));

    row.append(marker, content, card, state, action);
    return row;
  }

  // The context line says whose work this is and what is blocking it, in the
  // operator's language — never a state code or a request path.
  function homeTaskContext(item, model) {
    const parts = [];
    if (item.summary?.startsWith("Waiting for ")) {
      parts.push(
        `Waiting on ${
          item.summary.slice("Waiting for ".length).split(";")[0].trim()
        }`,
      );
    }
    if (item.assigneeLabel) {
      const mine = item.assigneeId &&
        item.assigneeId === model.stats.currentOperatorId;
      parts.push(mine ? "you" : item.assigneeLabel);
    } else if (item.taskId) {
      parts.push("Unassigned");
    }
    return parts.join(" · ");
  }

  // Overdue time reads as accumulated debt (mono day blocks + days), not a
  // state label; the same pressure treatment covers late follow-ups. All
  // other timings keep the human sentence.
  function homeTaskTimingText(item, today) {
    const overdueOf = (value) => {
      const due = String(value || "").slice(0, 10);
      const days = overdueDays(due, today);
      return days > 0
        ? `${"■".repeat(Math.min(days, 5))} ${days} day${days === 1 ? "" : "s"} overdue`
        : "";
    };
    if (item.priority === "overdue") {
      const text = overdueOf(item.dueDate || item.followUpDate);
      if (text) return text;
    }
    if (item.priority === "follow-up") {
      const text = overdueOf(item.followUpDate || item.dueDate);
      if (text) return text;
    }
    return formatHomeTaskTiming(item, today);
  }

  function overdueDays(due, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return 0;
    return Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) /
        86400000,
    );
  }

  function homeTaskActionLabel(value) {
    const label = String(value || "Open").trim();
    if (/^add /i.test(label)) return "Add proof";
    if (/^mark (done|response received)$/i.test(label)) return "Open";
    return label;
  }
  return { renderHomeAttentionQueue };
}
