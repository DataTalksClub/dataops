import { cardKind } from "../../core/card-kind.js";
import { personAvatar } from "../../core/identity.js";
import { blockingPrerequisites, prerequisiteResolved } from "../../core/task-dependencies.js";
import { browserRequirementParts, taskMaterials, taskTitleParts } from "../../core/task-display.js";
import { formatDayLabel } from "../../core/dates.js";
import { isCanonicalWorkTask } from "../../core/workspace.js";
import { createQueueAssigneeFilter } from "./queue-assignee.js";
import { createCardHovercards } from "./card-hovercard.js";
import { renderQueueMaterials } from "./queue-materials.js";
import { renderIcon } from "../../core/icons.js";
import { renderResourceMarks, resourceLabel } from "../../core/resources.js";

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
    queueCreateActions,
    resolveDocReference = () => null,
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

  const cardHovercards = createCardHovercards(context);
  const {
    activeAssigneeFilter,
    assigneeScope,
    assigneeTarget,
    renderAssigneeFilter,
    taskMatchesAssignee,
  } = createQueueAssigneeFilter(context);
  // The filtered open tasks in queue order: "Show all" continues this list.
  let visibleOpenTasks = [];

  // "all", "none" (needs nothing outside DataOps), or one resource id.
  let activeResourceFilter = "all";

  // "all", or one execution-need mode: "headless" keeps only tasks explicitly
  // classified as browser-free, "required" the ones needing a browser, and
  // "unclassified" the work nobody has decided about yet.
  let activeBrowserFilter = "all";

  function taskMatchesBrowser(task, filterId) {
    if (!filterId || filterId === "all") return true;
    const value = task.browserRequirement;
    if (filterId === "unclassified") return value !== "required" && value !== "headless";
    return value === filterId;
  }

  // Execution-need filter, always offered: headless mode is how an operator on
  // a browserless machine finds the work they can actually do, and unclassified
  // work must stay visible as un-triaged rather than silently safe.
  function renderBrowserFilter(openTasks, onSelect) {
    const counts = new Map();
    let unclassified = 0;
    for (const { task } of openTasks) {
      const parts = browserRequirementParts(task.browserRequirement);
      if (!parts.classified) unclassified += 1;
      else counts.set(task.browserRequirement, (counts.get(task.browserRequirement) || 0) + 1);
    }
    const label = document.createElement("label");
    label.className = "ops-queue-browser-filter";
    const text = document.createElement("span");
    text.textContent = "Browser";
    const select = document.createElement("select");
    select.className = "dk-select";
    select.setAttribute("aria-label", "Filter queue by browser requirement");
    const option = (value, name) => {
      const entry = document.createElement("option");
      entry.value = value;
      entry.textContent = name;
      entry.selected = value === activeBrowserFilter;
      select.append(entry);
    };
    option("all", "Any execution need");
    option("headless", `Headless (${counts.get("headless") || 0})`);
    option("required", `Browser required (${counts.get("required") || 0})`);
    option("unclassified", `Not classified (${unclassified})`);
    select.value = activeBrowserFilter;
    select.addEventListener("change", () => {
      activeBrowserFilter = select.value;
      onSelect();
    });
    label.append(text, select);
    return label;
  }

  function taskMatchesResource(task, filterId) {
    if (!filterId || filterId === "all") return true;
    const requires = Array.isArray(task.requires) ? task.requires : [];
    if (filterId === "none") return requires.length === 0;
    return requires.includes(filterId);
  }

  // Which external systems the open work needs, narrowed to one: who can
  // take a task depends on the accounts they hold. Only resources some open
  // task requires are offered, most-needed first.
  function renderResourceFilter(openTasks, onSelect) {
    const resourcesById = state.workSnapshot.resourcesById || new Map();
    const counts = new Map();
    let unneeded = 0;
    for (const { task } of openTasks) {
      const requires = Array.isArray(task.requires) ? task.requires : [];
      if (requires.length === 0) unneeded += 1;
      for (const id of requires) counts.set(id, (counts.get(id) || 0) + 1);
    }
    if (counts.size === 0) {
      activeResourceFilter = "all";
      return null;
    }
    const label = document.createElement("label");
    label.className = "ops-queue-resource-filter";
    const text = document.createElement("span");
    text.textContent = "Needs";
    const select = document.createElement("select");
    select.className = "dk-select";
    select.setAttribute("aria-label", "Filter queue by required resource");
    const option = (value, name) => {
      const entry = document.createElement("option");
      entry.value = value;
      entry.textContent = name;
      entry.selected = value === activeResourceFilter;
      select.append(entry);
    };
    option("all", "Any resource");
    const ordered = [...counts.entries()].sort(
      (left, right) => right[1] - left[1] ||
        resourceLabel(left[0], resourcesById).localeCompare(resourceLabel(right[0], resourcesById)),
    );
    for (const [id, count] of ordered) option(id, `${resourceLabel(id, resourcesById)} (${count})`);
    option("none", `Nothing external (${unneeded})`);
    if (activeResourceFilter !== "all" && activeResourceFilter !== "none" && !counts.has(activeResourceFilter)) {
      activeResourceFilter = "all";
      select.value = "all";
    }
    select.addEventListener("change", () => {
      activeResourceFilter = select.value;
      onSelect();
    });
    label.append(text, select);
    return label;
  }

  function renderWorkQueueSurface() {
    const taskRouteContext = getTaskRouteContext();
    const today = taskRouteContext.date || todayIsoDate();
    // The same task reaches this list through its lane query and its card's
    // checklist; deduplicate by id so the single queue never double-counts.
    // A task still waiting on a prerequisite is left out: nobody can do it
    // yet. It stays on its card's checklist and joins the queue once every
    // prerequisite is done or skipped.
    const tasks = withoutWaitingOnPrerequisites(dedupeQueueTasks(routeTasks(taskRouteContext)));
    const cardsById = state.workSnapshot.cardsById || new Map();
    const anySourceLoaded = Boolean(
      state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded ||
        Object.keys(state.workSnapshot.cardTasks || {}).length,
    );

    const allOpenTasks = orderOpenTasks(tasks, today);
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

    const board = document.createElement("div");
    board.className = "ops-queue-board";
    board.dataset.loadState = anySourceLoaded ? "ready" : "unavailable";

    // The create actions sit in the toolbar directly above the rows, after
    // the filters, never in the page header's corner.
    const createActions = queueCreateActions();

    function populateBoard() {
      board.replaceChildren();
      section.querySelector(".ops-queue-filters")?.remove();
      const filters = document.createElement("div");
      filters.className = "ops-queue-filters";
      filters.append(...createActions);
      section.prepend(filters);
      if (!anySourceLoaded) {
        board.append(renderUnavailableState());
        return;
      }

      const assigneeFilter = activeAssigneeFilter();
      const target = assigneeTarget(assigneeFilter);
      const scope = assigneeScope(assigneeFilter);
      const assigneeOpen = allOpenTasks.filter((entry) => taskMatchesAssignee(entry.task, target));
      const resourceFilter = renderResourceFilter(assigneeOpen, () => populateBoard());
      const browserFilter = renderBrowserFilter(assigneeOpen, () => populateBoard());
      const visibleOpen = assigneeOpen.filter(
        (entry) =>
          taskMatchesResource(entry.task, activeResourceFilter) &&
          taskMatchesBrowser(entry.task, activeBrowserFilter),
      );
      visibleOpenTasks = visibleOpen;

      const visibleDone = doneTasks.filter((task) =>
        taskMatchesAssignee(task, target) &&
        taskMatchesResource(task, activeResourceFilter) &&
        taskMatchesBrowser(task, activeBrowserFilter));

      if (allOpenTasks.length > 0 || doneTasks.length > 0) {
        // Who and what: the assignee filter, the required-resource filter, and
        // the browser-need filter share one toolbar row with the create actions.
        filters.prepend(
          renderAssigneeFilter(allOpenTasks),
          ...[resourceFilter, browserFilter],
        );

        if (visibleOpen.length > 0) {
          board.append(renderQueueTotalLine(visibleOpen.length, scope));
          board.append(renderQueueRows(visibleOpen, today, cardsById));
          const expander = renderQueueExpander(visibleOpen.length);
          if (expander) board.append(expander);
        } else if (activeBrowserFilter !== "all" && assigneeOpen.length > 0) {
          const emptyMsg = document.createElement("p");
          emptyMsg.className = "ops-empty ops-queue-browser-empty";
          emptyMsg.textContent = activeBrowserFilter === "headless"
            ? "No open task here is classified headless. Classify work from its task panel; unclassified tasks stay out of headless mode."
            : activeBrowserFilter === "required"
              ? "No open task here is marked as needing a browser."
              : "Every open task here already has a browser classification.";
          board.append(emptyMsg);
        } else if (activeResourceFilter !== "all" && assigneeOpen.length > 0) {
          const emptyMsg = document.createElement("p");
          emptyMsg.className = "ops-empty ops-queue-resource-empty";
          emptyMsg.textContent = activeResourceFilter === "none"
            ? "Every open task here needs an external system."
            : `No open tasks here need ${resourceLabel(activeResourceFilter, state.workSnapshot.resourcesById)}.`;
          board.append(emptyMsg);
        } else if (scope) {
          const emptyMsg = document.createElement("p");
          emptyMsg.className = "ops-empty ops-queue-assignee-empty";
          emptyMsg.textContent = target
            ? `No open tasks ${scope.phrase} right now.`
            : "Your signed-in identity is not known, so Mine cannot be shown. Choose a person or All.";
          board.append(emptyMsg);
        }

        if (visibleDone.length > 0) {
          board.append(renderQueueHistory(visibleDone, today));
        }
      }
    }

    populateBoard();
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

  // The lanes arrive already filtered by the API; card checklists do not.
  // A prerequisite's own row, when the snapshot has it, is the freshest word
  // on its status.
  function withoutWaitingOnPrerequisites(tasks) {
    const statusById = new Map(tasks.map((task) => [task.id, task.status]));
    return tasks.filter((task) => !blockingPrerequisites(task).some((entry) =>
      !prerequisiteResolved(statusById.has(entry.id) ? statusById.get(entry.id) : entry.status)));
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

  // How much of the scoped work is on screen. The scope rides in the same
  // sentence as the count, so "25 of 40" always says whose 40.
  function renderQueueTotalLine(count, scope) {
    const total = document.createElement("p");
    total.className = "ops-queue-total";
    const whose = scope ? ` ${scope.phrase}` : "";
    total.textContent =
      count > QUEUE_VISIBLE_LIMIT
        ? `Showing ${QUEUE_VISIBLE_LIMIT} of ${count} open${whose}, most urgent first`
        : `${count} open${whose}, most urgent first`;
    const copy = total.textContent;
    total.textContent = "";
    for (const part of copy.split(/(\d+)/)) {
      const span = document.createElement("span");
      span.textContent = part;
      if (/^\d+$/.test(part)) span.className = "dk-mono";
      total.append(span);
    }
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
    for (const label of ["", "Where", "Task", "", "Due", "Who"]) {
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
      for (const entry of visibleOpenTasks.slice(rendered))
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
    count.className = "dk-mono";
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
    button.setAttribute("aria-label", `Open task ${cleanTaskTitle(task)}`);
    button.addEventListener("click", () => openTaskPanel(task.id));
    const title = document.createElement("strong");
    title.textContent = cleanTaskTitle(task);
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
    // Clearing the card or day keeps whose work the queue shows.
    clear.addEventListener("click", () =>
      navigateCanonicalWorkspace("/tasks", { assignee: activeAssigneeFilter() }));
    routeState.append(heading, detail, retry, clear);
    return routeState;
  }

  // Human due moments: relative words for today/yesterday/tomorrow, a short
  // date otherwise, with the year only outside the current one. Timestamped
  // values (followUpAt carries a time) are compared on their day.
  function queueDueLabel(date, today) {
    return formatTaskDateMeta(String(date || "").slice(0, 10), today);
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
    input.setAttribute("aria-label", `Mark ${cleanTaskTitle(task)} as done`);
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

  // A task's display title, without a legacy "[Group]" prefix.
  function cleanTaskTitle(task) {
    return taskTitleParts(workTaskTitle(task), task.tags).title;
  }

  // The one place a task names where it came from. Card membership wins
  // (the card is what the operator can open): its title, its kind (the
  // template type — webinar, podcast…) and the template's icon. Recurring
  // schedules and explicit import sources follow; everything else is
  // hand-made ad hoc work. The column heading already says where, so a card
  // cell carries the card's name, not "Card · name".
  function taskOrigin(task, cardsById) {
    // A Task outside any Card can be about a sponsor deal or company; the
    // cell names the company and opens the record.
    if (task.subject?.href) {
      const type = task.subject.type === "sponsor-company" ? "Sponsor" : "Sponsor deal";
      const label = task.subject.label || type;
      return {
        label,
        kind: "sponsor",
        icon: "megaphone",
        type,
        title: `${label} · ${type}`,
        href: task.subject.href,
        open: () => navigateCanonicalWorkspace(task.subject.href),
      };
    }
    if (task.cardId) {
      const card = cardsById.get(String(task.cardId));
      const kind = card ? cardKind(card, state.workSnapshot.templates) : null;
      const label = card ? workCardTitle(card) : "Card";
      return {
        label,
        kind: "card",
        icon: kind?.icon || "card",
        type: kind?.name || "",
        title: kind ? `${label} · ${kind.name}` : card ? label : "Card task",
        card,
      };
    }
    const source = taskSourceLabel(task);
    if (source === "Recurring")
      return { label: "Recurring", kind: "recurring", icon: "recurring", type: "", title: "Recurring task" };
    if (["Ad hoc", "Manual"].includes(source))
      return { label: "Ad hoc", kind: "adhoc", icon: "adhoc", type: "", title: "Ad hoc task" };
    return { label: source, kind: "other", icon: "card", type: "", title: source };
  }

  // Ownership reads as a face, not a sentence. The avatar carries the
  // teammate's photo, or their initials; the full name stays available as the accessible
  // label so the queue never hides who owns the work behind two letters.
  function taskOwnerCell(task) {
    const cell = document.createElement("span");
    cell.className = "ops-queue-owner";
    if (!task.assigneeId) {
      cell.dataset.assignee = "none";
      cell.textContent = "Unassigned";
      cell.title = "Unassigned";
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", "Unassigned");
      return cell;
    }
    const name = resolveAssigneeLabel(task.assigneeId);
    const person = state.workSnapshot.usersById?.get(task.assigneeId);
    const avatar = personAvatar({ name, picture: person?.picture }, { size: "xs", className: "ops-queue-avatar" });
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
    cell.className = "ops-queue-due dk-mono";
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

  // The second line a row earns: what the task is waiting for.
  // Proof requirements stay in the task panel, and instructions live behind
  // the row's materials icon. The line is muted and one line tall; the full
  // text is its tooltip. A date inside a note is data: mono.
  function noteDate(text) {
    if (!/\d/.test(text)) return document.createTextNode(text);
    const date = document.createElement("span");
    date.className = "dk-mono";
    date.textContent = text;
    return date;
  }

  function queueNote(kind, task) {
    const note = document.createElement("small");
    note.className = "ops-queue-note";
    note.dataset.note = kind;
    // The title button's accessible name is its own label, so the note is
    // its description rather than text the name would swallow.
    note.id = `ops-queue-note-${task.id}`;
    return note;
  }

  function taskBlockerNote(task, today) {
    if (task.status === "done") return null;
    let note = null;
    if (task.waitingFor) {
      note = queueNote("waiting", task);
      note.append(`Waiting for ${task.waitingFor}`);
      if (task.followUpAt) {
        note.append(" · ", noteDate(queueDueLabel(task.followUpAt, today)));
      }
    } else if (isFollowUpDueTask(task, today)) {
      note = queueNote("follow-up", task);
      note.append("Follow up ", noteDate(formatDayLabel(task.followUpAt, today)));
    }
    if (note) note.title = note.textContent;
    return note;
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
    row.setAttribute("aria-label", `Open task ${cleanTaskTitle(task)}`);
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, input, label, a, [role='menu']")) return;
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
    open.setAttribute("aria-label", `Open task ${cleanTaskTitle(task)}`);
    open.addEventListener("click", () => openTaskPanel(task.id));

    const cell = document.createElement("div");
    cell.className = "ops-queue-task";
    const describedBy = [];

    // The task's group (a "[Group]" title prefix or tag) is not shown: it
    // mostly repeats the title or the card's kind. The task dialog keeps it.
    const name = cleanTaskTitle(task);
    const titleRow = document.createElement("span");
    titleRow.className = "ops-queue-title-row";
    const title = document.createElement("strong");
    title.textContent = name;
    // Titles truncate to one line; the full name stays one hover away.
    title.title = name;
    titleRow.append(title);
    // What the task needs outside DataOps, as glyphs named on hover: an
    // operator or agent without that access can see it is not theirs.
    // The button's name stays the task's name; what it needs and what it
    // waits on describe it instead of riding inside the label.
    const resources = renderResourceMarks(task.requires, state.workSnapshot.resourcesById);
    if (resources) {
      titleRow.append(resources);
      const needs = task.requires.map((id) => resourceLabel(id, state.workSnapshot.resourcesById));
      const needsText = document.createElement("span");
      needsText.className = "dk-visually-hidden";
      needsText.id = `ops-queue-needs-${task.id}`;
      needsText.textContent = `Needs ${needs.join(", ")}`;
      cell.append(needsText);
      describedBy.push(needsText.id);
    }
    // The execution need beside the accounts: a browser-required or
    // headless-classified task carries its mark; an unclassified one stays
    // unmarked here and asks to be classified from the task panel.
    const browser = browserRequirementParts(task.browserRequirement);
    if (browser.classified) {
      const mark = document.createElement("span");
      mark.className = "ops-queue-browser";
      mark.dataset.browser = task.browserRequirement;
      mark.title = browser.label;
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", browser.label);
      mark.append(renderIcon(browser.icon, { size: 16 }));
      titleRow.append(mark);
      row.dataset.browser = task.browserRequirement;
    }
    open.append(titleRow);
    cell.prepend(open);
    // The second line sits beside the button, not in it, and describes it.
    const note = taskBlockerNote(task, today);
    if (note) {
      cell.append(note);
      describedBy.push(note.id);
    }
    if (describedBy.length) open.setAttribute("aria-describedby", describedBy.join(" "));

    // Instructions and other supporting material: one icon, never a line of
    // small text. Empty cells keep the grid column so rows stay aligned.
    const materialsCell = document.createElement("span");
    materialsCell.className = "ops-queue-materials-cell";
    const materials = renderQueueMaterials(
      taskMaterials(task, { resolveDoc: resolveDocReference }),
      {
        taskTitle: name,
        openTask: () => openTaskPanel(task.id),
      },
    );
    if (materials) materialsCell.append(materials);

    const originCell = cardHovercards.renderOriginCell(origin, () => ({ today }));

    // Where comes first: which card or sponsor the work belongs to, then what to do.
    // The DOM follows the visual order so Tab does too.
    row.append(toggle, originCell, cell, materialsCell, taskDueCell(task, today), owner);
    return row;
  }

  return { renderWorkQueueSurface };
}
