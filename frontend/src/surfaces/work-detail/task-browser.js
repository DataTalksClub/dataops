// Whether doing this Task needs an interactive browser: the high-level
// execution need, separate from the `requires` accounts and from free-form
// tags. `required` and `headless` are human-made classifications; absent is
// an honest "not classified" that no surface ever presents as safe headless
// work. Editing is the same draft-with-one-Save flow as the required
// resources section, because every Task write is a versioned intent.

import { browserRequirementParts } from "../../core/task-display.js";

const BROWSER_OPTIONS = [
  ["unclassified", "Not classified — decide before trusting it headless"],
  ["headless", "Headless — the whole Task finishes without a browser"],
  ["required", "Browser required — an interactive browser is needed"],
];

export function createTaskBrowser({
  createTaskActionButton,
  renderTaskPanel,
  saveTaskBrowser,
  taskPanelBody,
}) {
  let browserDraft = null; // { taskId, value: 'required' | 'headless' | 'unclassified' } while editing

  function editTaskBrowser(task) {
    browserDraft = {
      taskId: task.id,
      value: task.browserRequirement === "required" || task.browserRequirement === "headless"
        ? task.browserRequirement
        : "unclassified",
    };
    renderTaskPanel({ preserveDrafts: true });
    taskPanelBody.querySelector('[data-panel-field="browser-requirement"]')?.focus();
  }

  function stopEditingTaskBrowser() {
    browserDraft = null;
    renderTaskPanel({ preserveDrafts: true });
    taskPanelBody.querySelector("[data-browser-edit]")?.focus();
  }

  function renderTaskBrowser(task, busy) {
    const editable = ["todo", "waiting"].includes(task.status);
    if (browserDraft && (browserDraft.taskId !== task.id || !editable)) browserDraft = null;
    const current = browserRequirementParts(task.browserRequirement);

    const section = document.createElement("section");
    section.className = "task-browser";
    section.setAttribute("aria-label", "Browser requirement");
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.id = "task-browser-label";
    label.textContent = "Browser";
    section.append(label);

    if (browserDraft) {
      section.classList.add("is-editing");
      section.append(renderTaskBrowserEditor(task, busy));
      return section;
    }

    const row = document.createElement("div");
    row.className = "task-browser-row";
    const value = document.createElement("p");
    value.className = "task-browser-value";
    value.dataset.browser = current.classified ? task.browserRequirement : "unclassified";
    value.textContent = current.label;
    row.append(value);
    if (editable) {
      row.classList.add("is-editable");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "task-browser-edit";
      edit.dataset.browserEdit = "true";
      edit.textContent = "Edit";
      edit.setAttribute("aria-label", "Edit whether this Task needs a browser");
      edit.title = "Edit whether this Task needs a browser";
      edit.disabled = busy;
      edit.addEventListener("click", () => editTaskBrowser(task));
      row.append(edit);
    }
    section.append(row);
    return section;
  }

  function renderTaskBrowserEditor(task, busy) {
    const editor = document.createElement("div");
    editor.className = "task-browser-editor";
    const select = document.createElement("select");
    select.className = "dk-select";
    select.dataset.panelField = "browser-requirement";
    select.setAttribute("aria-labelledby", "task-browser-label");
    for (const [value, text] of BROWSER_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = value === browserDraft.value;
      select.append(option);
    }
    select.disabled = busy;
    select.addEventListener("change", () => {
      if (browserDraft?.taskId === task.id) browserDraft.value = select.value;
    });
    editor.append(select);
    // Esc leaves the editor instead of closing the whole dialog with the
    // draft in it — the same escape hatch the required-resources editor gives.
    editor.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      stopEditingTaskBrowser();
    });
    const actions = document.createElement("div");
    actions.className = "task-browser-actions";
    const save = createTaskActionButton("Save", () => {
      const next = browserDraft?.value || "unclassified";
      const before = task.browserRequirement === "required" || task.browserRequirement === "headless"
        ? task.browserRequirement
        : "unclassified";
      browserDraft = null;
      if (next === before) {
        stopEditingTaskBrowser();
        return null;
      }
      return saveTaskBrowser(task.id, next === "unclassified" ? null : next, task.version);
    });
    save.classList.add("is-primary");
    save.disabled = busy;
    const cancel = createTaskActionButton("Cancel", () => stopEditingTaskBrowser());
    actions.append(save, cancel);
    editor.append(actions);
    return editor;
  }

  return { renderTaskBrowser };
}
