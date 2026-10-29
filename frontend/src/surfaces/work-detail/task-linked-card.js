// The Card a Task links: the Card that carries the Task out (a course's
// "Workshop 2" Task links that workshop's own Card). Linked, it shows the
// Card's title and status as a link with an Unlink action; unlinked, a field
// takes a Card id or a pasted Card address.

/** The Card id in a pasted value: a bare id or a portal `/cards?cardId=…` address. */
export function linkedCardIdFrom(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.searchParams.get("cardId") || url.searchParams.get("card") || "";
  } catch {
    return text;
  }
}

function statusText(linked) {
  return linked.status === "active" ? `${linked.status}, ${linked.stage}` : linked.status;
}

export function renderTaskLinkedCard(task, { busy, onSave, createTaskActionButton }) {
  const section = document.createElement("section");
  section.className = "task-linked-card";
  section.setAttribute("aria-label", "Linked Card");
  const heading = document.createElement("strong");
  heading.textContent = "Linked Card";
  section.append(heading);

  if (task.linkedCardId) {
    const row = document.createElement("p");
    row.className = "task-linked-card-row";
    const linked = task.linkedCard;
    if (linked) {
      const anchor = document.createElement("a");
      anchor.href = linked.url;
      anchor.textContent = linked.title || linked.id;
      const status = document.createElement("span");
      status.className = "task-linked-card-status";
      status.textContent = ` (${statusText(linked)})`;
      row.append(anchor, status);
    } else {
      row.textContent = `Card ${task.linkedCardId} is no longer available.`;
    }
    const unlink = createTaskActionButton("Unlink", () => onSave(null));
    unlink.dataset.taskAction = "unlink-card";
    unlink.disabled = busy;
    section.append(row, unlink);
    return section;
  }

  const form = document.createElement("form");
  form.className = "task-linked-card-form";
  const label = document.createElement("label");
  label.textContent = "Card id or address";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.panelField = "linked-card";
  input.placeholder = "Paste the Card's link";
  input.disabled = busy;
  label.append(input);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "task-action-btn";
  submit.textContent = "Link Card";
  submit.disabled = busy;
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const cardId = linkedCardIdFrom(input.value);
    if (cardId) onSave(cardId);
  });
  section.append(form);
  return section;
}

/** The Card a Task links, as one muted line under its checklist row; none when unlinked. */
export function renderChecklistLinkedCard(task) {
  const linked = task.linkedCard;
  if (!linked) return [];
  const note = document.createElement("small");
  note.className = "card-checklist-note card-checklist-linked-card";
  const anchor = document.createElement("a");
  anchor.href = linked.url;
  anchor.textContent = linked.title || linked.id;
  note.append(document.createTextNode("Card · "), anchor, document.createTextNode(` (${statusText(linked)})`));
  return [note];
}

/** The Tasks on other Cards that this Card carries out (a course's "Workshop 2"); none when unlinked. */
export function renderCardLinkedFrom(card) {
  if (!Array.isArray(card.linkedFrom) || card.linkedFrom.length === 0) return [];
  const section = document.createElement("section");
  section.className = "workflow-detail-section card-linked-from";
  const heading = document.createElement("strong");
  heading.textContent = "Part of";
  const list = document.createElement("ul");
  for (const ref of card.linkedFrom) {
    const item = document.createElement("li");
    const anchor = document.createElement("a");
    anchor.href = ref.url;
    anchor.textContent = `${ref.cardTitle}: ${ref.taskDescription}`;
    item.append(anchor, document.createTextNode(` (${ref.taskStatus})`));
    list.append(item);
  }
  section.append(heading, list);
  return [section];
}
