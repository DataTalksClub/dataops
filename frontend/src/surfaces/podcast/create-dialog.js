// New episode. The dialog loads the current register before it opens
// (dakit load-before-open), so its season and episode numbers start at the
// next free pair rather than at whatever the page happened to cache.
import { button, element, field, input, select } from "./dom.js";
import { EPISODE_STATUSES, parseGuestNames, statusLabel, suggestNextNumber } from "./model.js";

function buildDialog(documentRef) {
  const dialog = element(documentRef, "dialog", "dk-dialog podcast-dialog");
  dialog.style.setProperty("--dk-dialog-width", "560px");
  const head = element(documentRef, "div", "dk-dialog__head");
  const heading = element(documentRef, "div");
  const title = element(documentRef, "h2", "", "New episode");
  title.id = "podcast-create-title";
  dialog.setAttribute("aria-labelledby", title.id);
  heading.append(title, element(documentRef, "p", "", "Book a guest now; add links and the release date as the episode moves along."));
  head.append(heading);
  const body = element(documentRef, "div", "dk-dialog__body");
  const foot = element(documentRef, "div", "dk-dialog__foot");
  dialog.append(head, body, foot);
  return { dialog, body, foot };
}

/** The POST body from the form values; empty fields are left out. */
export function createBody(values) {
  const text = (value) => String(value ?? "").trim();
  const body = { status: text(values.status) || "booked" };
  if (text(values.title)) body.title = text(values.title);
  const guests = parseGuestNames(values.guests);
  if (guests.length) body.guests = guests;
  for (const name of ["season", "episode"]) if (text(values[name])) body[name] = Number(text(values[name]));
  if (text(values.recordingDate)) body.recordingDate = text(values.recordingDate);
  return body;
}

/**
 * Open the dialog from `trigger`. `load(signal)` returns the register's
 * episodes; `create(body)` posts one and resolves with the created record.
 */
export function openCreateEpisodeDialog({ documentRef, trigger, load, create, onCreated, dialogs }) {
  const render = (episodes) => {
    const { dialog, body, foot } = buildDialog(documentRef);
    const suggestion = suggestNextNumber(episodes);
    const form = element(documentRef, "form", "podcast-create-form dk-stack");
    form.id = "podcast-create-form";
    form.noValidate = true;
    const controls = {
      guests: input(documentRef, "guests"),
      title: input(documentRef, "title"),
      season: input(documentRef, "season", suggestion.season, "number"),
      episode: input(documentRef, "episode", suggestion.episode, "number"),
      recordingDate: input(documentRef, "recordingDate", "", "date"),
      status: select(documentRef, "status", EPISODE_STATUSES.map((status) => [status, statusLabel(status)]), "booked"),
    };
    controls.guests.placeholder = "Jane Doe, John Roe";
    controls.guests.autofocus = true;
    controls.title.maxLength = 300;
    controls.season.min = "1";
    controls.episode.min = "1";
    const numbers = element(documentRef, "div", "podcast-form-pair");
    numbers.append(field(documentRef, "Season", controls.season), field(documentRef, "Episode", controls.episode));
    const timing = element(documentRef, "div", "podcast-form-pair");
    timing.append(field(documentRef, "Recording date", controls.recordingDate), field(documentRef, "Status", controls.status));
    const error = element(documentRef, "p", "dk-field-error podcast-dialog-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(
      field(documentRef, "Guests", controls.guests, "Comma-separated names."),
      field(documentRef, "Title", controls.title),
      numbers,
      timing,
      error,
    );
    body.append(form);
    const cancel = button(documentRef, "Cancel", "secondary", "");
    cancel.addEventListener("click", () => dialog.close());
    const submit = button(documentRef, "Create episode", "primary", "");
    submit.type = "submit";
    submit.setAttribute("form", form.id);
    foot.append(cancel, submit);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.value]));
      const payload = createBody(values);
      if (!payload.title && !payload.guests) {
        error.textContent = "Add a guest or a title.";
        error.hidden = false;
        controls.guests.focus();
        return;
      }
      submit.setAttribute("aria-busy", "true");
      submit.disabled = true;
      cancel.disabled = true;
      error.hidden = true;
      try {
        const created = await create(payload);
        dialog.close();
        onCreated(created);
      } catch (failure) {
        error.textContent = failure?.status === 409
          ? `That episode already exists: ${failure.message}. Pick another number.`
          : `Could not create the episode: ${failure?.message || "request failed"}`;
        error.hidden = false;
        submit.removeAttribute("aria-busy");
        submit.disabled = false;
        cancel.disabled = false;
      }
    });

    documentRef.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
    return dialog;
  };

  if (dialogs?.openWhenReady) {
    return dialogs.openWhenReady(trigger, (signal) => load(signal), render, {
      label: "Loading episodes…",
      errorMessage: "Couldn't load the episode list. Try again.",
    });
  }
  return Promise.resolve(load()).then((episodes) => {
    const dialog = render(episodes);
    dialog.showModal?.();
    return { status: "open", dialog, data: episodes };
  });
}
