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

const fmtNum = (value) => new Intl.NumberFormat("en-US").format(value);

function formatIssueMailchimpLine(stats, escapeHtml) {
  if (!stats || typeof stats !== "object") return "";
  const parts = [];
  if (stats.deliveries !== undefined) parts.push(`${escapeHtml(fmtNum(stats.deliveries))} deliveries`);
  if (stats.opens !== undefined) {
    const rate = stats.openRate !== undefined ? ` (${escapeHtml(String(stats.openRate))}%)` : "";
    parts.push(`${escapeHtml(fmtNum(stats.opens))} opens${rate}`);
  }
  if (stats.clicks !== undefined) {
    const details = [];
    if (stats.uniqueClicks !== undefined) details.push(`${escapeHtml(fmtNum(stats.uniqueClicks))} unique`);
    if (stats.clickRate !== undefined) details.push(`${escapeHtml(String(stats.clickRate))}% CTR`);
    parts.push(`${escapeHtml(fmtNum(stats.clicks))} clicks${details.length ? ` (${details.join(", ")})` : ""}`);
  }
  if (!parts.length) return "";
  return `<div class="newsletter-stats-line" data-issue-mailchimp-stats><strong>Mailchimp:</strong> ${parts.join(" · ")}</div>`;
}

function formatSlotChannelStats(slot, positionLabel, escapeHtml) {
  const stats = slot?.stats;
  if (!stats || typeof stats !== "object") return "";
  const parts = [];
  if (stats.clicks !== undefined) {
    const details = [];
    if (stats.uniqueClicks !== undefined) details.push(`${escapeHtml(fmtNum(stats.uniqueClicks))} unique`);
    if (stats.clickRate !== undefined) details.push(`${escapeHtml(String(stats.clickRate))}% CTR`);
    parts.push(`Newsletter ${escapeHtml(fmtNum(stats.clicks))} clicks${details.length ? ` (${details.join(", ")})` : ""}`);
  }
  if (stats.linkedinImpressions !== undefined || stats.linkedinClicks !== undefined || stats.linkedinPostUrl) {
    const label = stats.linkedinPostUrl
      ? `<a href="${escapeHtml(stats.linkedinPostUrl)}" target="_blank" rel="noreferrer">LinkedIn</a>`
      : "LinkedIn";
    const metrics = [];
    if (stats.linkedinImpressions !== undefined) metrics.push(`${escapeHtml(fmtNum(stats.linkedinImpressions))} views`);
    if (stats.linkedinClicks !== undefined) metrics.push(`${escapeHtml(fmtNum(stats.linkedinClicks))} clicks`);
    const ctr = stats.linkedinCtr !== undefined ? ` (${escapeHtml(String(stats.linkedinCtr))}% CTR)` : "";
    parts.push(`${label}${metrics.length ? `: ${metrics.join(" / ")}${ctr}` : ""}`);
  }
  if (stats.xImpressions !== undefined || stats.xClicks !== undefined || stats.xPostUrl) {
    const label = stats.xPostUrl
      ? `<a href="${escapeHtml(stats.xPostUrl)}" target="_blank" rel="noreferrer">X</a>`
      : "X";
    const metrics = [];
    if (stats.xImpressions !== undefined) metrics.push(`${escapeHtml(fmtNum(stats.xImpressions))} views`);
    if (stats.xClicks !== undefined) metrics.push(`${escapeHtml(fmtNum(stats.xClicks))} clicks`);
    const ctr = stats.xCtr !== undefined ? ` (${escapeHtml(String(stats.xCtr))}% CTR)` : "";
    parts.push(`${label}${metrics.length ? `: ${metrics.join(" / ")}${ctr}` : ""}`);
  }
  if (!parts.length) return "";
  const sponsorSuffix = slot?.sponsor ? ` (${escapeHtml(slot.sponsor)})` : "";
  const slotAttr = escapeHtml(positionLabel.toLowerCase());
  return `<div class="newsletter-stats-line" data-slot-stats="${slotAttr}">`
    + `<strong>${escapeHtml(positionLabel)}${sponsorSuffix} stats:</strong> ${parts.join(" · ")}</div>`;
}

/** Compact Mailchimp and per-slot (LinkedIn / X / link clicks) stats summary for an issue row or Card. */
export function issueStatsSummaryMarkup(item, escapeHtml) {
  if (!item) return "";
  const lines = [];
  const mailchimp = formatIssueMailchimpLine(item.stats, escapeHtml);
  if (mailchimp) lines.push(mailchimp);
  const positions = SLOT_POSITIONS[item.kind] || [];
  for (const position of positions) {
    const slotLine = formatSlotChannelStats(item.slots?.[position], slotName(item, position), escapeHtml);
    if (slotLine) lines.push(slotLine);
  }
  if (!lines.length) return "";
  return `<div class="newsletter-issue-stats" data-issue-stats>${lines.join("")}</div>`;
}

/** "Card in 12 days" for an issue whose Card the daily run creates on `cardDueDate`. */
export function cardDueLabel(cardDueDate, todayIso) {
  if (!cardDueDate || !todayIso) return "";
  const days = Math.round(
    (Date.parse(`${cardDueDate}T00:00:00Z`) - Date.parse(`${String(todayIso).slice(0, 10)}T00:00:00Z`)) / 86400000,
  );
  if (days <= 0) return "Card due today";
  return days === 1 ? "Card tomorrow" : `Card in ${days} days`;
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
  const slotFieldsets = ["primary", "secondary"].map((position) => `
                <fieldset class="planner-field-wide newsletter-slot-fields" data-slot-fields="${position}">
                  <legend data-slot-legend>${position === "primary" ? "Primary slot" : "Secondary slot"}</legend>
                  <p class="newsletter-slot-fields__sponsor" data-slot-sponsor></p>
                  <label>Sponsorship document <input name="${position}DocumentUrl" type="url"></label>
                  <label>Link clicks <input name="${position}Clicks" type="number" min="0"></label>
                  <label>Unique clicks <input name="${position}UniqueClicks" type="number" min="0"></label>
                  <label>Click rate (%) <input name="${position}ClickRate" type="number" min="0" max="100" step="0.01"></label>
                  <label>LinkedIn views <input name="${position}LinkedinImpressions" type="number" min="0"></label>
                  <label>LinkedIn clicks <input name="${position}LinkedinClicks" type="number" min="0"></label>
                  <label>LinkedIn CTR (%) <input name="${position}LinkedinCtr" type="number" min="0" max="100" step="0.01"></label>
                  <label>LinkedIn post URL <input name="${position}LinkedinPostUrl" type="url"></label>
                  <label>X views <input name="${position}XImpressions" type="number" min="0"></label>
                  <label>X clicks <input name="${position}XClicks" type="number" min="0"></label>
                  <label>X CTR (%) <input name="${position}XCtr" type="number" min="0" max="100" step="0.01"></label>
                  <label>X post URL <input name="${position}XPostUrl" type="url"></label>
                </fieldset>`).join("");
  return `${slotFieldsets}
                <fieldset class="planner-field-wide newsletter-slot-fields" data-issue-stats-fields>
                  <legend>Mailchimp issue stats</legend>
                  <label>Deliveries <input name="statsDeliveries" type="number" min="0"></label>
                  <label>Opens (views) <input name="statsOpens" type="number" min="0"></label>
                  <label>Open rate (%) <input name="statsOpenRate" type="number" min="0" max="100" step="0.01"></label>
                  <label>Clicks <input name="statsClicks" type="number" min="0"></label>
                  <label>Unique clicks <input name="statsUniqueClicks" type="number" min="0"></label>
                  <label>Click rate (%) <input name="statsClickRate" type="number" min="0" max="100" step="0.01"></label>
                </fieldset>`;
}

export const SLOT_FORM_FIELD = new RegExp(
  "^(?:(?:primary|secondary)(?:DocumentUrl|Clicks|UniqueClicks|ClickRate|"
  + "LinkedinImpressions|LinkedinClicks|LinkedinCtr|LinkedinPostUrl|"
  + "XImpressions|XClicks|XCtr|XPostUrl)|"
  + "stats(?:Deliveries|Opens|OpenRate|Clicks|UniqueClicks|ClickRate))$",
);

const SLOT_INT_FIELDS = ["Clicks", "UniqueClicks", "LinkedinImpressions", "LinkedinClicks", "XImpressions", "XClicks"];
const SLOT_RATE_FIELDS = ["ClickRate", "LinkedinCtr", "XCtr"];
const SLOT_URL_FIELDS = ["LinkedinPostUrl", "XPostUrl"];
const ISSUE_INT_FIELDS = ["Deliveries", "Opens", "Clicks", "UniqueClicks"];
const ISSUE_RATE_FIELDS = ["OpenRate", "ClickRate"];

const lowerFirst = (name) => name[0].toLowerCase() + name.slice(1);

function readNumberInput(form, name, integerOnly = false) {
  const raw = String(form.elements[name]?.value ?? "").trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return integerOnly ? Math.round(parsed) : Math.round(parsed * 100) / 100;
}

/**
 * Slot and stats fields of the issue dialog. The sponsor is booked from the
 * issue's row; the dialog shows who holds each slot and edits its placement
 * document and performance stats. `currentItem()` is the issue being edited,
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
  }

  function fill(item) {
    const kind = item?.kind || "weekly";
    if (form.elements.kind) {
      form.elements.kind.value = kind;
      form.elements.kind.disabled = Boolean(item);
    }
    for (const position of ["primary", "secondary"]) {
      const slot = item?.slots?.[position] || {};
      const stats = slot.stats || {};
      form.elements[`${position}DocumentUrl`].value = slot.documentUrl || "";
      for (const suffix of [...SLOT_INT_FIELDS, ...SLOT_RATE_FIELDS, ...SLOT_URL_FIELDS]) {
        const key = lowerFirst(suffix);
        form.elements[`${position}${suffix}`].value = stats[key] ?? "";
      }
      const sponsor = dialog.querySelector(`[data-slot-fields="${position}"] [data-slot-sponsor]`);
      if (sponsor) {
        sponsor.textContent = slot.sponsor
          ? `Sponsor: ${slot.sponsor}`
          : item ? "Open: book a sponsor from the issue's row." : "Book sponsors from the issue's row once it is saved.";
      }
    }
    const issueStats = item?.stats || {};
    for (const suffix of [...ISSUE_INT_FIELDS, ...ISSUE_RATE_FIELDS]) {
      const key = lowerFirst(suffix);
      form.elements[`stats${suffix}`].value = issueStats[key] ?? "";
    }
    showKindFields(kind);
  }

  /** The slots as the form edits them, keeping the booking, sheet ID and stats. */
  function values(kind) {
    const slots = {};
    for (const position of SLOT_POSITIONS[kind] || SLOT_POSITIONS.weekly) {
      const slot = { ...(currentItem()?.slots?.[position] || {}) };
      const documentUrl = String(form.elements[`${position}DocumentUrl`]?.value || "").trim();
      if (documentUrl) slot.documentUrl = documentUrl;
      else delete slot.documentUrl;

      const slotStats = {};
      for (const suffix of SLOT_INT_FIELDS) {
        const val = readNumberInput(form, `${position}${suffix}`, true);
        if (val !== undefined) slotStats[lowerFirst(suffix)] = val;
      }
      for (const suffix of SLOT_RATE_FIELDS) {
        const val = readNumberInput(form, `${position}${suffix}`, false);
        if (val !== undefined) slotStats[lowerFirst(suffix)] = val;
      }
      for (const suffix of SLOT_URL_FIELDS) {
        const val = String(form.elements[`${position}${suffix}`]?.value ?? "").trim();
        if (val) slotStats[lowerFirst(suffix)] = val;
      }
      if (Object.keys(slotStats).length > 0) {
        slot.stats = slotStats;
      } else {
        delete slot.stats;
      }
      slots[position] = slot;
    }
    return slots;
  }

  function issueStats() {
    const stats = {};
    for (const suffix of ISSUE_INT_FIELDS) {
      const val = readNumberInput(form, `stats${suffix}`, true);
      if (val !== undefined) stats[lowerFirst(suffix)] = val;
    }
    for (const suffix of ISSUE_RATE_FIELDS) {
      const val = readNumberInput(form, `stats${suffix}`, false);
      if (val !== undefined) stats[lowerFirst(suffix)] = val;
    }
    if (Object.keys(stats).length > 0) return stats;
    return currentItem()?.stats ? null : undefined;
  }

  if (form.elements.kind) form.elements.kind.onchange = () => showKindFields(form.elements.kind.value);
  return { fill, values, issueStats };
}
