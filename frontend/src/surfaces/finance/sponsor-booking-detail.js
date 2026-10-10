import { html } from "./shared.js";

/**
 * Booking detail panel for the Sponsors surface: history fetch, overview /
 * finance / communications / history sections, section tabs, and the finance
 * and communications loaders. Extracted from sponsors.js so the surface
 * factory stays under the 1,000-line module contract; behavior unchanged.
 */
export function createSponsorBookingDetail({
  api,
  surface,
  escapeHtml,
  humanizeOptionLabel,
  humanSponsorDate,
  navigateCanonicalWorkspace,
  getOrganizations,
  getContacts,
  sponsorCommunications,
  draw,
  openBooking,
  loadFinance,
  loadCommunications,
}) {
  async function reopenBookingDetail(booking) {
    const history = await api(`/bookings/${booking.id}/history`);
    const org = getOrganizations().find(
      (item) => item.id === booking.organizationId,
    );
    const contact = getContacts().find(
      (item) => item.id === booking.primaryContactId,
    );
    sponsorCommunications.selectedBookingId = booking.id;
    surface.classList.add("has-booking-detail");
    draw();
    const historyMarkup = (history.items || []).length
      ? history.items
          .map(
            (item) => html`
              <div>
                <strong>
                  ${escapeHtml(humanizeOptionLabel(item.oldStatus || "created"))}
                  → ${escapeHtml(humanizeOptionLabel(item.newStatus))}
                </strong>
                <small>Recorded ${escapeHtml(item.createdAt)}</small>
                ${item.note ? html`<p>${escapeHtml(item.note)}</p>` : ""}
              </div>
            `,
          )
          .join("")
      : html`
          <div class="honest-state">
            <strong>No status changes yet</strong>
            <p>Changes to the booking status will appear here.</p>
          </div>
        `;
    surface.querySelector("[data-crm-detail]").innerHTML = html`<article
      class="crm-booking-detail"
    >
      <header class="booking-detail-header">
        <div>
          <button type="button" class="booking-back" data-close-booking>
            ← Bookings
          </button>
          <p class="booking-kind">
            ${escapeHtml(humanizeOptionLabel(booking.slotType || "sponsor"))}
            booking
          </p>
          <h2>${escapeHtml(org?.displayName || "Unknown sponsor")}</h2>
          <p>
            <span class="status-label"
              >${escapeHtml(humanizeOptionLabel(booking.status))}</span
            >
          </p>
        </div>
        <button data-edit-booking="${escapeHtml(booking.id)}">
          Edit booking
        </button>
      </header>
      <nav class="booking-section-nav" aria-label="Booking detail sections">
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
          <header>
            <h3>Overview</h3>
          </header>
          <dl class="booking-overview-list">
            <div>
              <dt>Publication</dt>
              <dd>
                ${escapeHtml(
                  booking.plannedPublicationDate
                    ? humanSponsorDate(booking.plannedPublicationDate)
                    : "Not set",
                )}
              </dd>
            </div>
            <div>
              <dt>Material deadline</dt>
              <dd>
                ${escapeHtml(
                  booking.materialDeadline
                    ? humanSponsorDate(booking.materialDeadline)
                    : "Not set",
                )}
              </dd>
            </div>
            <div>
              <dt>Next action</dt>
              <dd>
                ${escapeHtml(
                  booking.nextActionDate
                    ? humanSponsorDate(booking.nextActionDate)
                    : "Not set",
                )}
              </dd>
            </div>
            <div>
              <dt>Primary contact</dt>
              <dd>${escapeHtml(contact?.name || "Not assigned")}</dd>
            </div>
            <div>
              <dt>Newsletter</dt>
              <dd>
                ${escapeHtml(booking.cardId ? "Linked" : "Not linked")}
              </dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                ${escapeHtml(booking.scheduleEntryId ? "Linked" : "Not linked")}
              </dd>
            </div>
          </dl>
          ${
            booking.notes
              ? html`<div class="booking-notes">
                  <strong>Operator notes</strong>
                  <p>${escapeHtml(booking.notes)}</p>
                </div>`
              : ""
          }
        </section>
        <section
          id="booking-finance"
          class="booking-detail-section"
          data-booking-panel="finance"
        >
          <div class="honest-state"><strong>Loading finance…</strong></div>
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
              <strong>Loading communications…</strong>
            </div>
          </div>
        </section>
        <section
          id="booking-history"
          class="booking-detail-section"
          data-booking-panel="history"
        >
          <header>
            <h3>History</h3>
          </header>
          <div class="crm-history">${historyMarkup}</div>
        </section>
      </div>
    </article>`;
    surface
      .querySelector("[data-close-booking]")
      .addEventListener("click", () => {
        navigateCanonicalWorkspace("/sponsors");
      });
    surface
      .querySelector("[data-crm-detail] [data-edit-booking]")
      .addEventListener("click", () => openBooking(booking));
    surface
      .querySelectorAll("[data-booking-section-link]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          surface
            .querySelectorAll("[data-booking-section-link]")
            .forEach((item) => {
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
    await loadFinance(booking);
    await loadCommunications(booking.id);
  }
  return { reopenBookingDetail };
}
