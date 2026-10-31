// Card calendar invitations created from event time; hand linking adopts legacy events.
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

function formatLifecycleStatusLabel(status, sync) {
  const base =
    status === "approved"
      ? "Approved (Confirmed)"
      : status === "proposed"
        ? "Proposed (Proposal)"
        : status === "released"
          ? "Released"
          : "Not proposed yet";
  return sync === "deferred" ? `Status: ${base} · Google sync deferred` : `Status: ${base}`;
}

function splitDateTimeValue(raw, fallbackDate) {
  const trimmed = String(raw || "").trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}))?/);
  if (match) {
    return { date: match[1], ...(match[2] ? { time: match[2] } : {}) };
  }
  return fallbackDate ? { date: String(fallbackDate).slice(0, 10) } : {};
}

export function renderCardEventTime({ request, workApiUrl, reload }, card) {
  const section = document.createElement("form");
  section.className = "workflow-detail-section";
  const heading = document.createElement("h3");
  heading.textContent = "Event time";
  section.append(heading);

  const lifecycleStatus = card.eventTime?.status || "";
  const statusBadge = document.createElement("p");
  statusBadge.className = "card-event-lifecycle-status";
  statusBadge.dataset.eventLifecycleStatus = lifecycleStatus || "unscheduled";
  statusBadge.textContent = formatLifecycleStatusLabel(lifecycleStatus, card.eventTime?.sync);
  section.append(statusBadge);

  const input = (labelText, type, value) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const field = document.createElement("input");
    field.type = type;
    field.value = value;
    field.required = true;
    label.append(field);
    section.append(label);
    return field;
  };
  const policy = card.templateDefinitionSnapshot?.eventPolicy;
  const zone = card.eventTime?.timeZone || policy?.timeZone || "Europe/Berlin";
  let local = "";
  if (card.eventTime?.startIso) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(card.eventTime.startIso)).map(p => [p.type, p.value]));
    local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } else if (card.anchorDate) {
    const defaultTime = policy?.windows ? Object.values(policy.windows)[0] || "12:30" : "12:30";
    local = `${String(card.anchorDate).slice(0, 10)}T${defaultTime}`;
  }
  const at = input("Date and time", "datetime-local", local);
  const tz = input("Time zone", "text", zone);
  const duration = input("Duration (minutes)", "number", String(card.eventTime?.durationMinutes || policy?.durationMinutes || 60));
  duration.min = "1";
  duration.max = "1440";
  const guests = input("Guest emails (comma separated)", "text", (card.guestEmails || []).join(", "));
  guests.required = false;
  const note = document.createElement("p");
  note.textContent = "The invite starts 5 minutes early and ends with the event. Saving sends updates to guests.";
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  feedback.textContent = card.eventTime?.reason || "";

  const actionsBar = document.createElement("div");
  actionsBar.className = "card-event-lifecycle-actions";
  const actionButtons = [];

  const runLifecycleAction = async (action, pendingText) => {
    for (const btn of actionButtons) btn.disabled = true;
    feedback.textContent = pendingText;
    try {
      const parsedGuestEmails = guests.value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const dt = splitDateTimeValue(at.value, card.anchorDate);
      let body = {};
      if (action === "propose" || action === "reschedule") {
        body = {
          ...dt,
          ...(parsedGuestEmails.length ? { guestEmails: parsedGuestEmails } : {}),
        };
      } else if (action === "approve") {
        body = {
          ...(parsedGuestEmails.length ? { guestEmails: parsedGuestEmails } : {}),
        };
      }
      await request(workApiUrl(`/api/events/${encodeURIComponent(card.id)}/${action}`), {
        method: "POST",
        body: JSON.stringify(body),
      });
      await reload();
    } catch (error) {
      feedback.textContent = error.message || `Could not ${action} event.`;
      for (const btn of actionButtons) btn.disabled = false;
    }
  };

  const makeLifecycleButton = (label, action, pendingText, isEnabled) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dk-button dk-button--secondary dk-button--sm";
    btn.dataset.eventAction = action;
    btn.textContent = label;
    btn.disabled = !isEnabled;
    btn.addEventListener("click", () => runLifecycleAction(action, pendingText));
    actionButtons.push(btn);
    actionsBar.append(btn);
    return btn;
  };

  const isActive = lifecycleStatus === "proposed" || lifecycleStatus === "approved";
  makeLifecycleButton("Propose", "propose", "Proposing event slot…", !isActive);
  makeLifecycleButton("Approve", "approve", "Approving event slot…", lifecycleStatus === "proposed");
  makeLifecycleButton("Reschedule", "reschedule", "Rescheduling event slot…", isActive);
  makeLifecycleButton("Release", "release", "Releasing event slot…", isActive);
  if (card.eventTime?.sync === "deferred") {
    makeLifecycleButton("Retry sync", "retry", "Retrying event sync…", true);
  }

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "dk-button dk-button--secondary dk-button--sm";
  save.textContent = "Save time and send invite";
  actionButtons.push(save);
  section.append(note, actionsBar, save, feedback);
  section.addEventListener("submit", async event => {
    event.preventDefault();
    save.disabled = true;
    feedback.textContent = "Saving event and sending invite…";
    try {
      const response = await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/time`), {
        method: "POST",
        body: JSON.stringify({ at: at.value.replace("T", " "), duration: Number(duration.value), tz: tz.value,
          ...(guests.value.trim() ? { guestEmails: guests.value.split(",").map(value => value.trim()).filter(Boolean) } : {}),
        }),
      });
      await reload();
      if (response?.taskClosure?.outcome === "blocked" && response.taskClosure.message) {
        feedback.textContent = `Invite sent. ${response.taskClosure.message}`;
      }
    } catch (error) {
      feedback.textContent = error.message || "Could not send the invitation. Retry to recover the same event.";
      save.disabled = false;
    }
  });
  return section;
}
