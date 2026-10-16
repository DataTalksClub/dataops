import "../../dakit/tag-input.js";
import { documentHref, opensInNewTab } from "../../core/links.js";

// The doc types a schedule's process doc is picked from: the documents that
// say how to do a piece of work.
const PROCESS_DOC_TYPES = Object.freeze({
  sop: "SOPs",
  checklist: "Checklists",
  playbook: "Playbooks",
});

let pickerSequence = 0;

// The schedule's process doc: a type-to-search pick over the knowledge
// base's SOPs, checklists and playbooks (the dakit tag input, held to one
// value), with a link that opens the chosen doc in a new tab. A doc the
// catalog no longer lists stays chosen under its id, so saving never drops
// it silently.
export function createProcessDocPicker(initialDocId, { documents: allDocuments = [], resolveDocReference } = {}) {
  const field = document.createElement("div");
  field.className = "recurring-form-wide recurring-form-doc";
  const labelId = `recurring-doc-label-${++pickerSequence}`;
  const heading = document.createElement("span");
  heading.className = "recurring-form-doc-label";
  heading.id = labelId;
  heading.textContent = "Process doc";

  const documents = allDocuments.filter(
    (doc) => doc?.id && PROCESS_DOC_TYPES[doc.doc_type],
  );
  const options = documents
    .map((doc) => ({
      value: String(doc.id),
      label: String(doc.title || doc.id),
      aliases: [String(doc.id), ...(Array.isArray(doc.aliases) ? doc.aliases : [])],
      group: PROCESS_DOC_TYPES[doc.doc_type],
    }))
    .sort((a, b) =>
      Object.values(PROCESS_DOC_TYPES).indexOf(a.group) - Object.values(PROCESS_DOC_TYPES).indexOf(b.group)
        || a.label.localeCompare(b.label));
  const initial = String(initialDocId || "");
  if (initial && !options.some((option) => option.value === initial)) {
    const known = resolveDocReference?.(initial);
    options.unshift({ value: initial, label: known?.title || initial, aliases: [] });
  }

  const open = document.createElement("a");
  open.className = "recurring-form-doc-open";
  const syncOpen = (docId) => {
    const doc = docId ? resolveDocReference?.(docId) : null;
    open.replaceChildren();
    open.hidden = !doc?.path;
    if (!doc?.path) {
      open.removeAttribute("href");
      return;
    }
    open.href = documentHref(doc.path);
    open.textContent = "Open doc";
    open.removeAttribute("aria-label");
    open.setAttribute("aria-label", `Open ${doc.title || docId}`);
    opensInNewTab(open);
  };

  const picker = globalThis.dakitTagInput.create({
    labelledBy: labelId,
    label: "Process doc",
    placeholder: options.length ? "Type to find an SOP…" : "Process docs are not loaded",
    noMatches: "No matching process doc",
    options,
    value: initial ? [initial] : [],
    onChange: (value, change) => {
      // One process doc per schedule: a new pick replaces the old one.
      if (change?.added && value.length > 1) picker.setValue([change.added]);
      syncOpen(picker.getValue()[0] || "");
    },
  });
  picker.input.dataset.formField = "instructionDocId";
  syncOpen(initial);

  const row = document.createElement("div");
  row.className = "recurring-form-doc-row";
  row.append(picker.element, open);
  const hint = document.createElement("p");
  hint.className = "recurring-form-doc-hint";
  hint.textContent = "Every task this schedule creates links this doc.";
  field.append(heading, row, hint);
  return { element: field, getValue: () => picker.getValue()[0] || "" };
}
