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
  heading.append("Waiting on other steps ");
  const count = document.createElement("span");
  count.className = "ops-queue-blocked-count";
  count.textContent = `(${tasks.length})`;
  heading.append(count);
  section.append(heading);

  const hint = document.createElement("p");
  hint.className = "ops-queue-blocked-hint";
  hint.textContent =
    "These are assigned to the current scope but stay grey until their prerequisites are done or skipped.";
  section.append(hint);

  const list = document.createElement("ul");
  list.className = "ops-queue-blocked-list";
  for (const task of tasks) {
    // One row per blocked task: a muted marker plus a body of title + unlock
    // note. Assignee and due affordances are deliberately omitted here — the
    // scope filter above already says whose work this is, and a due chip
    // would borrow the main table's urgency language for work that is not
    // actionable yet. The unlock condition is the only per-row data.
    const item = document.createElement("li");
    item.className = "ops-queue-blocked-item";
    const marker = document.createElement("span");
    marker.className = "ops-queue-blocked-marker";
    marker.setAttribute("aria-hidden", "true");
    item.append(marker);
    const body = document.createElement("div");
    body.className = "ops-queue-blocked-body";
    const title = workTaskTitle(task);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-blocked-open";
    button.textContent = title;
    button.title = title;
    button.setAttribute("aria-label", `Open task ${title}`);
    button.addEventListener("click", () => openTaskPanel(task.id));
    body.append(button);
    const reason = blockedReason(task) || unlockHint(task);
    if (reason) {
      const note = document.createElement("small");
      note.className = "ops-queue-blocked-reason";
      note.textContent = reason;
      note.title = reason;
      body.append(note);
    }
    item.append(body);
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
