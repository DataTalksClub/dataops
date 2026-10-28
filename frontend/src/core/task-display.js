import { documentHref, isHttpLink, linkLabel, linkService, linkTarget } from "./links.js";

// How a task reads on screen: its title, an optional checklist tag, and the
// supporting materials (process doc, instructions, the task's stored
// `materials` links) gathered into one list the UI can put behind a single
// icon instead of strings under the title.

const TITLE_TAG = /^\[([^[\]]{1,40})\](?!\()\s*/;

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
  const tag = fieldTag ? fieldTag.trim() : prefix ? prefix[1].trim() : "";
  return { title: withoutPrefix, tag: tag.toLowerCase() === kind ? "" : tag };
}

function humanizeDocId(docId) {
  const tail = String(docId || "").split(".").pop() || "";
  return capitalize(tail.replace(/[-_]+/g, " ")) || "Process doc";
}

// Every supporting material of a task, most authoritative first, one entry
// per destination. `resolveDoc` maps a process-doc id to its document; a
// resolved process doc carries the portal address it opens at as `href`, an
// unresolved one has none.
export function taskMaterials(task, options = {}) {
  const { resolveDoc = () => null } = options;
  const materials = [];
  const seen = new Set();
  const add = (material) => {
    const key = material.kind === "doc" ? `doc:${material.docId}` : linkTarget(material.href);
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
      href: doc?.path ? documentHref(doc.path) : "",
    });
  }
  if (isHttpLink(task?.instructionsUrl)) {
    const href = linkTarget(task.instructionsUrl);
    add({ kind: "link", icon: "instructions", label: "Instructions", detail: linkService(href).name, href });
  }
  for (const link of Array.isArray(task?.materials) ? task.materials : []) {
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

// The execution need beside the accounts: does this task need an interactive
// browser? A human classification carried on the task — never inferred from a
// service name, since a YouTube or Typefully task may have a full API route.
// Anything unclassified stays unknown on purpose: it is never shown as, or
// filtered into, safe headless work.
export function browserRequirementParts(value) {
  if (value === "required") {
    return { label: "Browser required", short: "browser", icon: "globe", classified: true };
  }
  if (value === "headless") {
    return { label: "Runs headless", short: "headless", icon: "code", classified: true };
  }
  return { label: "Browser need not classified", short: "", icon: "", classified: false };
}
