// Task dependencies as the UI reads them. The API resolves each Task's
// prerequisites (`prerequisites`: name and current status) and whether it is
// `blocked`; a prerequisite is resolved, and satisfies its dependents, when it
// is done or skipped. When a Task arrives without the
// resolved list (it only has `dependsOn` ids), sibling Tasks on the card fill
// it in.

const STATUS_LABELS = {
  done: "Done",
  todo: "To do",
  waiting: "Waiting",
  skipped: "Skipped",
  missing: "Missing, remove this dependency",
};

export function prerequisiteStatusLabel(status) {
  return STATUS_LABELS[status] || String(status || "");
}

export function taskPrerequisites(task, siblings = []) {
  if (Array.isArray(task?.prerequisites)) return task.prerequisites;
  const ids = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
  const byId = new Map(siblings.map((sibling) => [sibling?.id, sibling]));
  return ids.map((id) => {
    const found = byId.get(id);
    return found
      ? { id, description: found.description, status: found.status }
      : { id, description: id, status: "missing" };
  });
}

// A done or skipped prerequisite no longer holds its dependents back.
export function prerequisiteResolved(status) {
  return status === "done" || status === "skipped";
}

// The prerequisites still in the way of an open Task, in listed order.
export function blockingPrerequisites(task, siblings = []) {
  if (!task || prerequisiteResolved(task.status)) return [];
  return taskPrerequisites(task, siblings).filter((entry) => !prerequisiteResolved(entry.status));
}

export function taskIsBlocked(task, siblings = []) {
  return blockingPrerequisites(task, siblings).length > 0;
}

function quoted(entries) {
  return entries.map((entry) => `"${entry.description}"`).join(", ");
}

// "Complete or skip "A", "B" first": the reason a blocked Task cannot be completed.
export function blockedReason(task, siblings = []) {
  const blocking = blockingPrerequisites(task, siblings);
  return blocking.length ? `Complete or skip ${quoted(blocking)} first` : "";
}

// Short form for a row: the first blocker's name plus a count of the rest.
export function blockedSummary(task, siblings = []) {
  const blocking = blockingPrerequisites(task, siblings);
  if (!blocking.length) return "";
  const rest = blocking.length - 1;
  return `Blocked by ${blocking[0].description}${rest ? ` +${rest} more` : ""}`;
}

// Whether `candidate` already waits on `task`, directly or through others.
// Offering it as a prerequisite would close a cycle, so the editor greys it.
export function waitsOnTask(candidate, task, siblings) {
  const byId = new Map(siblings.map((sibling) => [sibling.id, sibling]));
  const seen = new Set();
  const stack = [...(candidate?.dependsOn || [])];
  while (stack.length) {
    const id = stack.pop();
    if (id === task.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn || []));
  }
  return false;
}

// Same-card Tasks the operator may pick as prerequisites of `task`, by name,
// each with its status and, when it cannot be chosen, why.
export function prerequisiteChoices(task, siblings = []) {
  return siblings
    .filter((sibling) => sibling?.id && sibling.id !== task.id)
    .map((sibling) => ({
      id: sibling.id,
      description: sibling.description,
      status: sibling.status,
      unavailable: waitsOnTask(sibling, task, siblings)
        ? "Already waits on this task, so it cannot also be its prerequisite"
        : "",
    }));
}

// Order-preserving next value: kept ids stay where they were, new ones append.
export function nextDependsOn(current = [], ticked = []) {
  return [...current.filter((id) => ticked.includes(id)), ...ticked.filter((id) => !current.includes(id))];
}

// Same-card Tasks that wait on `task`: what finishing it unblocks.
export function taskDependents(task, siblings = []) {
  if (!task?.id) return [];
  return siblings.filter((sibling) => sibling?.id !== task.id
    && Array.isArray(sibling?.dependsOn) && sibling.dependsOn.includes(task.id));
}

// "after A", "after A and B", "after A, B and C": the quiet line under a
// waiting task. Names only, in listed order.
export function afterText(entries) {
  const names = entries.map((entry) => entry.description);
  if (names.length <= 1) return `after ${names[0] || ""}`.trim();
  return `after ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Order that never puts a step before its prerequisite. `tasks` arrive in
// their display order; a task moves down only as far as its last listed
// prerequisite, and everything else keeps its place. Only edges between two
// open (or two resolved) tasks count, so resolved tasks can stay grouped
// last; edges to tasks outside the list, and cycles, are ignored.
export function orderAfterPrerequisites(tasks) {
  const byId = new Map(tasks.map((task) => [task?.id, task]));
  const placed = new Set();
  const pending = [...tasks];
  const ordered = [];
  const counts = (task, id) => byId.has(id) && id !== task.id
    && prerequisiteResolved(byId.get(id).status) === prerequisiteResolved(task.status);
  while (pending.length) {
    const next = pending.findIndex((task) => (task?.dependsOn || [])
      .every((id) => !counts(task, id) || placed.has(id)));
    const [task] = pending.splice(next === -1 ? 0 : next, 1);
    placed.add(task?.id);
    ordered.push(task);
  }
  return ordered;
}
