// The seasons overview: what the podcast has, season by season. Each season
// is a row of numbered cells coloured by status, with the numbers nobody
// holds drawn as dashed gaps and the numbers two episodes claim marked as
// duplicates. Above them, the in-flight episodes that have no number yet.
// Hovering or focusing a cell shows the episode's summary; clicking opens it
// in the detail pane. With nothing open, the detail lists what needs a look.
import { attachHovercard } from "../../core/hovercard.js";
import { element, emptyState, formatDate, icon, statusChip } from "./dom.js";
import { episodeCode, episodeSummary, LINK_KINDS, matchesSearch, statusLabel } from "./model.js";
import { attentionOf, countsLabel, GRID_STATUSES, numberingLabel } from "./seasons-model.js";

const enc = encodeURIComponent;

function cellLabel(cell, season) {
  const code = cell.number ? `S${season}E${cell.number}` : `S${season}, no number`;
  const parts = [code, statusLabel(cell.episode.status), episodeSummary(cell.episode)];
  if (cell.duplicate) parts.push("number used twice");
  if (cell.flag) parts.push(cell.flag.text);
  return parts.join(", ");
}

/** The hover summary of one episode: code and status, who and what, when, where. */
export function episodePeek(documentRef, episode, { flag = null, duplicateOf = [] } = {}) {
  const peek = element(documentRef, "div", "podcast-peek");
  const head = element(documentRef, "p", "podcast-peek__head");
  const code = episodeCode(episode);
  if (code) head.append(element(documentRef, "span", "dk-mono", code));
  head.append(statusChip(documentRef, episode.status));
  peek.append(head, element(documentRef, "p", "podcast-peek__title", episodeSummary(episode)));
  const facts = element(documentRef, "dl", "podcast-peek__facts");
  const dates = [["Recorded", episode.recordingDate], ["Released", episode.releaseDate]].filter(([, value]) => value);
  for (const [label, value] of dates) {
    facts.append(element(documentRef, "dt", "", label), element(documentRef, "dd", "dk-mono", formatDate(value)));
  }
  if (dates.length) peek.append(facts);
  if (flag) peek.append(element(documentRef, "p", "podcast-peek__flag", flag.text));
  if (duplicateOf.length) {
    peek.append(element(
      documentRef,
      "p",
      "podcast-peek__flag",
      `Same number as ${duplicateOf.map((other) => episodeSummary(other)).join("; ")}`,
    ));
  }
  const links = LINK_KINDS.filter((kind) => episode.links?.[kind.id]);
  if (links.length) {
    const list = element(documentRef, "p", "podcast-peek__links");
    for (const kind of links) {
      const anchor = element(documentRef, "a", "podcast-peek__link");
      anchor.href = episode.links[kind.id];
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.append(icon(kind.icon, { size: 14 }), element(documentRef, "span", "", kind.label));
      list.append(anchor);
    }
    peek.append(list);
  }
  return peek;
}

function openOnClick(link, id, onSelect) {
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
    event.preventDefault();
    onSelect(id);
  });
}

function renderCell(documentRef, cell, row, { selectedId, query, onSelect }) {
  const item = element(documentRef, "li");
  const text = cell.number ? `E${cell.number}` : "E?";
  if (cell.kind === "gap") {
    const gap = element(documentRef, "span", "podcast-cell podcast-cell--gap", text);
    gap.setAttribute("role", "img");
    gap.setAttribute("aria-label", `S${row.season}E${cell.number}: no episode has this number`);
    gap.title = `No episode is numbered S${row.season}E${cell.number}`;
    item.append(gap);
    return item;
  }
  const { episode } = cell;
  const link = element(documentRef, "a", "podcast-cell", text);
  link.href = `/podcast/${enc(episode.id)}`;
  link.dataset.episodeId = episode.id;
  link.dataset.status = episode.status;
  if (cell.duplicate) link.classList.add("podcast-cell--duplicate");
  if (cell.flag) link.dataset.flag = cell.flag.kind;
  if (query && !matchesSearch(episode, query)) link.classList.add("is-dimmed");
  if (episode.id === selectedId) link.setAttribute("aria-current", "true");
  link.setAttribute("aria-label", cellLabel(cell, row.season));
  openOnClick(link, episode.id, onSelect);
  const duplicateOf = cell.duplicate
    ? row.cells.filter((other) => other.kind === "episode" && other.number === cell.number && other.episode !== episode)
      .map((other) => other.episode)
    : [];
  attachHovercard(link, {
    label: `${episodeCode(episode) || `Season ${row.season}`} summary`,
    className: "podcast-peek-card",
    render: () => episodePeek(documentRef, episode, { flag: cell.flag, duplicateOf }),
  });
  item.append(link);
  return item;
}

function renderSeason(documentRef, row, options) {
  const section = element(documentRef, "section", "podcast-season");
  section.dataset.season = String(row.season);
  const head = element(documentRef, "div", "podcast-season__head");
  const title = element(documentRef, "h3", "podcast-season__title", `Season ${row.season}`);
  title.id = `podcast-season-${row.season}`;
  head.append(title, element(documentRef, "span", "podcast-season__counts", countsLabel(row.counts)));
  const numbering = numberingLabel(row);
  if (numbering) head.append(element(documentRef, "span", "podcast-season__issues", numbering));
  const cells = element(documentRef, "ol", "podcast-cells");
  cells.setAttribute("aria-labelledby", title.id);
  for (const cell of row.cells) cells.append(renderCell(documentRef, cell, row, options));
  section.append(head, cells);
  return section;
}

function renderLegend(documentRef) {
  const legend = element(documentRef, "ul", "podcast-legend");
  legend.setAttribute("aria-label", "Cell colours");
  for (const status of GRID_STATUSES.filter((value) => value !== "cancelled")) {
    const item = element(documentRef, "li");
    const swatch = element(documentRef, "span", "podcast-cell podcast-cell--swatch");
    swatch.dataset.status = status;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, element(documentRef, "span", "", statusLabel(status)));
    legend.append(item);
  }
  const flagged = element(documentRef, "li");
  const flagSwatch = element(documentRef, "span", "podcast-cell podcast-cell--swatch");
  flagSwatch.dataset.status = "recorded";
  flagSwatch.dataset.flag = "stale";
  flagSwatch.setAttribute("aria-hidden", "true");
  flagged.append(flagSwatch, element(documentRef, "span", "", "Stuck or late"));
  const gap = element(documentRef, "li");
  const gapSwatch = element(documentRef, "span", "podcast-cell podcast-cell--swatch podcast-cell--gap");
  gapSwatch.setAttribute("aria-hidden", "true");
  gap.append(gapSwatch, element(documentRef, "span", "", "Unused number"));
  legend.append(flagged, gap);
  return legend;
}

/**
 * Fill the list pane's scroller with the overview of `grid`. `renderRow`
 * draws a pipeline row the way the list view draws its rows.
 */
export function renderSeasonsOverview(scroll, { documentRef, grid, query, selectedId, onSelect, renderRow }) {
  const options = { selectedId, query, onSelect };
  const pipeline = grid.pipeline.filter((item) => matchesSearch(item.episode, query));
  const seasons = grid.seasons.filter(
    (row) => !query || row.cells.some((cell) => cell.kind === "episode" && matchesSearch(cell.episode, query)),
  );
  const loose = grid.loose.filter((episode) => matchesSearch(episode, query));
  scroll.append(renderLegend(documentRef));
  if (!pipeline.length && !seasons.length && !loose.length) {
    const empty = emptyState(documentRef, "No matches", "Try another guest, title or code.");
    empty.classList.add("dk-empty--compact");
    scroll.append(empty);
    return;
  }
  if (pipeline.length) {
    const section = element(documentRef, "section", "podcast-group podcast-pipeline");
    section.dataset.group = "pipeline";
    const label = element(documentRef, "h3", "podcast-group__label", "Not yet numbered");
    label.id = "podcast-group-pipeline";
    const list = element(documentRef, "ul", "dk-split__items");
    list.setAttribute("aria-labelledby", label.id);
    for (const item of pipeline) list.append(renderRow(item.episode, selectedId, item.flag));
    section.append(label, list);
    scroll.append(section);
  }
  if (seasons.length) {
    const block = element(documentRef, "section", "podcast-seasons");
    block.setAttribute("aria-label", "Seasons");
    for (const row of seasons) block.append(renderSeason(documentRef, row, options));
    scroll.append(block);
  }
  if (loose.length) {
    const section = element(documentRef, "section", "podcast-group");
    section.dataset.group = "no-season";
    const label = element(documentRef, "h3", "podcast-group__label", "No season");
    label.id = "podcast-group-no-season";
    const list = element(documentRef, "ul", "dk-split__items");
    list.setAttribute("aria-labelledby", label.id);
    for (const episode of loose) list.append(renderRow(episode, selectedId));
    section.append(label, list);
    scroll.append(section);
  }
}

function attentionLink(documentRef, episode, text, onSelect) {
  const link = element(documentRef, "a", "podcast-attention__link");
  link.href = `/podcast/${enc(episode.id)}`;
  link.dataset.episodeId = episode.id;
  const code = episodeCode(episode);
  if (code) link.append(element(documentRef, "span", "dk-mono podcast-row__code", code));
  link.append(element(documentRef, "span", "", episodeSummary(episode)));
  openOnClick(link, episode.id, onSelect);
  const item = element(documentRef, "li", "podcast-attention__item");
  item.append(link);
  if (text) item.append(element(documentRef, "span", "podcast-attention__why", text));
  return item;
}

/**
 * The detail pane while nothing is open: the stuck or late episodes and the
 * seasons whose numbering needs fixing. Falls back to "Select an episode".
 */
export function renderAttention(pane, { documentRef, grid, onSelect }) {
  const { flagged, numbering } = attentionOf(grid);
  if (!flagged.length && !numbering.length) {
    const holder = element(documentRef, "div", "dk-split__empty");
    holder.append(emptyState(documentRef, "Select an episode", "Choose an episode to see its guests, dates, links and Card."));
    pane.append(holder);
    return;
  }
  const head = element(documentRef, "header", "dk-split__head");
  head.append(element(documentRef, "h2", "dk-split__title", "Needs a look"));
  const scroll = element(documentRef, "div", "dk-split__scroll podcast-attention");
  if (flagged.length) {
    const section = element(documentRef, "section", "podcast-section");
    section.append(element(documentRef, "h3", "podcast-section__title", "Stuck or late"));
    const list = element(documentRef, "ul", "podcast-attention__list");
    for (const item of flagged) list.append(attentionLink(documentRef, item.episode, item.flag.text, onSelect));
    section.append(list);
    scroll.append(section);
  }
  if (numbering.length) {
    const section = element(documentRef, "section", "podcast-section");
    section.append(element(documentRef, "h3", "podcast-section__title", "Numbering"));
    const list = element(documentRef, "ul", "podcast-attention__list");
    for (const row of numbering) {
      const item = element(documentRef, "li", "podcast-attention__item podcast-attention__season");
      item.append(element(documentRef, "span", "podcast-attention__season-name", `Season ${row.season}: ${row.label}`));
      if (row.duplicates.length) {
        const holders = element(documentRef, "ul", "podcast-attention__list");
        for (const episode of row.duplicates) holders.append(attentionLink(documentRef, episode, "", onSelect));
        item.append(holders);
      }
      list.append(item);
    }
    section.append(list);
    scroll.append(section);
  }
  scroll.append(element(documentRef, "p", "dk-hint", "Select an episode to see its guests, dates, links and Card."));
  pane.append(head, scroll);
}
