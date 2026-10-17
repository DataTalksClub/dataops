import { sponsorsPath } from "../../core/sponsor-routes.js";
import { pipelineControlsFromFilters } from "./sponsor-pipeline.js";
import {
  fetchViews,
  renderSavedViewBar,
  resolveEffectiveFilters,
} from "./sponsor-saved-views.js";

// Package E pipeline URL/filter/saved-view lifecycle, extracted unchanged
// from sponsor-directory-pages.js: filters, sort, page cursor and the
// selected saved view live in the URL (?view ?stage ?search ?owner
// ?organizationId ?sort ?cursor ?savedView). `view` is the D pipeline filter
// here; the saved-view id travels as `savedView`. Sort in the URL uses
// control values (next-action|recent) end to end. organizationId has no
// control: it rides as an extra API param through load() but stays in the
// canonical URL so a company-scoped view survives copy/reload.

const PIPELINE_VIEW_IDS = ["actionable", "active", "early", "overdue", "reply", "unscheduled", "all", "closed"];

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
  openViewsDialog,
  showNotice,
  workspaceApi,
}) {
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
    writeUrl(cursor) {
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
        modified: false,
        escapeHtml,
      });
    },
    async ensureViews() {
      if (pipeline.views || pipeline.viewsError) return;
      try {
        pipeline.views = (await fetchViews(api, "pipeline", { paths: workspaceApi })).items || [];
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
    // controlsChanged + load so the URL stays canonical. Invented view/sort
    // enums are surfaced honestly instead of silently replaced: the operator
    // sees what was rejected and which default is showing.
    async initFromParams() {
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
  return pipeline;
}
