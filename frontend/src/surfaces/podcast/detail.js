// The selected episode: what it is, where it stands, where it lives, and the
// Card that executes it. Facts read as a list; Edit turns the same pane into
// a form in place. Writes carry the episode's version, and a version
// conflict keeps what the operator typed and offers the latest record.
import { SPLIT_BACK_ICON } from "../split-back-icon.js";
import {
  button, element, emptyState, field, formatDate, icon, input, messageArea, select, statusChip,
} from "./dom.js";
import { buildPublication, samePublication } from "./publication-model.js";
import { publicationFormFields, publicationSection } from "./publication-section.js";
import {
  cardStageLabel, EPISODE_STATUSES, episodeCode, episodeTitle, guestNames, LINK_KINDS,
  parseGuestNames, statusLabel,
} from "./model.js";

const NOTES_MAX = 2000;
const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

export function conflictMessage(error) {
  return `This episode changed since you opened it: ${error?.message || "version conflict"}. `
    + "Reload it to see the latest, then make your change again.";
}

function describeError(error, verb) {
  if (error?.status === 409) return conflictMessage(error);
  return `Could not ${verb}: ${error?.message || "request failed"}`;
}

function detailHead(documentRef, episode, actions, editing) {
  const head = element(documentRef, "header", "dk-split__head podcast-detail-head");
  const back = element(documentRef, "button", "dk-split__back");
  back.type = "button";
  back.setAttribute("aria-label", "Back to Episodes");
  back.innerHTML = `${SPLIT_BACK_ICON}Episodes`;
  back.addEventListener("click", () => actions.back());
  const title = element(documentRef, "h2", "dk-split__title", episodeTitle(episode));
  title.tabIndex = -1;
  head.append(back, title);
  if (!editing) {
    const edit = button(documentRef, "Edit", "secondary");
    edit.dataset.podcastAction = "edit";
    edit.addEventListener("click", () => actions.edit(episode));
    head.append(edit);
  }
  head.append(closeButton(documentRef, actions));
  return head;
}

// Desktop closes the pane with ×; a phone has Back instead.
function closeButton(documentRef, actions) {
  const close = element(documentRef, "button", "dk-icon-button dk-icon-button--sm podcast-detail-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close episode");
  close.innerHTML = CLOSE_ICON;
  close.addEventListener("click", () => actions.back());
  return close;
}

function statusSection(documentRef, episode, actions, messages) {
  const section = element(documentRef, "section", "podcast-section podcast-status-section");
  section.setAttribute("aria-label", "Status");
  const row = element(documentRef, "div", "dk-cluster podcast-status-row");
  const code = episodeCode(episode);
  if (code) row.append(element(documentRef, "span", "dk-mono podcast-code", code));
  row.append(statusChip(documentRef, episode.status));
  const controls = element(documentRef, "div", "dk-cluster podcast-status-controls");
  async function move(status, trigger) {
    trigger.setAttribute("aria-busy", "true");
    trigger.setAttribute("aria-disabled", "true");
    messages.clear();
    try {
      await actions.update(episode, { status });
    } catch (error) {
      trigger.removeAttribute("aria-busy");
      trigger.removeAttribute("aria-disabled");
      if (trigger.tagName === "SELECT") trigger.value = episode.status;
      showFailure(documentRef, messages, error, "change the status", actions, episode);
    }
  }
  const choose = select(
    documentRef,
    "status",
    EPISODE_STATUSES.map((status) => [status, statusLabel(status)]),
    episode.status,
  );
  choose.classList.add("podcast-status-select");
  choose.setAttribute("aria-label", "Set status");
  choose.addEventListener("change", () => {
    if (choose.value === episode.status) return;
    move(choose.value, choose);
  });
  controls.append(choose);
  row.append(controls);
  section.append(row);
  // Ticking a stage's Task on the Card moves the status; the select corrects it.
  if (episode.cardId) {
    section.append(element(documentRef, "p", "dk-hint podcast-status-hint", "Moves with the Card: recorded, edited, scheduled and published follow its ticked Tasks."));
  }
  return section;
}

function showFailure(documentRef, messages, error, verb, actions, episode) {
  if (error?.status === 409) {
    const reload = button(documentRef, "Reload episode", "secondary");
    reload.addEventListener("click", () => actions.reload(episode.id));
    return messages.show("conflict", conflictMessage(error), [reload]);
  }
  return messages.show("error", describeError(error, verb));
}

function cardSection(documentRef, episode, actions, messages) {
  const section = element(documentRef, "section", "podcast-section podcast-card-section");
  section.append(element(documentRef, "h3", "podcast-section__title", "Card"));
  const card = episode.card;
  if (card) {
    const link = element(documentRef, "a", "podcast-card-chip");
    link.href = `/cards?cardId=${encodeURIComponent(card.id)}`;
    link.dataset.cardId = card.id;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      actions.openCard(card.id);
    });
    link.append(icon("card", { size: 16 }), element(documentRef, "span", "podcast-card-chip__title", card.title || "Untitled card"));
    const meta = element(documentRef, "span", "podcast-card-chip__meta");
    const stage = cardStageLabel(card.stage);
    if (stage) meta.append(element(documentRef, "span", "", stage));
    const open = Number(card.openTaskCount) || 0;
    const total = Number(card.taskCount) || 0;
    const tasks = element(documentRef, "span", "dk-mono", `${open}/${total}`);
    tasks.title = `${open} of ${total} tasks open`;
    meta.append(tasks, element(documentRef, "span", "", "open"));
    link.append(meta);
    section.append(link);
    return section;
  }
  if (episode.cardId) {
    section.append(element(documentRef, "p", "dk-hint", `Linked Card ${episode.cardId} could not be loaded.`));
    return section;
  }
  const row = element(documentRef, "div", "dk-cluster");
  const create = button(documentRef, "Create card", "secondary");
  create.dataset.podcastAction = "create-card";
  row.append(create);
  if (!episode.recordingDate) {
    create.setAttribute("aria-disabled", "true");
    create.disabled = true;
    row.append(element(documentRef, "span", "dk-hint podcast-inline-hint", "Set a recording date first: the Card's tasks count from it."));
  } else {
    row.append(element(documentRef, "span", "dk-hint podcast-inline-hint", "From the podcast template, anchored on the recording date."));
  }
  create.addEventListener("click", async () => {
    if (create.disabled || create.getAttribute("aria-busy") === "true") return;
    create.setAttribute("aria-busy", "true");
    create.setAttribute("aria-disabled", "true");
    messages.clear();
    try {
      await actions.createCard(episode);
    } catch (error) {
      create.removeAttribute("aria-busy");
      create.removeAttribute("aria-disabled");
      showFailure(documentRef, messages, error, "create the card", actions, episode);
    }
  });
  section.append(row);
  return section;
}

function factsSection(documentRef, episode) {
  const section = element(documentRef, "section", "podcast-section");
  section.append(element(documentRef, "h3", "podcast-section__title", "Details"));
  const list = element(documentRef, "dl", "dk-dl podcast-facts");
  const facts = [
    ["Guests", guestNames(episode) || "None yet"],
    ["Episode", episode.season ? `Season ${episode.season}${episode.episode ? `, episode ${episode.episode}` : ""}` : "Not numbered"],
    ["Recording", formatDate(episode.recordingDate) || "Not set", Boolean(episode.recordingDate)],
  ];
  if (episode.websiteSlug) facts.push(["Website slug", episode.websiteSlug, true]);
  for (const [label, value, mono] of facts) {
    list.append(element(documentRef, "dt", "", label), element(documentRef, "dd", mono ? "dk-mono" : "", value));
  }
  section.append(list);
  return section;
}

function linksSection(documentRef, episode) {
  const section = element(documentRef, "section", "podcast-section");
  section.append(element(documentRef, "h3", "podcast-section__title", "Links"));
  const links = LINK_KINDS.filter((kind) => episode.links?.[kind.id]);
  if (!links.length) {
    section.append(element(documentRef, "p", "dk-hint", "No links yet. Add them with Edit once the episode is out."));
    return section;
  }
  const list = element(documentRef, "ul", "podcast-links");
  for (const kind of links) {
    const item = element(documentRef, "li");
    const anchor = element(documentRef, "a", "podcast-link");
    anchor.href = episode.links[kind.id];
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.title = episode.links[kind.id];
    anchor.dataset.link = kind.id;
    anchor.append(icon(kind.icon, { size: 16 }), element(documentRef, "span", "", kind.label));
    item.append(anchor);
    list.append(item);
  }
  section.append(list);
  return section;
}

function notesSection(documentRef, episode) {
  const section = element(documentRef, "section", "podcast-section");
  section.append(element(documentRef, "h3", "podcast-section__title", "Notes"));
  section.append(
    episode.notes
      ? element(documentRef, "p", "podcast-notes", episode.notes)
      : element(documentRef, "p", "dk-hint", "No notes."),
  );
  return section;
}

/**
 * The changed fields between the record and the form, as a PUT body. Throws an
 * Error carrying a message when the publication fields cannot be built.
 */
export function formChanges(episode, values, nowIso = new Date().toISOString()) {
  const changes = {};
  const text = (value) => String(value ?? "").trim();
  const nullable = (value) => (text(value) ? text(value) : null);
  const number = (value) => (text(value) ? Number(text(value)) : null);
  const title = nullable(values.title);
  if (title !== (episode.title || null)) changes.title = title;
  const guests = parseGuestNames(values.guests, episode.guests);
  if (JSON.stringify(guests) !== JSON.stringify(episode.guests || [])) changes.guests = guests;
  for (const name of ["season", "episode"]) {
    const next = number(values[name]);
    if (next !== (episode[name] ?? null)) changes[name] = next;
  }
  for (const name of ["recordingDate", "releaseDate", "websiteSlug", "notes"]) {
    const next = nullable(values[name]);
    if (next !== (episode[name] || null)) changes[name] = next;
  }
  if (Object.hasOwn(values, "audioScheduledLocal")) {
    const built = buildPublication(episode.publication, values, nowIso);
    if (built.error) throw new Error(built.error);
    if (!samePublication(built.value, episode.publication)) changes.publication = built.value;
  }
  const links = {};
  for (const kind of LINK_KINDS) {
    const value = text(values[`link-${kind.id}`]);
    if (value) links[kind.id] = value;
  }
  if (JSON.stringify(links) !== JSON.stringify(Object.fromEntries(
    LINK_KINDS.filter((kind) => episode.links?.[kind.id]).map((kind) => [kind.id, episode.links[kind.id]]),
  ))) changes.links = links;
  return changes;
}

function editForm(documentRef, episode, actions, messages) {
  const form = element(documentRef, "form", "podcast-edit-form dk-stack");
  form.noValidate = true;
  form.setAttribute("aria-label", "Edit episode");
  const controls = {
    title: input(documentRef, "title", episode.title),
    guests: input(documentRef, "guests", guestNames(episode)),
    season: input(documentRef, "season", episode.season, "number"),
    episode: input(documentRef, "episode", episode.episode, "number"),
    recordingDate: input(documentRef, "recordingDate", episode.recordingDate, "date"),
    releaseDate: input(documentRef, "releaseDate", episode.releaseDate, "date"),
    websiteSlug: input(documentRef, "websiteSlug", episode.websiteSlug),
    notes: element(documentRef, "textarea", "dk-textarea"),
  };
  const publication = publicationFormFields(documentRef, episode);
  Object.assign(controls, publication.controls);
  controls.title.maxLength = 300;
  controls.season.min = "1";
  controls.episode.min = "1";
  controls.notes.name = "notes";
  controls.notes.rows = 4;
  controls.notes.maxLength = NOTES_MAX;
  controls.notes.value = episode.notes || "";
  controls.title.dataset.dkAutofocus = "";
  const numbers = element(documentRef, "div", "podcast-form-pair");
  numbers.append(field(documentRef, "Season", controls.season), field(documentRef, "Episode", controls.episode));
  const dates = element(documentRef, "div", "podcast-form-pair");
  dates.append(field(documentRef, "Recording date", controls.recordingDate), field(documentRef, "Intended release date", controls.releaseDate));
  const links = element(documentRef, "fieldset", "podcast-form-links");
  links.append(element(documentRef, "legend", "dk-label", "Links"));
  for (const kind of LINK_KINDS) {
    const control = input(documentRef, `link-${kind.id}`, episode.links?.[kind.id], "url");
    control.placeholder = "https://";
    controls[`link-${kind.id}`] = control;
    links.append(field(documentRef, kind.label, control));
  }
  form.append(
    field(documentRef, "Title", controls.title),
    field(documentRef, "Guests", controls.guests, "Comma-separated names."),
    numbers,
    dates,
    links,
    publication.fieldset,
    field(documentRef, "Website slug", controls.websiteSlug),
    field(documentRef, "Notes", controls.notes),
  );
  const footer = element(documentRef, "div", "dk-form-actions podcast-form-actions");
  const save = button(documentRef, "Save episode", "primary", "");
  save.type = "submit";
  save.dataset.podcastAction = "save";
  const cancel = button(documentRef, "Cancel", "secondary", "");
  cancel.addEventListener("click", () => actions.cancelEdit());
  footer.append(save, cancel);
  form.append(footer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.getAttribute("aria-busy") === "true") return;
    const values = Object.fromEntries(
      Object.entries(controls).map(([name, control]) => [name, control.type === "checkbox" ? control.checked : control.value]),
    );
    let changes;
    try {
      changes = formChanges(episode, values);
    } catch (error) {
      messages.show("error", error.message);
      return;
    }
    if (!Object.keys(changes).length) {
      actions.cancelEdit();
      return;
    }
    if (!String(values.title || "").trim() && !(changes.guests ?? episode.guests ?? []).length) {
      messages.show("error", "An episode needs a title or at least one guest.");
      return;
    }
    save.setAttribute("aria-busy", "true");
    save.setAttribute("aria-disabled", "true");
    messages.clear();
    try {
      await actions.update(episode, changes);
    } catch (error) {
      save.removeAttribute("aria-busy");
      save.removeAttribute("aria-disabled");
      showFailure(documentRef, messages, error, "save the episode", actions, episode)?.focus?.();
    }
  });
  return form;
}

/** Fill `pane` (a .dk-split__detail) with `episode`, or say why it can't. */
export function renderEpisodeDetail(pane, { documentRef, episode, editing, notice, missingId, actions }) {
  if (missingId) {
    const head = element(documentRef, "header", "dk-split__head");
    const back = element(documentRef, "button", "dk-split__back");
    back.type = "button";
    back.setAttribute("aria-label", "Back to Episodes");
    back.innerHTML = `${SPLIT_BACK_ICON}Episodes`;
    back.addEventListener("click", () => actions.back());
    head.append(back, element(documentRef, "h2", "dk-split__title", "Episode not found"));
    head.append(closeButton(documentRef, actions));
    const retry = button(documentRef, "Retry", "secondary");
    retry.addEventListener("click", () => actions.reload(missingId));
    const holder = element(documentRef, "div", "dk-split__empty podcast-not-found");
    holder.append(emptyState(documentRef, "Episode not found", `No episode has the id ${missingId}. It may have been deleted.`, [retry]));
    pane.append(head, holder);
    return;
  }
  pane.append(detailHead(documentRef, episode, actions, editing));
  const scroll = element(documentRef, "div", "dk-split__scroll podcast-detail");
  const messages = messageArea(documentRef, "podcast-message");
  if (notice) messages.show("status", notice);
  if (editing) {
    scroll.append(messages.node, editForm(documentRef, episode, actions, messages));
  } else {
    scroll.append(
      statusSection(documentRef, episode, actions, messages),
      messages.node,
      cardSection(documentRef, episode, actions, messages),
      publicationSection(documentRef, episode),
      factsSection(documentRef, episode),
      linksSection(documentRef, episode),
      notesSection(documentRef, episode),
    );
  }
  pane.append(scroll);
}
