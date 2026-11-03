import { parseSponsorBulletItems } from "./sponsor-doc-bullets.js";

export const DEFAULT_NEWSLETTER_UTM_SOURCE = "datatalksclub-newsletter";
export const DEFAULT_NEWSLETTER_UTM_MEDIUM = "newsletter";
export const MAX_X_POST_CHARS = 280;

function extractSponsorSocialFields(content = {}, options = {}) {
  const headline = String(content?.title || content?.headline || "").trim();
  const intro = String(content?.intro || content?.body || "").trim();
  const opening = String(content?.mainBodyOpening || "").trim();
  const bullets = parseSponsorBulletItems(content?.bullets, 0)
    .map((item) => item.trim())
    .filter(Boolean);
  const closing = String(content?.closing || "").trim();
  const ctaText = String(
    content?.closingCtaText || content?.ctaText || content?.earlyCtaText || "",
  ).trim();
  const ctaUrl = String(
    content?.closingCtaUrl || content?.ctaUrl || content?.earlyCtaUrl || "",
  ).trim();
  const sponsorName = String(options?.sponsorName || content?.sponsorName || "").trim();
  return { headline, intro, opening, bullets, closing, ctaText, ctaUrl, sponsorName };
}

function formatSponsorCtaLine(ctaText, ctaUrl) {
  if (ctaText && ctaUrl) return `👉 ${ctaText}: ${ctaUrl}`;
  if (ctaUrl) return `👉 ${ctaUrl}`;
  if (ctaText) return `👉 ${ctaText}`;
  return "";
}

export function generateSponsorLinkedinPost(content = {}, options = {}) {
  const {
    headline,
    intro,
    opening,
    bullets,
    closing,
    ctaText,
    ctaUrl,
    sponsorName,
  } = extractSponsorSocialFields(content, options);
  if (!headline && !intro && !opening && bullets.length === 0 && !closing && !ctaText && !ctaUrl) {
    return "";
  }
  const blocks = [];
  if (headline) blocks.push(headline);
  if (intro && intro !== headline) blocks.push(intro);
  if (opening && opening !== intro && opening !== headline) blocks.push(opening);
  if (bullets.length > 0) {
    blocks.push(bullets.map((item) => `🔸 ${item}`).join("\n"));
  }
  if (closing) blocks.push(closing);
  const ctaLine = formatSponsorCtaLine(ctaText, ctaUrl);
  if (ctaLine) blocks.push(ctaLine);
  if (sponsorName) {
    blocks.push(`This post is sponsored by ${sponsorName}. Thank you for supporting our community!`);
  }
  return blocks.join("\n\n");
}

function splitWordsToFit(text, maxLen) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxLen) {
        chunks.push(word.slice(i, i + maxLen));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLen) {
      current = next;
    } else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitTextToFit(text, maxLen) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitWordsToFit(sentence, maxLen));
      continue;
    }
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxLen) {
      current = next;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function packUnitsIntoXThread(units, maxChars = MAX_X_POST_CHARS) {
  const maxBodyChars = maxChars - 8;
  const expanded = [];
  for (const unit of units) {
    const text = String(unit.text || "").trim();
    if (!text) continue;
    const pieces = splitTextToFit(text, maxBodyChars);
    pieces.forEach((piece, idx) => {
      expanded.push({
        text: piece,
        isBullet: Boolean(unit.isBullet) && idx === 0,
      });
    });
  }
  if (expanded.length === 0) return [];
  const chunks = [];
  let current = "";
  let lastWasBullet = false;
  for (const item of expanded) {
    if (!current) {
      current = item.text;
      lastWasBullet = item.isBullet;
      continue;
    }
    const joiner = lastWasBullet && item.isBullet ? "\n" : "\n\n";
    const candidate = `${current}${joiner}${item.text}`;
    if (candidate.length <= maxBodyChars) {
      current = candidate;
      lastWasBullet = item.isBullet;
    } else {
      chunks.push(current);
      current = item.text;
      lastWasBullet = item.isBullet;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 1) return chunks;
  const total = chunks.length;
  return chunks.map((chunk, idx) => `${idx + 1}/${total}\n\n${chunk}`);
}

export function generateSponsorXPosts(content = {}, options = {}) {
  const {
    headline,
    intro,
    opening,
    bullets,
    closing,
    ctaText,
    ctaUrl,
  } = extractSponsorSocialFields(content, options);
  if (!headline && !intro && !opening && bullets.length === 0 && !closing && !ctaText && !ctaUrl) {
    return [];
  }
  const leadBlocks = [];
  if (headline) leadBlocks.push(headline);
  if (intro && intro !== headline) leadBlocks.push(intro);
  if (opening && opening !== intro && opening !== headline) leadBlocks.push(opening);

  const bulletLines = bullets.map((item) => `🔸 ${item}`);
  const ctaLine = formatSponsorCtaLine(ctaText, ctaUrl);

  const singleBlocks = [...leadBlocks];
  if (bulletLines.length > 0) singleBlocks.push(bulletLines.join("\n"));
  if (closing) singleBlocks.push(closing);
  if (ctaLine) singleBlocks.push(ctaLine);

  const singlePost = singleBlocks.join("\n\n");
  if (singlePost.length <= MAX_X_POST_CHARS) {
    return [singlePost];
  }

  const maxBodyChars = MAX_X_POST_CHARS - 8;
  const units = [
    ...leadBlocks.map((text) => ({ text, isBullet: false })),
    ...bulletLines.map((text) => ({ text, isBullet: true })),
  ];
  if (closing) units.push({ text: closing, isBullet: false });
  if (ctaLine) {
    if (ctaLine.length <= maxBodyChars || !ctaText || !ctaUrl) {
      units.push({ text: ctaLine, isBullet: false });
    } else {
      units.push({ text: ctaText, isBullet: false });
      units.push({ text: `👉 ${ctaUrl}`, isBullet: false });
    }
  }
  return packUnitsIntoXThread(units, MAX_X_POST_CHARS);
}

export function splitSponsorXThread(rawTwitterPost) {
  const trimmed = String(rawTwitterPost || "").trim();
  if (!trimmed) return [];
  if (trimmed.includes("\n\n---\n\n")) {
    const parts = trimmed.split(/\n\n---\n\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.every((p) => p.length <= MAX_X_POST_CHARS)) return parts;
  }
  if (trimmed.length <= MAX_X_POST_CHARS) return [trimmed];
  const units = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text) => ({ text, isBullet: text.startsWith("🔸") }));
  return packUnitsIntoXThread(units, MAX_X_POST_CHARS);
}

export function generateSponsorSocialPosts(content = {}, options = {}) {
  const linkedinPost = generateSponsorLinkedinPost(content, options);
  const xPosts = generateSponsorXPosts(content, options);
  const twitterPost = xPosts.join("\n\n---\n\n");
  return {
    linkedinPost,
    twitterPost,
    xPosts,
    isThread: xPosts.length > 1,
  };
}

export function hasUtmParams(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().startsWith("utm_")) return true;
    }
    return false;
  } catch {
    return /[?&]utm_[a-z0-9_]+=/i.test(trimmed);
  }
}

export function needsNewsletterUtmSuggestion(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) return false;
  return !hasUtmParams(trimmed);
}

export function buildSuggestedUtmUrl(
  rawUrl,
  utmSource = DEFAULT_NEWSLETTER_UTM_SOURCE,
  utmMedium = DEFAULT_NEWSLETTER_UTM_MEDIUM,
  utmCampaign = "",
) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (!parsed.searchParams.has("utm_source")) {
      parsed.searchParams.set("utm_source", utmSource);
    }
    if (utmMedium && !parsed.searchParams.has("utm_medium")) {
      parsed.searchParams.set("utm_medium", utmMedium);
    }
    if (utmCampaign && !parsed.searchParams.has("utm_campaign")) {
      parsed.searchParams.set("utm_campaign", utmCampaign);
    }
    return parsed.toString();
  } catch {
    const sep = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${sep}utm_source=${encodeURIComponent(utmSource)}&utm_medium=${encodeURIComponent(utmMedium)}`;
  }
}

const ENVELOPE_KEYS = new Set(["subjectLine", "previewText"]);
const CTA_PAIR_KEYS = new Set(["ctaText", "ctaUrl", "closingCtaText", "closingCtaUrl"]);

export function isEmailPieceSection(doc, tDef, sectionDef) {
  const key = String(doc?.template || tDef?.key || "");
  if (!key.startsWith("newsletter-")) return false;
  const secId = String(sectionDef?.id || "");
  return secId === "placement" || secId === "main" || secId.includes("placement");
}

export function validateSponsorDocDraft(tDef, draftContent) {
  const sections = Array.isArray(tDef?.sections) && tDef.sections.length > 0
    ? tDef.sections
    : [{ id: "main", title: "", fields: tDef?.fields || [] }];
  const allFields = sections.flatMap((section) => section.fields || []);
  const errors = {};
  for (const field of allFields) {
    const raw = String(draftContent?.[field.key] ?? "").trim();
    if (field.type === "bullets" || field.key === "bullets") {
      if (field.required && !raw) {
        errors[field.key] = `${field.label} is required.`;
      } else if (field.required) {
        const min = field.minItems || 1;
        const max = field.maxItems || Infinity;
        const filled = parseSponsorBulletItems(raw, 0).filter((item) => item.trim().length > 0);
        if (filled.length < min || filled.length > max) {
          errors[field.key] = `${field.label} must contain ${min}–${max} non-empty bullets.`;
        }
      }
      continue;
    }
    if (field.required && !raw) {
      errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (raw && field.format === "url") {
      try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
      } catch {
        errors[field.key] = `${field.label} must be a full http:// or https:// link.`;
      }
    }
  }
  return errors;
}

export function attachSoftUtmSuggestion({
  el,
  actionBtn,
  fieldWrap,
  fieldDef,
  control,
  draftContent,
  publicationDate,
  updateCount,
  updateLivePreview,
  announce,
}) {
  const shouldSuggest = Boolean(fieldDef.suggestNewsletterUtm)
    || fieldDef.key === "ctaUrl"
    || fieldDef.key === "closingCtaUrl"
    || fieldDef.key === "earlyCtaUrl";
  if (!shouldSuggest) return () => {};

  const box = el("div", "sponsor-doc-utm-suggestion");
  box.dataset.sponsorUtmSuggestion = fieldDef.key;
  box.hidden = true;

  const textSpan = el("span", "sponsor-doc-utm-suggestion__text");
  textSpan.dataset.sponsorUtmSuggestionText = fieldDef.key;

  const campaignSlug = publicationDate ? `dtc-${String(publicationDate).replace(/[^0-9a-z-]+/gi, "")}` : "";
  const applyBtn = actionBtn(
    "dk-button dk-button--secondary dk-button--sm",
    `Add ${DEFAULT_NEWSLETTER_UTM_SOURCE} UTM`,
    "apply-utm-suggestion",
    () => {
      const current = String(draftContent[fieldDef.key] || control.value || "").trim();
      if (!needsNewsletterUtmSuggestion(current)) return;
      const nextUrl = buildSuggestedUtmUrl(
        current,
        DEFAULT_NEWSLETTER_UTM_SOURCE,
        DEFAULT_NEWSLETTER_UTM_MEDIUM,
        campaignSlug,
      );
      control.value = nextUrl;
      draftContent[fieldDef.key] = nextUrl;
      updateCount(nextUrl);
      syncUtmSuggestion();
      updateLivePreview();
      announce?.(`Added ${DEFAULT_NEWSLETTER_UTM_SOURCE} UTM parameters to ${fieldDef.label}.`);
    },
  );
  applyBtn.dataset.sponsorUtmField = fieldDef.key;

  box.append(textSpan, applyBtn);
  fieldWrap.append(box);

  function syncUtmSuggestion() {
    const raw = String(draftContent[fieldDef.key] ?? control.value ?? "").trim();
    if (!needsNewsletterUtmSuggestion(raw)) {
      box.hidden = true;
      return;
    }
    const suggested = buildSuggestedUtmUrl(
      raw,
      DEFAULT_NEWSLETTER_UTM_SOURCE,
      DEFAULT_NEWSLETTER_UTM_MEDIUM,
      campaignSlug,
    );
    textSpan.textContent =
      `Tip: No UTM parameters detected. Consider adding "${DEFAULT_NEWSLETTER_UTM_SOURCE}" so you can track clicks from the newsletter (${suggested}).`;
    box.hidden = false;
  }

  syncUtmSuggestion();
  return syncUtmSuggestion;
}

export function mountNewsletterEmailPieceSection({
  el,
  doc,
  sectionWrap,
  sectionDef,
  fieldNodesByKey,
  draftContent,
  safePreviewHref,
}) {
  const fields = sectionDef.fields || [];
  const envelopeFields = fields.filter((f) => ENVELOPE_KEYS.has(f.key));
  const bodyFields = fields.filter((f) => !ENVELOPE_KEYS.has(f.key));

  if (envelopeFields.length > 0) {
    const envBox = el("div", "sponsor-email-piece-envelope");
    envBox.dataset.sponsorEmailEnvelope = "";
    for (const f of envelopeFields) {
      const node = fieldNodesByKey.get(f.key);
      if (node) envBox.append(node);
    }
    sectionWrap.append(envBox);
  }

  const pieceCard = el("div", "sponsor-email-piece-card");
  pieceCard.dataset.sponsorEmailCard = "";

  const cardHead = el("div", "sponsor-email-piece-card__head");
  const kickerDate = doc.publicationDate ? ` · ${doc.publicationDate}` : "";
  const kicker = el(
    "div",
    "sponsor-email-piece-card__kicker",
    `Sponsored · ${doc.sponsorName || "Your Company"}${kickerDate}`,
  );
  kicker.dataset.sponsorEmailKicker = "";
  const flowBadge = el(
    "span",
    "sponsor-email-piece-card__flow-label",
    "Email piece flow: Opening → Bulleted list → Closing → CTA button",
  );
  cardHead.append(kicker, flowBadge);
  pieceCard.append(cardHead);

  const flow = el("div", "sponsor-email-piece-card__flow");
  flow.dataset.sponsorEmailFlow = "";

  const isStandalone = doc.template === "newsletter-standalone"
    || bodyFields.some((f) => f.key === "mainBodyOpening");
  const openingKey = isStandalone
    ? "mainBodyOpening"
    : fieldNodesByKey.has("intro") ? "intro" : "body";
  const ctaTextKey = isStandalone && fieldNodesByKey.has("closingCtaText") ? "closingCtaText" : "ctaText";
  const ctaUrlKey = isStandalone && fieldNodesByKey.has("closingCtaUrl") ? "closingCtaUrl" : "ctaUrl";

  for (const f of bodyFields) {
    if (CTA_PAIR_KEYS.has(f.key)) continue;
    const node = fieldNodesByKey.get(f.key);
    if (!node) continue;
    if (f.key === openingKey) {
      node.classList.add("sponsor-email-piece-card__step");
      node.dataset.sponsorEmailStep = "opening";
    } else if (f.key === "bullets") {
      node.classList.add("sponsor-email-piece-card__step");
      node.dataset.sponsorEmailStep = "bullets";
    } else if (f.key === "closing") {
      node.classList.add("sponsor-email-piece-card__step");
      node.dataset.sponsorEmailStep = "closing";
    }
    flow.append(node);
  }

  const syncEditorCtaPill = () => {};
  const ctaTextNode = fieldNodesByKey.get(ctaTextKey);
  const ctaUrlNode = fieldNodesByKey.get(ctaUrlKey);
  if (ctaTextNode || ctaUrlNode) {
    const ctaStep = el("div", "sponsor-email-piece-card__cta sponsor-email-piece-card__step");
    ctaStep.dataset.sponsorEmailStep = "cta";
    ctaStep.dataset.sponsorCtaEditor = "";

    const ctaFieldsGrid = el("div", "sponsor-email-piece-card__cta-fields");
    if (ctaTextNode) ctaFieldsGrid.append(ctaTextNode);
    if (ctaUrlNode) ctaFieldsGrid.append(ctaUrlNode);

    ctaStep.append(ctaFieldsGrid);
    flow.append(ctaStep);
  }

  pieceCard.append(flow);
  sectionWrap.append(pieceCard);
  return syncEditorCtaPill;
}

export function renderNewsletterLivePreview({
  el,
  previewCard,
  doc,
  tDef,
  draftContent,
  hasField,
  uploadedVisualName,
  safePreviewHref,
}) {
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
  const appendCtaPreview = (parent, textVal, urlVal, fallbackLabel, wrapAttr, linkAttr, urlAttr, stepName) => {
    const wrap = el("div", "sponsor-preview-canvas__cta");
    wrap.dataset[wrapAttr] = "";
    if (stepName) wrap.dataset.sponsorPreviewStep = stepName;
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
  canvas.dataset.sponsorPreviewFlow = "";
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

  const isStandalone = doc.template === "newsletter-standalone" || hasField("mainBodyOpening");
  const pClass = "sponsor-preview-canvas__paragraph";
  const introFallback = "1–2 sentences introducing the problem, product, or resource.";
  const introNode = previewEl("p", pClass, val("intro") || val("body"), introFallback, "sponsorPreviewIntro");
  if (!isStandalone) introNode.dataset.sponsorPreviewStep = "opening";
  canvas.append(introNode);

  if (doc.template === "newsletter-standalone" || hasField("earlyCtaText") || hasField("earlyCtaUrl")) {
    appendCtaPreview(
      canvas, val("earlyCtaText"), val("earlyCtaUrl"), "Early CTA Button",
      "sponsorPreviewEarlyCta", "sponsorPreviewEarlyCtaLink", "", "",
    );
  }
  if (isStandalone) {
    const openingFallback = "1–2 sentences introducing the session, product, or key story before the bullet list.";
    const openNode = previewEl("p", pClass, val("mainBodyOpening"), openingFallback, "sponsorPreviewOpening");
    openNode.dataset.sponsorPreviewStep = "opening";
    canvas.append(openNode);
  }
  const isNewsletter = String(doc.template || tDef?.key || "").startsWith("newsletter-");
  if (hasField("bullets") || Boolean(draftContent.bullets) || isNewsletter) {
    const ul = el("ul", "sponsor-preview-canvas__bullets");
    ul.dataset.sponsorPreviewBullets = "";
    ul.dataset.sponsorPreviewStep = "bullets";
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
  if (hasField("closing") || Boolean(draftContent.closing) || isNewsletter) {
    const closingFallback = "Closing sentence leading into the call-to-action.";
    const closeNode = previewEl("p", pClass, val("closing"), closingFallback, "sponsorPreviewClosing");
    closeNode.dataset.sponsorPreviewStep = "closing";
    canvas.append(closeNode);
  }

  const useClosingCta = doc.template === "newsletter-standalone" || hasField("closingCtaText");
  appendCtaPreview(
    canvas,
    useClosingCta ? val("closingCtaText") : val("ctaText"),
    useClosingCta ? val("closingCtaUrl") : val("ctaUrl"),
    useClosingCta ? "Closing CTA Button" : "Call to Action",
    "sponsorPreviewCta",
    "sponsorPreviewCtaLink",
    "sponsorPreviewCtaUrl",
    "cta",
  );
  previewCard.append(canvas);

  const generatedSocial = generateSponsorSocialPosts(draftContent, {
    sponsorName: doc.sponsorName,
  });
  const linkedinVal = val("linkedinPost") || generatedSocial.linkedinPost;
  const rawTwitterVal = val("twitterPost");
  const xPosts = !rawTwitterVal || rawTwitterVal === generatedSocial.twitterPost
    ? generatedSocial.xPosts
    : splitSponsorXThread(rawTwitterVal);

  const socialWrap = el("div", "sponsor-preview-social");
  socialWrap.dataset.sponsorPreviewSocial = "";
  socialWrap.append(el("h3", "sponsor-doc-field__label", "Social Media Preview"));

  const linkedinCard = el("div", "sponsor-preview-social__card");
  linkedinCard.dataset.sponsorPreviewLinkedin = "";
  const linkedinTop = el("div", "sponsor-doc-field__top");
  linkedinTop.append(
    el("span", "sponsor-preview-envelope__label", "LinkedIn"),
    el("span", "sponsor-doc-field__count", "Auto-generated"),
  );
  const linkedinPlaceholder = "Auto-generated LinkedIn post will appear here as you fill in the fields.";
  const linkedinTextNode = el(
    "p",
    linkedinVal ? "sponsor-preview-social__text" : "sponsor-preview-social__text is-placeholder",
    linkedinVal || linkedinPlaceholder,
  );
  linkedinTextNode.dataset.sponsorPreviewLinkedinText = "";
  linkedinCard.append(linkedinTop, linkedinTextNode);
  socialWrap.append(linkedinCard);

  const isThread = xPosts.length > 1;
  const twitterCard = el("div", "sponsor-preview-social__card");
  twitterCard.dataset.sponsorPreviewTwitter = "";
  twitterCard.dataset.sponsorPreviewTwitterMode = isThread ? "thread" : "single";
  const twitterTop = el("div", "sponsor-doc-field__top");
  const twitterLabelText = isThread ? `X (Twitter) Thread (${xPosts.length} tweets)` : "X (Twitter)";
  const twitterMetaText = isThread
    ? `${xPosts.length} tweets · ≤ ${MAX_X_POST_CHARS} chars each`
    : `${(xPosts[0] || "").length} / ${MAX_X_POST_CHARS} chars`;
  twitterTop.append(
    el("span", "sponsor-preview-envelope__label", twitterLabelText),
    el("span", "sponsor-doc-field__count", twitterMetaText),
  );
  twitterCard.append(twitterTop);

  if (xPosts.length === 0) {
    const xPh = "Auto-generated X post (or thread when > 280 chars) will appear here.";
    const emptyTweet = el("p", "sponsor-preview-social__text is-placeholder", xPh);
    twitterCard.append(emptyTweet);
  } else if (!isThread) {
    const singleTweet = el("p", "sponsor-preview-social__text", xPosts[0]);
    singleTweet.dataset.sponsorPreviewTweet = "1";
    singleTweet.dataset.sponsorPreviewTweetChars = String(xPosts[0].length);
    twitterCard.append(singleTweet);
  } else {
    const threadWrap = el("div", "sponsor-preview-social__thread");
    threadWrap.dataset.sponsorPreviewThread = "";
    xPosts.forEach((tweetText, idx) => {
      const item = el("div", "sponsor-preview-social__thread-item");
      const itemTop = el("div", "sponsor-doc-field__top");
      itemTop.append(
        el("span", "sponsor-preview-envelope__label", `Tweet ${idx + 1} of ${xPosts.length}`),
        el("span", "sponsor-doc-field__count", `${tweetText.length} / ${MAX_X_POST_CHARS} chars`),
      );
      const tweetP = el("p", "sponsor-preview-social__text", tweetText);
      tweetP.dataset.sponsorPreviewTweet = String(idx + 1);
      tweetP.dataset.sponsorPreviewTweetChars = String(tweetText.length);
      item.append(itemTop, tweetP);
      threadWrap.append(item);
    });
    twitterCard.append(threadWrap);
  }
  socialWrap.append(twitterCard);
  previewCard.append(socialWrap);
}
