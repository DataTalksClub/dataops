import { createSponsorContactEditor, createSponsorDialogGuard } from "./sponsor-contacts.js";
import { createSponsorPersonDetail } from "./sponsor-person-detail.js";
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
import { createSponsorDirectoryPages } from "./sponsor-directory-pages.js";
import { createFollowupsController } from "./sponsor-followups.js";

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

const PAGE_VIEWS = new Set(["companies", "people", "followups", "leads", "newsletters", "money"]); // full-width pages, no split

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
  let surfaceRenderCount = 0;

  async function canLeaveFinanceSurface(reason = "navigation") {
    return (
      !sponsorCommunications ||
      sponsorCommunications.revokeCurrentReview(reason)
    );
  }

  async function renderSponsorCrmSurface() {
    // Surface-local render generation: in-render canonical URL writes
    // (filter/sort/page sync with history:replace) legitimately move the
    // route token, so staleness here means a NEWER render started, the
    // surface detached, or the workspace genuinely left CRM (e.g. Tasks) —
    // never our own filter synchronization.
    const renderToken = ++surfaceRenderCount;
    const stale = () => {
      if (renderToken !== surfaceRenderCount || !surface.isConnected) return true;
      const now = getPendingLegacyRoute();
      return !!now && !!now.view && now.view !== "sponsors";
    };
    const routeAtStart = getPendingLegacyRoute();
    const sponsorsRoute = routeAtStart?.view === "sponsors" ? routeAtStart : null;
    const initialTab = sponsorsRoute?.sponsorsTab || "pipeline";
    const requested = (name) => sponsorsRoute?.params.get(name) || null;
    const requestedDealId = requested("dealId");
    const requestedCompanyId = requested("companyId");
    const requestedPersonId = requested("personId");
    const requestedLeadId = requested("leadId");
    const requestedNewsletterId = requested("newsletterId");
    // Opening a tab or record in place records it in the URL without a re-render.
    const recordRoute = (path) => navigateCanonicalWorkspace(path, {}, { render: false });
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "sponsor-crm-surface";
    surface.innerHTML = sponsorSurfaceMarkup(humanizeOptionLabel, { escapeHtml, initialTab });
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
    setRouteTitle("CRM");
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
    const moneyTab = surface.querySelector('[data-crm-nav-tab="money"]');
    const sponsorMoney = createSponsorMoney({
      escapeHtml, request, surface, workApiUrl,
      openDeal: (dealId) => directoryPages.openRecord("deal", dealId),
      onAvailability: (enabled) => (moneyTab.hidden = !enabled),
    });
    const { loadFinance } = sponsorFinance;
    let ownerDirectoryLoaded = false;
    async function ensureOwnerDirectory() {
      if (ownerDirectoryLoaded) return;
      try {
        await ownerDirectory.load();
      } catch {
        // Owner names degrade honestly (Unavailable assignee); the record
        // itself must never fail because the team directory did.
      }
      ownerDirectoryLoaded = true;
    }
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
    const { loadFollowups } = createFollowupsController({ surface, api });

    // E directory pages factory is constructed after the record modules
    // below: it receives them directly instead of lazy closures.
    function setView(view, redraw = true) {
      currentView = view;
      // Every user tab/list transition advances the page-owned generation so
      // in-flight saves and stale record opens never paint over the new tab.
      directoryPages.noteTabTransition();
      surface.classList.remove("has-booking-detail");
      // Any list/page tab exits the record detail pane; a phone shows the list again.
      surface.querySelector("[data-crm-split]").dataset.view = "list";
      surface.classList.toggle("is-pipeline", view === "pipeline");
      surface.querySelectorAll("[data-crm-nav-tab]").forEach((link) => {
        if (link.dataset.crmNavTab === view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      const more = surface.querySelector("[data-crm-nav-more]");
      const moreCurrent = ["leads", "newsletters", "money"].includes(view);
      if (more) {
        // The secondary menu never hangs open over another tab's content.
        if (moreCurrent) more.setAttribute("open", "");
        else more.removeAttribute("open");
      }
      const pipeline = surface.querySelector("[data-crm-bookings]");
      const companies = surface.querySelector('[data-dir-root="companies"]');
      const people = surface.querySelector('[data-dir-root="people"]');
      const followups = surface.querySelector(".crm-followups");
      pipeline.hidden = view !== "pipeline";
      companies.hidden = view !== "companies";
      people.hidden = view !== "people";
      if (followups) followups.hidden = view !== "followups";
      surface.querySelector(".crm-leads").hidden = view !== "leads";
      surface.querySelector(".crm-newsletters").hidden = view !== "newsletters";
      if (!(surface.querySelector(".crm-money").hidden = view !== "money")) sponsorMoney.loadMoney();
      if (view === "followups") loadFollowups();
      surface.querySelector(".crm-layout").hidden = PAGE_VIEWS.has(view);
      // Pipeline fills the content area; the other views scroll the page.
      surface.classList.toggle("dk-fill", !surface.querySelector(".crm-layout").hidden);
      surface.querySelector("[data-crm-pipeline]").hidden = view !== "pipeline";
      surface.querySelector(".crm-funnel-scope").hidden = view !== "pipeline";
      surface.querySelector(".crm-funnel-controls").hidden = view !== "pipeline";
      surface.querySelector(".crm-filter-disclosure").hidden = view !== "pipeline";
      const heading = surface.querySelector("[data-crm-list-heading]");
      heading.textContent =
        view === "pipeline" ? "Pipeline"
        : view === "companies" ? "Companies"
        : view === "people" ? "People"
        : view === "followups" ? "Follow-ups"
        : view === "leads" ? "Leads"
        : view === "newsletters" ? "Newsletters"
        : "Money";
      if (redraw) draw();
    }
    const contactEditor = createSponsorContactEditor({
      api,
      surface,
      getContacts: () => contacts,
      getOrganizations: () => organizations,
      safe,
      openDialog,
      stale,
      capturePageCurrent: () => directoryPages.capturePageCurrent(),
      captureSaveContext: () => directoryPages.captureSaveContext(),
      saveContextOwnsSurface: (ctx) => directoryPages.saveContextOwnsSurface(ctx),
      afterSave: async (
        organizationId,
        saveContext,
        isPostCloseCurrent = () => !saveContext || directoryPages.saveContextOwnsSurface(saveContext),
      ) => {
        const isCurrent = () => isPostCloseCurrent() && !stale();
        if (!isCurrent()) return;
        const record = saveContext?.record;
        if (record) {
          if (record.kind === "person") {
            await personDetail.openPerson(record.id, { isCurrent });
            return;
          }
          const companyId = record.kind === "company"
            ? record.id
            : deals.find((item) => item.id === record.id)?.organizationId || organizationId;
          await directoryPages.loadCompanySummary(companyId);
          if (!isCurrent()) return;
          await reopenCompanyDetail({ id: companyId }, null, { isCurrent });
          return;
        }
        await refresh();
      },
    });
    const personDetail = createSponsorPersonDetail({
      api,
      surface,
      escapeHtml,
      safe,
      closeRecord: () => directoryPages.closeRecord(),
      openCompanyRecord: (organizationId) => directoryPages.openRecord("company", organizationId, undefined, { keepContext: true }),
      openContactEditor: (target, options) => contactEditor.open(target, options),
    });
    const { reopenDealDetail, reopenCompanyDetail, getSelectedDealId } = createSponsorCompanyDetail({
      api,
      surface,
      escapeHtml,
      humanizeOptionLabel,
      humanSponsorDate,
      navigateCanonicalWorkspace,
      // Closing a record returns to the tab it was opened from.
      listPath: () => directoryPages.listPath(currentView),
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
      openTaskPanel,
      openCompanyRecord: (organizationId) => directoryPages.openRecord("company", organizationId),
      openContactEditor: (target, options) => contactEditor.open(target, options),
      onEditCompany: (company) => openOrg(company),
      // Next-task owner beside due/description (same lookup pipeline uses;
      // Unassigned/Unavailable honest, raw IDs never rendered, no new reads).
      ownerName: (id) => ownerDirectory.name(id),
      // F adopts this in its close path (E bridge removed: F delegates Back).
      closeRecord: () => directoryPages.closeRecord(),
      // List refresh after record Archive/Restore/edits stays E-owned: F calls
      // this after mutating the company; Back also refreshes via closeRecord.
      onRecordChanged: () => {
        if (currentView === "companies" || currentView === "people") {
          safe(() => directoryPages.directories[currentView].refresh(), "Could not refresh directory");
        }
      },
    });
    // E directory pages: bounded directories, pipeline URL lifecycle,
    // saved-view dialogs, add-person wiring, record opening, Back context.
    // Constructed after the record modules so callbacks bind directly.
    const directoryPages = createSponsorDirectoryPages({
      api,
      surface,
      escapeHtml,
      humanSponsorDate,
      safe,
      openDialog,
      navigateCanonicalWorkspace,
      openContactEditor: (target, options) => contactEditor.open(target, options),
      reloadPipeline: (reset, extra) => pipeline.load(reset, extra),
      showView: (view, redraw) => setView(view, redraw),
      getCurrentView: () => currentView,
      getDeals: () => deals,
      setDeals: (items) => { deals = items; },
      getOrganizations: () => organizations,
      setOrganizations: (items) => { organizations = items; },
      ensureOwnerDirectory,
      ensureOwnerDirectory,
      reopenDealDetail: (...args) => reopenDealDetail(...args),
      reopenCompanyDetail: (...args) => reopenCompanyDetail(...args),
      personDetail,
      renderEntityLoadState,
      isStale: () => stale(),
    });
    directoryPages.seedListParams(
      sponsorsRoute?.sponsorsTab,
      Object.fromEntries((sponsorsRoute?.params || new URLSearchParams()).entries()),
    );
    sponsorFinance.setReopenBookingDetail(async (booking) => {
      // Per-invocation page predicate for the injected finance/record paint:
      // navigation during the load must not paint over the newer surface.
      const isCurrent = directoryPages.capturePageCurrent();
      if (
        surface.classList.contains("has-booking-detail") &&
        surface.querySelector('[data-booking-panel="finance"]')
      ) {
        await loadFinance(booking, { isCurrent });
      } else {
        await reopenDealDetail(booking, { isCurrent });
      }
    });

    function draw() {
      if (currentView === "pipeline") pipeline.draw();
    }


    const pipeline = createSponsorPipelineView({
      api,
      surface,
      escapeHtml,
      humanSponsorDate,
      ownerName: (id) => ownerDirectory.name(id),
      openTaskPanel,
      safe,
      captureCurrent: () => directoryPages.capturePipelineCurrent(),
      onChange: ({ cursor, isCurrent }) => directoryPages.pipeline.writeUrl(cursor, isCurrent),
    });
    const runPipelineLoad = (reset = true, extra = {}) => directoryPages.pipeline.load(reset, extra);
    let pipelineUrlApplied = false;
    let directoryLoaded = false;
    async function ensureDirectory() {
      if (directoryLoaded) return;
      const [orgs, people] = await Promise.all([readSponsorDirectory(api, "organizations"), readSponsorDirectory(api, "contacts")]);
      organizations = orgs.items; contacts = people.items; directoryLoaded = true; orgOptions();
    }

    async function refresh({ coldRecord = false } = {}) {
      const isRefreshCurrent = directoryPages.capturePageCurrent();
      directoryLoaded = false;
      message.textContent = "Loading sponsor CRM…";
      message.hidden = false;
      // Cold deep links open the record directly: the tab list behind it
      // stays unloaded until Back or tab navigation asks for it. In-place
      // opens reuse the already-loaded list.
      if (coldRecord && (currentView === "pipeline" || currentView === "companies" || currentView === "people")) {
        message.textContent = "";
        message.hidden = true;
        return;
      }
      if (currentView === "pipeline") {
        const isPipelineCurrent = directoryPages.capturePipelineCurrent();
        await ownerDirectory.load();
        if (!isPipelineCurrent()) return;
        ownerDirectory.fillFilter(surface.querySelector("[data-pipeline-owner]"));
        if (!pipelineUrlApplied) {
          pipelineUrlApplied = true;
          await directoryPages.pipeline.initFromParams(isPipelineCurrent);
        } else {
          await runPipelineLoad(true, { isCurrent: isPipelineCurrent });
        }
        if (!isPipelineCurrent()) return;
      }
      else if (currentView === "companies") await directoryPages.directories.companies.refresh();
      else if (currentView === "people") await directoryPages.directories.people.refresh();
      else if (currentView === "leads") await sponsorLeads.loadLeads();
      else if (currentView === "newsletters") await sponsorNewsletters.loadNewsletters();
      if (!isRefreshCurrent()) return;
      // A notice raised mid-refresh (invalid URL enums, saved-view errors)
      // survives completion; only the loading text itself is cleared.
      if (message.textContent === "Loading sponsor CRM…") {
        message.textContent = "";
        message.hidden = true;
      }
    }

    function drawAlerts() {
      renderSponsorBookingAlerts({ surface, notificationState, escapeHtml });
    }
    function bindDialogGuard(dialog) {
      return createSponsorDialogGuard({
        dialog,
        openDialog,
        stale,
        capturePageCurrent: () => directoryPages.capturePageCurrent(),
        captureSaveContext: () => directoryPages.captureSaveContext(),
        saveContextOwnsSurface: (saveContext) =>
          directoryPages.saveContextOwnsSurface(saveContext),
      });
    }
    const dealDialogGuard = bindDialogGuard(surface.querySelector("[data-deal-dialog]"));
    const orgDialogGuard = bindDialogGuard(surface.querySelector("[data-org-dialog]"));
    async function openDeal(item) {
      const canOpen = dealDialogGuard.beginOpen();
      await Promise.all([ensureDirectory(), ownerDirectory.load()]);
      if (!canOpen()) return;
      populateSponsorDealForm(dealDialogGuard.dialog.querySelector("form"), item, ownerDirectory, fillContacts);
      dealDialogGuard.finishOpen();
    }
    function openOrg(item = null) {
      orgDialogGuard.beginOpen();
      const form = orgDialogGuard.dialog.querySelector("form");
      orgDialogGuard.finishOpen();
      form.elements.organizationId.value = item?.id || "";
      form.elements.version.value = item?.version != null ? String(item.version) : "";
      form.elements.displayName.value = item?.displayName || "";
      form.elements.domain.value = item?.domain || "";
      form.elements.notes.value = item?.notes || "";
    }
    let searchTimer;
    const schedulePipeline = () => {
      clearTimeout(searchTimer);
      const isCurrent = directoryPages.capturePipelineCurrent();
      searchTimer = setTimeout(() => {
        if (!isCurrent()) return;
        safe(() => runPipelineLoad(true, { isCurrent }), "Could not load pipeline");
      }, 180);
    };
    // A manual control edit unpins the selected saved view (the URL keeps
    // the effective filters, so the state stays shareable).
    function pipelineControlsChanged(reload) {
      pipelineUrlApplied = true;
      directoryPages.pipeline.controlsChanged(reload);
    }
    surface.querySelectorAll("[data-pipeline-view],[data-pipeline-sort],[data-pipeline-owner],[data-pipeline-from],[data-pipeline-to]").forEach((input) =>
      input.addEventListener("change", () => pipelineControlsChanged(() => safe(() => runPipelineLoad(), "Could not load pipeline"))),
    );
    alertsSection.addEventListener("toggle", () => {
      if (alertsSection.open) safe(async () => {
        notificationState = await notificationLoader.load(); drawAlerts();
      }, "Could not load alerts");
    });
    surface.querySelectorAll("[data-crm-search],[data-crm-status]").forEach((input) =>
      input.addEventListener("input", () => pipelineControlsChanged(schedulePipeline)),
    );
    surface.querySelector("[data-crm-nav]").addEventListener("click", (event) => {
      const link = event.target.closest("[data-crm-nav-tab]");
      // Tabs are links: a modified click opens the tab's URL in a new tab.
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
      event.preventDefault();
      const view = link.dataset.crmNavTab;
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
      pipelineControlsChanged(() => safe(() => runPipelineLoad(), "Could not load pipeline"));
      recordRoute(sponsorsPath("pipeline"));
    });
    surface.querySelector("[data-crm-detail]").addEventListener("click", (event) => {
      if (surface.classList.contains("has-booking-detail")) return;
      const dealId = event.target.closest("[data-open-deal]")?.dataset.openDeal;
      if (dealId) {
        directoryPages.openRecord("deal", dealId);
      }
    });
    surface.querySelector("[data-add-org]").onclick = () => openOrg(null);
    surface.querySelector("[data-add-deal]").onclick = () => openDeal(null);
    // Record links are real anchors: plain clicks open in place, modified
    // clicks open the canonical URL in a new tab. Already-handled clicks
    // (F record links intercept with keepContext first) and Alt/modified
    // clicks are never reopened here.
    surface.addEventListener("click", (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      const company = event.target.closest("[data-open-company]");
      const person = event.target.closest("[data-open-person]");
      if (!company && !person) return;
      // Pipeline rows use buttons, not directory links.
      if (event.target.closest("[data-crm-bookings]")) return;
      event.preventDefault();
      if (company) directoryPages.openRecord("company", company.dataset.openCompany, `[data-open-company="${company.dataset.openCompany}"]`);
      else directoryPages.openRecord("person", person.dataset.openPerson, `[data-open-person="${person.dataset.openPerson}"]`);
    });
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
        directoryPages.openRecord("deal", dealId);
        return;
      }
      if (companyId) {
        directoryPages.openRecord("company", companyId);
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
      if (id) directoryPages.openRecord("deal", id);
      else if (companyId) directoryPages.openRecord("company", companyId);
    };
    for (const dialog of surface.querySelectorAll("dialog")) {
      const cancel = dialog.querySelector('[value="cancel"],[data-cancel]');
      if (cancel) cancel.onclick = () => {
        if (dialog === orgDialogGuard.dialog) orgDialogGuard.cancel();
        if (dialog === dealDialogGuard.dialog) dealDialogGuard.cancel();
        dialog.close();
      };
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
    function activeDealRecipientOptions() {
      const deal = deals.find((item) => item.id === sponsorCommunications.selectedBookingId);
      const recipients = contacts
        .filter((item) => item.organizationId === deal?.organizationId && item.active !== false && !item.archivedAt)
        .flatMap((item) => (item.emails || []).map((email) => ({ contactId: item.id, name: item.name, email })));
      const options = recipients
        .map(
          (item) =>
            html`<option value="${escapeHtml(item.email)}" data-contact-id="${escapeHtml(item.contactId)}">
              ${escapeHtml(item.name || "Sponsor contact")} · ${escapeHtml(item.email)}
            </option>`,
        )
        .join("");
      return { recipients, options };
    }
    surface.addEventListener("click", (event) => {
      if (!event.target.closest("[data-crm-communications]")) return;
      if (event.target.closest("[data-suppress-address]")) {
        const { options } = activeDealRecipientOptions();
        const dialog = surface.querySelector("[data-suppression-dialog]");
        const form = dialog.querySelector("form");
        form.reset();
        form.elements.recipient.innerHTML = options;
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
      const suggestionId = event.target.closest("[data-draft-suggestion]")?.dataset.draftSuggestion;
      if (suggestionId) {
        const suggestion = sponsorCommunications.communicationItems.find((item) => item.id === suggestionId);
        const { recipients, options } = activeDealRecipientOptions();
        if (!suggestion || !recipients.length) {
          message.hidden = false;
          message.textContent =
            "At least one active contact address in this sponsor organization is required before drafting.";
          return;
        }
        const dialog = surface.querySelector("[data-communication-draft-dialog]");
        const form = dialog.querySelector("form");
        form.reset();
        form.elements.suggestionId.value = suggestionId;
        form.elements.recipient.innerHTML = options;
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
      const guard = orgDialogGuard.beginSave();
      if (!guard) return;
      const form = orgDialogGuard.dialog.querySelector("form");
      const submitHadDetail = surface.classList.contains("has-booking-detail");
      safe(async () => {
        const raw = Object.fromEntries(new FormData(form));
        const id = (raw.organizationId || "").trim();
        const payload = {
          displayName: raw.displayName ?? "", domain: raw.domain ?? "", notes: raw.notes ?? "",
          ...(id && raw.version !== undefined && raw.version !== "" ? { version: Number(raw.version) } : {}),
        };
        let saved;
        try {
          saved = await api(id ? `/organizations/${encodeURIComponent(id)}` : "/organizations", {
            method: id ? "PUT" : "POST", body: JSON.stringify(payload),
          });
        } catch (error) {
          if (guard.fail(error, "Could not save sponsor")) throw error;
          return;
        }
        const isPostCloseCurrent = guard.closeAndContinue();
        if (!isPostCloseCurrent) return;
        try {
          if (id && submitHadDetail) {
            await directoryPages.loadCompanySummary(saved.id);
            if (!isPostCloseCurrent()) return;
            await reopenCompanyDetail(saved, getSelectedDealId(), {
              isCurrent: isPostCloseCurrent,
            });
            return;
          }
          await refresh();
        } finally {
          isPostCloseCurrent.done();
        }
      }, "Could not save sponsor");
    };
    surface.querySelector("[data-deal-save]").onclick = (event) => {
      event.preventDefault();
      const guard = dealDialogGuard.beginSave();
      if (!guard) return;
      const form = dealDialogGuard.dialog.querySelector("form");
      const submitHadDetail = surface.classList.contains("has-booking-detail");
      safe(async () => {
        const raw = Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
        const id = raw.dealId;
        const payload = {
          organizationId: raw.organizationId, primaryContactId: raw.primaryContactId || undefined,
          status: raw.status, productKind: raw.productKind, historyNote: raw.historyNote,
        };
        if (raw.version) payload.version = Number(raw.version);
        if (raw.amountEur) payload.amountEur = Number(raw.amountEur);
        if (raw.lostReason) payload.lostReason = raw.lostReason;
        const hasPromo = raw.title || raw.requiredLinkUrl || raw.contentType || raw.promotionSource
          || raw.relevancy || raw.influencerHandle || raw.publishedAt;
        const deliverableFields = () => {
          const body = {
            channel: raw.channel || "main",
            plannedPublicationDate: raw.plannedPublicationDate || undefined,
            materialDeadline: raw.materialDeadline || undefined,
          };
          if (raw.title) body.title = raw.title;
          if (raw.requiredLinkUrl) body.requiredLinkUrl = raw.requiredLinkUrl;
          if (raw.contentType) body.contentType = raw.contentType;
          if (raw.promotionSource) body.promotionSource = raw.promotionSource;
          if (raw.relevancy) body.relevancy = raw.relevancy;
          if (raw.influencerHandle) body.influencerHandle = raw.influencerHandle;
          if (raw.publishedAt) {
            const iso = new Date(raw.publishedAt).toISOString();
            if (!Number.isNaN(Date.parse(iso))) body.publishedAt = iso;
          }
          return body;
        };
        if (!id && (raw.channel || raw.plannedPublicationDate || raw.materialDeadline || hasPromo)) {
          payload.deliverable = deliverableFields();
        }
        let saved;
        try {
          saved = await api(`/deals${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
          if (id && raw.deliverableId && (raw.channel || raw.plannedPublicationDate || raw.materialDeadline || hasPromo)) {
            const delivBody = { ...deliverableFields(), version: Number(raw.deliverableVersion || 1) };
            await api(`/deliverables/${raw.deliverableId}`, { method: "PUT", body: JSON.stringify(delivBody) });
          }
          if (raw.taskDescription) {
            await request(workApiUrl("/api/tasks"), {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                description: raw.taskDescription,
                date: raw.taskDate || new Date().toISOString().slice(0, 10),
                ...(raw.taskAssignee ? { assigneeId: raw.taskAssignee } : {}),
                subject: { type: "sponsor-deal", id: saved.id },
              }),
            });
          }
        } catch (error) {
          if (guard.fail(error, "Could not save deal")) throw error;
          return;
        }
        const isPostCloseCurrent = guard.closeAndContinue();
        if (!isPostCloseCurrent) return;
        try {
          if (submitHadDetail) {
            await directoryPages.loadCompanySummary(saved.organizationId);
            if (!isPostCloseCurrent()) return;
            deals = [...deals.filter((value) => value.id !== saved.id), saved];
            await reopenDealDetail(saved, {
              isCurrent: isPostCloseCurrent,
            });
            return;
          }
          await refresh();
        } finally {
          isPostCloseCurrent.done();
        }
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
      const coldRecord = Boolean(requestedDealId || requestedCompanyId || requestedPersonId);
      await refresh({ coldRecord });
      if (stale()) return;
      if (requestedNewsletterId) await sponsorNewsletters.showNewsletter(requestedNewsletterId);
      // [id, kind, where its load state renders, tab to return to, open it]
      const record = [
        [requestedDealId, "deal", "[data-crm-detail]", "pipeline", async (id) => directoryPages.openRecord("deal", id)],
        [requestedCompanyId, "company", "[data-crm-detail]", "companies", async (id) => directoryPages.openRecord("company", id)],
        [requestedPersonId, "person", "[data-crm-detail]", "people", async (id) => directoryPages.openRecord("person", id)],
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
      surface.querySelector("[data-crm-bookings]").textContent = "Could not load deals.";
      message.hidden = false;
      message.textContent = `Permission or API error: ${error.message}. Reopen CRM to retry.`;
    }
  }

  return {
    canLeaveFinanceSurface,
    renderSponsorCrmSurface,
  };
}
