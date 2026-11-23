// Small DOM helpers shared by the newsletter blocks editor modules.

export const MULTILINE = new Set(["markdown", "lines", "html"]);

export function formatWhen(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 16).replace("T", " ");
}

export function createDom(documentRef) {
  const el = (tag, className, text) => {
    const node = (documentRef || globalThis.document).createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, variant, action) => {
    const node = el("button", `dk-button dk-button--sm${variant ? ` dk-button--${variant}` : ""}`, label);
    node.type = "button";
    if (action) node.dataset.blocksAction = action;
    return node;
  };
  return { el, button };
}

/** Server refusal text plus the per-field details of a validation error. */
export function failureText(failure) {
  const fields = failure.payload?.fields;
  const detail = fields ? ` (${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "";
  return `${failure.message}${detail}`;
}

/** Form control for one block field, prefilled from `value`. */
export function fieldControl(dom, field, value, placeholderDefault = true) {
  const wrap = dom.el("label", "dk-label newsletter-blocks__field");
  wrap.append(dom.el("span", "", `${field.label}${field.required ? " *" : ""}`));
  const multiline = MULTILINE.has(field.kind);
  const input = dom.el(multiline ? "textarea" : "input", multiline ? "dk-textarea" : "dk-input");
  input.name = field.name;
  input.value = value || "";
  if (!multiline) input.type = field.kind === "url" ? "url" : "text";
  if (multiline) input.rows = Math.min(14, Math.max(3, input.value.split("\n").length + 1));
  if (placeholderDefault && field.default) input.placeholder = field.default;
  input.dataset.blockField = field.name;
  wrap.append(input);
  return wrap;
}

export function collectFields(form) {
  const data = {};
  for (const input of form.querySelectorAll("[data-block-field]")) data[input.name] = input.value;
  return data;
}
