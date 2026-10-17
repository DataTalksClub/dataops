import { sponsorRecordPath, sponsorsPath } from "../../core/sponsor-routes.js";
import { createSponsorPipelineLifecycle, wireSavedViewsDialog } from "./sponsor-pipeline-lifecycle.js";
import {
  defaultViewForEntity,
  fetchViews,
  isBuiltinView,
  renderSavedViewBar,
  resolveEffectiveFilters,
  updateSavedView,
} from "./sponsor-saved-views.js";
import {
  companyPickerOptions,
  directoryDefaults,
  directoryQueryFromState,
  directoryStateFromUrl,
  directoryUrl,
  renderCompanyRow,
  renderDirectoryEmpty,
  renderDirectoryError,
  renderDirectoryPagination,
  renderDirectoryStatus,
  renderPersonRow,
} from "./sponsor-directory.js";

// Package E directory pages: bounded Companies/People directories, pipeline
// URL/filter/saved-view lifecycle, saved-view dialogs, the add-person dialog
// wiring, person-record interim pane, record Back context and the read-only
// archive loader for F's Activity disclosure. Wired into sponsors.js; the
// surface keeps lifecycle, pipeline list instance, records and money.

// Paths are scope-relative: the surface api() already prefixes
// /api/sponsor-crm (see DEFAULT_WORKSPACE_PATHS for the full contract).
const WORKSPACE_API = {
  views: "/views",
  companies: "/directory/companies",
  people: "/directory/people",
};

// Sort for saving: the resolved sort already carries its direction
// (preserved end-to-end from the view); control strings fall back to field
// defaults so a manual sort pick never invents a direction.
function sortForSave(sort) {
  if (sort && typeof sort === "object" && sort.field) {
    return { field: sort.field, direction: sort.direction === "desc" ? "desc" : "asc" };
  }
  const field = typeof sort === "string" && sort ? sort : "name";
  return { field, direction: field === "lastTouch" ? "desc" : "asc" };
}

export function createSponsorDirectoryPages({
  api,
  surface,
  escapeHtml,
  humanSponsorDate,
  safe,
  openDialog,
  navigateCanonicalWorkspace,
  openContactEditor,
  reloadPipeline,
  showView,
  getCurrentView,
  showTab,
  getDeals,
  setDeals,
  getOrganizations,
  setOrganizations,
  ensureOwnerDirectory,
  reopenDealDetail,
  reopenCompanyDetail,
  personDetail,
  renderEntityLoadState,
  isStale,
}) {
  const activeView = () => (typeof getCurrentView === "function" ? getCurrentView() : null);
  // Navigation generation: record opens bump it so a delayed list response
  // can never overwrite rows or the URL of the record the operator opened.
  let navGeneration = 0;
  const messageEl = () => surface.querySelector("[data-crm-message]");
  function showNotice(text) {
    const message = messageEl();
    if (!message) return;
    message.textContent = text || "";
    message.hidden = !text;
  }

  // Company display names seen in bounded pages, for picker options and
  // off-page selections. Display hints only; every list reads the API.
  const companyNames = new Map();
  function rememberCompanyNames(items) {
    for (const item of items || []) {
      if (item?.id && item.displayName) companyNames.set(item.id, item.displayName);
      if (item?.organizationId && item.companyName) companyNames.set(item.organizationId, item.companyName);
    }
  }
  async function fetchCompanyOptions({ search = "", limit = 20 } = {}) {
    const query = new URLSearchParams({ active: "true", limit: String(limit), sort: "name" });
    if (search) query.set("search", search);
    const result = await api(`${WORKSPACE_API.companies}?${query}`);
    // Both shapes: directory pickers read .name, the contact editor reads
    // .displayName (F contract).
    const options = (result.items || []).map((item) => ({ id: item.id, name: item.displayName, displayName: item.displayName }));
    rememberCompanyNames(result.items);
    return options;
  }

  // Last-written list params per tab, seeded by the host from the route.
  // Record-id path params never belong to list context and are stripped so
  // Back lands on the clean list URL with its filters.
  const RECORD_ID_PARAMS = ["dealId", "companyId", "personId", "leadId", "newsletterId"];
  const listParamsByView = { pipeline: {}, companies: {}, people: {} };
  function seedListParams(view, params) {
    if (!listParamsByView[view]) return;
    const clean = { ...(params || {}) };
    for (const key of RECORD_ID_PARAMS) delete clean[key];
    listParamsByView[view] = clean;
  }
  function rememberListParams(view, params) {
    listParamsByView[view] = { ...(params || {}) };
  }

  // Return context for record Back: origin tab path + params, scroll and the
  // originating link. E-owned; F closeRecord consumes it once record modules
  // land. listPath keeps returning the origin path for the current detail.
  // openRecordRef tracks the currently displayed record for record-scoped
  // save refreshes (contact reassociation must not jump to a new company).
  let returnContext = null;
  let openRecordRef = null;
  const listPath = (fallbackView) => returnContext?.path || sponsorsPath(fallbackView);
  function listScrollTarget(view) {
    const inner = surface.querySelector("[data-crm-list-scroll]");
    const layout = surface.querySelector(".crm-layout");
    if (view === "pipeline" && inner && (!layout || !layout.hidden)) {
      const overflowY = typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(inner).overflowY
        : "auto";
      if (overflowY === "auto" || overflowY === "scroll") return inner;
    }
    const main = surface.closest?.("#main-content, .dk-main")
      || globalThis.document?.getElementById?.("main-content")
      || globalThis.document?.querySelector?.(".dk-main")
      || globalThis.document?.scrollingElement;
    return main || inner || null;
  }
  function captureReturnContext(kind, id, currentView) {
    navGeneration += 1;
    const resolvedView = currentView === "pipeline" || currentView === "companies" || currentView === "people" ? currentView : "pipeline";
    const scroller = listScrollTarget(resolvedView);
    returnContext = {
      view: resolvedView,
      path: sponsorsPath(resolvedView),
      params: { ...(listParamsByView[currentView] || {}) },
      scrollTop: scroller ? scroller.scrollTop : (globalThis.window?.scrollY || 0),
      focusSelector: kind === "deal" ? `[data-open-deal="${id}"]`
        : kind === "company" ? `[data-open-company="${id}"]`
        : `[data-open-person="${id}"]`,
    };
  }
  // One page-owned save context for BOTH deal-save and F's contact-submit
  // hook: captured synchronously at submit, checked across every await. A
  // newer record open, Back/close, same-tab record->list, a tab/list click or
  // an actual navigation invalidates it. stale() only covers
  // render/surface/CRM — it is NOT a selected-record guard. The record
  // snapshot is gated by detail state: a list-owned save never carries a
  // stale record even if a ref somehow survived a transition.
  function captureSaveContext() {
    const detail = surface.classList.contains("has-booking-detail");
    return {
      nav: navGeneration,
      open: openGeneration,
      view: typeof getCurrentView === "function" ? getCurrentView() : null,
      detail,
      record: detail && openRecordRef ? { ...openRecordRef } : null,
    };
  }
  function saveContextOwnsSurface(saveContext) {
    return Boolean(saveContext) &&
      saveContext.nav === navGeneration &&
      saveContext.open === openGeneration &&
      saveContext.view === (typeof getCurrentView === "function" ? getCurrentView() : null) &&
      saveContext.detail === surface.classList.contains("has-booking-detail") &&
      !isStale();
  }
  // Per-invocation page predicate for F record/finance guards: captured at
  // the open/save call, false after any later tab/list transition, record
  // open, Back/close or workspace navigation. Never recaptured after the
  // response — the predicate closes over the invoking generation.
  function capturePageCurrent() {
    const nav = navGeneration;
    const open = openGeneration;
    return () => nav === navGeneration && open === openGeneration && !isStale();
  }
  // Per-invocation pipeline/directory list ownership predicates: captured at
  // init/saved-view/load start, invalidated by any tab transition (including
  // away-and-back or same-tab), record open, Back/close, workspace leave, or a
  // newer same-tab filter/view/pagination user intent.
  let pipelineIntent = 0;
  const dirIntent = { companies: 0, people: 0 };
  function notePipelineIntent() {
    pipelineIntent += 1;
  }
  function noteDirectoryIntent(entity) {
    if (entity in dirIntent) dirIntent[entity] += 1;
  }
  function captureSurfaceCurrent(view) {
    const nav = navGeneration;
    const open = openGeneration;
    return () =>
      nav === navGeneration &&
      open === openGeneration &&
      activeView() === view &&
      !surface.classList.contains("has-booking-detail") &&
      surface.isConnected &&
      !isStale();
  }
  function capturePipelineCurrent() {
    const isSurface = captureSurfaceCurrent("pipeline");
    const intent = pipelineIntent;
    return () => isSurface() && intent === pipelineIntent;
  }
  function captureDirectoryCurrent(entity) {
    const isSurface = captureSurfaceCurrent(entity);
    const intent = dirIntent[entity];
    return () => isSurface() && intent === dirIntent[entity];
  }
  // Every user CRM tab/list transition (including same-tab clicks) advances
  // the page-owned generation and drops the record ref, so in-flight saves
  // and stale record opens can never refresh/reopen over the newly shown
  // tab — and a later list-owned save can never resurrect the prior record.
  // The open flow's own setRecordTab is suppressed: it is part of the open,
  // not a transition away from it.
  let suppressTransitionNote = false;
  function noteTabTransition() {
    if (suppressTransitionNote) return;
    navGeneration += 1;
    openGeneration += 1;
    pipelineIntent += 1;
    dirIntent.companies += 1;
    dirIntent.people += 1;
    openRecordRef = null;
  }
  // Back restores the origin tab, then reloads the directory (records may
  // have archived/restored/edited behind it), and only then restores scroll
  // position and focus — refreshing first would replace the nodes out from
  // under the restored focus. Returns false when no origin was captured.
  async function closeRecord() {
    if (!returnContext) return false;
    const { view, path, params, scrollTop, focusSelector } = returnContext;
    returnContext = null;
    openRecordRef = null;
    // Back/close invalidates in-flight saves: a save that settles after this
    // must never refresh or reopen over the restored list.
    navGeneration += 1;
    openGeneration += 1;
    surface.classList.remove("has-booking-detail");
    const split = surface.querySelector("[data-crm-split]");
    if (split) {
      split.dataset.view = "list";
      globalThis.dakitSplit?.show(split, "list");
    }
    navigateCanonicalWorkspace(path, params, { render: false, history: "replace" });
    showView(view, false);
    const isCloseCurrent = view === "companies" || view === "people"
      ? captureDirectoryCurrent(view)
      : view === "pipeline"
        ? capturePipelineCurrent()
        : capturePageCurrent();
    if (view === "companies" || view === "people") {
      await safe(() => directories[view].restorePage(isCloseCurrent), "Could not load directory");
      if (!surface.isConnected || !isCloseCurrent()) return true;
    } else if (view === "pipeline") {
      if (!pipeline.views) await safe(() => pipeline.ensureViews(isCloseCurrent), "Could not load saved views");
      await safe(() => pipeline.load(false, { isCurrent: isCloseCurrent }), "Could not load pipeline");
      if (!surface.isConnected || !isCloseCurrent()) return true;
    }
    const scroller = listScrollTarget(view);
    if (scroller) scroller.scrollTop = scrollTop || 0;
    else if (typeof globalThis.scrollTo === "function") globalThis.scrollTo(0, scrollTop || 0);
    const focusEl = surface.querySelector(focusSelector);
    if (focusEl && typeof focusEl.focus === "function") {
      try {
        focusEl.focus({ preventScroll: true });
      } catch {
        focusEl.focus();
      }
    }
    return true;
  }

  function createDirectoryController(entity) {
    const root = surface.querySelector(`[data-dir-root="${entity}"]`);
    const rowsEl = root.querySelector("[data-dir-rows]");
    const statusEl = root.querySelector("[data-dir-status]");
    const pagesEl = root.querySelector("[data-dir-pages]");
    const inlineMessageEl = root.querySelector("[data-dir-message]");
    const viewsEl = root.querySelector("[data-dir-views]");
    const directoryPath = entity === "companies" ? WORKSPACE_API.companies : WORKSPACE_API.people;
    const state = {
      views: null,
      viewsError: null,
      selectedViewId: null,
      baseViewId: null,
      modified: false,
      filters: {},
      sort: "name",
      limit: directoryDefaults(entity).limit,
      cursor: null,
      prev: [],
      items: [],
      total: 0,
      nextCursor: null,
      lastResolved: null,
      requestToken: 0,
      initialized: false,
    };
    const controls = () => ({
      search: root.querySelector("[data-dir-search]"),
      sort: root.querySelector("[data-dir-sort]"),
      filters: [...root.querySelectorAll("[data-dir-filter]")],
    });
    function readControls() {
      const { search, sort, filters } = controls();
      // Every present control is represented, including cleared ones: an
      // explicitly emptied input unpins the view and deletes that filter
      // instead of silently restoring the saved base value.
      const collected = { search: search?.value || "" };
      for (const input of filters) {
        collected[input.dataset.dirFilter] = input.value || "";
      }
      // Always represent the selected sort field (including Name): omitting
      // it would let a stale base sort survive a deliberate manual change.
      collected.sort = sort?.value || "name";
      return collected;
    }
    function applyToControls(filters, sort) {
      const { search, sort: sortEl, filters: filterEls } = controls();
      if (search) search.value = filters.search || "";
      for (const input of filterEls) {
        input.value = filters[input.dataset.dirFilter] ?? "";
      }
      const field = sort && typeof sort === "object" ? sort.field : sort;
      if (sortEl) sortEl.value = field || "name";
    }
    function showMessage(text) {
      inlineMessageEl.textContent = text || "";
      inlineMessageEl.hidden = !text;
    }
    function renderViews() {
      viewsEl.innerHTML = renderSavedViewBar({
        entity,
        views: state.views,
        viewsError: state.viewsError,
        selectedViewId: state.selectedViewId,
        updateViewId: state.baseViewId,
        modified: state.modified,
        escapeHtml,
      });
    }
    async function loadViews(isCurrent = captureDirectoryCurrent(entity)) {
      const isSurfaceCurrent = captureSurfaceCurrent(entity);
      try {
        const result = await fetchViews(api, entity, { paths: WORKSPACE_API });
        if (!isSurfaceCurrent()) return;
        state.views = result.items || [];
        state.viewsError = null;
      } catch (error) {
        if (!isSurfaceCurrent() || !isCurrent()) return;
        state.views = null;
        state.viewsError = `Saved views unavailable: ${error.message}`;
      }
      if (!isSurfaceCurrent()) return;
      renderViews();
    }
    function effectiveFromControls() {
      const collected = readControls();
      const { sort, ...urlFilters } = collected;
      // The sort control carries the field only: an unchanged field keeps the
      // resolved direction (reverse combos survive filter edits), while an
      // explicitly changed field deliberately takes its field default.
      const stateField = typeof state.sort === "object" ? state.sort.field : state.sort;
      const stateDir = typeof state.sort === "object" ? state.sort.direction : undefined;
      const urlState = { ...urlFilters };
      if (sort) {
        urlState.sort = sort;
        if (sort !== stateField || !stateDir) urlState.dir = sort === "lastTouch" ? "desc" : "asc";
        else urlState.dir = stateDir;
      }
      return resolveEffectiveFilters({
        entity,
        views: state.views,
        viewsError: state.viewsError,
        selectedViewId: state.baseViewId ?? state.selectedViewId,
        urlState,
      });
    }
    // One canonical serializer (directoryUrl): field + direction mapping
    // lives there, never rebuilt per caller. Writes happen only for the
    // active tab and the navigation generation that issued the load, so a
    // delayed response can never replace a record URL (or another tab's).
    function writeUrl(resolved, isCurrent) {
      if (activeView() !== entity) return;
      if (typeof isCurrent === "function" && !isCurrent()) return;
      const canonical = directoryUrl(entity, { viewId: resolved.viewId, filters: resolved.filters, sort: resolved.sort, limit: state.limit });
      const params = new URLSearchParams(canonical.split("?")[1] || "");
      if (state.cursor) params.set("cursor", state.cursor);
      const plain = Object.fromEntries(params.entries());
      rememberListParams(entity, plain);
      navigateCanonicalWorkspace(sponsorsPath(entity), plain, { render: false, history: "replace" });
    }
    async function loadDirectory({ resetPage = true, isCurrent = captureDirectoryCurrent(entity) } = {}) {
      if (!isCurrent()) return;
      if (resetPage) {
        state.cursor = null;
        state.prev = [];
      }
      // Request + navigation ownership: an older success/error never
      // overwrites newer rows, status or URL (deferred search/filter/page
      // races), and a response that lands after the operator moved on
      // (another tab, an open record) never mutates hidden rows, shared
      // notices or the record URL. Applies to the 400 retry path too.
      const requestToken = ++state.requestToken;
      const settled = () => requestToken === state.requestToken && isCurrent();
      const resolved = effectiveFromControls();
      if (resolved.error) {
        if (!settled()) return;
        rowsEl.innerHTML = renderDirectoryError({ message: resolved.error, escapeHtml });
        statusEl.textContent = "";
        pagesEl.innerHTML = "";
        showMessage("");
        return;
      }
      state.selectedViewId = resolved.viewId;
      state.modified = resolved.modified;
      state.sort = resolved.sort;
      state.lastResolved = { filters: resolved.filters, sort: resolved.sort };
      showMessage("Loading…");
      rowsEl.setAttribute("aria-busy", "true");
      const query = directoryQueryFromState(entity, {
        ...resolved.filters,
        sort: resolved.sort,
        limit: state.limit,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      });
      const queryString = new URLSearchParams(query).toString();
      try {
        const result = await api(`${directoryPath}?${queryString}`);
        if (!settled()) return;
        state.items = result.items || [];
        state.total = Number(result.total || 0);
        rememberCompanyNames(state.items);
        const absoluteFilters = resolved.filters;
        const hasFilters = Object.keys(absoluteFilters)
          .some((key) => key !== "active" || absoluteFilters[key] !== "true");
        rowsEl.innerHTML = state.items.length
          ? state.items.map((item) => entity === "companies"
            ? renderCompanyRow(item, { escapeHtml, humanDate: humanSponsorDate, recordPath: sponsorRecordPath })
            : renderPersonRow(item, { escapeHtml, humanDate: humanSponsorDate, recordPath: sponsorRecordPath })).join("")
          : renderDirectoryEmpty(entity, { hasFilters });
        statusEl.textContent = renderDirectoryStatus({ shown: state.items.length, total: state.total });
        pagesEl.innerHTML = renderDirectoryPagination({ hasPrev: state.prev.length > 0, hasNext: !!result.nextCursor });
        state.nextCursor = result.nextCursor || null;
        showMessage("");
        renderViews();
        writeUrl(resolved, settled);
        rowsEl.removeAttribute("aria-busy");
      } catch (error) {
        if (!settled()) return;
        if (Number(error?.status) === 400 && state.cursor) {
          state.cursor = null;
          state.prev = [];
          await loadDirectory({ resetPage: true, isCurrent });
          return;
        }
        rowsEl.innerHTML = renderDirectoryError({ message: error.message, escapeHtml });
        statusEl.textContent = "";
        pagesEl.innerHTML = "";
        showMessage("");
        rowsEl.removeAttribute("aria-busy");
      }
    }
    // Back-page restore: reload the preserved cursor without resetting it;
    // when the page comes back empty but records remain (an archived row
    // vanished), fall back to the first page instead of stranding the
    // operator on an empty page.
    async function restorePage(isCurrent = captureDirectoryCurrent(entity)) {
      if (!isCurrent()) return;
      if (!state.initialized) {
        await refresh(isCurrent);
        return;
      }
      if (!state.views && !state.viewsError) {
        await loadViews(isCurrent);
        if (!isCurrent()) return;
      }
      await loadDirectory({ resetPage: false, isCurrent });
      if (!isCurrent()) return;
      if (state.items.length === 0 && state.total > 0 && (state.cursor || state.prev.length)) {
        state.cursor = null;
        state.prev = [];
        await loadDirectory({ resetPage: true, isCurrent });
      }
    }
    async function refresh(isCurrent = captureDirectoryCurrent(entity)) {
      if (!isCurrent()) return;
      if (!state.initialized) {
        await loadViews(isCurrent);
        if (!isCurrent()) return;
        const initial = directoryStateFromUrl(
          `${sponsorsPath(entity)}?${new URLSearchParams(listParamsByView[entity] || {}).toString()}`, entity);
        if (initial.error) {
          // Persist the invalid state: initialized stays false so a later
          // restorePage retries init instead of silently loading defaults.
          // Only an explicit corrected query (reload/navigation) clears it.
          renderViews();
          rowsEl.innerHTML = renderDirectoryError({ message: initial.error, escapeHtml });
          statusEl.textContent = "";
          pagesEl.innerHTML = "";
          showMessage("");
          return;
        }
        state.initialized = true;
        const initialViewId = initial.state.view || defaultViewForEntity(state.views || [], entity)?.id || null;
        state.baseViewId = initialViewId;
        const resolved = resolveEffectiveFilters({
          entity,
          views: state.views,
          viewsError: state.viewsError,
          selectedViewId: initialViewId,
          urlState: initial.state,
        });
        if (resolved.error) {
          // Honest resolver failure (missing view, unresolved builtin,
          // views failure): render it and stay invalid. initialized stays
          // false so a later restorePage retries init instead of silently
          // loading defaults; only an explicit corrected query clears it.
          state.initialized = false;
          renderViews();
          rowsEl.innerHTML = renderDirectoryError({ message: resolved.error, escapeHtml });
          statusEl.textContent = "";
          pagesEl.innerHTML = "";
          showMessage("");
          return;
        }
        state.selectedViewId = resolved.viewId;
        state.modified = resolved.modified;
        state.sort = resolved.sort;
        // The validated URL page size survives into state (and back into the
        // canonical URL via writeUrl); without this the limit param parses
        // but never executes.
        state.limit = initial.state.limit || directoryDefaults(entity).limit;
        applyToControls({ ...resolved.filters }, resolved.sort);
        if (entity === "people") {
          await refillCompanyFilter("", isCurrent);
          if (!isCurrent()) return;
        }
        renderViews();
      } else if (!state.views && !state.viewsError) {
        await loadViews(isCurrent);
        if (!isCurrent()) return;
      }
      await loadDirectory({ resetPage: true, isCurrent });
    }
    async function refillCompanyFilter(search = "", isCurrent = captureDirectoryCurrent(entity)) {
      const select = root.querySelector('[data-dir-filter="company"]');
      if (!select) return;
      const selectedId = select.value || readControls().company || "";
      try {
        const options = await fetchCompanyOptions({ search });
        if (!isCurrent()) return;
        select.innerHTML = companyPickerOptions({
          options,
          selectedId,
          selectedName: companyNames.get(selectedId) || "",
          includeAny: true,
          escapeHtml,
        });
      } catch {
        // The filter stays usable from the URL; a failed picker is not fatal.
      }
    }
    async function selectView(id, isCurrent = captureDirectoryCurrent(entity)) {
      if (!isCurrent()) return;
      state.selectedViewId = id || null;
      state.baseViewId = id || null;
      state.modified = false;
      const resolved = resolveEffectiveFilters({
        entity,
        views: state.views,
        viewsError: state.viewsError,
        selectedViewId: state.selectedViewId,
        urlState: {},
      });
      if (!resolved.error) {
        state.sort = resolved.sort;
        applyToControls({ ...resolved.filters }, resolved.sort);
      }
      await loadDirectory({ isCurrent });
    }
    let filterTimer;
    const scheduleLoad = () => {
      clearTimeout(filterTimer);
      noteDirectoryIntent(entity);
      state.initialized = true;
      const isCurrent = captureDirectoryCurrent(entity);
      filterTimer = setTimeout(() => {
        if (!isCurrent()) return;
        safe(() => loadDirectory({ isCurrent }), "Could not load directory");
      }, 180);
    };
    root.querySelector("[data-dir-search]").addEventListener("input", scheduleLoad);
    root.querySelectorAll("[data-dir-filter],[data-dir-sort]").forEach((input) =>
      input.addEventListener("change", () => {
        noteDirectoryIntent(entity);
        state.initialized = true;
        const isCurrent = captureDirectoryCurrent(entity);
        safe(() => loadDirectory({ isCurrent }), "Could not load directory");
      }));
    pagesEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-dir-next]") && state.nextCursor) {
        noteDirectoryIntent(entity);
        state.prev.push(state.cursor);
        state.cursor = state.nextCursor;
        const isCurrent = captureDirectoryCurrent(entity);
        safe(() => loadDirectory({ resetPage: false, isCurrent }), "Could not load directory");
      }
      if (event.target.closest("[data-dir-prev]") && state.prev.length) {
        noteDirectoryIntent(entity);
        state.cursor = state.prev.pop();
        const isCurrent = captureDirectoryCurrent(entity);
        safe(() => loadDirectory({ resetPage: false, isCurrent }), "Could not load directory");
      }
    });
    const pickerSearch = root.querySelector("[data-dir-company-search]");
    if (pickerSearch) {
      let pickerTimer;
      pickerSearch.addEventListener("input", () => {
        clearTimeout(pickerTimer);
        const isCurrent = captureDirectoryCurrent(entity);
        pickerTimer = setTimeout(() => {
          if (!isCurrent()) return;
          refillCompanyFilter(pickerSearch.value, isCurrent);
        }, 180);
      });
    }
    viewsEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-views-retry]")) {
        noteDirectoryIntent(entity);
        const isCurrent = captureDirectoryCurrent(entity);
        safe(async () => {
          await loadViews(isCurrent);
          if (!isCurrent()) return;
          await loadDirectory({ isCurrent });
        }, "Could not load saved views");
        return;
      }
      if (event.target.closest("[data-views-save]")) {
        openViewsDialog(entity, "save");
        return;
      }
      if (event.target.closest("[data-views-update]")) {
        noteDirectoryIntent(entity);
        const isCurrent = captureDirectoryCurrent(entity);
        safe(() => updateCurrentView(isCurrent), "Could not update saved view");
        return;
      }
      if (event.target.closest("[data-views-manage]")) {
        openViewsDialog(entity, "manage");
      }
    });
    viewsEl.addEventListener("change", (event) => {
      const select = event.target.closest("[data-views-select]");
      if (!select) return;
      noteDirectoryIntent(entity);
      state.initialized = true;
      const isCurrent = captureDirectoryCurrent(entity);
      safe(() => selectView(select.value || null, isCurrent), "Could not apply saved view");
    });
    async function updateCurrentView(isCurrent = captureDirectoryCurrent(entity)) {
      if (!isCurrent()) return;
      const targetId = state.selectedViewId || state.baseViewId;
      const current = state.views?.find((view) => view.id === targetId && !isBuiltinView(view));
      if (!current) throw new Error("Select one of your views to update it");
      const resolved = effectiveFromControls();
      if (resolved.error) throw new Error(resolved.error);
      const absolute = resolved.filters;
      try {
        await updateSavedView(api, current.id, {
          name: current.name,
          filters: absolute,
          sort: sortForSave(resolved.sort),
          ...(current.columns ? { columns: current.columns } : {}),
          version: current.version,
        }, { paths: WORKSPACE_API });
      } catch (error) {
        if (!isCurrent()) return;
        throw error;
      }
      state.views = null;
      state.viewsError = null;
      if (!isCurrent()) return;
      await loadViews(isCurrent);
      if (!isCurrent()) return;
      await selectView(current.id, isCurrent);
    }
    return {
      state, refresh, loadDirectory, restorePage, refillCompanyFilter, readControls,
      applyToControls, selectView, reloadViews: loadViews, root,
    };
  }
  const directories = {
    companies: createDirectoryController("companies"),
    people: createDirectoryController("people"),
  };

  // Saved-view save/manage dialog + pipeline URL/filter/saved-view lifecycle
  // live in sponsor-pipeline-lifecycle.js.
  let pipeline = null;
  const openViewsDialog = wireSavedViewsDialog({
    api,
    surface,
    escapeHtml,
    safe,
    openDialog,
    getPipeline: () => pipeline,
    directories,
    capturePipelineCurrent,
    captureDirectoryCurrent,
    notePipelineIntent,
    noteDirectoryIntent,
    sortForSave,
    workspaceApi: WORKSPACE_API,
  });
  pipeline = createSponsorPipelineLifecycle({
    api, surface, escapeHtml, safe, navigateCanonicalWorkspace, reloadPipeline,
    rememberListParams, listParamsByView, activeView, capturePipelineCurrent,
    captureSurfaceCurrent, notePipelineIntent,
    openViewsDialog, showNotice,
    workspaceApi: WORKSPACE_API,
  });

  // Add-person entries (E-owned selectors, agreed with F): [data-add-contact]
  // opens the shared editor with the explicit company association chooser
  // (bounded company options supplement the in-memory organizations);
  // [data-contact-org="<id>"] presets the company and hides the chooser.
  // Behavior (chooser, versions, precision-safe save) is F's editor.
  surface.addEventListener("click", (event) => {
    if (event.target.closest("[data-add-contact]")) {
      const isCurrent = capturePageCurrent();
      safe(async () => {
        const options = await fetchCompanyOptions({ limit: 50 }).catch(() => []);
        if (!isCurrent()) return;
        await openContactEditor({}, { companies: options });
      }, "Could not open contact editor");
      return;
    }
    const preset = event.target.closest("[data-contact-org]")?.dataset.contactOrg;
    if (preset) safe(() => openContactEditor({ organizationId: preset }), "Could not open contact editor");
  });

  // Record opening reads the cheap D record summary only (single Get, no
  // child collections): F People/Deals tabs fetch on click. Editing forms
  // load their full option sets on demand instead.
  async function loadCompanySummary(organizationId) {
    const summary = await api(`/directory/companies/${encodeURIComponent(organizationId)}`);
    setOrganizations([
      ...getOrganizations().filter((item) => item.id !== organizationId),
      {
        id: summary.id,
        displayName: summary.displayName,
        domain: summary.domain,
        active: summary.active,
        version: summary.version,
        updatedAt: summary.updatedAt,
      },
    ]);
    return summary;
  }

  // Record mode: the record renders in the split detail pane, so the split
  // layout is revealed while the record's primary tab stays highlighted
  // (company→Companies, person→People, deal→Pipeline). Pipeline-only chrome
  // (funnel scope/controls/filters) hides on every record. Origin context for
  // Back lives in returnContext; closeRecord restores the origin tab.
  function setRecordTab(tab) {
    // Part of the record open itself: opening a record must not invalidate
    // its own generation, only later user transitions do.
    suppressTransitionNote = true;
    try {
      showView(tab, false);
    } finally {
      suppressTransitionNote = false;
    }
    surface.querySelector(".crm-layout").hidden = false;
    surface.querySelector('[data-dir-root="companies"]').hidden = true;
    surface.querySelector('[data-dir-root="people"]').hidden = true;
    surface.querySelector(".crm-leads").hidden = true;
    surface.querySelector(".crm-newsletters").hidden = true;
    surface.querySelector(".crm-money").hidden = true;
    surface.querySelector("[data-crm-pipeline]").hidden = true;
    surface.querySelector(".crm-funnel-scope").hidden = true;
    surface.querySelector(".crm-funnel-controls").hidden = true;
    surface.querySelector(".crm-filter-disclosure").hidden = true;
    surface.classList.toggle("dk-fill", true);
  }

  let currentPersonId = null;
  const getOpenPersonId = () => (surface.querySelector("[data-crm-person]") ? currentPersonId : null);

  function showRecord({ dealId, companyId, personId } = {}) {
    const deal = dealId ? getDeals().find((item) => item.id === dealId) : null;
    const organization = companyId
      ? getOrganizations().find((item) => item.id === companyId)
      : null;
    if (deal) {
      currentPersonId = null;
      openRecordRef = { kind: "deal", id: dealId };
      setRecordTab("pipeline");
      // isCurrent threads through reopenDealDetail once F forwards it;
      // passing it now is forward-compatible and ignored until then.
      safe(() => reopenDealDetail(deal, { isCurrent: capturePageCurrent() }), "Could not open deal");
      return true;
    }
    if (organization) {
      currentPersonId = null;
      openRecordRef = { kind: "company", id: companyId };
      setRecordTab("companies");
      safe(() => reopenCompanyDetail(organization, null, { isCurrent: capturePageCurrent() }), "Could not open company");
      return true;
    }
    if (personId) {
      currentPersonId = personId;
      openRecordRef = { kind: "person", id: personId };
      setRecordTab("people");
      safe(async () => {
        const detail = surface.querySelector("[data-crm-detail]");
        surface.classList.add("has-booking-detail");
        const split = surface.querySelector("[data-crm-split]");
        if (split) {
          split.dataset.view = "detail";
          globalThis.dakitSplit?.show(split, "detail");
        }
        detail.innerHTML = `<div data-crm-person></div>`;
        const host = detail.querySelector("[data-crm-person]");
        personDetail.wire(host);
        await personDetail.openPerson(personId, { isCurrent: capturePageCurrent() });
      }, "Could not open person");
      return true;
    }
    return false;
  }

  // An in-place open records the record path; a record that cannot load
  // renders an honest error in the detail pane (retryable, with a way back)
  // instead of a bare status message. keepContext preserves the existing
  // Back origin for nested opens (person → company) instead of chaining.
  // Per-open generation: a late prior open never reopens or navigates over
  // a newer record (or Tasks).
  let openGeneration = 0;
  function openRecord(kind, id, focusSelector, { keepContext = false } = {}) {
    const openToken = ++openGeneration;
    const current = () => openToken !== openGeneration || isStale();
    safe(async () => {
      try {
        if (!keepContext) captureReturnContext(kind, id, getCurrentView());
          if (kind === "deal") {
            const item = await api(`/deals/${encodeURIComponent(id)}`);
            if (current()) return;
            await Promise.all([loadCompanySummary(item.organizationId), ensureOwnerDirectory()]);
            if (current()) return;
            setDeals([...getDeals().filter((value) => value.id !== id), item]);
            showRecord({ dealId: id });
          } else if (kind === "person") {
            showRecord({ personId: id });
          } else {
            await Promise.all([loadCompanySummary(id), ensureOwnerDirectory()]);
            if (current()) return;
            showRecord({ companyId: id });
          }
        if (current()) return;
        navigateCanonicalWorkspace(sponsorRecordPath(kind, id), {}, { render: false });
      } catch (error) {
        // A stale opener's rejection must never paint over a newer record.
        if (current()) return;
        surface.classList.add("has-booking-detail");
        const split = surface.querySelector("[data-crm-split]");
        if (split) {
          split.dataset.view = "detail";
          globalThis.dakitSplit?.show(split, "detail");
        }
        renderEntityLoadState(surface.querySelector("[data-crm-detail]"), {
          kind,
          id,
          status: error.status === 404 ? "not-found" : "error",
          error: error.message,
          retry: () => openRecord(kind, id, focusSelector),
          returnToList: () => navigateCanonicalWorkspace(sponsorsPath(getCurrentView())),
        });
      }
    }, "Could not open record");
  }

  return {
    directories,
    pipeline,
    seedListParams,
    fetchCompanyOptions,
    loadCompanySummary,
    showRecord,
    openRecord,
    getOpenPersonId,
    closeRecord,
    captureSaveContext,
    saveContextOwnsSurface,
    capturePageCurrent,
    capturePipelineCurrent,
    noteTabTransition,
    listPath,
    captureReturnContext,
  };
}
