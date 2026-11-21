import { dualZoneEventTime, guestEventTimeZone } from "./sponsor-doc-event-time.js";
import { formatEditedTimestamp } from "../../core/dates.js";

export function appendGuestTimezoneSelector({ el, container, headerCard, guestZone, busy, draftContent, render }) {
  const target = container || headerCard;
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
  target.append(zoneLabel, el("p", "dk-hint",
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

export function renderPodcastQuestionsView({ el, draftContent }) {
  const qCard = el("div", "sponsor-doc-card sponsor-doc-questions-view");
  qCard.dataset.podcastQuestionsView = "readonly";
  const qHead = el("div", "sponsor-doc-title-row");
  qHead.append(el("h2", "sponsor-doc-section__title", "Episode Questions (Read-only recording view)"));
  qCard.append(qHead);
  const qFields = [
    ["Cold Open", draftContent.coldOpen],
    ["Intro Script", draftContent.introScript],
    ["Interview Questions", draftContent.interviewQuestions],
    ["Topics to Cover", draftContent.topicsToCover],
    ["Topics to Avoid", draftContent.topicsToAvoid],
    ["Closing Script", draftContent.closingScript],
  ];
  let hasAny = false;
  for (const [labelText, val] of qFields) {
    const text = String(val || "").trim();
    if (!text) continue;
    hasAny = true;
    const sec = el("div", "sponsor-doc-section");
    sec.append(el("h3", "sponsor-doc-field__label", labelText));
    sec.append(el("pre", "sponsor-doc-export-pre", text));
    qCard.append(sec);
  }
  if (!hasAny) qCard.append(el("p", "dk-hint", "No questions or topics added to this document yet."));
  return qCard;
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

export function buildSponsorDocIntroCallout(el, tDef) {
  const hasGuidelines = Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0;
  if (!tDef.intro && !tDef.guidelinesUrl && !hasGuidelines) return null;
  const callout = el("div", "dk-callout");
  const body = el("div", "dk-callout__body");
  if (tDef.intro) body.append(el("p", "", tDef.intro));
  if (tDef.guidelinesUrl) {
    const guideP = el("p", "");
    const guideLink = el("a", "", tDef.guidelinesLabel || "View visual placement guide →");
    guideLink.href = tDef.guidelinesUrl;
    guideLink.target = "_blank";
    guideLink.rel = "noopener noreferrer";
    guideP.append(guideLink);
    body.append(guideP);
  }
  if (hasGuidelines) {
    const ul = el("ul", "sponsor-doc-guidelines");
    for (const item of tDef.guidelines) ul.append(el("li", "", item));
    body.append(ul);
  }
  callout.append(body);
  return callout;
}

export function renderSponsorDocStaffBar({
  el,
  actionBtn,
  doc,
  busy,
  isSpeaker,
  isPodcastGuest,
  isTwoTab,
  copyText,
  onSendEmail,
  onRotateCode,
}) {
  const staffBar = el("div", "sponsor-doc-staff-bar");
  staffBar.dataset.sponsorStaffBar = "";
  const topRow = el("div", "sponsor-doc-staff-bar__row");
  const shareInfo = el("div", "");
  const linkLabel = isSpeaker
    ? "Shareable speaker link (includes access code): "
    : isPodcastGuest
      ? "Shareable guest link (includes access code): "
      : "Shareable sponsor link (includes access code): ";
  shareInfo.append(el("strong", "", linkLabel), el("code", "dk-mono", doc.shareUrl || doc.docUrl || ""));
  topRow.append(shareInfo);

  if (doc.emailDelivery) {
    const delivery = doc.emailDelivery;
    const delivRow = el("div", "sponsor-doc-staff-bar__delivery");
    delivRow.dataset.sponsorEmailDelivery = delivery.state || "unknown";
    const statusText = delivery.state === "sent"
      ? `Auto-sent from ${delivery.from} to ${delivery.to}${delivery.sentAt ? ` at ${formatEditedTimestamp(delivery.sentAt)}` : ""}`
      : `Auto-send (${delivery.from || "orin@datatalks.club"}): ${delivery.state}${delivery.reason ? ` (${delivery.reason})` : ""}`;
    delivRow.append(el("span", "dk-hint", statusText));
    topRow.append(delivRow);
  }

  const smBtn = "dk-button dk-button--secondary dk-button--sm";
  const btnRow = el("div", "sponsor-doc-actions__buttons");
  let taskLabel = null;
  if (!isSpeaker && !isPodcastGuest) {
    taskLabel = el("label", "sponsor-doc-task-id");
    taskLabel.append(el("span", "dk-hint", "Owning task ID (for the sent message record)"));
    const taskInput = el("input", "dk-input");
    taskInput.type = "text";
    taskInput.value = doc.emailDelivery?.taskId || "";
    taskInput.placeholder = "DataOps task ID";
    taskInput.disabled = busy;
    taskInput.dataset.sponsorTaskId = "";
    taskLabel.append(taskInput);
  }
  if (doc.shareUrl) {
    const copyShareLabel = isPodcastGuest ? "Copy guest link" : "Copy share link";
    const copyShareToast = isSpeaker
      ? "Copied shareable speaker link with access code."
      : isPodcastGuest
        ? "Copied shareable guest link with access code."
        : "Copied shareable sponsor link with access code.";
    btnRow.append(actionBtn(smBtn, copyShareLabel, "copy-share-url", () => copyText(doc.shareUrl, copyShareToast)));
  }
  if (doc.emailDraft?.body) {
    const isInviteCopy = isSpeaker || isPodcastGuest;
    btnRow.append(actionBtn(smBtn, isInviteCopy ? "Copy invitation email" : "Copy sponsor email", "copy-email", () =>
      copyText(
        `Subject: ${doc.emailDraft.subject}\n\n${doc.emailDraft.body}`,
        isInviteCopy ? "Copied invitation email draft." : "Copied ready-to-send sponsor email draft.",
      )));
  }
  if (!isSpeaker && !isPodcastGuest) {
    btnRow.append(actionBtn(smBtn, "Send from orin@datatalks.club", "send-sponsor-email", onSendEmail, busy));
  }
  btnRow.append(actionBtn(smBtn, "Rotate code", "rotate-code", onRotateCode, busy));
  const cardIdForLink = doc.hostContext?.cardId || doc.cardId;
  if (cardIdForLink) {
    const cardLink = el("a", smBtn, "Open Card");
    cardLink.href = `/cards?cardId=${encodeURIComponent(cardIdForLink)}`;
    btnRow.append(cardLink);
  }
  staffBar.append(topRow);
  if (taskLabel) staffBar.append(taskLabel);
  staffBar.append(btnRow);
  if (isTwoTab) {
    staffBar.append(el(
      "p",
      "dk-hint",
      "Guests with the share link only see the Guest intake tab. Internal prep is staff-only.",
    ));
  }
  return staffBar;
}

export function renderSponsorDocExportCard({ el, markdownExport, onCopy }) {
  const exportCard = el("div", "sponsor-doc-card");
  exportCard.dataset.sponsorExport = "";
  const expTop = el("div", "sponsor-doc-title-row");
  expTop.append(el("h2", "sponsor-doc-field__label", "Read-only Markdown export"));
  const copyExportBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy Markdown");
  copyExportBtn.type = "button";
  copyExportBtn.dataset.sponsorAction = "copy-export";
  copyExportBtn.addEventListener("click", () => onCopy?.());
  expTop.append(copyExportBtn);
  exportCard.append(expTop, el("pre", "sponsor-doc-export-pre", markdownExport));
  return exportCard;
}
