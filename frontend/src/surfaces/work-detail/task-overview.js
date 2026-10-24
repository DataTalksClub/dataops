import { cardKind } from "../../core/card-kind.js";
import { renderIcon } from "../../core/icons.js";
import { opensInNewTab } from "../../core/links.js";
import { taskMaterials, taskTitleParts } from "../../core/task-display.js";

// The top of the task dialog answers, in order: which card (or sponsor) is this for,
// when is it due and whose is it, and how do I do it. Everything else
// (attachments, history, process notes) folds below.

export function taskDisplayParts(task, deps) {
  const card = task?.cardId ? deps.resolveCard(task.cardId) : null;
  const kind = card ? cardKind(card, deps.templates()) : null;
  const parts = taskTitleParts(deps.workTaskTitle(task), task?.tags, kind?.type);
  return { card, kind, parts };
}

function chip(text, className = "") {
  const element = document.createElement("span");
  element.className = ["task-context-chip", className].filter(Boolean).join(" ");
  element.textContent = text;
  return element;
}

export function renderTaskContext(task, view, deps) {
  const { card, kind, parts } = view;
  const context = document.createElement("section");
  context.className = "task-context";
  context.setAttribute("aria-label", "Task context");

  if (task.cardId) {
    const cardRow = document.createElement("button");
    cardRow.type = "button";
    cardRow.className = "task-context-card";
    cardRow.title = "Open the card";
    const icon = document.createElement("span");
    icon.className = "task-context-card-icon";
    icon.append(renderIcon(kind?.icon || "card", { size: 16 }));
    const text = document.createElement("span");
    text.className = "task-context-card-text";
    const name = document.createElement("strong");
    name.textContent = card?.title ? deps.workCardTitle(card) : deps.resolveCardLabel(task.cardId);
    // A deep link can open the task before the work snapshot knows its card;
    // the card is fetched once and the name filled in when it arrives.
    if (!card?.title) {
      deps.fetchCard(task.cardId).then((fetched) => {
        if (fetched?.title && name.isConnected) name.textContent = deps.workCardTitle(fetched);
      });
    }
    const meta = document.createElement("span");
    meta.textContent = kind ? `${kind.name} card` : "Card";
    text.append(name, meta);
    const open = document.createElement("span");
    open.className = "task-context-card-open";
    open.textContent = "Open card";
    cardRow.append(icon, text, open);
    cardRow.addEventListener("click", () => deps.navigateTaskToWorkflow(task));
    context.append(cardRow);
  }

  // Work outside a Card names its sponsor relationship or tuition agreement.
  if (task.subject?.href) {
    const type = task.subject.type === "tuition-agreement" ? "Tuition agreement"
      : task.subject.type === "sponsor-company" ? "Sponsor"
      : task.subject.type === "sponsor-person" ? "Person"
      : "Sponsor deal";
    const subjectRow = document.createElement("button");
    subjectRow.type = "button";
    subjectRow.className = "task-context-card";
    subjectRow.title = `Open the ${type.toLowerCase()}`;
    const icon = document.createElement("span");
    icon.className = "task-context-card-icon";
    icon.append(renderIcon(task.subject.type === "tuition-agreement" ? "receipt" : "megaphone", { size: 16 }));
    const text = document.createElement("span");
    text.className = "task-context-card-text";
    const name = document.createElement("strong");
    name.textContent = task.subject.label || type;
    const meta = document.createElement("span");
    meta.textContent = type;
    text.append(name, meta);
    const open = document.createElement("span");
    open.className = "task-context-card-open";
    open.textContent = task.subject.type === "tuition-agreement" ? "Open agreement"
      : task.subject.type === "sponsor-company" ? "Open company"
      : task.subject.type === "sponsor-person" ? "Open person"
      : "Open deal";
    subjectRow.append(icon, text, open);
    subjectRow.addEventListener("click", () => deps.openSubject(task.subject));
    context.append(subjectRow);
  }

  const chips = document.createElement("div");
  chips.className = "task-context-chips";
  const status = document.createElement("span");
  status.className = `task-status-badge ${task.status}`;
  // The raw status word; the badge style capitalizes it.
  status.textContent = task.status;
  chips.append(status);
  if (task.date && task.status !== "waiting") chips.append(chip(`Due ${deps.formatDate(task.date)}`, deps.isOverdue(task) ? "is-overdue" : ""));
  chips.append(chip(task.assigneeId ? deps.resolveAssigneeLabel(task.assigneeId) : "Unassigned"));
  if (parts.tag) chips.append(chip(parts.tag, "is-tag"));
  context.append(chips);
  return context;
}

// "How to do it": every supporting material as a row with its icon. Process
// docs and links both open in a new tab so the task stays open; a process
// doc the catalog cannot resolve is named without a link.
export function renderTaskInstructions(task, view, deps) {
  const section = document.createElement("section");
  section.className = "task-instructions";
  const label = document.createElement("div");
  label.className = "task-history-label";
  label.textContent = "How to do it";
  section.append(label);
  const materials = taskMaterials(task, { resolveDoc: deps.resolveDocReference });
  if (materials.length === 0) return null;
  const list = document.createElement("ul");
  list.className = "artifact-rows task-instruction-rows";
  for (const material of materials) {
    const row = document.createElement("li");
    row.className = "artifact-row";
    const icon = document.createElement("span");
    icon.className = "artifact-row-icon";
    icon.append(renderIcon(material.icon, { size: 16 }));
    const text = document.createElement("span");
    text.className = "artifact-row-text";
    const link = document.createElement(material.href ? "a" : "span");
    link.className = "artifact-row-label";
    link.textContent = material.label;
    if (material.href) {
      link.href = material.href;
      link.title = material.href;
      opensInNewTab(link);
    }
    const detail = document.createElement("span");
    detail.className = "artifact-row-detail";
    detail.textContent = material.detail;
    text.append(link, detail);
    row.append(icon, text);
    list.append(row);
  }
  section.append(list);
  return section;
}
