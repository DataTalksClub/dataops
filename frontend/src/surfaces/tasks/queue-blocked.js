import { blockedReason, blockingPrerequisites, prerequisiteResolved } from "../../core/task-dependencies.js";

/**
 * Assigned (or scoped) tasks that still wait on prerequisites.
 * Shown under the actionable queue so Mine is honest about blocked work.
 */
export function renderBlockedPrerequisiteSection(tasks, { openTaskPanel, workTaskTitle }) {
  const section = document.createElement("section");
  section.className = "ops-queue-blocked";
  section.setAttribute("aria-label", "Waiting on other steps");

  const heading = document.createElement("h3");
  heading.className = "ops-queue-blocked-title";
  heading.textContent = `Waiting on other steps (${tasks.length})`;
  section.append(heading);

  const hint = document.createElement("p");
  hint.className = "ops-queue-blocked-hint";
  hint.textContent =
    "These are assigned to the current scope but stay grey until their prerequisites are done or skipped.";
  section.append(hint);

  const list = document.createElement("ul");
  list.className = "ops-queue-blocked-list";
  for (const task of tasks) {
    const item = document.createElement("li");
    item.className = "ops-queue-blocked-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-blocked-open";
    button.textContent = workTaskTitle(task);
    button.addEventListener("click", () => openTaskPanel(task.id));
    item.append(button);
    const reason = blockedReason(task) || unlockHint(task);
    if (reason) {
      const note = document.createElement("small");
      note.className = "ops-queue-blocked-reason";
      note.textContent = reason;
      item.append(note);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function unlockHint(task) {
  const blocking = blockingPrerequisites(task).filter(
    (entry) => !prerequisiteResolved(entry.status),
  );
  if (!blocking.length) return "";
  const names = blocking
    .map((entry) => entry.description || entry.id)
    .filter(Boolean);
  return names.length
    ? `Blocked until you complete or skip ${names.join(", ")}`
    : "";
}
