// The queue's assignee scope. Whose work the queue shows lives in the URL
// (`/tasks?assignee=`), so Back/Forward and shared links carry it, and a bare
// /tasks is the signed-in operator's own queue.
const ASSIGNEE_DEFAULT = "me";

export function createQueueAssigneeFilter(context) {
  const {
    getActiveWorkspaceRoute,
    getCurrentOperator,
    navigateCanonicalWorkspace,
    resolveAssigneeLabel,
    state,
  } = context;

  // Whose work the queue shows, from the URL: `assignee=me` (the default, so
  // a bare /tasks is the signed-in operator's queue), `unassigned`, `all`, or
  // one workspace member's id. The same words as the API's `owner` filter
  // and the CLI's --owner/--mine, with `all` for no owner filter.
  function activeAssigneeFilter() {
    const route = getActiveWorkspaceRoute();
    return (route?.path === "/tasks" && route.params.get("assignee")) || ASSIGNEE_DEFAULT;
  }

  function currentOperatorId() {
    return String(getCurrentOperator()?.id || "");
  }

  // The filter resolved to what a task must carry: `me` becomes the signed-in
  // operator's id, or null when the identity is not known yet.
  function assigneeTarget(filter) {
    if (filter === "all" || filter === "unassigned") return filter;
    if (filter === "me") return currentOperatorId() || null;
    return filter;
  }

  function taskMatchesAssignee(task, target) {
    if (target === "all") return true;
    if (!target) return false;
    const assigneeId = String(task.assigneeId || "");
    if (target === "unassigned") return !assigneeId;
    return assigneeId === target;
  }

  function activeMembers() {
    return (state.workSnapshot.users || [])
      .filter((member) => member?.id && member.disabled !== true)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  // Whose work, as words for the count line and empty state.
  function assigneeScope(filter) {
    if (filter === "all") return null;
    if (filter === "unassigned") return { phrase: "unassigned", owner: "nobody" };
    const target = assigneeTarget(filter);
    if (filter === "me" || (target && target === currentOperatorId())) {
      return { phrase: "assigned to you", owner: "you" };
    }
    const name = resolveAssigneeLabel(target) || target;
    return { phrase: `assigned to ${name}`, owner: name };
  }

  // Moving the filter is navigation: it lands in the URL and history, so
  // Back returns to the previous scope and the link can be shared. The route
  // context (date, card) rides along; an open task does not.
  function selectAssignee(value) {
    const route = getActiveWorkspaceRoute();
    const params = new URLSearchParams(route?.path === "/tasks" ? route.params : undefined);
    params.delete("taskId");
    if (value === ASSIGNEE_DEFAULT) params.delete("assignee");
    else params.set("assignee", value);
    navigateCanonicalWorkspace("/tasks", params);
  }

  // One choice among Mine, Unassigned, All and each teammate: more than a
  // segmented track holds, so a select (docs/segmented.md), the same control
  // as the resource filter beside it. Each option carries its open count.
  function renderAssigneeFilter(openTasks) {
    const filter = activeAssigneeFilter();
    const meId = currentOperatorId();
    const count = (target) => openTasks.filter((entry) => taskMatchesAssignee(entry.task, target)).length;
    const label = document.createElement("label");
    label.className = "ops-queue-assignee-filter";
    const text = document.createElement("span");
    text.textContent = "Assignee";
    const select = document.createElement("select");
    select.className = "dk-select";
    select.setAttribute("aria-label", "Filter queue by assignee");
    const option = (parent, value, name) => {
      const entry = document.createElement("option");
      entry.value = value;
      entry.textContent = name;
      parent.append(entry);
    };
    option(select, "me", meId ? `Mine (${count(meId)})` : "Mine");
    option(select, "unassigned", `Unassigned (${count("unassigned")})`);
    option(select, "all", `All (${openTasks.length})`);
    const people = document.createElement("optgroup");
    people.label = "People";
    const members = activeMembers().filter((member) => String(member.id) !== meId);
    for (const member of members) {
      option(people, String(member.id), `${member.name || member.email} (${count(String(member.id))})`);
    }
    // A deep link to someone who is not an active member still filters to
    // them, and says so, rather than quietly showing somebody else's work.
    const known = ["me", "all", "unassigned", meId, ...members.map((member) => String(member.id))];
    if (!known.includes(filter)) {
      option(people, filter, `${resolveAssigneeLabel(filter) || filter}, not active (${count(filter)})`);
    }
    if (people.children.length > 0) select.append(people);
    select.value = filter === meId ? "me" : filter;
    select.addEventListener("change", () => selectAssignee(select.value));
    label.append(text, select);
    return label;
  }

  return {
    activeAssigneeFilter,
    assigneeScope,
    assigneeTarget,
    renderAssigneeFilter,
    taskMatchesAssignee,
  };
}
