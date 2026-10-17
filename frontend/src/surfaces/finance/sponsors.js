import { createSponsorContactEditor } from "./sponsor-contacts.js";
import { createSponsorOwnerDirectory, populateSponsorDealForm } from "./sponsor-deal-form.js";
import { createSponsorCommunications } from "./sponsor-communications.js";
import { createSponsorFinance } from "./sponsor-finance.js";
import { createSponsorLeads } from "./sponsor-leads.js";
import { createSponsorNewsletters } from "./sponsor-newsletters.js";
import { createSponsorMoney } from "./sponsor-money.js";
import { renderSponsorBookingAlerts } from "./sponsor-alerts.js";
import { createSponsorCompanyDetail } from "./sponsor-company-detail.js";
import { sponsorSurfaceMarkup } from "./sponsor-layout.js";
import { SPONSOR_PIPELINE_STAGES, createSponsorPipelineView } from "./sponsor-pipeline.js";
import { createCollectionLoader } from "../../core/collection-loader.js";
import { sponsorRecordPath, sponsorsPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";

export async function readSponsorDirectory(api, collection) {
  const items = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await api(`/${collection}?${query}`);
    if (!Array.isArray(result?.items) ||
        (result.nextCursor != null && typeof result.nextCursor !== "string")) {
      throw new Error(`Invalid sponsor ${collection} page`);
    }
    for (const item of result.items) {
      if (!item || typeof item.id !== "string" || !item.id) {
        throw new Error(`Invalid sponsor ${collection} record`);
      }
      items.set(item.id, item);
    }
    cursor = result.nextCursor;
    if (!cursor) return { items: [...items.values()] };
    if (cursors.has(cursor)) throw new Error(`Repeated sponsor ${collection} cursor`);
    cursors.add(cursor);
  }
  throw new Error(`Sponsor ${collection} directory is incomplete; pagination limit reached`);
}

function focusFirstUsableControl(dialog) {
  const control = dialog.querySelector(
    [
      'input:not([type="hidden"]):not([disabled]):not([hidden])',
      'select:not([disabled]):not([hidden])',
      'textarea:not([disabled]):not([hidden])',
      'button:not([disabled]):not([hidden])',
      'a[href]:not([hidden])',
    ].join(","),
  );
  control?.focus();
}

const PAGE_VIEWS = new Set(["companies", "leads", "newsletters", "money"]); // full-width pages, no split

function openDialog(dialog) {
  dialog.showModal();
  focusFirstUsableControl(dialog);
}

export function createSponsorCrmSurface(context) {
  const {
    documentList,
    escapeHtml,
    getPendingLegacyRoute,
    humanizeOptionLabel,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openTaskPanel,
    request,
    renderEntityLoadState,
    setRouteTitle,
    workApiUrl,
  } = context;

  let sponsorCommunications = null;
  // Whether the operator unfolded the alerts; a repaint of the surface keeps it.
  let alertsOpen = false;

  async function canLeaveFinanceSurface(reason = "navigation") {
    return (
      !sponsorCommunications ||
      sponsorCommunications.revokeCurrentReview(reason)
    );
  }

  async function renderSponsorCrmSurface() {
    const routeAtStart = getPendingLegacyRoute();
    const routeToken = routeAtStart?.token;
    const sponsorsRoute = routeAtStart?.view === "sponsors" ? routeAtStart : null;
    const initialTab = sponsorsRoute?.sponsorsTab || "pipeline";
    const requested = (name) => sponsorsRoute?.params.get(name) || null;
    const requestedDealId = requested("dealId");
    const requestedCompanyId = requested("companyId");
    const requestedLeadId = requested("leadId");
    const requestedNewsletterId = requested("newsletterId");
    // Opening a tab or record in place records it in the URL without a re-render.
    const recordRoute = (path) => navigateCanonicalWorkspace(path, {}, { render: false });
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "sponsor-crm-surface";
    surface.innerHTML = sponsorSurfaceMarkup(humanizeOptionLabel);
    const alertsSection = surface.querySelector(".crm-alerts");
    alertsSection.open = alertsOpen;
    alertsSection.addEventListener("toggle", () => {
      alertsOpen = alertsSection.open;
    });
    documentList.append(surface);
    surface.querySelector("[data-crm-bookings]").classList.add("crm-funnel");
    surface.querySelector("[data-crm-status]").innerHTML = html`<option value="">All stages</option>${
      SPONSOR_PIPELINE_STAGES.map(({ id, label }) => html`<option value="${id}">${label}</option>`).join("")
    }`;
    setRouteTitle("Sponsors");
    const api = (path, options = {}) =>
        request(workApiUrl(`/api/sponsor-crm${path}`), {
          headers: {
            "content-type": "application/json",
            ...(options.headers || {}),
          },
          ...options,
        }),
      message = surface.querySelector("[data-crm-message]");
    const ownerDirectory = createSponsorOwnerDirectory({ request, workApiUrl, escapeHtml });
    let organizations = [],
      contacts = [],
      deals = [];
    let currentView = "pipeline";
    const notificationLoader = createCollectionLoader({
      collection: "notifications",
      createUrl: ({ cursor, limit }) => {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor) query.set("cursor", cursor);
        return workApiUrl(`/api/notifications?${query}`);
      },
      request,
    });
    let notificationState = notificationLoader.getSnapshot();
    const sponsorFinance = createSponsorFinance({
      escapeHtml,
      humanizeOptionLabel,
      message,
      openTaskPanel,
      request,
      surface,
      workApiUrl,
    });
    sponsorCommunications = createSponsorCommunications({
      api,
      escapeHtml,
      getBookings: () => deals,
      getContacts: () => contacts,
      humanizeOptionLabel,
      message,
      surface,
    });
    const sponsorLeads = createSponsorLeads({
      api,
      escapeHtml,
      humanizeOptionLabel,
      message,
      surface,
      openDialog,
    });
    sponsorLeads.wireLeadControls();
    const sponsorNewsletters = createSponsorNewsletters({
      api,
      escapeHtml,
      humanizeOptionLabel,
      message,
      surface,
      openDialog,
      newsletterPath: (id) => sponsorRecordPath("newsletter", id),
      recordPath: sponsorRecordPath,
      listPath: () => sponsorsPath("newsletters"),
      navigate: (path, options = {}) => navigateCanonicalWorkspace(path, {}, options),
      renderEntityLoadState,
    });
    sponsorNewsletters.wireNewsletterControls();
    // Money shows only while sponsor finance is enabled (deals carry finance; the ledger is not 404).
    const moneyTab = surface.querySelector('[data-crm-view="money"]');
    const sponsorMoney = createSponsorMoney({
      escapeHtml, request, surface, workApiUrl,
      openDeal: (dealId) => openRecord("deal", dealId),
      onAvailability: (enabled) => (moneyTab.hidden = !enabled),
    });
    const { loadFinance } = sponsorFinance;
    const {
      loadCommunications,
      revokeCurrentReview,
      showExactReview,
    } = sponsorCommunications;
    const showExactReviewAndFocus = async (...args) => {
      await showExactReview(...args);
      focusFirstUsableControl(
        surface.querySelector("[data-communication-review-dialog]"),
      );
    };
    const safe = async (action, label) => {
      try {
        await action();
      } catch (error) {
        message.hidden = false;
        message.textContent = `${label}: ${error.message}`;
      }
    };
    function humanSponsorDate(value) {
      const iso = String(value || "").slice(0, 10);
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return value || "";
      return new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(parsed);
    }
    function organizationName(organizationId) {
      return (
        organizations.find((item) => item.id === organizationId)?.displayName ||
        "Unknown sponsor"
      );
    }
    function orgOptions() {
      surface.querySelector(
        '[data-deal-dialog] [name="organizationId"]',
      ).innerHTML = organizations
        .filter((item) => !item.archivedAt)
        .map(
          (item) =>
            html`<option value="${escapeHtml(item.id)}">
              ${escapeHtml(item.displayName)}
            </option>`,
        )
        .join("");
    }
    function fillContacts(form, organizationId, selectedId) {
      form.elements.primaryContactId.innerHTML = html`<option value="">
          No contact
        </option>
        ${contacts
          .filter(
            (value) => value.organizationId === organizationId && !value.archivedAt,
          )
          .map(
            (value) =>
              html`<option value="${escapeHtml(value.id)}">
                ${escapeHtml(value.name)}
              </option>`,
          )
          .join("")}`;
      if (selectedId) form.elements.primaryContactId.value = selectedId;
    }
    function setView(view, redraw = true) {
      currentView = view;
      if (view === "pipeline") {
        surface.classList.remove("has-booking-detail");
        // The board is the list pane; a phone shows it again.
        surface.querySelector("[data-crm-split]").dataset.view = "list";
      }
      surface.classList.toggle("is-pipeline", view === "pipeline");
      surface.querySelectorAll("[data-crm-view]").forEach((link) => {
        if (link.dataset.crmView === view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      const pipeline = surface.querySelector("[data-crm-bookings]");
      const companies = surface.querySelector("[data-crm-companies-section]");
      const filters = surface.querySelector(".crm-filters");
      if (view === "companies") {
        companies.insertBefore(filters, surface.querySelector("[data-crm-orgs]"));
      } else if (view === "pipeline") {
        surface.querySelector(".crm-filter-disclosure").append(filters);
      }
      // Inside the list pane the filters are its tool band.
      filters.classList.toggle("dk-split__tools", view !== "companies");
      pipeline.hidden = view !== "pipeline";
      companies.hidden = view !== "companies";
      surface.querySelector(".crm-leads").hidden = view !== "leads";
      surface.querySelector(".crm-newsletters").hidden = view !== "newsletters";
      if (!(surface.querySelector(".crm-money").hidden = view !== "money")) sponsorMoney.loadMoney();
      surface.querySelector(".crm-layout").hidden = PAGE_VIEWS.has(view);
      // Pipeline fills the content area; the other views scroll the page.
      surface.classList.toggle("dk-fill", !surface.querySelector(".crm-layout").hidden);
      surface.querySelector("[data-crm-pipeline]").hidden = view !== "pipeline";
      surface.querySelector(".crm-funnel-scope").hidden = view !== "pipeline";
      surface.querySelector(".crm-funnel-controls").hidden = view !== "pipeline";
      surface.querySelector(".crm-filter-disclosure").hidden = view !== "pipeline";
      if (view === "pipeline" && !filters.closest?.(".crm-filter-disclosure")) {
        surface.querySelector(".crm-filter-disclosure").append(filters);
      }
      const heading = surface.querySelector("[data-crm-list-heading]");
      heading.textContent =
        view === "pipeline" ? "Pipeline"
        : view === "leads" ? "Leads"
        : view === "newsletters" ? "Newsletters"
        : view === "money" ? "Money"
        : "Companies";
      if (redraw) draw();
    }
    const { reopenDealDetail, reopenCompanyDetail } = createSponsorCompanyDetail({
      api,
      surface,
      escapeHtml,
      humanizeOptionLabel,
      humanSponsorDate,
      navigateCanonicalWorkspace,
      // Closing a record returns to the tab it was opened from.
      listPath: () => sponsorsPath(currentView),
      getOrganizations: () => organizations,
      getContacts: () => contacts,
      getDeals: () => deals,
      sponsorCommunications,
      draw,
      openDeal,
      openDialog,
      loadFinance,
      loadCommunications,
      safe,
    });
    sponsorFinance.setReopenBookingDetail(async (booking) => {
      if (
        surface.classList.contains("has-booking-detail") &&
        surface.querySelector('[data-booking-panel="finance"]')
      ) {
        await loadFinance(booking);
      } else {
        await reopenDealDetail(booking);
      }
    });

    function draw() {
      const search = surface.querySelector("[data-crm-search]").value.toLowerCase(),
        active = surface.querySelector("[data-crm-active]").value,
        status = surface.querySelector("[data-crm-status]").value,
        shown = organizations.filter(
          (item) =>
            (!search || item.displayName.toLowerCase().includes(search)) &&
            (!active || String(!item.archivedAt) === active),
        );
      surface.querySelector("[data-crm-orgs]").innerHTML = shown.length
        ? shown
            .map(
              (item) =>
                html`<article class="crm-directory-row">
                  <div>
                    <strong>${escapeHtml(item.displayName)}</strong>
                    <p>
                      ${escapeHtml(humanizeOptionLabel(item.relationship || "prospect"))}
                      ${item.archivedAt ? " · Archived" : ""}
                    </p>
                  </div>
                  <div class="row-actions">
                    <button data-open-company="${escapeHtml(item.id)}">Open</button>
                    <button data-contact-org="${escapeHtml(item.id)}">Add contact</button
                    >${item.archivedAt ? "" : ` <button data-archive-org="${escapeHtml(item.id)}">Archive</button>`}
                  </div>
                </article>`,
            )
            .join("")
        : html`<div class="honest-state">
            <strong>No sponsors found</strong>
            <p>Adjust filters or add the first sponsor.</p>
          </div>`;
      if (currentView === "pipeline") pipeline.draw();
    }

    const pipeline = createSponsorPipelineView({ api, surface, escapeHtml, humanSponsorDate,
      ownerName: (id) => ownerDirectory.name(id), safe });
    let directoryLoaded = false;
    async function ensureDirectory() {
      if (directoryLoaded) return;
      const [orgs, people] = await Promise.all([readSponsorDirectory(api, "organizations"), readSponsorDirectory(api, "contacts")]);
      organizations = orgs.items; contacts = people.items; directoryLoaded = true; orgOptions();
    }
    async function loadCompany(organizationId) {
      const [organization, people, bookings] = await Promise.all([
        api(`/organizations/${organizationId}`),
        readSponsorDirectory((path) => api(
          `${path}&organizationId=${encodeURIComponent(organizationId)}`,
        ), "contacts"),
        readSponsorDirectory((path) => api(
          `${path}&organizationId=${encodeURIComponent(organizationId)}`,
        ), "deals"),
      ]);
      organizations = [...organizations.filter((item) => item.id !== organizationId), organization];
      contacts = [...contacts.filter((item) => item.organizationId !== organizationId), ...people.items];
      deals = [...deals.filter((item) => item.organizationId !== organizationId), ...bookings.items];
      return organization;
    }

    async function refresh() {
      directoryLoaded = false;
      message.textContent = "Loading sponsor CRM…";
      message.hidden = false;
      if (currentView === "pipeline") {
        await ownerDirectory.load();
        ownerDirectory.fillFilter(surface.querySelector("[data-pipeline-owner]"));
        await pipeline.load();
      }
      else if (currentView === "companies") { await ensureDirectory(); draw(); }
      else if (currentView === "leads") await sponsorLeads.loadLeads();
      else if (currentView === "newsletters") await sponsorNewsletters.loadNewsletters();
      message.textContent = "";
      message.hidden = true;
    }

    function drawAlerts() {
      renderSponsorBookingAlerts({ surface, notificationState, escapeHtml });
    }
    async function openDeal(item) {
      await Promise.all([ensureDirectory(), ownerDirectory.load()]);
      const dialog = surface.querySelector("[data-deal-dialog]"),
        form = dialog.querySelector("form");
      populateSponsorDealForm(form, item, ownerDirectory, fillContacts);
      openDialog(dialog);
    }
    let searchTimer;
    const schedulePipeline = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => safe(() => pipeline.load(), "Could not load pipeline"), 180); };
    surface.querySelectorAll("[data-pipeline-view],[data-pipeline-sort],[data-pipeline-owner]").forEach((input) =>
      input.addEventListener("change", () => safe(() => pipeline.load(), "Could not load pipeline")),
    );
    alertsSection.addEventListener("toggle", () => {
      if (alertsSection.open) safe(async () => {
        notificationState = await notificationLoader.load(); drawAlerts();
      }, "Could not load alerts");
    });
    surface.querySelectorAll("[data-crm-search],[data-crm-active],[data-crm-status]").forEach((input) =>
      input.addEventListener("input", () => {
        if (currentView === "pipeline") schedulePipeline(); else draw();
      }),
    );
    surface.querySelector("[data-crm-views]").addEventListener("click", (event) => {
      const button = event.target.closest("[data-crm-view]");
      // Tabs are links: a modified click opens the tab's URL in a new tab.
      if (!button || event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
      event.preventDefault();
      const view = button.dataset.crmView;
      if (view === "newsletters") sponsorNewsletters.showList();
      setView(view);
      safe(refresh, "Could not load view");
      recordRoute(sponsorsPath(view));
    });
    surface.querySelector("[data-crm-pipeline]").addEventListener("click", (event) => {
      const button = event.target.closest("[data-pipeline-status]");
      if (!button) return;
      surface.querySelector("[data-crm-status]").value =
        button.getAttribute("data-pipeline-status") || "";
      surface.querySelector("[data-pipeline-view]").value = "all";
      setView("pipeline");
      safe(() => pipeline.load(), "Could not load pipeline");
      recordRoute(sponsorsPath("pipeline"));
    });
    function showRecord({ dealId, companyId } = {}) {
      const deal = dealId ? deals.find((item) => item.id === dealId) : null;
      const organization = companyId
        ? organizations.find((item) => item.id === companyId)
        : null;
      if (deal) {
        if (PAGE_VIEWS.has(currentView)) {
          setView("pipeline");
        }
        safe(() => reopenDealDetail(deal), "Could not open deal");
        return true;
      }
      if (organization) {
        if (PAGE_VIEWS.has(currentView)) {
          setView("pipeline");
        }
        safe(() => reopenCompanyDetail(organization), "Could not open company");
        return true;
      }
      return false;
    }
    // An in-place open records the record path; an unknown record renders it.
    function openRecord(kind, id) {
      safe(async () => {
        if (kind === "deal") {
          const item = await api(`/deals/${encodeURIComponent(id)}`);
          await loadCompany(item.organizationId);
          deals = [...deals.filter((value) => value.id !== id), item];
        } else await loadCompany(id);
        showRecord(kind === "deal" ? { dealId: id } : { companyId: id });
        navigateCanonicalWorkspace(sponsorRecordPath(kind, id), {}, { render: false });
      }, "Could not open record");
    }

    surface.querySelector("[data-crm-detail]").addEventListener("click", (event) => {
      if (surface.classList.contains("has-booking-detail")) return;
      const dealId = event.target.closest("[data-open-deal]")?.dataset.openDeal;
      if (dealId) {
        openRecord("deal", dealId);
      }
    });
    surface.querySelector("[data-add-org]").onclick = () =>
      openDialog(surface.querySelector("[data-org-dialog]"));
    surface.querySelector("[data-add-deal]").onclick = () => openDeal(null);
    surface.querySelector("[data-crm-orgs]").onclick = (event) => {
      const company = event.target.closest("[data-open-company]")?.dataset.openCompany;
      const contact = event.target.closest("[data-contact-org]")?.dataset.contactOrg;
      const archive = event.target.closest("[data-archive-org]")?.dataset.archiveOrg;
      if (company) {
        openRecord("company", company);
        return;
      }
      if (contact) {
        const form = surface.querySelector("[data-contact-dialog] form");
        form.reset();
        form.elements.organizationId.value = contact;
        openDialog(surface.querySelector("[data-contact-dialog]"));
      }
      if (archive)
        safe(async () => {
          const organization = organizations.find((item) => item.id === archive);
          if (
            !(await confirmSponsorAction(
              "Archive sponsor organization?",
              `${organization?.displayName || "This organization"} will leave the active directory. Existing deals and history remain available.`,
              "Archive sponsor",
            ))
          )
            return;
          await api(`/organizations/${archive}`, { method: "DELETE" });
          await refresh();
        }, "Could not archive sponsor");
    };
    const openFromList = (event) => {
      const edit = event.target.closest("[data-edit-deal]")?.dataset.editDeal;
      const dealId = event.target.closest("[data-open-deal]")?.dataset.openDeal;
      const companyId = event.target.closest("[data-open-company]")?.dataset.openCompany;
      if (edit) {
        openDeal(deals.find((item) => item.id === edit));
        return;
      }
      // An in-place open still records the selection in the URL (no re-render).
      if (dealId) {
        openRecord("deal", dealId);
        return;
      }
      if (companyId) {
        openRecord("company", companyId);
      }
    };
    surface.querySelector("[data-crm-bookings]").onclick = openFromList;
    surface.querySelector("[data-crm-alerts]").onclick = (event) => {
      if (event.target.closest("[data-load-sponsor-alerts]")) {
        safe(async () => {
          const pendingPage = notificationLoader.loadMore();
          notificationState = notificationLoader.getSnapshot();
          drawAlerts();
          notificationState = await pendingPage;
          drawAlerts();
        }, "Could not load more booking alerts");
        return;
      }
      if (event.target.closest("[data-load-sponsor-alerts-retry]")) {
        safe(async () => {
          const pendingPage = notificationLoader.load();
          notificationState = notificationLoader.getSnapshot();
          drawAlerts();
          notificationState = await pendingPage;
          drawAlerts();
        }, "Could not load booking alerts");
        return;
      }
      const button = event.target.closest("[data-alert-deal],[data-alert-booking]");
      const id = button?.dataset.alertDeal || button?.dataset.alertBooking;
      const companyId = button?.dataset.alertCompany;
      if (id) openRecord("deal", id);
      else if (companyId) openRecord("company", companyId);
    };
    for (const dialog of surface.querySelectorAll("dialog")) {
      const cancel = dialog.querySelector('[value="cancel"],[data-cancel]');
      if (cancel) cancel.onclick = () => dialog.close();
    }
    const reviewDialog = surface.querySelector(
      "[data-communication-review-dialog]",
    );
    reviewDialog.querySelector("[data-review-close]").onclick = (event) => {
      event.preventDefault();
      revokeCurrentReview("close");
    };
    reviewDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      revokeCurrentReview("escape");
    });
    const confirmDialog = surface.querySelector("[data-sponsor-confirm-dialog]");
    const confirmSponsorAction = (title, description, actionLabel) =>
      new Promise((resolve) => {
        confirmDialog.querySelector("[data-confirm-title]").textContent = title;
        confirmDialog.querySelector("[data-confirm-description]").textContent = description;
        confirmDialog.querySelector("[data-confirm-accept]").textContent = actionLabel;
        const finish = (accepted) => {
          confirmDialog.removeEventListener("close", onClose);
          confirmDialog.querySelector("[data-confirm-accept]").removeEventListener("click", onAccept);
          resolve(accepted);
        };
        const onClose = () => finish(false);
        const onAccept = () => {
          confirmDialog.removeEventListener("close", onClose);
          confirmDialog.close();
          finish(true);
        };
        confirmDialog.addEventListener("close", onClose, { once: true });
        confirmDialog.querySelector("[data-confirm-accept]").addEventListener("click", onAccept, { once: true });
        confirmDialog.showModal();
      });
    surface.querySelector("[data-evaluate-communications]").onclick = () =>
      safe(async () => {
        const result = await api("/communications/evaluate", {
          method: "POST",
          body: "{}",
        });
        message.hidden = false;
        message.textContent = `Suggestions refreshed: ${result.created.length} new, ${result.existing.length} already known. No messages were drafted or sent.`;
        if (sponsorCommunications.selectedBookingId)
          await loadCommunications(sponsorCommunications.selectedBookingId);
      }, "Could not refresh communication suggestions");
    surface.addEventListener("click", (event) => {
      if (!event.target.closest("[data-crm-communications]")) return;
      if (event.target.closest("[data-suppress-address]")) {
        const deal = deals.find(
          (item) => item.id === sponsorCommunications.selectedBookingId,
        );
        const recipients = contacts
          .filter(
            (item) =>
              item.organizationId === deal?.organizationId &&
              item.active !== false &&
              !item.archivedAt,
          )
          .flatMap((item) =>
            (item.emails || []).map((email) => ({
              contactId: item.id,
              name: item.name,
              email,
            })),
          );
        const dialog = surface.querySelector("[data-suppression-dialog]");
        const form = dialog.querySelector("form");
        form.reset();
        form.elements.recipient.innerHTML = recipients
          .map(
            (item) =>
              html`<option
                value="${escapeHtml(item.email)}"
                data-contact-id="${escapeHtml(item.contactId)}"
              >
                ${escapeHtml(item.name || "Sponsor contact")} ·
                ${escapeHtml(item.email)}
              </option>`,
          )
          .join("");
        openDialog(dialog);
        return;
      }
      const reviewDraft = event.target.closest("[data-review-draft]");
      if (reviewDraft) {
        safe(
          async () =>
            showExactReviewAndFocus(
              reviewDraft.dataset.reviewDraft,
              Number(reviewDraft.dataset.draftVersion),
            ),
          "Could not open exact review",
        );
        return;
      }
      const suggestionId = event.target.closest("[data-draft-suggestion]")
        ?.dataset.draftSuggestion;
      if (suggestionId) {
        const suggestion = sponsorCommunications.communicationItems.find(
          (item) => item.id === suggestionId,
        );
        const deal = deals.find(
          (item) => item.id === sponsorCommunications.selectedBookingId,
        );
        const recipients = contacts
          .filter(
            (item) =>
              item.organizationId === deal?.organizationId &&
              item.active !== false &&
              !item.archivedAt,
          )
          .flatMap((item) =>
            (item.emails || []).map((email) => ({
              contactId: item.id,
              name: item.name,
              email,
            })),
          );
        if (!suggestion || !recipients.length) {
          message.hidden = false;
          message.textContent =
            "At least one active contact address in this sponsor organization is required before drafting.";
          return;
        }
        const dialog = surface.querySelector(
          "[data-communication-draft-dialog]",
        );
        const form = dialog.querySelector("form");
        form.reset();
        form.elements.suggestionId.value = suggestionId;
        form.elements.recipient.innerHTML = recipients
          .map(
            (item) =>
              html`<option
                value="${escapeHtml(item.email)}"
                data-contact-id="${escapeHtml(item.contactId)}"
              >
                ${escapeHtml(item.name || "Sponsor contact")} ·
                ${escapeHtml(item.email)}
              </option>`,
          )
          .join("");
        surface.querySelector("[data-create-review]").textContent =
          sponsorCommunications.communicationPermissions.canApprove
            ? "Save and review exact message"
            : "Save draft for admin review";
        openDialog(dialog);
        return;
      }
    });
    surface.querySelector("[data-org-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-org-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(new FormData(form));
        await api("/organizations", { method: "POST", body: JSON.stringify(data) });
        dialog.close();
        await refresh();
      }, "Could not save sponsor");
    };
    createSponsorContactEditor({ api, surface, getContacts: () => contacts, safe, openDialog,
      afterSave: async (organizationId) => { await refresh(); await reopenCompanyDetail(await loadCompany(organizationId)); } });
    surface.querySelector("[data-deal-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-deal-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const raw = Object.fromEntries(
          [...new FormData(form)].filter(([, value]) => value !== ""),
        );
        const id = raw.dealId;
        const payload = {
          organizationId: raw.organizationId,
          primaryContactId: raw.primaryContactId || undefined,
          status: raw.status,
          productKind: raw.productKind,
          historyNote: raw.historyNote,
        };
        if (raw.version) payload.version = Number(raw.version);
        if (raw.amountEur) payload.amountEur = Number(raw.amountEur);
        if (raw.lostReason) payload.lostReason = raw.lostReason;
        if (!id && (raw.channel || raw.plannedPublicationDate || raw.materialDeadline)) {
          payload.deliverable = {
            channel: raw.channel || "main",
            plannedPublicationDate: raw.plannedPublicationDate,
            materialDeadline: raw.materialDeadline,
          };
        }
        const saved = await api(`/deals${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        // The deal's next step is a Task about the deal, so it lands in the
        // Tasks queue with everything else.
        if (raw.taskDescription) {
          await request(workApiUrl("/api/tasks"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              description: raw.taskDescription,
              date: raw.taskDate || new Date().toISOString().slice(0, 10),
              ...(raw.taskAssignee ? { assigneeId: raw.taskAssignee } : {}),
              subject: { type: "sponsor-deal", id: saved.id },
            }),
          });
        }
        dialog.close();
        await refresh();
      }, "Could not save deal");
    };
    surface.querySelector("[data-save-suppression]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-suppression-dialog]");
      const form = dialog.querySelector("form");
      safe(async () => {
        const value = Object.fromEntries(new FormData(form));
        const selectedRecipient = form.elements.recipient.selectedOptions[0];
        if (!selectedRecipient) throw new Error("Select one recipient");
        if (!value.reason) throw new Error("A reason is required");
        await api(`/contacts/${selectedRecipient.dataset.contactId}/suppressions`, {
          method: "POST",
          body: JSON.stringify({ email: value.recipient, reason: value.reason }),
        });
        dialog.close();
        message.hidden = false;
        message.textContent =
          "Future messages to the selected sponsor address are suppressed. In-flight mail cannot be recalled.";
        await loadCommunications(sponsorCommunications.selectedBookingId);
      }, "Could not add suppression");
    };
    surface.querySelector("[data-create-review]").onclick = (event) => {
      event.preventDefault();
      const draftDialog = surface.querySelector("[data-communication-draft-dialog]");
      const form = draftDialog.querySelector("form");
      safe(async () => {
        const value = Object.fromEntries(new FormData(form));
        const selectedRecipient = form.elements.recipient.selectedOptions[0];
        if (!selectedRecipient) throw new Error("Select one recipient");
        const publicLinks = value.publicLink ? [value.publicLink] : [];
        const draft = await api(`/communication-suggestions/${value.suggestionId}/drafts`, {
          method: "POST",
          body: JSON.stringify({
            contactId: selectedRecipient.dataset.contactId,
            recipient: value.recipient,
            subject: value.subject,
            body: value.body,
            publicLinks,
          }),
        });
        draftDialog.close();
        await loadCommunications(sponsorCommunications.selectedBookingId);
        if (sponsorCommunications.communicationPermissions.canApprove) {
          await showExactReviewAndFocus(draft.communicationId, draft.version);
        } else {
          message.hidden = false;
          message.textContent = `Draft version ${draft.version} saved. Awaiting administrator review; no message was approved or sent.`;
        }
      }, "Could not save sponsor message draft");
    };
    setView(initialTab, false);
    try {
      await refresh();
      if (routeToken && (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)) return;
      const stale = () => routeToken && (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected);
      if (requestedNewsletterId) await sponsorNewsletters.showNewsletter(requestedNewsletterId);
      // [id, kind, where its load state renders, tab to return to, open it]
      const record = [
        [requestedDealId, "deal", "[data-crm-detail]", "pipeline", async (id) => {
          let deal = deals.find((item) => item.id === id);
          if (!deal) {
            deal = await api(`/deals/${encodeURIComponent(id)}`);
            if (stale()) return;
            deals = [deal, ...deals];
            draw();
          }
          await loadCompany(deal.organizationId);
          await reopenDealDetail(deal);
        }],
        [requestedCompanyId, "company", "[data-crm-detail]", "pipeline", async (id) => reopenCompanyDetail(
          await loadCompany(id),
        )],
        [requestedLeadId, "lead", "[data-crm-leads]", "leads", (id) => sponsorLeads.focusLead(id)],
      ].find(([id]) => id);
      if (record) {
        const [id, kind, container, tab, open] = record;
        try {
          await open(id);
        } catch (error) {
          if (stale()) return;
          // A deal or company that cannot load still takes the detail pane,
          // which Pipeline shows only while a record is open.
          if (container === "[data-crm-detail]") surface.classList.add("has-booking-detail");
          renderEntityLoadState(surface.querySelector(container), {
            kind,
            id,
            status: error.status === 404 ? "not-found" : "error",
            error: error.message,
            retry: () => renderSponsorCrmSurface(),
            returnToList: () => navigateCanonicalWorkspace(sponsorsPath(tab)),
          });
        }
      }
    } catch (error) {
      surface.querySelector("[data-crm-orgs]").textContent = "Could not load sponsors.";
      surface.querySelector("[data-crm-bookings]").textContent = "Could not load deals.";
      message.hidden = false;
      message.textContent = `Permission or API error: ${error.message}. Reopen Sponsors to retry.`;
    }
  }

  return {
    canLeaveFinanceSurface,
    renderSponsorCrmSurface,
  };
}
