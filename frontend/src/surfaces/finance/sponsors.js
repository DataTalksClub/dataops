import { createSponsorCommunications } from "./sponsor-communications.js";
import { createSponsorFinance } from "./sponsor-finance.js";
import { sponsorSurfaceMarkup } from "./sponsor-layout.js";
import { html } from "./shared.js";

export function createSponsorCrmSurface(context) {
  const {
    documentList,
    escapeHtml,
    getPendingLegacyRoute,
    humanizeOptionLabel,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    request,
    renderEntityLoadState,
    setPageTitle,
    workApiUrl,
  } = context;

  let sponsorCommunications = null;

  async function canLeaveFinanceSurface(reason = "navigation") {
    return (
      !sponsorCommunications ||
      sponsorCommunications.revokeCurrentReview(reason)
    );
  }

  async function renderSponsorCrmSurface() {
    const routeAtStart = getPendingLegacyRoute();
    const routeToken = routeAtStart?.token;
    const requestedBookingId =
      routeAtStart?.path === "/sponsors"
        ? routeAtStart.params.get("bookingId")
        : null;
    documentList.replaceChildren();
    const bookingStatuses = [
      "inquiry",
      "held",
      "confirmed",
      "materials-pending",
      "materials-ready",
      "scheduled",
      "published",
      "performance-due",
      "complete",
      "cancelled",
    ];
    const bookingStatusOptions = bookingStatuses
      .map(
        (value) => html`
          <option value="${value}">${humanizeOptionLabel(value)}</option>
        `,
      )
      .join("");
    const surface = document.createElement("section");
    surface.className = "sponsor-crm-surface";
    surface.innerHTML = sponsorSurfaceMarkup(bookingStatusOptions);
    documentList.append(surface);
    setPageTitle("Sponsors", "Sponsors");
    const api = (path, options = {}) =>
        request(workApiUrl(`/api/sponsor-crm${path}`), {
          headers: {
            "content-type": "application/json",
            ...(options.headers || {}),
          },
          ...options,
        }),
      message = surface.querySelector("[data-crm-message]");
    let organizations = [],
      contacts = [],
      bookings = [];
    const sponsorFinance = createSponsorFinance({
      escapeHtml,
      humanizeOptionLabel,
      message,
      request,
      surface,
      workApiUrl,
    });
    sponsorCommunications = createSponsorCommunications({
      api,
      escapeHtml,
      getBookings: () => bookings,
      getContacts: () => contacts,
      humanizeOptionLabel,
      message,
      surface,
    });
    const { loadFinance } = sponsorFinance;
    const {
      drawCommunications,
      loadCommunications,
      revokeCurrentReview,
      showExactReview,
    } = sponsorCommunications;
    const safe = async (action, label) => {
      try {
        await action();
      } catch (error) {
        message.textContent = `${label}: ${error.message}`;
      }
    };
    async function reopenBookingDetail(booking) {
      const history = await api(`/bookings/${booking.id}/history`);
      const org = organizations.find(
        (item) => item.id === booking.organizationId,
      );
      const contact = contacts.find(
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
              ← Return to bookings
            </button>
            <p class="surface-eyebrow">
              ${escapeHtml(humanizeOptionLabel(booking.slotType || "sponsor"))}
              booking
            </p>
            <h2>Booking detail</h2>
            <p>
              <strong
                >${escapeHtml(org?.displayName || "Unknown sponsor")}</strong
              ><span class="status-label"
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
              <p class="section-kicker">Current work</p>
              <h3>Overview</h3>
            </header>
            <dl class="booking-overview-list">
              <div>
                <dt>Publication</dt>
                <dd>
                  ${escapeHtml(booking.plannedPublicationDate || "Not set")}
                </dd>
              </div>
              <div>
                <dt>Material deadline</dt>
                <dd>${escapeHtml(booking.materialDeadline || "Not set")}</dd>
              </div>
              <div>
                <dt>Next action</dt>
                <dd>${escapeHtml(booking.nextActionDate || "Not set")}</dd>
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
              <p class="section-kicker">Reviewed delivery</p>
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
              <p class="section-kicker">Audit trail</p>
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
    sponsorFinance.setReopenBookingDetail(reopenBookingDetail);

    function orgOptions() {
      surface.querySelector(
        '[data-booking-dialog] [name="organizationId"]',
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
    function draw() {
      const search = surface
          .querySelector("[data-crm-search]")
          .value.toLowerCase(),
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
                      ${item.archivedAt ? "Archived organization" : "Active organization"}
                    </p>
                  </div>
                  <div class="row-actions">
                    <button data-contact-org="${escapeHtml(item.id)}">
                      Add contact</button
                    >${item.archivedAt ? "" : ` <button data-archive-org="${escapeHtml(item.id)}">Archive</button>`}
                  </div>
                </article>`,
            )
            .join("")
        : html`<div class="honest-state">
            <strong>No sponsors found</strong>
            <p>Adjust filters or add the first sponsor.</p>
          </div>`;
      const shownIds = new Set(shown.map((item) => item.id));
      const visible = bookings.filter(
        (item) =>
          shownIds.has(item.organizationId) &&
          (!status || item.status === status),
      );
      surface.querySelector("[data-booking-count]").textContent =
        `${visible.length} ${visible.length === 1 ? "booking" : "bookings"}`;
      surface.querySelector("[data-crm-bookings]").innerHTML = visible.length
        ? visible
            .map((item) => {
              const org = organizations.find(
                (value) => value.id === item.organizationId,
              );
              return html`<article
                class="crm-booking-row"
                ${item.id === sponsorCommunications.selectedBookingId ? 'aria-current="true"' : ""}
              >
                <div>
                  <strong
                    >${escapeHtml(org?.displayName || "Unknown sponsor")}</strong
                  ><span class="status-label"
                    >${escapeHtml(humanizeOptionLabel(item.status))}</span
                  >
                  <p>
                    ${escapeHtml(item.plannedPublicationDate || "Publication not set")}
                    · next action
                    ${escapeHtml(item.nextActionDate || "not set")}
                  </p>
                </div>
                <div class="row-actions">
                  <button data-open-booking="${escapeHtml(item.id)}">
                    Open booking</button
                  ><button data-edit-booking="${escapeHtml(item.id)}">
                    Edit
                  </button>
                </div>
              </article>`;
            })
            .join("")
        : html`<div class="honest-state">
            <strong>No bookings</strong>
            <p>Create a booking or adjust filters.</p>
          </div>`;
    }
    async function refresh() {
      message.textContent = "Loading sponsor CRM…";
      const results = await Promise.all([
        api("/organizations"),
        api("/contacts"),
        api("/bookings"),
        request(workApiUrl("/api/notifications")),
      ]);
      organizations = results[0].items || [];
      contacts = results[1].items || [];
      bookings = results[2].items || [];
      const alerts = (results[3].notifications || []).filter(
        (item) =>
          (item.metadata?.sponsorBookingId ||
            item.metadata?.financeBookingId) &&
          !item.dismissed,
      );
      surface.querySelector("[data-crm-alerts]").innerHTML = alerts.length
        ? alerts
            .map(
              (item) =>
                html`<article class="crm-card">
                  <strong>${escapeHtml(item.message)}</strong>
                  <p>Due ${escapeHtml(item.dueAt || "now")}</p>
                  <button
                    data-alert-booking="${escapeHtml(item.metadata.sponsorBookingId || item.metadata.financeBookingId)}"
                  >
                    Open booking
                  </button>
                </article>`,
            )
            .join("")
        : "No active sponsor booking alerts.";
      orgOptions();
      draw();
      message.textContent = "Sponsor CRM ready.";
    }
    function openBooking(item) {
      const dialog = surface.querySelector("[data-booking-dialog]"),
        form = dialog.querySelector("form");
      form.reset();
      for (const field of form.elements)
        if (item && field.name && item[field.name] != null)
          field.value = Array.isArray(item[field.name])
            ? item[field.name].join("\n")
            : item[field.name];
      form.elements.bookingId.value = item?.id || "";
      const orgId = item?.organizationId || form.elements.organizationId.value;
      form.elements.primaryContactId.innerHTML = html`<option value="">
          No contact
        </option>
        ${contacts
          .filter(
            (value) => value.organizationId === orgId && !value.archivedAt,
          )
          .map(
            (value) =>
              html`<option value="${escapeHtml(value.id)}">
                ${escapeHtml(value.name)}
              </option>`,
          )
          .join("")}`;
      if (item?.primaryContactId)
        form.elements.primaryContactId.value = item.primaryContactId;
      dialog.showModal();
    }
    surface
      .querySelectorAll("[data-crm-search],[data-crm-active],[data-crm-status]")
      .forEach((input) => input.addEventListener("input", draw));
    surface.querySelector("[data-add-org]").onclick = () =>
      surface.querySelector("[data-org-dialog]").showModal();
    surface.querySelector("[data-add-booking]").onclick = () =>
      openBooking(null);
    surface.querySelector("[data-crm-orgs]").onclick = (event) => {
      const contact =
          event.target.closest("[data-contact-org]")?.dataset.contactOrg,
        archive =
          event.target.closest("[data-archive-org]")?.dataset.archiveOrg;
      if (contact) {
        const form = surface.querySelector("[data-contact-dialog] form");
        form.reset();
        form.elements.organizationId.value = contact;
        surface.querySelector("[data-contact-dialog]").showModal();
      }
      if (archive)
        safe(async () => {
          const organization = organizations.find(
            (item) => item.id === archive,
          );
          if (
            !(await confirmSponsorAction(
              "Archive sponsor organization?",
              `${organization?.displayName || "This organization"} will leave the active directory. Existing bookings and history remain available.`,
              "Archive sponsor",
            ))
          )
            return;
          await api(`/organizations/${archive}`, { method: "DELETE" });
          await refresh();
        }, "Could not archive sponsor");
    };
    surface.querySelector("[data-crm-bookings]").onclick = (event) => {
      const edit = event.target.closest("[data-edit-booking]")?.dataset
          .editBooking,
        open = event.target.closest("[data-open-booking]")?.dataset.openBooking;
      if (edit) openBooking(bookings.find((item) => item.id === edit));
      if (open) navigateCanonicalWorkspace("/sponsors", { bookingId: open });
    };
    surface.querySelector("[data-crm-alerts]").onclick = (event) => {
      const id = event.target.closest("[data-alert-booking]")?.dataset
        .alertBooking;
      const booking = bookings.find((item) => item.id === id);
      if (booking) {
        navigateCanonicalWorkspace("/sponsors", { bookingId: id });
      }
    };
    for (const dialog of surface.querySelectorAll("dialog")) {
      const cancel = dialog.querySelector('[value="cancel"],[data-cancel]');
      if (cancel) cancel.onclick = () => dialog.close();
    }
    surface.querySelector("[data-evaluate-communications]").onclick = () =>
      safe(async () => {
        const result = await api("/communications/evaluate", {
          method: "POST",
          body: "{}",
        });
        message.textContent = `Suggestions refreshed: ${result.created.length} new, ${result.existing.length} already known. No messages were drafted or sent.`;
        if (sponsorCommunications.selectedBookingId)
          await loadCommunications(sponsorCommunications.selectedBookingId);
      }, "Could not refresh communication suggestions");
    surface.addEventListener("click", (event) => {
      if (!event.target.closest("[data-crm-communications]")) return;
      if (event.target.closest("[data-suppress-address]")) {
        const booking = bookings.find(
          (item) => item.id === sponsorCommunications.selectedBookingId,
        );
        const recipients = contacts
          .filter(
            (item) =>
              item.organizationId === booking?.organizationId &&
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
        dialog.showModal();
        return;
      }
      const cancelAttempt = event.target.closest("[data-cancel-attempt]")
        ?.dataset.cancelAttempt;
      if (cancelAttempt) {
        safe(async () => {
          await api(`/communications/attempts/${cancelAttempt}/cancel`, {
            method: "POST",
            body: "{}",
          });
          await loadCommunications(sponsorCommunications.selectedBookingId);
        }, "Could not cancel before dispatch");
        return;
      }
      const reconcileAttempt = event.target.closest("[data-reconcile-attempt]")
        ?.dataset.reconcileAttempt;
      if (reconcileAttempt) {
        const reason = window.prompt(
          "Record why this provider outcome is considered no effect. This never resends the message.",
        );
        if (!reason) return;
        safe(async () => {
          await api(`/communications/attempts/${reconcileAttempt}/reconcile`, {
            method: "POST",
            body: JSON.stringify({ resolution: "no_effect", reason }),
          });
          await loadCommunications(sponsorCommunications.selectedBookingId);
        }, "Could not reconcile provider uncertainty");
        return;
      }
      const reviewDraft = event.target.closest("[data-review-draft]");
      if (reviewDraft) {
        safe(
          async () =>
            showExactReview(
              reviewDraft.dataset.reviewDraft,
              Number(reviewDraft.dataset.draftVersion),
            ),
          "Could not generate a fresh exact review",
        );
        return;
      }
      const suggestionId = event.target.closest("[data-draft-suggestion]")
        ?.dataset.draftSuggestion;
      if (!suggestionId) return;
      const suggestion = sponsorCommunications.communicationItems.find(
        (item) => item.id === suggestionId,
      );
      const booking = bookings.find(
        (item) => item.id === sponsorCommunications.selectedBookingId,
      );
      const recipients = contacts
        .filter(
          (item) =>
            item.organizationId === booking?.organizationId &&
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
        message.textContent =
          "At least one active contact address in this sponsor organization is required before drafting.";
        return;
      }
      const dialog = surface.querySelector("[data-communication-draft-dialog]");
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
      dialog.showModal();
    });
    for (const dialog of surface.querySelectorAll("dialog"))
      dialog
        .querySelector('[value="cancel"]')
        ?.addEventListener("click", () => dialog.close());
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
    surface.querySelector("[data-org-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-org-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(new FormData(form));
        if (!data.displayName) throw new Error("Name is required");
        await api("/organizations", {
          method: "POST",
          body: JSON.stringify(data),
        });
        dialog.close();
        await refresh();
      }, "Could not save sponsor");
    };
    surface.querySelector("[data-contact-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-contact-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(new FormData(form));
        if (!data.name || !data.email)
          throw new Error("Name and email are required");
        data.emails = [data.email];
        delete data.email;
        data.primary = form.elements.primary.checked;
        await api("/contacts", { method: "POST", body: JSON.stringify(data) });
        dialog.close();
        await refresh();
      }, "Could not save contact");
    };
    surface.querySelector("[data-booking-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-booking-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(
          [...new FormData(form)].filter(([, value]) => value !== ""),
        );
        if (data.version) data.version = Number(data.version);
        if (data.artifactUrls)
          data.artifactUrls = data.artifactUrls.split("\n").filter(Boolean);
        const id = data.bookingId;
        delete data.bookingId;
        await api(`/bookings${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        });
        dialog.close();
        await refresh();
      }, "Could not save booking");
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
        await api(
          `/contacts/${selectedRecipient.dataset.contactId}/suppressions`,
          {
            method: "POST",
            body: JSON.stringify({
              email: value.recipient,
              reason: value.reason,
            }),
          },
        );
        dialog.close();
        message.textContent =
          "Future messages to the selected sponsor address are suppressed. In-flight mail cannot be recalled.";
        await loadCommunications(sponsorCommunications.selectedBookingId);
      }, "Could not add suppression");
    };
    surface.querySelector("[data-create-review]").onclick = (event) => {
      event.preventDefault();
      const draftDialog = surface.querySelector(
        "[data-communication-draft-dialog]",
      );
      const form = draftDialog.querySelector("form");
      safe(async () => {
        const value = Object.fromEntries(new FormData(form));
        const selectedRecipient = form.elements.recipient.selectedOptions[0];
        if (!selectedRecipient) throw new Error("Select one recipient");
        const publicLinks = value.publicLink ? [value.publicLink] : [];
        const draft = await api(
          `/communication-suggestions/${value.suggestionId}/drafts`,
          {
            method: "POST",
            body: JSON.stringify({
              contactId: selectedRecipient.dataset.contactId,
              recipient: value.recipient,
              subject: value.subject,
              body: value.body,
              publicLinks,
            }),
          },
        );
        draftDialog.close();
        await loadCommunications(sponsorCommunications.selectedBookingId);
        if (sponsorCommunications.communicationPermissions.canApprove) {
          await showExactReview(draft.communicationId, draft.version);
        } else {
          message.textContent = `Draft version ${draft.version} saved. Awaiting administrator review; no message was approved or sent.`;
        }
      }, "Could not save sponsor message draft");
    };
    surface.querySelector("[data-approve-message]").onclick = (event) => {
      event.preventDefault();
      if (!sponsorCommunications.currentReview) return;
      const reviewDialog = surface.querySelector(
        "[data-communication-review-dialog]",
      );
      safe(async () => {
        const oneTimeReview = sponsorCommunications.currentReview;
        if (
          !oneTimeReview ||
          !sponsorCommunications.communicationPermissions.canApprove
        )
          throw new Error("A fresh administrator review is required");
        let result;
        try {
          result = await api(
            `/communications/${oneTimeReview.communicationId}/approve`,
            {
              method: "POST",
              body: JSON.stringify({
                version: oneTimeReview.version,
                presentationId: oneTimeReview.presentationId,
                token: oneTimeReview.token,
              }),
            },
          );
        } catch (error) {
          reviewDialog.querySelector("[data-review-status]").textContent =
            `Approval was not applied: ${error.message}. Keep this review open to retry, or revoke it before leaving.`;
          throw error;
        }
        sponsorCommunications.currentReview = null;
        reviewDialog.close();
        message.textContent =
          "Approved immutable message queued for dispatch. No provider call occurred in this request.";
        await loadCommunications(sponsorCommunications.selectedBookingId);
      }, "Approval was not applied");
    };
    try {
      await refresh();
      if (
        routeToken &&
        (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
      )
        return;
      if (requestedBookingId) {
        let booking = bookings.find((item) => item.id === requestedBookingId);
        try {
          if (!booking) {
            booking = await api(
              `/bookings/${encodeURIComponent(requestedBookingId)}`,
            );
            if (
              routeToken &&
              (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
            )
              return;
            bookings = [booking, ...bookings];
            draw();
          }
          await reopenBookingDetail(booking);
        } catch (error) {
          if (
            routeToken &&
            (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
          )
            return;
          const detail = surface.querySelector("[data-crm-detail]");
          renderEntityLoadState(detail, {
            kind: "booking",
            id: requestedBookingId,
            status: error.status === 404 ? "not-found" : "error",
            error: error.message,
            retry: () => renderSponsorCrmSurface(),
            returnToList: () => {
              navigateCanonicalWorkspace("/sponsors");
            },
          });
        }
      }
    } catch (error) {
      surface.querySelector("[data-crm-orgs]").textContent =
        "Could not load sponsors.";
      surface.querySelector("[data-crm-bookings]").textContent =
        "Could not load bookings.";
      message.textContent = `Permission or API error: ${error.message}. Reopen Sponsors to retry.`;
    }
  }

  return {
    canLeaveFinanceSurface,
    renderSponsorCrmSurface,
  };
}
