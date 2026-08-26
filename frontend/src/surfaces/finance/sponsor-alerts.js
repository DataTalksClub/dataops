import { html } from "./shared.js";

export function renderSponsorBookingAlerts({
  surface,
  notificationState,
  escapeHtml,
}) {
  const alerts = notificationState.items.filter(
    (item) =>
      (item.metadata?.sponsorBookingId || item.metadata?.financeBookingId) &&
      !item.dismissed,
  );
  const alertCards = alerts.length
    ? alerts
        .map(
          (item) =>
            html`<article class="crm-card">
              <strong>${escapeHtml(item.message)}</strong>
              <p>Due ${escapeHtml(item.dueAt || "now")}</p>
              <button
                data-alert-booking="${escapeHtml(
                  item.metadata.sponsorBookingId ||
                    item.metadata.financeBookingId,
                )}"
              >
                Open booking
              </button>
            </article>`,
        )
        .join("")
    : notificationState.complete && !notificationState.failed
      ? html`<div class="honest-state">
          <strong>No active sponsor booking alerts</strong>
        </div>`
      : "";
  let continuation = "";
  if (notificationState.loading || notificationState.loadingMore) {
    continuation = html`<p class="honest-state" role="status">
        ${
          notificationState.loadingMore
            ? "Loading more booking alerts…"
            : "Loading booking alerts…"
        }
      </p>`;
  } else if (notificationState.failed && notificationState.moreAvailable) {
    continuation = html`<div class="honest-state">
        <strong role="alert"
          >More alerts are available, but loading failed:
          ${escapeHtml(notificationState.error)}</strong
        ><button type="button" data-load-sponsor-alerts>
          Retry next page</button
        >
      </div>`;
  } else if (notificationState.moreAvailable) {
    continuation = html`<div class="honest-state">
        <span>More booking alerts are available.</span>
        <button type="button" data-load-sponsor-alerts>
          Load more alerts</button
        >
      </div>`;
  } else if (notificationState.failed) {
    continuation = html`<div class="honest-state">
        <strong role="alert">Booking alerts are unavailable:
          ${escapeHtml(notificationState.error)}</strong
        ><button type="button" data-load-sponsor-alerts-retry>
          Retry alerts</button
        >
      </div>`;
  } else if (
    notificationState.complete &&
    notificationState.items.length
  ) {
    continuation = html`<p class="honest-state">
        All notification pages loaded.
      </p>`;
  }

  surface.querySelector("[data-crm-alerts]").innerHTML =
    `${alertCards}${continuation}`;
}
