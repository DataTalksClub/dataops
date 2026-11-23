import {
  appendGuestTimezoneSelector,
  appendTimeChoiceSave,
  buildSponsorDocIntroCallout,
  guestEventMetadataRow,
  guestSlotFieldDefinition,
  renderPodcastQuestionsView,
  renderSponsorDocExportCard,
  renderSponsorDocFormActions,
  renderSponsorDocPhaseCard,
  renderSponsorDocStaffBar,
  updateSponsorDocFieldCount,
} from "./sponsor-doc-guest-schedule.js";
import {
  buildStrippedCodePath,
  fetchPodcastQnaState,
  hasPodcastHostContent,
  isPodcastTwoTabDoc,
  mountPodcastSchedulingContainer,
  parseInitialPodcastRoute,
  renderPodcastTwoTabWorkspace,
  stripGuestPodcastQueryParams,
  syncPodcastHistoryUrl,
} from "./sponsor-doc-podcast.js";
import { formatEditedTimestamp } from "../../core/dates.js";
import { formatUserCode } from "../../dakit/device-code.js";
import { renderSponsorDocGate } from "./sponsor-doc-gate.js";
import { SPONSOR_DOC_AUTOSAVE_DELAY_MS, createSponsorDocAutosave, notSavedMessage, reportSaveFailure } from "./sponsor-doc-autosave.js";
import { appendSponsorDocRadioField } from "./sponsor-doc-radio.js";
import { appendSponsorDocSelectField } from "./sponsor-doc-select.js";
import { isImageOnlyVisualField, mountSponsorDocVisualControls } from "./sponsor-doc-visual.js";
import {
  appendSponsorDocBulletsField,
  parseSponsorBulletItems,
  serializeSponsorBulletItems,
} from "./sponsor-doc-bullets.js";
import {
  DEFAULT_NEWSLETTER_UTM_MEDIUM,
  DEFAULT_NEWSLETTER_UTM_SOURCE,
  MAX_X_POST_CHARS,
  attachSoftUtmSuggestion,
  buildSuggestedUtmUrl,
  generateSponsorLinkedinPost,
  generateSponsorSocialPosts,
  generateSponsorXPosts,
  hasUtmParams,
  isEmailPieceSection,
  mountNewsletterEmailPieceSection,
  needsNewsletterUtmSuggestion,
  renderNewsletterLivePreview,
  splitSponsorXThread,
  validateSponsorDocDraft,
} from "./sponsor-doc-email-card.js";

export {
  DEFAULT_NEWSLETTER_UTM_MEDIUM,
  DEFAULT_NEWSLETTER_UTM_SOURCE,
  MAX_X_POST_CHARS,
  buildSuggestedUtmUrl,
  generateSponsorLinkedinPost,
  generateSponsorSocialPosts,
  generateSponsorXPosts,
  hasUtmParams,
  needsNewsletterUtmSuggestion,
  parseSponsorBulletItems,
  serializeSponsorBulletItems,
  splitSponsorXThread,
};

export const SPONSOR_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const SPONSOR_CODE_LENGTH = 16;

export { readVisualFileAsDataUrl } from "./sponsor-doc-files.js";

function isNewsletterTemplate(templateKey, tDef) {
  return String(templateKey || tDef?.key || "").startsWith("newsletter-");
}

function safePreviewHref(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "#";
}

export const SPONSOR_DOC_PATH_PREFIXES = ["/webinar-docs", "/workshop-docs", "/podcast-docs", "/guest-docs", "/sponsor-docs"];

function extractDocId(pathname) {
  const match = /^\/(sponsor-docs|podcast-docs|guest-docs|webinar-docs|workshop-docs)\/([^/?#]+)/.exec(String(pathname || ""));
  if (!match) return { id: "", prefix: "/sponsor-docs" };
  return { id: decodeURIComponent(match[2]), prefix: `/${match[1]}` };
}

/** Podcast guest form reads as guest materials everywhere, never sponsor. */
function isPodcastGuestDoc(doc) {
  const key = String(doc?.template || doc?.templateDefinition?.key || "");
  return key === "podcast" || key.startsWith("podcast-");
}

/** Webinar and workshop forms are filled by the speaker. */
const isSpeakerDoc = (doc) => doc?.template === "webinar" || doc?.template === "workshop";

function guestRoleLabel(doc) {
  if (isSpeakerDoc(doc)) return "speaker";
  return isPodcastGuestDoc(doc) ? "guest" : "sponsor";
}

function formatEditorLabel(doc) {
  if (!doc?.lastEditedAt) return "Not edited yet";
  const who = doc.lastEditedBy === "staff"
    ? (doc.lastEditedByName ? `staff (${doc.lastEditedByName})` : "staff")
    : guestRoleLabel(doc);
  return `Last edited ${formatEditedTimestamp(doc.lastEditedAt)} by ${who}`;
}

export function createSponsorDocPage({
  documentRef,
  request,
  locationRef,
  historyRef,
  storageRef = globalThis.sessionStorage,
  clipboardRef = globalThis.navigator?.clipboard,
  autosaveDelayMs = SPONSOR_DOC_AUTOSAVE_DELAY_MS,
}) {
  const root = documentRef.querySelector("#sponsor-doc-root");
  const identity = documentRef.querySelector("#sponsor-doc-identity");
  const live = documentRef.querySelector("#dk-live");

  let docId = "";
  let docPathPrefix = "/sponsor-docs";
  let accessCode = "";
  let doc = null;
  let draftContent = {};
  let fieldErrors = {};
  let uploadedVisualName = "";
  let questionsOnly = false;
  let activePodcastTab = "guest";
  let podcastInternalMode = "host";
  let podcastInternalModeTouched = false;
  let recordingSlotExpanded = false;
  let qnaState = { loading: false, loaded: false, questions: null, error: "" };
  let phase = "loading";
  let gateError = "";
  let feedbackMsg = "";
  let feedbackTone = "info";
  let busy = false;
  let unbindCode = null;

  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const actionBtn = (className, text, action, onClick, disabled = false) => {
    const button = el("button", className, text);
    button.type = "button";
    if (action) button.dataset.sponsorAction = action;
    button.disabled = disabled;
    if (onClick) button.addEventListener("click", onClick);
    return button;
  };

  const announce = (message) => {
    if (live) live.textContent = message;
  };
  const storageKey = (id) => `dataops:sponsor-doc-code:${id}`;

  function saveStoredCode(id, codeValue) {
    if (!id || !storageRef) return;
    try {
      if (codeValue) storageRef.setItem(storageKey(id), codeValue);
      else storageRef.removeItem(storageKey(id));
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }

  function readStoredCode(id) {
    if (!id || !storageRef) return "";
    try {
      return storageRef.getItem(storageKey(id)) || "";
    } catch {
      return "";
    }
  }

  function updateIdentityBar() {
    if (!identity) return;
    identity.replaceChildren();
    if (phase === "editor" && doc) {
      if (doc.viewerRole === "staff") {
        identity.append(el("span", "", "DataOps Staff · Full access"));
      } else {
        identity.append(el("span", "", `${isSpeakerDoc(doc) ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"} access · Code verified`));
        const lockBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Lock");
        lockBtn.type = "button";
        lockBtn.dataset.sponsorAction = "lock";
        lockBtn.addEventListener("click", () => {
          accessCode = "";
          saveStoredCode(docId, "");
          doc = null;
          activePodcastTab = "guest";
          podcastInternalMode = "host";
          podcastInternalModeTouched = false;
          recordingSlotExpanded = false;
          qnaState = { loading: false, loaded: false, questions: null, error: "" };
          phase = "gate";
          gateError = "";
          render();
        });
        identity.append(documentRef.createTextNode(" "), lockBtn);
      }
      return;
    }
    const signInLink = el("a", "", "Staff sign in");
    const nextPath = `${docPathPrefix}/${encodeURIComponent(docId)}`;
    signInLink.href = `/login?return_to=${encodeURIComponent(nextPath)}`;
    identity.append(el("span", "", "Access code protected · "), signInLink);
  }

  async function copyText(text, successNotice) {
    try {
      await clipboardRef?.writeText?.(text);
    } catch {
      // Fallback no-op when clipboard API is unavailable
    }
    feedbackMsg = successNotice;
    feedbackTone = "success";
    announce(successNotice);
    render();
  }

  function syncPodcastUrl() {
    if (!isPodcastTwoTabDoc(doc) || doc?.viewerRole !== "staff") return;
    syncPodcastHistoryUrl({
      historyRef,
      docPathPrefix,
      docId,
      activeTab: activePodcastTab,
      internalMode: podcastInternalMode,
    });
  }

  async function loadPodcastQna() {
    if (!doc || qnaState.loading) return;
    qnaState = { ...qnaState, loading: true, error: "" };
    render();
    qnaState = await fetchPodcastQnaState({ request, doc, currentState: qnaState });
    render();
  }

  async function loadDoc() {
    phase = "loading";
    render();
    try {
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, { method: "GET", headers });
      doc = payload.doc;
      draftContent = { ...(doc.content || {}) };
      fieldErrors = {};
      uploadedVisualName = "";
      recordingSlotExpanded = false;
      qnaState = { loading: false, loaded: false, questions: null, error: "" };
      if (isPodcastTwoTabDoc(doc)) {
        if (doc.viewerRole !== "staff") {
          activePodcastTab = "guest";
          podcastInternalMode = "host";
          podcastInternalModeTouched = false;
          questionsOnly = false;
          stripGuestPodcastQueryParams({ locationRef, historyRef, docPathPrefix, docId });
        } else if (activePodcastTab === "internal" && !podcastInternalModeTouched) {
          podcastInternalMode = hasPodcastHostContent(draftContent) ? "host" : "edit";
          podcastInternalModeTouched = true;
        }
      }
      if (accessCode) saveStoredCode(docId, accessCode);
      gateError = "";
      phase = "editor";
      autosave.setSaved();
      autosave.forgetBaseline();
      render();
      autosave.markClean();
    } catch (err) {
      if (err.status === 404) {
        phase = "notfound";
      } else if (err.status === 429) {
        phase = "gate";
        gateError = `Too many failed access code attempts. Please wait ${err.retryAfter || 60} seconds and try again.`;
      } else if (err.status === 403 && err.code === "staff_only_document") {
        phase = "gate";
        gateError = "This document is for staff only. Use \"Staff sign in\" above with your DataTalks.Club account; an access code cannot open it.";
      } else if (err.status === 403) {
        saveStoredCode(docId, "");
        phase = "gate";
        gateError = "Invalid access code. Check the 16-character code from your email and try again.";
      } else if (err.status === 401) {
        phase = "gate";
        gateError = "";
      } else {
        phase = "gate";
        gateError = err.message || "Could not load the document.";
      }
      render();
    }
  }

  function savableContent() {
    const derivedKeys = new Set((doc?.templateDefinition?.sections || []).flatMap(section =>
      (section.fields || []).filter(field => field.derived).map(field => field.key)));
    return Object.fromEntries(Object.entries(draftContent).filter(([key]) => !derivedKeys.has(key)));
  }

  const autosave = createSponsorDocAutosave({
    el, actionBtn, root, request, announce, delayMs: autosaveDelayMs,
    ctx: {
      doc: () => doc, setDoc: (next) => { doc = next; }, docId: () => docId, accessCode: () => accessCode,
      editing: () => phase === "editor" && Boolean(doc), busy: () => busy, savableContent,
      savedLabel: () => (doc?.lastEditedAt ? formatEditorLabel(doc) : ""),
      setFieldErrors: (fields) => { fieldErrors = { ...fields }; },
    },
  });

  async function saveChanges(nextStatus, timeChoiceIntent) {
    if (busy || !doc) return;
    await autosave.settle();
    if (busy || !doc) return;
    if (nextStatus === "submitted") {
      const validationErrors = validateSponsorDocDraft(doc.templateDefinition, draftContent);
      if (Object.keys(validationErrors).length > 0) {
        fieldErrors = validationErrors;
        feedbackMsg = Object.values(validationErrors).join(" ");
        feedbackTone = "danger";
        announce(feedbackMsg);
        render();
        return;
      }
    }
    fieldErrors = {};
    busy = true;
    feedbackMsg = "";
    render();
    try {
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      const body = { content: savableContent() };
      if (nextStatus) body.status = nextStatus;
      if (timeChoiceIntent) body.timeChoiceIntent = timeChoiceIntent;
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      doc = payload.doc;
      draftContent = { ...(doc.content || {}) };
      if (timeChoiceIntent) recordingSlotExpanded = false;
      busy = false;
      autosave.setSaved();
      autosave.forgetBaseline();
      if (nextStatus === "submitted") {
        feedbackMsg = "Submitted and marked ready for DataTalks.Club review.";
        feedbackTone = "success";
      } else if (nextStatus === "draft") {
        feedbackMsg = "Reopened as draft.";
        feedbackTone = "info";
      } else {
        feedbackMsg = `Saved draft · ${formatEditorLabel(doc)}`;
        feedbackTone = "success";
      }
      announce(feedbackMsg);
      render();
      autosave.markClean();
    } catch (err) {
      busy = false;
      if (err.fields && typeof err.fields === "object") {
        fieldErrors = { ...err.fields };
      }
      feedbackMsg = `${notSavedMessage(err)} Try again.`;
      feedbackTone = "danger";
      autosave.setError(notSavedMessage(err));
      reportSaveFailure(err);
      announce(feedbackMsg);
      render();
    }
  }

  async function rotateStaffCode() {
    if (busy || !doc) return;
    busy = true;
    render();
    try {
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}/rotate-code`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      doc = payload.doc;
      busy = false;
      const linkRole = isSpeakerDoc(doc) ? "speaker" : isPodcastGuestDoc(doc) ? "guest" : "sponsor";
      feedbackMsg = `Rotated access code. Previous ${linkRole} links with the old code are now invalid.`;
      feedbackTone = "warning";
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = err.message || "Could not rotate access code.";
      feedbackTone = "danger";
      render();
    }
  }

  async function sendSponsorEmailFromOrin() {
    if (busy || !doc) return;
    busy = true;
    render();
    try {
      // The server finds the owning email-sponsor Task from the doc's Card.
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}/send-email`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (payload?.doc) doc = payload.doc;
      const delivery = payload?.emailDelivery || doc?.emailDelivery;
      busy = false;
      if (delivery?.state === "sent") {
        feedbackMsg = `Sent sponsor form email from ${delivery.from} to ${delivery.to}.`;
        feedbackTone = "success";
      } else {
        feedbackMsg = delivery?.message || "Sponsor email could not be sent automatically yet.";
        feedbackTone = "warning";
      }
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = `Could not send sponsor email: ${err.message || "unknown error"}`;
      feedbackTone = "danger";
      render();
    }
  }

  function renderGate() {
    unbindCode = renderSponsorDocGate({
      el,
      root,
      initialCode: accessCode,
      gateError,
      onUnlock: (displayCode) => {
        accessCode = displayCode;
        loadDoc();
      },
    });
  }

  function renderEditor() {
    const tDef = doc.templateDefinition || { label: doc.template, fields: [], guidelines: [] };
    const isSubmitted = doc.status === "submitted";
    const isTwoTab = isPodcastTwoTabDoc(doc);
    const isStaff = doc.viewerRole === "staff";
    const formTitle = doc.title || (doc.template === "workshop" ? "Workshop Materials"
      : doc.template === "webinar" ? "Speaker Materials"
        : isPodcastGuestDoc(doc) ? "Guest Materials" : "Sponsorship Document");
    try {
      documentRef.title = `${formTitle} · DataTalks.Club`;
    } catch {
      // Non-browser test doubles may not support setting the title
    }

    // 1. Header & guidelines card
    const headerCard = el("div", "sponsor-doc-card");
    headerCard.dataset.sponsorView = "editor";

    const headWrap = el("div", "sponsor-doc-head");
    const titleRow = el("div", "sponsor-doc-title-row");
    const badgeClass = isSubmitted ? "dk-badge dk-badge--success" : "dk-badge";
    const badge = el("span", badgeClass, isSubmitted ? "Submitted / Ready" : "Draft");
    badge.dataset.sponsorDocStatus = doc.status;
    titleRow.append(el("h1", "sponsor-doc-title", formTitle), badge);
    if (isTwoTab && isStaff && doc.hostContext?.sponsored === true) {
      const sponsoredBadge = el("span", "dk-badge dk-badge--info", "Sponsored");
      sponsoredBadge.dataset.podcastSponsoredBadge = "true";
      titleRow.append(sponsoredBadge);
    }
    if (isTwoTab && isStaff) {
      const onHostView = activePodcastTab === "internal" && podcastInternalMode === "host";
      titleRow.append(actionBtn(
        "dk-button dk-button--secondary dk-button--sm",
        onHostView ? "Back to form" : "View questions",
        "toggle-questions-view",
        () => {
          if (activePodcastTab === "internal" && podcastInternalMode === "host") {
            activePodcastTab = "guest";
          } else {
            activePodcastTab = "internal";
            podcastInternalMode = "host";
            podcastInternalModeTouched = true;
          }
          syncPodcastUrl();
          render();
        },
      ));
    } else if (!isTwoTab && isPodcastGuestDoc(doc)) {
      titleRow.append(actionBtn(
        "dk-button dk-button--secondary dk-button--sm",
        questionsOnly ? "Back to form" : "View questions",
        "toggle-questions-view",
        () => { questionsOnly = !questionsOnly; render(); },
      ));
    }

    const { metaRow, guestSchedule, guestZone } = guestEventMetadataRow({
      el, doc, tDef, draftContent, isSpeakerDoc, isPodcastGuestDoc, formatEditorLabel,
    });
    headWrap.append(titleRow, metaRow);
    headerCard.append(headWrap);
    if (guestSchedule && !isTwoTab) {
      appendGuestTimezoneSelector({ el, headerCard, guestZone, busy, draftContent, render });
    }

    if (isStaff) {
      headerCard.append(renderSponsorDocStaffBar({
        el,
        actionBtn,
        doc,
        busy,
        isSpeaker: isSpeakerDoc(doc),
        isPodcastGuest: isPodcastGuestDoc(doc),
        isTwoTab,
        copyText,
        onSendEmail: () => sendSponsorEmailFromOrin(),
        onRotateCode: () => rotateStaffCode(),
      }));
    }

    if (!isTwoTab) {
      const introCallout = buildSponsorDocIntroCallout(el, tDef);
      if (introCallout) headerCard.append(introCallout);
    }

    root.append(headerCard);

    if (!isTwoTab && questionsOnly && isPodcastGuestDoc(doc)) {
      root.append(renderPodcastQuestionsView({ el, draftContent }));
      return;
    }

    // 2. Editor form card + optional Live Preview pane
    const showLivePreview = isNewsletterTemplate(doc.template, tDef);
    root.classList.toggle("sponsor-doc-shell--with-preview", showLivePreview);

    const sections = Array.isArray(tDef.sections) && tDef.sections.length > 0
      ? tDef.sections
      : [{ id: "main", title: "", fields: tDef.fields || [] }];
    const allFields = sections.flatMap((section) => section.fields || []);
    const hasField = (key) => allFields.some((f) => f.key === key);

    const previewCard = showLivePreview ? el("aside", "sponsor-doc-card sponsor-doc-preview") : null;
    if (previewCard) {
      previewCard.dataset.sponsorLivePreview = "";
      previewCard.setAttribute("aria-label", "Live newsletter preview");
    }

    const previewSyncListeners = [];
    const socialFieldControls = new Map();
    const syncAutoSocialPosts = () => {
      if (!showLivePreview) return;
      const social = generateSponsorSocialPosts(draftContent, { sponsorName: doc.sponsorName });
      draftContent.linkedinPost = social.linkedinPost;
      draftContent.twitterPost = social.twitterPost;
      for (const [key, val] of [["linkedinPost", social.linkedinPost], ["twitterPost", social.twitterPost]]) {
        const binding = socialFieldControls.get(key);
        if (binding) { binding.control.value = val; binding.updateCount(val); }
      }
    };
    if (showLivePreview && !String(draftContent.linkedinPost || "").trim() && !String(draftContent.twitterPost || "").trim()) {
      syncAutoSocialPosts();
    }
    const updateLivePreview = () => {
      for (const fn of previewSyncListeners) fn();
      renderNewsletterLivePreview({ el, previewCard, doc, tDef, draftContent, hasField, uploadedVisualName, safePreviewHref });
      // Helpers (uploads, bullets, radios, selects) report edits through here.
      autosave.schedule();
    };
    const onSourceFieldEdit = () => { syncAutoSocialPosts(); updateLivePreview(); };

    const buildFormElement = ({ sectionsToRender, forceExpanded = false, internalEdit = false }) => {
      const form = el("form", "sponsor-doc-form");
      form.noValidate = true;
      let timezoneMounted = !isTwoTab || !guestSchedule || internalEdit;

      for (const sectionDef of sectionsToRender) {
        const collapsible = !forceExpanded && Boolean(sectionDef.collapsible);
        const sectionWrap = collapsible
          ? el("details", "sponsor-doc-section sponsor-doc-details")
          : el("div", "sponsor-doc-section");
        if (collapsible) {
          sectionWrap.dataset.sponsorCollapsible = sectionDef.id;
          const filled = (sectionDef.fields || []).some((field) => String(draftContent[field.key] ?? "").trim().length > 0);
          if (filled) sectionWrap.open = true;
          const summary = el("summary", "sponsor-doc-details__summary");
          if (sectionDef.title) {
            summary.append(
              el("span", "sponsor-doc-section__title", sectionDef.title),
              el("span", "sponsor-doc-details__hint", "Optional — tap to expand"),
            );
          }
          sectionWrap.append(summary);
        } else if (sectionDef.title) {
          sectionWrap.append(el("h2", "sponsor-doc-section__title", sectionDef.title));
        }

        const schedulingState = isTwoTab && !internalEdit && sectionDef.id === "scheduling"
          ? mountPodcastSchedulingContainer({
            el,
            actionBtn,
            doc,
            guestZone,
            sectionWrap,
            expanded: recordingSlotExpanded,
            onToggle: () => {
              recordingSlotExpanded = !recordingSlotExpanded;
              render();
            },
          })
          : { collapsed: false, target: sectionWrap };
        if (schedulingState.collapsed) {
          timezoneMounted = true;
          form.append(sectionWrap);
          continue;
        }
        const sectionTarget = schedulingState.target;

        if (sectionDef.description) sectionTarget.append(el("p", "dk-hint", sectionDef.description));
        if (!timezoneMounted && sectionDef.id === "scheduling") {
          appendGuestTimezoneSelector({
            el,
            container: sectionTarget,
            guestZone,
            busy,
            draftContent,
            render,
            compact: isTwoTab,
          });
          timezoneMounted = true;
        }

        const useEmailCard = isEmailPieceSection(doc, tDef, sectionDef);
        const fieldNodesByKey = new Map();
        const appendFieldNode = (key, node) => {
          if (useEmailCard) fieldNodesByKey.set(key, node);
          else sectionTarget.append(node);
        };

        for (const fieldDef of sectionDef.fields || []) {
          if (guestSchedule && ["guestTimezone", "proposedSlotLabel"].includes(fieldDef.key)) continue;
          const fieldWrap = el("div", "sponsor-doc-field");
          fieldWrap.dataset.sponsorFieldGroup = fieldDef.key;
          if (fieldDef.required) fieldWrap.dataset.sponsorFieldRequired = "true";
          const top = el("div", "sponsor-doc-field__top");
          const label = el("label", "sponsor-doc-field__label", `${fieldDef.label}${fieldDef.required ? " *" : ""}`);
          const inputId = `sponsor-field-${fieldDef.key}`;
          label.setAttribute("for", inputId);

          const maxChars = fieldDef.maxCharsHint || fieldDef.maxChars || 0;
          const maxWords = fieldDef.maxWordsHint || 0;
          const countEl = el("span", "sponsor-doc-field__count");
          const currentVal = String(draftContent[fieldDef.key] ?? "");

          const appendErrorIfAny = () => {
            const errText = fieldErrors[fieldDef.key];
            if (!errText) return null;
            const errEl = el("p", "sponsor-doc-field__error", errText);
            errEl.dataset.sponsorFieldError = fieldDef.key;
            fieldWrap.append(errEl);
            return errEl;
          };

          if (fieldDef.derived) {
            top.append(label);
            const value = el("p", "dk-hint", currentVal || "Unscheduled");
            value.dataset.sponsorDerivedField = fieldDef.key;
            fieldWrap.append(top, value);
            sectionTarget.append(fieldWrap);
            continue;
          }

          if (fieldDef.type === "bullets" || fieldDef.key === "bullets") {
            appendSponsorDocBulletsField({
              el, actionBtn, fieldWrap, fieldDef, inputId, currentVal, busy, draftContent,
              updateLivePreview: onSourceFieldEdit, top, label, countEl,
            });
            appendErrorIfAny();
            appendFieldNode(fieldDef.key, fieldWrap);
            continue;
          }

          const isVisualField = fieldDef.key === "graphicsUrl" || Boolean(fieldDef.allowVisualUpload);
          const updateCount = (valText) => updateSponsorDocFieldCount({
            fieldDef,
            countEl,
            valText,
            uploadedVisualName,
            isVisualField,
            maxChars,
            maxWords,
            maxXPostChars: MAX_X_POST_CHARS,
            splitXThread: splitSponsorXThread,
          });

          updateCount(currentVal);
          top.append(label, countEl);

          if (fieldDef.type === "radio") {
            appendSponsorDocRadioField({
              el, fieldWrap,
              fieldDef: guestSchedule ? guestSlotFieldDefinition(fieldDef, doc.eventMetadata, guestZone) : fieldDef,
              inputId, currentVal, busy, draftContent, updateLivePreview, top,
            });
            if (fieldDef.key === "slotChoice" && guestSchedule) {
              appendTimeChoiceSave({
                fieldWrap, actionBtn, busy, draftContent, metadata: doc.eventMetadata, saveChanges,
                showWarning: (message) => { feedbackMsg = message; feedbackTone = "warning"; render(); },
              });
            }
            appendErrorIfAny();
            appendFieldNode(fieldDef.key, fieldWrap);
            continue;
          }

          if (fieldDef.type === "select") {
            appendSponsorDocSelectField({
              el, fieldWrap, fieldDef, inputId, currentVal, busy, draftContent, updateCount, updateLivePreview, top,
            });
            appendErrorIfAny();
            appendFieldNode(fieldDef.key, fieldWrap);
            continue;
          }

          const imageOnly = isImageOnlyVisualField(fieldDef);
          const isMultiline = !imageOnly && (fieldDef.type === "textarea" || Boolean(fieldDef.multiline));
          const control = isMultiline ? el("textarea", "sponsor-doc-textarea") : el("input", "dk-input");
          if (isMultiline) control.rows = fieldDef.rows || 5;
          else control.type = imageOnly ? "hidden" : "text";
          // Image fields show the image and an Upload/Replace button; the URL
          // stays in a hidden input, never as an editable text box.
          if (imageOnly) {
            control.hidden = true;
            label.setAttribute("for", `sponsor-visual-file-${fieldDef.key}`);
          }
          control.id = inputId;
          control.dataset.sponsorField = fieldDef.key;
          const isDataVisual = isVisualField && /^data:image\//i.test(currentVal);
          const attachedPh = "Uploaded visual attached — or paste an https:// link to replace";
          control.placeholder = isDataVisual ? attachedPh : (fieldDef.placeholder || "");
          control.value = isDataVisual ? "" : currentVal;
          control.disabled = busy;
          if (fieldDef.required) { control.required = true; control.setAttribute("aria-required", "true"); }
          if (fieldErrors[fieldDef.key]) control.setAttribute("aria-invalid", "true");
          if (fieldDef.format === "url" && !imageOnly) control.type = "url";
          fieldWrap.append(top, control);

          const isSocialField = fieldDef.key === "linkedinPost" || fieldDef.key === "twitterPost";
          if (isSocialField) socialFieldControls.set(fieldDef.key, { control, updateCount });

          const syncUtmSuggestion = attachSoftUtmSuggestion({
            el, actionBtn, fieldWrap, fieldDef, control, draftContent,
            publicationDate: doc.publicationDate, updateCount, updateLivePreview: onSourceFieldEdit, announce,
            // A helper-filled value is a real edit: save it right away.
            onApplied: () => autosave.schedule(0),
          });

          control.addEventListener("input", () => {
            uploadedVisualName = "";
            draftContent[fieldDef.key] = control.value;
            if (fieldErrors[fieldDef.key]) {
              delete fieldErrors[fieldDef.key];
              control.removeAttribute("aria-invalid");
              fieldWrap.querySelector(`[data-sponsor-field-error="${fieldDef.key}"]`)?.remove?.();
            }
            updateCount(control.value);
            syncUtmSuggestion();
            if (isSocialField) updateLivePreview();
            else onSourceFieldEdit();
          });

          if (isVisualField) {
            mountSponsorDocVisualControls({
              el, actionBtn, fieldWrap, fieldDef, control, docId, accessCode, request, busy,
              draftContent, fieldErrors,
              getUploadedVisualName: () => uploadedVisualName,
              setUploadedVisualName: (name) => { uploadedVisualName = name; },
              updateCount, updateLivePreview, announce,
            });
          }

          appendErrorIfAny();
          if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
          appendFieldNode(fieldDef.key, fieldWrap);
        }

        if (useEmailCard) {
          const syncEditorCta = mountNewsletterEmailPieceSection({
            el, doc, sectionWrap, sectionDef, fieldNodesByKey, draftContent, safePreviewHref,
          });
          previewSyncListeners.push(syncEditorCta);
        }
        form.append(sectionWrap);
      }

      if (!timezoneMounted) {
        appendGuestTimezoneSelector({
          el,
          container: form,
          guestZone,
          busy,
          draftContent,
          render,
          compact: isTwoTab,
        });
      }

      if (feedbackMsg) {
        const fb = el("div", `dk-callout dk-callout--${feedbackTone}`);
        fb.setAttribute("role", "status");
        fb.dataset.sponsorFeedback = "";
        fb.append(el("div", "dk-callout__body", feedbackMsg));
        form.append(fb);
      }

      form.addEventListener("submit", (event) => { event.preventDefault(); saveChanges(undefined); });
      form.append(autosave.statusNode());
      form.append(renderSponsorDocFormActions({
        el,
        actionBtn,
        internalEdit,
        busy,
        isSubmitted,
        saveChanges,
      }));
      return form;
    };

    if (isTwoTab) {
      if (isStaff && activePodcastTab === "internal" && !podcastInternalModeTouched) {
        podcastInternalMode = hasPodcastHostContent(draftContent) ? "host" : "edit";
        podcastInternalModeTouched = true;
      }
      renderPodcastTwoTabWorkspace({
        el,
        actionBtn,
        root,
        doc,
        tDef,
        draftContent,
        guestZone,
        qnaState,
        isStaff,
        activeTab: activePodcastTab,
        internalMode: podcastInternalMode,
        sections,
        buildFormElement,
        buildIntroCallout: (def) => buildSponsorDocIntroCallout(el, def),
        onSelectTab: (nextTab) => {
          activePodcastTab = nextTab === "internal" ? "internal" : "guest";
          if (activePodcastTab === "internal" && !podcastInternalModeTouched) {
            podcastInternalMode = hasPodcastHostContent(draftContent) ? "host" : "edit";
            podcastInternalModeTouched = true;
          }
          syncPodcastUrl();
          render();
        },
        onSelectMode: (mode) => {
          podcastInternalMode = mode === "edit" ? "edit" : "host";
          podcastInternalModeTouched = true;
          syncPodcastUrl();
          render();
        },
        onLoadQna: loadPodcastQna,
        onEditPrep: () => {
          podcastInternalMode = "edit";
          podcastInternalModeTouched = true;
          syncPodcastUrl();
          render();
        },
        onEditQuestions: () => {
          activePodcastTab = "guest";
          syncPodcastUrl();
          render();
        },
        onCopyExport: () => copyText(doc.markdownExport, "Copied Markdown export to clipboard."),
      });
      return;
    }

    const formCard = el("div", "sponsor-doc-card sponsor-doc-form-card");
    formCard.append(buildFormElement({ sectionsToRender: sections }));

    if (previewCard) {
      updateLivePreview();
      const workspace = el("div", "sponsor-doc-workspace");
      workspace.dataset.sponsorWorkspace = "";
      workspace.append(formCard, previewCard);
      root.append(workspace);
    } else {
      root.append(formCard);
    }

    // 3. Read-only Markdown Export card
    if (doc.markdownExport) {
      root.append(renderSponsorDocExportCard({
        el,
        markdownExport: doc.markdownExport,
        onCopy: () => copyText(doc.markdownExport, "Copied Markdown export to clipboard."),
      }));
    }
  }

  function render() {
    unbindCode?.();
    unbindCode = null;
    root.classList.remove("sponsor-doc-shell--with-preview");
    root.replaceChildren();
    updateIdentityBar();

    if (phase === "loading" || phase === "notfound") {
      root.append(renderSponsorDocPhaseCard(el, phase));
      return;
    }

    if (phase === "gate") {
      renderGate();
      return;
    }

    if (phase === "editor" && doc) {
      renderEditor();
      // Edits applied through a re-render (e.g. timezone) are saved too.
      autosave.schedule();
    }
  }

  async function start() {
    autosave.attach(documentRef);
    const url = new URL(locationRef.href);
    const extracted = extractDocId(url.pathname);
    docId = extracted.id;
    docPathPrefix = SPONSOR_DOC_PATH_PREFIXES.includes(extracted.prefix) ? extracted.prefix : "/sponsor-docs";
    const route = parseInitialPodcastRoute(url);
    questionsOnly = route.initialView === "questions";
    activePodcastTab = route.activeTab;
    podcastInternalMode = route.internalMode;
    podcastInternalModeTouched = route.touched;
    const queryCode = url.searchParams.get("code");
    if (queryCode !== null) {
      accessCode = formatUserCode(queryCode);
      saveStoredCode(docId, accessCode);
      historyRef.replaceState(null, "", buildStrippedCodePath(docPathPrefix, docId, route.initialTab, route.initialView));
    } else {
      accessCode = readStoredCode(docId);
    }
    if (!docId) {
      phase = "notfound";
      render();
      return;
    }
    await loadDoc();
  }

  function destroy() {
    autosave.clearTimer();
    unbindCode?.();
    unbindCode = null;
  }

  return { start, destroy };
}
