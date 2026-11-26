import { html } from "./shared.js";
import { archiveDisclosureMarkup } from "./sponsor-record-markup.js";

/**
 * Lazy read-only communication archive for the selected deal
 * (CRM-PRESERVE-ARCHIVE). B's removal brief keeps existing sponsor records,
 * drafts and delivery history readable; D's unified activity does not include
 * the old SPONSOR_SEND_ATTEMPT/draft records, so the record exposes them in
 * a collapsed disclosure that loads once, on first open, through the
 * injected `loadArchive(dealId)` reader (E wires it to B's preserved read
 * paths/projection after the rebase). No draft/approve/cancel/reconcile
 * actions and no composer exist anywhere in this module.
 */

/**
 * Bounded archive pager. One explicit page per call — no silent multi-page
 * fan-out, no fake totals (`total` stays null unless the server provides
 * one), no dedupe (distinct draft versions are preserved even when they
 * share a communication id). Failed continuations keep the visible rows;
 * `retry()` resumes from the failed page.
 */
export function createArchiveLoader({ loadArchive, dealId, limit = 50 }) {
  if (typeof loadArchive !== "function") throw new Error("createArchiveLoader requires loadArchive (E-wired B read path)");
  const state = { status: "idle", items: [], nextCursor: null, total: null, error: "" };
  async function open() {
    if (state.status === "loading" || state.status === "loading-more" || state.status === "ready") return state;
    state.status = "loading";
    state.error = "";
    state.items = [];
    state.nextCursor = null;
    try {
      const result = await loadArchive(dealId, { limit });
      state.items = result.items || [];
      state.nextCursor = result.nextCursor ?? null;
      state.total = typeof result.total === "number" ? result.total : null;
      state.status = "ready";
    } catch (error) {
      state.status = "error";
      state.error = error?.message || "Could not load the archive";
    }
    return state;
  }
  async function loadMore() {
    if (!state.nextCursor || state.status === "loading" || state.status === "loading-more") return state;
    const cursor = state.nextCursor;
    state.status = "loading-more";
    state.error = "";
    try {
      const result = await loadArchive(dealId, { cursor, limit });
      state.items = [...state.items, ...(result.items || [])];
      state.nextCursor = result.nextCursor ?? null;
      if (typeof result.total === "number") state.total = result.total;
      state.status = "ready";
    } catch (error) {
      state.status = "error";
      state.error = error?.message || "Could not load older messages";
    }
    return state;
  }
  async function retry() {
    // Resume the failed page: a set cursor always continues the
    // continuation, even when the visible row count is zero (an empty first
    // page with a cursor is valid after recordType projection). Never reset
    // an in-flight request: only idle/error states may start a new fetch.
    if (state.nextCursor) return loadMore();
    if (state.status !== "idle" && state.status !== "error") return state;
    return open();
  }
  return { state, open, loadMore, retry };
}

/**
 * The record's archive disclosure: one loader per selected deal, painted
 * into the Activity tab's `[data-record-archive-host]`. The record is read
 * through `getRecord()` and guarded by the record's own `current(mine)` /
 * `generation()`, because the record it belongs to is replaced on every
 * open: a late response must never paint under another deal or generation.
 */
export function createRecordArchive({ context, getRecord, current, generation }) {
  function archiveLoaderFor() {
    const record = getRecord();
    if (typeof context.loadArchive !== "function" || !record?.selectedDeal) return null;
    const key = `archive:${record.selectedDeal.id}`;
    if (!record.archiveLoaders) record.archiveLoaders = new Map();
    if (!record.archiveLoaders.has(key)) {
      record.archiveLoaders.set(key, createArchiveLoader({ loadArchive: context.loadArchive, dealId: record.selectedDeal.id }));
    }
    return record.archiveLoaders.get(key);
  }

  function paintArchive(target, loader) {
    const host = target.querySelector("[data-record-archive-host]");
    if (!host) return;
    const record = getRecord();
    const active = loader || archiveLoaderFor();
    if (!record?.selectedDeal) {
      host.innerHTML = html`<details data-record-archive>
        <summary>Archived drafts and delivery history</summary>
        <div class="honest-state">
          <strong>No deal selected</strong>
          <p>Select a deal to see its archived drafts and delivery history.</p>
        </div>
      </details>`;
      return;
    }
    record.archiveLoader = active;
    host.innerHTML = archiveDisclosureMarkup(active?.state || { status: "idle" }, context);
  }

  function wireArchive(target) {
    const host = target.querySelector("[data-record-archive-host]");
    if (!host || host.dataset.wiredArchive) return;
    host.dataset.wiredArchive = "true";
    // The native details toggle event does NOT bubble (verified by probe:
    // bubble 0, capture 1), so the host listener must use the capture phase.
    // Listeners live on the persistent host: paintArchive replaces the
    // disclosure node on every state change, so node-level listeners
    // would be lost after the first render.
    const fail = typeof context.safe === "function" ? context.safe : async (action) => action();
    // Current generation + selected-deal identity are captured before every
    // await; a late response paints only when the same deal is still
    // selected in the same record generation — never under deal B.
    const guard = (mine, dealId, loader) =>
      current(mine) && getRecord()?.selectedDeal?.id === dealId && archiveLoaderFor() === loader;
    host.addEventListener("toggle", async (event) => {
      const disclosure = event.target.closest("[data-record-archive]");
      if (!disclosure || !disclosure.open) return;
      const loader = archiveLoaderFor();
      if (!loader || loader.state.status !== "idle") return;
      const mine = generation();
      const dealId = getRecord().selectedDeal.id;
      // Paint the loading state immediately; the guarded paint after the
      // await renders the result only for the current deal+generation.
      const pending = loader.open();
      paintArchive(target, loader);
      await fail(async () => {
        await pending;
        if (!guard(mine, dealId, loader)) return;
        paintArchive(target, loader);
      }, "Could not load the archive");
    }, true);
    host.addEventListener("click", async (event) => {
      const more = event.target.closest("[data-archive-more]");
      if (more) {
        const loader = archiveLoaderFor();
        if (!loader) return;
        const mine = generation();
        const dealId = getRecord().selectedDeal.id;
        await fail(async () => {
          const pending = loader.loadMore();
          paintArchive(target, loader);
          await pending;
          if (!guard(mine, dealId, loader)) return;
          paintArchive(target, loader);
        }, "Could not load older messages");
        return;
      }
      const retry = event.target.closest("[data-archive-retry]");
      if (retry) {
        const loader = archiveLoaderFor();
        if (!loader) return;
        const mine = generation();
        const dealId = getRecord().selectedDeal.id;
        await fail(async () => {
          const pending = loader.retry();
          paintArchive(target, loader);
          await pending;
          if (!guard(mine, dealId, loader)) return;
          paintArchive(target, loader);
        }, "Could not load the archive");
        return;
      }
      const review = event.target.closest("[data-archive-review]");
      if (!review || typeof context.onReviewDraft !== "function") return;
      const dealId = getRecord()?.selectedDeal?.id;
      await fail(async () => {
        if (getRecord()?.selectedDeal?.id !== dealId) return;
        return context.onReviewDraft(review.dataset.archiveReview, Number(review.dataset.archiveVersion));
      }, "Could not open the exact preview");
    });
  }

  return { archiveLoaderFor, paintArchive, wireArchive };
}
