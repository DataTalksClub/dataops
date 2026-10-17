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
 * pane and replicates the previous Back/scroll/split behavior with the
 * origin view label (Companies/Pipeline/CRM). New optional ctx (E one-line
 * hunks): openTaskPanel, openContactEditor (from the sponsors.js editor
 * instance), loadArchive/onReviewDraft overrides. Until E passes
 * openContactEditor, person edit affordances stay hidden.
 */
export function createSponsorCompanyDetail({
  api,
  surface,
  escapeHtml,
  humanizeOptionLabel,
  humanSponsorDate,
  navigateCanonicalWorkspace,
  listPath,
  getOrganizations,
  getContacts,
  getDeals,
  sponsorCommunications,
  draw,
  openDeal,
  openDialog,
  loadFinance,
  loadCommunications,
  safe,
  openTaskPanel,
  openCompanyRecord,
  openContactEditor,
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
    closeRecord: () => {},
    loadFinance,
    openTaskPanel,
    openCompanyRecord: openCompanyRecord || (async (organizationId) => {
      await reopenCompanyDetail({ id: organizationId });
    }),
    openContactEditor,
    loadArchive: loadArchive || defaultLoadArchive,
    onReviewDraft: onReviewDraft || onReviewDraftDefault,
    onArchiveCompany,
    onRestoreCompany,
    onAddDeal: onAddDeal || ((organizationId) => openDeal({ organizationId, status: "open" })),
    onEditCompany,
  });

  async function defaultLoadArchive(dealId) {
    // B-preserved read path (GET deals/:id/communications, body-free),
    // projected to the archive shape E confirmed. Read-only: no
    // draft/approve/cancel/reconcile affordances are produced or consumed.
    const items = [];
    let cursor = "";
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await api(`/deals/${encodeURIComponent(dealId)}/communications?${query}`);
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
      cursor = result.nextCursor || "";
      if (!cursor) break;
    }
    return { items, total: items.length, hasMore: Boolean(cursor) };
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
    await api(`/organizations/${encodeURIComponent(company.id)}`, { method: "DELETE" });
    await reopenCompanyDetail({ id: company.id }, record.getSelectedDealId());
  }

  async function onRestoreCompany() {
    const company = record.getCompany();
    if (!company) return;
    await api(`/organizations/${encodeURIComponent(company.id)}`, {
      method: "PUT",
      body: JSON.stringify({ archivedAt: null, active: true, version: company.version }),
    });
    await reopenCompanyDetail({ id: company.id }, record.getSelectedDealId());
  }

  function mount() {
    const detail = surface.querySelector("[data-crm-detail]");
    detail.innerHTML = html`<div data-crm-record></div>`;
    return detail.querySelector("[data-crm-record]");
  }

  async function reopenDealDetail(deal) {
    await reopenCompanyDetail({ id: deal.organizationId }, deal);
  }

  // E owns final Back restoration; the label only names the origin view.
  // Never hardcode a destination name here.
  function originLabel() {
    try {
      const path = typeof listPath === "function" ? listPath() : "";
      if (String(path).includes("/companies")) return "Companies";
      if (String(path).includes("/pipeline")) return "Pipeline";
    } catch {
      // fall through to the workspace label
    }
    return "CRM";
  }

  async function reopenCompanyDetail(organization, highlightedDeal = null) {
    const split = surface.querySelector("[data-crm-split]");
    const listScroller = surface.querySelector("[data-crm-list-scroll]");
    const listScrollTop = listScroller?.scrollTop || 0;
    surface.classList.add("has-booking-detail");
    // The queue marks this company as the selected row; on a phone the split
    // shows the detail pane.
    surface.dataset.selectedCompany = organization.id;
    if (split) split.dataset.view = "detail";
    draw();
    if (listScroller) listScroller.scrollTop = listScrollTop;
    const host = mount();
    // closeRecord replicates the previous Back: keep the list DOM, its
    // selected row and its reading position while removing the record from
    // the URL. E's integration will take over mount/Back/list-refresh.
    record.wire(host);
    const closeRecord = () => {
      record.destroy();
      navigateCanonicalWorkspace(listPath(), {}, { render: false });
      surface.classList.remove("has-booking-detail");
      if (listScroller) listScroller.scrollTop = listScrollTop;
      globalThis.dakitSplit?.show(split, "list");
    };
    record.closeWith(closeRecord);
    const dealId = typeof highlightedDeal === "string"
      ? highlightedDeal
      : highlightedDeal?.id || null;
    await record.openCompany(organization.id, {
      dealId,
      returnLabel: originLabel(),
    });
    if (sponsorCommunications) sponsorCommunications.selectedBookingId = dealId;
    globalThis.dakitSplit?.show(split, "detail");
  }

  return { reopenDealDetail, reopenCompanyDetail };
}
