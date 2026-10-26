// Linked Google Calendar invites on a Card: event id + calendar/organizer,
// the htmlLink when known, and the operator label (`original`, `resent`).
// Read-only here — invites are linked with
// `dataops cards invite add <card> --event-id … --calendar …`.
export function renderCardInvitesSection(card) {
  const section = document.createElement("div");
  section.className =
    "task-history workflow-detail-section workflow-links-section";
  const header = document.createElement("div");
  header.className = "workflow-links-header";
  const heading = document.createElement("div");
  heading.className = "task-history-label";
  heading.textContent = "Calendar invites";
  header.append(heading);
  section.append(header);
  const list = document.createElement("ul");
  list.className = "link-rows";
  list.setAttribute("aria-label", "Calendar invites");
  for (const invite of card.calendarInvites || []) {
    const row = document.createElement("li");
    row.className = "link-row";
    const name = document.createElement("span");
    name.className = "link-row__label";
    const labelText = [invite.calendar, invite.label].filter(Boolean).join(" · ") || "Invite";
    name.textContent = labelText;
    name.title = labelText;
    const valueCell = document.createElement("div");
    valueCell.className = "link-row__value";
    if (invite.url) {
      const link = document.createElement("a");
      link.className = "link-row__link";
      link.href = invite.url;
      link.title = invite.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const address = document.createElement("span");
      address.className = "link-row__address";
      address.textContent = invite.eventId;
      address.title = `${invite.eventId} — ${invite.url}`;
      link.append(address);
      valueCell.append(link);
    } else {
      const text = document.createElement("span");
      text.className = "link-row__text";
      text.textContent = invite.eventId;
      text.title = invite.eventId;
      valueCell.append(text);
    }
    row.append(name, valueCell, document.createElement("div"));
    list.append(row);
  }
  section.append(list);
  return section;
}
