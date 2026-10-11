import { personInitials } from "../../core/identity.js";
import { isCanonicalWorkTask } from "../../core/workspace.js";

// One queue, not one section per state. Every open task the snapshot knows
// about lands in the same list, sorted by urgency. The list is a checklist
// read as a table: a completion mark, the task, where it came from (its card
// or ad hoc), when it is due, and whose it is. Nothing else earns a line.
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
    refreshOperationsWorkSnapshot,
    request,
    resolveAssigneeLabel,
    showUndoToast,
    state,
    taskDate,
    taskProofState,
    taskSourceLabel,
    todayIsoDate,
    workApiUrl,
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
    rows.append(renderQueueHeader());
    for (const entry of openTasks.slice(0, QUEUE_VISIBLE_LIMIT))
      rows.append(renderWorkQueueRow(entry.task, today, cardsById));
    return rows;
  }

  // The columns, named once. Without headings the eye reads the card title
  // column as the task title and the whole thing stays confusing, which is
  // the problem the table layout exists to fix.
  function renderQueueHeader() {
    const header = document.createElement("div");
    header.className = "ops-queue-head";
    header.setAttribute("aria-hidden", "true");
    for (const label of ["", "Task", "Where", "Due", "Who"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      header.append(cell);
    }
    return header;
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

  // One in-flight toggle per task. The toggle outlives neither its render
  // nor its response: a double activation cannot send two competing versions,
  // and a rerender mid-flight still renders the pending task as busy.
  const queuePendingToggles = new Set();

  function findQueueTask(taskId) {
    const work = state.workSnapshot;
    const candidates = [
      ...(Array.isArray(work.todayTasks) ? work.todayTasks : []),
      ...(Array.isArray(work.overdueTasks) ? work.overdueTasks : []),
      ...(Array.isArray(work.waitingTasks) ? work.waitingTasks : []),
      ...Object.values(work.cardTasks || {}).flatMap((cardTasks) =>
        Array.isArray(cardTasks) ? cardTasks : [],
      ),
    ];
    return candidates.find((task) => task?.id === taskId) || null;
  }

  async function putQueueTaskStatus(taskId, status, expectedVersion) {
    const updated = await request(
      workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`),
      {
        method: "PUT",
        body: JSON.stringify({ status, expectedVersion }),
      },
    );
    if (!isCanonicalWorkTask(updated)) {
      throw new Error("Task payload is not in the canonical versioned shape");
    }
    return updated;
  }

  // The checkbox is the real thing: checking it marks the task done through
  // the same versioned PUT the panels use, then the refreshed snapshot moves
  // the row into history. A failed toggle restores the box and says why, so
  // the queue never silently swallows the operator's tick.
  async function toggleQueueTask(task, input) {
    if (queuePendingToggles.has(task.id)) return;
    queuePendingToggles.add(task.id);
    input.disabled = true;
    input.checked = true;
    try {
      await putQueueTaskStatus(task.id, "done", task.version);
      await refreshOperationsWorkSnapshot({ rerender: true });
      queuePendingToggles.delete(task.id);
      showUndoToast("Task marked done.", () => reopenQueueTask(task.id));
    } catch (err) {
      queuePendingToggles.delete(task.id);
      if (input.isConnected) {
        input.disabled = false;
        input.checked = false;
        input.title = `Could not update task: ${err?.message || "request failed"}`;
      }
    }
  }

  async function reopenQueueTask(taskId) {
    const current = findQueueTask(taskId);
    if (!current || !Number.isInteger(current.version)) return;
    try {
      await putQueueTaskStatus(taskId, "todo", current.version);
    } finally {
      await refreshOperationsWorkSnapshot({ rerender: true });
    }
  }

  // Whether the checkbox does anything. Proof-blocked and waiting tasks keep
  // a disabled box that names its reasons — the same gate the card checklist
  // and the task panel enforce — so ticking it is never a dead click.
  function queueToggleBlockers(task) {
    const reasons = [];
    if (task.status === "waiting") {
      reasons.push(
        task.waitingFor ? `Waiting for ${task.waitingFor}` : "Waiting task",
      );
      return reasons;
    }
    const proof = taskProofState(task);
    if (proof.ok) return reasons;
    for (const missing of proof.missing) {
      if (missing === "required file") reasons.push("Upload required file");
      else if (missing === "approved artifact")
        reasons.push("Approve an attached artifact");
      else reasons.push(`Fill in ${missing}`);
    }
    return reasons;
  }

  // Row-level urgency for the checkbox. Overdue and due-today are the
  // only states that change the box; everything else scans as plain work.
  function queueUrgency(task, today) {
    const due = String(task.date || "").slice(0, 10);
    if (isOpenWorkTask(task) && overdueDays(due, today) > 0) return "overdue";
    if (due && due === today) return "today";
    return "later";
  }

  function renderQueueToggle(task) {
    const label = document.createElement("label");
    label.className = "ops-queue-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "ops-queue-check-input";
    input.setAttribute("aria-label", `Mark ${workTaskTitle(task)} as done`);
    const blockers = queueToggleBlockers(task);
    if (blockers.length > 0) {
      input.disabled = true;
      // The tooltip lives on the label: the visible box is its child, and a
      // tooltip on the input alone would not surface when hovering the box.
      label.title = blockers.join("; ");
    } else {
      if (queuePendingToggles.has(task.id)) {
        input.disabled = true;
        input.checked = true;
      }
      input.addEventListener("change", () => toggleQueueTask(task, input));
    }
    const box = document.createElement("span");
    box.className = "ops-queue-box";
    box.setAttribute("aria-hidden", "true");
    label.append(input, box);
    return label;
  }

  // The one place a task names where it came from. Card membership wins
  // (the card is what the operator can open); recurring schedules and
  // explicit import sources follow; everything else is hand-made ad hoc
  // work. The label is the bare origin — the column heading already says
  // where, so a card cell carries the card's name, not "Card · name".
  function taskOrigin(task, cardsById) {
    if (task.cardId) {
      const card = cardsById.get(String(task.cardId));
      return {
        label: card ? workCardTitle(card) : "Card",
        kind: "card",
        title: card ? workCardTitle(card) : "Card",
      };
    }
    const source = taskSourceLabel(task);
    if (source === "Recurring") return { label: "Recurring", kind: "recurring" };
    if (["Ad hoc", "Manual"].includes(source))
      return { label: "Ad hoc", kind: "adhoc" };
    return { label: source, kind: "other" };
  }

  // Ownership reads as a face, not a sentence. The avatar carries the
  // teammate's initials; the full name stays available as the accessible
  // label so the queue never hides who owns the work behind two letters.
  function taskOwnerCell(task) {
    const cell = document.createElement("span");
    cell.className = "ops-queue-owner";
    if (!task.assigneeId) {
      cell.dataset.assignee = "none";
      cell.textContent = "—";
      cell.title = "Unassigned";
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", "Unassigned");
      return cell;
    }
    const name = resolveAssigneeLabel(task.assigneeId);
    const avatar = document.createElement("span");
    avatar.className = "account-avatar ops-queue-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = personInitials(name);
    cell.dataset.assignee = "named";
    cell.append(avatar);
    cell.title = name;
    cell.setAttribute("role", "img");
    cell.setAttribute("aria-label", `Assigned to ${name}`);
    return cell;
  }

  // One due cell: how late, in the fewest words the state allows. A debt
  // reads as plain machine days ("67d"), a due-today as the word, and
  // anything else as a short date. Proof-blocked work never reaches a
  // completion claim here; the row's blocker note carries that.
  function taskDueCell(task, today) {
    const cell = document.createElement("span");
    cell.className = "ops-queue-due";
    const due = String(task.date || "").slice(0, 10);
    const debt = isOpenWorkTask(task) ? overdueDays(due, today) : 0;
    if (debt > 0) {
      cell.dataset.due = "overdue";
      cell.textContent = `${debt}d late`;
      cell.title = `${debt} day${debt === 1 ? "" : "s"} past due`;
      return cell;
    }
    if (!task.date) {
      cell.dataset.due = "none";
      cell.textContent = "—";
      return cell;
    }
    cell.dataset.due = due === today ? "today" : "later";
    cell.textContent =
      due === today ? "Today" : queueDueLabel(task.date, today);
    return cell;
  }

  // The blocker note is the only second line a row earns, and only when the
  // task is genuinely stuck: waiting on someone, or missing proof. A task
  // with nothing blocking it is one line, so the list scans as a checklist
  // rather than a wall of "Next: Mark done".
  function taskBlockerNote(task, today) {
    const proof = taskProofState(task);
    if (task.status === "done") return null;
    if (task.waitingFor) {
      const note = document.createElement("small");
      note.className = "ops-queue-note is-waiting";
      note.textContent = `Waiting for ${task.waitingFor}${
        task.followUpAt ? ` · ${queueDueLabel(task.followUpAt, today)}` : ""
      }`;
      return note;
    }
    if (!proof.ok) {
      const note = document.createElement("small");
      note.className = "ops-queue-note is-blocked";
      note.textContent = `Needs ${proof.label.replace(/^Missing proof:\s*/i, "")}`;
      return note;
    }
    if (isFollowUpDueTask(task, today)) {
      const note = document.createElement("small");
      note.className = "ops-queue-note";
      note.textContent = `Follow up ${queueShortDate(task.followUpAt)}`;
      return note;
    }
    return null;
  }

  function renderWorkQueueRow(task, today, cardsById) {
    if (!isCanonicalWorkTask(task)) {
      throw new Error("Task payload is not in the canonical versioned shape");
    }
    const origin = taskOrigin(task, cardsById);
    const owner = taskOwnerCell(task);
    // The row is a group, not a button: the checkbox toggles completion and
    // the title opens the task, so nesting both inside one button would make
    // every tick also open the panel. Mouse users still get the whole row —
    // the row's own click opens the task unless the tick took the click.
    // tabindex -1 keeps the row a focus-restore target when the task panel
    // closes without ever becoming a tab stop; the two controls own keys.
    const row = document.createElement("div");
    row.className = "ops-queue-row";
    row.dataset.taskId = task.id;
    row.dataset.source = origin.kind;
    // Urgency rides the row so the checkbox can carry it: overdue and
    // due-today rows read as such before any text is parsed. Purely visual —
    // ordering already happened above, so this never changes what renders.
    row.dataset.urgency = queueUrgency(task, today);
    row.tabIndex = -1;
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, input, label, a")) return;
      openTaskPanel(task.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target?.closest?.("button, input, label, a") && event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTaskPanel(task.id);
      }
    });

    const toggle = renderQueueToggle(task);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "ops-queue-main";
    open.setAttribute("aria-label", `Open task ${workTaskTitle(task)}`);
    open.addEventListener("click", () => openTaskPanel(task.id));

    const title = document.createElement("strong");
    title.textContent = workTaskTitle(task);
    // Titles truncate to one line; the full name stays one hover away.
    title.title = workTaskTitle(task);
    open.append(title);
    const note = taskBlockerNote(task, today);
    if (note) open.append(note);

    const originCell = document.createElement("span");
    originCell.className = "ops-queue-origin";
    originCell.dataset.source = origin.kind;
    originCell.textContent = origin.label;
    originCell.title = origin.title;

    row.append(toggle, open, originCell, taskDueCell(task, today), owner);
    return row;
  }

  return { renderWorkQueueSurface };
}
