import { SPLIT_BACK_ICON } from "../split-back-icon.js";
import { html } from "./shared.js";

/**
 * Company page for the Sponsors surface: people, deals, filed mail, finance,
 * communications, and history. Extracted from sponsors.js so the surface
 * factory stays under the 1,000-line module contract.
 */
export function createSponsorCompanyDetail({
  api,
  surface,
  escapeHtml,
  humanizeOptionLabel,
  humanSponsorDate,
  navigateCanonicalWorkspace,
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
}) {
  function historyDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  }

  function mailThreadMarkup(item) {
    const direction = { inbound: "Incoming", outbound: "Outgoing" }[item.direction]
      || humanizeOptionLabel(item.direction);
    return html`<li>
      <strong>${escapeHtml(direction)}</strong>
      ${item.sentAt ? html` · ${escapeHtml(historyDateTime(item.sentAt))}` : ""}
      ${item.snippet ? html`<p>${escapeHtml(item.snippet)}</p>` : ""}
    </li>`;
  }

  async function reopenDealDetail(deal) {
    const organization =
      getOrganizations().find((item) => item.id === deal.organizationId) ||
      (await api(`/organizations/${deal.organizationId}`));
    await reopenCompanyDetail(organization, deal);
  }

  async function reopenCompanyDetail(organization, highlightedDeal) {
    const orgDeals = getDeals().filter(
      (item) => item.organizationId === organization.id,
    );
    const orgContacts = getContacts().filter(
      (item) => item.organizationId === organization.id && !item.archivedAt,
    );
    const deal =
      highlightedDeal ||
      orgDeals.find((item) => item.status !== "lost") ||
      orgDeals[0];
    if (deal) sponsorCommunications.selectedBookingId = deal.id;
    surface.classList.add("has-booking-detail");
    // The queue marks this company as the selected row; on a phone the split
    // shows the detail pane.
    surface.dataset.selectedCompany = organization.id;
    const split = surface.querySelector("[data-crm-split]");
    split.dataset.view = "detail";
    draw();
    const history = deal ? await api(`/deals/${deal.id}/history`) : { items: [] };
    const mail = await api(`/organizations/${organization.id}/messages`);
    const historyMarkup = (history.items || []).length
      ? history.items
          .map(
            (item) => html`
              <div>
                <strong>
                  ${escapeHtml(humanizeOptionLabel(item.oldStatus || "created"))}
                  → ${escapeHtml(humanizeOptionLabel(item.newStatus))}
                </strong>
                <small>Recorded ${escapeHtml(historyDateTime(item.createdAt))}</small>
                ${item.note ? html`<p>${escapeHtml(item.note)}</p>` : ""}
              </div>
            `,
          )
          .join("")
      : html`
          <div class="honest-state">
            <strong>No status changes yet</strong>
            <p>Changes to the deal status will appear here.</p>
          </div>
        `;
    const people = orgContacts.length
      ? orgContacts
          .map(
            (item) => html`<li>
              ${escapeHtml(item.name)}
              ${item.emails?.[0] ? html` · ${escapeHtml(item.emails[0])}` : ""}
            </li>`,
          )
          .join("")
      : html`<li>No people yet.</li>`;
    const dealCards = orgDeals.length
      ? orgDeals
          .map((item) => {
            const action = item.nextAction;
            const next = action?.due
              ? `${humanizeOptionLabel(action.type)} · ${humanSponsorDate(action.due)}`
              : item.rotting
                ? "Next action missing"
                : "No next action";
            const current = deal?.id === item.id ? 'aria-current="true"' : "";
            return html`<article class="crm-card crm-company-deal" ${current}>
              <div class="crm-deal-card-header">
                <strong>
                  ${escapeHtml(({ "one-off": "One-off", package: "Package", course: "Course" }[item.productKind] || "Deal"))}
                </strong>
                <span class="status-label" data-status="${escapeHtml(item.status)}">
                  ${escapeHtml(humanizeOptionLabel(item.status))}
                </span>
              </div>
              <p class="crm-deal-meta">
                ${[
                  item.money && item.money !== "none" ? humanizeOptionLabel(item.money) : "",
                  item.fulfillment && item.fulfillment !== "none" ? humanizeOptionLabel(item.fulfillment) : "",
                  next,
                ].filter(Boolean).map((value) => escapeHtml(value)).join(" · ")}
              </p>
              <div class="row-actions">
                <button data-edit-deal="${escapeHtml(item.id)}">Edit deal</button>
              </div>
            </article>`;
          })
          .join("")
      : html`<div class="honest-state">
          <strong>No deals</strong>
          <p>Add a deal for this company.</p>
        </div>`;
    const threads = (mail.items || []).length
      ? (mail.items || [])
          .map(mailThreadMarkup)
          .join("")
      : html`<li class="crm-mail-empty">
          <strong>No filed mail yet</strong>
          <p>Threads linked to this company will appear here.</p>
        </li>`;
    const kindLabel = humanizeOptionLabel(
      deal ? deal.status : organization.relationship || "company",
    );
    const domainChip = organization.domain
      ? html`<span class="status-label" data-status="domain">${escapeHtml(organization.domain)}</span>`
      : "";
    const dealChip = deal
      ? html`<span class="status-label" data-status="${escapeHtml(deal.status)}">
          ${escapeHtml(humanizeOptionLabel(deal.status))}
        </span>`
      : "";
    surface.querySelector("[data-crm-detail]").innerHTML = html`<header
        class="dk-split__head"
      >
        <button type="button" class="dk-split__back" data-close-booking aria-label="Back to Sponsors">
          ${SPLIT_BACK_ICON}Sponsors
        </button>
        <div class="booking-detail-title">
          <p class="booking-kind">${escapeHtml(kindLabel)}</p>
          <h2 class="dk-split__title" tabindex="-1">${escapeHtml(organization.displayName || "Unknown sponsor")}</h2>
          <p>${domainChip}${dealChip}</p>
        </div>
        <button
          data-edit-deal="${deal ? escapeHtml(deal.id) : ""}"
          ${deal ? "" : "hidden"}
        >
          Edit deal
        </button>
      </header>
      <article class="dk-split__scroll crm-booking-detail">
      <nav class="booking-section-nav dk-split__sticky" aria-label="Company detail sections">
        <button
          class="is-active"
          aria-pressed="true"
          data-booking-section-link="overview"
        >
          Overview
        </button>
        <button aria-pressed="false" data-booking-section-link="finance">
          Finance
        </button>
        <button
          aria-pressed="false"
          data-booking-section-link="communications"
        >
          Communications
        </button>
        <button aria-pressed="false" data-booking-section-link="history">
          History
        </button>
      </nav>
      <div class="booking-detail-sections">
        <section
          id="booking-overview"
          class="booking-detail-section"
          data-booking-panel="overview"
        >
          <header><h3>Overview</h3></header>
          <header class="crm-company-section-header">
            <h4>People</h4>
            <button data-contact-org="${escapeHtml(organization.id)}">Add contact</button>
          </header>
          <ul>${people}</ul>
          <header class="crm-company-section-header">
            <h4>Deals</h4>
            <button data-add-deal-org="${escapeHtml(organization.id)}">Add deal</button>
          </header>
          ${dealCards}
          <header class="crm-company-section-header"><h4>Mail</h4></header>
          <label class="crm-mail-search">
            Search filed threads <input data-mail-search type="search" placeholder="Search this company’s mail" />
          </label>
          <ul data-mail-threads>${threads}</ul>
        </section>
        <section
          id="booking-finance"
          class="booking-detail-section"
          data-booking-panel="finance"
        >
          <div class="honest-state">
            <strong>
              ${deal
                ? "Loading finance…"
                : "Select a deal to load finance."}
            </strong>
          </div>
        </section>
        <section
          id="booking-communications"
          class="booking-detail-section"
          data-booking-panel="communications"
          aria-labelledby="crm-communications-heading"
        >
          <header>
            <h3 id="crm-communications-heading">Communications</h3>
            <p>Suggestions never draft, approve, or send automatically.</p>
          </header>
          <div data-crm-communications>
            <div class="honest-state">
              <strong>
                ${deal
                  ? "Loading communications…"
                  : "Select a deal to load communications."}
              </strong>
            </div>
          </div>
        </section>
        <section
          id="booking-history"
          class="booking-detail-section"
          data-booking-panel="history"
        >
          <header><h3>History</h3></header>
          <div class="crm-history">${historyMarkup}</div>
        </section>
      </div>
    </article>`;
    surface.querySelector("[data-close-booking]").addEventListener("click", () => {
      navigateCanonicalWorkspace("/sponsors", {}, { restoreFocus: { kind: "split-list" } });
    });
    globalThis.dakitSplit?.show(split, "detail");
    surface
      .querySelector("[data-crm-detail] [data-edit-deal]")
      ?.addEventListener("click", (event) => {
        const id = event.currentTarget.dataset.editDeal;
        const item = getDeals().find((value) => value.id === id);
        if (item) openDeal(item);
      });
    surface
      .querySelector("[data-add-deal-org]")
      ?.addEventListener("click", (event) => {
        openDeal({
          organizationId: event.currentTarget.dataset.addDealOrg,
          status: "open",
        });
      });
    surface
      .querySelector("[data-contact-org]")
      ?.addEventListener("click", (event) => {
        const form = surface.querySelector("[data-contact-dialog] form");
        form.reset();
        form.elements.organizationId.value =
          event.currentTarget.dataset.contactOrg;
        openDialog(surface.querySelector("[data-contact-dialog]"));
      });
    surface.querySelectorAll("[data-booking-section-link]").forEach((button) =>
      button.addEventListener("click", () => {
        surface.querySelectorAll("[data-booking-section-link]").forEach((item) => {
          const active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
        surface
          .querySelector(
            `[data-booking-panel="${button.dataset.bookingSectionLink}"]`,
          )
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
    );
    surface
      .querySelector("[data-mail-search]")
      ?.addEventListener("input", (event) => {
        safe(async () => {
          const query = new URLSearchParams();
          if (event.target.value) query.set("q", event.target.value);
          const result = await api(
            `/organizations/${organization.id}/messages?${query}`,
          );
          surface.querySelector("[data-mail-threads]").innerHTML = (
            result.items || []
          ).length
            ? result.items
                .map(mailThreadMarkup)
                .join("")
            : html`<li class="crm-mail-empty">No matching filed threads.</li>`;
        }, "Could not search mail");
      });
    if (deal) {
      await loadFinance(deal);
      try {
        await loadCommunications(deal.id);
      } catch (error) {
        const root = surface.querySelector("[data-crm-communications]");
        if (root) {
          root.innerHTML = html`<div class="honest-state">
            <strong>Communications unavailable</strong>
            <p>${escapeHtml(error.message)}</p>
          </div>`;
        }
      }
    }
  }

  return { reopenDealDetail, reopenCompanyDetail };
}
