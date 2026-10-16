import {
  nextDependsOn,
  prerequisiteChoices,
  prerequisiteResolved,
  prerequisiteStatusLabel,
  taskDependents,
  taskPrerequisites,
} from "../../core/task-dependencies.js";

// The task dialog's dependency sections. "Waiting on" lists what this task
// waits on and "Unblocks" what finishing it releases; each appears only when
// it has an entry, so a task with no dependencies shows nothing here. A task
// on a Card that may still change its prerequisites keeps the editor: an
// "Edit" control on "Waiting on", or "Add a prerequisite" under the dialog's
// "Attachments, notes and history" disclosure when it has none.
export function renderTaskDependencies(
  task,
  { openTask, siblings = [], busy = false, loadCardTasks, onSave } = {},
) {
  const editable = Boolean(task.cardId && onSave && task.status !== "done");
  const container = document.createElement("div");
  container.className = "task-dependencies";

  const render = (cardTasks) => {
    const prerequisites = taskPrerequisites(task, cardTasks);
    const dependents = taskDependents(task, cardTasks);
    const byId = new Map(cardTasks.map((sibling) => [sibling?.id, sibling]));
    const sections = [];
    if (prerequisites.length > 0) {
      const section = dependencySection("Waiting on", "task-prerequisites", prerequisites, { byId, openTask });
      if (editable) {
        const editor = renderPrerequisiteEditor(task, { busy, loadCardTasks, onSave, summary: "Edit" });
        editor.classList.add("is-inline");
        section.append(editor);
      }
      sections.push(section);
    }
    if (dependents.length > 0) {
      sections.push(dependencySection("Unblocks", "task-dependents", dependents, { byId, openTask }));
    }
    container.replaceChildren(...sections);
  };

  render(siblings);
  // The dialog may open without the card's tasks at hand (from the queue,
  // say). They load once; "Unblocks" appears if anything waits on this task.
  if (siblings.length === 0 && task.cardId && typeof loadCardTasks === "function") {
    Promise.resolve()
      .then(() => loadCardTasks())
      .then((cardTasks) => {
        if (Array.isArray(cardTasks) && cardTasks.length > 0) render(cardTasks);
      })
      .catch(() => {});
  }
  return { element: container, editable };
}

// "Add a prerequisite" for a task that has none: the same editor, offered
// from the dialog's secondary disclosure instead of an empty section.
export function renderAddPrerequisite(task, { busy = false, loadCardTasks, onSave } = {}) {
  if (!task.cardId || !onSave || task.status === "done") return null;
  if (taskPrerequisites(task).length > 0) return null;
  return renderPrerequisiteEditor(task, { busy, loadCardTasks, onSave, summary: "Add a prerequisite" });
}

function dependencySection(title, className, entries, { byId, openTask }) {
  const section = document.createElement("section");
  section.className = `task-dependency-section ${className}`;
  section.setAttribute("aria-label", title);
  const label = document.createElement("div");
  label.className = "task-history-label";
  label.textContent = title;
  section.append(label);

  const list = document.createElement("ul");
  list.className = "task-dependency-rows";
  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = "task-dependency-row";
    row.dataset.taskId = entry.id;
    row.dataset.status = entry.status;
    const resolved = prerequisiteResolved(entry.status);
    const dot = document.createElement("span");
    dot.className = `dk-dot ${resolved ? "dk-dot--success" : "dk-dot--neutral"}`;
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement(entry.status === "missing" ? "span" : "button");
    name.className = "task-dependency-name";
    name.textContent = entry.description;
    if (entry.status !== "missing") {
      name.type = "button";
      name.title = `Open “${entry.description}”`;
      name.addEventListener("click", () => openTask?.(entry.id));
    }
    // Resolved and broken entries say so; open ones show when they are due.
    const date = String(byId.get(entry.id)?.date || "").slice(0, 10);
    const meta = document.createElement("span");
    meta.className = "task-dependency-meta";
    if (resolved || entry.status === "missing" || !date) {
      meta.textContent = prerequisiteStatusLabel(entry.status);
    } else {
      meta.classList.add("dk-mono");
      meta.textContent = shortDate(date);
      meta.title = prerequisiteStatusLabel(entry.status);
    }
    row.append(dot, name, meta);
    list.append(row);
  }
  section.append(list);
  return section;
}

function shortDate(iso) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
}

// The editor: the card's other tasks by name and status. They load when the
// disclosure opens, so the dialog costs no extra request until the operator
// asks to change the list.
function renderPrerequisiteEditor(task, { busy, loadCardTasks, onSave, summary: summaryText }) {
  const editor = document.createElement("details");
  editor.className = "task-prerequisite-editor";
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  editor.append(summary);
  const body = document.createElement("div");
  body.className = "task-prerequisite-options";
  editor.append(body);

  let loaded = false;
  const showMessage = (text) => {
    const message = document.createElement("p");
    message.className = "task-prerequisite-empty";
    message.textContent = text;
    body.replaceChildren(message);
  };
  const populate = (siblings) => {
    const choices = prerequisiteChoices(task, siblings);
    if (choices.length === 0) {
      showMessage("This card has no other tasks to depend on.");
      return;
    }
    const current = task.dependsOn || [];
    const boxes = [];
    const rows = choices.map((choice) => {
      const option = document.createElement("label");
      option.className = "task-prerequisite-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = choice.id;
      box.checked = current.includes(choice.id);
      box.disabled = busy || (Boolean(choice.unavailable) && !box.checked);
      if (choice.unavailable) option.title = choice.unavailable;
      boxes.push(box);
      const name = document.createElement("span");
      name.className = "task-prerequisite-name";
      name.textContent = choice.description;
      const status = document.createElement("span");
      status.className = "task-prerequisite-status";
      status.textContent = prerequisiteStatusLabel(choice.status);
      option.append(box, name, status);
      return option;
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "task-action-btn";
    save.textContent = "Save prerequisites";
    save.disabled = busy;
    save.addEventListener("click", () => {
      const ticked = boxes.filter((box) => box.checked).map((box) => box.value);
      onSave(nextDependsOn(current, ticked));
    });
    body.replaceChildren(...rows, save);
  };
  editor.addEventListener("toggle", async () => {
    if (!editor.open || loaded) return;
    loaded = true;
    showMessage("Loading this card's tasks…");
    try {
      populate(await loadCardTasks());
    } catch {
      loaded = false;
      showMessage("Could not load this card's tasks. Close and reopen to retry.");
    }
  });
  return editor;
}
