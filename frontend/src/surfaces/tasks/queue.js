import { isCanonicalWorkTask } from "../../core/workspace.js";

// One queue, not one section per state. Every open task the snapshot knows
// about lands in the same list, sorted by urgency; the source chip on each
// row says where the task came from, so triage reads one column top to
// bottom instead of six boxed lanes.
const QUEUE_VISIBLE_LIMIT = 25;
const HISTORY_VISIBLE_LIMIT = 12;

export function createTaskQueue(context) {
  const {
    compareIsoDate,
    formatTaskDateMeta,
    getActiveWorkspaceRoute,
    getTaskRouteContext,
    isFollowUpDueTask,
    isOpenWorkTask,
    isTaskDueToday,
    isTaskOverdue,
    isWaitingOrFollowUpTask,
    navigateCanonicalWorkspace,
    openCardPanel,
    openTaskPanel,
    resolveAssigneeLabel,
    state,
    taskDate,
    taskNextActionLabel,
    taskProofState,
    taskSourceLabel,
    todayIsoDate,
    workCardTitle,
    workTaskTitle,
  } = context;

  function renderWorkQueueSurface() {
    const taskRouteContext = getTaskRouteContext();
    const today = taskRouteContext.date || todayIsoDate();
    // The same task reaches this list through its lane query and its card's
    // checklist; deduplicate by id so the single queue never double-counts.
    const tasks = dedupeQueueTasks(routeTasks(taskRouteContext));
    const cardsById = state.workSnapshot.cardsById || new Map();
    const anySourceLoaded = Boolean(
      state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded ||
        Object.keys(state.workSnapshot.cardTasks || {}).length,
    );

    const openTasks = orderOpenTasks(tasks, today);
    const doneTasks = tasks
      .filter((task) => isCanonicalWorkTask(task) && task.status === "done")
      .sort((left, right) =>
        compareIsoDate(taskDate(right) || "", taskDate(left) || ""),
      );

    const section = document.createElement("section");
    section.className = "ops-work-queue";
    section.setAttribute("aria-label", "Work queue");
    if (
      taskRouteContext.date ||
      taskRouteContext.cardId ||
      taskRouteContext.contextCardId ||
      taskRouteContext.failures.length
    ) {
      section.append(renderTaskRouteContext(taskRouteContext));
    }

    // A fully loaded empty queue states nothing here: the page summary above
    // already says "No tasks are open in this queue." once. The board only
    // renders when there is work to show or data to apologize for.
    const board = document.createElement("div");
    board.className = "ops-queue-board";
    board.dataset.loadState = anySourceLoaded ? "ready" : "unavailable";
    if (!anySourceLoaded) {
      board.append(renderUnavailableState());
    } else if (openTasks.length > 0 || doneTasks.length > 0) {
      if (openTasks.length > 0) {
        board.append(renderQueueTotalLine(openTasks.length));
        board.append(renderQueueRows(openTasks, today, cardsById));
        const expander = renderQueueExpander(openTasks.length);
        if (expander) board.append(expander);
      }
      if (doneTasks.length > 0)
        board.append(renderQueueHistory(doneTasks, today));
    }
    if (board.children.length > 0) section.append(board);
    return section;
  }

  function routeTasks(taskRouteContext) {
    return Array.isArray(taskRouteContext.tasks)
      ? taskRouteContext.tasks
      : allQueueTasks();
  }

  function dedupeQueueTasks(tasks) {
    const seen = new Set();
    return tasks.filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  }

  function allQueueTasks() {
    const work = state.workSnapshot;
    return dedupeQueueTasks([
      ...(Array.isArray(work.todayTasks) ? work.todayTasks : []),
      ...(Array.isArray(work.overdueTasks) ? work.overdueTasks : []),
      ...(Array.isArray(work.waitingTasks) ? work.waitingTasks : []),
      ...Object.values(work.cardTasks || {}).flatMap((cardTasks) =>
        Array.isArray(cardTasks) ? cardTasks : [],
      ),
    ]);
  }

  // Urgency order: overdue, follow-ups due, then the day's work, then
  // waiting and the rest. Each open task lives in exactly one segment —
  // the first it qualifies for — so an overdue proof-blocked task is
  // counted once, in Overdue, with its "Proof needed" line.
  function orderOpenTasks(tasks, today) {
    const placed = new Set();
    const segment = (predicate) => {
      const members = tasks.filter(
        (task) => !placed.has(task.id) && predicate(task),
      );
      for (const task of members) placed.add(task.id);
      return members;
    };
    const segments = [
      segment((task) => isTaskOverdue(task, today)),
      segment((task) => isFollowUpDueTask(task, today)),
      segment((task) => isTaskDueToday(task, today)),
      segment(
        (task) =>
          isWaitingOrFollowUpTask(task) && !isFollowUpDueTask(task, today),
      ),
      segment((task) => isOpenWorkTask(task)),
    ];
    // sortWorkTasks caps at its own page size; the one queue must not drop
    // work behind that cap, so segments sort by the same leading facts the
    // lanes used (due date, then title) and the cap moves to the render
    // layer where "Show all" can lift it.
    return segments.flatMap((members) =>
      members.length === 0
        ? []
        : members
            .slice()
            .sort(
              (left, right) =>
                compareIsoDate(taskDate(left) || "", taskDate(right) || "") ||
                workTaskTitle(left).localeCompare(workTaskTitle(right)),
            )
            .map((task) => ({ task })),
    );
  }

  function renderUnavailableState() {
    const empty = document.createElement("p");
    empty.className = "ops-empty";
    empty.dataset.state = "unavailable";
    empty.textContent = "Live work data unavailable.";
    return empty;
  }

  function renderQueueTotalLine(totalOpen) {
    const total = document.createElement("p");
    total.className = "ops-queue-total";
    total.textContent =
      totalOpen > QUEUE_VISIBLE_LIMIT
        ? `Showing ${QUEUE_VISIBLE_LIMIT} of ${totalOpen} open, most urgent first`
        : `${totalOpen} open, most urgent first`;
    total.setAttribute("role", "status");
    return total;
  }

  function renderQueueRows(openTasks, today, cardsById) {
    const rows = document.createElement("div");
    rows.className = "ops-queue-list";
    for (const entry of openTasks.slice(0, QUEUE_VISIBLE_LIMIT))
      rows.append(renderWorkQueueRow(entry.task, today, cardsById));
    return rows;
  }

  // Past the cap the list keeps its full order and grows downward; the
  // count line above stays the one summary of how much work exists.
  function renderQueueExpander(totalOpen) {
    if (totalOpen <= QUEUE_VISIBLE_LIMIT) return null;
    const expander = document.createElement("div");
    expander.className = "ops-queue-more-wrap";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ops-queue-more quiet-button";
    more.textContent = `Show all ${totalOpen}`;
    more.addEventListener("click", () => {
      const board = expander.closest(".ops-queue-board");
      const list = board?.querySelector(".ops-queue-list");
      if (!list) return;
      const today = todayIsoDate();
      const cardsById = state.workSnapshot.cardsById || new Map();
      const rendered = list.querySelectorAll(".ops-queue-row").length;
      const ordered = orderOpenTasks(
        routeTasks(getTaskRouteContext()),
        today,
      );
      for (const entry of ordered.slice(rendered))
        list.append(renderWorkQueueRow(entry.task, today, cardsById));
      expander.remove();
    });
    expander.append(more);
    return expander;
  }

  function renderQueueHistory(doneTasks, today) {
    const details = document.createElement("details");
    details.className = "ops-queue-history";
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = "Recently completed";
    const count = document.createElement("span");
    count.dataset.queueCount = "known";
    count.textContent = String(doneTasks.length);
    count.setAttribute(
      "aria-label",
      `${doneTasks.length} recently completed tasks`,
    );
    summary.append(label, count);
    details.append(summary);
    const rows = document.createElement("div");
    rows.className = "ops-queue-history-list";
    for (const task of doneTasks.slice(0, HISTORY_VISIBLE_LIMIT))
      rows.append(renderQueueHistoryRow(task, today));
    details.append(rows);
    return details;
  }

  function renderQueueHistoryRow(task, today) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-history-row";
    button.dataset.taskId = task.id;
    button.setAttribute("aria-label", `Open task ${workTaskTitle(task)}`);
    button.addEventListener("click", () => openTaskPanel(task.id));
    const title = document.createElement("strong");
    title.textContent = workTaskTitle(task);
    const meta = document.createElement("span");
    const completed = String(task.completedAt || task.date || "").slice(0, 10);
    meta.textContent = completed
      ? `Done · ${queueDueLabel(completed, today)}`
      : "Done";
    button.append(title, meta);
    return button;
  }

  function renderTaskRouteContext(taskRouteContext) {
    const routeContext = document.createElement("aside");
    routeContext.className = "task-route-context";
    routeContext.setAttribute("aria-label", "Task queue route context");
    const heading = document.createElement("h3");
    heading.textContent = "Queue context";
    const summary = document.createElement("p");
    // The context chip names the filtered day relative to the operator's
    // real today — the queue-local `today` serves the ordering, not this
    // label, or every filtered day would read "Today".
    summary.textContent = [
      taskRouteContext.date
        ? `Date ${queueDueLabel(taskRouteContext.date, todayIsoDate())}`
        : "",
      taskRouteContext.cardId
        ? `Filtered to card ${taskRouteContext.filterCard?.title || taskRouteContext.cardId}`
        : "",
      taskRouteContext.contextCardId
        ? `Return card ${taskRouteContext.contextCard?.title || taskRouteContext.contextCardId}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    routeContext.append(heading, summary);
    if (taskRouteContext.contextCardId && taskRouteContext.contextCard) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open return card";
      open.addEventListener("click", () =>
        openCardPanel(taskRouteContext.contextCardId),
      );
      routeContext.append(open);
    }
    for (const failure of taskRouteContext.failures) {
      routeContext.append(renderTaskRouteContextFailure(failure));
    }
    return routeContext;
  }

  function renderTaskRouteContextFailure(failure) {
    const labels = {
      "filter-card": [
        "Filter card",
        "The card filter could not be verified.",
      ],
      "task-query": [
        "Filtered task queue",
        "The requested task slice could not be loaded.",
      ],
      "return-context": [
        "Return card",
        "The return context could not be loaded.",
      ],
    };
    const [label, explanation] = labels[failure.source] || [
      "Route context",
      "This route context could not be loaded.",
    ];
    const routeState = document.createElement("section");
    routeState.className = `task-context-state entity-route-${failure.status}`;
    routeState.dataset.contextSource = failure.source;
    routeState.setAttribute(
      "role",
      failure.status === "error" ? "alert" : "status",
    );
    const heading = document.createElement("strong");
    heading.textContent = `${label} ${failure.status === "not-found" ? "not found" : "unavailable"}`;
    const detail = document.createElement("p");
    detail.textContent =
      `${explanation} Requested value: ${failure.id}. ${failure.error || ""}`.trim();
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry route context";
    retry.addEventListener("click", () => {
      const route = getActiveWorkspaceRoute();
      navigateCanonicalWorkspace(route.path, route.params, { history: "none" });
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear queue context";
    clear.addEventListener("click", () => navigateCanonicalWorkspace("/tasks"));
    routeState.append(heading, detail, retry, clear);
    return routeState;
  }

  // Short human date for instants (follow-ups), independent of lane wording.
  function queueShortDate(value) {
    const parsed = new Date(String(value || ""));
    if (Number.isNaN(parsed.getTime())) return String(value || "");
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
    }).format(parsed);
  }

  // Human due moments: relative words for today/yesterday/tomorrow, a short
  // date otherwise — never a bare ISO quantity in the queue. Timestamped
  // values (followUpAt carries a time) are compared on their day.
  function queueDueLabel(date, today) {
    const day = String(date || "").slice(0, 10);
    const relative = formatTaskDateMeta(day, today);
    if (relative !== day) return relative;
    const parsed = new Date(`${day}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? relative
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).format(parsed);
  }

  // Overdue time reads as accumulated debt (mono day blocks + days) — not a
  // bare due date.
  function overdueDays(due, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(today))
      return 0;
    return Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) /
        86400000,
    );
  }

  // The one place a task names where it came from. Card membership wins
  // (the card is what the operator can open); recurring schedules and
  // explicit import sources follow; everything else is hand-made ad hoc
  // work.
  function taskSourceChip(task, cardsById) {
    if (task.cardId) {
      const card = cardsById.get(String(task.cardId));
      return {
        label: card ? `Card · ${workCardTitle(card)}` : "Card",
        kind: "card",
      };
    }
    const source = taskSourceLabel(task);
    if (source === "Recurring") return { label: "Recurring", kind: "recurring" };
    if (["Ad hoc", "Manual"].includes(source))
      return { label: "Ad hoc", kind: "adhoc" };
    return { label: source, kind: "other" };
  }

  function renderWorkQueueRow(task, today, cardsById) {
    if (!isCanonicalWorkTask(task)) {
      throw new Error("Task payload is not in the canonical versioned shape");
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-row";
    button.dataset.taskId = task.id;
    button.setAttribute("aria-label", `Open task ${workTaskTitle(task)}`);
    button.addEventListener("click", () => openTaskPanel(task.id));
    const title = document.createElement("strong");
    title.textContent = workTaskTitle(task);
    const meta = document.createElement("div");
    meta.className = "ops-queue-meta";
    // The source chip leads the meta line: where a task came from is the
    // first triage fact. Due moment and ownership follow as quiet facts;
    // defaults (no proof, todo status) stay quiet instead of pill-spamming
    // every row.
    const source = taskSourceChip(task, cardsById);
    const sourceChip = document.createElement("span");
    sourceChip.className = "ops-queue-chip is-source";
    sourceChip.dataset.source = source.kind;
    sourceChip.textContent = source.label;
    meta.append(sourceChip);
    const proof = taskProofState(task);
    const due = String(task.date || "").slice(0, 10);
    const debt = isOpenWorkTask(task) ? overdueDays(due, today) : 0;
    for (const [value, attention, debtTiming] of [
      [
        debt > 0
          ? `${"■".repeat(Math.min(debt, 5))} ${debt} day${debt === 1 ? "" : "s"} overdue`
          : task.date
            ? `Due ${queueDueLabel(task.date, today)}`
            : "",
        debt === 0 && Boolean(task.date) && due === today,
        debt > 0,
      ],
      [
        task.assigneeId
          ? `Owner ${resolveAssigneeLabel(task.assigneeId)}`
          : "Unassigned",
        false,
        false,
      ],
    ]) {
      if (!value) continue;
      const chip = document.createElement("span");
      chip.className = [
        "ops-queue-chip",
        attention ? "is-attention" : "",
        debtTiming ? "is-debt" : "",
      ]
        .filter(Boolean)
        .join(" ");
      chip.textContent = value;
      meta.append(chip);
    }
    if (task.status === "waiting") {
      const waitingChip = document.createElement("span");
      waitingChip.className = "ops-queue-chip is-waiting";
      waitingChip.textContent = "Waiting";
      meta.append(waitingChip);
    }
    // The summary names the real blocker: proof-blocked work never claims
    // "Mark done" as its next step, and follow-up moments stay human.
    const summary = document.createElement("small");
    summary.textContent = task.status === "done"
      ? "Completed."
      : !proof.ok
        ? `Proof needed: ${proof.label.replace(/^Missing proof:\s*/i, "")}`
        : task.waitingFor
          ? `Waiting for ${task.waitingFor}${task.followUpAt ? ` · follow up ${queueShortDate(task.followUpAt)}` : ""}`
          : `Next: ${taskNextActionLabel(task, today)}`;
    const open = document.createElement("span");
    open.className = "ops-queue-row-open";
    open.setAttribute("aria-hidden", "true");
    open.textContent = "Open";
    button.append(title, meta, summary, open);
    return button;
  }

  return { renderWorkQueueSurface };
}
