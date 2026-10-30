import { formatUserCode } from "../../dakit/device-code.js";
import { renderSponsorDocGate } from "./sponsor-doc-gate.js";
import { appendSponsorDocRadioField } from "./sponsor-doc-radio.js";
import { appendSponsorDocSelectField } from "./sponsor-doc-select.js";
import {
  appendSponsorDocBulletsField,
  parseSponsorBulletItems,
  serializeSponsorBulletItems,
} from "./sponsor-doc-bullets.js";
import {
  DEFAULT_NEWSLETTER_UTM_MEDIUM,
  DEFAULT_NEWSLETTER_UTM_SOURCE,
  attachSoftUtmSuggestion,
  buildSuggestedUtmUrl,
  hasUtmParams,
  isEmailPieceSection,
  mountNewsletterEmailPieceSection,
  needsNewsletterUtmSuggestion,
  renderNewsletterLivePreview,
  validateSponsorDocDraft,
} from "./sponsor-doc-email-card.js";

export {
  DEFAULT_NEWSLETTER_UTM_MEDIUM,
  DEFAULT_NEWSLETTER_UTM_SOURCE,
  buildSuggestedUtmUrl,
  hasUtmParams,
  needsNewsletterUtmSuggestion,
  parseSponsorBulletItems,
  serializeSponsorBulletItems,
};

export const SPONSOR_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const SPONSOR_CODE_LENGTH = 16;

function bytesToDataUrl(bytes, mimeType = "image/png") {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const base64 = typeof globalThis.btoa === "function"
    ? globalThis.btoa(binary)
    : globalThis.Buffer ? globalThis.Buffer.from(bytes).toString("base64") : "";
  return `data:${mimeType || "image/png"};base64,${base64}`;
}

export async function readVisualFileAsDataUrl(file) {
  if (!file) return "";
  if (typeof file.dataUrl === "string" && file.dataUrl) return file.dataUrl;
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    return bytesToDataUrl(new Uint8Array(buffer), file.type || "image/png");
  }
  if (typeof globalThis.FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new globalThis.FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.readAsDataURL(file);
    });
  }
  return "";
}

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
  return String(doc?.template || doc?.templateDefinition?.key || "") === "podcast"
    || String(doc?.templateDefinition?.key || "") === "podcast";
}

/** Webinar and workshop forms are filled by the speaker. */
const isSpeakerDoc = (doc) => doc?.template === "webinar" || doc?.template === "workshop";

function guestRoleLabel(doc) {
  if (isSpeakerDoc(doc)) return "speaker";
  return isPodcastGuestDoc(doc) ? "guest" : "sponsor";
}

function formatEditedTimestamp(iso) {
  return iso ? `${String(iso).slice(0, 16).replace("T", " ")} UTC` : "";
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
      if (accessCode) saveStoredCode(docId, accessCode);
      gateError = "";
      phase = "editor";
      render();
    } catch (err) {
      if (err.status === 404) {
        phase = "notfound";
      } else if (err.status === 429) {
        phase = "gate";
        gateError = `Too many failed access code attempts. Please wait ${err.retryAfter || 60} seconds and try again.`;
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

  async function saveChanges(nextStatus) {
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
      const derivedKeys = new Set((doc.templateDefinition?.sections || []).flatMap(section =>
        (section.fields || []).filter(field => field.derived).map(field => field.key)));
      const body = { content: Object.fromEntries(Object.entries(draftContent).filter(([key]) => !derivedKeys.has(key))) };
      if (nextStatus) body.status = nextStatus;
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      doc = payload.doc;
      draftContent = { ...(doc.content || {}) };
      busy = false;
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
    } catch (err) {
      busy = false;
      if (err.fields && typeof err.fields === "object") {
        fieldErrors = { ...err.fields };
      }
      feedbackMsg = err.message || "Failed to save changes.";
      feedbackTone = "danger";
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
      feedbackMsg = "Rotated access code. Previous sponsor links with the old code are now invalid.";
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
      feedbackMsg = err.message || "Could not send sponsor email.";
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

    const metaRow = el("div", "sponsor-doc-meta");
    metaRow.append(el("span", "dk-badge", tDef.label || doc.template));
    if (doc.eventMetadata) {
      const eventLabel = el("span", "", doc.eventMetadata.label);
      eventLabel.dataset.sponsorDocEvent = "";
      metaRow.append(eventLabel);
    }
    if (doc.publicationDate) metaRow.append(el("span", "", `Publication date: ${doc.publicationDate}`));
    if (doc.sponsorName) metaRow.append(el("span", "", `${isSpeakerDoc(doc) ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"}: ${doc.sponsorName}`));
    const editedSpan = el("span", "", formatEditorLabel(doc));
    editedSpan.dataset.sponsorDocLastEdited = "";
    metaRow.append(editedSpan);
    headWrap.append(titleRow, metaRow);
    headerCard.append(headWrap);

    if (doc.viewerRole === "staff") {
      const staffBar = el("div", "sponsor-doc-staff-bar");
      staffBar.dataset.sponsorStaffBar = "";
      const topRow = el("div", "sponsor-doc-staff-bar__row");
      const shareInfo = el("div", "");
      shareInfo.append(
        el("strong", "", isSpeakerDoc(doc) ? "Shareable speaker link (includes access code): " : "Shareable sponsor link (includes access code): "),
        el("code", "dk-mono", doc.shareUrl || doc.docUrl || ""),
      );
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
      if (doc.shareUrl) {
        btnRow.append(
          actionBtn(smBtn, "Copy share link", "copy-share-url", () =>
            copyText(doc.shareUrl, isSpeakerDoc(doc) ? "Copied shareable speaker link with access code." : "Copied shareable sponsor link with access code."),
          ),
        );
      }
      if (doc.emailDraft?.body) {
        btnRow.append(
          actionBtn(smBtn, isSpeakerDoc(doc) ? "Copy invitation email" : "Copy sponsor email", "copy-email", () =>
            copyText(
              `Subject: ${doc.emailDraft.subject}\n\n${doc.emailDraft.body}`,
              isSpeakerDoc(doc) ? "Copied invitation email draft." : "Copied ready-to-send sponsor email draft.",
            ),
          ),
        );
      }
      if (!isSpeakerDoc(doc) && !isPodcastGuestDoc(doc)) {
        btnRow.append(
          actionBtn(smBtn, "Send from orin@datatalks.club", "send-sponsor-email", () => sendSponsorEmailFromOrin(), busy),
        );
      }
      btnRow.append(actionBtn(smBtn, "Rotate code", "rotate-code", () => rotateStaffCode(), busy));
      if (doc.cardId) {
        const cardLink = el("a", smBtn, "Open Card");
        cardLink.href = `/cards?cardId=${encodeURIComponent(doc.cardId)}`;
        btnRow.append(cardLink);
      }
      staffBar.append(topRow, btnRow);
      headerCard.append(staffBar);
    }

    if (tDef.intro || tDef.guidelinesUrl || (Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0)) {
      const callout = el("div", "dk-callout");
      const body = el("div", "dk-callout__body");
      if (tDef.intro) body.append(el("p", "", tDef.intro));
      if (tDef.guidelinesUrl) {
        const guideP = el("p", "");
        const guideLink = el("a", "", "View visual placement guide →");
        guideLink.href = tDef.guidelinesUrl;
        guideLink.target = "_blank";
        guideLink.rel = "noopener noreferrer";
        guideP.append(guideLink);
        body.append(guideP);
      }
      if (Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0) {
        const ul = el("ul", "sponsor-doc-guidelines");
        for (const item of tDef.guidelines) ul.append(el("li", "", item));
        body.append(ul);
      }
      callout.append(body);
      headerCard.append(callout);
    }

    root.append(headerCard);

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
    const updateLivePreview = () => {
      for (const fn of previewSyncListeners) fn();
      renderNewsletterLivePreview({
        el,
        previewCard,
        doc,
        tDef,
        draftContent,
        hasField,
        uploadedVisualName,
        safePreviewHref,
      });
    };

    const formCard = el("div", "sponsor-doc-card sponsor-doc-form-card");
    const form = el("form", "sponsor-doc-form");
    form.noValidate = true;

    for (const sectionDef of sections) {
      const collapsible = Boolean(sectionDef.collapsible);
      const sectionWrap = collapsible
        ? el("details", "sponsor-doc-section sponsor-doc-details")
        : el("div", "sponsor-doc-section");
      if (collapsible) {
        sectionWrap.dataset.sponsorCollapsible = sectionDef.id;
        const filled = (sectionDef.fields || []).some(
          (field) => String(draftContent[field.key] ?? "").trim().length > 0,
        );
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
      if (sectionDef.description) sectionWrap.append(el("p", "dk-hint", sectionDef.description));

      const useEmailCard = isEmailPieceSection(doc, tDef, sectionDef);
      const fieldNodesByKey = new Map();
      const appendFieldNode = (key, node) => {
        if (useEmailCard) fieldNodesByKey.set(key, node);
        else sectionWrap.append(node);
      };

      for (const fieldDef of sectionDef.fields || []) {
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
          sectionWrap.append(fieldWrap);
          continue;
        }

        if (fieldDef.type === "bullets" || fieldDef.key === "bullets") {
          appendSponsorDocBulletsField({
            el,
            actionBtn,
            fieldWrap,
            fieldDef,
            inputId,
            currentVal,
            busy,
            draftContent,
            updateLivePreview,
            top,
            label,
            countEl,
          });
          appendErrorIfAny();
          appendFieldNode(fieldDef.key, fieldWrap);
          continue;
        }

        const isVisualField = fieldDef.key === "graphicsUrl" || Boolean(fieldDef.allowVisualUpload);
        const updateCount = (valText) => {
          const text = String(valText || "");
          if (isVisualField && /^data:image\//i.test(text)) {
            countEl.textContent = uploadedVisualName ? `Uploaded (${uploadedVisualName})` : "Uploaded image";
            countEl.classList.remove("is-over");
            return;
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
        };

        updateCount(currentVal);
        top.append(label, countEl);

        if (fieldDef.type === "radio") {
          appendSponsorDocRadioField({
            el,
            fieldWrap,
            fieldDef,
            inputId,
            currentVal,
            busy,
            draftContent,
            updateLivePreview,
            top,
          });
          appendErrorIfAny();
          appendFieldNode(fieldDef.key, fieldWrap);
          continue;
        }

        if (fieldDef.type === "select") {
          appendSponsorDocSelectField({
            el,
            fieldWrap,
            fieldDef,
            inputId,
            currentVal,
            busy,
            draftContent,
            updateCount,
            updateLivePreview,
            top,
          });
          appendErrorIfAny();
          appendFieldNode(fieldDef.key, fieldWrap);
          continue;
        }

        const isMultiline = fieldDef.type === "textarea" || Boolean(fieldDef.multiline);
        const control = isMultiline ? el("textarea", "sponsor-doc-textarea") : el("input", "dk-input");
        if (isMultiline) control.rows = fieldDef.rows || 5;
        else control.type = "text";
        control.id = inputId;
        control.dataset.sponsorField = fieldDef.key;
        const isDataVisual = isVisualField && /^data:image\//i.test(currentVal);
        const attachedPh = "Uploaded visual attached — or paste an https:// link to replace";
        control.placeholder = isDataVisual ? attachedPh : (fieldDef.placeholder || "");
        control.value = isDataVisual ? "" : currentVal;
        control.disabled = busy;
        if (fieldDef.required) {
          control.required = true;
          control.setAttribute("aria-required", "true");
        }
        if (fieldErrors[fieldDef.key]) {
          control.setAttribute("aria-invalid", "true");
        }
        if (fieldDef.format === "url") control.type = "url";
        fieldWrap.append(top, control);

        const syncUtmSuggestion = attachSoftUtmSuggestion({
          el,
          actionBtn,
          fieldWrap,
          fieldDef,
          control,
          draftContent,
          publicationDate: doc.publicationDate,
          updateCount,
          updateLivePreview,
          announce,
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
          updateLivePreview();
        });

        if (isVisualField) {
          const visualControls = el("div", "sponsor-doc-visual-upload");
          visualControls.dataset.sponsorVisualControls = fieldDef.key;
          const fileInputId = `sponsor-visual-file-${fieldDef.key}`;
          const uploadClass = "dk-button dk-button--secondary dk-button--sm sponsor-doc-visual-upload__label";
          const uploadLabel = el("label", uploadClass, "Upload visual");
          uploadLabel.setAttribute("for", fileInputId);
          const fileInput = el("input", "sponsor-doc-visual-upload__input");
          fileInput.type = "file";
          fileInput.id = fileInputId;
          fileInput.accept = "image/*";
          fileInput.dataset.sponsorVisualUpload = fieldDef.key;
          fileInput.disabled = busy;
          const statusSpan = el("span", "sponsor-doc-visual-upload__status");
          statusSpan.dataset.sponsorVisualStatus = "";
          const clearBtn = actionBtn("dk-button dk-button--secondary dk-button--sm", "Remove visual", "clear-visual", () => {
            uploadedVisualName = "";
            draftContent[fieldDef.key] = "";
            control.value = "";
            control.placeholder = fieldDef.placeholder || "";
            fileInput.value = "";
            updateCount("");
            syncVisualControls();
            updateLivePreview();
          });

          function syncVisualControls() {
            const v = String(draftContent[fieldDef.key] || "").trim();
            if (/^data:image\//i.test(v)) {
              statusSpan.textContent = uploadedVisualName
                ? `Uploaded visual: ${uploadedVisualName}`
                : "Uploaded visual attached";
              clearBtn.hidden = false;
            } else if (v) {
              statusSpan.textContent = "Using linked image URL";
              clearBtn.hidden = false;
            } else {
              statusSpan.textContent = "Upload PNG, JPG, WebP, or GIF to preview right away";
              clearBtn.hidden = true;
            }
          }

          fileInput.addEventListener("change", async (event) => {
            const file = fileInput.files?.[0] || event?.target?.files?.[0] || event?.detail?.file;
            if (!file) return;
            const dataUrl = await readVisualFileAsDataUrl(file);
            if (!dataUrl) return;
            uploadedVisualName = file.name || "uploaded-visual.png";
            draftContent[fieldDef.key] = dataUrl;
            control.value = "";
            control.placeholder = attachedPh;
            updateCount(dataUrl);
            syncVisualControls();
            updateLivePreview();
            announce(`Uploaded visual ${uploadedVisualName} for live preview.`);
          });
          control.addEventListener("input", () => syncVisualControls());
          syncVisualControls();
          visualControls.append(uploadLabel, fileInput, statusSpan, clearBtn);
          fieldWrap.append(visualControls);
        }

        appendErrorIfAny();
        if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
        appendFieldNode(fieldDef.key, fieldWrap);
      }

      if (useEmailCard) {
        const syncEditorCta = mountNewsletterEmailPieceSection({
          el,
          doc,
          sectionWrap,
          sectionDef,
          fieldNodesByKey,
          draftContent,
          safePreviewHref,
        });
        previewSyncListeners.push(syncEditorCta);
      }
      form.append(sectionWrap);
    }

    if (feedbackMsg) {
      const fb = el("div", `dk-callout dk-callout--${feedbackTone}`);
      fb.setAttribute("role", "status");
      fb.dataset.sponsorFeedback = "";
      fb.append(el("div", "dk-callout__body", feedbackMsg));
      form.append(fb);
    }

    const actionsBar = el("div", "sponsor-doc-actions");
    const leftBtns = el("div", "sponsor-doc-actions__buttons");
    const rightBtns = el("div", "sponsor-doc-actions__buttons");
    const draftLabel = busy ? "Saving…" : isSubmitted ? "Save changes" : "Save draft";
    leftBtns.append(actionBtn("dk-button dk-button--secondary", draftLabel, "save-draft", () => saveChanges(undefined), busy));

    if (isSubmitted) {
      rightBtns.append(actionBtn("dk-button dk-button--secondary", "Reopen as Draft", "reopen-draft", () => saveChanges("draft"), busy));
    } else {
      const submitLabel = busy ? "Submitting…" : "Mark as Submitted / Ready";
      rightBtns.append(actionBtn("dk-button dk-button--primary", submitLabel, "submit-ready", () => saveChanges("submitted"), busy));
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveChanges(undefined);
    });

    actionsBar.append(leftBtns, rightBtns);
    form.append(actionsBar);
    formCard.append(form);

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
      const exportCard = el("div", "sponsor-doc-card");
      exportCard.dataset.sponsorExport = "";
      const expTop = el("div", "sponsor-doc-title-row");
      expTop.append(el("h2", "sponsor-doc-field__label", "Read-only Markdown export"));
      const copyExportBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy Markdown");
      copyExportBtn.type = "button";
      copyExportBtn.dataset.sponsorAction = "copy-export";
      copyExportBtn.addEventListener("click", () =>
        copyText(doc.markdownExport, "Copied Markdown export to clipboard."),
      );
      expTop.append(copyExportBtn);
      exportCard.append(expTop, el("pre", "sponsor-doc-export-pre", doc.markdownExport));
      root.append(exportCard);
    }
  }

  function render() {
    unbindCode?.();
    unbindCode = null;
    root.classList.remove("sponsor-doc-shell--with-preview");
    root.replaceChildren();
    updateIdentityBar();

    if (phase === "loading") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.append(el("p", "dk-auth-card__lede", "Loading document…"));
      root.append(card);
      return;
    }

    if (phase === "notfound") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.dataset.sponsorView = "notfound";
      const head = el("header", "dk-auth-card__head");
      head.append(
        el("h1", "dk-auth-card__title", "Document not found"),
        el("p", "dk-auth-card__lede", "Check that you opened the full link from your DataTalks.Club email."),
      );
      card.append(head);
      root.append(card);
      return;
    }

    if (phase === "gate") {
      renderGate();
      return;
    }

    if (phase === "editor" && doc) renderEditor();
  }

  async function start() {
    const url = new URL(locationRef.href);
    const extracted = extractDocId(url.pathname);
    docId = extracted.id;
    docPathPrefix = SPONSOR_DOC_PATH_PREFIXES.includes(extracted.prefix) ? extracted.prefix : "/sponsor-docs";
    const queryCode = url.searchParams.get("code");
    if (queryCode !== null) {
      accessCode = formatUserCode(queryCode);
      saveStoredCode(docId, accessCode);
      historyRef.replaceState(null, "", `${docPathPrefix}/${encodeURIComponent(docId)}`);
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
    unbindCode?.();
    unbindCode = null;
  }

  return { start, destroy };
}
