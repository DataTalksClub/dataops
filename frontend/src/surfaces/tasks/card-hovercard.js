import { cardKind } from "../../core/card-kind.js";
import { attachHovercard } from "../../core/hovercard.js";
import { renderIcon } from "../../core/icons.js";
import { STATUS_LABELS, episodeCode, guestNames } from "../podcast/model.js";

// The Card behind a queue row, summarised on hover as a few short facts: a
// podcast Card's episode or a newsletter Card's slot first (loaded on first
// open and cached for the session), then how far the Card got and when it is
// due. The row already names the Card, and clicking it opens the Card, so
// the summary repeats neither.

const PODCAST_TYPES = new Set(["podcast"]);
const NEWSLETTER_TYPES = new Set(["newsletter", "newsletter-standalone"]);

function formatDay(iso) {
  const value = String(iso || "").slice(0, 10);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(parsed);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.round((to - from) / 86400000);
}

// "Due 12 Aug 2026 · 3 days late" / "· in 5 days" / "· today".
export function cardDueText(card, today) {
  const day = formatDay(card?.anchorDate);
  if (!day) return "";
  const open = Number(card.openTaskCount) || 0;
  const delta = daysBetween(today, card.anchorDate);
  let when = "";
  if (delta === 0) when = "today";
  else if (delta > 0) when = `in ${delta} day${delta === 1 ? "" : "s"}`;
  else if (open > 0) when = `${-delta} day${delta === -1 ? "" : "s"} late`;
  return when ? `${day} · ${when}` : day;
}

export function cardProgressText(card) {
  const total = Number(card?.taskCount) || 0;
  if (!total) return "No tasks yet";
  const open = Math.min(total, Number(card.openTaskCount) || 0);
  return `${total - open} of ${total} tasks done`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fact(list, label, value) {
  if (!value) return;
  const row = el("div", "card-hovercard__fact");
  row.append(el("dt", "", label));
  const dd = el("dd");
  if (typeof value === "string") dd.textContent = value;
  else dd.append(value);
  row.append(dd);
  list.append(row);
}

// "Weekly #299", never "Weekly #299 · #299".
export function slotIssueText(slot) {
  const label = String(slot?.campaignLabel || "").trim();
  const number = String(slot?.campaignNumber || "").trim();
  if (!number) return label;
  if (!label) return `#${number}`;
  return label.includes(number) ? label : `${label} #${number}`;
}

function episodeFacts(episode) {
  return [
    ["Episode", [episodeCode(episode), episode.title].filter(Boolean).join(" · ")],
    ["Guests", guestNames(episode)],
    ["Status", STATUS_LABELS[episode.status] || episode.status],
    ["Recording", formatDay(episode.recordingDate)],
    ["Release", formatDay(episode.releaseDate)],
  ];
}

function slotFacts(slot) {
  return [
    ["Issue", slotIssueText(slot)],
    ["Date", formatDay(slot.publicationDate)],
    ["Sponsor", slot.bookedByDisplayName || ""],
    ["Status", String(slot.status || "").replaceAll("-", " ")],
  ];
}

export function createCardHovercards(context) {
  const {
    isArchivedWorkCard,
    isParkedWorkCard,
    openCardPanel,
    request,
    state,
    workApiUrl,
  } = context;
  const extras = new Map();

  // The Card's own address, the one openCardPanel navigates to.
  function cardHref(card) {
    const path = isArchivedWorkCard(card) || isParkedWorkCard(card) ? "/cards/archive" : "/cards";
    return `${path}?cardId=${encodeURIComponent(card.id)}`;
  }

  // The linked episode or slot, one request per Card per session. A failed
  // read is not cached, so the next hover tries again.
  function loadExtra(card, kind) {
    const type = kind?.type || "";
    let path = "";
    if (PODCAST_TYPES.has(type)) path = "/api/podcast-episodes";
    else if (NEWSLETTER_TYPES.has(type)) path = "/api/newsletter-slots";
    if (!path) return Promise.resolve(null);
    if (!extras.has(card.id)) {
      const loading = Promise.resolve(request(workApiUrl(`${path}?cardId=${encodeURIComponent(card.id)}`)))
        .then((payload) => {
          const item = Array.isArray(payload?.items) ? payload.items[0] : null;
          if (!item) return null;
          return PODCAST_TYPES.has(type) ? episodeFacts(item) : slotFacts(item);
        })
        .catch((error) => {
          extras.delete(card.id);
          throw error;
        });
      extras.set(card.id, loading);
    }
    return extras.get(card.id).catch(() => null);
  }

  async function renderCardSummary(cardId, { today }) {
    const card = state.workSnapshot.cardsById?.get(String(cardId));
    if (!card) return null;
    const kind = cardKind(card, state.workSnapshot.templates);
    const extra = await loadExtra(card, kind);
    const facts = el("dl", "card-hovercard__facts");
    for (const [label, value] of extra || []) fact(facts, label, value);
    fact(facts, "Progress", cardProgressText(card));
    const dueText = cardDueText(card, today);
    if (dueText) {
      const due = el("span", "card-hovercard__due", dueText);
      if (/late$/.test(dueText)) due.dataset.late = "";
      fact(facts, "Due", due);
    }
    return facts;
  }

  // The Where cell of a queue row. A card task's Where is a link to that
  // Card: a plain click opens it in place, a modified click in a new tab.
  // Pointing at it (or focusing it) shows the Card's summary; on touch, where
  // nothing hovers, the info button beside it toggles the summary and a tap
  // on the name opens the Card.
  function renderOriginCell(origin, summary) {
    const cell = el("span", "ops-queue-origin");
    cell.dataset.source = origin.kind;
    const icon = el("span", "ops-queue-origin-icon");
    icon.dataset.icon = origin.icon;
    icon.append(renderIcon(origin.icon, { size: 16 }));
    const text = el("span", "ops-queue-origin-text");
    text.append(el("span", "ops-queue-origin-label", origin.label));
    if (origin.type) text.append(el("span", "ops-queue-origin-type", origin.type));
    if (!origin.card) {
      cell.append(icon, text);
      cell.title = origin.title;
      return cell;
    }
    const { card } = origin;
    const link = el("a", "ops-queue-origin-link");
    link.href = cardHref(card);
    link.setAttribute("aria-label", `Open card ${origin.title}`);
    link.append(icon, text);
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
      event.preventDefault();
      openCardPanel(card.id);
    });
    const info = el("button", "dk-icon-button dk-icon-button--sm ops-queue-origin-info");
    info.type = "button";
    info.setAttribute("aria-label", `Card summary: ${origin.label}`);
    info.append(renderIcon("info", { size: 16 }));
    attachHovercard(link, {
      label: `Card summary: ${origin.label}`,
      className: "card-hovercard",
      toggle: info,
      render: () => renderCardSummary(card.id, summary()),
    });
    cell.append(link, info);
    return cell;
  }

  return { renderOriginCell };
}
