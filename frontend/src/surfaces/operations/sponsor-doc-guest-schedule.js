import { dualZoneEventTime, guestEventTimeZone } from "./sponsor-doc-event-time.js";

export function appendGuestTimezoneSelector({ el, headerCard, guestZone, busy, draftContent, render }) {
  const zoneLabel = el("label", "sponsor-doc-field__label", "Your time zone");
  const zoneSelect = el("select", "dk-input");
  zoneSelect.dataset.guestTimezone = "";
  zoneSelect.setAttribute("aria-label", "Your time zone");
  const zones = new Set([guestZone, "Europe/Berlin", "UTC", ...(Intl.supportedValuesOf?.("timeZone") || [])]);
  for (const zone of zones) { const option = el("option", "", zone); option.value = zone; zoneSelect.append(option); }
  zoneSelect.value = guestZone;
  zoneSelect.disabled = busy;
  zoneSelect.addEventListener("change", () => { draftContent.guestTimezone = zoneSelect.value; render(); });
  zoneLabel.append(zoneSelect);
  headerCard.append(zoneLabel, el("p", "dk-hint",
    "Times show the Berlin schedule and your local date and time. " +
    "You can save a time choice now and complete the questionnaire later."));
}

export function guestSlotFieldDefinition(fieldDef, metadata, guestZone) {
  if (fieldDef.key !== "slotChoice") return fieldDef;
  return { ...fieldDef, options: (fieldDef.options || []).map(option => {
    const proposed = option.value === "confirm_proposed";
    const start = option.startIso || (proposed ? metadata.startIso : undefined);
    const end = option.endIso || (proposed ? metadata.endIso : undefined);
    const label = dualZoneEventTime(start, end, guestZone, metadata.durationMinutes);
    return label ? { ...option, label: `${proposed ? "Confirm proposed time: " : ""}${label}` } : option;
  }) };
}

export function appendTimeChoiceSave({ fieldWrap, actionBtn, busy, draftContent, metadata, saveChanges, showWarning }) {
  fieldWrap.append(actionBtn("dk-button dk-button--secondary", busy ? "Saving…" : "Save time choice", "save-time-choice", () => {
    if (!draftContent.slotChoice) {
      showWarning("Choose a time option first.");
      return;
    }
    saveChanges(undefined, {
      choice: draftContent.slotChoice,
      proposalStartIso: metadata.startIso,
      proposalVersion: metadata.version,
    });
  }, busy));
}

export function guestEventMetadataRow({ el, doc, tDef, draftContent, isSpeakerDoc, isPodcastGuestDoc, formatEditorLabel }) {
    const metaRow = el("div", "sponsor-doc-meta");
    metaRow.append(el("span", "dk-badge", tDef.label || doc.template));
    const guestSchedule = ["podcast", "webinar", "workshop"].includes(doc.template) && doc.eventMetadata?.startIso;
    const guestZone = guestEventTimeZone(draftContent.guestTimezone || doc.eventMetadata?.guestTimezone);
    if (guestSchedule && !draftContent.guestTimezone) draftContent.guestTimezone = guestZone;
    if (doc.eventMetadata) {
      const eventLabel = el("span", "", guestSchedule
        ? dualZoneEventTime(doc.eventMetadata.startIso, doc.eventMetadata.endIso, guestZone, doc.eventMetadata.durationMinutes)
        : doc.eventMetadata.label);
      eventLabel.dataset.sponsorDocEvent = "";
      eventLabel.style.whiteSpace = "pre-line";
      metaRow.append(eventLabel);
    }
    if (doc.publicationDate) metaRow.append(el("span", "", `Publication date: ${doc.publicationDate}`));
    if (doc.sponsorName) metaRow.append(el("span", "", `${isSpeakerDoc(doc) ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"}: ${doc.sponsorName}`));
    const editedSpan = el("span", "", formatEditorLabel(doc));
    editedSpan.dataset.sponsorDocLastEdited = "";
    metaRow.append(editedSpan);
    return { metaRow, guestSchedule, guestZone };
}
