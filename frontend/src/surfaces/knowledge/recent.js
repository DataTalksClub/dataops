// Process Docs › Recently changed: the documents edited most recently, newest
// first, read from the knowledge store's publication history
// (GET /knowledge/recent). One row per document; repeat edits collapse into
// a count. The row opens the document; History opens its version history.
import { documentHref } from "../../core/links.js";

export const RECENT_DOCS_LIMIT = 50;
// Re-rendering the surface reuses an answer this fresh instead of refetching.
const RECENT_DOCS_FRESH_MS = 30_000;

const OPERATION_LABELS = Object.freeze({
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
  rename: "Renamed",
  restore: "Restored",
  import: "Imported",
});

export function recentOperationLabel(operation) {
  return OPERATION_LABELS[operation] || "Changed";
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// "Today", "Yesterday", then a short weekday date ("Mon 12 Oct", with the
// year only when it is not the current one).
export function recentDayLabel(time, now = new Date()) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function recentTimeLabel(time) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Rows grouped under their day label, keeping the newest-first order.
export function groupRecentChanges(changes, now = new Date()) {
  const groups = [];
  for (const change of changes || []) {
    const label = recentDayLabel(change.time, now);
    let group = groups.at(-1);
    if (!group || group.label !== label) {
      group = { label, changes: [] };
      groups.push(group);
    }
    group.changes.push(change);
  }
  return groups;
}

export function createRecentDocsView(context) {
  const { apiUrl, request, openDocument, openHistory, titleForPath } = context;
  const documentRef = context.documentRef || globalThis.document;
  const now = context.now || (() => new Date());
  const state = { status: "idle", data: null, error: "", generation: 0, loadedAt: 0 };

  function el(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The section on screen; a load that finishes fills whichever one is current.
  let current = null;

  async function load() {
    const generation = ++state.generation;
    state.status = "loading";
    try {
      const url = apiUrl("/knowledge/recent");
      url.searchParams.set("limit", String(RECENT_DOCS_LIMIT));
      const data = await request(url);
      if (generation !== state.generation) return;
      if (!Array.isArray(data?.changes)) throw new Error("Recent changes response is incomplete");
      state.data = data;
      state.status = "loaded";
      state.loadedAt = Date.now();
      state.error = "";
    } catch (error) {
      if (generation !== state.generation) return;
      state.status = "error";
      state.error = error?.message || "Request failed";
    }
    if (current) fill(current);
  }

  function renderRow(change) {
    const row = el("li", "ops-recent-doc");
    row.dataset.path = change.path;
    const title = titleForPath(change.path) || change.path.split("/").pop();
    const meta = el("span", "ops-recent-doc__meta");
    const parts = [recentOperationLabel(change.operation), change.actorName || change.actor];
    if (change.changes > 1) parts.push(`${change.changes} edits`);
    meta.textContent = parts.join(" · ");
    // The whole title-and-byline block is the link, one comfortable target.
    let main;
    if (change.deleted) {
      main = el("div", "ops-recent-doc__main");
      main.append(el("span", "ops-recent-doc__title is-deleted", title), meta);
    } else {
      main = el("a", "ops-recent-doc__main");
      main.href = documentHref(change.path);
      main.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
        event.preventDefault();
        openDocument(change.path);
      });
      main.append(el("span", "ops-recent-doc__title", title), meta);
    }
    main.title = change.path;

    const side = el("div", "ops-recent-doc__side");
    const time = el("time", "ops-recent-doc__time dk-mono", recentTimeLabel(change.time));
    time.dateTime = change.time;
    time.title = new Date(change.time).toLocaleString();
    const history = el("button", "dk-button dk-button--secondary dk-button--sm ops-recent-doc__history", "History");
    history.type = "button";
    history.setAttribute("aria-label", `Version history of ${title}`);
    history.addEventListener("click", () => openHistory(change.path));
    side.append(time, history);
    row.append(main, side);
    return row;
  }

  function fill(container) {
    container.setAttribute("aria-busy", state.status === "loading" ? "true" : "false");
    if (state.status === "loading" && !state.data) {
      container.replaceChildren(el("p", "ops-recent-docs__status", "Loading recent changes…"));
      return;
    }
    if (state.status === "error") {
      const callout = el("div", "dk-callout dk-callout--danger ops-recent-docs__error");
      callout.setAttribute("role", "alert");
      const body = el("div", "dk-callout__body");
      body.append(
        el("p", "dk-callout__title", "Recent changes are unavailable"),
        el("p", "", state.error),
      );
      const retry = el("button", "dk-button dk-button--secondary dk-button--sm", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => {
        load();
        fill(container);
      });
      const actions = el("div", "dk-callout__actions");
      actions.append(retry);
      callout.append(body, actions);
      container.replaceChildren(callout);
      return;
    }
    const changes = state.data?.changes || [];
    if (changes.length === 0) {
      const empty = el("div", "dk-empty dk-empty--compact");
      empty.append(el("p", "dk-empty__title", "No changes yet"), el("p", "dk-empty__desc", "Edits to process docs appear here once they are published."));
      container.replaceChildren(empty);
      return;
    }
    const nodes = [];
    for (const group of groupRecentChanges(changes, now())) {
      const section = el("section", "ops-recent-docs__day");
      const heading = el("h3", "ops-recent-docs__day-label", group.label);
      const list = el("ul", "ops-recent-docs__list");
      for (const change of group.changes) list.append(renderRow(change));
      section.append(heading, list);
      nodes.push(section);
    }
    container.replaceChildren(...nodes);
  }

  // Renders the section; the list fills in from the cached answer at once
  // and refreshes in the background, so returning to the tab never blanks it.
  function renderRecentDocs() {
    const container = el("div", "ops-recent-docs");
    container.setAttribute("aria-label", "Recently changed process docs");
    container.setAttribute("role", "region");
    const fresh = state.status === "loaded" && Date.now() - state.loadedAt < RECENT_DOCS_FRESH_MS;
    current = container;
    if (!fresh && state.status !== "loading") load();
    fill(container);
    return container;
  }

  return { renderRecentDocs };
}
