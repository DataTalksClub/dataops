import { sponsorRecordPath, sponsorsPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";
import { pipelineControlsFromFilters, pipelineUiSort } from "./sponsor-pipeline.js";
import {
  archiveSavedView,
  defaultViewForEntity,
  fetchViews,
  isBuiltinView,
  renderSavedViewBar,
  renderSavedViewManageList,
  resolveEffectiveFilters,
  resolveViewFiltersForQuery,
  saveView,
  updateSavedView,
  validateViewName,
} from "./sponsor-saved-views.js";
import {
  companyPickerOptions,
  directoryDefaults,
  directoryQueryFromState,
  directoryStateFromUrl,
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

// Maps B-preserved read-only communications history onto F's archive shape.
// Bodies were never stored: preview/detail carry status metadata only.
export function mapArchiveItems(items) {
  return (items || []).map((entry) => {
    const kind = String(entry.recordType || "unknown");
    const label = String(entry.communicationType || entry.status || entry.derivedStatus || kind);
    const preview = String(entry.safeReason || entry.status || entry.derivedStatus || "");
    return {
      id: String(entry.id || ""),
      kind,
      label,
      preview,
      detail: [preview, entry.createdAt ? `Recorded ${entry.createdAt}` : ""].filter(Boolean).join(" · "),
      createdAt: entry.createdAt,
    };
  });
}

// Directory sorts are fixed-direction: name ascends, last touch descends.
function viewSortFor(sort) {
  return { field: sort === "lastTouch" ? "lastTouch" : "name", direction: sort === "lastTouch" ? "desc" : "asc" };
}

function newViewSourceKey() {
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  return `sponsors-ui-${random}`;
}

const PIPELINE_VIEW_IDS = ["actionable", "active", "unscheduled", "all", "closed"];

export function createSponsorDirectoryPages({
  api,
  surface,
  escapeHtml,
  humanSponsorDate,
  safe,
  openDialog,
  navigateCanonicalWorkspace,
  getContacts,
  mergeContact,
  reloadPipeline,
  showView,
}) {
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
    const options = (result.items || []).map((item) => ({ id: item.id, name: item.displayName }));
    rememberCompanyNames(result.items);
    return options;
  }

  // Last-written list params per tab, seeded by the host from the route.
  const listParamsByView = { pipeline: {}, companies: {}, people: {} };
  function seedListParams(view, params) {
    if (listParamsByView[view]) listParamsByView[view] = { ...(params || {}) };
  }
  function rememberListParams(view, params) {
    listParamsByView[view] = { ...(params || {}) };
  }

  // Return context for record Back: origin tab path + params, scroll and the
  // originating link. E-owned; F closeRecord consumes it once record modules
  // land. listPath keeps returning the origin path for the current detail.
  let returnContext = null;
  const listPath = (fallbackView) => returnContext?.path || sponsorsPath(fallbackView);
  function captureReturnContext(kind, id, currentView) {
    const scroller = surface.querySelector("[data-crm-list-scroll]");
    returnContext = {
      view: currentView === "pipeline" || currentView === "companies" || currentView === "people" ? currentView : "pipeline",
      path: sponsorsPath(currentView === "pipeline" || currentView === "companies" || currentView === "people" ? currentView : "pipeline"),
      params: { ...(listParamsByView[currentView] || {}) },
      scrollTop: scroller ? scroller.scrollTop : (globalThis.window?.scrollY || 0),
      focusSelector: kind === "deal" ? `[data-open-deal="${id}"]`
        : kind === "company" ? `[data-open-company="${id}"]`
        : `[data-open-person="${id}"]`,
    };
  }
  function closeRecord() {
    if (!returnContext) return;
    const { view, path, params, scrollTop, focusSelector } = returnContext;
    returnContext = null;
    navigateCanonicalWorkspace(path, params, { render: false, history: "replace" });
    showView(view, false);
    if ((view === "companies" || view === "people") && !directories[view].state.initialized) {
      safe(() => directories[view].refresh(), "Could not load directory");
    }
    surface.classList.remove("has-booking-detail");
    const split = surface.querySelector("[data-crm-split]");
    if (split) {
      split.dataset.view = "list";
      globalThis.dakitSplit?.show(split, "list");
    }
    const scroller = surface.querySelector("[data-crm-list-scroll]");
    if (scroller) scroller.scrollTop = scrollTop || 0;
    else if (typeof globalThis.scrollTo === "function") globalThis.scrollTo(0, scrollTop || 0);
    surface.querySelector(focusSelector)?.focus?.();
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
      initialized: false,
    };
    const controls = () => ({
      search: root.querySelector("[data-dir-search]"),
      sort: root.querySelector("[data-dir-sort]"),
      filters: [...root.querySelectorAll("[data-dir-filter]")],
    });
    function readControls() {
      const { search, sort, filters } = controls();
      const collected = {};
      if (search?.value) collected.search = search.value;
      for (const input of filters) {
        if (input.value !== "") collected[input.dataset.dirFilter] = input.value;
      }
      if (sort?.value && sort.value !== "name") collected.sort = sort.value;
      return collected;
    }
    function applyToControls(filters, sort) {
      const { search, sort: sortEl, filters: filterEls } = controls();
      if (search) search.value = filters.search || "";
      for (const input of filterEls) {
        input.value = filters[input.dataset.dirFilter] ?? "";
      }
      if (sortEl) sortEl.value = sort || "name";
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
        modified: state.modified,
        escapeHtml,
      });
    }
    async function loadViews() {
      try {
        const result = await fetchViews(api, entity, { paths: WORKSPACE_API });
        state.views = result.items || [];
        state.viewsError = null;
      } catch (error) {
        state.views = null;
        state.viewsError = `Saved views unavailable: ${error.message}`;
      }
      renderViews();
    }
    function effectiveFromControls() {
      const collected = readControls();
      const { sort, ...urlFilters } = collected;
      return resolveEffectiveFilters({
        entity,
        views: state.views,
        viewsError: state.viewsError,
        selectedViewId: state.selectedViewId,
        urlState: { ...urlFilters, ...(sort ? { sort } : {}) },
      });
    }
    function writeUrl(resolved) {
      const params = {};
      if (resolved.viewId) params.view = resolved.viewId;
      const absolute = resolveViewFiltersForQuery(resolved.filters);
      for (const [key, value] of Object.entries(absolute)) params[key] = String(value);
      if (resolved.sort && resolved.sort !== "name") params.sort = resolved.sort;
      if (state.cursor) params.cursor = state.cursor;
      rememberListParams(entity, params);
      navigateCanonicalWorkspace(sponsorsPath(entity), params, { render: false, history: "replace" });
    }
    async function loadDirectory({ resetPage = true } = {}) {
      if (resetPage) {
        state.cursor = null;
        state.prev = [];
      }
      const resolved = effectiveFromControls();
      if (resolved.error) {
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
        ...resolveViewFiltersForQuery(resolved.filters),
        sort: resolved.sort,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      });
      const queryString = new URLSearchParams(query).toString();
      try {
        const result = await api(`${directoryPath}?${queryString}`);
        if (!surface.isConnected) return;
        state.items = result.items || [];
        state.total = Number(result.total || 0);
        rememberCompanyNames(state.items);
        const absoluteFilters = resolveViewFiltersForQuery(resolved.filters);
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
        writeUrl(resolved);
        rowsEl.removeAttribute("aria-busy");
      } catch (error) {
        if (!surface.isConnected) return;
        if (Number(error?.status) === 400 && state.cursor) {
          state.cursor = null;
          state.prev = [];
          await loadDirectory({ resetPage: true });
          return;
        }
        rowsEl.innerHTML = renderDirectoryError({ message: error.message, escapeHtml });
        statusEl.textContent = "";
        pagesEl.innerHTML = "";
        showMessage("");
        rowsEl.removeAttribute("aria-busy");
      }
    }
    async function refresh() {
      if (!state.initialized) {
        state.initialized = true;
        await loadViews();
        const initial = directoryStateFromUrl(
          `${sponsorsPath(entity)}?${new URLSearchParams(listParamsByView[entity] || {}).toString()}`, entity);
        const resolved = resolveEffectiveFilters({
          entity,
          views: state.views,
          viewsError: state.viewsError,
          selectedViewId: initial.state.view || defaultViewForEntity(state.views || [], entity)?.id || null,
          urlState: initial.state,
        });
        if (!resolved.error) {
          state.selectedViewId = resolved.viewId;
          state.modified = resolved.modified;
          applyToControls(resolveViewFiltersForQuery(resolved.filters), resolved.sort);
        }
        if (entity === "people") await refillCompanyFilter();
        renderViews();
      }
      await loadDirectory({ resetPage: true });
    }
    async function refillCompanyFilter(search = "") {
      const select = root.querySelector('[data-dir-filter="company"]');
      if (!select) return;
      const selectedId = select.value || readControls().company || "";
      try {
        const options = await fetchCompanyOptions({ search });
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
    async function selectView(id) {
      state.selectedViewId = id || null;
      state.modified = false;
      const resolved = resolveEffectiveFilters({
        entity,
        views: state.views,
        viewsError: state.viewsError,
        selectedViewId: state.selectedViewId,
        urlState: {},
      });
      if (!resolved.error) {
        applyToControls(resolveViewFiltersForQuery(resolved.filters), resolved.sort);
      }
      await loadDirectory();
    }
    let filterTimer;
    const scheduleLoad = () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => safe(() => loadDirectory(), "Could not load directory"), 180);
    };
    root.querySelector("[data-dir-search]").addEventListener("input", scheduleLoad);
    root.querySelectorAll("[data-dir-filter],[data-dir-sort]").forEach((input) =>
      input.addEventListener("change", () => safe(() => loadDirectory(), "Could not load directory")));
    pagesEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-dir-next]") && state.nextCursor) {
        state.prev.push(state.cursor);
        state.cursor = state.nextCursor;
        safe(() => loadDirectory({ resetPage: false }), "Could not load directory");
      }
      if (event.target.closest("[data-dir-prev]") && state.prev.length) {
        state.cursor = state.prev.pop();
        safe(() => loadDirectory({ resetPage: false }), "Could not load directory");
      }
    });
    const pickerSearch = root.querySelector("[data-dir-company-search]");
    if (pickerSearch) {
      let pickerTimer;
      pickerSearch.addEventListener("input", () => {
        clearTimeout(pickerTimer);
        pickerTimer = setTimeout(() => refillCompanyFilter(pickerSearch.value), 180);
      });
    }
    viewsEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-views-retry]")) {
        safe(async () => {
          await loadViews();
          await loadDirectory();
        }, "Could not load saved views");
        return;
      }
      if (event.target.closest("[data-views-save]")) {
        openViewsDialog(entity, "save");
        return;
      }
      if (event.target.closest("[data-views-update]")) {
        safe(() => updateCurrentView(), "Could not update saved view");
        return;
      }
      if (event.target.closest("[data-views-manage]")) {
        openViewsDialog(entity, "manage");
      }
    });
    viewsEl.addEventListener("change", (event) => {
      const select = event.target.closest("[data-views-select]");
      if (!select) return;
      safe(() => selectView(select.value || null), "Could not apply saved view");
    });
    async function updateCurrentView() {
      const current = state.views?.find((view) => view.id === state.selectedViewId && !isBuiltinView(view));
      if (!current) throw new Error("Select one of your views to update it");
      const resolved = effectiveFromControls();
      if (resolved.error) throw new Error(resolved.error);
      const absolute = resolveViewFiltersForQuery(resolved.filters);
      await updateSavedView(api, current.id, {
        name: current.name,
        filters: absolute,
        sort: viewSortFor(resolved.sort),
        ...(current.columns ? { columns: current.columns } : {}),
        version: current.version,
      }, { paths: WORKSPACE_API });
      await loadViews();
      await selectView(current.id);
    }
    return {
      state, refresh, loadDirectory, refillCompanyFilter, readControls,
      applyToControls, selectView, reloadViews: loadViews, root,
    };
  }
  const directories = {
    companies: createDirectoryController("companies"),
    people: createDirectoryController("people"),
  };

  // Saved-view save/manage dialog shared by both directories and pipeline.
  let viewsDialogContext = null;
  function openViewsDialog(entity, mode, preset) {
    const dialog = surface.querySelector("[data-views-dialog]");
    const form = dialog.querySelector("form");
    const title = dialog.querySelector("[data-views-dialog-title]");
    const saveFields = dialog.querySelector("[data-views-save-fields]");
    const manage = dialog.querySelector("[data-views-manage]");
    const confirm = dialog.querySelector("[data-views-confirm]");
    const nameInput = form.elements.viewName;
    form.reset();
    viewsDialogContext = { entity, mode, viewId: preset?.id || null, version: preset?.version };
    if (mode === "manage") {
      title.textContent = "Manage my views";
      saveFields.hidden = true;
      confirm.hidden = true;
      const views = entity === "pipeline" ? pipeline.views : directories[entity].state.views;
      manage.innerHTML = renderSavedViewManageList({ views, escapeHtml });
    } else {
      title.textContent = mode === "rename" ? `Rename “${preset?.name || ""}”` : "Save view";
      saveFields.hidden = false;
      confirm.hidden = false;
      confirm.textContent = mode === "rename" ? "Rename view" : "Save view";
      if (preset) nameInput.value = preset.name || "";
      manage.innerHTML = "";
    }
    openDialog(dialog);
  }
  surface.querySelector("[data-views-dialog] [data-views-manage]").addEventListener("click", (event) => {
    const archiveId = event.target.closest("[data-views-archive]")?.dataset.viewsArchive;
    const renameId = event.target.closest("[data-views-rename]")?.dataset.viewsRename;
    if (!viewsDialogContext) return;
    const { entity } = viewsDialogContext;
    if (archiveId) {
      safe(async () => {
        await archiveSavedView(api, archiveId, { paths: WORKSPACE_API });
        if (entity === "pipeline") {
          pipeline.views = null;
          pipeline.viewsError = null;
          await pipeline.ensureViews();
        } else {
          await directories[entity].reloadViews();
          await directories[entity].loadDirectory();
        }
        openViewsDialog(entity, "manage");
      }, "Could not archive saved view");
      return;
    }
    if (renameId) {
      const views = entity === "pipeline" ? pipeline.views : directories[entity].state.views;
      const preset = views?.find((view) => view.id === renameId);
      if (preset) openViewsDialog(entity, "rename", preset);
    }
  });
  surface.querySelector("[data-views-confirm]").onclick = (event) => {
    event.preventDefault();
    if (!viewsDialogContext) return;
    const { entity, mode, viewId, version } = viewsDialogContext;
    const dialog = surface.querySelector("[data-views-dialog]");
    const form = dialog.querySelector("form");
    safe(async () => {
      const name = form.elements.viewName.value || "";
      const nameError = validateViewName(name);
      if (nameError) throw new Error(nameError);
      if (entity === "pipeline") {
        const controls = pipeline.controlValues();
        const filters = {};
        if (controls.view && controls.view !== "actionable") filters.view = controls.view;
        if (controls.stage) filters.stage = controls.stage;
        if (controls.search) filters.search = controls.search;
        if (controls.owner) filters.owner = controls.owner;
        if (pipeline.getOrg()) filters.organizationId = pipeline.getOrg();
        const sort = { field: controls.sort === "recent" ? "recent" : "next" };
        const saved = mode === "rename"
          ? await updateSavedView(api, viewId, { name, filters, sort, version }, { paths: WORKSPACE_API })
          : await saveView(api, { entity, name, filters, sort, sourceKey: newViewSourceKey() }, { paths: WORKSPACE_API });
        dialog.close();
        pipeline.views = null;
        pipeline.viewsError = null;
        await pipeline.ensureViews();
        await pipeline.applySavedView(saved.id);
        return;
      }
      const controller = directories[entity];
      const resolved = controller.state.lastResolved || { filters: {}, sort: "name" };
      const saved = mode === "rename"
        ? await updateSavedView(api, viewId, {
          name, filters: resolveViewFiltersForQuery(resolved.filters), sort: viewSortFor(resolved.sort), version,
        }, { paths: WORKSPACE_API })
        : await saveView(api, {
          entity, name, filters: resolveViewFiltersForQuery(resolved.filters),
          sort: viewSortFor(resolved.sort), sourceKey: newViewSourceKey(),
        }, { paths: WORKSPACE_API });
      dialog.close();
      await controller.reloadViews();
      await controller.selectView(saved.id);
    }, "Could not save view");
  };

  // Pipeline URL/filter/saved-view lifecycle: filters, sort, page cursor and
  // the selected saved view live in the URL (?view ?stage ?search ?owner
  // ?sort ?cursor ?savedView). `view` is the D pipeline filter here; the
  // saved-view id travels as `savedView`. Sort in the URL uses control values
  // (next-action|recent); saved-view sorts (next|recent) map onto controls.
  const pipeline = {
    org: null,
    savedViewId: null,
    views: null,
    viewsError: null,
    getOrg: () => pipeline.org,
    controlValues() {
      return {
        view: surface.querySelector("[data-pipeline-view]").value,
        stage: surface.querySelector("[data-crm-status]").value,
        search: surface.querySelector("[data-crm-search]").value,
        owner: surface.querySelector("[data-pipeline-owner]").value,
        sort: surface.querySelector("[data-pipeline-sort]").value,
      };
    },
    applyControls({ view, stage, search, owner, sort, organizationId } = {}) {
      if (view !== undefined && PIPELINE_VIEW_IDS.includes(view)) {
        surface.querySelector("[data-pipeline-view]").value = view;
      }
      if (stage !== undefined) surface.querySelector("[data-crm-status]").value = stage;
      if (search !== undefined) surface.querySelector("[data-crm-search]").value = search;
      if (owner !== undefined) surface.querySelector("[data-pipeline-owner]").value = owner;
      if (sort !== undefined) surface.querySelector("[data-pipeline-sort]").value = pipelineUiSort(sort);
      pipeline.org = organizationId || null;
    },
    writeUrl(cursor) {
      const controls = pipeline.controlValues();
      const params = {};
      if (controls.view && controls.view !== "actionable") params.view = controls.view;
      if (controls.stage) params.stage = controls.stage;
      if (controls.search) params.search = controls.search;
      if (controls.owner) params.owner = controls.owner;
      if (controls.sort && controls.sort !== "next-action") params.sort = controls.sort;
      if (pipeline.savedViewId) params.savedView = pipeline.savedViewId;
      if (cursor) params.cursor = cursor;
      rememberListParams("pipeline", params);
      navigateCanonicalWorkspace("/sponsors/pipeline", params, { render: false, history: "replace" });
    },
    renderViews() {
      const slot = surface.querySelector("[data-pipeline-views]");
      if (!slot) return;
      slot.innerHTML = renderSavedViewBar({
        entity: "pipeline",
        views: pipeline.views,
        viewsError: pipeline.viewsError,
        selectedViewId: pipeline.savedViewId,
        modified: false,
        escapeHtml,
      });
    },
    async ensureViews() {
      if (pipeline.views || pipeline.viewsError) return;
      try {
        pipeline.views = (await fetchViews(api, "pipeline", { paths: WORKSPACE_API })).items || [];
      } catch (error) {
        pipeline.viewsError = `Saved views unavailable: ${error.message}`;
      }
      pipeline.renderViews();
    },
    async applySavedView(id) {
      await pipeline.ensureViews();
      const resolved = resolveEffectiveFilters({
        entity: "pipeline",
        views: pipeline.views,
        viewsError: pipeline.viewsError,
        selectedViewId: id,
        urlState: {},
      });
      if (resolved.error) {
        showNotice(resolved.error);
        return;
      }
      pipeline.savedViewId = resolved.viewId;
      const mapped = pipelineControlsFromFilters(resolved.filters, resolved.sort);
      pipeline.applyControls(mapped);
      pipeline.renderViews();
      await safe(() => pipeline.load(true), "Could not load pipeline");
    },
    // A manual control edit unpins the selected saved view (the URL keeps
    // the effective filters, so the state stays shareable).
    controlsChanged(reload) {
      if (pipeline.savedViewId) {
        pipeline.savedViewId = null;
        pipeline.renderViews();
      }
      reload();
    },
    load(reset = true, extra = {}) {
      return reloadPipeline(reset, { ...(pipeline.org ? { organizationId: pipeline.org } : {}), ...extra });
    },
    // First paint from the URL: controls, saved views, then the first page
    // (deep-linked cursors included). Later control edits go through
    // controlsChanged + load so the URL stays canonical.
    async initFromParams() {
      const p = listParamsByView.pipeline;
      pipeline.applyControls({
        view: p.view,
        stage: p.stage || "",
        search: p.search || "",
        owner: p.owner || "",
        sort: p.sort === "recent" ? "recent" : "next",
      });
      await pipeline.ensureViews();
      if (p.savedView) await pipeline.applySavedView(p.savedView);
      else await pipeline.load(true, p.cursor ? { cursor: p.cursor } : {});
    },
  };
  const pipelineViewsSlot = surface.querySelector("[data-pipeline-views]");
  if (pipelineViewsSlot) {
    pipelineViewsSlot.addEventListener("click", (event) => {
      if (event.target.closest("[data-views-retry]")) {
        safe(async () => {
          pipeline.views = null;
          pipeline.viewsError = null;
          await pipeline.ensureViews();
        }, "Could not load saved views");
        return;
      }
      if (event.target.closest("[data-views-save]")) {
        openViewsDialog("pipeline", "save");
        return;
      }
      if (event.target.closest("[data-views-manage]")) {
        openViewsDialog("pipeline", "manage");
      }
    });
    pipelineViewsSlot.addEventListener("change", (event) => {
      const select = event.target.closest("[data-views-select]");
      if (!select) return;
      safe(() => pipeline.applySavedView(select.value || null), "Could not apply saved view");
    });
  }

  // Add-person entries (E-owned selectors, agreed with F): [data-add-contact]
  // opens the dialog with the explicit company association chooser;
  // [data-contact-org="<id>"] presets the company and hides the chooser.
  async function openContactDialog(organizationId) {
    const dialog = surface.querySelector("[data-contact-dialog]");
    const form = dialog.querySelector("form");
    form.reset();
    const picker = form.querySelector("[data-contact-org-picker]");
    const wrap = form.querySelector("[data-contact-org-picker-wrap]");
    if (organizationId) {
      form.elements.organizationId.value = organizationId;
      if (wrap) wrap.hidden = true;
    } else {
      form.elements.organizationId.value = "";
      if (wrap) wrap.hidden = false;
      if (picker) {
        picker.innerHTML = `<option value="">Select a company</option>`;
        try {
          const options = await fetchCompanyOptions({ limit: 50 });
          picker.innerHTML = `<option value="">Select a company</option>` + options
            .map((entry) => html`<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</option>`)
            .join("");
        } catch {
          // The dialog still opens; saving without a company fails honestly.
        }
      }
    }
    openDialog(dialog);
  }
  surface.addEventListener("click", (event) => {
    if (event.target.closest("[data-add-contact]")) {
      safe(() => openContactDialog(null), "Could not open contact editor");
      return;
    }
    const preset = event.target.closest("[data-contact-org]")?.dataset.contactOrg;
    if (preset) safe(() => openContactDialog(preset), "Could not open contact editor");
  });
  surface.querySelector("[data-contact-dialog] [data-contact-org-picker]")?.addEventListener("change", (event) => {
    const form = surface.querySelector("[data-contact-dialog] form");
    form.elements.organizationId.value = event.target.value;
  });

  // INTERIM-F: minimal person record until F's sponsor-person-detail lands.
  // Bounded single-record fetch (existing contacts/:id), company link,
  // edit via the shared contact editor, E-owned Back. F's module takes over
  // this mount without changing routes or returnContext.
  async function reopenPersonDetail(personId) {
    const known = getContacts().find((item) => item.id === personId);
    const contact = known || await api(`/contacts/${encodeURIComponent(personId)}`);
    if (!known) mergeContact(contact);
    const detail = surface.querySelector("[data-crm-detail]");
    const companyName = contact.organizationId
      ? companyNames.get(contact.organizationId) || "Linked company"
      : null;
    surface.classList.add("has-booking-detail");
    const split = surface.querySelector("[data-crm-split]");
    if (split) {
      split.dataset.view = "detail";
      globalThis.dakitSplit?.show(split, "detail");
    }
    const companyHref = contact.organizationId
      ? sponsorRecordPath("company", contact.organizationId)
      : "";
    detail.innerHTML = html`<article class="crm-person-pane" data-person-pane="${escapeHtml(contact.id)}">
      <button type="button" class="dk-split__back" data-close-record>Back</button>
      <h3>${escapeHtml(contact.name || "Unnamed person")}</h3>
      <p>${contact.organizationId
        ? html`<a href="${escapeHtml(companyHref)}" data-open-company="${escapeHtml(contact.organizationId)}">${escapeHtml(companyName)}</a>`
        : "Unlinked"}</p>
      <p>${escapeHtml(contact.role || "No role recorded")}</p>
      <p>${escapeHtml((contact.emails || []).join(", ") || "No email")}</p>
      <p>Full record tabs land with the record worker; this summary stays available.</p>
      <div class="row-actions">
        <button type="button" data-edit-contact="${escapeHtml(contact.id)}">Edit person</button>
      </div>
    </article>`;
    detail.querySelector("[data-close-record]").addEventListener("click", closeRecord);
  }

  // Archive loader for F's record Activity disclosure (B-preserved read-only
  // communications path; bodies were never stored, previews only).
  async function loadArchive(dealId) {
    const result = await api(`/deals/${encodeURIComponent(dealId)}/communications?limit=50`);
    return {
      items: mapArchiveItems(result.items || []),
      total: (result.items || []).length,
      hasMore: result.nextCursor != null,
    };
  }

  return {
    directories,
    pipeline,
    seedListParams,
    openContactDialog,
    reopenPersonDetail,
    closeRecord,
    listPath,
    captureReturnContext,
    loadArchive,
  };
}
