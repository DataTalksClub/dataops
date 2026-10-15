// The publication schedule: every episode on its way out (Upcoming) or out
// (Past) with when its audio is scheduled in its own timezone, whether the
// Spotify episode is verified public, whether the transcript is reviewed, and
// whether the website may go out, plus the Card that runs it and the proofs.
import { element, emptyState, formatDate, statusChip } from "./dom.js";
import { episodeCode, episodeSummary } from "./model.js";
import { formatPublicationTime, proofLinks, readinessOf, scheduleGroups } from "./publication-model.js";
import { proofAnchor, readinessChip } from "./publication-section.js";

const enc = encodeURIComponent;

const COLUMNS = ["Episode", "Intended release", "Spotify", "Transcript", "Website", "Card", "Proof"];

function intendedCell(documentRef, episode) {
  const cell = element(documentRef, "td", "podcast-schedule__when");
  const date = formatDate(episode.releaseDate);
  cell.append(date ? element(documentRef, "span", "dk-mono", date) : element(documentRef, "span", "dk-hint", "Not set"));
  return cell;
}

// The chip says what Spotify evidence exists; the line under it is the
// evidenced schedule, in its own timezone, when one is recorded.
function spotifyCell(documentRef, episode, state) {
  const cell = element(documentRef, "td", "podcast-schedule__spotify");
  cell.append(readinessChip(documentRef, "spotify", state));
  const time = formatPublicationTime(episode.publication);
  if (time) cell.append(element(documentRef, "span", "podcast-schedule__evidence", time));
  return cell;
}

function cardCell(documentRef, episode, actions) {
  const cell = element(documentRef, "td");
  const card = episode.card;
  if (!card) {
    cell.append(element(documentRef, "span", "dk-hint", episode.cardId ? "Card unavailable" : "No Card"));
    return cell;
  }
  const link = element(documentRef, "a", "podcast-schedule__card");
  link.href = `/cards?cardId=${enc(card.id)}`;
  link.dataset.cardId = card.id;
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
    event.preventDefault();
    actions.openCard(card.id);
  });
  const open = Number(card.openTaskCount) || 0;
  const total = Number(card.taskCount) || 0;
  link.append(element(documentRef, "span", "", "Tasks"), element(documentRef, "span", "dk-mono", `${open}/${total} open`));
  link.title = card.title || "Card";
  cell.append(link);
  return cell;
}

function renderRow(documentRef, episode, actions) {
  const readiness = readinessOf(episode);
  const row = element(documentRef, "tr", "podcast-schedule__row");
  row.dataset.episodeId = episode.id;
  const name = element(documentRef, "td", "podcast-schedule__name");
  const link = element(documentRef, "a", "podcast-schedule__episode");
  link.href = `/podcast/${enc(episode.id)}`;
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
    event.preventDefault();
    actions.openEpisode(episode.id);
  });
  const code = episodeCode(episode);
  if (code) link.append(element(documentRef, "span", "dk-mono podcast-row__code", code));
  link.append(element(documentRef, "span", "", episodeSummary(episode)));
  name.append(link, statusChip(documentRef, episode.status));
  const website = element(documentRef, "td");
  const websiteChip = readinessChip(documentRef, "website", readiness.website);
  if (readiness.websiteGate.missing.length) websiteChip.title = `Release needs: ${readiness.websiteGate.missing.join("; ")}`;
  website.append(websiteChip);
  const transcript = element(documentRef, "td");
  transcript.append(readinessChip(documentRef, "transcript", readiness.transcript));
  const proofs = element(documentRef, "td");
  const proofList = element(documentRef, "div", "podcast-schedule__proofs");
  const links = proofLinks(episode);
  if (links.length) for (const proof of links) proofList.append(proofAnchor(documentRef, proof));
  else proofList.append(element(documentRef, "span", "dk-hint", "None recorded"));
  proofs.append(proofList);
  row.append(name, intendedCell(documentRef, episode), spotifyCell(documentRef, episode, readiness.spotify), transcript, website, cardCell(documentRef, episode, actions), proofs);
  return row;
}

function renderGroup(documentRef, group, actions) {
  const section = element(documentRef, "section", "podcast-schedule__group");
  section.dataset.group = group.id;
  const heading = element(documentRef, "h3", "podcast-section__title", `${group.label} (${group.episodes.length})`);
  heading.id = `podcast-schedule-${group.id}`;
  section.append(heading);
  if (!group.episodes.length) {
    const empty = emptyState(
      documentRef,
      group.id === "upcoming" ? "Nothing upcoming" : "Nothing published yet",
      group.id === "upcoming"
        ? "Episodes that are booked, or have recorded publication evidence, appear here."
        : "Episodes appear here once their website page is out, and historical episodes without recorded evidence.",
    );
    empty.classList.add("dk-empty--compact");
    section.append(empty);
    return section;
  }
  const wrap = element(documentRef, "div", "podcast-schedule__scroll");
  const table = element(documentRef, "table", "dk-table podcast-schedule");
  table.setAttribute("aria-labelledby", heading.id);
  const head = element(documentRef, "thead");
  const headRow = element(documentRef, "tr");
  for (const label of COLUMNS) {
    const th = element(documentRef, "th", "", label);
    th.scope = "col";
    headRow.append(th);
  }
  head.append(headRow);
  const body = element(documentRef, "tbody");
  for (const episode of group.episodes) body.append(renderRow(documentRef, episode, actions));
  table.append(head, body);
  wrap.append(table);
  section.append(wrap);
  return section;
}

/** Fill `root` with the schedule of `episodes`. */
export function renderSchedule(root, { documentRef, episodes, actions }) {
  const panel = element(documentRef, "div", "podcast-schedule-view");
  panel.append(
    element(
      documentRef,
      "p",
      "dk-hint podcast-schedule__note",
      "The intended release is a plan. Spotify scheduling, the public episode, the transcript review "
        + "and the website show only what has been recorded with evidence; “Not recorded” means no evidence, not a no.",
    ),
  );
  for (const group of scheduleGroups(episodes)) panel.append(renderGroup(documentRef, group, actions));
  root.append(panel);
}
