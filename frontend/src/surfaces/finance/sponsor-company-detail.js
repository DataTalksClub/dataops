import { html } from "./shared.js";
import { createSponsorRecord } from "./sponsor-record.js";

/**
 * Company/deal record entry point (F-owned). Delegates rendering to the
 * progressive-disclosure record shell (sponsor-record.js): stable identity
 * header, accessible lazy tabs (Overview / People / Activity / Deals /
 * Finance), per-deal finance/archive caches, Back with list restoration.
 *
 * Old behavior removed here (no eager loads): the previous pane fetched
 * deal history + org messages + finance + communications on every open and
 * rendered all sections at once. Tabs now fetch only on open; People uses
 * the D paged directory; Activity uses the D unified timeline; Finance
 * reuses the canonical loader through its own hook; the archive disclosure
 * reads B-preserved communications (read-only).
 *
 * E owns the surrounding integration (routes, mount, list refresh, final
 * Back restoration): this module mounts into the existing [data-crm-detail]
 * pane. Back is E's directoryPages.closeRecord, injected as `closeRecord`
 * (required: a loud error names it when absent); the old navigate/listPath/
 * split/scroll Back lifecycle is removed, not duplicated. New optional ctx
 * (E one-line hunks): openTaskPanel, openContactEditor (from the sponsors.js
 * editor instance), ownerName (E ownerDirectory.name), loadArchive/onReviewDraft
 * overrides, onRecordChanged
 * (called with the updated org after a successful archive/restore so E can
 * refresh its directory context).
 * Until E passes openContactEditor, person edit affordances stay hidden.
 */
export function createSponsorCompanyDetail({
  api,
  surface,
  escapeHtml,
  humanizeOptionLabel,
  humanSponsorDate,
  closeRecord,
  onRecordChanged,
  sponsorCommunications,
  draw,
  openDeal,
  loadFinance,
  safe,
  openTaskPanel,
  openCompanyRecord,
  openContactEditor,
  ownerName,
  onEditDeal,
  loadArchive,
  onReviewDraft,
  onEditCompany,
  onAddDeal,
}) {
  const record = createSponsorRecord({
    api,
    surface,
    escapeHtml,
    humanizeOptionLabel,
    humanSponsorDate,
    safe,
    // E's directoryPages.closeRecord owns Back (focus/scroll/filter
    // restoration). No local navigate/listPath/split fallback lives here.
    closeRecord: (...args) => {
      if (typeof closeRecord !== "function") {
        throw new Error("createSponsorCompanyDetail requires E closeRecord (directoryPages.closeRecord)");
      }
      return closeRecord(...args);
    },
    loadFinance,
    openTaskPanel,
    openCompanyRecord: openCompanyRecord || (async (organizationId) => {
      await reopenCompanyDetail({ id: organizationId });
    }),
    openContactEditor,
    ownerName,
    loadArchive: loadArchive || defaultLoadArchive,
    onReviewDraft: onReviewDraft || onReviewDraftDefault,
    onArchiveCompany,
    onRestoreCompany,
    // Edit uses E's existing deal dialog via openDeal with the actual loaded
    // deal (object + optimistic version); error/conflict surfacing and the
    // post-save refresh stay in E's dialog wiring.
    // The record shows the guard error (409: booked slot, deliverable,
    // finance) in its confirm dialog when this rejects.
    onDeleteDeal,
    onEditDeal: onEditDeal || ((deal) => openDeal(deal)),
    onAddDeal: onAddDeal || ((organizationId) => openDeal({ organizationId, status: "open" })),
    onEditCompany,
  });

  async function defaultLoadArchive(dealId, { cursor = "", limit = 50 } = {}) {
    // B-preserved read path (GET deals/:id/communications, body-free),
    // projected to the archive shape E confirmed. One bounded page per
    // call — no silent multi-page fan-out, no fake totals (the endpoint
    // provides no total, so none is claimed). Read-only: no
    // draft/approve/cancel/reconcile affordances are produced or consumed.
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const result = await api(`/deals/${encodeURIComponent(dealId)}/communications?${query}`);
    const items = [];
    for (const item of result.items || []) {
      if (item.recordType !== "communication-draft-version" && item.recordType !== "sponsor-send-attempt") continue;
      items.push({
        id: String(item.communicationId || item.id),
        kind: item.recordType,
        label: item.recordType === "communication-draft-version"
          ? `Archived draft v${item.version ?? "?"}`
          : `Delivery ${item.derivedStatus || item.status || "record"}`,
        preview: item.safeReason || item.derivedStatus || item.status || "",
        detail: typeof item.snippet === "string" ? item.snippet : undefined,
        createdAt: item.createdAt || item.updatedAt || null,
        version: item.version,
        reviewable: Boolean(item.reviewable),
      });
    }
    return { items, nextCursor: result.nextCursor || null, total: null };
  }

  async function onReviewDraftDefault(communicationId, version) {
    // Read-only exact preview through B's preserved review flow (no sends,
    // no composer). The dialog and its revoke/immutability behavior are
    // E-owned sponsors.js/layout territory; the record only opens it.
    if (typeof sponsorCommunications?.showExactReview !== "function") return;
    await sponsorCommunications.showExactReview(communicationId, Number(version));
    surface.querySelector("[data-communication-review-dialog]")?.querySelector("[data-review-close]")?.focus?.();
  }

  async function onArchiveCompany() {
    const company = record.getCompany();
    if (!company) return;
    const updated = await api(`/organizations/${encodeURIComponent(company.id)}`, { method: "DELETE" });
    if (typeof onRecordChanged === "function") await onRecordChanged(updated);
    await reopenCompanyDetail({ id: company.id }, record.getSelectedDealId());
  }

  async function onDeleteDeal(deal) {
    await api(`/deals/${encodeURIComponent(deal.id)}?hard=true&expectedVersion=${encodeURIComponent(deal.version)}`, { method: "DELETE" });
    if (typeof onRecordChanged === "function") await onRecordChanged({ id: deal.organizationId });
    await reopenCompanyDetail({ id: deal.organizationId });
  }

  async function onRestoreCompany() {
    const company = record.getCompany();
    if (!company) return;
    const updated = await api(`/organizations/${encodeURIComponent(company.id)}`, {
      method: "PUT",
      body: JSON.stringify({ archivedAt: null, active: true, version: company.version }),
    });
    if (typeof onRecordChanged === "function") await onRecordChanged(updated);
    await reopenCompanyDetail({ id: company.id }, record.getSelectedDealId());
  }

  function mount() {
    const detail = surface.querySelector("[data-crm-detail]");
    detail.innerHTML = html`<div data-crm-record></div>`;
    return detail.querySelector("[data-crm-record]");
  }

  async function reopenDealDetail(deal, { isCurrent = null } = {}) {
    await reopenCompanyDetail({ id: deal.organizationId }, deal, { isCurrent });
  }

  async function reopenCompanyDetail(organization, highlightedDeal = null, { isCurrent = null } = {}) {
    const split = surface.querySelector("[data-crm-split]");
    surface.classList.add("has-booking-detail");
    // The queue marks this company as the selected row; on a phone the split
    // shows the detail pane.
    surface.dataset.selectedCompany = organization.id;
    if (split) split.dataset.view = "detail";
    draw();
    const host = mount();
    // Back is E's injected closeRecord (focus/scroll/filter restoration).
    // No local navigate/listPath/split/scroll lifecycle lives here.
    record.wire(host);
    const dealId = typeof highlightedDeal === "string"
      ? highlightedDeal
      : highlightedDeal?.id || null;
    await record.openCompany(organization.id, {
      dealId,
      returnLabel: "CRM",
      isCurrent,
    });
    if (sponsorCommunications) sponsorCommunications.selectedBookingId = dealId;
    globalThis.dakitSplit?.show(split, "detail");
  }

  return { reopenDealDetail, reopenCompanyDetail, getSelectedDealId: () => record.getSelectedDealId() };
}
