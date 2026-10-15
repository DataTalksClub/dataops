// What a Task needs outside DataOps (its required resources). Whoever lacks
// one of these accounts leaves the Task for someone who has it, so the panel
// names each one and lets the operator correct the list with the kit's tag
// input (dakit dk-tag-input): chips to remove, a field that filters the
// vocabulary from GET /api/resources.

import "../../dakit/tag-input.js";
import { renderIcon } from "../../core/icons.js";
import { renderResourceMarks, resourcesFromPayload } from "../../core/resources.js";

export function createTaskRequires({
  createTaskActionButton,
  renderTaskPanel,
  request,
  saveTaskRequires,
  state,
  taskPanelBody,
  workApiUrl,
}) {
  // Editing is a draft with one Save, not a save per chip: every Task write
  // is a versioned intent that locks and re-renders the whole panel and
  // refuses a second write while one is in flight, so per-chip saves would
  // drop quick successive picks or need a queue around the intent pipeline.
  // The draft survives panel re-renders until it is saved or cancelled.
  let requiresDraft = null; // { taskId, value: string[] } while editing
  // The vocabulary from GET /api/resources when the work snapshot has none
  // yet (a Task opened by deep link before the queue loads).
  let requiresVocabulary = { status: "idle", resources: [] };

  function requiresResources() {
    const fromSnapshot = state.workSnapshot.resources || [];
    return fromSnapshot.length ? fromSnapshot : requiresVocabulary.resources;
  }

  function loadRequiresVocabulary() {
    if (requiresVocabulary.status === "loading" || requiresVocabulary.status === "loaded") return;
    requiresVocabulary = { status: "loading", resources: [] };
    request(workApiUrl("/api/resources"))
      .then((payload) => {
        requiresVocabulary = { status: "loaded", resources: resourcesFromPayload(payload) };
      })
      .catch(() => {
        requiresVocabulary = { status: "failed", resources: [] };
      })
      .finally(() => {
        if (!requiresDraft) return;
        renderTaskPanel({ preserveDrafts: true });
        taskPanelBody.querySelector('[data-panel-field="requires"]')?.focus();
      });
  }

  function editTaskRequires(task) {
    requiresDraft = { taskId: task.id, value: [...(task.requires || [])] };
    if (!(state.workSnapshot.resources || []).length) loadRequiresVocabulary();
    renderTaskPanel({ preserveDrafts: true });
    taskPanelBody.querySelector('[data-panel-field="requires"]')?.focus();
  }

  function stopEditingTaskRequires() {
    requiresDraft = null;
    renderTaskPanel({ preserveDrafts: true });
    taskPanelBody.querySelector("[data-requires-edit]")?.focus();
  }

  function renderTaskRequires(task, busy) {
    const resources = requiresResources();
    const resourcesById = resources.length
      ? new Map(resources.map((resource) => [resource.id, resource]))
      : state.workSnapshot.resourcesById || new Map();
    const requires = Array.isArray(task.requires) ? task.requires : [];
    const editable = ["todo", "waiting"].includes(task.status);
    if (requiresDraft && (requiresDraft.taskId !== task.id || !editable)) requiresDraft = null;
    const section = document.createElement("section");
    section.className = "task-requires";
    section.setAttribute("aria-label", "Required resources");
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.id = "task-requires-label";
    label.textContent = "Needs";
    section.append(label);

    if (requiresDraft) {
      // Save and Cancel sit on the label row (CSS), so the open list below
      // the field never covers them.
      section.classList.add("is-editing");
      section.append(renderTaskRequiresEditor(task, resources, busy));
      return section;
    }

    const row = document.createElement("div");
    row.className = "task-requires-row";
    const marks = renderResourceMarks(requires, resourcesById, { withName: true });
    if (marks) {
      row.append(marks);
    } else {
      const none = document.createElement("p");
      none.className = "task-requires-empty";
      none.textContent = "Nothing outside DataOps.";
      row.append(none);
    }
    if (editable) {
      // A press on the chips opens the editor too; the button is the
      // keyboard and screen-reader way in.
      row.classList.add("is-editable");
      row.addEventListener("click", (event) => {
        if (busy || event.target?.closest?.("button")) return;
        editTaskRequires(task);
      });
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "task-requires-edit";
      edit.dataset.requiresEdit = "true";
      const verb = requires.length ? "Edit" : "Add";
      edit.textContent = verb;
      edit.setAttribute("aria-label", `${verb} what this task needs`);
      edit.title = `${verb} what this task needs`;
      edit.disabled = busy;
      edit.addEventListener("click", () => editTaskRequires(task));
      row.append(edit);
    }
    section.append(row);
    return section;
  }

  function renderTaskRequiresEditor(task, resources, busy) {
    const editor = document.createElement("div");
    editor.className = "task-requires-editor";
    const loading = !resources.length && requiresVocabulary.status !== "failed";
    const tags = globalThis.dakitTagInput.create({
      labelledBy: "task-requires-label",
      label: "Needs",
      placeholder: loading ? "Loading resources…" : "Type to add an account or tool…",
      noMatches: "No matching resource",
      options: resources.map((resource) => ({
        value: resource.id,
        label: resource.name,
        aliases: [resource.id],
        icon: () => renderIcon(resource.icon, { size: 16 }),
      })),
      value: requiresDraft.value,
      disabled: busy || loading,
      onChange: (value) => {
        if (requiresDraft?.taskId === task.id) requiresDraft.value = value;
      },
    });
    tags.input.dataset.panelField = "requires";
    editor.append(tags.element);
    if (requiresVocabulary.status === "failed" && !resources.length) {
      const failed = document.createElement("p");
      failed.className = "task-requires-empty";
      failed.setAttribute("role", "alert");
      failed.textContent = "Could not load the resource list. Cancel and edit again to retry.";
      editor.append(failed);
    }
    // Esc that the tag input did not use (list closed, no text) leaves the
    // editor instead of closing the whole dialog with the draft in it.
    editor.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      stopEditingTaskRequires();
    });
    const actions = document.createElement("div");
    actions.className = "task-requires-actions";
    const save = createTaskActionButton("Save", () => {
      const next = requiresDraft?.value || [];
      const current = Array.isArray(task.requires) ? task.requires : [];
      requiresDraft = null;
      const same = next.length === current.length
        && next.every((id, index) => id === current[index]);
      if (same) {
        stopEditingTaskRequires();
        return null;
      }
      return saveTaskRequires(task.id, next, task.version);
    });
    save.classList.add("is-primary");
    save.disabled = busy || loading;
    const cancel = createTaskActionButton("Cancel", () => stopEditingTaskRequires());
    actions.append(save, cancel);
    editor.append(actions);
    return editor;
  }

  return { renderTaskRequires };
}
