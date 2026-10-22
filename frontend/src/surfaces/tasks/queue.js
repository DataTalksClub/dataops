import { createQueueHistory } from "./queue-history.js";
import { isTaskDeferred, taskAttentionDate } from "../../core/task-attention.js";
import { cardKind } from "../../core/card-kind.js";
import { personAvatar } from "../../core/identity.js";
import { blockedReason, blockingPrerequisites, prerequisiteResolved } from "../../core/task-dependencies.js";
import { browserRequirementParts, taskMaterials, taskTitleParts } from "../../core/task-display.js";
import { formatDayLabel } from "../../core/dates.js";
import { isCanonicalWorkTask } from "../../core/workspace.js";
import { createQueueAssigneeFilter } from "./queue-assignee.js";
import { createCardHovercards } from "./card-hovercard.js";
import { renderQueueMaterials } from "./queue-materials.js";
import { renderIcon } from "../../core/icons.js";
import { renderResourceMarks, resourceLabel } from "../../core/resources.js";
import { renderQueueSkeleton, renderQueueUnavailableState } from "./queue-skeleton.js";
import { renderBlockedPrerequisiteSection } from "./queue-blocked.js";
import { renderTaskRouteContext as renderTaskRouteContextView } from "./queue-route-context.js";

const QUEUE_VISIBLE_LIMIT = 25;

export function createTaskQueue(context) {
  const {
    compareIsoDate,
    formatTaskDateMeta,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken,
    getTaskRouteContext,
    isFollowUpDueTask,
    isOpenWorkTask,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openCardPanel,
    openTaskPanel,
    refreshDocuments,
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
  // Kept only in this page's queue instance: a reload starts with clean active work.
  const completedThisSession = new Map();
  let previousQueueOrder = [];
  const queueHistory = createQueueHistory({ request, workApiUrl, openTaskPanel, cleanTaskTitle, queueDueLabel });

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
    select.value = activeResourceFilter;
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

  function renderWorkQueueSurface(model) {
    const taskRouteContext = getTaskRouteContext();
    const today = taskRouteContext.date || todayIsoDate();
    // The same task reaches this list through its lane query and its card's
    // checklist; deduplicate by id so the single queue never double-counts.
    // Actionable work (no open prerequisites) is the main queue. Tasks still
    // waiting on a prerequisite stay visible under "Waiting on other steps"
    // when Assignee is Mine/someone, so operators see their full plate and
    // the unlock condition — not a single mysterious leftover.
    const routedTasks = dedupeQueueTasks(routeTasks(taskRouteContext));
    const tasks = withoutWaitingOnPrerequisites(routedTasks);
    const blockedRoutedTasks = routedTasks.filter((task) =>
      isOpenWorkTask(task) && !tasks.some((open) => open.id === task.id) &&
      blockingPrerequisites(task).length > 0);
    for (const task of tasks) {
      const retained = completedThisSession.get(task.id);
      if (!retained || task.version <= retained.version) continue;
      if (task.status === "done") completedThisSession.set(task.id, task);
      else completedThisSession.delete(task.id);
    }
    const cardsById = state.workSnapshot.cardsById || new Map();
    const anySourceLoaded = Boolean(
      model?.stats?.liveLoaded !== false && (
        state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded ||
        Object.keys(state.workSnapshot.cardTasks || {}).length
      ),
    );

    const allOpenTasks = orderOpenTasks(tasks.filter((task) => !completedThisSession.has(task.id) && !isTaskDeferred(task, today)), today);
    for (const [id, task] of completedThisSession) {
      // Do not leak a completion into a different card/day route.
      if (taskRouteContext.cardId && task.cardId !== taskRouteContext.cardId) continue;
      if (taskRouteContext.date && task.date !== taskRouteContext.date) continue;
      allOpenTasks.push({ task });
    }
    if (completedThisSession.size) {
      const positions = new Map(previousQueueOrder.map((id, index) => [id, index]));
      allOpenTasks.sort((left, right) =>
        (positions.get(left.task.id) ?? Infinity) - (positions.get(right.task.id) ?? Infinity));
    }
    previousQueueOrder = allOpenTasks.map(({ task }) => task.id);
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
      section.append(renderTaskRouteContextView(taskRouteContext, {
      queueDueLabel,
      todayIsoDate,
      openCardPanel,
      getActiveWorkspaceRoute,
      navigateCanonicalWorkspace,
      activeAssigneeFilter,
    }));
    }

    const workErrors = (model?.stats?.workErrors || state?.workSnapshot?.errors || []).filter(Boolean);
    const retryWork = async () => {
      const routeToken = getActiveWorkspaceRouteToken?.();
      await refreshOperationsWorkSnapshot?.({ rerender: false });
      if (!routeToken || !isWorkspaceRouteFresh || isWorkspaceRouteFresh(routeToken)) refreshDocuments?.();
    };

    const board = document.createElement("div");
    board.className = "ops-queue-board";
    board.dataset.loadState = anySourceLoaded ? "ready" : workErrors.length > 0 ? "unavailable" : "loading";

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
        if (workErrors.length === 0) {
          board.append(renderQueueSkeleton());
        } else {
          board.append(renderQueueUnavailableState(retryWork));
        }
        return;
      }

      const assigneeFilter = activeAssigneeFilter();
      const target = assigneeTarget(assigneeFilter);
      const scope = assigneeScope(assigneeFilter);
      const assigneeOpen = allOpenTasks.filter((entry) => taskMatchesAssignee(entry.task, target));
      const filterCandidates = dedupeQueueTasks([
        ...tasks, ...completedThisSession.values(), ...queueHistory.tasks(),
      ]).filter((task) => taskMatchesAssignee(task, target)).map((task) => ({ task }));
      const resourceFilter = renderResourceFilter(filterCandidates, () => populateBoard());
      const browserFilter = renderBrowserFilter(filterCandidates, () => populateBoard());
      const visibleOpen = assigneeOpen.filter(
        (entry) =>
          taskMatchesResource(entry.task, activeResourceFilter) &&
          taskMatchesBrowser(entry.task, activeBrowserFilter),
      );
      visibleOpenTasks = visibleOpen;

      const visibleDone = dedupeQueueTasks([
        ...completedThisSession.values(), ...queueHistory.tasks(), ...doneTasks,
      ]).filter((task) =>
        (!taskRouteContext.cardId || task.cardId === taskRouteContext.cardId) &&
        (!taskRouteContext.date || task.date === taskRouteContext.date) &&
        taskMatchesAssignee(task, target) &&
        taskMatchesResource(task, activeResourceFilter) &&
        taskMatchesBrowser(task, activeBrowserFilter));

      if (anySourceLoaded) {
        // Who and what: the assignee filter, the required-resource filter, and
        // the browser-need filter share one toolbar row with the create actions.
        filters.prepend(
          renderAssigneeFilter(allOpenTasks),
          ...[resourceFilter, browserFilter].filter(Boolean),
        );

        const blockedForScope = blockedRoutedTasks.filter((task) =>
          taskMatchesAssignee(task, target) &&
          taskMatchesResource(task, activeResourceFilter) &&
          taskMatchesBrowser(task, activeBrowserFilter) &&
          !isTaskDeferred(task, today));

        if (visibleOpen.length > 0) {
          board.append(renderQueueTotalLine(visibleOpen.filter(({ task }) => task.status !== "done").length, scope,
            visibleOpen.filter(({ task }) => task.status === "done").length, blockedForScope.length));
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
          if (!target) {
            emptyMsg.textContent = "Your signed-in identity is not known, so Mine cannot be shown. Choose a person or All.";
          } else if (blockedForScope.length > 0) {
            emptyMsg.textContent =
              `No actionable tasks ${scope.phrase} right now — ${blockedForScope.length} still wait on other steps (see below).`;
          } else {
            emptyMsg.textContent = `No open tasks ${scope.phrase} right now.`;
          }
          board.append(emptyMsg);
        }

        if (blockedForScope.length > 0) {
          board.append(renderBlockedPrerequisiteSection(blockedForScope, {
            openTaskPanel,
            workTaskTitle,
          }));
        }

      }
      const deferred = tasks.filter((task) =>
        isTaskDeferred(task, today) && taskMatchesAssignee(task, target) &&
        taskMatchesResource(task, activeResourceFilter) && taskMatchesBrowser(task, activeBrowserFilter))
        .sort((left, right) => deferredWakeup(left).localeCompare(deferredWakeup(right)) ||
          workTaskTitle(left).localeCompare(workTaskTitle(right)) || left.id.localeCompare(right.id));
      if (deferred.length) {
        const waiting = document.createElement("details");
        waiting.className = "ops-queue-history ops-queue-waiting";
        const summary = document.createElement("summary");
        summary.textContent = `Waiting & snoozed (${deferred.length})`;
        waiting.append(summary);
        const list = document.createElement("div");
        list.className = "ops-queue-list";
        for (const task of deferred) list.append(renderWorkQueueRow(task, today, cardsById));
        waiting.append(list);
        board.append(waiting);
      }
      board.append(queueHistory.render(visibleDone, today, populateBoard));
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

  // All states share one chronology: a waiting follow-up is due on its
  // follow-up day, while ordinary work uses its deadline. Undated work is last.
  function orderOpenTasks(tasks) {
    return tasks.filter(isOpenWorkTask).slice().sort((left, right) =>
      (taskAttentionDate(left) || "9999-12-31").localeCompare(taskAttentionDate(right) || "9999-12-31") ||
      workTaskTitle(left).localeCompare(workTaskTitle(right)) || left.id.localeCompare(right.id),
    ).map((task) => ({ task }));
  }

  // Compare exact timestamps in Berlin alongside civil-day wakeups at midnight.
  function queueMoment(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00`;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  }

  // Every deferral must have elapsed before work is actionable again.
  function deferredWakeup(task) {
    return [task.followUpAt, task.snoozedUntil, task.notBeforeAt]
      .filter((date) => date && Number.isFinite(Date.parse(date))).map(queueMoment).sort().at(-1) || "";
  }

  function queueAttentionDay(task, today) {
    return isTaskDeferred(task, today) ? deferredWakeup(task).slice(0, 10) : taskAttentionDate(task);
  }

  // How much of the scoped work is on screen. The scope rides in the same
  // sentence as the count, so "25 of 40" always says whose 40.
  function renderQueueTotalLine(count, scope, completed = 0, blockedCount = 0) {
    const total = document.createElement("p");
    total.className = "ops-queue-total";
    const whose = scope ? ` ${scope.phrase}` : "";
    total.textContent =
      count > QUEUE_VISIBLE_LIMIT
        ? `Showing ${QUEUE_VISIBLE_LIMIT} of ${count} actionable${whose}, most urgent first`
        : `${count} actionable${whose}, most urgent first`;
    if (blockedCount) {
      total.textContent += ` · ${blockedCount} waiting on other steps`;
    }
    if (completed) total.textContent += ` · ${completed} completed this session`;
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

  async function toggleQueueTask(task, input) {
    if (queuePendingToggles.has(task.id)) return;
    queuePendingToggles.add(task.id);
    input.disabled = true;
    input.checked = true;
    try {
      const updated = await putQueueTaskStatus(task.id, "done", task.version);
      completedThisSession.set(task.id, updated);
      queueHistory.invalidate();
      queuePendingToggles.delete(task.id);
      if (input.isConnected) {
        input.closest(".ops-queue-row")?.setAttribute("data-completed", "true");
        input.disabled = false;
        input.setAttribute("aria-label", `Reopen ${cleanTaskTitle(task)}`);
      }
      try {
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        // The write succeeded. A failed refresh must not claim it was undone.
        input.title = `Task completed; queue refresh failed: ${err?.message || "request failed"}`;
      }
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
    const candidates = [findQueueTask(taskId), completedThisSession.get(taskId)].filter(Boolean);
    const current = candidates.sort((a, b) => b.version - a.version)[0];
    if (!current || !Number.isInteger(current.version)) return;
    try {
      await putQueueTaskStatus(taskId, "todo", current.version);
      completedThisSession.delete(taskId);
      queueHistory.remove(taskId);
      queueHistory.invalidate();
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
    const due = String(queueAttentionDay(task, today) || "").slice(0, 10);
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
    const completed = completedThisSession.has(task.id);
    input.checked = completed;
    if (completed) input.setAttribute("aria-label", `Reopen ${cleanTaskTitle(task)}`);
    const blockers = completed ? [] : queueToggleBlockers(task);
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
      input.addEventListener("change", async () => {
        if (!completedThisSession.has(task.id)) return toggleQueueTask(task, input);
        input.disabled = true;
        try { await reopenQueueTask(task.id); }
        catch (err) {
          input.title = `Could not reopen task: ${err?.message || "request failed"}`;
        } finally {
          input.disabled = false;
          input.checked = completedThisSession.has(task.id);
        }
      });
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
    // Work outside a Card opens its sponsor relationship or tuition agreement.
    if (task.subject?.href) {
      const type = task.subject.type === "tuition-agreement" ? "Tuition agreement"
        : task.subject.type === "sponsor-company" ? "Sponsor" : "Sponsor deal";
      const label = task.subject.label || type;
      return {
        label,
        kind: task.subject.type === "tuition-agreement" ? "tuition" : "sponsor",
        icon: task.subject.type === "tuition-agreement" ? "receipt" : "megaphone",
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
    const due = String(queueAttentionDay(task, today) || "").slice(0, 10);
    const debt = isOpenWorkTask(task) ? overdueDays(due, today) : 0;
    if (debt > 0) {
      cell.dataset.due = "overdue";
      cell.textContent = `${debt}d late`;
      cell.title = `${debt} day${debt === 1 ? "" : "s"} past due`;
      return cell;
    }
    if (!due) {
      cell.dataset.due = "none";
      cell.textContent = "—";
      return cell;
    }
    cell.dataset.due = due === today ? "today" : "later";
    cell.textContent =
      due === today ? "Today" : queueDueLabel(due, today);
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
    row.dataset.completed = task.status === "done" ? "true" : "false";
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
    // waits on describe it instead of riding inside the label. The glyphs
    // share one group after the title, which wraps instead of overflowing
    // when a narrow column cannot fit them all on the title line.
    const marks = document.createElement("span");
    marks.className = "ops-queue-marks";
    const resources = renderResourceMarks(task.requires, state.workSnapshot.resourcesById);
    if (resources) {
      marks.append(resources);
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
      marks.append(mark);
      row.dataset.browser = task.browserRequirement;
    }
    if (marks.children.length) titleRow.append(marks);
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
