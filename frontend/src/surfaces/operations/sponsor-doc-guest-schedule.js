import { dualZoneEventTime, guestEventTimeZone } from "./sponsor-doc-event-time.js";
import { formatEditedTimestamp } from "../../core/dates.js";

export function appendGuestTimezoneSelector({
  el,
  container,
  headerCard,
  guestZone,
  busy,
  draftContent,
  render,
  compact = false,
}) {
  const target = container || headerCard;
  const zoneSelect = el("select", "dk-input");
  zoneSelect.dataset.guestTimezone = "";
  zoneSelect.setAttribute("aria-label", "Your time zone");
  const zones = new Set([guestZone, "Europe/Berlin", "UTC", ...(Intl.supportedValuesOf?.("timeZone") || [])]);
  for (const zone of zones) { const option = el("option", "", zone); option.value = zone; zoneSelect.append(option); }
  zoneSelect.value = guestZone;
  zoneSelect.disabled = busy;
  zoneSelect.addEventListener("change", () => { draftContent.guestTimezone = zoneSelect.value; render(); });

  if (compact) {
    const row = el("div", "sponsor-doc-timezone-row");
    const zoneLabel = el("label", "sponsor-doc-field__label", "Your time zone");
    zoneLabel.setAttribute("for", "guest-timezone-select");
    zoneSelect.id = "guest-timezone-select";
    row.append(zoneLabel, zoneSelect);
    target.append(row);
    return;
  }

  const zoneLabel = el("label", "sponsor-doc-field__label", "Your time zone");
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
  fieldWrap.append(actionBtn(
    "dk-button dk-button--secondary sponsor-doc-time-save",
    busy ? "Saving…" : "Save time choice",
    "save-time-choice",
    () => {
      if (!draftContent.slotChoice) {
        showWarning("Choose a time option first.");
        return;
      }
      saveChanges(undefined, {
        choice: draftContent.slotChoice,
        proposalStartIso: metadata.startIso,
        proposalVersion: metadata.version,
      });
    },
    busy,
  ));
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

export function buildSponsorDocStatusRow({ el, doc, isSubmitted, isTwoTab, isStaff }) {
  const statusRow = el("div", "sponsor-doc-status-row");
  const docChip = el("span", "sponsor-doc-status-chip");
  const badgeClass = isSubmitted ? "dk-badge dk-badge--success" : "dk-badge";
  const badge = el("span", badgeClass, isSubmitted ? "Submitted / Ready" : "Draft");
  badge.dataset.sponsorDocStatus = doc.status;
  docChip.append(el("span", "sponsor-doc-status-chip__label", "Document"), badge);
  statusRow.append(docChip);

  if (doc.eventMetadata?.state) {
    const eventState = doc.eventMetadata.state;
    const eventLabels = {
      confirmed: "Confirmed",
      tentative: "Tentative",
      unscheduled: "Unscheduled",
      released: "Released",
    };
    const eventBadgeClass = eventState === "confirmed"
      ? "dk-badge dk-badge--success"
      : eventState === "tentative"
        ? "dk-badge dk-badge--warning"
        : "dk-badge";
    const eventChip = el("span", "sponsor-doc-status-chip");
    const eventBadge = el("span", eventBadgeClass, eventLabels[eventState] || eventState);
    eventBadge.dataset.sponsorEventStatus = eventState;
    eventChip.append(el("span", "sponsor-doc-status-chip__label", "Event"), eventBadge);
    statusRow.append(eventChip);
  }

  if (isTwoTab && isStaff && doc.hostContext?.sponsored === true) {
    const sponsoredBadge = el("span", "dk-badge dk-badge--info", "Sponsored");
    sponsoredBadge.dataset.podcastSponsoredBadge = "true";
    statusRow.append(sponsoredBadge);
  }

  return statusRow;
}

export function guestEventMetadataRow({ el, doc, tDef, draftContent, isSpeakerDoc, isPodcastGuestDoc, formatEditorLabel }) {
  const metaRow = el("div", "sponsor-doc-meta");
  const guestSchedule = ["podcast", "webinar", "workshop"].includes(doc.template) && doc.eventMetadata?.startIso;
  const guestZone = guestEventTimeZone(draftContent.guestTimezone || doc.eventMetadata?.guestTimezone);
  if (guestSchedule && !draftContent.guestTimezone) draftContent.guestTimezone = guestZone;
  if (doc.eventMetadata) {
    const eventText = doc.eventMetadata.startIso
      ? dualZoneEventTime(doc.eventMetadata.startIso, doc.eventMetadata.endIso, guestZone, doc.eventMetadata.durationMinutes)
      : doc.eventMetadata.date ? `${doc.eventMetadata.date} · Time not set` : "";
    if (eventText) {
      const eventLabel = el("span", "sponsor-doc-event-time", eventText);
      eventLabel.dataset.sponsorDocEvent = "";
      metaRow.append(eventLabel);
    }
  }
  if (doc.publicationDate) metaRow.append(el("span", "", `Publication date: ${doc.publicationDate}`));
  if (doc.sponsorName) metaRow.append(el("span", "", `${isSpeakerDoc(doc) ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"}: ${doc.sponsorName}`));

  const secondaryRow = el("div", "sponsor-doc-meta sponsor-doc-meta--secondary");
  const typeLabel = el("span", "sponsor-doc-type", tDef.label || doc.template);
  const sep = el("span", "sponsor-doc-meta__sep", "·");
  sep.setAttribute("aria-hidden", "true");
  const editedSpan = el("span", "", formatEditorLabel(doc));
  editedSpan.dataset.sponsorDocLastEdited = "";
  secondaryRow.append(typeLabel, sep, editedSpan);

  return { metaRow, secondaryRow, guestSchedule, guestZone };
}

/** The template's intro and guidelines, folded away under one summary line so the header stays compact. */
export function buildSponsorDocIntroCallout(el, tDef) {
  const hasGuidelines = Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0;
  if (!tDef.intro && !tDef.guidelinesUrl && !hasGuidelines) return null;
  const details = el("details", "sponsor-doc-intro");
  details.dataset.sponsorDocIntro = "";
  details.append(el("summary", "sponsor-doc-intro__summary", "About this document"));
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
  details.append(callout);
  return details;
}

/**
 * The staff-only action strip: Copy share link and Open Card, with everything
 * secondary (sponsor email, send, rotate code, Copy Markdown, the auto-send
 * status) in a "More" overflow. The share URL and access code are never shown
 * as text; people opening the share link never get this strip.
 */
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
  onCopyExport,
}) {
  const staffBar = el("div", "sponsor-doc-staff-bar");
  staffBar.dataset.sponsorStaffBar = "";
  const smBtn = "dk-button dk-button--secondary dk-button--sm";
  const btnRow = el("div", "sponsor-doc-actions__buttons");
  const more = el("details", "sponsor-doc-more");
  more.dataset.sponsorStaffMore = "";
  const moreSummary = el("summary", smBtn, "More");
  moreSummary.setAttribute("aria-label", "More document actions");
  const menu = el("div", "dk-menu sponsor-doc-more__menu");
  const menuItem = "dk-menu__item";
  more.append(moreSummary, menu);

  if (doc.emailDelivery) {
    const delivery = doc.emailDelivery;
    const delivRow = el("div", "sponsor-doc-staff-bar__delivery");
    delivRow.dataset.sponsorEmailDelivery = delivery.state || "unknown";
    const statusText = delivery.state === "sent"
      ? `Auto-sent from ${delivery.from} to ${delivery.to}${delivery.sentAt ? ` at ${formatEditedTimestamp(delivery.sentAt)}` : ""}`
      : `Auto-send (${delivery.from || "orin@datatalks.club"}): ${delivery.state}${delivery.reason ? ` (${delivery.reason})` : ""}`;
    delivRow.append(el("span", "dk-hint", statusText));
    menu.append(delivRow);
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
  const cardIdForLink = doc.hostContext?.cardId || doc.cardId;
  if (cardIdForLink) {
    const cardLink = el("a", smBtn, "Open Card");
    cardLink.href = `/cards?cardId=${encodeURIComponent(cardIdForLink)}`;
    btnRow.append(cardLink);
  }
  if (doc.emailDraft?.body) {
    const isInviteCopy = isSpeaker || isPodcastGuest;
    menu.append(actionBtn(menuItem, isInviteCopy ? "Copy invitation email" : "Copy sponsor email", "copy-email", () =>
      copyText(
        `Subject: ${doc.emailDraft.subject}\n\n${doc.emailDraft.body}`,
        isInviteCopy ? "Copied invitation email draft." : "Copied ready-to-send sponsor email draft.",
      )));
  }
  if (!isSpeaker && !isPodcastGuest) {
    menu.append(actionBtn(menuItem, "Send from orin@datatalks.club", "send-sponsor-email", onSendEmail, busy));
  }
  if (onCopyExport && doc.markdownExport) menu.append(actionBtn(menuItem, "Copy Markdown", "copy-export", onCopyExport));
  menu.append(actionBtn(menuItem, "Rotate code", "rotate-code", onRotateCode, busy));
  btnRow.append(more);
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

export function updateSponsorDocFieldCount({
  fieldDef,
  countEl,
  valText,
  uploadedVisualName,
  isVisualField,
  maxChars,
  maxWords,
  maxXPostChars,
  splitXThread,
}) {
  if (fieldDef.key === "photoUrl" || fieldDef.key === "graphicsUrl") {
    countEl.hidden = true;
    countEl.textContent = "";
    return;
  }
  const text = String(valText || "");
  if (isVisualField && /^data:image\//i.test(text)) {
    countEl.textContent = uploadedVisualName ? `Uploaded (${uploadedVisualName})` : "Uploaded image";
    countEl.classList.remove("is-over");
    return;
  }
  if (fieldDef.key === "twitterPost") {
    const tweets = splitXThread(text);
    if (tweets.length > 1) {
      countEl.textContent = `${tweets.length} tweets (≤ ${maxXPostChars} chars each)`;
      countEl.classList.toggle("is-over", tweets.some((t) => t.length > maxXPostChars));
      return;
    }
  }
  const len = text.length;
  if (maxChars > 0) {
    countEl.textContent = `${len} / ${maxChars} chars`;
    countEl.classList.toggle("is-over", len > maxChars);
  } else if (maxWords > 0) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    countEl.textContent = `${words} / ${maxWords} words`;
    countEl.classList.toggle("is-over", words > maxWords);
  } else {
    countEl.textContent = `${len} chars`;
  }
}

export function renderSponsorDocFormActions({
  el,
  actionBtn,
  internalEdit,
  busy,
  isSubmitted,
  saveChanges,
}) {
  const actionsBar = el("div", "sponsor-doc-actions");
  const leftBtns = el("div", "sponsor-doc-actions__buttons");
  if (internalEdit) {
    leftBtns.append(actionBtn(
      "dk-button dk-button--primary",
      busy ? "Saving…" : "Save internal changes",
      "save-draft",
      () => saveChanges(undefined),
      busy,
    ));
    actionsBar.append(leftBtns);
    return actionsBar;
  }
  const rightBtns = el("div", "sponsor-doc-actions__buttons");
  const draftLabel = busy ? "Saving…" : isSubmitted ? "Save changes" : "Save draft";
  leftBtns.append(actionBtn("dk-button dk-button--secondary", draftLabel, "save-draft", () => saveChanges(undefined), busy));
  if (isSubmitted) {
    rightBtns.append(actionBtn("dk-button dk-button--secondary", "Reopen as Draft", "reopen-draft", () => saveChanges("draft"), busy));
  } else {
    const submitLabel = busy ? "Submitting…" : "Mark as Submitted / Ready";
    rightBtns.append(actionBtn("dk-button dk-button--primary", submitLabel, "submit-ready", () => saveChanges("submitted"), busy));
  }
  actionsBar.append(leftBtns, rightBtns);
  return actionsBar;
}

export function renderSponsorDocPhaseCard(el, phase) {
  const card = el("div", "dk-auth-card sponsor-doc-card");
  if (phase === "loading") {
    card.append(el("p", "dk-auth-card__lede", "Loading document…"));
    return card;
  }
  card.dataset.sponsorView = "notfound";
  const head = el("header", "dk-auth-card__head");
  head.append(
    el("h1", "dk-auth-card__title", "Document not found"),
    el("p", "dk-auth-card__lede", "Check that you opened the full link from your DataTalks.Club email."),
  );
  card.append(head);
  return card;
}
