// The one HTML escaper. Its output is safe in text and in single- or
// double-quoted attribute values, so every surface uses it for both.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const UNESCAPES = Object.fromEntries(Object.entries(ESCAPES).map(([raw, entity]) => [entity, raw]));

// Reverses escapeHtml, for text that was escaped as a whole before parts of
// it were picked out (markdown links) and need their raw value again.
export function unescapeHtml(value) {
  return String(value ?? "").replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity]);
}
