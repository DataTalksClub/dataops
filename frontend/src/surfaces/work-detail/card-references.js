import { documentHref, opensInNewTab } from "../../core/links.js";
import { isResolvedWorkTask } from "../../core/workspace.js";
import { appendBreakableText } from "./card-summary.js";

// Process references: the card-wide union from the template (`sourceDocIds`
// plus `references`). Each task already carries its own subset behind "How to
// do it" in the task dialog (renderTaskInstructions via taskMaterials), so
// this section is the collapsed supplement, not the primary place to find a
// task's docs. A reference counts as done when its doc is the instruction doc
// of a resolved task on the card; the title text itself is never rewritten
// (it may carry its own check mark).

// How many reference rows paint inline before the rest fold behind the
// "Show all N references" toggle.
export const REFERENCES_VISIBLE_LIMIT = 5;

function appendReferenceItem(entry) {
  const item = document.createElement("div");
  item.className = `task-history-event${entry.done ? " is-done" : ""}`;
  if (entry.done) item.title = "The task using this doc is done";
  if (entry.href) {
    const link = document.createElement("a");
    link.href = entry.href;
    if (entry.isProcessDoc) link.className = "task-instruction-doc-link";
    appendBreakableText(link, entry.name || entry.href);
    opensInNewTab(link);
    item.append(link);
  } else {
    appendBreakableText(item, entry.name);
  }
  return item;
}

// Builds the card's Process references section, or null when the card has
// none. `expanded` forces the list open or shut; null keeps the default
// (open while short, folded once long). `onToggle` receives the next state.
export function renderCardReferencesSection(deps, card, tasks) {
  const {
    resolveDocReference,
    localDocPathFromHref,
    expanded = null,
    onToggle = null,
  } = deps;
  const doneDocIds = new Set();
  const doneHrefs = new Set();
  for (const task of tasks || []) {
    if (!isResolvedWorkTask(task) || !task?.instructionDocId) continue;
    doneDocIds.add(String(task.instructionDocId));
    const doneDoc = resolveDocReference(task.instructionDocId);
    if (doneDoc?.path) doneHrefs.add(documentHref(doneDoc.path));
  }
  const refEntries = [];
  const seenRefs = new Set();
  const collectReferenceItem = (refName, refUrl, isProcessDoc = false, refDocId = "") => {
    if (!refUrl && !refName) return;
    const docPath = refUrl ? localDocPathFromHref(refUrl) : "";
    const href = docPath ? documentHref(docPath) : refUrl ? String(refUrl) : "";
    const dedupeKey = href || `label:${refName}`;
    if (seenRefs.has(dedupeKey)) return;
    seenRefs.add(dedupeKey);
    refEntries.push({
      name: refName,
      href,
      isProcessDoc: Boolean(docPath) || isProcessDoc,
      done: (refDocId && doneDocIds.has(String(refDocId))) ||
        (href ? doneHrefs.has(href) : false),
    });
  };
  const sourceDocIds = Array.isArray(card.sourceDocIds) ? card.sourceDocIds : [];
  for (const docId of sourceDocIds) {
    if (!docId) continue;
    const doc = resolveDocReference(docId);
    const docUrl = doc?.path || (localDocPathFromHref(docId) ? docId : "");
    const docLabel =
      doc?.title ||
      String(docId).split(".").pop()?.replace(/[-_]+/g, " ") ||
      String(docId);
    collectReferenceItem(docLabel, docUrl, true, String(docId));
  }
  const existingRefs = Array.isArray(card.references) ? card.references : [];
  for (const ref of existingRefs) {
    const refUrl = typeof ref === "string" ? ref : ref.url || ref.link || "";
    const refName =
      typeof ref === "string" ? ref : ref.name || ref.title || refUrl;
    if (!refUrl) continue;
    collectReferenceItem(refName, refUrl, false);
  }
  if (refEntries.length === 0) return null;

  const doneCount = refEntries.filter((entry) => entry.done).length;
  const refsExpanded = expanded ?? refEntries.length <= REFERENCES_VISIBLE_LIMIT;
  const refsSection = document.createElement("div");
  refsSection.className =
    "task-history workflow-detail-section workflow-references-section";
  const refsLabel = document.createElement("div");
  refsLabel.className = "task-history-label";
  refsLabel.textContent = "Process references";
  refsSection.append(refsLabel);
  const refsList = document.createElement("div");
  refsList.className = "task-history-list";
  const visible = refsExpanded ? refEntries : refEntries.slice(0, REFERENCES_VISIBLE_LIMIT);
  for (const entry of visible) {
    refsList.append(appendReferenceItem(entry));
  }
  refsSection.append(refsList);
  if (refEntries.length > REFERENCES_VISIBLE_LIMIT && typeof onToggle === "function") {
    const hiddenCount = refEntries.length - REFERENCES_VISIBLE_LIMIT;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "quiet-button workflow-references-toggle";
    toggle.setAttribute("aria-expanded", String(refsExpanded));
    toggle.textContent = refsExpanded
      ? "Show fewer"
      : `Show all ${refEntries.length} references${doneCount ? ` (${doneCount} done)` : ""}`;
    toggle.setAttribute(
      "aria-label",
      refsExpanded
        ? "Show fewer process references"
        : `Show all ${refEntries.length} process references (${hiddenCount} more${doneCount ? `, ${doneCount} done` : ""})`,
    );
    toggle.addEventListener("click", () => onToggle(!refsExpanded));
    refsSection.append(toggle);
  }
  return refsSection;
}
