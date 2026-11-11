// The Templates list pane: search, trigger groups, and rows.
//
// Search text, collapsed groups, and the scroll offset persist here across
// rerenders (selection, refresh), so the list never resets under the
// operator. No URL param: the filter is transient operator state, not a
// shareable route.
//
// Data (ranking, facts, row DOM) stays with the Templates surface; this
// controller owns only the list chrome and its transient state. The surface
// passes:
// - ordered: the already-ranked template array for this render,
// - loaded/error: the fetch state,
// - renderRow(template): the row button (selection baked in by the surface),
// - triggerLabel(triggerType): the chip/group label,
// - renderHonestState(title, detail): the quiet empty/error block.
export function createTemplateListController(context) {
  const { renderHonestState, renderRow, triggerLabel } = context;

  let listSearch = "";
  let listScrollTop = 0;
  let listElement = null;
  const collapsedGroups = new Set();

  // triggerType is the facet that actually varies across Templates. Seed
  // evidence: synthetic fixtures carry tags: [] and a single shared
  // department, while trigger.mode is the field the backend reads ("manual"
  // default in yamlTemplates, "automatic" scanned by the cron runner).
  // Unknown modes keep their own group instead of merging.
  const TRIGGER_GROUP_ORDER = ["manual", "scheduled", "recurring", "event"];

  function triggerGroupKey(template) {
    return String(template.triggerType || "manual").toLowerCase();
  }

  function groupedTemplates(templates) {
    const groups = new Map();
    for (const template of templates) {
      const key = triggerGroupKey(template);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(template);
    }
    // Canonical trigger order first, then any backend-only modes (e.g.
    // "automatic") alphabetically. Within a group the caller passes the
    // already-ranked order through untouched.
    const rank = new Map(TRIGGER_GROUP_ORDER.map((key, index) => [key, index]));
    return [...groups.entries()].sort((left, right) => (
      (rank.get(left[0]) ?? TRIGGER_GROUP_ORDER.length)
      - (rank.get(right[0]) ?? TRIGGER_GROUP_ORDER.length)
      || triggerLabel(left[0]).localeCompare(triggerLabel(right[0]))
    ));
  }

  function templateHaystack(template) {
    return [
      template.name || "",
      template.id || "",
      template.type || "",
      triggerLabel(template.triggerType),
      ...((Array.isArray(template.tags) ? template.tags : []).map(String)),
    ].join(" ").toLowerCase();
  }

  // Every whitespace-separated term must match somewhere: name, id, type,
  // tags, or the trigger label. Local substring filter, no debounce needed.
  function filteredTemplates(ordered) {
    const terms = listSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return ordered;
    return ordered.filter((template) => {
      const haystack = templateHaystack(template);
      return terms.every((term) => haystack.includes(term));
    });
  }

  // "N of M" while a filter narrows the list, "M" otherwise; silent until
  // loaded so the count never states a stale total.
  function templateCountLabel(ordered, loaded, error) {
    if (!loaded || error) return "";
    if (!listSearch.trim()) return String(ordered.length);
    return `${filteredTemplates(ordered).length} of ${ordered.length}`;
  }

  // Group headers are buttons (collapsible, aria-expanded) wrapping the
  // group's rows in a hidden-toggled container: toggling never rebuilds rows,
  // so selection and scroll offset survive it.
  function renderTemplateGroup(key, group, open) {
    const header = document.createElement("button");
    header.type = "button";
    header.className = "runtime-template-group-header";
    header.setAttribute("aria-expanded", String(open));
    header.setAttribute("aria-controls", `runtime-template-group-${key}-rows`);
    const name = document.createElement("span");
    name.className = "runtime-template-group-name";
    name.textContent = triggerLabel(key);
    const tally = document.createElement("span");
    tally.className = "runtime-template-group-count dk-mono";
    tally.textContent = String(group.length);
    tally.setAttribute("role", "status");
    header.append(name, tally);
    const rows = document.createElement("div");
    rows.className = "runtime-template-group-rows";
    rows.id = `runtime-template-group-${key}-rows`;
    rows.hidden = !open;
    header.addEventListener("click", () => {
      const hide = !rows.hidden;
      rows.hidden = hide;
      header.setAttribute("aria-expanded", String(!hide));
      if (hide) collapsedGroups.add(key);
      else collapsedGroups.delete(key);
    });
    for (const template of group) rows.append(renderRow(template));
    return [header, rows];
  }

  function renderTemplateRows(list, { ordered, loaded, error, onClearSearch }) {
    const searching = Boolean(listSearch.trim());
    const templates = loaded && !error ? filteredTemplates(ordered) : [];
    list.replaceChildren();
    if (error) {
      list.append(renderHonestState("Runtime templates unavailable", error));
    } else if (!loaded) {
      const loading = document.createElement("p");
      loading.className = "runtime-template-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading templates…";
      list.append(loading);
    } else if (!templates.length && !searching) {
      list.append(renderHonestState(
        "No Authored templates",
        "The deployment has not published any Templates yet.",
      ));
    } else {
      if (!templates.length) {
        const empty = renderHonestState(
          "No templates match",
          `No templates match \u201C${listSearch.trim()}\u201D.`,
        );
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "task-action-btn runtime-template-empty-clear";
        clear.textContent = "Clear search";
        clear.addEventListener("click", () => onClearSearch?.());
        empty.append(clear);
        list.append(empty);
      }
      // A search narrows across groups, so collapsed groups open while a
      // query is active; clearing the query restores the persisted set.
      for (const [key, group] of groupedTemplates(templates)) {
        const [header, rows] = renderTemplateGroup(
          key,
          group,
          searching || !collapsedGroups.has(key),
        );
        list.append(header, rows);
      }
    }
    // The list element is recreated on every surface render; without this a
    // selection made at the bottom jumps the scroll back to the top.
    list.scrollTop = listScrollTop;
  }

  // The pane is built detached and attached by the surface afterwards; a
  // detached element ignores scrollTop, so the offset is restored again once
  // the list is in the document (next frame, or a microtask without rAF).
  function restoreScrollWhenAttached(list) {
    const restore = () => {
      if (listElement === list && list.isConnected) list.scrollTop = listScrollTop;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else queueMicrotask(restore);
  }

  function renderListPane({ ordered, loaded, error }) {
    const pane = document.createElement("section");
    pane.className = "dk-split__list";
    pane.setAttribute("aria-labelledby", "runtime-templates-title");
    const head = document.createElement("header");
    head.className = "dk-split__head";
    const title = document.createElement("h2");
    title.className = "dk-split__title";
    title.id = "runtime-templates-title";
    title.textContent = "Authored templates";
    head.append(title);
    const count = document.createElement("span");
    count.className = "dk-split__count";
    count.setAttribute("role", "status");
    head.append(count);
    // The search row lives outside the scroll region it filters, so
    // per-keystroke list updates never rebuild the input or steal focus.
    const search = document.createElement("div");
    search.className = "runtime-template-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "dk-input runtime-template-search-input";
    searchInput.placeholder = "Search templates…";
    searchInput.setAttribute("aria-label", "Search templates");
    searchInput.autocomplete = "off";
    searchInput.value = listSearch;
    const searchClear = document.createElement("button");
    searchClear.type = "button";
    searchClear.className = "dk-button runtime-template-search-clear";
    searchClear.textContent = "Clear";
    searchClear.setAttribute("aria-label", "Clear search");
    search.append(searchInput, searchClear);
    const list = document.createElement("div");
    list.className = "dk-split__scroll";
    list.addEventListener("scroll", () => {
      listScrollTop = list.scrollTop || 0;
    }, { passive: true });
    listElement = list;
    // Targeted update: refresh the count and the scroll region only. The
    // search input (and its focus/caret) is never rebuilt by typing.
    const refreshList = () => {
      searchClear.hidden = !listSearch;
      count.textContent = templateCountLabel(ordered, loaded, error);
      renderTemplateRows(list, { ordered, loaded, error, onClearSearch: clearTemplateSearch });
    };
    const clearTemplateSearch = () => {
      listSearch = "";
      searchInput.value = "";
      refreshList();
      searchInput.focus();
    };
    searchInput.addEventListener("input", () => {
      listSearch = searchInput.value;
      refreshList();
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && searchInput.value) {
        event.preventDefault();
        clearTemplateSearch();
      }
    });
    searchClear.addEventListener("click", () => clearTemplateSearch());
    refreshList();
    pane.append(head, search, list);
    restoreScrollWhenAttached(list);
    return pane;
  }

  // A row click navigates (full surface rerender); capture the offset first
  // so the rebuilt list restores it.
  function saveScroll() {
    if (listElement) listScrollTop = listElement.scrollTop || 0;
  }

  return { renderListPane, saveScroll };
}
