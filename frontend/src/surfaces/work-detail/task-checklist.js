import { documentHref, opensInNewTab } from "../../core/links.js";

export function renderTaskChecklist(task, { resolveDocReference = () => null, toggleTaskChecklistItem, busy = false } = {}) {
  const items = Array.isArray(task?.checklistItems) ? task.checklistItems : [];
  if (!items.length) return null;

  const section = document.createElement("section");
  section.className = "task-checklist-section";
  section.setAttribute("aria-label", "Task checklist");

  const heading = document.createElement("div");
  heading.className = "task-checklist-heading";
  const title = document.createElement("h3");
  title.textContent = "Checklist";
  const progress = document.createElement("span");
  progress.className = "task-checklist-progress";
  const checked = items.filter((item) => item.checked).length;
  progress.textContent = `${checked}/${items.length} complete`;
  heading.append(title, progress);

  const list = document.createElement("ol");
  list.className = "task-checklist-items";
  for (const item of items) {
    const row = document.createElement("li");
    row.className = "task-checklist-item";
    if (item.checked) row.dataset.checked = "true";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(item.checked);
    checkbox.disabled = busy || !toggleTaskChecklistItem || task.status === "done" || task.status === "skipped";
    checkbox.setAttribute("aria-label", `${item.checked ? "Uncheck" : "Check"}: ${item.text}`);
    checkbox.addEventListener("change", () => {
      toggleTaskChecklistItem(task.id, item.id, checkbox.checked, task.version);
    });

    const content = document.createElement("div");
    content.className = "task-checklist-item-content";
    const label = document.createElement("span");
    label.className = "task-checklist-item-text";
    label.textContent = item.text;
    content.append(label);

    if (item.instructionDocId) {
      const doc = resolveDocReference(item.instructionDocId);
      const instruction = document.createElement(doc ? "a" : "span");
      instruction.className = "task-checklist-instruction";
      instruction.textContent = doc?.title || item.instructionDocId;
      if (doc) {
        instruction.href = documentHref(doc.path);
        instruction.title = doc.title || item.instructionDocId;
        opensInNewTab(instruction);
      }
      content.append(instruction);
    }

    if (item.link || item.note) {
      const evidence = document.createElement("small");
      evidence.className = "task-checklist-evidence";
      if (item.link) {
        const link = document.createElement("a");
        link.href = item.link;
        link.textContent = "Evidence";
        link.title = item.link;
        opensInNewTab(link);
        evidence.append(link);
      }
      if (item.note) {
        const note = document.createElement("span");
        note.textContent = item.note;
        evidence.append(note);
      }
      content.append(evidence);
    }

    row.append(checkbox, content);
    list.append(row);
  }

  section.append(heading, list);
  return section;
}
