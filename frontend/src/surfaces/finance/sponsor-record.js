import { html } from "./shared.js";
import {
  activityPanelMarkup,
  createActivityLoader,
  wireActivityPanel,
} from "./sponsor-activity.js";
import { createRecordArchive } from "./sponsor-record-archive.js";
import {
  RECORD_TABS,
  dealHeaderMarkup,
  dealOverviewMarkup,
  dealsListMarkup,
  emptyMarkup,
  errorMarkup,
  loadingMarkup,
  overviewMarkup,
  peopleListMarkup,
  deleteDealDialogMarkup,
  deleteCompanyDialogMarkup,
  recordHeaderMarkup,
  recordTabsMarkup,
} from "./sponsor-record-markup.js";

/**
 * Company/deal record with progressive disclosure.
 *
 * Tabs: Overview · People · Activity · Deals · Finance. Only the visible tab
 * fetches. Nothing here pages whole directories: the People tab fetches
 * GET /directory/people?company=:id (bounded), the Deals tab fetches
 * GET /deals?organizationId=:id (bounded), Activity fetches
 * GET /activity/organization/:id (bounded, filterable), and Overview fetches
 * only the company projection plus an activity preview (limit 3, server-side
 * merge, no full bodies). Finance renders through the injected canonical
 * loader on first tab open per selected deal.
 *
 * Two shapes, decided by how the record is opened. Without a deal it is the
 * company record. With a dealId (/sponsors/deals/:id, a Pipeline row, an
 * alert) it is that exact deal: the deal is the header identity and the
 * Overview, Activity and the archived drafts are the deal's, while the
 * company stays one click away as context.
 *
 * Data shapes consumed (defensive: every field optional):
 *   GET /directory/companies/:id (D projection: direct lookup + summary/notes,
 *     no finance/mail/deal bodies)
 *     { id, displayName, domain, relationship, active, primaryPerson
 *       { id, name, email } | null, notes, lastTouch, lastInboundAt,
 *       lastOutboundAt, openDealCount, version, updatedAt }
 *   GET /directory/people?company=&limit=&cursor= -> { items, total, nextCursor }
 *     person: { id, organizationId, name, emails[], primary, role, linkedin,
 *       telegram, notes, lastTouch, lastInboundAt, lastOutboundAt,
 *       lastContactedAt, active, version, updatedAt } (flat A fields, never a
 *       channels object)
 *   GET /deals?organizationId=&limit=&cursor= -> { items, nextCursor }
 *   GET /deals/:id -> the decorated deal { id, organizationId, title,
 *     status, productKind, amountEur, openTasks[], finance, contract, ... }
 *   GET /pipeline?view=all&organizationId=&limit=100 -> { items } whose rows
 *     carry the stage and nextTask shown on the Pipeline row
 *
 * E (directory/navigation owner) provides: mount root
 * `[data-crm-record]`, `closeRecord` (canonical Back restoring list
 * filters/page/scroll + focus), `loadFinance(deal, panel)`, and optional
 * `openContactEditor`, `openTaskPanel`, `openCompanyRecord`,
 * `openLinkedRecord(kind, id)` (reopens the record on another deal or on the
 * company while keeping the list origin for Back), `onEditCompany`,
 * `onAddDeal`. F owns this render/controller implementation.
 */

/**
 * Company/deal record controller. Renders into
 * `surface.querySelector("[data-crm-record]")` (E-owned mount).
 */
export function createSponsorRecord(context) {
  const { api, surface, closeRecord, loadFinance } = context;
  if (typeof api !== "function") throw new Error("createSponsorRecord requires api");
  if (!surface) throw new Error("createSponsorRecord requires surface");
  if (typeof closeRecord !== "function") throw new Error("createSponsorRecord requires closeRecord (E integration)");
  if (typeof loadFinance !== "function") throw new Error("createSponsorRecord requires loadFinance (canonical finance component)");
  const fail = typeof context.safe === "function" ? context.safe : async (action) => action();
  const canEditPerson = typeof context.openContactEditor === "function";
  let record = null;
  let token = 0;
  let closer = (...args) => closeRecord(...args);

  // Per-invocation render guard (E page-generation/isCurrent seam): the
  // token covers same-controller races; the injected predicate covers
  // cross-page navigation that leaves this controller alive. Every async
  // continuation checks current() after each await and before shared
  // flags/error/DOM/focus writes.
  const current = (mine) =>
    mine === undefined ||
    (mine === token && record && (!record.isCurrent || record.isCurrent() !== false));
  // The selected deal's read-only archive disclosure on the Activity tab.
  const archive = createRecordArchive({ context, getRecord: () => record, current, generation: () => token });

  function closeWith(next) {
    if (typeof next === "function") closer = next;
  }

  function root() {
    return surface.querySelector("[data-crm-record]");
  }

  function panel(name) {
    return root()?.querySelector(`[data-record-panel="${name}"]`);
  }

  function paintTabs(active) {
    // Update the existing buttons in place: replacing the tablist markup
    // here would nest a new tablist inside the current one.
    const tabs = root()?.querySelector("[data-record-tabs]");
    if (!tabs) return;
    for (const button of tabs.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset?.recordTab === active;
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("tabindex", selected ? "0" : "-1");
    }
  }

  function showTab(active) {
    for (const [id] of RECORD_TABS) {
      const section = panel(id);
      if (section) section.hidden = id !== active;
    }
    paintTabs(active);
    if (record) record.activeTab = active;
  }

  function headerOptions() {
    return {
      selectedDeal: record?.selectedDeal || null,
      returnLabel: record?.returnLabel || "Back",
      canEdit: typeof context.onEditCompany === "function",
      // E asked for Archive/Restore in the record header (old per-row list
      // Archive goes away with integration); the buttons render only when
      // the migration wires the handlers.
      canArchive: typeof context.onArchiveCompany === "function" || typeof context.onRestoreCompany === "function",
      // Admin-only permanent delete through the same hard-delete route the
      // CLI uses; the button renders only when the handler is wired.
      canDelete: typeof context.onDeleteCompany === "function",
    };
  }

  function headerMarkup() {
    const { returnLabel } = headerOptions();
    // A deal-first record leads with its deal. When that deal could not be
    // resolved, the company header still gives the page an identity and Back.
    return record.dealMode && record.selectedDeal
      ? dealHeaderMarkup({
        deal: record.selectedDeal, company: record.company, row: record.row, returnLabel,
      }, context)
      : recordHeaderMarkup(record.company, headerOptions(), context);
  }

  function paintHeader() {
    const header = root()?.querySelector("[data-record-header]");
    if (!header || !record) return;
    // A deal's Pipeline facts arrive after its shell opened. Rebuilding the
    // header then must not drop the focus its title took.
    const hadFocus = typeof header.contains === "function" && header.contains(globalThis.document?.activeElement);
    header.innerHTML = headerMarkup();
    if (hadFocus) header.querySelector("[data-record-title]")?.focus?.({ preventScroll: true });
  }

  function shellMarkup(active) {
    return html`<div data-record-header>${headerMarkup()}</div>
      ${recordTabsMarkup(active, context, { label: record.dealMode ? "Deal record sections" : "Company record sections" })}
      ${RECORD_TABS.map(
        ([id]) => html`<section role="tabpanel" id="record-panel-${id}" aria-labelledby="record-tab-${id}"
          data-record-panel="${id}"${id === active ? "" : " hidden"}></section>`,
      ).join("")}
      ${context.onDeleteDeal ? deleteDealDialogMarkup() : ""}
      ${!record.dealMode && context.onDeleteCompany ? deleteCompanyDialogMarkup() : ""}`;
  }

  async function openCompany(companyId, { dealId = null, returnLabel = "Back", isCurrent = null } = {}) {
    const mine = ++token;
    const host = root();
    if (!host) throw new Error("createSponsorRecord: missing [data-crm-record] mount (E integration)");
    record = {
      companyId, company: null, deals: [], selectedDealId: dealId,
      // A record opened on one deal is that deal's page; see the module note.
      dealMode: Boolean(dealId),
      isCurrent: typeof isCurrent === "function" ? isCurrent : null,
      selectedDeal: null, activeTab: "overview", returnLabel,
      row: null, factsLoaded: false, factsTried: false, selectionError: null,
      loaded: new Set(), cursors: {}, people: [], dealsLoaded: false,
      preview: { items: [], relatedWork: [] },
    };
    host.innerHTML = loadingMarkup(record.dealMode ? "Loading deal" : "Loading company", context);
    const settle = (read) => Promise.resolve().then(read).then((value) => ({ value }), (error) => ({ error }));
    // The company summary is D's cheap projection (GET
    // /directory/companies/:id): direct lookup + notes, no finance/mail/deal
    // bodies. No snapshot fallback and no legacy single-record enrichment —
    // a missing D route is an honest error, never a silent downgrade.
    // An exact deal is read by its ID beside it, so the deal page never
    // depends on which page of the company's deals happens to be loaded.
    const [companyResult, dealResult] = await Promise.all([
      settle(() => api(`/directory/companies/${encodeURIComponent(companyId)}`)),
      dealId ? settle(() => api(`/deals/${encodeURIComponent(dealId)}`)) : null,
    ]);
    if (!current(mine)) return record;
    if (companyResult.error) {
      host.innerHTML = companyResult.error?.status === 404
        ? emptyMarkup("Company not found", "It may have been archived or removed.", context)
        : errorMarkup(companyResult.error?.message, context);
      return record;
    }
    record.company = companyResult.value || {};
    const deal = dealResult?.value || null;
    if (dealResult?.error) {
      record.selectionError = dealResult.error?.status === 404
        ? `Deal ${dealId} was not found.`
        : `Deal ${dealId} could not be loaded: ${dealResult.error?.message || "unknown error"}.`;
    } else if (deal && deal.organizationId !== companyId) {
      record.selectionError = `Deal ${dealId} does not belong to this company.`;
    } else if (deal) {
      record.selectedDeal = deal;
      // Seeded so the header's Edit/Delete and selection resolve without the
      // Deals tab; the tab's own page replaces it when it loads.
      record.deals = [deal];
    }
    // The deal's row facts come before its header renders (best effort), so
    // the stage and next action are the Pipeline's from the first paint.
    if (record.dealMode && record.selectedDeal) await loadDealFacts(mine);
    if (!current(mine)) return record;
    host.innerHTML = shellMarkup(record.activeTab);
    host.querySelector("[data-record-title]")?.focus?.();
    await loadOverview(mine);
    return record;
  }

  async function loadOverview(mine) {
    if (!current(mine)) return;
    const target = panel("overview");
    if (!target || !record) return;
    return record.dealMode ? loadDealOverview(mine, target) : loadCompanyOverview(mine, target);
  }

  /**
   * The deal's Pipeline row: the stage and the next action shown on the row
   * the operator clicked, from the same read the list uses. Best effort: read
   * once per record before the page renders, so the header never flips; when
   * the read fails the page shows the deal from its own record, and Retry
   * (which clears factsTried) reads it again.
   */
  async function loadDealFacts(mine) {
    if (!record || record.factsLoaded || record.factsTried) return;
    record.factsTried = true;
    try {
      const query = new URLSearchParams({ view: "all", organizationId: record.companyId, limit: "100" });
      const result = await api(`/pipeline?${query}`);
      if (!current(mine) || !record) return;
      record.row = (result.items || []).find((item) => item.id === record.selectedDealId) || null;
      record.factsLoaded = true;
    } catch {
      // The deal record's own status and open Tasks stand in.
    }
  }

  async function loadDealOverview(mine, target) {
    if (!record.selectedDeal) {
      target.innerHTML = errorMarkup(record.selectionError || "Deal could not be loaded.", context);
      return;
    }
    target.innerHTML = loadingMarkup("Loading deal overview", context);
    const dealId = record.selectedDeal.id;
    // The deal's own timeline, notes and open Tasks: a company timeline
    // never counts a deal's Tasks, which is why a deal page cannot read one.
    const loader = createActivityLoader({ api, targetType: "deal", targetId: dealId, limit: 3 });
    await Promise.all([loader.load(), loadDealFacts(mine)]);
    if (!current(mine) || !record || record.selectedDealId !== dealId) return;
    paintHeader();
    if (loader.state.status === "error") {
      // Unknown, not empty: the deal's facts stay, nothing claims what the
      // unloaded activity would have shown.
      target.innerHTML = dealOverviewMarkup({
        deal: record.selectedDeal, company: record.company, row: record.row,
        activityError: loader.state.error,
      }, context);
      return;
    }
    record.preview = { items: loader.state.items, relatedWork: loader.state.relatedWork };
    target.innerHTML = dealOverviewMarkup({
      deal: record.selectedDeal, company: record.company, row: record.row,
      recent: loader.state.items.slice(0, 3), relatedWork: loader.state.relatedWork,
    }, context);
    record.loaded.add("overview");
  }

  async function loadCompanyOverview(mine, target) {
    target.innerHTML = loadingMarkup("Loading overview", context);
    const loader = createActivityLoader({
      api, targetType: "organization", targetId: record.companyId, limit: 3,
    });
    await loader.load();
    if (!current(mine) || !record) return;
    if (loader.state.status === "error") {
      // Unknown, not empty: render no content claims, only the error.
      target.innerHTML = overviewMarkup({
        company: record.company, activityError: loader.state.error,
      }, context);
      return;
    }
    record.preview = { items: loader.state.items, relatedWork: loader.state.relatedWork };
    target.innerHTML = overviewMarkup({
      company: record.company,
      primaryPerson: record.company.primaryPerson,
      // D rev 4 orders relatedWork eligible-first with an exact boolean;
      // consume it strictly (no older-shape fallback — no compat shims).
      nextTask: loader.state.relatedWork.find((task) => task.eligible === true) || null,
      recent: loader.state.items.slice(0, 3),
      relatedWork: loader.state.relatedWork,
    }, context);
    record.loaded.add("overview");
  }

  async function loadPeople(mine) {
    const target = panel("people");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading people", context);
    try {
      const query = new URLSearchParams({ company: record.companyId, limit: "30" });
      const append = Boolean(record.cursors.people);
      if (append) query.set("cursor", record.cursors.people);
      const result = await api(`/directory/people?${query}`);
      if (!current(mine)) return;
      const items = append ? [...(record.people || []), ...(result.items || [])] : (result.items || []);
      record.people = items;
      record.cursors.people = result.nextCursor ?? null;
      target.innerHTML = peopleListMarkup({ items, total: result.total, canEdit: canEditPerson }, context)
        + (record.cursors.people
          ? html`<button type="button" data-people-more>Show more people</button>`
          : "");
      record.loaded.add("people");
    } catch (error) {
      if (!current(mine)) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  async function loadActivity(mine) {
    const target = panel("activity");
    if (!target || !record) return;
    // One loader + one wiring per record: rapid Activity clicks reuse them
    // instead of duplicating fetches and listeners.
    if (!record.activityLoader) {
      // A deal-first record reads its deal's own timeline and notes; the
      // company record reads the company's.
      const targetType = record.dealMode ? "deal" : "organization";
      record.activityLoader = createActivityLoader({
        api, targetType, targetId: targetType === "deal" ? record.selectedDealId : record.companyId,
      });
      const withArchive = typeof context.loadArchive === "function";
      target.innerHTML = activityPanelMarkup({ targetType })
        + (withArchive ? html`<div data-record-archive-host></div>` : "");
      record.activityWired = wireActivityPanel(target, record.activityLoader, {
        ...context,
        openTaskPanel: typeof context.openTaskPanel === "function" ? context.openTaskPanel : undefined,
      });
      if (withArchive) {
        archive.paintArchive(target, null);
        archive.wireArchive(target);
      }
    }
    // Single-flight: a second click while the first page is in flight is a
    // no-op; the stale-generation check below runs before any shared flag
    // mutation so a deferred load can never clear a newer request's flag.
    if (record.loaded.has("activity") || record.activityLoading) return;
    record.activityLoading = true;
    record.activityWired.paint();
    await record.activityLoader.load();
    if (!current(mine)) return;
    record.activityLoading = false;
    record.activityWired.paint();
    if (record.activityLoader.state.status === "ready") record.loaded.add("activity");
  }
  async function loadDeals(mine) {
    const target = panel("deals");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading deals", context);
    try {
      if (!record.dealsLoaded) {
        const query = new URLSearchParams({ organizationId: record.companyId, limit: "50" });
        const append = Boolean(record.cursors.deals);
        if (append) query.set("cursor", record.cursors.deals);
        const result = await api(`/deals?${query}`);
        if (!current(mine)) return;
        record.deals = append ? [...(record.deals || []), ...(result.items || [])] : (result.items || []);
        record.cursors.deals = result.nextCursor ?? null;
        if (!record.cursors.deals) record.dealsLoaded = true;
      }
      await resolveSelection(mine);
      if (!current(mine)) return;
      paintDeals(target);
      record.loaded.add("deals");
      if (record.loaded.has("activity") && typeof context.loadArchive === "function") {
        const activityPanel = panel("activity");
        if (activityPanel) {
          archive.paintArchive(activityPanel, null);
          archive.wireArchive(activityPanel);
        }
      }
    } catch (error) {
      if (!current(mine)) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  /**
   * Resolve the selected deal with an explicit failure memory (review
   * finding 1): a deep-linked deal that is absent from the loaded page is
   * fetched independently by ID. When that fetch fails (missing, wrong
   * company, unreadable), the requested ID is preserved as an error and
   * finance is NEVER pointed at an unrelated first-page fallback. The page
   * fallback applies only when no deal was originally requested.
   */
  async function resolveSelection(mine) {
    if (!record) return;
    if (record.selectedDealId) {
      const onPage = (record.deals || []).find((deal) => deal.id === record.selectedDealId);
      if (onPage) {
        record.selectedDeal = onPage;
        record.selectionError = null;
        return;
      }
      // An exact deal link already resolved its deal by ID when it opened.
      if (record.selectedDeal?.id === record.selectedDealId) return;
      try {
        const deal = await api(`/deals/${encodeURIComponent(record.selectedDealId)}`);
        if (!current(mine)) return;
        if (deal && deal.organizationId === record.companyId) {
          record.selectedDeal = deal;
          record.selectionError = null;
          return;
        }
        record.selectionError = `Deal ${record.selectedDealId} does not belong to this company.`;
      } catch (error) {
        if (!current(mine)) return;
        record.selectionError = error?.status === 404
          ? `Deal ${record.selectedDealId} was not found.`
          : `Deal ${record.selectedDealId} could not be loaded: ${error?.message || "unknown error"}.`;
      }
      if (!current(mine)) return;
      record.selectedDeal = null;
      return;
    }
    record.selectionError = null;
    const fallback = (record.deals || []).find((deal) => deal.status !== "lost") || (record.deals || [])[0] || null;
    record.selectedDealId = fallback?.id || null;
    record.selectedDeal = fallback;
  }

  /**
   * The company's deals. In a deal-first record the list is the way between
   * them, so the open deal reads "This deal" and the others "Open deal".
   */
  function dealsMarkup() {
    return dealsListMarkup({
      deals: record.deals,
      selectedDealId: record.selectedDealId,
      canAdd: typeof context.onAddDeal === "function",
      ...(record.dealMode
        ? { open: true, heading: `Deals from ${record.company?.displayName || "this company"}` }
        : {}),
    }, context);
  }

  function paintDeals(target) {
    if (!record) return;
    target.innerHTML = dealsMarkup()
      + (record.selectionError ? errorMarkup(record.selectionError, context) : "")
      + (!record.dealsLoaded && record.cursors.deals
        ? html`<button type="button" data-deals-more>Show more deals</button>`
        : "");
    paintHeader();
  }

  /**
   * Invalidate every pending load (source-review finding 5): Back/destroy
   * must never let a stale response render into a closed record or
   * overwrite a newer selection/finance panel.
   */
  function destroy() {
    token += 1;
    record = null;
  }

  async function loadFinanceTab(mine) {
    const target = panel("finance");
    if (!target || !record) return;
    // Stale first: return immediately on !current(mine) before inspecting
    // or painting the current record.
    if (!current(mine)) return;
    if (!record.selectedDeal) {
      // Selection is deal-driven; without the Deals tab there may be no
      // selection yet — resolve it cheaply here without a full load.
      await loadDeals(mine);
      if (!current(mine)) return;
      if (!record?.selectedDeal) {
        // A failed explicit selection is an error, never a fallback deal's
        // finance: errorMarkup carries the record-retry hook which
        // re-attempts the independent fetch.
        target.innerHTML = record.selectionError
          ? errorMarkup(record.selectionError, context)
          : emptyMarkup("No deal selected", "Select a deal to load finance.", context);
        return;
      }
    }
    const deal = record.selectedDeal;
    const cacheKey = `finance:${deal.id}`;
    if (record.loaded.has(cacheKey)) return;
    // The canonical finance component renders into its own
    // [data-booking-panel="finance"] hook; the tab hosts that hook instead
    // of forking finance rendering.
    target.innerHTML = html`<div data-booking-panel="finance">${loadingMarkup("Loading finance", context)}</div>`;
    // One captured per-invocation predicate for BOTH the renderer and the
    // cache mark: if the selection moves A→B mid-request, the renderer
    // skips AND the cache stays unmarked, so returning to A refetches
    // instead of wrongly skipping its never-painted render.
    const isCurrent = () => current(mine) && record?.selectedDeal?.id === deal.id;
    try {
      // Thread the invocation predicate into the canonical renderer so its
      // own post-fetch paint/bind is guarded too.
      await loadFinance(deal, { isCurrent });
      if (!isCurrent()) return;
      record.loaded.add(cacheKey);
    } catch (error) {
      if (!isCurrent()) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  async function switchTab(name) {
    if (!record || !RECORD_TABS.some(([id]) => id === name)) return;
    const mine = token;
    showTab(name);
    if (name === "overview" && !record.loaded.has("overview")) return loadOverview(mine);
    if (name === "people" && !record.loaded.has("people")) return loadPeople(mine);
    if (name === "activity" && !record.loaded.has("activity")) return loadActivity(mine);
    if (name === "deals" && !record.loaded.has("deals")) return loadDeals(mine);
    if (name === "finance") return loadFinanceTab(mine);
    return undefined;
  }

  function selectDeal(dealId) {
    if (!record) return;
    const deal = record.deals.find((item) => item.id === dealId);
    if (!deal) return;
    record.selectedDealId = deal.id;
    record.selectedDeal = deal;
    record.selectionError = null;
    record.loaded.delete(`finance:${record.selectedDealId}`);
    for (const key of [...record.loaded]) {
      if (key.startsWith("finance:")) record.loaded.delete(key);
    }
    paintHeader();
    const dealsPanel = panel("deals");
    if (dealsPanel && record.loaded.has("deals")) {
      dealsPanel.innerHTML = dealsMarkup();
    }
    if (record.activeTab === "finance") {
      const mine = token;
      loadFinanceTab(mine);
    }
    if (record.loaded.has("activity") && typeof context.loadArchive === "function") {
      const activityPanel = panel("activity");
      if (activityPanel) {
        archive.paintArchive(activityPanel, null);
        archive.wireArchive(activityPanel);
      }
    }
  }

  function wire(host) {
    host.addEventListener("click", async (event) => {
      const back = event.target.closest("[data-record-back]");
      if (back) {
        destroy();
        closer();
        return;
      }
      const tab = event.target.closest("[data-record-tab]");
      if (tab) {
        await fail(() => switchTab(tab.dataset.recordTab), "Could not open section");
        return;
      }
      // The deal page's way up to its company record. E opens it in place
      // and keeps the list origin, so Back there still returns to the list.
      const companyLink = event.target.closest("[data-record-company]");
      if (companyLink) {
        if (!record?.companyId) return;
        if (typeof context.openLinkedRecord === "function") context.openLinkedRecord("company", record.companyId);
        else if (typeof context.openCompanyRecord === "function") context.openCompanyRecord(record.companyId);
        return;
      }
      if (event.target.closest("[data-goto-people]")) {
        await fail(() => switchTab("people"), "Could not open section");
        return;
      }
      const retry = event.target.closest("[data-record-retry]");
      if (retry) {
        // A retry after a failure must refetch rather than repaint the
        // error, so drop the loaded marker (and any finance cache) first.
        fail(async () => {
          if (!record) return;
          record.loaded.delete(record.activeTab);
          // A retry refetches: the section, its finance and a failed row read.
          record.factsTried = false;
          for (const key of [...record.loaded]) {
            if (key.startsWith("finance:")) record.loaded.delete(key);
          }
          await switchTab(record.activeTab);
        }, "Could not reload section");
        return;
      }
      const more = event.target.closest("[data-people-more]");
      if (more) {
        await fail(() => loadPeople(token), "Could not load more people");
        return;
      }
      const moreDeals = event.target.closest("[data-deals-more]");
      if (moreDeals) {
        await fail(async () => {
          if (!record) return;
          record.loaded.delete("deals");
          await switchTab("deals");
        }, "Could not load more deals");
        return;
      }
      const pick = event.target.closest("[data-select-deal]");
      if (pick) {
        const dealId = pick.dataset.selectDeal;
        if (record?.dealMode) {
          // Here the list moves between the company's deals: E reopens the
          // record on the chosen deal and records its URL, keeping the list
          // origin for Back.
          if (dealId === record.selectedDealId) return;
          if (typeof context.openLinkedRecord === "function") context.openLinkedRecord("deal", dealId);
          else await openCompany(record.companyId, { dealId, returnLabel: record.returnLabel, isCurrent: record.isCurrent });
          return;
        }
        selectDeal(dealId);
        return;
      }
      const downloadAttachment = event.target.closest("[data-download-attachment]");
      if (downloadAttachment) {
        const dealId = downloadAttachment.dataset.attachmentDeal;
        const attachmentId = downloadAttachment.dataset.downloadAttachment;
        if (!dealId || !attachmentId) return;
        await fail(async () => {
          const payload = await api(
            `/deals/${encodeURIComponent(dealId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
          );
          if (!payload?.downloadUrl) return;
          const origin = globalThis.window?.location?.origin || "https://dataops.local";
          const target = new URL(payload.downloadUrl, origin).toString();
          if (typeof context.openDownloadUrl === "function") context.openDownloadUrl(target, payload);
          else globalThis.window?.open?.(target, "_blank", "noopener");
        }, "Could not prepare attachment download");
        return;
      }
      const attachSubmit = event.target.closest("[data-attach-file-submit]");
      if (attachSubmit) {
        const dealId = attachSubmit.dataset.attachFileSubmit;
        const dealsPanel = panel("deals");
        const input = dealsPanel?.querySelector(`[data-attach-file-input="${dealId}"]`);
        const errEl = dealsPanel?.querySelector(`[data-attachment-error="${dealId}"]`);
        const file = input?.files?.[0];
        if (!file) {
          if (errEl) errEl.textContent = "Choose a file to upload.";
          return;
        }
        if (errEl) errEl.textContent = "";
        const mine = token;
        await fail(async () => {
          const form = new FormData();
          form.append("file", file, file.name);
          const created = await api(`/deals/${encodeURIComponent(dealId)}/attachments`, {
            method: "POST",
            body: form,
          });
          if (!current(mine) || !record) return;
          const deal = (record.deals || []).find((item) => item.id === dealId);
          if (deal && created?.attachment) {
            deal.attachments = [created.attachment, ...(deal.attachments || [])];
            paintDeals(panel("deals"));
          }
        }, "Could not upload attachment");
        return;
      }
      const deleteAttachment = event.target.closest("[data-delete-attachment]");
      if (deleteAttachment) {
        const dealId = deleteAttachment.dataset.attachmentDeal;
        const attachmentId = deleteAttachment.dataset.deleteAttachment;
        if (!dealId || !attachmentId) return;
        const mine = token;
        await fail(async () => {
          await api(`/deals/${encodeURIComponent(dealId)}/attachments/${encodeURIComponent(attachmentId)}`, {
            method: "DELETE",
          });
          if (!current(mine) || !record) return;
          const deal = (record.deals || []).find((item) => item.id === dealId);
          if (deal) {
            deal.attachments = (deal.attachments || []).filter((item) => item.id !== attachmentId);
            paintDeals(panel("deals"));
          }
        }, "Could not delete attachment");
        return;
      }
      const deleteDeal = event.target.closest("[data-delete-deal]");
      if (deleteDeal && typeof context.onDeleteDeal === "function") {
        const deal = (record?.deals || []).find((item) => item.id === deleteDeal.dataset.deleteDeal);
        const dialog = root()?.querySelector("[data-delete-deal-dialog]");
        if (!deal || !dialog) return;
        dialog.dataset.dealId = deal.id;
        dialog.querySelector("[data-delete-deal-description]").textContent =
          "Permanently delete this deal with its history, notes, deliverables and Tasks? This cannot be undone.";
        dialog.querySelector("[data-delete-deal-error]").textContent = "";
        dialog.showModal();
        return;
      }
      const cancelDelete = event.target.closest("[data-delete-deal-cancel]");
      if (cancelDelete) {
        root()?.querySelector("[data-delete-deal-dialog]")?.close();
        return;
      }
      const confirmDelete = event.target.closest("[data-delete-deal-confirm]");
      if (confirmDelete && typeof context.onDeleteDeal === "function") {
        const dialog = root()?.querySelector("[data-delete-deal-dialog]");
        const deal = (record?.deals || []).find((item) => item.id === dialog?.dataset.dealId);
        if (!deal) return;
        try {
          await context.onDeleteDeal(deal);
          dialog.close();
        } catch (error) {
          dialog.querySelector("[data-delete-deal-error]").textContent = error?.message || "Could not delete the deal";
        }
        return;
      }
      const deleteCompany = event.target.closest("[data-delete-company]");
      if (deleteCompany && typeof context.onDeleteCompany === "function") {
        const dialog = root()?.querySelector("[data-delete-company-dialog]");
        if (!dialog || !record?.company) return;
        dialog.querySelector("[data-delete-company-description]").textContent =
          "Permanently delete this company with its history? This cannot be undone. " +
          "Deletion is refused while the company still has deals, linked contacts, notes or human touches.";
        dialog.querySelector("[data-delete-company-error]").textContent = "";
        dialog.showModal();
        return;
      }
      const cancelDeleteCompany = event.target.closest("[data-delete-company-cancel]");
      if (cancelDeleteCompany) {
        root()?.querySelector("[data-delete-company-dialog]")?.close();
        return;
      }
      const confirmDeleteCompany = event.target.closest("[data-delete-company-confirm]");
      if (confirmDeleteCompany && typeof context.onDeleteCompany === "function") {
        const dialog = root()?.querySelector("[data-delete-company-dialog]");
        if (!dialog || !record?.company) return;
        try {
          await context.onDeleteCompany(record.company);
          dialog.close();
          // The company record is gone: the Back/close lifecycle restores the
          // directory list (and refreshes it through E's closeRecord).
          destroy();
          closer();
        } catch (error) {
          dialog.querySelector("[data-delete-company-error]").textContent = error?.message || "Could not delete the company";
        }
        return;
      }
      const editDeal = event.target.closest("[data-edit-deal]");
      if (editDeal && typeof context.onEditDeal === "function") {
        // The actual loaded deal object (with its optimistic version) goes
        // to the editor — never a re-fetched or global-list fallback. The
        // open is awaited through fail like Add deal: a rejecting editor
        // surfaces operator feedback instead of an unhandled rejection.
        const mine = token;
        const deal = (record?.deals || []).find((item) => item.id === editDeal.dataset.editDeal);
        if (!deal) return;
        await fail(async () => {
          if (!current(mine) || !record) return;
          await context.onEditDeal(deal);
        }, "Could not open the deal editor");
        return;
      }
      if (event.target.closest("[data-add-deal]") && typeof context.onAddDeal === "function") {
        // Preassociate the new deal with the currently loaded company; the
        // generation guard keeps a stale panel from opening a dialog for a
        // record that has since navigated away.
        const mine = token;
        const companyId = record?.companyId;
        if (!companyId) return;
        await fail(async () => {
          if (!current(mine) || record?.companyId !== companyId) return;
          await context.onAddDeal(companyId);
        }, "Could not open the deal editor");
        return;
      }
      const editCompany = event.target.closest("[data-edit-company]");
      if (editCompany && typeof context.onEditCompany === "function") {
        const mine = token;
        const company = record?.company;
        if (!company?.id) return;
        await fail(async () => {
          if (!current(mine) || record?.companyId !== company.id) return;
          await context.onEditCompany(company);
        }, "Could not open the company editor");
        return;
      }
      const toggleDnc = event.target.closest("[data-toggle-company-dnc]");
      if (toggleDnc) {
        const company = record?.company;
        if (!company?.id) return;
        const isDnc = Boolean(company.doNotContact || (Array.isArray(company.tags) && company.tags.includes("do-not-contact")));
        let note;
        if (!isDnc) {
          note = window.prompt("Reason / note for Do-Not-Contact (optional):");
          if (note === null) return;
        }
        await fail(async () => {
          await api(`/organizations/${encodeURIComponent(company.id)}/dnc`, {
            method: "POST",
            body: JSON.stringify({ doNotContact: !isDnc, ...(note ? { note } : {}) }),
          });
          if (!record) return;
          if (typeof context.onRecordChanged === "function") {
            context.onRecordChanged({ ...company, doNotContact: !isDnc });
          }
          // The flag is persisted; reopen in place so the header shows the
          // company as stored now, back on the section that was open.
          const { activeTab } = record;
          await openCompany(record.companyId, {
            dealId: record.dealMode ? record.selectedDealId : null,
            returnLabel: record.returnLabel,
            isCurrent: record.isCurrent,
          });
          if (activeTab !== "overview") await switchTab(activeTab);
        }, "Could not update do-not-contact status");
        return;
      }
      const archive = event.target.closest("[data-archive-company]");
      if (archive && typeof context.onArchiveCompany === "function") {
        await fail(() => context.onArchiveCompany(), "Could not archive company");
        return;
      }
      const restore = event.target.closest("[data-restore-company]");
      if (restore && typeof context.onRestoreCompany === "function") {
        await fail(() => context.onRestoreCompany(), "Could not restore company");
        return;
      }
      const openTask = event.target.closest("[data-open-task]");
      if (openTask && typeof context.openTaskPanel === "function") {
        context.openTaskPanel(openTask.dataset.openTask);
        return;
      }
      const editPerson = event.target.closest("[data-edit-person]");
      if (editPerson && canEditPerson) {
        const person = (record?.people || []).find((item) => item.id === editPerson.dataset.editPerson);
        if (person) context.openContactEditor(person);
        return;
      }
      if (event.target.closest("[data-add-person]") && canEditPerson) {
        context.openContactEditor({ organizationId: record?.companyId });
        return;
      }
      const openPerson = event.target.closest("[data-open-person]");
      if (openPerson && typeof context.openCompanyRecord === "function") {
        // Person deep-links resolve through the primary People directory;
        // inside the record this opens the person via E navigation.
        context.openCompanyRecord({ personId: openPerson.dataset.openPerson });
      }
    });
    host.addEventListener("keydown", async (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (!tab) return;
      const ids = RECORD_TABS.map(([id]) => id);
      const index = ids.indexOf(tab.dataset.recordTab);
      let next = null;
      if (event.key === "ArrowRight") next = ids[(index + 1) % ids.length];
      else if (event.key === "ArrowLeft") next = ids[(index - 1 + ids.length) % ids.length];
      else if (event.key === "Home") next = ids[0];
      else if (event.key === "End") next = ids[ids.length - 1];
      else return;
      event.preventDefault();
      await fail(() => switchTab(next).then(() => {
        host.querySelector(`[data-record-tab="${next}"]`)?.focus?.();
      }), "Could not open section");
    });
  }

  function getSelectedDealId() {
    return record?.selectedDealId || null;
  }

  function getCompany() {
    return record?.company || null;
  }

  return { openCompany, switchTab, selectDeal, getSelectedDealId, getCompany, destroy, closeWith, wire };
}
