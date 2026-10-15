import { renderIcon } from "../../core/icons.js";
import {
  isHttpLink,
  isMailLink,
  linkAddress,
  linkService,
  mailAddress,
  opensInNewTab,
} from "../../core/links.js";

// Named links as a dense list: one row per link with its label, the value as
// a readable link (host and a shortened path, the full address in the title),
// and an Edit button. The text input exists only while a row is being edited;
// an empty link shows a quiet "Add" in its place. Rows sit in a `.link-rows`
// list (see `renderLinkList`).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(icon, label, className) {
  const button = el("button", `link-row__button ${className}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(renderIcon(icon, { size: 16 }));
  return button;
}

// The value cell for a saved link: an outside page opens in a new tab, an
// email address opens the mail client, anything else is plain text.
function renderValue(value) {
  const service = linkService(value);
  if (isHttpLink(value) || isMailLink(value)) {
    const link = el("a", "link-row__link");
    link.href = value;
    link.title = value;
    if (service.id !== "link") link.append(renderIcon(service.icon, { size: 16, className: "link-row__icon" }));
    link.append(el("span", "link-row__address", isMailLink(value) ? mailAddress(value) : linkAddress(value)));
    if (isHttpLink(value)) opensInNewTab(link);
    return link;
  }
  const text = el("span", "link-row__text", value);
  text.title = value;
  return text;
}

async function copyText(text) {
  await globalThis.navigator?.clipboard?.writeText?.(text);
}

/**
 * One link row.
 *
 * - `label`: what the link is ("Guest email").
 * - `value`: the saved value; empty means the link is missing.
 * - `editing`: start with the editor open (an unsaved draft survives a rerender).
 * - `draftKey` / `draftValue`: the editor input's draft identity and text.
 * - `disabled`: a mutation is in flight; nothing can be edited.
 * - `onSave(value)`: commit the edited value (called only when it changed).
 * - `onEditingChange(open)`: the editor opened or closed.
 */
export function renderLinkRow(options) {
  const {
    label,
    value = "",
    disabled = false,
    draftKey,
    draftValue,
    onSave,
    onEditingChange = () => {},
  } = options;
  const saved = String(value || "").trim();
  const row = el("li", "link-row");
  row.dataset.linkName = label;
  let editing = Boolean(options.editing);

  const setEditing = (open, { focus = true } = {}) => {
    editing = open;
    onEditingChange(open);
    paint();
    if (!focus) return;
    const target = open
      ? row.querySelector(".link-row__input")
      : row.querySelector(".link-row__edit, .link-row__add");
    target?.focus?.();
  };

  function renderEditor() {
    const editor = el("div", "link-row__editor");
    const input = el("input", "dk-input link-row__input");
    input.type = "url";
    input.inputMode = "url";
    input.placeholder = "https://… or mailto:…";
    input.setAttribute("aria-label", `${label} link`);
    if (draftKey) input.dataset.cardDraftKey = draftKey;
    input.value = draftValue ?? saved;
    input.disabled = disabled;
    const save = el("button", "dk-button dk-button--primary dk-button--sm link-row__save", "Save");
    save.type = "button";
    save.disabled = disabled;
    save.setAttribute("aria-label", `Save ${label}`);
    const cancel = el("button", "dk-button dk-button--sm link-row__cancel", "Cancel");
    cancel.type = "button";
    cancel.setAttribute("aria-label", `Cancel editing ${label}`);
    const commit = () => {
      const next = input.value.trim();
      if (next === saved) return setEditing(false);
      editing = false;
      onEditingChange(false);
      return onSave(next);
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", () => setEditing(false));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setEditing(false);
      }
    });
    editor.append(input, save, cancel);
    return editor;
  }

  function paint() {
    row.classList.toggle("is-missing", !saved);
    row.classList.toggle("is-editing", editing);
    const name = el("span", "link-row__label", label);
    name.title = label;
    if (editing) {
      row.replaceChildren(name, renderEditor());
      return;
    }
    const valueCell = el("div", "link-row__value");
    const actions = el("div", "link-row__actions");
    if (saved) {
      valueCell.append(renderValue(saved));
      if (isMailLink(saved)) {
        const copy = iconButton("copy", `Copy ${label} address`, "link-row__copy");
        copy.addEventListener("click", async () => {
          try {
            await copyText(mailAddress(saved));
            copy.title = "Copied";
            copy.dataset.copied = "";
          } catch {
            copy.title = "Could not copy";
          }
        });
        actions.append(copy);
      }
      const edit = iconButton("pencil", `Edit ${label}`, "link-row__edit");
      edit.disabled = disabled;
      edit.addEventListener("click", () => setEditing(true));
      actions.append(edit);
    } else {
      const add = el("button", "link-row__add", "Add");
      add.type = "button";
      add.disabled = disabled;
      add.setAttribute("aria-label", `Add ${label}`);
      add.addEventListener("click", () => setEditing(true));
      valueCell.append(add);
    }
    row.replaceChildren(name, valueCell, actions);
  }

  paint();
  return row;
}

// The list the rows sit in.
export function renderLinkList(rows, label = "Links") {
  const list = el("ul", "link-rows");
  list.setAttribute("aria-label", label);
  list.append(...rows);
  return list;
}
