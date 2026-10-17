import { sponsorsPath } from "../../core/sponsor-routes.js";
import { pipelineControlsFromFilters } from "./sponsor-pipeline.js";
import {
  archiveSavedView,
  fetchViews,
  isBuiltinView,
  renderSavedViewBar,
  renderSavedViewManageList,
  resolveEffectiveFilters,
  saveView,
  updateSavedView,
  validateViewName,
} from "./sponsor-saved-views.js";

function newViewSourceKey() {
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  return `sponsors-ui-${random}`;
}

// Package E pipeline URL/filter/saved-view lifecycle, extracted unchanged
// from sponsor-directory-pages.js: filters, sort, page cursor and the
// selected saved view live in the URL (?view ?stage ?search ?owner
// ?organizationId ?sort ?cursor ?savedView). `view` is the D pipeline filter
// here; the saved-view id travels as `savedView`. Sort in the URL uses
// control values (next-action|recent) end to end. organizationId has no
// control: it rides as an extra API param through load() but stays in the
// canonical URL so a company-scoped view survives copy/reload.

const PIPELINE_VIEW_IDS = ["actionable", "active", "early", "overdue", "reply", "unscheduled", "all", "closed"];

export function wireSavedViewsDialog({
  api,
  surface,
  escapeHtml,
  safe,
  openDialog,
  getPipeline,
  directories,
  capturePipelineCurrent,
  captureDirectoryCurrent,
  notePipelineIntent = () => {},
  noteDirectoryIntent = () => {},
  sortForSave,
  workspaceApi,
}) {
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
    viewsDialogContext = {
      entity,
      mode,
      viewId: preset?.id || null,
      version: preset?.version,
      preset: preset || null,
      sourceKey: mode === "save" ? newViewSourceKey() : null,
    };
    const pipeline = getPipeline();
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
    const dialogContext = viewsDialogContext;
    const { entity } = dialogContext;
    const pipeline = getPipeline();
    if (archiveId) {
      if (entity === "pipeline") notePipelineIntent();
      else noteDirectoryIntent(entity);
      const isEntityCurrent = entity === "pipeline" ? capturePipelineCurrent() : captureDirectoryCurrent(entity);
      const isCurrent = () => isEntityCurrent() && viewsDialogContext === dialogContext;
      safe(async () => {
        try {
          await archiveSavedView(api, archiveId, { paths: workspaceApi });
        } catch (error) {
          if (!isCurrent()) return;
          throw error;
        }
        if (entity === "pipeline") {
          if (pipeline.savedViewId === archiveId) pipeline.savedViewId = null;
          if (pipeline.baseViewId === archiveId) {
            pipeline.baseViewId = null;
            pipeline.modified = false;
          }
          pipeline.views = null;
          pipeline.viewsError = null;
          if (!isCurrent()) return;
          await pipeline.ensureViews(isCurrent);
        } else {
          const controller = directories[entity];
          if (controller.state.selectedViewId === archiveId) controller.state.selectedViewId = null;
          if (controller.state.baseViewId === archiveId) {
            controller.state.baseViewId = null;
            controller.state.modified = false;
          }
          controller.state.views = null;
          controller.state.viewsError = null;
          if (!isCurrent()) return;
          await controller.reloadViews(isCurrent);
          if (!isCurrent()) return;
          await controller.loadDirectory({ isCurrent });
        }
        if (!isCurrent()) return;
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
    const dialogContext = viewsDialogContext;
    const { entity, mode, viewId, version, preset, sourceKey } = dialogContext;
    const dialog = surface.querySelector("[data-views-dialog]");
    const form = dialog.querySelector("form");
    const pipeline = getPipeline();
    if (mode !== "rename") {
      if (entity === "pipeline") notePipelineIntent();
      else noteDirectoryIntent(entity);
    }
    const isEntityCurrent = entity === "pipeline" ? capturePipelineCurrent() : captureDirectoryCurrent(entity);
    const isCurrent = () => isEntityCurrent() && viewsDialogContext === dialogContext;
    safe(async () => {
      const name = form.elements.viewName.value || "";
      const nameError = validateViewName(name);
      if (nameError) throw new Error(nameError);
      if (mode === "rename") {
        if (!preset) throw new Error("Saved view not found");
        try {
          await updateSavedView(api, viewId, {
            name,
            filters: { ...(preset.filters || {}) },
            ...(preset.sort !== undefined ? { sort: preset.sort } : {}),
            ...(preset.columns !== undefined ? { columns: preset.columns } : {}),
            version,
          }, { paths: workspaceApi });
        } catch (error) {
          if (!isCurrent()) return;
          throw error;
        }
        if (entity === "pipeline") {
          pipeline.views = null;
          pipeline.viewsError = null;
          if (!isCurrent()) return;
          dialog.close();
          await pipeline.ensureViews(isCurrent);
          if (!isCurrent()) return;
          pipeline.renderViews();
        } else {
          directories[entity].state.views = null;
          directories[entity].state.viewsError = null;
          if (!isCurrent()) return;
          dialog.close();
          await directories[entity].reloadViews(isCurrent);
        }
        return;
      }
      if (entity === "pipeline") {
        const controls = pipeline.controlValues();
        const filters = {};
        if (controls.view && controls.view !== "actionable") filters.view = controls.view;
        if (controls.stage) filters.stage = controls.stage;
        if (controls.search) filters.search = controls.search;
        if (controls.owner) filters.owner = controls.owner;
        if (controls.nextActionFrom) filters.nextActionFrom = controls.nextActionFrom;
        if (controls.nextActionBefore) filters.nextActionBefore = controls.nextActionBefore;
        if (pipeline.getOrg()) filters.organizationId = pipeline.getOrg();
        const sort = { field: controls.sort === "recent" ? "recent" : "next-action" };
        let saved;
        try {
          saved = await saveView(api, { entity, name, filters, sort, sourceKey: sourceKey || newViewSourceKey() }, { paths: workspaceApi });
        } catch (error) {
          if (!isCurrent()) return;
          throw error;
        }
        pipeline.views = null;
        pipeline.viewsError = null;
        if (!isCurrent()) return;
        dialog.close();
        await pipeline.ensureViews(isCurrent);
        if (!isCurrent()) return;
        await pipeline.applySavedView(saved.id, isCurrent);
        return;
      }
      const controller = directories[entity];
      const resolved = controller.state.lastResolved || { filters: {}, sort: "name" };
      let saved;
      try {
        saved = await saveView(api, {
          entity, name, filters: { ...resolved.filters },
          sort: sortForSave(resolved.sort), sourceKey: sourceKey || newViewSourceKey(),
        }, { paths: workspaceApi });
      } catch (error) {
        if (!isCurrent()) return;
        throw error;
      }
      controller.state.views = null;
      controller.state.viewsError = null;
      if (!isCurrent()) return;
      dialog.close();
      await controller.reloadViews(isCurrent);
      if (!isCurrent()) return;
      await controller.selectView(saved.id, isCurrent);
    }, "Could not save view");
  };
  return openViewsDialog;
}

export function createSponsorPipelineLifecycle({
  api,
  surface,
  escapeHtml,
  safe,
  navigateCanonicalWorkspace,
  reloadPipeline,
  rememberListParams,
  listParamsByView,
  activeView,
  capturePipelineCurrent = () => () => true,
  captureSurfaceCurrent = () => capturePipelineCurrent(),
  notePipelineIntent = () => {},
  openViewsDialog,
  showNotice,
  workspaceApi,
}) {
  const pipeline = {
    org: null,
    savedViewId: null,
    baseViewId: null,
    modified: false,
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
        nextActionFrom: surface.querySelector("[data-pipeline-from]").value,
        nextActionBefore: surface.querySelector("[data-pipeline-to]").value,
      };
    },
    applyControls({ view, stage, search, owner, sort, nextActionFrom, nextActionBefore, organizationId } = {}) {
      if (view !== undefined && PIPELINE_VIEW_IDS.includes(view)) {
        surface.querySelector("[data-pipeline-view]").value = view;
      }
      if (stage !== undefined) surface.querySelector("[data-crm-status]").value = stage;
      if (search !== undefined) surface.querySelector("[data-crm-search]").value = search;
      if (owner !== undefined) surface.querySelector("[data-pipeline-owner]").value = owner;
      if (sort !== undefined) surface.querySelector("[data-pipeline-sort]").value = sort === "recent" ? "recent" : "next-action";
      if (nextActionFrom !== undefined) surface.querySelector("[data-pipeline-from]").value = nextActionFrom;
      if (nextActionBefore !== undefined) surface.querySelector("[data-pipeline-to]").value = nextActionBefore;
      pipeline.org = organizationId || null;
    },
    writeUrl(cursor, isCurrent) {
      if (typeof activeView === "function" && activeView() !== "pipeline") return;
      if (surface.classList.contains("has-booking-detail")) return;
      if (typeof isCurrent === "function" && !isCurrent()) return;
      const controls = pipeline.controlValues();
      const params = {};
      if (controls.view && controls.view !== "actionable") params.view = controls.view;
      if (controls.stage) params.stage = controls.stage;
      if (controls.search) params.search = controls.search;
      if (controls.owner) params.owner = controls.owner;
      if (pipeline.org) params.organizationId = pipeline.org;
      if (controls.sort && controls.sort !== "next-action") params.sort = controls.sort;
      // Inclusive absolute bounds, labeled From/Through in the UI. Invalid or
      // reversed ranges 400 honestly at the API and surface via safe().
      if (controls.nextActionFrom) params.nextActionFrom = controls.nextActionFrom;
      if (controls.nextActionBefore) params.nextActionBefore = controls.nextActionBefore;
      if (pipeline.savedViewId) params.savedView = pipeline.savedViewId;
      if (cursor) params.cursor = cursor;
      rememberListParams("pipeline", params);
      navigateCanonicalWorkspace(sponsorsPath("pipeline"), params, { render: false, history: "replace" });
    },
    renderViews() {
      const slot = surface.querySelector("[data-pipeline-views]");
      if (!slot) return;
      slot.innerHTML = renderSavedViewBar({
        entity: "pipeline",
        views: pipeline.views,
        viewsError: pipeline.viewsError,
        selectedViewId: pipeline.savedViewId,
        updateViewId: pipeline.baseViewId,
        modified: pipeline.modified,
        escapeHtml,
      });
    },
    async ensureViews(isCurrent = capturePipelineCurrent()) {
      if (pipeline.views || pipeline.viewsError) return;
      const isSurfaceCurrent = captureSurfaceCurrent("pipeline");
      try {
        const response = await fetchViews(api, "pipeline", { paths: workspaceApi });
        if (!isSurfaceCurrent()) return;
        pipeline.views = response.items || [];
      } catch (error) {
        if (!isSurfaceCurrent() || !isCurrent()) return;
        pipeline.viewsError = `Saved views unavailable: ${error.message}`;
      }
      if (!isSurfaceCurrent()) return;
      pipeline.renderViews();
    },
    async applySavedView(id, isCurrent = capturePipelineCurrent()) {
      if (!isCurrent()) return;
      await pipeline.ensureViews(isCurrent);
      if (!isCurrent()) return;
      const resolved = resolveEffectiveFilters({
        entity: "pipeline",
        views: pipeline.views,
        viewsError: pipeline.viewsError,
        selectedViewId: id,
        urlState: {},
      });
      if (resolved.error) {
        if (!isCurrent()) return;
        showNotice(resolved.error);
        return;
      }
      pipeline.savedViewId = resolved.viewId;
      pipeline.baseViewId = resolved.viewId;
      pipeline.modified = false;
      const mapped = pipelineControlsFromFilters(resolved.filters, resolved.sort);
      pipeline.applyControls(mapped);
      pipeline.renderViews();
      await safe(() => pipeline.load(true, { isCurrent }), "Could not load pipeline");
    },
    async updateCurrentView(isCurrent = capturePipelineCurrent()) {
      if (!isCurrent()) return;
      const targetId = pipeline.savedViewId || pipeline.baseViewId;
      const current = pipeline.views?.find((view) => view.id === targetId && !isBuiltinView(view));
      if (!current) throw new Error("Select one of your views to update it");
      const controls = pipeline.controlValues();
      const filters = {};
      if (controls.view && controls.view !== "actionable") filters.view = controls.view;
      if (controls.stage) filters.stage = controls.stage;
      if (controls.search) filters.search = controls.search;
      if (controls.owner) filters.owner = controls.owner;
      if (controls.nextActionFrom) filters.nextActionFrom = controls.nextActionFrom;
      if (controls.nextActionBefore) filters.nextActionBefore = controls.nextActionBefore;
      if (pipeline.getOrg()) filters.organizationId = pipeline.getOrg();
      const sort = { field: controls.sort === "recent" ? "recent" : "next-action" };
      try {
        await updateSavedView(api, current.id, {
          name: current.name,
          filters,
          sort,
          ...(current.columns ? { columns: current.columns } : {}),
          version: current.version,
        }, { paths: workspaceApi });
      } catch (error) {
        if (!isCurrent()) return;
        throw error;
      }
      pipeline.views = null;
      pipeline.viewsError = null;
      if (!isCurrent()) return;
      await pipeline.ensureViews(isCurrent);
      if (!isCurrent()) return;
      await pipeline.applySavedView(current.id, isCurrent);
    },
    // A manual control edit unpins the selected saved view (the URL keeps
    // the effective filters, so the state stays shareable).
    controlsChanged(reload) {
      notePipelineIntent();
      if (pipeline.savedViewId || pipeline.baseViewId) {
        pipeline.savedViewId = null;
        pipeline.modified = Boolean(pipeline.baseViewId);
        pipeline.renderViews();
      }
      reload();
    },
    load(reset = true, extra = {}) {
      return reloadPipeline(reset, { ...(pipeline.org ? { organizationId: pipeline.org } : {}), ...extra });
    },
    // First paint from the URL: controls, saved views, then the first page
    // (deep-linked cursors included). Later control edits go through
    // controlsChanged + load so the URL stays canonical. Invented view/sort
    // enums are surfaced honestly instead of silently replaced: the operator
    // sees what was rejected and which default is showing.
    async initFromParams(isCurrent = capturePipelineCurrent()) {
      if (!isCurrent()) return;
      const p = listParamsByView.pipeline;
      const invalid = [];
      if (p.view !== undefined && !PIPELINE_VIEW_IDS.includes(p.view)) invalid.push(`view=${p.view}`);
      if (p.sort !== undefined && p.sort !== "recent" && p.sort !== "next-action") invalid.push(`sort=${p.sort}`);
      pipeline.applyControls({
        view: PIPELINE_VIEW_IDS.includes(p.view) ? p.view : undefined,
        stage: p.stage || "",
        search: p.search || "",
        owner: p.owner || "",
        sort: p.sort === "recent" ? "recent" : "next-action",
        nextActionFrom: p.nextActionFrom || "",
        nextActionBefore: p.nextActionBefore || "",
        organizationId: p.organizationId || "",
      });
      if (invalid.length) {
        showNotice(`Ignored invalid pipeline URL: ${invalid.join(", ")}. Showing defaults.`);
      }
      await pipeline.ensureViews(isCurrent);
      if (!isCurrent()) return;
      if (p.savedView) await pipeline.applySavedView(p.savedView, isCurrent);
      else await pipeline.load(true, { ...(p.cursor ? { cursor: p.cursor } : {}), isCurrent });
    },
  };
  const pipelineViewsSlot = surface.querySelector("[data-pipeline-views]");
  if (pipelineViewsSlot) {
    pipelineViewsSlot.addEventListener("click", (event) => {
      if (event.target.closest("[data-views-retry]")) {
        notePipelineIntent();
        const isCurrent = capturePipelineCurrent();
        safe(async () => {
          pipeline.views = null;
          pipeline.viewsError = null;
          await pipeline.ensureViews(isCurrent);
        }, "Could not load saved views");
        return;
      }
      if (event.target.closest("[data-views-save]")) {
        openViewsDialog("pipeline", "save");
        return;
      }
      if (event.target.closest("[data-views-update]")) {
        notePipelineIntent();
        const isCurrent = capturePipelineCurrent();
        safe(() => pipeline.updateCurrentView(isCurrent), "Could not update saved view");
        return;
      }
      if (event.target.closest("[data-views-manage]")) {
        openViewsDialog("pipeline", "manage");
      }
    });
    pipelineViewsSlot.addEventListener("change", (event) => {
      const select = event.target.closest("[data-views-select]");
      if (!select) return;
      notePipelineIntent();
      const isCurrent = capturePipelineCurrent();
      safe(() => pipeline.applySavedView(select.value || null, isCurrent), "Could not apply saved view");
    });
  }
  return pipeline;
}
