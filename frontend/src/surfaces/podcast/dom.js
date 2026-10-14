// Small DOM helpers shared by the podcast page's list, detail and dialog.
import { renderIcon } from "../../core/icons.js";
import { statusLabel } from "./model.js";

export function element(documentRef, tag, className = "", text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(documentRef, label, variant = "secondary", size = "sm") {
  const node = element(documentRef, "button", `dk-button dk-button--${variant}${size ? ` dk-button--${size}` : ""}`, label);
  node.type = "button";
  return node;
}

// Status reads as a word first; the tone only separates done from in-flight.
const STATUS_TONES = Object.freeze({
  booked: "dk-chip",
  recorded: "dk-badge dk-badge--info",
  edited: "dk-badge dk-badge--info",
  scheduled: "dk-badge dk-badge--warning",
  published: "dk-badge dk-badge--success",
  cancelled: "dk-chip",
});

export function statusChip(documentRef, status) {
  const chip = element(
    documentRef,
    "span",
    `${STATUS_TONES[status] || "dk-chip"} podcast-status`,
    statusLabel(status),
  );
  chip.dataset.status = status || "";
  return chip;
}

export function formatDate(value, options = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(options.year === false ? {} : { year: "numeric" }),
  }).format(date);
}

export function icon(name, options) {
  return renderIcon(name, options);
}

export function emptyState(documentRef, title, description, actions = []) {
  const state = element(documentRef, "div", "dk-empty");
  state.append(element(documentRef, "p", "dk-empty__title", title));
  if (description) state.append(element(documentRef, "p", "dk-empty__desc", description));
  if (actions.length) {
    const row = element(documentRef, "div", "dk-empty__actions");
    row.append(...actions);
    state.append(row);
  }
  return state;
}

/** A label wrapping its control, the kit's form row. */
export function field(documentRef, labelText, control, hint = "") {
  const label = element(documentRef, "label", "podcast-field");
  label.append(element(documentRef, "span", "dk-label", labelText), control);
  if (hint) label.append(element(documentRef, "span", "dk-hint", hint));
  return label;
}

export function input(documentRef, name, value = "", type = "text") {
  const node = element(documentRef, "input", "dk-input");
  node.name = name;
  node.type = type;
  node.value = value === null || value === undefined ? "" : String(value);
  return node;
}

export function select(documentRef, name, options, value = "") {
  const node = element(documentRef, "select", "dk-select");
  node.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = element(documentRef, "option", "", optionLabel);
    option.value = optionValue;
    option.selected = optionValue === value;
    node.append(option);
  }
  node.value = value;
  return node;
}

/** A message area with one assertive role for failures and conflicts. */
export function messageArea(documentRef, className) {
  const node = element(documentRef, "div", className);
  node.hidden = true;
  return {
    node,
    show(kind, text, actions = []) {
      node.replaceChildren();
      node.hidden = false;
      node.dataset.kind = kind;
      node.setAttribute("role", kind === "status" ? "status" : "alert");
      node.className = `${className} dk-callout dk-callout--${kind === "status" ? "success" : kind === "conflict" ? "warning" : "danger"}`;
      const body = element(documentRef, "p", "dk-callout__body", text);
      node.append(body);
      if (actions.length) {
        const row = element(documentRef, "div", "dk-callout__actions");
        row.append(...actions);
        node.append(row);
      }
      return node;
    },
    clear() {
      node.replaceChildren();
      node.hidden = true;
      delete node.dataset.kind;
    },
  };
}
