import { isCanonicalWorkTask } from "../../core/workspace.js";

export function createTaskQueue(context) {
  const {
    allWorkTasks,
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
    sortWorkTasks,
    state,
    taskDate,
    taskNextActionLabel,
    taskProofState,
    taskSourceLabel,
    todayIsoDate,
    workTaskTitle,
  } = context;

  function renderWorkQueueSurface() {
    const taskRouteContext = getTaskRouteContext();
    const today = taskRouteContext.date || todayIsoDate();
    const tasks = Array.isArray(taskRouteContext.tasks)
      ? taskRouteContext.tasks
      : allWorkTasks(state.workSnapshot);
    const groupLoaded = {
      Overdue: state.workSnapshot.overdueLoaded,
      "Follow-ups due": state.workSnapshot.waitingLoaded,
      "Missing proof":
        state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded,
      Waiting: state.workSnapshot.waitingLoaded,
      Today: state.workSnapshot.todayLoaded,
      "Done / history":
        state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded,
    };
    const groups = [
      ["Overdue", tasks.filter((task) => isTaskOverdue(task, today))],
      [
        "Follow-ups due",
        tasks.filter((task) => isFollowUpDueTask(task, today)),
      ],
      [
        "Missing proof",
        tasks.filter(
          (task) => isOpenWorkTask(task) && !taskProofState(task).ok,
        ),
      ],
      [
        "Waiting",
        tasks.filter(
          (task) =>
            isWaitingOrFollowUpTask(task) && !isFollowUpDueTask(task, today),
        ),
      ],
      ["Today", tasks.filter((task) => isTaskDueToday(task, today))],
      [
        "Done / history",
        tasks.filter(
          (task) => isCanonicalWorkTask(task) && task.status === "done",
        ),
      ],
    ];

    const section = document.createElement("section");
    section.className = "ops-work-queue";
    section.setAttribute("aria-label", "Work queue");
    if (
      taskRouteContext.date ||
      taskRouteContext.cardId ||
      taskRouteContext.contextCardId ||
      taskRouteContext.failures.length
    ) {
      const routeContext = document.createElement("aside");
      routeContext.className = "task-route-context";
      routeContext.setAttribute("aria-label", "Task queue route context");
      const heading = document.createElement("h3");
      heading.textContent = "Queue context";
      const summary = document.createElement("p");
      summary.textContent = [
        taskRouteContext.date ? `Date ${taskRouteContext.date}` : "",
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
      section.append(routeContext);
    }
    for (const [groupIndex, [label, list]] of groups.entries()) {
      const group = document.createElement("article");
      group.className = "ops-queue-group";
      group.dataset.queueGroup = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.id = `queue-group-${groupIndex}`;
      title.textContent = label;
      const count = document.createElement("span");
      count.textContent = String(list.length);
      count.setAttribute("aria-label", `${list.length} ${label.toLowerCase()} tasks`);
      header.append(title, count);
      group.setAttribute("aria-labelledby", title.id);
      group.append(header);
      const rows = document.createElement("div");
      rows.className = "ops-queue-rows";
      rows.dataset.loadState = groupLoaded[label] ? "ready" : "unavailable";
      if (list.length === 0) {
        const empty = document.createElement("p");
        empty.className = "ops-empty";
        empty.dataset.state = groupLoaded[label] ? "empty" : "unavailable";
        empty.textContent = groupLoaded[label]
          ? `No ${label.toLowerCase()} work.`
          : "Live work data unavailable.";
        rows.append(empty);
      } else {
        const visible =
          label === "Done / history"
            ? list
                .slice()
                .sort((a, b) =>
                  compareIsoDate(taskDate(b) || "", taskDate(a) || ""),
                )
                .slice(0, 12)
            : sortWorkTasks(
                list,
                label === "Overdue" ? "overdue" : "today",
                today,
              );
        for (const task of visible)
          rows.append(renderWorkQueueRow(task, today));
      }
      group.append(rows);
      section.append(group);
    }
    return section;
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

  function renderWorkQueueRow(task, today) {
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
    const status = task.status;
    for (const value of [
      status,
      task.date ? `Due ${formatTaskDateMeta(task.date, today)}` : "",
      task.assigneeId
        ? `Owner ${resolveAssigneeLabel(task.assigneeId)}`
        : "Unassigned",
      task.cardId ? "Card task" : "Independent task",
      taskSourceLabel(task),
      taskProofState(task).label,
    ].filter(Boolean)) {
      const chip = document.createElement("span");
      chip.textContent = value;
      meta.append(chip);
    }
    const summary = document.createElement("small");
    summary.textContent = task.waitingFor
      ? `Waiting for ${task.waitingFor}${task.followUpAt ? ` · follow up ${formatTaskDateMeta(task.followUpAt, today)}` : ""}`
      : `Next: ${taskNextActionLabel(task, today)}`;
    button.append(title, meta, summary);
    return button;
  }

  return { renderWorkQueueSurface };
}
