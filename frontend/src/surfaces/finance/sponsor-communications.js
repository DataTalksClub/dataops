import { html } from "./shared.js";

export function createSponsorCommunications(context) {
  const {
    api,
    escapeHtml,
    getBookings,
    getContacts,
    humanizeOptionLabel,
    message,
    surface,
  } = context;
  let selectedBookingId = "";
  let communicationItems = [];
  let communicationConfig = null;
  let communicationPermissions = {
    role: "operator",
    canApprove: false,
    canCancel: false,
    canReconcile: false,
  };
  let currentReview = null;
  function drawCommunications() {
    const root = surface.querySelector("[data-crm-communications]");
    if (!selectedBookingId) return;
    const booking = getBookings().find((item) => item.id === selectedBookingId);
    const hasRecipients = getContacts().some(
      (item) =>
        item.organizationId === booking?.organizationId &&
        item.active !== false &&
        !item.archivedAt &&
        item.emails?.length,
    );
    const isAdmin = communicationPermissions.role === "admin";
    const controls = hasRecipients
      ? html`<div class="crm-communication-controls">
          <button data-suppress-address>Suppress sponsor address</button>
        </div>`
      : "";
    const disabledBanner = !communicationConfig?.enabled
      ? html`<div class="honest-state" data-communication-state="disabled">
          <strong>Reviewed sending is disabled</strong>
          <p>
            History remains visible. A credentialed operator must reconcile
            private templates, suppression keys, SES identity, and the kill
            switch before a new preview can be approved.
          </p>
        </div>`
      : "";
    const suggestions = communicationItems.filter(
      (item) => item.recordType === "communication-suggestion",
    );
    const attempts = communicationItems.filter(
      (item) => item.recordType === "sponsor-send-attempt",
    );
    const drafts = communicationItems.filter(
      (item) => item.recordType === "communication-draft-version",
    );
    const draftCards = drafts
      .map((item) => {
        const state = item.reviewState || "awaiting_review";
        const guidance =
          state === "claimed"
            ? "This exact version has already been claimed by an immutable send attempt."
            : state === "abandoned"
              ? "This draft expired and its private payload is no longer reviewable."
              : isAdmin
                ? "Generate a fresh admin-bound exact preview before approval."
                : "Draft saved. Awaiting administrator review.";
        const action =
          isAdmin && item.reviewable && communicationConfig?.enabled
            ? html`<button
                data-review-draft="${escapeHtml(item.communicationId)}"
                data-draft-version="${escapeHtml(item.version)}"
              >
                Review exact draft
              </button>`
            : "";
        return html`<article
          class="crm-card"
          data-communication-state="${escapeHtml(state)}"
        >
          <header>
            <strong>Draft version ${escapeHtml(item.version)}</strong
            ><span>${escapeHtml(humanizeOptionLabel(state))}</span>
          </header>
          <p>${guidance}</p>
          ${action}
        </article>`;
      })
      .join("");
    const suggestionCards = suggestions.length
      ? suggestions
          .map(
            (item) =>
              html`<article
                class="crm-card"
                data-communication-state="${escapeHtml(item.status)}"
              >
                <header>
                  <strong
                    >${escapeHtml(humanizeOptionLabel(item.communicationType))}</strong
                  ><span hidden>${escapeHtml(item.communicationType)}</span
                  ><span>${escapeHtml(humanizeOptionLabel(item.status))}</span>
                </header>
                <p>${escapeHtml(item.safeReason)}</p>
                ${item.status === "open" && communicationConfig?.enabled ? html`<button data-draft-suggestion="${escapeHtml(item.id)}">Draft message</button>` : ""}
              </article>`,
          )
          .join("")
      : html`<div class="honest-state">
          <strong>No eligible suggestions</strong>
          <p>
            Milestones only create suggestions. Nothing is drafted or sent
            automatically.
          </p>
        </div>`;
    const attemptCards = attempts
      .map((item) => {
        const state = item.derivedStatus || item.status;
        const guidance =
          item.status === "outcome_unknown"
            ? isAdmin
              ? "Provider outcome is unknown. This attempt will never be resent automatically; reconcile it only after provider investigation."
              : "Provider outcome is unknown. This attempt will never be resent automatically; an administrator must reconcile it."
            : state === "delayed"
              ? "SES accepted the message but delivery is delayed."
              : state === "rejected"
                ? "The provider rejected this message. Draft and approve a new version only after resolving the cause."
                : state === "delivered"
                  ? "Provider delivery fact recorded. This does not prove the recipient read it."
                  : state === "pending_event"
                    ? "Dispatch started. Waiting for a trusted provider fact; this message will not be sent again automatically."
                    : state === "accepted"
                      ? "SES accepted the immutable message. Awaiting later delivery evidence."
                      : state === "queued"
                        ? isAdmin
                          ? "Approved and queued. You may cancel only before dispatch reaches its point of no return."
                          : "Approved and queued. An administrator may cancel only before dispatch starts."
                        : "Current immutable execution history.";
        const cancel =
          item.status === "queued" && communicationPermissions.canCancel
            ? html`<button data-cancel-attempt="${escapeHtml(item.id)}">
                Cancel before dispatch
              </button>`
            : "";
        const reconcile =
          item.status === "outcome_unknown" &&
          communicationPermissions.canReconcile
            ? html`<button data-reconcile-attempt="${escapeHtml(item.id)}">
                Reconcile outcome
              </button>`
            : "";
        return html`<article
          class="crm-card"
          data-communication-state="${escapeHtml(state)}"
        >
          <header>
            <strong>Reviewed send</strong
            ><span hidden>${escapeHtml(state)}</span
            ><span>${escapeHtml(humanizeOptionLabel(state))}</span>
          </header>
          <p>${guidance}</p>
          ${cancel}${reconcile}
        </article>`;
      })
      .join("");
    root.innerHTML = `${controls}${disabledBanner}${suggestionCards}${draftCards}${attemptCards}`;
  }
  async function loadCommunications(bookingId) {
    selectedBookingId = bookingId;
    let cursor = "";
    let pageCount = 0;
    const items = [];
    do {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await api(
        `/bookings/${bookingId}/communications?${query}`,
      );
      items.push(...(result.items || []));
      communicationConfig = result.config || { enabled: false };
      communicationPermissions = result.permissions || communicationPermissions;
      cursor = result.nextCursor || "";
      pageCount += 1;
      if (pageCount > 20)
        throw new Error("Communication history is too large to display safely");
    } while (cursor);
    communicationItems = items;
    drawCommunications();
  }
  async function showExactReview(communicationId, version) {
    const presentation = await api(
      `/communications/${communicationId}/presentations`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    );
    currentReview = {
      communicationId,
      version,
      presentationId: presentation.presentationId,
      token: presentation.token,
    };
    const preview = presentation.preview;
    const reviewDialog = surface.querySelector(
      "[data-communication-review-dialog]",
    );
    reviewDialog.querySelector("[data-review-warning]").textContent =
      communicationPermissions.canApprove
        ? [
            "Approval queues exactly this one-recipient plain-text message.",
            "It never sends inline; the worker rechecks authority, source revisions, suppression, and the kill switch.",
          ].join(" ")
        : [
            "This is an exact private preview.",
            "Save the draft for an administrator; this review cannot approve or send.",
          ].join(" ");
    reviewDialog.querySelector("[data-review-addresses]").innerHTML = html`<dt>
        From
      </dt>
      <dd>${escapeHtml(preview.from)}</dd>
      ${
        preview.replyTo
          ? html`<dt>Reply-To</dt>
              <dd>${escapeHtml(preview.replyTo)}</dd>`
          : ""
      }
      <dt>To</dt>
      <dd>${escapeHtml(preview.to)}</dd>
      <dt>Type</dt>
      <dd>${escapeHtml(preview.communicationType)}</dd>`;
    reviewDialog.querySelector("[data-review-subject]").textContent =
      preview.subject;
    reviewDialog.querySelector("[data-review-body]").textContent = preview.body;
    reviewDialog.querySelector("[data-review-links]").innerHTML = (
      preview.publicLinks || []
    )
      .map((link) => html`<p>${escapeHtml(link)}</p>`)
      .join("");
    reviewDialog.querySelector("[data-review-status]").textContent =
      `Exact preview hash: ${presentation.previewHash}`;
    reviewDialog.querySelector("[data-approve-message]").hidden =
      !communicationPermissions.canApprove;
    reviewDialog.showModal();
  }
  async function revokeCurrentReview(reason = "close") {
    const reviewDialog = surface.querySelector(
      "[data-communication-review-dialog]",
    );
    if (!currentReview) {
      if (reviewDialog.open) reviewDialog.close();
      return true;
    }
    const closeButton = reviewDialog.querySelector("[data-review-close]");
    const approveButton = reviewDialog.querySelector("[data-approve-message]");
    closeButton.disabled = true;
    approveButton.disabled = true;
    reviewDialog.querySelector("[data-review-status]").textContent =
      "Revoking this one-time review…";
    try {
      await api(
        `/communications/${currentReview.communicationId}/presentations/${currentReview.presentationId}/reject`,
        { method: "POST", body: "{}" },
      );
      currentReview = null;
      reviewDialog.close();
      if (reason !== "navigation")
        message.textContent =
          "Exact review revoked. The saved draft remains available for a fresh review.";
      return true;
    } catch (error) {
      reviewDialog.querySelector("[data-review-status]").textContent =
        `Could not revoke this review: ${error.message}. Retry Reject / close before leaving.`;
      message.textContent =
        "The review is still active and visible. Retry revocation before navigating or regenerate after reloading.";
      return false;
    } finally {
      closeButton.disabled = false;
      approveButton.disabled = false;
    }
  }
  return {
    get communicationConfig() {
      return communicationConfig;
    },
    get communicationItems() {
      return communicationItems;
    },
    get communicationPermissions() {
      return communicationPermissions;
    },
    get currentReview() {
      return currentReview;
    },
    set currentReview(value) {
      currentReview = value;
    },
    get selectedBookingId() {
      return selectedBookingId;
    },
    set selectedBookingId(value) {
      selectedBookingId = value;
    },
    drawCommunications,
    loadCommunications,
    revokeCurrentReview,
    showExactReview,
  };
}
