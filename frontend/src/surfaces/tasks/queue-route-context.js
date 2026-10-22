export function renderTaskRouteContext(taskRouteContext, {
  queueDueLabel,
  todayIsoDate,
  openCardPanel,
  getActiveWorkspaceRoute,
  navigateCanonicalWorkspace,
  activeAssigneeFilter,
}) {
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
    routeContext.append(renderTaskRouteContextFailure(failure, {
      getActiveWorkspaceRoute,
      navigateCanonicalWorkspace,
      activeAssigneeFilter,
    }));
  }
  return routeContext;
}

export function renderTaskRouteContextFailure(failure, {
  getActiveWorkspaceRoute,
  navigateCanonicalWorkspace,
  activeAssigneeFilter,
}) {
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
