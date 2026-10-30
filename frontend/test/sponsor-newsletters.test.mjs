import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { filterNewsletters } from "../src/surfaces/finance/sponsor-newsletters.js";
import {
  DEFAULT_NEWSLETTER_UTM_SOURCE,
  buildSuggestedUtmUrl,
  createSponsorDocPage,
  hasUtmParams,
  needsNewsletterUtmSuggestion,
  parseSponsorBulletItems,
  readVisualFileAsDataUrl,
  serializeSponsorBulletItems,
} from "../src/surfaces/operations/sponsor-docs.js";
import { FakeDocument, FakeElement, nextTicks } from "./support/fake-dom.mjs";

const savedDocument = globalThis.document;
const savedEvent = globalThis.CustomEvent;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.CustomEvent = savedEvent;
});

function newsletterMainTemplateDefinition() {
  return {
    key: "newsletter-main",
    label: "Sponsored Newsletter — Main Slot",
    intro: "Main sponsored block at the top of the weekly newsletter.",
    sections: [
      {
        id: "placement",
        title: "1) Newsletter Placement",
        fields: [
          { key: "subjectLine", label: "Subject Line (≤ 35 characters)", type: "text", maxCharsHint: 35 },
          { key: "previewText", label: "Email Preview Text (≤ 120 characters)", type: "text", maxCharsHint: 120 },
          { key: "title", label: "Title (≤ 80 characters)", type: "text", maxCharsHint: 80 },
          {
            key: "graphicsUrl",
            label: "Graphics (Link to cloud storage or image URL)",
            type: "text",
            allowVisualUpload: true,
          },
          { key: "intro", label: "Intro (1–2 sentences)", type: "textarea", rows: 3 },
          {
            key: "bullets",
            label: "Bulleted List (3–6 bullets)",
            type: "bullets",
            minItems: 3,
            maxItems: 6,
            bulletMarker: "•",
            placeholder: "Key benefit or takeaway",
          },
          { key: "closing", label: "Closing (1 sentence)", type: "textarea", rows: 2 },
          {
            key: "ctaText",
            label: "CTA Button — Text (2–4 words)",
            type: "text",
            required: true,
            maxCharsHint: 40,
          },
          {
            key: "ctaUrl",
            label: "CTA Button — Link (URL with UTM if applicable)",
            type: "text",
            required: true,
            format: "url",
            suggestNewsletterUtm: true,
          },
        ],
      },
    ],
  };
}

function setupPageHarness(docOverrides = {}, customRequest = null) {
  const root = new FakeElement("section");
  root.id = "sponsor-doc-root";
  const identity = new FakeElement("span");
  identity.id = "sponsor-doc-identity";
  const live = new FakeElement("div");
  live.id = "dk-live";
  const doc = new FakeDocument(root, identity, live);
  const originalCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = originalCreate(tag);
    node.dispatchEvent = (event) => node.dispatch(event.type, event);
    node.prepend = (child) => {
      node.children.unshift(child);
      child.parentElement = node;
    };
    node.isConnected = true;
    return node;
  };
  globalThis.document = doc;
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  const calls = [];
  let currentDoc = {
    id: "sdoc-news-1",
    cardId: "card-news-1",
    template: "newsletter-main",
    title: "2026-11-23 - Modal",
    sponsorName: "Modal",
    publicationDate: "2026-11-23",
    status: "draft",
    viewerRole: "sponsor",
    docUrl: "https://ops.example.test/sponsor-docs/sdoc-news-1",
    content: {
      subjectLine: "Serverless GPUs for AI",
      previewText: "Run inference and fine-tuning in seconds.",
      title: "Run generative AI workloads without managing infrastructure",
      graphicsUrl: "",
      intro: "Teams waste weeks configuring Kubernetes for GPU workloads.",
      bullets: "- Sub-second container cold starts\n- Per-second GPU billing\n- Python-native deployment",
      closing: "Try Modal with $30/month in free compute credits.",
      ctaText: "",
      ctaUrl: "",
    },
    templateDefinition: newsletterMainTemplateDefinition(),
    markdownExport: "# 2026-11-23 - Modal\n",
    version: 1,
    ...docOverrides,
  };

  const controller = createSponsorDocPage({
    documentRef: doc,
    locationRef: {
      href: "https://ops.example.test/sponsor-docs/sdoc-news-1?code=bcdfghjklmnpqrst",
      pathname: "/sponsor-docs/sdoc-news-1",
    },
    historyRef: { replaceState: () => {} },
    storageRef: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    clipboardRef: { writeText: async () => {} },
    request: async (url, opts = {}) => {
      calls.push([url, opts]);
      if (customRequest) return customRequest(url, opts, currentDoc);
      if (opts.method === "PUT") {
        const body = JSON.parse(opts.body);
        currentDoc = {
          ...currentDoc,
          content: { ...currentDoc.content, ...(body.content || {}) },
          status: body.status || currentDoc.status,
          version: currentDoc.version + 1,
        };
        return { doc: currentDoc };
      }
      if (url.endsWith("/send-email")) {
        const delivery = {
          state: "sent",
          from: "orin@datatalks.club",
          to: "partner@modal.example.com",
          messageId: "gmail-msg-1",
          sentAt: "2026-10-30T12:00:00.000Z",
        };
        currentDoc = { ...currentDoc, emailDelivery: delivery };
        return { doc: currentDoc, emailDelivery: delivery };
      }
      return { doc: currentDoc };
    },
  });

  return { root, live, controller, calls };
}

test("attention filter keeps overdue missing and pending titles", () => {
  const items = [
    { id: "late", health: "overdue" },
    { id: "none", health: "missing" },
    { id: "sign", health: "pending" },
    { id: "ok", health: "current" },
    { id: "wait", health: "waiting" },
  ];
  assert.deepEqual(filterNewsletters(items, "").map((item) => item.id), [
    "late", "none", "sign", "ok", "wait",
  ]);
  assert.deepEqual(filterNewsletters(items, "attention").map((item) => item.id), [
    "late", "none", "sign",
  ]);
  assert.deepEqual(filterNewsletters(items, "current").map((item) => item.id), ["ok"]);
});

test("sponsor newsletter bullet list helpers preserve structured items and visual file reader encodes data URL", async () => {
  const parsed = parseSponsorBulletItems("• Fast ingestion\n• SQL transforms\n• Zero ops", 3);
  assert.deepEqual(parsed, ["Fast ingestion", "SQL transforms", "Zero ops"]);
  assert.equal(
    serializeSponsorBulletItems([...parsed, "Real-time alerting"]),
    "- Fast ingestion\n- SQL transforms\n- Zero ops\n- Real-time alerting",
  );

  const bytes = new Uint8Array([137, 80, 78, 71]);
  const dataUrl = await readVisualFileAsDataUrl({
    name: "sponsor-banner.png",
    type: "image/png",
    arrayBuffer: async () => bytes.buffer,
  });
  assert.equal(dataUrl, "data:image/png;base64,iVBORw==");
});

test("UTM helpers detect missing UTM params and build default datatalksclub-newsletter UTM links without clobbering existing params", () => {
  assert.equal(DEFAULT_NEWSLETTER_UTM_SOURCE, "datatalksclub-newsletter");
  assert.equal(hasUtmParams("https://example.com/product"), false);
  assert.equal(hasUtmParams("https://example.com/product?ref=dtc"), false);
  assert.equal(hasUtmParams("https://example.com/product?utm_source=custom"), true);
  assert.equal(needsNewsletterUtmSuggestion(""), false);
  assert.equal(needsNewsletterUtmSuggestion("not-a-url"), false);
  assert.equal(needsNewsletterUtmSuggestion("https://example.com/launch"), true);
  assert.equal(needsNewsletterUtmSuggestion("https://example.com/launch?utm_campaign=fall"), false);

  const suggested = buildSuggestedUtmUrl("https://example.com/launch?ref=hero", "datatalksclub-newsletter", "newsletter", "dtc-2026-11-23");
  assert.equal(
    suggested,
    "https://example.com/launch?ref=hero&utm_source=datatalksclub-newsletter&utm_medium=newsletter&utm_campaign=dtc-2026-11-23",
  );
});

test("renders card-as-email layout (opening -> bullets -> closing -> CTA button), enforces required CTA fields, and softly suggests UTM without silent rewrite", async () => {
  const h = setupPageHarness();
  await h.controller.start();

  // 1. Editor presents one white email-piece card with ordered steps: opening -> bullets -> closing -> cta
  const emailCard = h.root.querySelector("[data-sponsor-email-card]");
  assert.ok(emailCard, "editor renders white email-piece card");
  const editorSteps = emailCard
    .querySelectorAll("[data-sponsor-email-step]")
    .map((node) => node.dataset.sponsorEmailStep);
  assert.deepEqual(editorSteps, ["opening", "bullets", "closing", "cta"]);

  // 2. Preview shows the same ordered flow: opening -> bullets -> closing -> cta
  const preview = h.root.querySelector("[data-sponsor-live-preview]");
  assert.ok(preview, "live preview is rendered");
  const previewSteps = preview
    .querySelectorAll("[data-sponsor-preview-step]")
    .map((node) => node.dataset.sponsorPreviewStep);
  assert.deepEqual(previewSteps, ["opening", "bullets", "closing", "cta"]);

  // 3. CTA button label and URL are required in the UI: submitting while empty is blocked with inline errors
  const submitBtn = h.root.querySelector('[data-sponsor-action="submit-ready"]');
  await submitBtn.click();
  await nextTicks();

  const putCallsBeforeFill = h.calls.filter(([, opts]) => opts.method === "PUT");
  assert.equal(putCallsBeforeFill.length, 0, "does not PUT when required CTA fields are missing");
  assert.ok(h.root.querySelector('[data-sponsor-field-error="ctaText"]'), "shows inline error for missing ctaText");
  assert.ok(h.root.querySelector('[data-sponsor-field-error="ctaUrl"]'), "shows inline error for missing ctaUrl");

  // 4. Typing CTA label and URL without UTM updates the editor's CTA button pill and live preview, and shows soft UTM suggestion without rewriting
  const ctaTextInput = h.root.querySelector("#sponsor-field-ctaText");
  const ctaUrlInput = h.root.querySelector("#sponsor-field-ctaUrl");
  assert.equal(ctaTextInput.getAttribute("aria-required"), "true");
  assert.equal(ctaUrlInput.getAttribute("aria-required"), "true");

  ctaTextInput.value = "Try Modal Free";
  await ctaTextInput.dispatch("input");
  ctaUrlInput.value = "https://modal.com/signup";
  await ctaUrlInput.dispatch("input");

  const editorCtaPill = h.root.querySelector("[data-sponsor-editor-cta-pill]");
  assert.equal(editorCtaPill.textContent, "Try Modal Free");
  assert.equal(editorCtaPill.href, "https://modal.com/signup");
  const updatedPreview = h.root.querySelector("[data-sponsor-live-preview]");
  assert.equal(updatedPreview.querySelector("[data-sponsor-preview-cta-link]").textContent, "Try Modal Free");
  assert.equal(updatedPreview.querySelector("[data-sponsor-preview-cta-link]").href, "https://modal.com/signup");

  const utmBox = h.root.querySelector('[data-sponsor-utm-suggestion="ctaUrl"]');
  assert.ok(utmBox, "soft UTM suggestion box exists");
  assert.equal(utmBox.hidden, false, "soft UTM suggestion is visible when URL has no UTM");
  assert.match(utmBox.textContent, /datatalksclub-newsletter/);

  // Saving draft without clicking the UTM suggestion preserves the exact sponsor URL (never rewrites silently)
  const saveDraftBtn = h.root.querySelector('[data-sponsor-action="save-draft"]');
  await saveDraftBtn.click();
  await nextTicks();

  const draftPut = h.calls.find(([, opts]) => opts.method === "PUT");
  assert.ok(draftPut);
  assert.equal(
    JSON.parse(draftPut[1].body).content.ctaUrl,
    "https://modal.com/signup",
    "never rewrites CTA URL silently on save",
  );

  // 5. Clicking the soft UTM suggestion button applies the default DTC newsletter UTM and hides the banner
  const applyUtmBtn = h.root.querySelector('[data-sponsor-action="apply-utm-suggestion"]');
  await applyUtmBtn.click();
  const updatedCtaUrlInput = h.root.querySelector("#sponsor-field-ctaUrl");
  assert.match(updatedCtaUrlInput.value, /utm_source=datatalksclub-newsletter/);
  assert.equal(h.root.querySelector('[data-sponsor-utm-suggestion="ctaUrl"]').hidden, true);

  // 6. Submitting now succeeds
  await h.root.querySelector('[data-sponsor-action="submit-ready"]').click();
  await nextTicks();
  assert.match(h.root.textContent, /Submitted \/ Ready/);
  h.controller.destroy();
});

test("staff view displays Orin auto-send delivery status and can trigger Send from orin@datatalks.club", async () => {
  const h = setupPageHarness({
    viewerRole: "staff",
    shareUrl: "https://ops.example.test/sponsor-docs/sdoc-news-1?code=BCDF-GHJK-LMNP-QRST",
    accessCode: "BCDF-GHJK-LMNP-QRST",
    emailDelivery: {
      state: "deferred",
      from: "orin@datatalks.club",
      to: "partner@modal.example.com",
      reason: "insufficient_gmail_scope",
      message: "Dapier connection google-calendar-orin needs gmail.send scope.",
    },
  });
  await h.controller.start();

  const delivEl = h.root.querySelector("[data-sponsor-email-delivery]");
  assert.ok(delivEl);
  assert.equal(delivEl.dataset.sponsorEmailDelivery, "deferred");
  assert.match(delivEl.textContent, /orin@datatalks\.club/);

  const sendBtn = h.root.querySelector('[data-sponsor-action="send-sponsor-email"]');
  assert.ok(sendBtn, "Send from orin@datatalks.club button is rendered for staff");
  await sendBtn.click();
  await nextTicks();

  const updatedDeliv = h.root.querySelector("[data-sponsor-email-delivery]");
  assert.equal(updatedDeliv.dataset.sponsorEmailDelivery, "sent");
  assert.match(h.root.textContent, /Sent sponsor form email from orin@datatalks\.club to partner@modal\.example\.com/);
  h.controller.destroy();
});
