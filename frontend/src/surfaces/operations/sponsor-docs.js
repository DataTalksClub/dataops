import { formatUserCode } from "../../dakit/device-code.js";
import { renderSponsorDocGate } from "./sponsor-doc-gate.js";
import { appendSponsorDocRadioField } from "./sponsor-doc-radio.js";
import { appendSponsorDocSelectField } from "./sponsor-doc-select.js";
import { parseSponsorBulletItems, serializeSponsorBulletItems } from "./sponsor-doc-bullets.js";
export { parseSponsorBulletItems, serializeSponsorBulletItems };

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

export const SPONSOR_DOC_PATH_PREFIXES = ["/webinar-docs", "/podcast-docs", "/guest-docs", "/sponsor-docs"];

function extractDocId(pathname) {
  const match = /^\/(sponsor-docs|podcast-docs|guest-docs|webinar-docs)\/([^/?#]+)/.exec(String(pathname || ""));
  if (!match) return { id: "", prefix: "/sponsor-docs" };
  return { id: decodeURIComponent(match[2]), prefix: `/${match[1]}` };
}

/** Podcast guest form reads as guest materials everywhere, never sponsor. */
function isPodcastGuestDoc(doc) {
  return String(doc?.template || doc?.templateDefinition?.key || "") === "podcast"
    || String(doc?.templateDefinition?.key || "") === "podcast";
}

function guestRoleLabel(doc) {
  if (doc?.template === "webinar") return "speaker";
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
        identity.append(el("span", "", `${doc.template === "webinar" ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"} access · Code verified`));
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
    busy = true;
    feedbackMsg = "";
    render();
    try {
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      const body = { content: { ...draftContent } };
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
    const formTitle = doc.title || (doc.template === "webinar" ? "Speaker Materials" : isPodcastGuestDoc(doc) ? "Guest Materials" : "Sponsorship Document");
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
    if (doc.publicationDate) metaRow.append(el("span", "", `Publication date: ${doc.publicationDate}`));
    if (doc.sponsorName) metaRow.append(el("span", "", `${doc.template === "webinar" ? "Speaker" : isPodcastGuestDoc(doc) ? "Guest" : "Sponsor"}: ${doc.sponsorName}`));
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
        el("strong", "", doc.template === "webinar" ? "Shareable speaker link (includes access code): " : "Shareable sponsor link (includes access code): "),
        el("code", "dk-mono", doc.shareUrl || doc.docUrl || ""),
      );
      topRow.append(shareInfo);

      const smBtn = "dk-button dk-button--secondary dk-button--sm";
      const btnRow = el("div", "sponsor-doc-actions__buttons");
      if (doc.shareUrl) {
        btnRow.append(
          actionBtn(smBtn, "Copy share link", "copy-share-url", () =>
            copyText(doc.shareUrl, doc.template === "webinar" ? "Copied shareable speaker link with access code." : "Copied shareable sponsor link with access code."),
          ),
        );
      }
      if (doc.emailDraft?.body) {
        btnRow.append(
          actionBtn(smBtn, doc.template === "webinar" ? "Copy invitation email" : "Copy sponsor email", "copy-email", () =>
            copyText(
              `Subject: ${doc.emailDraft.subject}\n\n${doc.emailDraft.body}`,
              doc.template === "webinar" ? "Copied invitation email draft." : "Copied ready-to-send sponsor email draft.",
            ),
          ),
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

    const updateLivePreview = () => {
      if (!previewCard) return;
      previewCard.replaceChildren();

      const head = el("div", "sponsor-doc-preview__head");
      const headRow = el("div", "sponsor-doc-title-row");
      headRow.append(el("h2", "sponsor-doc-section__title", "Live Preview"));
      const slotLabel = doc.template === "newsletter-standalone"
        ? "Stand-Alone Blast"
        : doc.template === "newsletter-secondary" ? "Secondary Slot" : "Main Sponsor Block";
      const slotBadge = el("span", "dk-badge", slotLabel);
      slotBadge.dataset.sponsorPreviewSlot = doc.template || "newsletter-main";
      headRow.append(slotBadge);
      const hintText =
        "Updates live as you type and upload your visual so the final email block look is clear before submitting.";
      head.append(headRow, el("p", "dk-hint", hintText));
      previewCard.append(head);

      const val = (key) => String(draftContent[key] || "").trim();
      const previewEl = (tag, baseClass, text, placeholder, dataAttr) => {
        const node = el(tag, text ? baseClass : `${baseClass} is-placeholder`, text || placeholder);
        node.dataset[dataAttr] = "";
        return node;
      };
      const appendCtaPreview = (parent, textVal, urlVal, fallbackLabel, wrapAttr, linkAttr, urlAttr) => {
        const wrap = el("div", "sponsor-preview-canvas__cta");
        wrap.dataset[wrapAttr] = "";
        const btn = previewEl("a", "sponsor-preview-canvas__cta-btn", textVal, fallbackLabel, linkAttr);
        btn.href = safePreviewHref(urlVal);
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
        const urlSpan = el("span", "sponsor-preview-canvas__cta-url", urlVal || "https://...");
        if (urlAttr) urlSpan.dataset[urlAttr] = "";
        wrap.append(btn, urlSpan);
        parent.append(wrap);
      };

      const showEnvelope =
        doc.template === "newsletter-main"
        || doc.template === "newsletter-standalone"
        || hasField("subjectLine")
        || hasField("previewText");
      if (showEnvelope) {
        const env = el("div", "sponsor-preview-envelope");
        env.dataset.sponsorPreviewEnvelope = "";
        const rawSubj = val("subjectLine");
        const subjDisplay = doc.template === "newsletter-main"
          ? `${rawSubj || "[Your subject line]"} | DataTalks.Club Weekly`
          : (rawSubj || "[Email subject line]");
        const subjRow = el("div", "sponsor-preview-envelope__row");
        const envValClass = "sponsor-preview-envelope__value";
        const subjValEl = previewEl("span", envValClass, rawSubj ? subjDisplay : "", subjDisplay, "sponsorPreviewSubject");
        subjRow.append(el("span", "sponsor-preview-envelope__label", "Subject"), subjValEl);
        const preRow = el("div", "sponsor-preview-envelope__row");
        const preValEl = previewEl("span", envValClass, val("previewText"), "[Inbox preview text]", "sponsorPreviewPreheader");
        preRow.append(el("span", "sponsor-preview-envelope__label", "Preview"), preValEl);
        env.append(subjRow, preRow);
        previewCard.append(env);
      }

      const canvas = el("article", "sponsor-preview-canvas");
      canvas.dataset.sponsorPreviewCanvas = "";
      const kickerDate = doc.publicationDate ? ` · ${doc.publicationDate}` : "";
      canvas.append(
        el("div", "sponsor-preview-canvas__kicker", `Sponsored · ${doc.sponsorName || "Your Company"}${kickerDate}`),
      );

      const titleVal = val("title") || val("headline");
      canvas.append(
        previewEl("h3", "sponsor-preview-canvas__title", titleVal, "Headline for your sponsored section", "sponsorPreviewTitle"),
      );

      const visualWrap = el("div", "sponsor-preview-canvas__visual");
      visualWrap.dataset.sponsorPreviewVisual = "";
      const visualVal = val("graphicsUrl") || val("imageUrl");
      if (/^(?:data:image\/|https?:\/\/|\/|blob:)/i.test(visualVal)) {
        const figure = el("figure", "sponsor-preview-figure");
        const img = el("img", "sponsor-preview-figure__img");
        img.dataset.sponsorPreviewImage = "";
        img.src = visualVal;
        img.alt = titleVal || doc.sponsorName || "Sponsor visual";
        figure.append(img);
        if (uploadedVisualName || /^data:image\//i.test(visualVal)) {
          const capText = uploadedVisualName ? `Uploaded visual: ${uploadedVisualName}` : "Uploaded visual";
          const caption = el("figcaption", "sponsor-preview-figure__caption", capText);
          caption.dataset.sponsorPreviewVisualCaption = "";
          figure.append(caption);
        }
        visualWrap.append(figure);
      } else if (visualVal) {
        const noteBox = el("div", "sponsor-preview-visual-placeholder", `Visual note: ${visualVal}`);
        noteBox.dataset.sponsorPreviewVisualNote = "";
        visualWrap.append(noteBox);
      } else {
        const phText = "Visual placement — upload an image or paste an image URL to preview it here.";
        const ph = el("div", "sponsor-preview-visual-placeholder is-placeholder", phText);
        ph.dataset.sponsorPreviewVisualPlaceholder = "";
        visualWrap.append(ph);
      }
      canvas.append(visualWrap);

      const pClass = "sponsor-preview-canvas__paragraph";
      const introFallback = "1–2 sentences introducing the problem, product, or resource.";
      canvas.append(previewEl("p", pClass, val("intro") || val("body"), introFallback, "sponsorPreviewIntro"));

      if (doc.template === "newsletter-standalone" || hasField("earlyCtaText") || hasField("earlyCtaUrl")) {
        appendCtaPreview(
          canvas, val("earlyCtaText"), val("earlyCtaUrl"), "Early CTA Button",
          "sponsorPreviewEarlyCta", "sponsorPreviewEarlyCtaLink", "",
        );
      }
      if (doc.template === "newsletter-standalone" || hasField("mainBodyOpening")) {
        const openingFallback = "1–2 sentences introducing the session, product, or key story before the bullet list.";
        canvas.append(previewEl("p", pClass, val("mainBodyOpening"), openingFallback, "sponsorPreviewOpening"));
      }
      if (hasField("bullets") || Boolean(draftContent.bullets) || isNewsletterTemplate(doc.template, tDef)) {
        const ul = el("ul", "sponsor-preview-canvas__bullets");
        ul.dataset.sponsorPreviewBullets = "";
        const parsedBullets = parseSponsorBulletItems(draftContent.bullets, 0).filter((item) => item.trim().length > 0);
        if (parsedBullets.length > 0) {
          for (const bulletText of parsedBullets) {
            const li = el("li", "", bulletText);
            li.dataset.sponsorPreviewBullet = "";
            ul.append(li);
          }
        } else {
          for (let i = 1; i <= 3; i += 1) {
            const li = el("li", "is-placeholder", `Bullet point ${i}`);
            li.dataset.sponsorPreviewBulletPlaceholder = String(i);
            ul.append(li);
          }
        }
        canvas.append(ul);
      }
      if (hasField("closing") || Boolean(draftContent.closing) || isNewsletterTemplate(doc.template, tDef)) {
        const closingFallback = "Closing sentence leading into the call-to-action.";
        canvas.append(previewEl("p", pClass, val("closing"), closingFallback, "sponsorPreviewClosing"));
      }

      const isStandalone = doc.template === "newsletter-standalone" || hasField("closingCtaText");
      appendCtaPreview(
        canvas,
        isStandalone ? val("closingCtaText") : val("ctaText"),
        isStandalone ? val("closingCtaUrl") : val("ctaUrl"),
        isStandalone ? "Closing CTA Button" : "Call to Action",
        "sponsorPreviewCta", "sponsorPreviewCtaLink", "sponsorPreviewCtaUrl",
      );
      previewCard.append(canvas);

      const linkedinVal = val("linkedinPost");
      const twitterVal = val("twitterPost");
      if (linkedinVal || twitterVal) {
        const socialWrap = el("div", "sponsor-preview-social");
        socialWrap.dataset.sponsorPreviewSocial = "";
        socialWrap.append(el("h3", "sponsor-doc-field__label", "Social Media Preview"));
        const socialEntries = [
          [linkedinVal, "LinkedIn", "sponsorPreviewLinkedin"],
          [twitterVal, "X (Twitter)", "sponsorPreviewTwitter"],
        ];
        for (const [postVal, labelText, attr] of socialEntries) {
          if (!postVal) continue;
          const card = el("div", "sponsor-preview-social__card");
          card.dataset[attr] = "";
          card.append(el("span", "sponsor-preview-envelope__label", labelText), el("p", "sponsor-preview-social__text", postVal));
          socialWrap.append(card);
        }
        previewCard.append(socialWrap);
      }
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

      for (const fieldDef of sectionDef.fields || []) {
        const fieldWrap = el("div", "sponsor-doc-field");
        fieldWrap.dataset.sponsorFieldGroup = fieldDef.key;
        const top = el("div", "sponsor-doc-field__top");
        const label = el("label", "sponsor-doc-field__label", `${fieldDef.label}${fieldDef.required ? " *" : ""}`);
        const inputId = `sponsor-field-${fieldDef.key}`;
        label.setAttribute("for", inputId);

        const maxChars = fieldDef.maxCharsHint || fieldDef.maxChars || 0;
        const maxWords = fieldDef.maxWordsHint || 0;
        const countEl = el("span", "sponsor-doc-field__count");
        const currentVal = String(draftContent[fieldDef.key] ?? "");

        if (fieldDef.type === "bullets" || fieldDef.key === "bullets") {
          const minItems = fieldDef.minItems || 3;
          const maxItems = fieldDef.maxItems || 6;
          const marker = fieldDef.bulletMarker || "•";
          const basePlaceholder = (fieldDef.placeholder || "Bullet point")
            .split("\n")[0]
            .replace(/^(?:[-*•→🔸▪▸]|\d+[.)])\s*/, "")
            .replace(/\s+\d+$/, "")
            .trim() || "Bullet point";

          const bulletItems = parseSponsorBulletItems(currentVal, minItems);
          const updateBulletsCount = () => {
            const filled = bulletItems.filter((item) => item.trim().length > 0).length;
            countEl.textContent = `${filled} / ${minItems} bullets`;
            countEl.classList.toggle("is-over", filled > maxItems);
          };

          label.setAttribute("for", `${inputId}-0`);
          updateBulletsCount();
          top.append(label, countEl);

          const bulletsContainer = el("div", "sponsor-doc-bullets");
          bulletsContainer.id = inputId;
          bulletsContainer.dataset.sponsorField = fieldDef.key;
          bulletsContainer.dataset.sponsorBullets = fieldDef.key;

          const bulletList = el("div", "sponsor-doc-bullets__list");
          bulletList.dataset.sponsorBulletList = "";
          const actionsRow = el("div", "sponsor-doc-bullets__actions");
          const addBulletBtn = actionBtn("dk-button dk-button--secondary dk-button--sm", "+ Add bullet", "add-bullet", () => {
            if (bulletItems.length >= maxItems) return;
            bulletItems.push("");
            renderBulletRows(bulletItems.length - 1);
            syncBulletsState();
          });
          addBulletBtn.id = "add-sponsor-bullet";

          function syncBulletsState() {
            draftContent[fieldDef.key] = serializeSponsorBulletItems(bulletItems);
            updateBulletsCount();
            addBulletBtn.disabled = busy || bulletItems.length >= maxItems;
            updateLivePreview();
          }

          function renderBulletRows(focusIndex = null) {
            bulletList.replaceChildren();
            bulletItems.forEach((itemVal, idx) => {
              const row = el("div", "sponsor-doc-bullets__row");
              row.dataset.sponsorBulletRow = String(idx);
              const markerSpan = el("span", "sponsor-doc-bullets__marker", marker);
              markerSpan.setAttribute("aria-hidden", "true");

              const bulletInput = el("input", "dk-input sponsor-doc-bullets__input");
              bulletInput.type = "text";
              bulletInput.id = `${inputId}-${idx}`;
              bulletInput.name = `${fieldDef.key}[]`;
              bulletInput.dataset.sponsorBulletInput = String(idx);
              bulletInput.placeholder = `${basePlaceholder} ${idx + 1}`;
              bulletInput.value = itemVal;
              bulletInput.disabled = busy;
              if (fieldDef.required && idx < minItems) bulletInput.setAttribute("aria-required", "true");
              bulletInput.addEventListener("input", () => {
                const rawInput = String(bulletInput.value || "");
                if (rawInput.includes("\n")) {
                  const splitLines = rawInput.replace(/\r\n/g, "\n").split("\n").map((l) => stripBulletPrefix(l)).filter(Boolean);
                  if (splitLines.length > 0) {
                    bulletItems[idx] = splitLines[0];
                    for (let s = 1; s < splitLines.length; s += 1) {
                      const targetIdx = idx + s;
                      if (targetIdx < bulletItems.length && !bulletItems[targetIdx]) bulletItems[targetIdx] = splitLines[s];
                      else if (bulletItems.length < maxItems) bulletItems.splice(Math.min(targetIdx, bulletItems.length), 0, splitLines[s]);
                    }
                    renderBulletRows(Math.min(idx + splitLines.length - 1, bulletItems.length - 1));
                    syncBulletsState();
                    return;
                  }
                }
                bulletItems[idx] = rawInput;
                syncBulletsState();
              });

              const removeClass = "dk-button dk-button--secondary dk-button--sm sponsor-doc-bullets__remove";
              const removeBtn = actionBtn(
                removeClass,
                "Remove",
                "remove-bullet",
                () => {
                  if (bulletItems.length > 1) bulletItems.splice(idx, 1);
                  else bulletItems[0] = "";
                  renderBulletRows(Math.max(0, Math.min(idx, bulletItems.length - 1)));
                  syncBulletsState();
                },
                busy || (bulletItems.length <= 1 && !bulletItems[0]),
              );
              removeBtn.dataset.sponsorBulletRemove = String(idx);
              removeBtn.setAttribute("aria-label", `Remove bullet ${idx + 1}`);

              row.append(markerSpan, bulletInput, removeBtn);
              bulletList.append(row);
              if (focusIndex === idx) bulletInput.focus?.();
            });
            addBulletBtn.disabled = busy || bulletItems.length >= maxItems;
          }

          renderBulletRows();
          actionsRow.append(addBulletBtn);
          bulletsContainer.append(bulletList, actionsRow);
          fieldWrap.append(top, bulletsContainer);
          if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
          sectionWrap.append(fieldWrap);
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
          sectionWrap.append(fieldWrap);
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
          sectionWrap.append(fieldWrap);
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
        if (fieldDef.required) control.setAttribute("aria-required", "true");
        if (fieldDef.format === "url") control.type = "url";
        control.addEventListener("input", () => {
          uploadedVisualName = "";
          draftContent[fieldDef.key] = control.value;
          updateCount(control.value);
          updateLivePreview();
        });
        fieldWrap.append(top, control);

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

        if (fieldDef.helpText) fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
        sectionWrap.append(fieldWrap);
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
