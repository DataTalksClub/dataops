/**
 * Newsletter issue slots, shared by the planner rows, the issue dialog and
 * the Card's issue section.
 *
 * A weekly issue has a primary and a secondary sponsor slot; a stand-alone
 * issue has one. A slot is open until a sponsor is booked on it. Booking
 * picks a sponsor from the Sponsors tab (a live deal, or an organization,
 * which gets a new deal) and records the booking there; the slot's Tasks
 * join the issue's Card. Removing the sponsor frees the slot and skips its
 * open Tasks; done ones stay. A sent or cancelled issue's slots are read-only.
 */
import "../dakit/tag-input.js";

export const SLOT_POSITIONS = { weekly: ["primary", "secondary"], standalone: ["primary"] };
export const SLOT_NAMES = { primary: "Primary", secondary: "Secondary" };

export const slotName = (issue, position) => (issue?.kind === "standalone" ? "Sponsor" : SLOT_NAMES[position]);
const slotsLocked = (issue) => ["sent", "cancelled"].includes(issue?.status);

/** One control per slot: a booking button, or the sponsor with change and remove. */
export function issueSlotsMarkup(item, escapeHtml) {
  const positions = SLOT_POSITIONS[item.kind] || [];
  const issueId = escapeHtml(item.id);
  const label = escapeHtml(item.label || "this issue");
  return `
      <ul class="newsletter-slots" aria-label="Sponsor slots">
        ${positions.map((position) => {
          const name = escapeHtml(slotName(item, position));
          const sponsor = item.slots?.[position]?.sponsor || "";
          const state = sponsor ? "is-booked" : "is-open";
          if (slotsLocked(item)) {
            return `
            <li class="newsletter-slot ${state}" data-slot-position="${position}">
              <span class="newsletter-slot__text"><strong>${name}:</strong> ${escapeHtml(sponsor || "open")}</span>
            </li>`;
          }
          if (!sponsor) {
            return `
            <li class="newsletter-slot ${state}" data-slot-position="${position}">
              <button type="button" class="newsletter-slot__book" data-slot-book="${position}" data-issue-id="${issueId}"
                aria-label="Book a sponsor for the ${name.toLowerCase()} slot of ${label}"><strong>${name}:</strong> + sponsor</button>
            </li>`;
          }
          return `
            <li class="newsletter-slot ${state}" data-slot-position="${position}">
              <button type="button" class="newsletter-slot__book" data-slot-book="${position}" data-issue-id="${issueId}"
                title="Change sponsor"
                aria-label="Change the ${name.toLowerCase()} sponsor of ${label} (${escapeHtml(sponsor)})"
                ><strong>${name}:</strong> ${escapeHtml(sponsor)}</button>
              <button type="button" class="newsletter-slot__remove" data-slot-release="${position}" data-issue-id="${issueId}"
                aria-label="Remove ${escapeHtml(sponsor)} from the ${name.toLowerCase()} slot of ${label}">×</button>
            </li>`;
        }).join("")}
      </ul>`;
}

let sponsorOptionsCache = null;

/** Who a slot can be booked for, shared by every picker for a minute. */
function loadSponsorOptions(request, workApiUrl) {
  if (sponsorOptionsCache && Date.now() - sponsorOptionsCache.at < 60000) return sponsorOptionsCache.promise;
  const promise = request(workApiUrl("/api/newsletter-issues/sponsor-options")).then((payload) => payload?.items || []);
  sponsorOptionsCache = { at: Date.now(), promise };
  promise.catch(() => { sponsorOptionsCache = null; });
  return promise;
}

const optionValue = (option) => (option.dealId ? `deal:${option.dealId}` : `org:${option.organizationId}`);

/**
 * Wire the slot controls inside `container`: a booking button opens a
 * type-to-search sponsor picker in place; × asks, then frees the slot.
 * `findIssue(id)` returns the issue a control belongs to; `onChanged(issue)`
 * runs after a booking or removal is saved.
 */
export function attachSlotControls(container, { findIssue, request, workApiUrl, onChanged, onError }) {
  const slotUrl = (issue, position) =>
    workApiUrl(`/api/newsletter-issues/${encodeURIComponent(issue.id)}/slots/${position}`);

  async function book(issue, position, value) {
    const [kind, id] = value.split(/:(.*)/s);
    const body = { version: issue.version, ...(kind === "deal" ? { dealId: id } : { organizationId: id }) };
    return request(slotUrl(issue, position), { method: "PUT", body: JSON.stringify(body) });
  }

  async function release(issue, position, button) {
    const sponsor = issue.slots?.[position]?.sponsor || "the sponsor";
    const where = `the ${slotName(issue, position).toLowerCase()} slot of ${issue.label || "this issue"}`;
    const question = `Remove ${sponsor} from ${where}? `
      + "The booking is marked withdrawn and the slot's open tasks leave the card.";
    if (!globalThis.confirm?.(question)) return;
    button.disabled = true;
    const body = { version: issue.version };
    try {
      let saved;
      try {
        saved = await request(slotUrl(issue, position), { method: "DELETE", body: JSON.stringify(body) });
      } catch (error) {
        if (error?.code !== "slot-has-completed-tasks" || !globalThis.confirm?.(error.message)) throw error;
        saved = await request(slotUrl(issue, position), {
          method: "DELETE",
          body: JSON.stringify({ ...body, confirmSlotRemoval: true }),
        });
      }
      await onChanged?.(saved);
    } catch (error) {
      button.disabled = false;
      onError?.(`Could not remove ${sponsor}: ${error.message}`);
    }
  }

  function openPicker(issue, position, slotItem) {
    if (slotItem.querySelector(".newsletter-slot__picker")) return;
    const previous = [...slotItem.childNodes];
    const picker = document.createElement("div");
    picker.className = "newsletter-slot__picker";
    const close = () => {
      if (!picker.isConnected) return;
      slotItem.replaceChildren(...previous);
      slotItem.querySelector("[data-slot-book]")?.focus();
    };
    const tags = globalThis.dakitTagInput.create({
      label: `${slotName(issue, position)} sponsor for ${issue.label || "this issue"}`,
      placeholder: "Loading sponsors…",
      noMatches: "No sponsor matches",
      options: [],
      value: [],
      disabled: true,
      onChange: async (_value, change) => {
        if (!change?.added) return;
        tags.setDisabled(true);
        try {
          const saved = await book(issue, position, change.added);
          await onChanged?.(saved);
        } catch (error) {
          close();
          onError?.(`Could not book the ${slotName(issue, position).toLowerCase()} slot: ${error.message}`);
        }
      },
    });
    picker.append(tags.element);
    picker.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    picker.addEventListener("focusout", (event) => {
      if (event.relatedTarget && picker.contains(event.relatedTarget)) return;
      setTimeout(() => {
        if (!picker.contains(document.activeElement)) close();
      }, 0);
    });
    slotItem.replaceChildren(picker);
    tags.focus();
    loadSponsorOptions(request, workApiUrl).then((options) => {
      const current = issue.slots?.[position]?.sponsor;
      tags.setOptions(options
        .filter((option) => !(current && option.name === current && !option.dealId))
        .map((option) => ({
          value: optionValue(option),
          label: option.name,
          aliases: option.dealTitle ? [option.dealTitle] : [],
          group: option.dealId ? "Deals" : "Organizations without a deal",
        })));
      tags.input.placeholder = "Type a sponsor…";
      tags.setDisabled(false);
      tags.focus();
      tags.open();
    }, (error) => {
      close();
      onError?.(`Could not load sponsors: ${error.message}`);
    });
  }

  container.addEventListener("click", (event) => {
    const bookButton = event.target.closest?.("[data-slot-book]");
    const releaseButton = event.target.closest?.("[data-slot-release]");
    const button = bookButton || releaseButton;
    if (!button || !container.contains(button)) return;
    const issue = findIssue(button.dataset.issueId);
    if (!issue) return;
    event.preventDefault();
    if (releaseButton) release(issue, releaseButton.dataset.slotRelease, releaseButton);
    else openPicker(issue, bookButton.dataset.slotBook, bookButton.closest(".newsletter-slot"));
  });
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
                  <p class="newsletter-slot-fields__sponsor" data-slot-sponsor></p>
                  <label>Sponsorship document <input name="${position}DocumentUrl" type="url"></label>
                </fieldset>`).join("");
}

export const SLOT_FORM_FIELD = /^(primary|secondary)DocumentUrl$/;

/**
 * Slot fields of the issue dialog. The sponsor is booked from the issue's
 * row; the dialog shows who holds each slot and edits its placement
 * document. `currentItem()` is the issue being edited, or null for a new one.
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
  }

  function fill(item) {
    const kind = item?.kind || "weekly";
    if (form.elements.kind) {
      form.elements.kind.value = kind;
      form.elements.kind.disabled = Boolean(item);
    }
    for (const position of ["primary", "secondary"]) {
      const slot = item?.slots?.[position] || {};
      form.elements[`${position}DocumentUrl`].value = slot.documentUrl || "";
      const sponsor = dialog.querySelector(`[data-slot-fields="${position}"] [data-slot-sponsor]`);
      if (sponsor) {
        sponsor.textContent = slot.sponsor
          ? `Sponsor: ${slot.sponsor}`
          : item ? "Open: book a sponsor from the issue's row." : "Book sponsors from the issue's row once it is saved.";
      }
    }
    showKindFields(kind);
  }

  /** The slots as the form edits them, keeping the booking and sheet ID. */
  function values(kind) {
    const slots = {};
    for (const position of SLOT_POSITIONS[kind] || SLOT_POSITIONS.weekly) {
      const slot = { ...(currentItem()?.slots?.[position] || {}) };
      const documentUrl = String(form.elements[`${position}DocumentUrl`]?.value || "").trim();
      if (documentUrl) slot.documentUrl = documentUrl;
      else delete slot.documentUrl;
      slots[position] = slot;
    }
    return slots;
  }

  if (form.elements.kind) form.elements.kind.onchange = () => showKindFields(form.elements.kind.value);
  return { fill, values };
}
