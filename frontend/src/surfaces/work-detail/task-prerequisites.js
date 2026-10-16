import {
  blockingPrerequisites,
  nextDependsOn,
  prerequisiteChoices,
  prerequisiteStatusLabel,
  taskPrerequisites,
} from "../../core/task-dependencies.js";

// The task dialog's "Prerequisites" section: every task this one waits on,
// by name, with its current status. A prerequisite that is not done is the
// reason completion is disabled, so the section says so in words next to the
// list instead of leaving a dead button.
export function renderTaskPrerequisites(
  task,
  { openTask, siblings = [], busy = false, loadCardTasks, onSave } = {},
) {
  const prerequisites = taskPrerequisites(task, siblings);
  // A completed Task keeps its prerequisites, and only a Task on a Card has any.
  const editable = Boolean(task.cardId && onSave && task.status !== "done");
  if (prerequisites.length === 0 && !editable) return null;
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
  if (prerequisites.length === 0) {
    const none = document.createElement("p");
    none.className = "task-prerequisite-empty";
    none.textContent = "This task does not wait for any other task.";
    section.append(none);
  }
  section.append(list);

  if (blocking.length > 0) {
    const note = document.createElement("p");
    note.className = "task-prerequisite-note";
    note.dataset.blocked = "true";
    note.textContent = task.status === "todo" || task.status === "waiting"
      ? "Blocked: this task can be completed once every prerequisite is done or skipped."
      : "Blocked by an unfinished prerequisite.";
    section.append(note);
  }
  if (editable) section.append(renderPrerequisiteEditor(task, { busy, loadCardTasks, onSave }));
  return section;
}

// "Edit prerequisites": the card's other tasks by name and status. They load
// when the disclosure opens, so a task dialog costs no extra request until the
// operator asks to change the list.
function renderPrerequisiteEditor(task, { busy, loadCardTasks, onSave }) {
  const editor = document.createElement("details");
  editor.className = "task-prerequisite-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Edit prerequisites";
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
      status.className = `task-status-badge ${choice.status}`;
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
