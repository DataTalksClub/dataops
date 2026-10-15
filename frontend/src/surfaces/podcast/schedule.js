// The publication schedule: every episode on its way out (Upcoming) or out
// (Past) with when its audio is scheduled in its own timezone, whether the
// Spotify episode is verified public, whether the transcript is reviewed, and
// whether the website may go out, plus the Card that runs it and the proofs.
import { element, emptyState, formatDate, statusChip } from "./dom.js";
import { episodeCode, episodeSummary } from "./model.js";
import { formatPublicationTime, proofLinks, readinessOf, scheduleGroups } from "./publication-model.js";
import { proofAnchor, readinessChip } from "./publication-section.js";

const enc = encodeURIComponent;

const COLUMNS = ["Episode", "Audio", "Spotify", "Transcript", "Website", "Card", "Proof"];

function whenCell(documentRef, episode) {
  const cell = element(documentRef, "td", "podcast-schedule__when");
  const time = formatPublicationTime(episode.publication);
  if (time) {
    cell.append(element(documentRef, "span", "dk-mono", time));
    return cell;
  }
  const fallback = formatDate(episode.releaseDate);
  cell.append(
    element(documentRef, "span", "dk-hint", fallback ? `Release ${fallback}, time not set` : "Not scheduled"),
  );
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
  website.append(readinessChip(documentRef, "website", readiness.website));
  if (readiness.websiteBlockers.length) {
    website.append(element(documentRef, "span", "dk-hint podcast-schedule__blockers", readiness.websiteBlockers.join("; ")));
  }
  const spotify = element(documentRef, "td");
  spotify.append(readinessChip(documentRef, "spotify", readiness.spotify));
  const transcript = element(documentRef, "td");
  transcript.append(readinessChip(documentRef, "transcript", readiness.transcript));
  const proofs = element(documentRef, "td", "podcast-schedule__proofs");
  const links = proofLinks(episode);
  if (links.length) for (const proof of links) proofs.append(proofAnchor(documentRef, proof));
  else proofs.append(element(documentRef, "span", "dk-hint", "None recorded"));
  row.append(name, whenCell(documentRef, episode), spotify, transcript, website, cardCell(documentRef, episode, actions), proofs);
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
        ? "Record an audio schedule on an episode to see it here."
        : "Episodes appear here once their website page is released.",
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
      "Scheduled audio is not public. Spotify turns public only when someone verifies the playable episode; the website needs that and a reviewed transcript.",
    ),
  );
  for (const group of scheduleGroups(episodes)) panel.append(renderGroup(documentRef, group, actions));
  root.append(panel);
}
