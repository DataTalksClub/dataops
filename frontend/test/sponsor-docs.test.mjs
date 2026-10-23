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
  assert.match(h.root.textContent, /Last edited 2026-10-17 20:30 UTC by sponsor/);

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
  assert.match(preview.textContent, /Stand-Alone Blast/);

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

  const previewImg = preview.querySelector("img[data-sponsor-preview-image]");
  assert.ok(previewImg, "Preview image element is rendered after visual upload");
  assert.match(previewImg.src, /^data:image\/png;base64,/);
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
  assert.match(savedBody.content.graphicsUrl, /^data:image\/png;base64,/);
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
