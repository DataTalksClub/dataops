import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { linkService } from "../src/core/links.js";
import {
  createSponsorDocPage,
  parseSponsorBulletItems,
  serializeSponsorBulletItems,
} from "../src/surfaces/operations/sponsor-docs.js";
import { renderCardSponsorDocsSection } from "../src/surfaces/work-detail/card-summary.js";
import { FakeDocument, FakeElement, findByText, nextTicks } from "./support/fake-dom.mjs";

const savedDocument = globalThis.document;
const savedEvent = globalThis.CustomEvent;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.CustomEvent = savedEvent;
});

function sampleDoc(overrides = {}) {
  return {
    id: "doc-abc",
    cardId: "card-1",
    template: "newsletter-main",
    title: "2026-11-15 - Acme AI",
    sponsorName: "Acme AI",
    publicationDate: "2026-11-15",
    status: "draft",
    viewerRole: "sponsor",
    docUrl: "https://ops.example.test/sponsor-docs/doc-abc",
    lastEditedAt: null,
    lastEditedBy: null,
    lastEditedByName: null,
    content: {
      headline: "Initial Headline",
      body: "Initial Body",
      ctaText: "Learn More",
      ctaUrl: "https://acme.example.com",
      imageUrl: "",
      notes: "",
    },
    templateDefinition: {
      key: "newsletter-main",
      label: "Sponsored Newsletter — Main Slot",
      intro: "Please fill in your main newsletter copy below.",
      guidelinesUrl: "https://drive.google.com/example",
      guidelines: ["Title max 80 characters", "Include UTM tags"],
      sections: [
        {
          id: "newsletter-placement",
          title: "1) Newsletter Placement",
          description: "Main sponsored block at the top of the weekly newsletter.",
          fields: [
            { key: "headline", label: "Title / Headline", type: "text", required: true, maxWordsHint: 12 },
            { key: "body", label: "Main Copy", type: "textarea", required: true, maxCharsHint: 900, rows: 5 },
            { key: "ctaText", label: "CTA Label", type: "text", required: true, maxCharsHint: 50 },
            { key: "ctaUrl", label: "CTA Link", type: "text", required: true },
          ],
        },
      ],
    },
    markdownExport: "# 2026-11-15 - Acme AI\n\n## Title\n\nInitial Headline\n",
    version: 1,
    ...overrides,
  };
}

function harness(options = {}) {
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
  const history = [];
  const copied = [];
  const store = new Map();
  const storageRef = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const locationRef = {
    href: options.href || "https://ops.example.test/sponsor-docs/doc-abc?code=bcdfghjklmnpqrst",
    pathname: options.pathname || "/sponsor-docs/doc-abc",
  };

  let currentDoc = sampleDoc(options.docOverrides);
  const validCode = options.validCode || "BCDF-GHJK-LMNP-QRST";

  const controller = createSponsorDocPage({
    documentRef: doc,
    locationRef,
    historyRef: { replaceState: (...args) => history.push(args) },
    storageRef,
    clipboardRef: { writeText: async (text) => copied.push(text) },
    ...(options.autosaveDelayMs !== undefined ? { autosaveDelayMs: options.autosaveDelayMs } : {}),
    request: async (url, opts = {}) => {
      calls.push([url, opts]);
      if (options.request) return options.request(url, opts);

      const headerCode = opts.headers?.["x-sponsor-doc-code"] || "";
      if (currentDoc.viewerRole !== "staff") {
        if (!headerCode) {
          throw Object.assign(new Error("Access code required"), { status: 401 });
        }
        if (headerCode !== validCode) {
          throw Object.assign(new Error("Invalid access code"), { status: 403 });
        }
      }

      if (opts.method === "POST" && /\/images(?:\?|$)/.test(url)) {
        return {
          image: {
            id: "11111111-1111-4111-8111-111111111111.png",
            path: "/api/public-images/11111111-1111-4111-8111-111111111111.png",
            url: "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png",
            contentType: "image/png",
            sizeBytes: 8,
          },
        };
      }

      if (opts.method === "PUT") {
        const body = JSON.parse(opts.body);
        currentDoc = {
          ...currentDoc,
          content: { ...currentDoc.content, ...(body.content || {}) },
          status: body.status || currentDoc.status,
          lastEditedAt: "2026-10-17T20:30:00.000Z",
          lastEditedBy: currentDoc.viewerRole === "staff" ? "staff" : "sponsor",
          version: currentDoc.version + 1,
        };
        return { doc: currentDoc };
      }

      if (url.endsWith("/rotate-code")) {
        currentDoc = {
          ...currentDoc,
          accessCode: "WXZ2-3456-789B-CDFG",
          shareUrl: "https://ops.example.test/sponsor-docs/doc-abc?code=WXZ2-3456-789B-CDFG",
        };
        return { doc: currentDoc };
      }

      return { doc: currentDoc };
    },
  });

  return { root, identity, live, controller, calls, history, copied, storageRef };
}

test("sponsor link with ?code= strips code from URL, opens straight into editor, and saves + submits", async () => {
  const h = harness();
  await h.controller.start();

  assert.deepEqual(h.history, [[null, "", "/sponsor-docs/doc-abc"]]);
  assert.equal(h.calls[0][1].headers["x-sponsor-doc-code"], "BCDF-GHJK-LMNP-QRST");
  assert.match(h.root.textContent, /2026-11-15 - Acme AI/);
  assert.match(h.root.textContent, /Draft/);

  const headlineInput = h.root.querySelector("#sponsor-field-headline");
  assert.equal(headlineInput.value, "Initial Headline");
  headlineInput.value = "Updated Sponsor Headline";
  await headlineInput.dispatch("input");

  const saveDraftBtn = h.root.querySelector('[data-sponsor-action="save-draft"]');
  await saveDraftBtn.click();
  await nextTicks();

  assert.match(h.root.textContent, /Saved draft/);
  assert.match(h.root.textContent, /Last edited 17 Oct 2026, 22:30 CEST \(Europe\/Berlin\) by sponsor/);

  const submitBtn = h.root.querySelector('[data-sponsor-action="submit-ready"]');
  await submitBtn.click();
  await nextTicks();

  assert.match(h.root.textContent, /Submitted \/ Ready/);
  assert.match(h.root.textContent, /Submitted and marked ready/);
  h.controller.destroy();
});

test("wrong code is refused with an alert and typing the valid 16-char code unlocks the doc", async () => {
  const h = harness({
    href: "https://ops.example.test/sponsor-docs/doc-abc?code=WRNG-CODE-WRNG-CODE",
  });
  await h.controller.start();

  assert.match(h.root.textContent, /Enter access code/);
  assert.match(h.root.textContent, /Invalid access code/);
  assert.match(h.root.textContent, /DataTalks\.Club email/);
  assert.ok(!/sponsor/i.test(h.root.textContent), "gate copy is sponsor-free");
  assert.ok(!/sponsor/i.test(h.identity.textContent), "gate identity is sponsor-free");

  const codeInput = h.root.querySelector("#sponsor-doc-code-input");
  codeInput.value = "bcdfghjklmnpqrst";
  await codeInput.dispatch("input");
  assert.equal(codeInput.value, "BCDF-GHJK-LMNP-QRST");

  await h.root.querySelector("form").dispatch("submit");
  await nextTicks();

  assert.match(h.root.textContent, /2026-11-15 - Acme AI/);
  assert.match(h.identity.textContent, /Code verified/);

  const lockBtn = h.identity.querySelector('[data-sponsor-action="lock"]');
  await lockBtn.click();
  assert.match(h.root.textContent, /Enter access code/);
  h.controller.destroy();
});

test("authenticated DataOps staff can view, copy share links, rotate codes, and reopen without a code", async () => {
  const h = harness({
    href: "https://ops.example.test/sponsor-docs/doc-abc",
    docOverrides: {
      viewerRole: "staff",
      status: "submitted",
      shareUrl: "https://ops.example.test/sponsor-docs/doc-abc?code=BCDF-GHJK-LMNP-QRST",
      accessCode: "BCDF-GHJK-LMNP-QRST",
      emailDraft: {
        subject: "Subject line",
        body: "Body with link",
      },
    },
  });
  await h.controller.start();

  assert.match(h.identity.textContent, /DataOps Staff/);
  assert.match(h.root.textContent, /Shareable sponsor link/);

  await findByText(h.root, "Copy share link", "button").click();
  assert.equal(h.copied.at(-1), "https://ops.example.test/sponsor-docs/doc-abc?code=BCDF-GHJK-LMNP-QRST");

  await findByText(h.root, "Copy sponsor email", "button").click();
  assert.match(h.copied.at(-1), /Subject: Subject line/);

  assert.equal(h.root.querySelector("[data-sponsor-task-id]"), null, "no manual owning-task input");
  assert.doesNotMatch(h.root.textContent, /Owning task ID/);
  assert.ok(h.root.querySelector("[data-sponsor-staff-only-note]"), "staff panel is labelled staff-only");
  await findByText(h.root, "Send from orin@datatalks.club", "button").click();
  await nextTicks();
  const sendCall = h.calls.find(([url]) => url.endsWith("/send-email"));
  assert.deepEqual(JSON.parse(sendCall[1].body), {}, "the server resolves the owning Task from the Card");

  await findByText(h.root, "Copy Markdown", "button").click();
  assert.match(h.copied.at(-1), /# 2026-11-15 - Acme AI/);

  await findByText(h.root, "Rotate code", "button").click();
  await nextTicks();
  assert.match(h.root.textContent, /WXZ2-3456-789B-CDFG/);

  await findByText(h.root, "Reopen as Draft", "button").click();
  await nextTicks();
  assert.match(h.root.textContent, /Reopened as draft/);
  h.controller.destroy();
});

test("Card sponsor docs section and linkService render status and last-edited info", () => {
  assert.equal(linkService("https://ops.dtcdev.click/sponsor-docs/doc-abc").id, "sponsordoc");
  assert.equal(linkService("https://ops.dtcdev.click/podcast-docs/doc-abc").id, "sponsordoc");
  assert.equal(linkService("https://ops.dtcdev.click/guest-docs/doc-abc").id, "sponsordoc");

  const doc = new FakeDocument();
  globalThis.document = doc;
  const section = renderCardSponsorDocsSection({
    id: "card-1",
    sponsorDocs: [
      {
        id: "doc-abc",
        title: "2026-11-15 - Acme AI",
        template: "newsletter-main",
        status: "submitted",
        lastEditedAt: "2026-10-17T20:30:00.000Z",
        lastEditedBy: "sponsor",
      },
    ],
  });
  assert.ok(section);
  assert.match(section.textContent, /Submitted \/ Ready/);
  assert.match(section.textContent, /Last edited 2026-10-17 20:30 by sponsor/);
  assert.match(section.textContent, /Markdown export/);

  const guestSection = renderCardSponsorDocsSection({
    id: "card-2",
    sponsorDocs: [
      {
        id: "doc-pod",
        title: "Podcast — Materials from the Guest",
        template: "podcast",
        status: "draft",
        lastEditedAt: "2026-10-17T20:30:00.000Z",
        lastEditedBy: "guest",
      },
    ],
  });
  assert.ok(guestSection);
  assert.match(guestSection.textContent, /Guest materials/);
  assert.ok(!/Sponsor/i.test(guestSection.textContent), "no sponsor wording for podcast guest docs");
  const guestLink = guestSection.querySelector("a");
  assert.ok(guestLink.href.startsWith("/podcast-docs/"), `podcast doc links under /podcast-docs/: ${guestLink.href}`);
  const guestMeta = [...guestSection.querySelectorAll("small")].map((node) => node.textContent).join(" ");
  assert.match(guestMeta, /podcast · Last edited 2026-10-17 20:30 by guest/);
});

test("keeps structured Main Body Opening, Bulleted List, and Closing fields and updates live preview on typing and visual upload", async () => {
  const standaloneTemplateDefinition = {
    key: "newsletter-standalone",
    label: "Stand-Alone Newsletter Specs",
    intro: "Dedicated stand-alone newsletter blast.",
    sections: [
      {
        id: "standalone-placement",
        title: "1) Stand-Alone Newsletter Copy",
        fields: [
          { key: "subjectLine", label: "Email Subject Line (≤ 65 characters)", type: "text", maxCharsHint: 65 },
          { key: "previewText", label: "Email Preview Text (≤ 140 characters)", type: "text", maxCharsHint: 140 },
          { key: "title", label: "Title (≤ 12 words)", type: "text", maxWordsHint: 12 },
          {
            key: "graphicsUrl",
            label: "Graphics (Link to cloud storage or image URL)",
            type: "text",
            allowVisualUpload: true,
          },
          { key: "intro", label: "Intro (2 sentences)", type: "textarea", rows: 3 },
          { key: "earlyCtaText", label: "CTA Button — Early Placement (Text)", type: "text" },
          { key: "earlyCtaUrl", label: "CTA Button — Early Placement (Link)", type: "text" },
          {
            key: "mainBodyOpening",
            label: "Main Body — Opening (1–2 sentences)",
            type: "textarea",
            rows: 3,
          },
          {
            key: "bullets",
            label: "Main Body — Bulleted List (3–4 bullets)",
            type: "bullets",
            minItems: 3,
            maxItems: 5,
            bulletMarker: "•",
            placeholder: "Takeaway or highlight",
          },
          { key: "closing", label: "Closing (1–2 sentences)", type: "textarea", rows: 2 },
          { key: "closingCtaText", label: "CTA Button — Closing Placement (Text)", type: "text" },
          { key: "closingCtaUrl", label: "CTA Button — Closing Placement (Link)", type: "text" },
        ],
      },
    ],
  };

  const h = harness({
    docOverrides: {
      template: "newsletter-standalone",
      templateDefinition: standaloneTemplateDefinition,
      content: {
        subjectLine: "",
        previewText: "",
        title: "",
        graphicsUrl: "",
        intro: "",
        earlyCtaText: "",
        earlyCtaUrl: "",
        mainBodyOpening: "",
        bullets: "",
        closing: "",
        closingCtaText: "",
        closingCtaUrl: "",
      },
    },
  });
  await h.controller.start();

  // 1. All three structured body fields exist separately (never merged into one textarea)
  const openingInput = h.root.querySelector("#sponsor-field-mainBodyOpening");
  const bulletsField = h.root.querySelector('[data-sponsor-bullets="bullets"]');
  const closingInput = h.root.querySelector("#sponsor-field-closing");
  assert.ok(openingInput, "Main Body Opening textarea is present");
  assert.ok(bulletsField, "Structured Bulleted List editor is present");
  assert.ok(closingInput, "Closing textarea is present");

  // 2. Bulleted list renders 3 structured item inputs (CMP learning-in-public links style)
  let bulletInputs = bulletsField.querySelectorAll("[data-sponsor-bullet-input]");
  assert.equal(bulletInputs.length, 3);

  // 3. Live preview pane is present on the right side of the workspace
  const preview = h.root.querySelector("[data-sponsor-live-preview]");
  assert.ok(preview, "Live preview pane is rendered");
  assert.match(preview.textContent, /Live Preview/);
  // The preview is the block alone: no slot badge, helper copy, envelope labels or sample text.
  assert.doesNotMatch(preview.textContent, /Stand-Alone Blast|Updates live|Subject|\[Inbox preview text\]|Bullet point 1|Headline for your/);
  assert.ok(preview.querySelector("[data-sponsor-preview-empty]"), "an empty doc shows one quiet empty-state line");

  // 4. Typing into structured fields updates the live preview immediately
  const titleInput = h.root.querySelector("#sponsor-field-title");
  titleInput.value = "Real-time CDC & streaming pipelines";
  await titleInput.dispatch("input");
  assert.equal(
    preview.querySelector("[data-sponsor-preview-title]").textContent,
    "Real-time CDC & streaming pipelines",
  );

  openingInput.value = "Here is what you will learn in our architecture deep dive:";
  await openingInput.dispatch("input");
  assert.equal(
    preview.querySelector("[data-sponsor-preview-opening]").textContent,
    "Here is what you will learn in our architecture deep dive:",
  );

  bulletInputs[0].value = "Sub-second CDC from Postgres and Snowflake";
  await bulletInputs[0].dispatch("input");
  bulletInputs[1].value = "Zero-maintenance schema evolution";
  await bulletInputs[1].dispatch("input");
  bulletInputs[2].value = "Declarative transformations in SQL";
  await bulletInputs[2].dispatch("input");

  // Add a 4th bullet using "+ Add bullet" button
  const addBulletBtn = bulletsField.querySelector('[data-sponsor-action="add-bullet"]');
  await addBulletBtn.click();
  bulletInputs = bulletsField.querySelectorAll("[data-sponsor-bullet-input]");
  assert.equal(bulletInputs.length, 4);
  bulletInputs[3].value = "SOC2 Type II and HIPAA ready";
  await bulletInputs[3].dispatch("input");

  const previewBullets = preview.querySelectorAll("[data-sponsor-preview-bullet]");
  assert.equal(previewBullets.length, 4);
  assert.deepEqual(
    previewBullets.map((li) => li.textContent),
    [
      "Sub-second CDC from Postgres and Snowflake",
      "Zero-maintenance schema evolution",
      "Declarative transformations in SQL",
      "SOC2 Type II and HIPAA ready",
    ],
  );

  closingInput.value = "Join the live engineering session on Thursday.";
  await closingInput.dispatch("input");
  assert.equal(
    preview.querySelector("[data-sponsor-preview-closing]").textContent,
    "Join the live engineering session on Thursday.",
  );

  // 5. Uploading a visual file updates the live preview image right away
  const visualFileInput = h.root.querySelector('[data-sponsor-visual-upload="graphicsUrl"]');
  assert.ok(visualFileInput, "Visual upload input is present");
  const fakePngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  visualFileInput.files = [
    {
      name: "acme-architecture.png",
      type: "image/png",
      arrayBuffer: async () => fakePngBytes.buffer,
    },
  ];
  await visualFileInput.dispatch("change");
  await nextTicks();

  const inlineImg = h.root.querySelector('img[data-sponsor-visual-image="graphicsUrl"]');
  assert.ok(inlineImg, "Inline brief image element is rendered in the field after upload");
  assert.equal(inlineImg.src, "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png");

  const previewImg = preview.querySelector("img[data-sponsor-preview-image]");
  assert.ok(previewImg, "Preview image element is rendered after visual upload");
  assert.equal(previewImg.src, "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png");
  assert.match(
    preview.querySelector("[data-sponsor-preview-visual-caption]").textContent,
    /acme-architecture\.png/,
  );

  // 6. Saving sends structured fields + serialized bullets + uploaded visual
  const saveDraftBtn = h.root.querySelector('[data-sponsor-action="save-draft"]');
  await saveDraftBtn.click();
  await nextTicks();

  const putCall = h.calls.find(([, opts]) => opts.method === "PUT");
  assert.ok(putCall);
  const savedBody = JSON.parse(putCall[1].body);
  assert.equal(
    savedBody.content.mainBodyOpening,
    "Here is what you will learn in our architecture deep dive:",
  );
  assert.equal(
    savedBody.content.bullets,
    [
      "- Sub-second CDC from Postgres and Snowflake",
      "- Zero-maintenance schema evolution",
      "- Declarative transformations in SQL",
      "- SOC2 Type II and HIPAA ready",
    ].join("\n"),
  );
  assert.equal(savedBody.content.closing, "Join the live engineering session on Thursday.");
  assert.equal(
    savedBody.content.graphicsUrl,
    "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png",
  );
  h.controller.destroy();
});

test("parseSponsorBulletItems and serializeSponsorBulletItems strip bullet prefixes cleanly", () => {
  assert.deepEqual(parseSponsorBulletItems("", 3), ["", "", ""]);
  assert.deepEqual(
    parseSponsorBulletItems("• First point\n- Second point\n→ Third point", 3),
    ["First point", "Second point", "Third point"],
  );
  assert.equal(
    serializeSponsorBulletItems(["• First point", "Second point", "  ", "→ Third point"]),
    "- First point\n- Second point\n- Third point",
  );
});

function podcastTemplateDefinition() {
  return {
    key: "podcast",
    label: "Podcast — Materials from the Guest",
    intro: "Use this form to confirm or change the recording slot.",
    sections: [
      {
        id: "scheduling",
        title: "1) Recording Time",
        description: "The invite proposes one recording time.",
        fields: [
          {
            key: "proposedSlotLabel",
            label: "Proposed time from the invite",
            type: "text",
            placeholder: "Pre-filled by Orin (Europe/Berlin)",
          },
          {
            key: "slotChoice",
            label: "Recording slot",
            type: "radio",
            placeholder: "Choose one",
            helpText: "One choice only — each option is a full date and time.",
            options: [
              { value: "confirm_proposed", label: "Yes — Mon 26 Oct · 12:30–13:30 Berlin works for me" },
              { value: "slot:2026-10-26:evening", label: "Mon 26 Oct · 17:00–18:00 Berlin" },
              { value: "slot:2026-10-27:midday", label: "Tue 27 Oct · 12:30–13:30 Berlin" },
              { value: "none_fit", label: "None of these work — just reply to the invite email and we’ll find an alternative" },
            ],
          },
        ],
      },
      {
        id: "who-you-are",
        title: "2) Who You Are",
        fields: [
          { key: "guestName", label: "Guest Name & Role / Company", type: "text" },
          { key: "introduction", label: "How would you like us to introduce you? (Bio)", type: "textarea", rows: 3 },
        ],
      },
      {
        id: "topics",
        title: "3) Topics",
        fields: [
          { key: "currentFocus", label: "What are you currently focused on?", type: "textarea", rows: 3 },
          { key: "topicsToCover", label: "Which topics are you most keen to cover?", type: "textarea", rows: 4 },
        ],
      },
      {
        id: "social-links",
        title: "4) Social Media & Profile Links",
        fields: [{ key: "linkedinUrl", label: "LinkedIn", type: "text" }],
      },
      {
        id: "detailed-questions",
        title: "5) Episode Story & Practical Takeaways (Optional)",
        collapsible: true,
        fields: [{ key: "hookAndPainPoint", label: "Hook & Listener Pain Point", type: "textarea", rows: 3 }],
      },
      {
        id: "notes",
        title: "6) Additional Notes (Optional)",
        collapsible: true,
        fields: [{ key: "sponsorNotes", label: "Anything else for the DataTalks.Club team?", type: "textarea", rows: 3 }],
      },
    ],
  };
}

test("podcast guest form renders radios with human slot labels, ordered sections, and no sponsor wording", async () => {
  const h = harness({
    href: "https://ops.example.test/podcast-docs/doc-pod?code=bcdfghjklmnpqrst",
    pathname: "/podcast-docs/doc-pod",
    docOverrides: {
      template: "podcast",
      title: "Podcast — Materials from the Guest",
      sponsorName: "Jane Doe",
      templateDefinition: podcastTemplateDefinition(),
      content: { guestName: "Jane Doe" },
    },
  });
  await h.controller.start();

  // /podcast-docs/ prefix is preserved in history (old /sponsor-docs/ still works for existing links)
  assert.deepEqual(h.history, [[null, "", "/podcast-docs/doc-pod"]]);

  // Section order: scheduling first, identity/topics/links, optional story + notes last
  const titles = h.root
    .querySelectorAll(".sponsor-doc-section__title")
    .map((node) => node.textContent);
  assert.deepEqual(titles, [
    "1) Recording Time",
    "2) Who You Are",
    "3) Topics",
    "4) Social Media & Profile Links",
    "5) Episode Story & Practical Takeaways (Optional)",
    "6) Additional Notes (Optional)",
  ]);

  // Slot picker is radios: one choice, each a full human datetime label
  const radios = h.root.querySelectorAll('[data-sponsor-radios="slotChoice"] input');
  assert.equal(radios.length, 4);
  const radioLabels = h.root
    .querySelectorAll('[data-sponsor-radios="slotChoice"] .sponsor-doc-radio__text')
    .map((node) => node.textContent);
  assert.ok(radioLabels[0].includes("Mon 26 Oct · 12:30–13:30 Berlin"));
  assert.deepEqual(radioLabels.slice(1, 3), [
    "Mon 26 Oct · 17:00–18:00 Berlin",
    "Tue 27 Oct · 12:30–13:30 Berlin",
  ]);
  assert.match(radioLabels[3], /reply to the invite email/);
  assert.ok(!radioLabels.some((label) => /slot:/.test(label)), "no raw slot: values in radio labels");
  assert.ok(
    h.root.querySelector('[data-sponsor-radio-band="free"]'),
    "free slots are banded under their own caption",
  );
  assert.match(
    h.root.querySelector('[data-sponsor-radio-band="free"]').textContent,
    /Or pick another free slot/,
  );

  // No custom-slot text input anywhere
  assert.equal(h.root.querySelector("#sponsor-field-customSlot"), null);

  // Optional sections render collapsed when empty (noise hidden, still expandable)
  const story = h.root.querySelector('[data-sponsor-collapsible="detailed-questions"]');
  assert.ok(story);
  assert.equal(story.tagName, "DETAILS");
  assert.equal(story.open, false);
  const notes = h.root.querySelector('[data-sponsor-collapsible="notes"]');
  assert.ok(notes);
  assert.equal(notes.open, false);

  // Guest-visible copy never says sponsor/sponsorship
  assert.ok(!/sponsor/i.test(h.root.textContent), `guest UI is sponsor-free: ${h.root.textContent}`);
  assert.ok(!/sponsor/i.test(h.identity.textContent));
  assert.match(h.root.textContent, /Guest: Jane Doe/);

  // Picking a radio saves the stored value, not the label
  await radios[2].dispatch("change");
  const saveDraftBtn = h.root.querySelector('[data-sponsor-action="save-draft"]');
  await saveDraftBtn.click();
  await nextTicks();
  const putCall = h.calls.find(([, opts]) => opts.method === "PUT");
  assert.ok(putCall);
  assert.equal(JSON.parse(putCall[1].body).content.slotChoice, "slot:2026-10-27:midday");
  h.controller.destroy();
});

test("webinar speaker form preserves its invite path, required labels and speaker wording", async () => {
  const h = harness({
    href: "https://ops.example.test/webinar-docs/doc-abc?code=bcdfghjklmnpqrst",
    docOverrides: { template: "webinar", title: "Speaker materials", sponsorName: "Test Speaker", markdownExport: "# Speaker materials", templateDefinition: { key: "webinar", label: "Webinar — Speaker Materials", sections: [{ id: "talk", title: "Your talk", fields: [
      { key: "talkTitle", label: "Talk title", type: "text", required: true },
      { key: "bio", label: "Speaker bio", type: "textarea", required: true },
      { key: "outline", label: "Outline (3–4 bullets)", type: "bullets", required: true, minItems: 3, maxItems: 4 },
    ] }] } },
  });
  await h.controller.start();
  assert.deepEqual(h.history, [[null, "", "/webinar-docs/doc-abc"]]);
  assert.match(h.identity.textContent, /Speaker access/);
  assert.match(h.root.textContent, /Speaker: Test Speaker/);
  assert.match(h.root.textContent, /Talk title \*/);
  assert.match(h.root.textContent, /Speaker bio \*/);
  assert.match(h.root.textContent, /Outline \(3–4 bullets\) \*/);
  assert.doesNotMatch(h.root.textContent, /sponsor|\bhub\b/i);
  assert.equal(h.root.querySelector("#sponsor-field-talkTitle").getAttribute("aria-required"), "true");
  const section = renderCardSponsorDocsSection({ sponsorDocs: [{ id: "doc-abc", template: "webinar", status: "submitted" }] });
  assert.match(section.textContent, /Speaker materials/);
  assert.equal(section.querySelector("a").href, "/webinar-docs/doc-abc");
  assert.equal(linkService("https://example.test/webinar-docs/doc-abc").id, "webinardoc");
  h.controller.destroy();
});


test("podcast header keeps event status out of its schedule text", async () => {
  for (const metadata of [
    { state: "tentative", date: "2030-12-03", label: "2030-12-03 (tentative; time not set)" },
    { state: "unscheduled", date: null, label: "Unscheduled" },
  ]) {
    const h = harness({ docOverrides: {
      template: "podcast", title: "Synthetic episode", publicationDate: null,
      eventMetadata: metadata, templateDefinition: podcastTemplateDefinition(),
    } });
    await h.controller.start();
    const schedule = h.root.querySelector('[data-sponsor-doc-event]');
    assert.equal(schedule?.textContent || "", metadata.date ? "2030-12-03 · Time not set" : "");
    assert.ok(h.root.querySelector(`[data-sponsor-event-status="${metadata.state}"]`));
    h.controller.destroy();
  }
});

test("scheduled podcast templates show the time without repeating the event status", async () => {
  for (const template of ["podcast", "podcast-guest-research", "podcast-run-sheet", "podcast-episode-brief"]) {
    const h = harness({ docOverrides: {
      template, title: "Synthetic episode", publicationDate: null,
      eventMetadata: {
        state: "confirmed", date: "2030-12-03", label: "3 Dec 2030 12:30 Europe/Berlin (confirmed)",
        startIso: "2030-12-03T11:30:00Z", endIso: "2030-12-03T12:30:00Z", durationMinutes: 60,
      },
      templateDefinition: podcastTemplateDefinition(),
    } });
    await h.controller.start();
    const schedule = h.root.querySelector('[data-sponsor-doc-event]');
    assert.match(schedule.textContent, /Berlin/);
    assert.match(schedule.textContent, /12:30/);
    assert.doesNotMatch(schedule.textContent, /confirmed|tentative|unscheduled/i);
    assert.ok(h.root.querySelector('[data-sponsor-event-status="confirmed"]'));
    h.controller.destroy();
  }
});

test("event fields render read-only and are excluded from document saves", async () => {
  const h = harness({ docOverrides: {
    template: "podcast-episode-brief",
    title: "Synthetic · 3 Dec 2030 12:30 Europe/Berlin (tentative)",
    publicationDate: null,
    eventMetadata: { label: "3 Dec 2030 12:30 Europe/Berlin (tentative)", state: "tentative", date: "2030-12-03", startIso: "2030-12-03T11:30:00Z", endIso: "2030-12-03T12:30:00Z", durationMinutes: 60 },
    content: { recordingDate: "3 Dec 2030 12:30 Europe/Berlin (tentative)", goal: "Authored goal" },
    templateDefinition: { label: "Episode brief", sections: [{ id: "overview", fields: [
      { key: "recordingDate", label: "Recording Date", type: "text", derived: "event-datetime" },
      { key: "goal", label: "Goal", type: "text" },
    ] }] },
  } });
  await h.controller.start();
  assert.ok(h.root.querySelector('[data-sponsor-derived-field="recordingDate"]'));
  assert.equal(h.root.querySelector('#sponsor-field-recordingDate'), null);
  assert.ok(h.root.querySelector('[data-sponsor-doc-event]'));
  await h.root.querySelector('[data-sponsor-action="save-draft"]').click();
  await nextTicks();
  const put = h.calls.find(([, opts]) => opts.method === "PUT");
  assert.deepEqual(JSON.parse(put[1].body).content, { goal: "Authored goal" });
});


test("guest portal shows dual zones and saves a time choice before required materials", async () => {
  const definition = podcastTemplateDefinition();
  definition.sections[0].fields[1].options[1] = { value: "slot:2030-12-03:evening", label: "Canonical choice", startIso: "2030-12-03T18:00:00Z", endIso: "2030-12-03T19:00:00Z" };
  definition.sections[1].fields[1].required = true;
  definition.sections[1].fields.push({ key: "photoUrl", label: "Photo", type: "text", allowVisualUpload: true, maxCharsHint: 300000 });
  const h = harness({ href: "https://ops.example.test/podcast-docs/doc-pod?code=bcdfghjklmnpqrst", pathname: "/podcast-docs/doc-pod", docOverrides: {
    template: "podcast", templateDefinition: definition,
    eventMetadata: { label: "Canonical Berlin time", startIso: "2030-12-02T18:00:00Z", endIso: "2030-12-02T19:00:00Z", durationMinutes: 60, version: 1 },
    content: { guestTimezone: "Asia/Kolkata" },
  } });
  await h.controller.start();
  assert.match(h.root.querySelector('[data-sponsor-doc-event]').textContent, /Tue, 3 Dec 2030/);
  assert.equal(h.root.querySelector('[data-sponsor-field-group="photoUrl"] .sponsor-doc-field__count').hidden, true);
  assert.equal(h.root.querySelector("#sponsor-field-proposedSlotLabel"), null);
  const zone = h.root.querySelector('[data-guest-timezone]');
  zone.value = "America/New_York"; await zone.dispatch("change");
  assert.match(h.root.querySelector('[data-sponsor-doc-event]').textContent, /America\/New_York/);
  const radios = h.root.querySelectorAll('[data-sponsor-radios="slotChoice"] input');
  await radios[1].dispatch("change");
  assert.match(h.root.querySelector('[data-sponsor-radio-option="slot:2030-12-03:evening"]').textContent, /Tue, 3 Dec 2030/);
  await h.root.querySelector('[data-sponsor-action="save-time-choice"]').click();
  await nextTicks();
  const putCall = h.calls.find(([, options]) => options.method === "PUT");
  const body = JSON.parse(putCall[1].body);
  assert.equal(body.content.slotChoice, "slot:2030-12-03:evening");
  assert.equal(body.content.guestTimezone, "America/New_York");
  assert.equal(body.status, undefined);
  assert.equal(body.content.introduction, undefined);
  assert.deepEqual(body.timeChoiceIntent, { choice: "slot:2030-12-03:evening", proposalStartIso: "2030-12-02T18:00:00Z", proposalVersion: 1 });
  await h.root.querySelector('[data-sponsor-action="save-draft"]').click();
  await nextTicks();
  const ordinarySave = h.calls.filter(([, options]) => options.method === "PUT").at(-1);
  assert.equal(JSON.parse(ordinarySave[1].body).timeChoiceIntent, undefined, "ordinary biography/material saves do not reconfirm the stored slot choice");
  h.controller.destroy();
});

test("a valid code on a staff-only doc says it is staff only and keeps the stored code", async () => {
  const h = harness({
    request: async () => {
      throw Object.assign(new Error("This document is for staff only."), { status: 403, code: "staff_only_document" });
    },
  });
  await h.controller.start();

  assert.match(h.root.textContent, /for staff only/);
  assert.ok(!/Invalid access code/.test(h.root.textContent));
  h.controller.destroy();
});

test("guest brief renders uploaded photo inline immediately and shows visible error for broken or bare-filename images", async () => {
  const guestDocOverrides = {
    template: "podcast",
    viewerRole: "sponsor",
    templateDefinition: {
      key: "podcast",
      label: "Podcast Guest Brief",
      intro: "Share your photo and bio.",
      sections: [
        {
          id: "guest",
          title: "Guest profile",
          fields: [
            { key: "guestName", label: "Name", type: "text", required: true },
            { key: "photoUrl", label: "Photo", type: "text", allowVisualUpload: true },
          ],
        },
      ],
    },
    content: {
      guestName: "Ada Lovelace",
      photoUrl: "ada-headshot.png",
    },
  };

  // 1. Existing brief holding only a bare filename shows a visible error, not a silent blank
  const h = harness({
    href: "https://ops.example.test/podcast-docs/doc-abc?code=bcdfghjklmnpqrst",
    pathname: "/podcast-docs/doc-abc",
    docOverrides: guestDocOverrides,
  });
  await h.controller.start();
  const filenameErr = h.root.querySelector('[data-sponsor-visual-error="photoUrl"]');
  assert.ok(filenameErr, "Bare filename shows visible error instead of silent blank");
  assert.match(filenameErr.textContent, /ada-headshot\.png/);

  // 2. Uploading a photo in the guest brief renders the image inline immediately (no reload)
  const fileInput = h.root.querySelector('[data-sponsor-visual-upload="photoUrl"]');
  const fakePngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  fileInput.files = [
    { name: "ada.png", type: "image/png", arrayBuffer: async () => fakePngBytes.buffer },
  ];
  await fileInput.dispatch("change");
  await nextTicks();

  const inlineImg = h.root.querySelector('img[data-sponsor-visual-image="photoUrl"]');
  assert.ok(inlineImg, "Guest brief renders inline image immediately after upload");
  assert.equal(inlineImg.src, "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png");
  assert.equal(h.root.querySelector('[data-sponsor-visual-error="photoUrl"]'), null);

  // 3. If an image fails to load, a visible error is shown and the broken img is hidden
  await inlineImg.dispatch("error");
  assert.equal(inlineImg.hidden, true);
  const brokenErr = h.root.querySelector('[data-sponsor-visual-error="photoUrl"]');
  assert.ok(brokenErr, "Broken image shows visible error");
  assert.match(brokenErr.textContent, /Could not load image/);
  h.controller.destroy();
});

test("guest photo upload states the 800 px rule, asks the server to enforce it, and shows its rejection as a request to the guest", async () => {
  const reports = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { reports.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  const tooSmall = "Thanks! The photo is a bit too small for our event picture. Could you upload a larger one, at least 800 × 800 pixels? A square headshot works best. (This one is 128 × 128.)";
  const doc = {
    viewerRole: "guest",
    template: "podcast",
    templateDefinition: {
      key: "podcast",
      label: "Podcast Guest Brief",
      sections: [{ id: "guest", title: "Guest profile", fields: [{ key: "photoUrl", label: "Photo", type: "text", allowVisualUpload: true }] }],
    },
    content: { photoUrl: "" },
  };
  try {
    const h = harness({
      href: "https://ops.example.test/podcast-docs/doc-abc?code=bcdfghjklmnpqrst",
      pathname: "/podcast-docs/doc-abc",
      docOverrides: doc,
      request: async (url, opts = {}) => {
        if (opts.method === "POST" && /\/images/.test(url)) {
          throw Object.assign(new Error(tooSmall), { status: 400, code: "guest_photo_too_small" });
        }
        return { doc: sampleDoc(doc) };
      },
    });
    await h.controller.start();
    const fileInput = h.root.querySelector('[data-sponsor-visual-upload="photoUrl"]');
    assert.equal(fileInput.accept, "image/png,image/jpeg,image/webp");
    assert.match(h.root.querySelector("[data-sponsor-visual-status]").textContent, /at least 800 × 800 px/);

    // A GIF never reaches the server.
    fileInput.files = [{ name: "me.gif", type: "image/gif", size: 10, arrayBuffer: async () => new ArrayBuffer(4) }];
    await fileInput.dispatch("change");
    await nextTicks();
    assert.match(h.root.querySelector('[data-sponsor-visual-error="photoUrl"]').textContent, /JPG, PNG or WebP/);
    assert.equal(h.calls.filter(([url]) => /\/images/.test(url)).length, 0);
    const reportsBefore = reports.length;

    fileInput.files = [{ name: "me.png", type: "image/png", size: 10, arrayBuffer: async () => new ArrayBuffer(8) }];
    await fileInput.dispatch("change");
    await nextTicks();
    const uploads = h.calls.filter(([url]) => /\/images/.test(url));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0][0], /\/images\?field=photoUrl$/);
    const err = h.root.querySelector('[data-sponsor-visual-error="photoUrl"]');
    assert.equal(err.textContent, tooSmall, "the guest sees the request verbatim, not an upload failure");
    assert.equal(reports.length, reportsBefore, "a too-small photo is not reported as a client error");
    h.controller.destroy();
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("podcast cards hide legacy prep templates, never show Sponsorship documents, and expose top link + live questions + sponsored flag", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = new FakeDocument();
  try {
  const { renderCardEventQuickBar } = await import("../src/surfaces/work-detail/card-documents.js");
  const card = {
    id: "card-pod-1",
    version: 3,
    templateDefinitionSnapshot: { type: "podcast" },
    sponsored: true,
    qna: { url: "https://qna.dtcdev.click/r/pod1" },
    sponsorDocs: [
      { id: "sdoc-pod", template: "podcast", status: "draft", title: "Guest doc" },
      { id: "sdoc-brief", template: "podcast-episode-brief", status: "submitted", title: "Brief" },
      { id: "sdoc-res", template: "podcast-guest-research", status: "draft", title: "Research" },
      { id: "sdoc-run", template: "podcast-run-sheet", status: "draft", title: "Run sheet" },
    ],
  };
  const section = renderCardSponsorDocsSection(card);
  assert.match(section.textContent, /Guest materials/);
  assert.doesNotMatch(section.textContent, /Sponsorship document/i);
  assert.equal(section.querySelectorAll("[data-sponsor-doc-id]").length, 1);
  assert.ok(section.querySelector('[data-sponsor-doc-id="sdoc-pod"]'));

  const calls = [];
  const bar = renderCardEventQuickBar({
    card,
    workApiUrl: (p) => p,
    reload: async () => {},
    request: async (url) => {
      calls.push(url);
      if (url.includes("/api/sponsor-docs/")) {
        return { doc: { content: { interviewQuestions: "1. What is FDE?" } } };
      }
      if (url.includes("/qna/questions")) {
        return { questions: [{ text: "How do you test agents?", authorName: "Alex", score: 2, status: "visible" }] };
      }
      return {};
    },
  });
  assert.ok(bar.querySelector('[data-card-podcast-doc-top-link]').href.includes("/podcast-docs/sdoc-pod"));
  assert.equal(bar.querySelector('[data-card-sponsored-toggle]').checked, true);

  await bar.querySelector('[data-card-live-questions-trigger]').click();
  await nextTicks();
  assert.ok(calls.some((u) => u.includes("/api/sponsor-docs/sdoc-pod")));
  assert.ok(calls.some((u) => u.includes("/api/cards/card-pod-1/qna/questions")));
  const panel = bar.querySelector('[data-card-live-questions-panel]');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /1\. What is FDE\?/);
  assert.match(panel.textContent, /How do you test agents\?/);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("podcast doc supports staff view-questions mode while isolating guests and showing photo preview placeholder", async () => {
  const definition = podcastTemplateDefinition();
  definition.sections[1].fields.push({ key: "photoUrl", label: "Photo", type: "text", allowVisualUpload: true });

  const guest = harness({
    href: "https://ops.example.test/podcast-docs/doc-q?code=bcdfghjklmnpqrst",
    pathname: "/podcast-docs/doc-q",
    docOverrides: {
      template: "podcast",
      viewerRole: "sponsor",
      markdownExport: "# Export",
      templateDefinition: definition,
      content: { topicsToCover: "Production reliability" },
    },
  });
  await guest.controller.start();
  assert.ok(guest.root.querySelector('[data-sponsor-photo-placeholder]'), "empty photoUrl shows preview placeholder");
  assert.equal(guest.root.querySelector('[data-podcast-tab]'), null, "guests never see the tab bar");
  assert.equal(guest.root.querySelector('[data-sponsor-action="toggle-questions-view"]'), null, "guests never see View questions");
  assert.equal(guest.root.querySelector('[data-sponsor-export]'), null, "guests never see Markdown export");
  guest.controller.destroy();

  const staff = harness({
    href: "https://ops.example.test/podcast-docs/doc-q",
    pathname: "/podcast-docs/doc-q",
    docOverrides: {
      template: "podcast",
      viewerRole: "staff",
      templateDefinition: definition,
      content: {
        interviewQuestions: "Q1: Why agents?\nQ2: How evals?",
        topicsToCover: "Production reliability",
      },
    },
  });
  await staff.controller.start();
  assert.ok(staff.root.querySelector('[data-sponsor-photo-placeholder]'), "staff Guest intake shows photo placeholder");
  await staff.root.querySelector('[data-sponsor-action="toggle-questions-view"]').click();
  await nextTicks();
  const ro = staff.root.querySelector('[data-podcast-questions-view="readonly"]');
  assert.ok(ro);
  assert.match(ro.textContent, /Q1: Why agents\?/);
  assert.match(ro.textContent, /Production reliability/);
  assert.equal(staff.root.querySelector('[data-sponsor-action="submit-ready"]'), null);
  staff.controller.destroy();
});

test("event cards filter out legacy /sponsor-docs/ cardLinks in renderCardLinksSection", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = new FakeDocument();
  try {
    const { renderCardLinksSection } = await import("../src/surfaces/work-detail/link-rows.js");
    const section = renderCardLinksSection({
      card: {
        id: "card-pod-2",
        tags: ["Podcast"],
        cardLinks: [
          { name: "Podcast document", url: "https://ops.dtcdev.click/podcast-docs/sdoc-canon" },
          { name: "Guest research", url: "https://ops.dtcdev.click/sponsor-docs/sdoc-legacy-res" },
          { name: "Host run sheet", url: "https://ops.dtcdev.click/sponsor-docs/sdoc-legacy-run" },
        ],
      },
      onSaveLink: () => {},
    });
    assert.match(section.textContent, /Podcast document/);
    assert.doesNotMatch(section.textContent, /Guest research/);
    assert.doesNotMatch(section.textContent, /Host run sheet/);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("Graphics renders the image with Upload/Replace (no URL text box), rejects bad files loudly, and accepts drag-drop", async () => {
  const existing = "https://ops.example.test/api/public-images/22222222-2222-4222-8222-222222222222.png";
  const h = harness({
    docOverrides: {
      content: { headline: "H", body: "B", ctaText: "C", ctaUrl: "https://acme.example.com", graphicsUrl: existing },
      templateDefinition: {
        ...sampleDoc().templateDefinition,
        sections: [{
          id: "newsletter-placement",
          title: "1) Newsletter Placement",
          fields: [
            { key: "headline", label: "Title / Headline", type: "text" },
            { key: "graphicsUrl", label: "Graphics", type: "text", allowVisualUpload: true },
          ],
        }],
      },
    },
  });
  await h.controller.start();

  const control = h.root.querySelector("#sponsor-field-graphicsUrl");
  assert.equal(control.type, "hidden", "the stored URL is not an editable text box");
  assert.equal(control.hidden, true);
  const img = h.root.querySelector('img[data-sponsor-visual-image="graphicsUrl"]');
  assert.ok(img, "the existing value renders as an image preview");
  assert.equal(img.src, existing);
  const uploadLabel = h.root.querySelector('[data-sponsor-visual-upload-label="graphicsUrl"]');
  assert.equal(uploadLabel.textContent, "Replace");
  assert.ok(h.root.querySelector('[data-sponsor-visual-preview="graphicsUrl"]').classList.contains("is-thumbnail"), "the editor shows the uploaded image as a thumbnail");

  // Wrong type: visible alert, no upload, current image kept.
  const fileInput = h.root.querySelector('[data-sponsor-visual-upload="graphicsUrl"]');
  fileInput.files = [{ name: "brief.pdf", type: "application/pdf", size: 1000, arrayBuffer: async () => new ArrayBuffer(4) }];
  await fileInput.dispatch("change");
  await nextTicks();
  let err = h.root.querySelector('[data-sponsor-visual-error="graphicsUrl"]');
  assert.ok(err, "type error is visible");
  assert.equal(err.getAttribute("role"), "alert");
  assert.match(err.textContent, /PNG, JPG, WebP, or GIF/);
  assert.ok(h.root.querySelector('img[data-sponsor-visual-image="graphicsUrl"]'), "current image still shown");
  assert.equal(h.calls.filter(([url]) => url.endsWith("/images")).length, 0);

  // Too large: visible alert naming the limit.
  fileInput.files = [{ name: "huge.png", type: "image/png", size: 5 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(4) }];
  await fileInput.dispatch("change");
  await nextTicks();
  err = h.root.querySelector('[data-sponsor-visual-error="graphicsUrl"]');
  assert.match(err.textContent, /over the 4 MiB limit/);
  assert.equal(h.calls.filter(([url]) => url.endsWith("/images")).length, 0);

  // Drag-drop a valid image: uploads to public-images and sets the field.
  const dropzone = h.root.querySelector('[data-sponsor-visual-preview="graphicsUrl"]');
  await dropzone.dispatch("drop", {
    dataTransfer: { files: [{ name: "new.png", type: "image/png", size: 8, arrayBuffer: async () => new ArrayBuffer(8) }] },
  });
  await nextTicks();
  assert.equal(h.calls.filter(([url]) => url.endsWith("/images")).length, 1);
  assert.equal(h.root.querySelector('[data-sponsor-visual-error="graphicsUrl"]'), null, "errors clear after a good upload");
  const uploaded = "https://ops.example.test/api/public-images/11111111-1111-4111-8111-111111111111.png";
  assert.equal(h.root.querySelector('img[data-sponsor-visual-image="graphicsUrl"]').src, uploaded);

  await h.root.querySelector('[data-sponsor-action="save-draft"]').click();
  await nextTicks();
  const putCall = h.calls.find(([, opts]) => opts.method === "PUT");
  assert.equal(JSON.parse(putCall[1].body).content.graphicsUrl, uploaded);
  h.controller.destroy();
});

test("Graphics upload failures surface as a visible error instead of failing silently", async () => {
  const h = harness({
    docOverrides: {
      content: { headline: "H", graphicsUrl: "" },
      templateDefinition: {
        ...sampleDoc().templateDefinition,
        sections: [{ id: "s", title: "S", fields: [{ key: "graphicsUrl", label: "Graphics", type: "text" }] }],
      },
    },
    request: async (url, opts) => {
      if (opts.method === "POST" && url.endsWith("/images")) {
        throw Object.assign(new Error("Image storage is unavailable"), { status: 503 });
      }
      return { doc: sampleDoc({
        content: { headline: "H", graphicsUrl: "" },
        templateDefinition: {
          ...sampleDoc().templateDefinition,
          sections: [{ id: "s", title: "S", fields: [{ key: "graphicsUrl", label: "Graphics", type: "text" }] }],
        },
      }) };
    },
  });
  await h.controller.start();
  assert.equal(h.root.querySelector('[data-sponsor-visual-upload-label="graphicsUrl"]').textContent, "Upload image");
  assert.ok(h.root.querySelector("[data-sponsor-photo-placeholder]"), "empty Graphics shows a drop placeholder");
  const fileInput = h.root.querySelector('[data-sponsor-visual-upload="graphicsUrl"]');
  fileInput.files = [{ name: "ok.png", type: "image/png", size: 8, arrayBuffer: async () => new ArrayBuffer(8) }];
  await fileInput.dispatch("change");
  await nextTicks();
  const err = h.root.querySelector('[data-sponsor-visual-error="graphicsUrl"]');
  assert.ok(err);
  assert.match(err.textContent, /Image upload failed: Image storage is unavailable/);
  h.controller.destroy();
});

test("sponsor share-link view never renders the internal staff panel", async () => {
  const h = harness();
  await h.controller.start();
  assert.equal(h.root.querySelector("[data-sponsor-staff-bar]"), null);
  for (const text of ["Owning task ID", "Copy share link", "Copy sponsor email", "Send from orin@", "Rotate code", "Open Card"]) {
    assert.ok(!h.root.textContent.includes(text), `sponsor view must not show "${text}"`);
  }
  h.controller.destroy();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5)).then(() => nextTicks(4));

test("UTM suggest button autosaves the helper-filled ctaUrl without a Save click", async () => {
  const h = harness({ autosaveDelayMs: 0 });
  await h.controller.start();
  const status = () => h.root.querySelector("[data-sponsor-save-status]");
  assert.equal(status().dataset.sponsorSaveState, "saved", "a freshly loaded doc is not dirty and is not re-saved");
  assert.equal(h.calls.filter(([, o]) => o.method === "PUT").length, 0);
  const applyBtn = h.root.querySelector('[data-sponsor-action="apply-utm-suggestion"]');
  assert.ok(applyBtn, "UTM suggestion button is offered for a ctaUrl without UTM");
  await applyBtn.click();
  await settle();
  const puts = h.calls.filter(([, o]) => o.method === "PUT");
  assert.equal(puts.length, 1, "helper-filled value is persisted automatically");
  const body = JSON.parse(puts[0][1].body);
  assert.match(body.content.ctaUrl, /utm_source=/);
  assert.equal(body.status, undefined, "autosave never changes the doc status");
  assert.equal(status().dataset.sponsorSaveState, "saved");
  assert.match(status().textContent, /All changes saved/);
  h.controller.destroy();
});

test("typing autosaves after the debounce; a failed autosave is loud and Retry saves", async () => {
  let failPuts = true;
  const puts = [];
  const h = harness({
    autosaveDelayMs: 0,
    request: async (url, opts = {}) => {
      if (opts.method === "PUT") {
        puts.push(JSON.parse(opts.body));
        if (failPuts) throw Object.assign(new Error("Could not save: it took too long to respond."), { status: "timeout" });
        return { doc: { ...sampleDoc(), content: { ...sampleDoc().content, ...puts.at(-1).content } } };
      }
      return { doc: sampleDoc() };
    },
  });
  await h.controller.start();
  const status = () => h.root.querySelector("[data-sponsor-save-status]");
  const input = h.root.querySelector("#sponsor-field-headline");
  input.value = "Edited";
  await input.dispatch("input");
  await settle();
  assert.equal(puts.length, 1, "edit is saved without a Save click");
  assert.equal(puts[0].content.headline, "Edited");
  assert.equal(status().dataset.sponsorSaveState, "error");
  assert.equal(status().getAttribute("role"), "alert");
  assert.match(status().textContent, /NOT SAVED: the server took too long to respond\. Your edits are still in this form; do not reload/);
  failPuts = false;
  await h.root.querySelector('[data-sponsor-action="retry-save"]').click();
  await settle();
  assert.equal(puts.length, 2);
  assert.equal(status().dataset.sponsorSaveState, "saved");
  h.controller.destroy();
});

test("a 4xx autosave failure is reported to the server, not only shown", async () => {
  const reports = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { reports.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  try {
    const h = harness({
      autosaveDelayMs: 0,
      request: async (url, opts = {}) => {
        if (opts.method === "PUT") throw Object.assign(new Error("Document is locked"), { status: 409 });
        return { doc: sampleDoc() };
      },
    });
    await h.controller.start();
    const input = h.root.querySelector("#sponsor-field-headline");
    input.value = "Edited";
    await input.dispatch("input");
    await settle();
    assert.match(h.root.querySelector("[data-sponsor-save-status]").textContent, /NOT SAVED: Document is locked/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], "/api/client-errors");
    assert.equal(reports[0][1].status, 409);
    h.controller.destroy();
  } finally {
    globalThis.fetch = prevFetch;
  }
});
