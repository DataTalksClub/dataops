// The publication block of an episode: what is scheduled, what is verified
// public, and whether the website is out. Read view for the detail pane
// and the controls the edit form adds. Readiness comes from the API.
import { element, field, formatDate, input } from "./dom.js";
import {
  formatPublicationTime, proofLinks, publicationFormValues, readinessOf,
  SPOTIFY_LABELS, TRANSCRIPT_LABELS, WEBSITE_LABELS,
} from "./publication-model.js";

const TONES = Object.freeze({
  "not-recorded": "dk-chip",
  scheduled: "dk-badge dk-badge--info",
  "awaiting-public-check": "dk-badge dk-badge--warning",
  public: "dk-badge dk-badge--success",
  reviewed: "dk-badge dk-badge--success",
  released: "dk-badge dk-badge--success",
  "observed-live": "dk-badge dk-badge--warning",
});

const LABELS = Object.freeze({
  spotify: SPOTIFY_LABELS,
  transcript: TRANSCRIPT_LABELS,
  website: WEBSITE_LABELS,
});

/** A state as a word first: "Public on Spotify", with a tone for done / waiting. */
export function readinessChip(documentRef, track, state) {
  const chip = element(documentRef, "span", `${TONES[state] || "dk-chip"} podcast-readiness`, LABELS[track][state] || state);
  chip.dataset.track = track;
  chip.dataset.state = state;
  return chip;
}

export function proofAnchor(documentRef, proof) {
  const anchor = element(documentRef, "a", "podcast-proof", proof.label);
  anchor.href = proof.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.title = proof.url;
  anchor.dataset.proof = proof.id;
  return anchor;
}

export function publicationSection(documentRef, episode) {
  const section = element(documentRef, "section", "podcast-section podcast-publication");
  section.setAttribute("aria-label", "Publication");
  section.append(element(documentRef, "h3", "podcast-section__title", "Publication"));
  const readiness = readinessOf(episode);
  const publication = episode.publication || {};
  const list = element(documentRef, "dl", "dk-dl podcast-facts");
  const row = (label, ...nodes) => {
    const value = element(documentRef, "dd", "podcast-publication__value");
    value.append(...nodes);
    list.append(element(documentRef, "dt", "", label), value);
  };
  const hint = (text) => element(documentRef, "span", "dk-hint", text);
  const proof = (id) => proofLinks(episode).filter((entry) => entry.id === id).map((entry) => proofAnchor(documentRef, entry));
  // The plan and the evidence are separate rows: an intended date claims
  // nothing about what Spotify actually has scheduled.
  const intended = formatDate(episode.releaseDate);
  row("Intended release", intended ? element(documentRef, "span", "dk-mono", intended) : hint("Not set"));
  const time = formatPublicationTime(publication);
  row(
    "Spotify schedule",
    time ? element(documentRef, "span", "dk-mono", time) : hint("No Spotify scheduling recorded"),
    ...proof("schedule"),
  );
  row("Spotify", readinessChip(documentRef, "spotify", readiness.spotify), ...proof("spotify"));
  row("Transcript", readinessChip(documentRef, "transcript", readiness.transcript), ...proof("transcript"));
  row("Website", readinessChip(documentRef, "website", readiness.website), ...proof("website"), ...proof("observed"));
  section.append(list);
  return section;
}

function checkbox(documentRef, name, labelText, checked) {
  const label = element(documentRef, "label", "dk-check podcast-check");
  const control = element(documentRef, "input");
  control.type = "checkbox";
  control.name = name;
  control.checked = Boolean(checked);
  label.append(control, element(documentRef, "span", "", labelText));
  return { label, control };
}

/** Controls for the edit form; `controls` maps form value names to inputs. */
export function publicationFormFields(documentRef, episode) {
  const initial = publicationFormValues(episode);
  const controls = {
    timezone: input(documentRef, "timezone", initial.timezone),
    audioScheduledLocal: input(documentRef, "audioScheduledLocal", initial.audioScheduledLocal, "datetime-local"),
    scheduleProofUrl: input(documentRef, "scheduleProofUrl", initial.scheduleProofUrl, "url"),
    spotifyUrl: input(documentRef, "spotifyUrl", initial.spotifyUrl, "url"),
    transcriptUrl: input(documentRef, "transcriptUrl", initial.transcriptUrl, "url"),
    websiteUrl: input(documentRef, "websiteUrl", initial.websiteUrl, "url"),
    websiteObservedUrl: input(documentRef, "websiteObservedUrl", initial.websiteObservedUrl, "url"),
  };
  controls.timezone.placeholder = "Europe/Berlin";
  controls.timezone.setAttribute("list", "podcast-timezones");
  for (const name of ["scheduleProofUrl", "spotifyUrl", "transcriptUrl", "websiteUrl", "websiteObservedUrl"]) {
    controls[name].placeholder = "https://";
  }
  const spotify = checkbox(documentRef, "spotifyVerified", "I played the public Spotify episode and it works", initial.spotifyVerified);
  const transcript = checkbox(documentRef, "transcriptReviewed", "Transcript reviewed", initial.transcriptReviewed);
  controls.spotifyVerified = spotify.control;
  controls.transcriptReviewed = transcript.control;

  const fieldset = element(documentRef, "fieldset", "podcast-form-publication");
  fieldset.append(
    element(documentRef, "legend", "dk-label", "Publication evidence"),
    element(documentRef, "p", "dk-hint", "Record only what you saw. The intended release date above is a plan; nothing here is inferred from it."),
  );
  const when = element(documentRef, "div", "podcast-form-pair");
  when.append(
    field(documentRef, "Spotify scheduled for", controls.audioScheduledLocal, "As shown in Spotify. Scheduled is not public."),
    field(documentRef, "Timezone", controls.timezone, "IANA name; the time is read in it."),
  );
  const zones = element(documentRef, "datalist");
  zones.id = "podcast-timezones";
  for (const zone of ["Europe/Berlin", "Europe/London", "UTC", "America/New_York", "America/Los_Angeles"]) {
    const option = element(documentRef, "option");
    option.value = zone;
    zones.append(option);
  }
  fieldset.append(
    when,
    zones,
    field(documentRef, "Spotify schedule proof link (optional)", controls.scheduleProofUrl),
    spotify.label,
    field(documentRef, "Public Spotify episode link", controls.spotifyUrl, "https://open.spotify.com/episode/…"),
    transcript.label,
    field(documentRef, "Transcript review proof link", controls.transcriptUrl, "Required to record the review."),
    field(documentRef, "Website release link", controls.websiteUrl),
    field(documentRef, "Website already live (historical)", controls.websiteObservedUrl, "Records a page you saw live."),
  );
  return { fieldset, controls };
}
