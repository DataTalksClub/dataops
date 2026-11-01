// Card calendar invitations, created only from the Card's event time. An invite
// Google reports gone is marked stale and proves nothing until it is unlinked.
function truncateEventId(eventId) {
  const raw = String(eventId || "");
  return raw.length > 16 ? `${raw.slice(0, 16)}…` : raw;
}

function renderInviteRow(invite, { busy, onUnlink } = {}) {
  const row = document.createElement("li");
  row.className = "link-row card-invite-row";
  const stale = Boolean(invite.staleAt);
  if (stale) row.dataset.inviteState = "stale";
  // Human name first: the calendar and label an operator recognizes. The raw
  // event id never shows as text; it lives truncated in the tooltip only.
  const name = document.createElement("span");
  name.className = "link-row__label";
  const labelText = [invite.calendar, invite.label].filter(Boolean).join(" / ") || "Invite";
  name.textContent = labelText;
  name.title = invite.eventId
    ? `${labelText} · event ${truncateEventId(invite.eventId)}`
    : labelText;
  const statusCell = document.createElement("div");
  statusCell.className = "link-row__value";
  const status = document.createElement("span");
  status.className = `card-invite-status${stale ? " is-stale" : " is-live"}`;
  status.textContent = stale ? "Stale" : "Live";
  status.title = stale ? "Gone in Google; unlink it once it is no longer needed" : "Present in Google";
  statusCell.append(status);
  const actions = document.createElement("div");
  actions.className = "link-row__actions";
  if (invite.url) {
    const link = document.createElement("a");
    link.className = "link-row__link card-invite-open";
    link.href = invite.url;
    link.textContent = "Open in Google";
    link.title = invite.eventId
      ? `Event ${truncateEventId(invite.eventId)} — ${invite.url}`
      : invite.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  } else {
    const text = document.createElement("span");
    text.className = "link-row__text";
    text.textContent = "No Google link";
    actions.append(text);
  }
  // Only a stale invite offers Unlink: a live one is this Card's own
  // invitation from cards time and moves with it, so the server would
  // refuse the unlink (invite_not_linked / invite_conflict).
  if (stale && typeof onUnlink === "function") {
    const unlink = document.createElement("button");
    unlink.type = "button";
    unlink.className = "quiet-button card-invite-unlink";
    unlink.dataset.inviteAction = "unlink";
    unlink.textContent = "Unlink";
    unlink.setAttribute("aria-label", `Unlink invite ${labelText}`);
    unlink.disabled = Boolean(busy);
    unlink.addEventListener("click", () => onUnlink(invite, unlink));
    actions.append(unlink);
  }
  row.append(name, statusCell, actions);
  return row;
}

export function renderCardInvitesSection(card, { request, workApiUrl, reload } = {}) {
  const section = document.createElement("div");
  section.className =
    "task-history workflow-detail-section workflow-links-section";
  const header = document.createElement("div");
  header.className = "workflow-links-header";
  const heading = document.createElement("div");
  heading.className = "task-history-label";
  heading.textContent = "Calendar invites";
  header.append(heading);
  // role=status line under the header: every Check/Unlink outcome lands
  // here, so a failure is a message instead of a silent flicker.
  const feedback = document.createElement("p");
  feedback.className = "dk-hint card-invite-feedback";
  feedback.setAttribute("role", "status");
  section.append(feedback);
  const list = document.createElement("ul");
  list.className = "link-rows";
  list.setAttribute("aria-label", "Calendar invites");
  const paintInvites = (invites) => {
    list.replaceChildren();
    const rows = Array.isArray(invites) ? invites : [];
    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "link-row card-invite-empty";
      const note = document.createElement("span");
      note.className = "link-row__text";
      note.textContent = "No invites linked.";
      empty.append(note);
      list.append(empty);
      return;
    }
    for (const invite of rows) list.append(renderInviteRow(invite, { onUnlink: unlinkInvite }));
  };
  async function unlinkInvite(invite, button) {
    if (!request || !workApiUrl) return;
    button.disabled = true;
    feedback.textContent = `Unlinking ${[invite.calendar, invite.label].filter(Boolean).join(" / ") || "invite"}…`;
    try {
      const response = await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/calendar-invites`), {
        method: "DELETE",
        body: JSON.stringify({ eventId: invite.eventId, ...(invite.calendar ? { calendar: invite.calendar } : {}) }),
      });
      const invites = Array.isArray(response?.invites) ? response.invites : [];
      card.calendarInvites = invites;
      paintInvites(invites);
      feedback.textContent = invites.length === 0 ? "Invite unlinked; none remain." : "Invite unlinked.";
    } catch (error) {
      feedback.textContent = error?.message || "Could not unlink the invite.";
      button.disabled = false;
    }
  }
  if (request && workApiUrl) {
    // Ask Google which linked events still exist; gone ones are marked stale.
    const check = document.createElement("button");
    check.type = "button";
    check.className = "dk-button dk-button--secondary dk-button--sm";
    check.dataset.inviteAction = "verify";
    check.textContent = "Check in Google";
    check.addEventListener("click", async () => {
      check.disabled = true;
      check.textContent = "Checking…";
      feedback.textContent = "Checking invites in Google…";
      try {
        const response = await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/calendar-invites?verify=1`));
        const invites = Array.isArray(response?.invites) ? response.invites : (card.calendarInvites || []);
        const checkState = response?.check;
        card.calendarInvites = invites;
        paintInvites(invites);
        const live = invites.filter((invite) => !invite?.staleAt).length;
        const stale = invites.length - live;
        if (checkState?.state === "deferred") {
          feedback.textContent = `Google check deferred: ${checkState.reason || "try again later"}.`;
        } else {
          feedback.textContent = `Checked: ${live} live, ${stale} stale in Google.`;
        }
      } catch (error) {
        feedback.textContent = error?.message || "Could not check invites in Google.";
      } finally {
        check.disabled = false;
        check.textContent = "Check in Google";
      }
    });
    header.append(check);
  }
  section.append(header, feedback, list);
  paintInvites(card.calendarInvites);
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
  return sync === "deferred" ? `${base} · Google sync deferred` : base;
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
  section.className = "workflow-detail-section card-event-time";

  const head = document.createElement("div");
  head.className = "card-event-time__head";
  const heading = document.createElement("h3");
  heading.className = "card-event-time__title";
  heading.textContent = "Event time";
  head.append(heading);

  const lifecycleStatus = card.eventTime?.status || "";
  const isDeferred = card.eventTime?.sync === "deferred";
  const statusBadge = document.createElement("p");
  statusBadge.className = "card-event-lifecycle-status";
  statusBadge.dataset.eventLifecycleStatus = isDeferred ? "deferred" : lifecycleStatus || "unscheduled";
  statusBadge.textContent = formatLifecycleStatusLabel(lifecycleStatus, card.eventTime?.sync);
  head.append(statusBadge);
  section.append(head);

  const grid = document.createElement("div");
  grid.className = "card-event-time__grid";

  const fieldId = (name) => `card-event-${name}-${card.id || "time"}`;
  const TIME_ZONE_OPTIONS = [
    "Europe/Berlin",
    "Europe/London",
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Los_Angeles",
    "Asia/Dubai",
    "Asia/Singapore",
    "Australia/Sydney",
  ];
  const DURATION_OPTIONS_MINUTES = [15, 30, 45, 60, 90, 120];
  const makeFieldShell = (name, labelText, { required = true } = {}) => {
    const wrap = document.createElement("div");
    wrap.className = `card-event-time__field card-event-time__field--${name}`;
    const id = fieldId(name);
    const label = document.createElement("label");
    label.className = "dk-label";
    label.htmlFor = id;
    label.textContent = labelText;
    if (required) {
      const marker = document.createElement("span");
      marker.className = "card-event-time__required";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = " *";
      label.append(marker);
    }
    return { wrap, id, label };
  };
  const finishField = (shell, field, { hint } = {}) => {
    const { wrap, id, label } = shell;
    wrap.append(label, field);
    if (hint) {
      const help = document.createElement("p");
      help.className = "dk-hint";
      help.id = `${id}-hint`;
      help.textContent = hint;
      field.setAttribute("aria-describedby", help.id);
      wrap.append(help);
    }
    grid.append(wrap);
    return field;
  };
  const input = (name, labelText, type, value, { hint, required = true, min, max } = {}) => {
    const shell = makeFieldShell(name, labelText, { required });
    const field = document.createElement("input");
    field.className = "dk-input";
    field.id = shell.id;
    field.type = type;
    field.value = value;
    field.required = required;
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    if (required) field.setAttribute("aria-required", "true");
    return finishField(shell, field, { hint });
  };
  const selectField = (name, labelText, currentValue, choices, { hint, required = true } = {}) => {
    const shell = makeFieldShell(name, labelText, { required });
    const field = document.createElement("select");
    field.className = "dk-input dk-select";
    field.id = shell.id;
    field.required = required;
    if (required) field.setAttribute("aria-required", "true");
    for (const choice of choices) {
      const value = String(choice?.value ?? choice);
      const optionLabel = String(choice?.label ?? value);
      const option = document.createElement("option");
      option.value = value;
      option.textContent = optionLabel;
      if (value === String(currentValue)) option.selected = true;
      field.append(option);
    }
    field.value = String(currentValue);
    return finishField(shell, field, { hint });
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
  const at = input("at", "Date and time", "datetime-local", local, { hint: "Shown in the time zone below." });
  const zoneChoices = TIME_ZONE_OPTIONS.includes(zone) ? TIME_ZONE_OPTIONS : [zone, ...TIME_ZONE_OPTIONS];
  const tz = selectField("tz", "Time zone", zone, zoneChoices, { hint: "IANA name, e.g. Europe/Berlin." });
  const currentDuration = Number(card.eventTime?.durationMinutes || policy?.durationMinutes || 60);
  const policyDuration = Number(policy?.durationMinutes);
  const extraDurations = [currentDuration, policyDuration].filter(
    (value) => Number.isFinite(value) && value > 0 && !DURATION_OPTIONS_MINUTES.includes(value),
  );
  const durationMinutes = [...new Set([...DURATION_OPTIONS_MINUTES, ...extraDurations])].sort((a, b) => a - b);
  const duration = selectField(
    "duration",
    "Duration (minutes)",
    String(currentDuration),
    durationMinutes.map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` })),
  );
  const guests = input("guests", "Guest emails (comma separated)", "text", (card.guestEmails || []).join(", "), {
    required: false,
    hint: "Comma separated. Saving sends updates to guests.",
  });
  section.append(grid);
  const note = document.createElement("p");
  note.className = "dk-hint card-event-time__note";
  note.textContent = "The invite starts 5 minutes early and ends with the event. Saving sends updates to guests.";
  const feedback = document.createElement("p");
  feedback.className = "dk-hint card-event-time__feedback";
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

  const makeLifecycleButton = (label, action, pendingText, isEnabled, primary = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = primary
      ? "dk-button dk-button--primary dk-button--sm"
      : "dk-button dk-button--secondary dk-button--sm";
    btn.dataset.eventAction = action;
    btn.textContent = label;
    btn.disabled = !isEnabled;
    btn.addEventListener("click", () => runLifecycleAction(action, pendingText));
    actionButtons.push(btn);
    actionsBar.append(btn);
    return btn;
  };

  const isActive = lifecycleStatus === "proposed" || lifecycleStatus === "approved";
  makeLifecycleButton("Propose", "propose", "Proposing event slot…", !isActive, true);
  makeLifecycleButton("Approve", "approve", "Approving event slot…", lifecycleStatus === "proposed");
  makeLifecycleButton("Reschedule", "reschedule", "Rescheduling event slot…", isActive);
  makeLifecycleButton("Release", "release", "Releasing event slot…", isActive);
  if (card.eventTime?.sync === "deferred") {
    makeLifecycleButton("Retry sync", "retry", "Retrying event sync…", true);
  }

  const saveRow = document.createElement("div");
  saveRow.className = "card-event-time__save";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "dk-button dk-button--secondary dk-button--sm";
  save.textContent = "Save time and send invite";
  actionButtons.push(save);
  saveRow.append(save, feedback);
  section.append(note, actionsBar, saveRow);
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
