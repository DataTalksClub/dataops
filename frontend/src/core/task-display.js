import { extractTextLinks, isHttpLink, linkLabel, linkService, linkTarget } from "./links.js";

// How a task reads on screen: its title without import debris, an optional
// checklist tag, and the supporting materials (process doc, instructions,
// links that were pasted into the title) gathered into one list the UI can
// put behind a single icon instead of strings under the title.

const TITLE_TAG = /^\[([^[\]]{1,40})\]\s*/;

function capitalize(text) {
  const value = String(text || "").trim();
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

// `kindType` is the Card's template type: a tag that only repeats it (the
// Trello import tagged every task with its card's type) says nothing new.
export function taskTitleParts(rawTitle, tags, kindType = "") {
  const kind = String(kindType || "").toLowerCase();
  const fieldTag = (Array.isArray(tags) ? tags : []).find(
    (tag) => typeof tag === "string" && tag.trim() && tag.trim().toLowerCase() !== kind,
  );
  const raw = String(rawTitle || "");
  const prefix = raw.match(TITLE_TAG);
  const withoutPrefix = prefix ? raw.replace(TITLE_TAG, "") || raw : raw;
  const { text, links } = extractTextLinks(withoutPrefix);
  const tag = fieldTag ? fieldTag.trim() : prefix ? prefix[1].trim() : "";
  return { title: text, tag: tag.toLowerCase() === kind ? "" : tag, links };
}

function humanizeDocId(docId) {
  const tail = String(docId || "").split(".").pop() || "";
  return capitalize(tail.replace(/[-_]+/g, " ")) || "Process doc";
}

// Every supporting material of a task, most authoritative first, one entry
// per destination. `resolveDoc` maps a process-doc id to its document.
export function taskMaterials(task, options = {}) {
  const { links = [], resolveDoc = () => null } = options;
  const materials = [];
  const seen = new Set();
  const add = (material) => {
    const key = material.href ? linkTarget(material.href) : `doc:${material.docId}`;
    if (seen.has(key)) return;
    seen.add(key);
    materials.push(material);
  };
  if (task?.instructionDocId) {
    const doc = resolveDoc(task.instructionDocId);
    add({
      kind: "doc",
      icon: "instructions",
      label: doc?.title || humanizeDocId(task.instructionDocId),
      detail: "Process doc",
      docId: String(task.instructionDocId),
      docPath: doc?.path || "",
    });
  }
  if (isHttpLink(task?.instructionsUrl)) {
    const href = linkTarget(task.instructionsUrl);
    add({ kind: "link", icon: "instructions", label: "Instructions", detail: linkService(href).name, href });
  }
  for (const link of links) {
    if (!isHttpLink(link.url)) continue;
    const service = linkService(link.url);
    add({
      kind: "link",
      icon: service.icon,
      label: link.label ? capitalize(link.label) : linkLabel(link.url),
      detail: service.name,
      href: link.url,
    });
  }
  return materials;
}
