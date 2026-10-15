// The publication block of an episode: what is scheduled, what is verified
// public, and whether the website may go out. Read view for the detail pane
// and the controls the edit form adds. Readiness comes from the API.
import { element, field, input } from "./dom.js";
import {
  formatPublicationTime, proofLinks, publicationFormValues, readinessOf,
  SPOTIFY_LABELS, TRANSCRIPT_LABELS, WEBSITE_LABELS,
} from "./publication-model.js";

const TONES = Object.freeze({
  "not-scheduled": "dk-chip",
  scheduled: "dk-badge dk-badge--info",
  "awaiting-public-check": "dk-badge dk-badge--warning",
  public: "dk-badge dk-badge--success",
  pending: "dk-chip",
  reviewed: "dk-badge dk-badge--success",
  blocked: "dk-chip",
  ready: "dk-badge dk-badge--info",
  released: "dk-badge dk-badge--success",
  "released-early": "dk-badge dk-badge--warning",
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
  const time = formatPublicationTime(publication);
  row(
    "Audio",
    time
      ? element(documentRef, "span", "dk-mono", time)
      : element(documentRef, "span", "dk-hint", "No publication time recorded"),
  );
  const proof = (id) => proofLinks(episode).filter((entry) => entry.id === id).map((entry) => proofAnchor(documentRef, entry));
  row("Spotify", readinessChip(documentRef, "spotify", readiness.spotify), ...proof("spotify"));
  row("Transcript", readinessChip(documentRef, "transcript", readiness.transcript), ...proof("transcript"));
  row("Website", readinessChip(documentRef, "website", readiness.website), ...proof("website"));
  section.append(list);
  if (publication.website?.earlyReason) {
    section.append(element(documentRef, "p", "dk-hint podcast-early-reason", `Released before ready: ${publication.website.earlyReason}`));
  }
  if (readiness.websiteBlockers.length) {
    const callout = element(documentRef, "div", "dk-callout dk-callout--warning podcast-blockers");
    const body = element(documentRef, "div", "dk-callout__body");
    body.append(
      element(documentRef, "p", "dk-callout__title", "Website release is blocked"),
      element(
        documentRef,
        "p",
        "",
        `${readiness.websiteBlockers.join("; ")}. Scheduled audio does not count: the website needs `
          + "a reviewed transcript and a verified playable public Spotify episode.",
      ),
    );
    callout.append(body);
    section.append(callout);
  }
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
    spotifyUrl: input(documentRef, "spotifyUrl", initial.spotifyUrl, "url"),
    transcriptUrl: input(documentRef, "transcriptUrl", initial.transcriptUrl, "url"),
    websiteUrl: input(documentRef, "websiteUrl", initial.websiteUrl, "url"),
    websiteEarlyReason: input(documentRef, "websiteEarlyReason", initial.websiteEarlyReason),
  };
  controls.timezone.placeholder = "Europe/Berlin";
  controls.timezone.setAttribute("list", "podcast-timezones");
  for (const name of ["spotifyUrl", "transcriptUrl", "websiteUrl"]) controls[name].placeholder = "https://";
  controls.websiteEarlyReason.maxLength = 500;
  const spotify = checkbox(documentRef, "spotifyVerified", "I played the public Spotify episode and it works", initial.spotifyVerified);
  const transcript = checkbox(documentRef, "transcriptReviewed", "Transcript reviewed", initial.transcriptReviewed);
  controls.spotifyVerified = spotify.control;
  controls.transcriptReviewed = transcript.control;

  const fieldset = element(documentRef, "fieldset", "podcast-form-publication");
  fieldset.append(element(documentRef, "legend", "dk-label", "Publication"));
  const when = element(documentRef, "div", "podcast-form-pair");
  when.append(
    field(documentRef, "Timezone", controls.timezone, "IANA name; the audio time below is read in it."),
    field(documentRef, "Audio scheduled for", controls.audioScheduledLocal, "Scheduled is not public: verify it below once it plays."),
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
    spotify.label,
    field(documentRef, "Public Spotify episode link", controls.spotifyUrl, "https://open.spotify.com/episode/…"),
    transcript.label,
    field(documentRef, "Transcript proof link (optional)", controls.transcriptUrl),
    field(documentRef, "Website page link (once released)", controls.websiteUrl, "Needs a reviewed transcript and a verified public Spotify episode."),
    field(documentRef, "Reason for releasing early", controls.websiteEarlyReason, "Only if the page went out before both were done."),
  );
  return { fieldset, controls };
}

