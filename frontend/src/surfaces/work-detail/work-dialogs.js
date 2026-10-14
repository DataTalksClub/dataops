// Kit dialogs for the two irreversible-feeling work actions: skipping a Task
// as not applicable (needs a reason) and deleting a Card (needs a confirm
// that names what goes with it). Both are built on demand, removed on close,
// and return focus to their trigger.

const SKIP_REASON_MAX = 500;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildDialog(titleText, width) {
  const dialog = element("dialog", "dk-dialog work-dialog");
  dialog.style.setProperty("--dk-dialog-width", width);
  const head = element("div", "dk-dialog__head");
  const heading = element("div");
  const title = element("h2", "", titleText);
  title.id = `work-dialog-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute("aria-labelledby", title.id);
  heading.append(title);
  head.append(heading);
  const body = element("div", "dk-dialog__body");
  const foot = element("div", "dk-dialog__foot");
  dialog.append(head, body, foot);
  return { dialog, body, foot };
}

function mount(dialog, trigger) {
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
}

/**
 * Ask why a Task does not apply, then call `onSkip(reason)`. The form is in
 * memory, so the dialog opens at once. A failed skip keeps the dialog open
 * with the server's message; a successful one closes it.
 */
export function openSkipTaskDialog({ taskTitle, trigger, onSkip }) {
  const { dialog, body, foot } = buildDialog("Skip task", "480px");
  dialog.dataset.workDialog = "skip-task";
  const form = element("form", "work-dialog-form");
  form.id = `skip-task-form-${Math.random().toString(36).slice(2)}`;
  form.noValidate = true;
  const lead = element("p", "work-dialog-lead");
  lead.append(
    document.createTextNode("Resolve "),
    element("strong", "", taskTitle),
    document.createTextNode(
      " as not applicable. Skipping needs no proof, and the Card counts the task as resolved.",
    ),
  );
  const label = element("label", "work-dialog-field");
  const labelText = element("span", "dk-label", "Reason");
  const reason = element("textarea", "dk-textarea");
  reason.name = "reason";
  reason.rows = 3;
  reason.required = true;
  reason.maxLength = SKIP_REASON_MAX;
  reason.placeholder = "e.g. Self-hosted event, no recording";
  label.append(labelText, reason);
  const error = element("p", "dk-field-error work-dialog-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.append(lead, label, error);
  body.append(form);

  const cancel = element("button", "dk-button dk-button--secondary", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const submit = element("button", "dk-button dk-button--primary", "Skip task");
  submit.type = "submit";
  submit.setAttribute("form", form.id);
  foot.append(cancel, submit);

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    reason.setAttribute("aria-invalid", "true");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = reason.value.trim();
    if (!value) {
      showError("A reason is required to skip a task.");
      reason.focus();
      return;
    }
    submit.disabled = true;
    cancel.disabled = true;
    submit.setAttribute("aria-busy", "true");
    try {
      await onSkip(value);
      dialog.close();
    } catch (err) {
      showError(`Could not skip task: ${err?.message || "request failed"}`);
      submit.disabled = false;
      cancel.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  });

  mount(dialog, trigger);
  dialog.showModal();
  reason.focus();
  return dialog;
}

/**
 * Confirm deleting a Card. The current Card is loaded first (load-before-open
 * through dakitDialogs.openWhenReady), so the confirm names the live title and
 * Task count and deletes at the version the operator saw.
 */
export function openDeleteCardDialog({ trigger, loadCard, onDelete }) {
  const render = (card) => {
    const taskCount = Number(card?.taskCount || 0);
    const title = card?.title || "Untitled card";
    const { dialog, body, foot } = buildDialog("Delete card", "480px");
    dialog.dataset.workDialog = "delete-card";
    const lead = element("p", "work-dialog-lead");
    lead.append(
      document.createTextNode("Delete "),
      element("strong", "", title),
      document.createTextNode(
        ` and its ${taskCount} task${taskCount === 1 ? "" : "s"}? This cannot be undone. `
        + "Newsletter slots and other links to it are cleared.",
      ),
    );
    const error = element("p", "dk-field-error work-dialog-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    body.append(lead, error);

    const cancel = element("button", "dk-button dk-button--secondary", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    const confirm = element("button", "dk-button dk-button--danger", "Delete card");
    confirm.type = "button";
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setAttribute("aria-busy", "true");
      try {
        await onDelete(card);
        dialog.close();
      } catch (err) {
        error.textContent = `Could not delete card: ${err?.message || "request failed"}`;
        error.hidden = false;
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.removeAttribute("aria-busy");
      }
    });
    foot.append(cancel, confirm);
    mount(dialog, trigger);
    return dialog;
  };

  const dialogs = globalThis.dakitDialogs;
  if (dialogs?.openWhenReady) {
    return dialogs.openWhenReady(trigger, (signal) => loadCard(signal), render, {
      label: "Loading card…",
      errorMessage: "Couldn't load this card. Try again.",
    });
  }
  return Promise.resolve(loadCard()).then((card) => {
    const dialog = render(card);
    dialog.showModal();
    return { status: "open", dialog, data: card };
  });
}
