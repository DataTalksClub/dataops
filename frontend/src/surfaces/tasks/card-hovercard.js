import { cardKind } from "../../core/card-kind.js";
import { attachHovercard } from "../../core/hovercard.js";
import { renderIcon } from "../../core/icons.js";
import { documentHref, isHttpLink, linkLabel, linkService, opensInNewTab } from "../../core/links.js";
import { LINK_KINDS, STATUS_LABELS, episodeCode, guestNames } from "../podcast/model.js";

// The Card behind a queue row, summarised on hover: what it is, how far it
// got, what is next, when it is due and whose it is, plus its links. A
// podcast Card adds its episode and a newsletter Card its slot, loaded on
// first open and cached for the session. Everything else comes from the
// snapshot already in memory, so the card opens without waiting.

const PODCAST_TYPES = new Set(["podcast"]);
const NEWSLETTER_TYPES = new Set(["newsletter", "newsletter-standalone"]);
const STAGE_LABELS = Object.freeze({
  preparation: "Preparation",
  announced: "Announced",
  "after-event": "After the event",
  done: "Done",
});

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

function linkRow(href, label, icon) {
  const item = el("li");
  const link = el("a", "card-hovercard__link");
  link.href = href;
  link.title = href;
  link.append(renderIcon(icon, { size: 16 }), el("span", "", label));
  opensInNewTab(link);
  item.append(link);
  return item;
}

function cardLinksList(card, localDocPathFromHref) {
  const list = el("ul", "card-hovercard__links");
  for (const link of Array.isArray(card.cardLinks) ? card.cardLinks : []) {
    if (!isHttpLink(link?.url)) continue;
    list.append(linkRow(link.url, link.name || linkLabel(link.url), linkService(link.url).icon));
  }
  for (const ref of Array.isArray(card.references) ? card.references : []) {
    const url = typeof ref === "string" ? ref : ref?.url || ref?.link || "";
    if (!url) continue;
    const name = typeof ref === "string" ? "" : ref.name || ref.title || "";
    const docPath = localDocPathFromHref(url);
    if (docPath) list.append(linkRow(documentHref(docPath), name || "Process doc", "instructions"));
    else if (isHttpLink(url)) list.append(linkRow(url, name || linkLabel(url), linkService(url).icon));
  }
  return list.children.length ? list : null;
}

function section(title, ...children) {
  const wrap = el("section", "card-hovercard__section");
  wrap.append(el("h3", "card-hovercard__section-title", title), ...children.filter(Boolean));
  return wrap;
}

function episodeSection(episode) {
  const facts = el("dl", "card-hovercard__facts");
  const code = episodeCode(episode);
  fact(facts, "Episode", [code, episode.title].filter(Boolean).join(" · "));
  fact(facts, "Guests", guestNames(episode));
  fact(facts, "Status", STATUS_LABELS[episode.status] || episode.status);
  fact(facts, "Recording", formatDay(episode.recordingDate));
  fact(facts, "Release", formatDay(episode.releaseDate));
  const links = el("ul", "card-hovercard__links");
  for (const kind of LINK_KINDS) {
    const url = episode.links?.[kind.id];
    if (isHttpLink(url)) links.append(linkRow(url, kind.label, kind.icon));
  }
  return section("Podcast episode", facts, links.children.length ? links : null);
}

function slotSection(slot) {
  const facts = el("dl", "card-hovercard__facts");
  fact(facts, "Issue", [slot.campaignLabel, slot.campaignNumber ? `#${slot.campaignNumber}` : ""].filter(Boolean).join(" · "));
  fact(facts, "Date", formatDay(slot.publicationDate));
  fact(facts, "Sponsor", slot.bookedByDisplayName || "");
  fact(facts, "Status", String(slot.status || "").replaceAll("-", " "));
  const links = el("ul", "card-hovercard__links");
  if (isHttpLink(slot.publicUrl)) links.append(linkRow(slot.publicUrl, "Published issue", "newspaper"));
  return section("Newsletter slot", facts, links.children.length ? links : null);
}

export function createCardHovercards(context) {
  const {
    isArchivedWorkCard,
    isParkedWorkCard,
    localDocPathFromHref = () => "",
    openCardPanel,
    request,
    resolveAssigneeLabel,
    state,
    taskDate,
    workApiUrl,
    workCardTitle,
    workTaskTitle,
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
          return PODCAST_TYPES.has(type) ? episodeSection(item) : slotSection(item);
        })
        .catch((error) => {
          extras.delete(card.id);
          throw error;
        });
      extras.set(card.id, loading);
    }
    return extras.get(card.id).catch(() => null);
  }

  // `openTasks` is the queue's open list in its urgency order, so the
  // Card's first task in it is the next one to do.
  async function renderCardSummary(cardId, { openTasks = [], today }) {
    const card = state.workSnapshot.cardsById?.get(String(cardId));
    if (!card) return null;
    const kind = cardKind(card, state.workSnapshot.templates);
    const extra = loadExtra(card, kind);
    const body = el("div", "card-hovercard__body");

    const head = el("div", "card-hovercard__head");
    const icon = el("span", "card-hovercard__icon");
    icon.append(renderIcon(kind?.icon || "card", { size: 16 }));
    const titles = el("div", "card-hovercard__titles");
    titles.append(el("p", "card-hovercard__title", workCardTitle(card)));
    const stage = STAGE_LABELS[card.stage] || "";
    const status = card.status && card.status !== "active" ? card.status : "";
    titles.append(el("p", "card-hovercard__kind", [kind ? `${kind.name} card` : "Card", stage, status].filter(Boolean).join(" · ")));
    head.append(icon, titles);
    body.append(head);

    const facts = el("dl", "card-hovercard__facts");
    fact(facts, "Progress", cardProgressText(card));
    const next = openTasks.find((task) => String(task.cardId) === String(card.id));
    if (next) {
      const date = formatDay(taskDate(next));
      const due = date ? ` · due ${date}` : "";
      fact(facts, "Next", `${workTaskTitle(next)}${due}`);
    }
    const dueText = cardDueText(card, today);
    if (dueText) {
      const due = el("span", "card-hovercard__due", dueText);
      if (/late$/.test(dueText)) due.dataset.late = "";
      fact(facts, "Due", due);
    }
    fact(facts, "Owner", card.ownerId ? resolveAssigneeLabel(card.ownerId) : "Unassigned");
    body.append(facts);

    const links = cardLinksList(card, localDocPathFromHref);
    if (links) body.append(section("Links", links));

    const extraSection = await extra;
    if (extraSection) body.append(extraSection);

    const footer = el("div", "card-hovercard__footer");
    const openLink = el("a", "dk-button dk-button--secondary dk-button--sm card-hovercard__open", "Open card");
    openLink.href = cardHref(card);
    openLink.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
      event.preventDefault();
      openCardPanel(card.id);
    });
    footer.append(openLink);
    body.append(footer);
    return body;
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
