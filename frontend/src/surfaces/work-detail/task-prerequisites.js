import {
  blockingPrerequisites,
  prerequisiteStatusLabel,
  taskPrerequisites,
} from "../../core/task-dependencies.js";

// The task dialog's "Prerequisites" section: every task this one waits on,
// by name, with its current status. A prerequisite that is not done is the
// reason completion is disabled, so the section says so in words next to the
// list instead of leaving a dead button.
export function renderTaskPrerequisites(task, { openTask, siblings = [] } = {}) {
  const prerequisites = taskPrerequisites(task, siblings);
  if (prerequisites.length === 0) return null;
  const blocking = blockingPrerequisites(task, siblings);
  const section = document.createElement("section");
  section.className = "task-prerequisites";
  section.setAttribute("aria-label", "Prerequisites");
  const label = document.createElement("div");
  label.className = "task-history-label";
  label.textContent = "Prerequisites";
  section.append(label);

  const list = document.createElement("ul");
  list.className = "task-prerequisite-rows";
  for (const entry of prerequisites) {
    const row = document.createElement("li");
    row.className = "task-prerequisite-row";
    row.dataset.prerequisiteId = entry.id;
    row.dataset.status = entry.status;
    const name = document.createElement(entry.status === "missing" ? "span" : "button");
    name.className = "task-prerequisite-name";
    name.textContent = entry.description;
    if (entry.status !== "missing") {
      name.type = "button";
      name.title = "Open this task";
      name.addEventListener("click", () => openTask?.(entry.id));
    }
    const status = document.createElement("span");
    status.className = `task-status-badge ${entry.status}`;
    status.textContent = prerequisiteStatusLabel(entry.status);
    row.append(name, status);
    list.append(row);
  }
  section.append(list);

  if (blocking.length > 0) {
    const note = document.createElement("p");
    note.className = "task-prerequisite-note";
    note.dataset.blocked = "true";
    note.textContent = task.status === "todo" || task.status === "waiting"
      ? "Blocked: this task can be completed once every prerequisite is done."
      : "Blocked by an unfinished prerequisite.";
    section.append(note);
  }
  return section;
}
