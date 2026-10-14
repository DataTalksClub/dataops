// Podcast: the episode register as a list–detail split (dakit
// docs/list-detail.md). The list holds what's in flight first, then each
// season; the detail is the selected episode, addressed by /podcast/<id> so
// it can be linked, reloaded and reached with Back on a phone.
import {
  createCollectionCreateButton, createCollectionHeader, createPageHeader,
} from "../operations-overview.js";
import { openCreateEpisodeDialog } from "./create-dialog.js";
import { renderEpisodeDetail } from "./detail.js";
import { element, emptyState, formatDate, select, statusChip } from "./dom.js";
import {
  episodeCode, episodeKeyDate, episodeSummary, filterEpisodes, groupEpisodes,
  matchesStatusFilter, seasonsOf, STATUS_FILTERS,
} from "./model.js";

const enc = encodeURIComponent;

export function createPodcastSurface(context) {
  const {
    apiUrl,
    documentList,
    documentRef = globalThis.document,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    navigateCanonicalWorkspace,
    request,
    setRouteTitle,
    getDialogs = () => globalThis.dakitDialogs,
    getSplit = () => globalThis.dakitSplit,
  } = context;

  const state = {
    loaded: false,
    error: "",
    episodes: [],
    filter: "upcoming",
    season: "",
    query: "",
    editingId: "",
    notice: null,
  };
  let inFlight = null;
  let listScrollTop = 0;

  function routeEpisodeId() {
    return getActiveWorkspaceRoute()?.params?.get("episodeId") || "";
  }

  function isActive() {
    return getActiveWorkspaceView() === "podcast";
  }

  // One load at a time; whoever started it re-renders when it lands, so a
  // route's render and its hydration never paint the page twice.
  async function refreshPodcastEpisodes(options = {}) {
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      try {
        const payload = await request(apiUrl("/api/podcast-episodes"));
        state.episodes = Array.isArray(payload?.items) ? payload.items : [];
        state.loaded = true;
        state.error = "";
      } catch (error) {
        state.error = error?.message || "Podcast episodes could not be loaded.";
      }
    })();
    await inFlight;
    inFlight = null;
    if (options.rerender !== false && isActive()) renderPodcastSurface();
  }

  function replaceEpisode(next) {
    const index = state.episodes.findIndex((episode) => episode.id === next.id);
    if (index >= 0) state.episodes[index] = next;
    else state.episodes.unshift(next);
  }

  // A PUT answers with the episode alone; keep the Card summary it had
  // unless the link itself changed.
  function mergeSaved(previous, saved) {
    const { cardSync, ...episode } = saved;
    const card = episode.cardId && episode.cardId === previous.cardId ? previous.card : null;
    return { episode: { ...episode, card }, cardSync };
  }

  const actions = {
    back() {
      state.editingId = "";
      navigateCanonicalWorkspace("/podcast", {}, { restoreFocus: { kind: "split-list" } });
    },
    edit(episode) {
      state.editingId = episode.id;
      state.notice = null;
      renderPodcastSurface({ focusDetail: true });
    },
    cancelEdit() {
      state.editingId = "";
      renderPodcastSurface({ focusDetail: true });
    },
    async update(episode, changes) {
      const saved = await request(apiUrl(`/api/podcast-episodes/${enc(episode.id)}`), {
        method: "PUT",
        body: JSON.stringify({ ...changes, version: episode.version }),
      });
      const merged = mergeSaved(episode, saved);
      replaceEpisode(merged.episode);
      state.editingId = "";
      state.notice = merged.cardSync === "failed"
        ? "Saved. The linked Card did not take the new date or guests; update the Card by hand."
        : changes.status && Object.keys(changes).length === 1
          ? `Marked ${merged.episode.status}.`
          : "Episode saved.";
      renderPodcastSurface({ focusDetail: true });
    },
    async createCard(episode) {
      const result = await request(apiUrl(`/api/podcast-episodes/${enc(episode.id)}/card`), {
        method: "POST",
        body: JSON.stringify({ version: episode.version }),
      });
      replaceEpisode({ ...result.episode, card: result.card });
      state.notice = `Created Card “${result.card?.title || "Podcast"}”.`;
      renderPodcastSurface({ focusDetail: true });
    },
    async reload(id) {
      state.editingId = "";
      state.notice = null;
      try {
        const episode = await request(apiUrl(`/api/podcast-episodes/${enc(id)}`));
        replaceEpisode(episode);
      } catch (error) {
        if (error?.status !== 404) state.error = error?.message || "Episode could not be reloaded.";
        else state.episodes = state.episodes.filter((episode) => episode.id !== id);
      }
      renderPodcastSurface({ focusDetail: true });
    },
    openCard(cardId) {
      navigateCanonicalWorkspace("/cards", { cardId });
    },
  };

  function openCreate(trigger) {
    return openCreateEpisodeDialog({
      documentRef,
      trigger,
      dialogs: getDialogs(),
      load: async (signal) => {
        const payload = await request(apiUrl("/api/podcast-episodes"), signal ? { signal } : {});
        return Array.isArray(payload?.items) ? payload.items : [];
      },
      create: (body) => request(apiUrl("/api/podcast-episodes"), { method: "POST", body: JSON.stringify(body) }),
      onCreated(created) {
        replaceEpisode({ ...created, card: null });
        if (!matchesStatusFilter(created, state.filter)) state.filter = "all";
        state.season = "";
        state.query = "";
        state.notice = "Episode created.";
        navigateCanonicalWorkspace(`/podcast/${enc(created.id)}`);
      },
    });
  }

  function createButton(label = "New episode", options = {}) {
    const control = createCollectionCreateButton({
      label,
      documentRef,
      ...options,
      onClick: (event) => openCreate(event?.currentTarget || control),
    });
    return control;
  }

  function selectEpisode(id) {
    state.editingId = "";
    state.notice = null;
    navigateCanonicalWorkspace(`/podcast/${enc(id)}`, {}, { render: false });
    renderPodcastSurface({ opened: true });
  }

  function renderFilters(tools) {
    const tabs = element(documentRef, "div", "dk-tabs dk-tabs--sm podcast-status-filter");
    tabs.setAttribute("role", "radiogroup");
    tabs.setAttribute("aria-label", "Filter episodes by status");
    tabs.id = "podcast-status-filter";
    for (const [value, label] of STATUS_FILTERS) {
      const tab = element(documentRef, "button", "dk-tab", label);
      tab.type = "button";
      tab.setAttribute("role", "radio");
      tab.dataset.filter = value;
      const checked = value === state.filter;
      tab.setAttribute("aria-checked", String(checked));
      tab.tabIndex = checked ? 0 : -1;
      tab.addEventListener("click", () => {
        if (state.filter === value) return;
        state.filter = value;
        listScrollTop = 0;
        renderPodcastSurface({ focusFilter: value });
      });
      tabs.append(tab);
    }
    const seasons = seasonsOf(state.episodes);
    const season = select(
      documentRef,
      "season",
      [["", "All seasons"], ...seasons.map((value) => [String(value), `Season ${value}`])],
      state.season,
    );
    season.classList.add("podcast-season-filter");
    season.setAttribute("aria-label", "Filter episodes by season");
    season.addEventListener("change", () => {
      state.season = season.value;
      listScrollTop = 0;
      renderPodcastSurface();
    });
    const search = element(documentRef, "input", "dk-input podcast-search");
    search.type = "search";
    search.name = "podcast-search";
    search.placeholder = "Search guest or title";
    search.setAttribute("aria-label", "Search episodes by guest or title");
    search.value = state.query;
    search.addEventListener("input", () => {
      state.query = search.value;
      listScrollTop = 0;
      renderPodcastSurface({ focusSearch: true });
    });
    const row = element(documentRef, "div", "podcast-tools-row");
    row.append(season, search);
    tools.append(tabs, row);
  }

  function renderRow(episode, selectedId) {
    const item = element(documentRef, "li");
    const row = element(documentRef, "a", "dk-split__item podcast-row");
    row.href = `/podcast/${enc(episode.id)}`;
    row.dataset.episodeId = episode.id;
    if (episode.id === selectedId) row.setAttribute("aria-current", "true");
    const name = element(documentRef, "span", "dk-split__name");
    const code = episodeCode(episode);
    if (code) name.append(element(documentRef, "span", "dk-mono podcast-row__code", code));
    name.append(element(documentRef, "span", "podcast-row__summary", episodeSummary(episode)));
    const meta = element(documentRef, "span", "dk-split__meta");
    meta.append(statusChip(documentRef, episode.status));
    const date = episodeKeyDate(episode);
    if (date.value) {
      const when = element(documentRef, "span", "podcast-row__date");
      when.append(
        element(documentRef, "span", "", date.kind === "recording" ? "Rec" : "Out"),
        element(documentRef, "span", "dk-mono", formatDate(date.value)),
      );
      when.title = `${date.kind === "recording" ? "Recording" : "Release"} date ${date.value}`;
      meta.append(when);
    }
    row.append(name, meta);
    row.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
      event.preventDefault();
      selectEpisode(episode.id);
    });
    item.append(row);
    return item;
  }

  function renderList(selectedId) {
    const pane = element(documentRef, "section", "dk-split__list podcast-list");
    pane.setAttribute("aria-labelledby", "podcast-episodes-title");
    const header = createCollectionHeader({
      title: "Episodes",
      titleId: "podcast-episodes-title",
      className: "dk-split__head podcast-list-head",
      create: createButton(),
      documentRef,
    });
    header.querySelector("h2")?.classList.add("dk-split__title");
    pane.append(header);
    const tools = element(documentRef, "div", "dk-split__tools podcast-tools");
    renderFilters(tools);
    pane.append(tools);
    const scroll = element(documentRef, "div", "dk-split__scroll podcast-list-scroll");
    const shown = filterEpisodes(state.episodes, { status: state.filter, season: state.season, query: state.query });
    if (!shown.length) {
      const filtered = state.query || state.season || state.filter === "published";
      const empty = filtered
        ? emptyState(documentRef, "No matches", "Try another season, status or search.")
        : emptyState(documentRef, "Nothing upcoming", "Every booked episode is out. Book the next guest with New episode.");
      empty.classList.add("dk-empty--compact");
      scroll.append(empty);
    }
    for (const group of groupEpisodes(shown)) {
      const section = element(documentRef, "section", "podcast-group");
      section.dataset.group = group.id;
      const label = element(documentRef, "h3", "podcast-group__label", group.label);
      label.id = `podcast-group-${group.id}`;
      const list = element(documentRef, "ul", "dk-split__items");
      list.setAttribute("aria-labelledby", label.id);
      for (const episode of group.episodes) list.append(renderRow(episode, selectedId));
      section.append(label, list);
      scroll.append(section);
    }
    scroll.addEventListener("scroll", () => {
      listScrollTop = scroll.scrollTop;
    });
    pane.append(scroll, element(documentRef, "div", "dk-split__handle"));
    return { pane, scroll };
  }

  function renderUnavailable(root) {
    const retry = element(documentRef, "button", "dk-button dk-button--secondary dk-button--sm", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => {
      state.error = "";
      renderPodcastSurface();
      refreshPodcastEpisodes();
    });
    const callout = element(documentRef, "div", "dk-callout dk-callout--danger podcast-unavailable");
    callout.setAttribute("role", "alert");
    const body = element(documentRef, "div", "dk-callout__body");
    body.append(
      element(documentRef, "p", "dk-callout__title", "Podcast episodes are unavailable"),
      element(documentRef, "p", "", state.error),
    );
    const buttons = element(documentRef, "div", "dk-callout__actions");
    buttons.append(retry);
    callout.append(body, buttons);
    root.append(callout);
  }

  function renderEmptyRegister(root) {
    const panel = element(documentRef, "section", "podcast-empty-register");
    panel.setAttribute("aria-labelledby", "podcast-episodes-title");
    panel.append(createCollectionHeader({
      title: "Episodes",
      titleId: "podcast-episodes-title",
      create: createButton(),
      documentRef,
    }));
    panel.append(emptyState(
      documentRef,
      "No episodes yet",
      "Each episode tracks a guest from booking to publication, with its links and the Card that runs it.",
      [createButton("Create the first episode", { variant: "secondary", shortcut: false })],
    ));
    root.append(panel);
  }

  function renderPodcastSurface(options = {}) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    documentList.classList.add("is-podcast-surface");
    setRouteTitle("Podcast");
    if (!state.loaded && !state.error && !inFlight) refreshPodcastEpisodes();

    const root = element(documentRef, "div", "podcast-surface dk-fill");
    root.append(createPageHeader({ title: "Podcast", className: "podcast-header", documentRef }));
    if (state.error && !state.loaded) {
      renderUnavailable(root);
      documentList.replaceChildren(root);
      return;
    }
    if (!state.loaded) {
      const loading = element(documentRef, "div", "podcast-loading");
      loading.setAttribute("role", "status");
      loading.append(element(documentRef, "span", "dk-spinner"), element(documentRef, "span", "", "Loading episodes…"));
      root.append(loading);
      documentList.replaceChildren(root);
      return;
    }
    if (!state.episodes.length && !routeEpisodeId()) {
      renderEmptyRegister(root);
      documentList.replaceChildren(root);
      return;
    }
    if (state.error) renderUnavailable(root);

    const routeId = routeEpisodeId();
    const selected = routeId ? state.episodes.find((episode) => episode.id === routeId) || null : null;
    if (state.editingId && state.editingId !== selected?.id) state.editingId = "";
    const split = element(documentRef, "div", "dk-split podcast-split");
    split.dataset.dkSplit = "podcast";
    split.dataset.view = routeId ? "detail" : "list";
    const { pane: list, scroll } = renderList(selected?.id || "");
    const detail = element(documentRef, "section", "dk-split__detail podcast-detail-pane");
    detail.setAttribute("aria-label", "Selected episode");
    renderEpisodeDetail(detail, {
      documentRef,
      episode: selected,
      editing: Boolean(selected && state.editingId === selected.id),
      notice: selected ? state.notice : null,
      missingId: routeId && !selected ? routeId : "",
      actions,
    });
    state.notice = null;
    split.append(list, detail);
    root.append(split);
    documentList.replaceChildren(root);
    scroll.scrollTop = listScrollTop;

    const kit = getSplit();
    if (options.opened) kit?.show?.(split, "detail");
    else if (options.focusDetail) {
      (detail.querySelector("[data-dk-autofocus]") || detail.querySelector(".dk-split__title"))?.focus?.({ preventScroll: true });
    }
    if (options.focusSearch) {
      const search = root.querySelector(".podcast-search");
      search?.focus?.();
      search?.setSelectionRange?.(state.query.length, state.query.length);
    }
    if (options.focusFilter) {
      root.querySelector(`.podcast-status-filter [data-filter="${options.focusFilter}"]`)?.focus?.();
    }
  }

  return { refreshPodcastEpisodes, renderPodcastSurface };
}
