// Task dependencies as the UI reads them. The API resolves each Task's
// prerequisites (`prerequisites`: name and current status) and whether it is
// `blocked`; a prerequisite satisfies a dependency only when it is done, so a
// skipped one keeps its dependents blocked. When a Task arrives without the
// resolved list (it only has `dependsOn` ids), sibling Tasks on the card fill
// it in.

const STATUS_LABELS = {
  done: "Done",
  todo: "To do",
  waiting: "Waiting",
  skipped: "Skipped, does not unblock",
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

// The prerequisites still in the way of an open Task, in listed order.
export function blockingPrerequisites(task, siblings = []) {
  if (!task || task.status === "done" || task.status === "skipped") return [];
  return taskPrerequisites(task, siblings).filter((entry) => entry.status !== "done");
}

export function taskIsBlocked(task, siblings = []) {
  return blockingPrerequisites(task, siblings).length > 0;
}

function quoted(entries) {
  return entries.map((entry) => `"${entry.description}"`).join(", ");
}

// "Complete "A", "B" first": the reason a blocked Task cannot be completed.
export function blockedReason(task, siblings = []) {
  const blocking = blockingPrerequisites(task, siblings);
  return blocking.length ? `Complete ${quoted(blocking)} first` : "";
}

// Short form for a row: the first blocker's name plus a count of the rest.
export function blockedSummary(task, siblings = []) {
  const blocking = blockingPrerequisites(task, siblings);
  if (!blocking.length) return "";
  const rest = blocking.length - 1;
  return `Blocked by ${blocking[0].description}${rest ? ` +${rest} more` : ""}`;
}
