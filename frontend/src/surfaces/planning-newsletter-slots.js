/**
 * Newsletter issue slots, shared by the planner rows and the issue dialog.
 *
 * A weekly issue has a primary and a secondary sponsor slot; a stand-alone
 * issue has one. A ticked slot is part of the issue and its sponsor Tasks are
 * on the issue's Card; the sponsor name is separate, so a ticked slot may
 * still read "sponsor TBD". An unticked slot is open for a sponsor.
 */
export const SLOT_POSITIONS = { weekly: ["primary", "secondary"], standalone: ["primary"] };
export const SLOT_NAMES = { primary: "Primary", secondary: "Secondary" };

/** One checkbox per slot for a planner row (stand-alone slots have no box). */
export function issueSlotsMarkup(item, escapeHtml) {
  const positions = SLOT_POSITIONS[item.kind] || [];
  const locked = item.status === "cancelled" || item.status === "sent";
  return `
      <ul class="newsletter-slot-ticks" aria-label="Sponsor slots">
        ${positions.map((position) => {
          const slot = item.slots?.[position] || { ticked: false };
          const name = item.kind === "standalone" ? "Sponsor" : SLOT_NAMES[position];
          const state = slot.ticked ? (slot.sponsor ? slot.sponsor : "sponsor TBD") : "open";
          const toggle = item.kind === "standalone"
            ? ""
            : `<input type="checkbox" data-slot-toggle="${position}" data-issue-id="${escapeHtml(item.id)}"
                ${slot.ticked ? "checked" : ""} ${locked ? "disabled" : ""}
                aria-label="${escapeHtml(`${name} slot in ${item.label || "this issue"}`)}">`;
          return `
            <li class="newsletter-slot-tick${slot.ticked ? " is-ticked" : ""}${slot.ticked && !slot.sponsor ? " is-tbd" : ""}"
              data-slot-position="${position}">
              <label>${toggle}<span><strong>${escapeHtml(name)}:</strong> ${escapeHtml(state)}</span></label>
            </li>`;
        }).join("")}
      </ul>`;
}

/** The issue dialog's kind, issue number and slot fields. */
export function issueSlotFormMarkup() {
  return `
              <label>Kind
                <select name="kind">
                  <option value="weekly">Weekly email</option>
                  <option value="standalone">Stand-alone email</option>
                </select>
              </label>
              <label>Publication date <input name="publicationDate" type="date" required></label>
              <label>Publication time <input name="publicationTime" type="time" placeholder="14:00" title="Time in Europe/Berlin"></label>
              <label data-weekly-only>Issue number <input name="issueNumber" type="number" min="1"></label>`;
}

export function issueSlotFieldsetsMarkup() {
  return ["primary", "secondary"].map((position) => `
                <fieldset class="planner-field-wide newsletter-slot-fields" data-slot-fields="${position}">
                  <legend data-slot-legend>${position === "primary" ? "Primary slot" : "Secondary slot"}</legend>
                  <label class="newsletter-slot-fields__tick">
                    <input type="checkbox" name="${position}Ticked"> This issue has the ${position} slot
                  </label>
                  <label>Sponsor <input name="${position}Sponsor" autocomplete="off" placeholder="TBD" maxlength="200"></label>
                  <label>Sponsorship document <input name="${position}DocumentUrl" type="url"></label>
                </fieldset>`).join("");
}

export const SLOT_FORM_FIELD = /^(primary|secondary)(Ticked|Sponsor|DocumentUrl)$/;

/**
 * Slot fields of the issue dialog. `currentItem()` is the issue being edited,
 * or null for a new one.
 */
export function createIssueSlotForm({ dialog, form, currentItem }) {
  /** Weekly issues show both slots and the issue number; stand-alone has one slot. */
  function showKindFields(kind) {
    const standalone = kind === "standalone";
    const secondary = dialog.querySelector('[data-slot-fields="secondary"]');
    if (secondary) secondary.hidden = standalone;
    dialog.querySelectorAll("[data-weekly-only]").forEach((el) => { el.hidden = standalone; });
    const primaryLegend = dialog.querySelector('[data-slot-fields="primary"] [data-slot-legend]');
    if (primaryLegend) primaryLegend.textContent = standalone ? "Sponsor slot" : "Primary slot";
    const primaryTick = form.elements.primaryTicked;
    if (primaryTick) {
      primaryTick.disabled = standalone;
      if (standalone) primaryTick.checked = true;
    }
  }

  function fill(item) {
    const kind = item?.kind || "weekly";
    if (form.elements.kind) {
      form.elements.kind.value = kind;
      form.elements.kind.disabled = Boolean(item);
    }
    for (const position of ["primary", "secondary"]) {
      const slot = item?.slots?.[position] || { ticked: !item && position === "primary" };
      form.elements[`${position}Ticked`].checked = Boolean(slot.ticked);
      form.elements[`${position}Sponsor`].value = slot.sponsor || "";
      form.elements[`${position}DocumentUrl`].value = slot.documentUrl || "";
    }
    showKindFields(kind);
  }

  /**
   * The slots as the form edits them, keeping fields the form does not show
   * (sheet ID, booking references). Naming a sponsor ticks its slot.
   */
  function values(kind) {
    const slots = {};
    for (const position of SLOT_POSITIONS[kind] || SLOT_POSITIONS.weekly) {
      const slot = { ...(currentItem()?.slots?.[position] || {}) };
      const sponsor = String(form.elements[`${position}Sponsor`]?.value || "").trim();
      const documentUrl = String(form.elements[`${position}DocumentUrl`]?.value || "").trim();
      slot.ticked = kind === "standalone" || Boolean(form.elements[`${position}Ticked`]?.checked) || Boolean(sponsor);
      if (sponsor && slot.ticked) slot.sponsor = sponsor;
      else delete slot.sponsor;
      if (!slot.ticked) {
        delete slot.bookedByUserId;
        delete slot.sponsorBookingId;
      }
      if (documentUrl) slot.documentUrl = documentUrl;
      else delete slot.documentUrl;
      slots[position] = slot;
    }
    return slots;
  }

  /** Sponsors booked on the issue being edited, primary first. */
  function bookedSponsors() {
    const kind = form.elements.kind?.value || currentItem()?.kind || "weekly";
    return Object.values(values(kind)).filter((slot) => slot.ticked && slot.sponsor).map((slot) => slot.sponsor);
  }

  if (form.elements.kind) form.elements.kind.onchange = () => showKindFields(form.elements.kind.value);
  return { fill, values, bookedSponsors };
}
