// One dialog for a person leaving the team: Disable, Delete, or just
// Reassign their open work. It loads the person's open work first
// (load-before-open through dakitDialogs.openWhenReady), then asks only what
// the server will need: who takes the open work over, and, when the person
// is the default assignee, who becomes the new default. Nothing open and not
// the default: it is a plain confirm.

const COPY = {
  disable: {
    title: (name) => `Disable ${name}`,
    lead: (name) => `${name} can no longer sign in, and every session and API token they hold is revoked. You can enable the account again later.`,
    confirm: (name) => `Disable ${name}`,
    tone: "danger",
  },
  delete: {
    title: (name) => `Delete ${name}`,
    lead: (name) => `The account is removed for good. Only the name ${name} stays, so past work still shows who did it.`,
    confirm: (name) => `Delete ${name}`,
    tone: "danger",
  },
  reassign: {
    title: (name) => `Reassign ${name}’s open work`,
    lead: () => "",
    confirm: () => "Reassign",
    tone: "primary",
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "231 open tasks, 3 cards and 1 schedule", or "" when nothing is open. */
export function describeOpenWork(work = {}) {
  const parts = [
    work.tasks ? plural(work.tasks, "open task", "open tasks") : "",
    work.cards ? plural(work.cards, "card", "cards") : "",
    work.schedules ? plural(work.schedules, "recurring schedule", "recurring schedules") : "",
    work.sponsorRecords ? plural(work.sponsorRecords, "sponsor record", "sponsor records") : "",
  ].filter(Boolean);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function personSelect(id, candidates, selected, placeholder) {
  const select = element("select", "dk-select");
  select.id = id;
  select.required = true;
  const empty = element("option", "", placeholder);
  empty.value = "";
  select.append(empty);
  for (const person of candidates) {
    const option = element("option", "", person.name || person.email || person.id);
    option.value = person.id;
    select.append(option);
  }
  select.value = candidates.some((person) => person.id === selected) ? selected : "";
  return select;
}

function field(labelText, control, hint) {
  const wrap = element("div", "user-lifecycle-field");
  const label = element("label", "dk-label", labelText);
  label.htmlFor = control.id;
  wrap.append(label, control);
  if (hint) {
    const note = element("p", "dk-hint", hint);
    note.id = `${control.id}-hint`;
    control.setAttribute("aria-describedby", note.id);
    wrap.append(note);
  }
  return wrap;
}

/**
 * @param {object} options
 * @param {"disable"|"delete"|"reassign"} options.mode
 * @param {{id: string, name?: string}} options.user
 * @param {HTMLElement} options.trigger   the control that opened it; busy while loading, focused after
 * @param {Array<{id: string, name?: string}>} options.candidates  active people who can take over
 * @param {(signal?: AbortSignal) => Promise<object>} options.loadHandover  GET /api/users/:id/handover
 * @param {(body: object) => Promise<void>} options.onConfirm  runs the action; throws to keep the dialog open
 */
export function openUserLifecycleDialog({ mode, user, trigger, candidates, loadHandover, onConfirm }) {
  const copy = COPY[mode];
  const render = (summary) => {
    const name = summary?.user?.name || user.name || user.email || user.id;
    const others = candidates.filter((person) => person.id !== user.id);
    const openTotal = Number(summary?.openTotal || 0);
    const needsDefault = mode !== "reassign" && Boolean(summary?.isDefaultAssignee);
    const needsRecipient = openTotal > 0;

    const dialog = element("dialog", "dk-dialog user-lifecycle-dialog");
    dialog.dataset.userDialog = mode;
    dialog.style.setProperty("--dk-dialog-width", "480px");
    const head = element("div", "dk-dialog__head");
    const title = element("h2", "", copy.title(name));
    title.id = `user-dialog-title-${user.id}`;
    dialog.setAttribute("aria-labelledby", title.id);
    const heading = element("div");
    heading.append(title);
    head.append(heading);
    const body = element("div", "dk-dialog__body user-lifecycle-body");
    const foot = element("div", "dk-dialog__foot");
    dialog.append(head, body, foot);

    const form = element("form", "user-lifecycle-form");
    form.id = `user-dialog-form-${user.id}`;
    form.noValidate = true;
    const lead = copy.lead(name);
    if (lead) form.append(element("p", "user-lifecycle-lead", lead));

    let recipient = null;
    if (needsRecipient) {
      const preselect = summary.defaultAssigneeId && summary.defaultAssigneeId !== user.id ? summary.defaultAssigneeId : "";
      recipient = personSelect(`user-dialog-recipient-${user.id}`, others, preselect, "Choose a person");
      form.append(field(
        "Hand over to",
        recipient,
        `${name} has ${describeOpenWork(summary.openWork)}. They all go to this person.`,
      ));
    } else if (mode === "reassign") {
      form.append(element("p", "user-lifecycle-lead", `${name} has no open work to reassign.`));
    }

    let newDefault = null;
    if (needsDefault) {
      newDefault = personSelect(`user-dialog-default-${user.id}`, others, recipient?.value || "", "Choose a person");
      // Until it is changed by hand, the new default follows the recipient.
      let touched = false;
      newDefault.addEventListener("change", () => { touched = true; });
      recipient?.addEventListener("change", () => {
        if (!touched) newDefault.value = recipient.value;
      });
      form.append(field(
        "New default assignee",
        newDefault,
        `${name} is the default assignee: new tasks nobody else is named for go to them.`,
      ));
    }

    const error = element("p", "dk-field-error user-lifecycle-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(error);
    body.append(form);

    const cancel = element("button", "dk-button dk-button--secondary", mode === "reassign" && !needsRecipient ? "Close" : "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    foot.append(cancel);
    if (mode === "reassign" && !needsRecipient) {
      document.body.append(dialog);
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
      return dialog;
    }
    const confirm = element("button", `dk-button dk-button--${copy.tone}`, copy.confirm(name));
    confirm.type = "submit";
    confirm.setAttribute("form", form.id);
    foot.append(confirm);

    const showError = (message, control) => {
      error.textContent = message;
      error.hidden = false;
      if (control) {
        control.setAttribute("aria-invalid", "true");
        control.focus();
      }
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      for (const control of [recipient, newDefault]) control?.removeAttribute("aria-invalid");
      if (recipient && !recipient.value) return showError("Choose who takes over the open work.", recipient);
      if (newDefault && !newDefault.value) return showError("Choose the new default assignee.", newDefault);
      const payload = {};
      if (recipient) payload.reassignTo = recipient.value;
      if (newDefault) payload.newDefaultAssigneeId = newDefault.value;
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setAttribute("aria-busy", "true");
      try {
        await onConfirm(payload);
        dialog.close();
      } catch (err) {
        showError(err?.message || "The request failed. Try again.");
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.removeAttribute("aria-busy");
      }
    });

    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
    queueMicrotask(() => (recipient || newDefault || confirm).focus());
    return dialog;
  };

  const dialogs = globalThis.dakitDialogs;
  if (dialogs?.openWhenReady) {
    return dialogs.openWhenReady(trigger, (signal) => loadHandover(signal), render, {
      label: "Loading open work…",
      errorMessage: "Couldn't load this person's open work. Try again.",
    });
  }
  return Promise.resolve(loadHandover()).then((summary) => {
    const dialog = render(summary);
    dialog.showModal();
    return { status: "open", dialog, data: summary };
  });
}
