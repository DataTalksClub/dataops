// External links as people read them: which service, and a short human name.
// Raw URLs never reach the screen — a link is drawn as its service icon plus
// a label (the stored title when someone wrote one, otherwise the service and
// a short identifier), with the full address one hover away.

const MARKDOWN_ESCAPE = /\\([\\`*_{}[\]()#+\-.!~|])/g;

const SERVICES = [
  { id: "webinardoc", name: "Speaker materials", icon: "doc", group: "documents", test: (_h, p) => p.startsWith("/webinar-docs/") },
  {
    id: "sponsordoc",
    name: "Sponsor Doc",
    icon: "doc",
    group: "documents",
    test: (_h, p) =>
      p.startsWith("/sponsor-docs/") || p.startsWith("/podcast-docs/") || p.startsWith("/guest-docs/"),
  },
  { id: "gdoc", name: "Google Doc", icon: "doc", group: "documents", test: (h, p) => h === "docs.google.com" && p.startsWith("/document/") },
  { id: "gsheet", name: "Google Sheet", icon: "sheet", group: "documents", test: (h, p) => h === "docs.google.com" && p.startsWith("/spreadsheets/") },
  { id: "gslides", name: "Google Slides", icon: "slides", group: "documents", test: (h, p) => h === "docs.google.com" && p.startsWith("/presentation/") },
  { id: "gform", name: "Google Form", icon: "doc", group: "documents", test: (h, p) => h === "docs.google.com" && p.startsWith("/forms/") },
  { id: "gdrive", name: "Google Drive", icon: "file", group: "documents", test: (h) => h === "drive.google.com" },
  { id: "github", name: "GitHub", icon: "code", group: "documents", test: (h) => h === "github.com" },
  { id: "luma", name: "Luma", icon: "calendar", group: "events", test: (h) => h === "luma.com" || h === "lu.ma" },
  { id: "meetup", name: "Meetup", icon: "calendar", group: "events", test: (h) => h === "meetup.com" },
  { id: "youtube", name: "YouTube", icon: "play", group: "media", test: (h) => h === "youtube.com" || h === "youtu.be" },
  { id: "loom", name: "Loom", icon: "play", group: "media", test: (h) => h === "loom.com" },
  { id: "linkedin", name: "LinkedIn", icon: "person", group: "people", test: (h) => h === "linkedin.com" },
];

const GENERIC = { id: "link", name: "Link", icon: "link", group: "other" };
const MAIL = { id: "email", name: "Email", icon: "mail", group: "people" };

export const LINK_GROUPS = Object.freeze([
  { id: "documents", label: "Documents" },
  { id: "events", label: "Event pages" },
  { id: "media", label: "Videos" },
  { id: "people", label: "People" },
  { id: "files", label: "Files" },
  { id: "other", label: "Other links" },
]);

function parsed(url) {
  try {
    return new URL(String(url || ""));
  } catch {
    return null;
  }
}

// The link target inside `[label](url)` or a broken `url](url` half, with
// Markdown escapes and a dangling bracket removed. Rendering only; the
// backend stores links already cleaned.
export function linkTarget(raw) {
  let text = String(raw || "").trim();
  const full = /^\[[^\]]*\]\((.+)\)$/.exec(text);
  if (full) text = full[1];
  else if (text.includes("](")) text = text.slice(text.lastIndexOf("](") + 2);
  text = text.replace(/\s+"[^"]*"$/, "").replace(MARKDOWN_ESCAPE, "$1").replace(/\]+$/, "");
  const opens = text.split("(").length;
  const closes = text.split(")").length;
  if (text.endsWith(")") && closes > opens) text = text.slice(0, -1);
  return text;
}

export function isHttpLink(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// A `mailto:` value is an email address, not a page: present, but opened by
// the mail client rather than a new tab.
export function isMailLink(value) {
  return /^mailto:[^\s@]+@[^\s@]+/i.test(String(value || "").trim());
}

export function mailAddress(value) {
  const text = String(value || "").trim().replace(/^mailto:/i, "").split("?")[0];
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The address as people read it: the host without `www.`, then the path cut
// to its last segment ("docs.google.com/…/edit", "luma.com/ar4ggwep"), and a
// short query kept when it is the identifier ("youtube.com/watch?v=…"). The
// full URL belongs in the link's title.
export function linkAddress(url) {
  const target = linkTarget(url);
  const address = parsed(target);
  if (!address || !/^https?:$/.test(address.protocol)) return target;
  const host = address.hostname.replace(/^www\./, "");
  const segments = address.pathname.split("/").filter(Boolean);
  let path = "";
  if (segments.length === 1) path = `/${segments[0]}`;
  else if (segments.length > 1) path = `/…/${segments.at(-1)}`;
  const query = address.search.length > 1 && address.search.length <= 24 ? address.search : "";
  try {
    return decodeURIComponent(`${host}${path}${query}`);
  } catch {
    return `${host}${path}${query}`;
  }
}

export function linkService(url) {
  const address = parsed(linkTarget(url));
  if (!address) return GENERIC;
  if (address.protocol === "mailto:") return MAIL;
  const host = address.hostname.toLowerCase().replace(/^www\./, "");
  return SERVICES.find((service) => service.test(host, address.pathname)) || GENERIC;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 8)}…` : text;
}

// The short identifier that tells two links of one service apart.
function linkIdentifier(address, service) {
  const segments = address.pathname.split("/").filter(Boolean);
  switch (service.id) {
    case "gdoc":
    case "gsheet":
    case "gslides":
    case "gform": {
      const index = segments.indexOf("d");
      return index >= 0 ? shortId(segments[index + 1]) : "";
    }
    case "meetup": {
      const index = segments.indexOf("events");
      return index >= 0 && segments[index + 1] ? `event ${segments[index + 1]}` : segments[0] || "";
    }
    case "youtube":
      return address.searchParams.get("v") || segments.at(-1) || "";
    case "linkedin":
      return segments.at(-1) || "";
    case "github":
      return segments.slice(0, 2).join("/") + (segments.length > 2 ? ` · ${decodeURIComponent(segments.at(-1))}` : "");
    default:
      return segments.length ? shortId(segments.at(-1)) : address.hostname.replace(/^www\./, "");
  }
}

// The name a link goes by: an operator's label wins; a URL-shaped or empty
// title becomes "Service · identifier".
export function linkLabel(url, title) {
  const text = String(title || "").trim();
  if (text && !isHttpLink(linkTarget(text)) && !text.includes("](")) return text;
  const target = linkTarget(url || text);
  const address = parsed(target);
  if (!address) return text || target || "Link";
  const service = linkService(target);
  const id = linkIdentifier(address, service);
  if (service === GENERIC) return id ? `${address.hostname.replace(/^www\./, "")} · ${id}` : address.hostname;
  return id ? `${service.name} · ${id}` : service.name;
}

// The address the portal shows a process document at: its content path
// without the `content/` prefix.
export function documentHref(path) {
  return `/${encodeURI(String(path || "").replace(/^\/+/, "").replace(/^content\//, ""))}`;
}

const NEW_TAB_NOTE = "(opens in new tab)";

// A link that leaves the work in front of the operator — a process doc, a
// material, an artifact, any outside page — opens in a new tab and says so
// to assistive tech. Call it after the link has its label: an `aria-label`
// gains the note, otherwise a visually hidden note is appended.
export function opensInNewTab(link) {
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const label = link.getAttribute("aria-label");
  if (label) {
    link.setAttribute("aria-label", `${label} ${NEW_TAB_NOTE}`);
  } else {
    const note = document.createElement("span");
    note.className = "dk-visually-hidden";
    note.textContent = ` ${NEW_TAB_NOTE}`;
    link.append(note);
  }
  return link;
}

// The Card a plain click on a link opens: a link to a Card's own page
// (`/cards?cardId=…`, or the archive) opens that Card as a dialog over the
// current page instead. A modified or middle click, a link to a Task inside
// the Card, or one that opens in another window keeps its browser default.
export function cardLinkTarget(event, origin = globalThis.location?.origin) {
  if (event.defaultPrevented || event.button !== 0) return "";
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return "";
  const link = event.target?.closest?.("a[href]");
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return "";
  let url;
  try {
    url = new URL(link.getAttribute("href"), origin);
  } catch {
    return "";
  }
  if (url.origin !== origin || !["/cards", "/cards/archive"].includes(url.pathname)) return "";
  if (url.searchParams.has("taskId")) return "";
  return url.searchParams.get("cardId") || "";
}
