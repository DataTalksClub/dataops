// The work surfaces' one icon language: inline 24-grid stroke paths drawn at
// 20px with currentColor, stroke 1.8, round caps and joins — the dakit family
// geometry. No emoji, no icon font. Each name maps to one `d` attribute.
const ICON_PATHS = Object.freeze({
  // Template icons (the curated set templates may name in their `icon`).
  video: "M3 7h12v10H3Z M15 10.5l6-3.5v10l-6-3.5",
  mic: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z M5 11a7 7 0 0 0 14 0 M12 18v3 M9 21h6",
  wrench:
    "M14.7 6.3a4.5 4.5 0 0 1 5.8-2.6l-3 3 .7 2.1 2.1.7 3-3a4.5 4.5 0 0 1-6 5.8l-7.2 7.2a2.1 2.1 0 0 1-3-3Z",
  newspaper: "M4 5h13v15H6a2 2 0 0 1-2-2Z M17 9h3v9a2 2 0 0 1-2 2 M8 9h5 M8 13h5 M8 17h3",
  book: "M5 19V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12v-4 M9 7h6",
  "graduation-cap": "M2 9l10-5 10 5-10 5Z M6 11v5c3 2.5 9 2.5 12 0v-5 M22 9v6",
  share:
    "M18 2.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z M6 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z M18 15.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"
    + " M8.6 13.5l6.8 3.5 M15.4 7l-6.8 3.5",
  zap: "M13 2 4 14h7l-1 8 9-12h-7Z",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z",
  code: "m16 18 6-6-6-6 M8 6l-6 6 6 6",
  receipt: "M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2Z M9 8h6 M9 12h6 M9 16h3",
  compass: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Z M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3Z",
  calendar: "M3 5h18v16H3Z M8 3v4 M16 3v4 M3 10h18",
  megaphone: "M3 10v4l13 5V5Z M16 9a3 3 0 0 1 0 6 M7 15.5V20h3v-3.3",
  users:
    "M9 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z M17 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z M3 20c0-4 2-6 6-6s6 2 6 6 M16 14c3 0 5 2 5 5",
  star: "m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3-5.5-2.9-5.5 2.9 1-6.3L3 9.7l6.2-.9Z",
  // Work and link glyphs.
  card: "M4 5h16v14H4Z M4 9h16",
  recurring: "M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4",
  adhoc: "M12 4v16 M4 12h16",
  instructions: "M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2Z M22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8Z",
  doc: "M6 3h9l4 4v14H6Z M14 3v5h5 M9 12h7 M9 16h7",
  sheet: "M6 3h9l4 4v14H6Z M14 3v5h5 M9 11h7v7H9Z M9 14.5h7 M12.5 11v7",
  slides: "M6 3h9l4 4v14H6Z M14 3v5h5 M9 12h7v5H9Z",
  play: "M3 6h18v12H3Z M10 9.5l5 2.5-5 2.5Z",
  person: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z M4 21c0-4 3.6-6 8-6s8 2 8 6",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  file: "M6 3h9l4 4v14H6Z M14 3v5h5",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  pencil: "M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4",
  copy: "M9 9h11v11H9Z M5 15H4V4h11v1",
  // Required-resource glyphs (backend/src/resources/requiredResources.json).
  film: "M4 4h16v16H4Z M8 4v16 M16 4v16 M4 9h4 M4 15h4 M16 9h4 M16 15h4",
  ticket: "M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4Z M14 7v10",
  mail: "M3 6h18v12H3Z M3 7l9 6 9-6",
  folder: "M3 6h6l2 2h10v11H3Z",
  image: "M4 5h16v14H4Z M4 16l5-5 4 4 3-3 4 4 M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z",
  audio: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M7 9.5c3.5-1 7-.6 10 1 M7.5 12.8c3-.8 5.8-.4 8.3.9 M8 16c2.3-.5 4.5-.2 6.4.7",
  podcast: "M12 9.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z M12 13.5V21 M7.8 15.5a6 6 0 1 1 8.4 0 M5 18.2a9.5 9.5 0 1 1 14 0",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M3 12h18 M12 3c3.5 3.5 3.5 14.5 0 18 M12 3c-3.5 3.5-3.5 14.5 0 18",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 11v5 M12 8h.01",
  board: "M4 4h16v16H4Z M8 8v7 M12 8v4 M16 8v9",
  bank: "M3 10l9-6 9 6 M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 20h18",
});

// Kept in step with backend/src/templates/templateIcons.ts (a test checks).
export const TEMPLATE_ICON_NAMES = Object.freeze([
  "video", "mic", "wrench", "newspaper", "book", "graduation-cap", "share", "zap",
  "chat", "code", "receipt", "compass", "calendar", "megaphone", "users", "star",
]);

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

// One inline SVG. Decorative by default (aria-hidden); pass `label` when the
// icon is the only thing naming its control's content.
export function renderIcon(name, options = {}) {
  const svgNs = "http://www.w3.org/2000/svg";
  const make = (tag) =>
    typeof document.createElementNS === "function"
      ? document.createElementNS(svgNs, tag)
      : document.createElement(tag);
  const size = String(options.size || 20);
  const svg = make("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", ["dk-icon", options.className].filter(Boolean).join(" "));
  svg.dataset.icon = hasIcon(name) ? name : "card";
  if (options.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", options.label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const path = make("path");
  path.setAttribute("d", ICON_PATHS[name] || ICON_PATHS.card);
  svg.append(path);
  return svg;
}
