// Required resources: the external systems a Task cannot be done without
// (YouTube, Luma, Mailchimp, ...). The vocabulary comes from
// GET /api/resources; each entry names a glyph in the shared icon set
// (core/icons.js), one per kind of system, so the name always rides along as
// a tooltip and accessible label.

import { renderIcon } from "./icons.js";

/** The vocabulary payload as an ordered list plus an id lookup. */
export function resourcesFromPayload(payload) {
  const list = Array.isArray(payload?.resources) ? payload.resources : [];
  return list.filter((resource) => resource && typeof resource.id === "string");
}

export function resourceLabel(id, resourcesById) {
  return resourcesById?.get?.(id)?.name || String(id);
}

/**
 * One resource as a glyph, or a glyph and its name. The name is always the
 * tooltip; a glyph-only mark carries it as the accessible label too.
 */
export function renderResourceMark(id, resourcesById, options = {}) {
  const resource = resourcesById?.get?.(id);
  const name = resourceLabel(id, resourcesById);
  const mark = document.createElement("span");
  mark.className = options.withName ? "ops-resource ops-resource--named" : "ops-resource";
  mark.dataset.resource = id;
  mark.title = resource?.access ? `${name}: ${resource.access}` : name;
  mark.append(renderIcon(resource?.icon, { size: 16 }));
  if (options.withName) {
    const label = document.createElement("span");
    label.className = "ops-resource-name";
    label.textContent = name;
    mark.append(label);
  } else {
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", name);
  }
  return mark;
}

/** A Task's requirements as a compact row of marks; null when it needs none. */
export function renderResourceMarks(requires, resourcesById, options = {}) {
  if (!Array.isArray(requires) || requires.length === 0) return null;
  const marks = document.createElement("span");
  marks.className = options.withName ? "ops-resources ops-resources--named" : "ops-resources";
  for (const id of requires) marks.append(renderResourceMark(id, resourcesById, options));
  return marks;
}
