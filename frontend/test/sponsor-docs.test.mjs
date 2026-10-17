import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { linkService } from "../src/core/links.js";
import { createSponsorDocPage } from "../src/surfaces/operations/sponsor-docs.js";
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
      guidelines: ["Title max 80 characters", "Include UTM tags"],
      fields: [
        { key: "headline", label: "Title / Headline", required: true, maxChars: 80, multiline: false },
        { key: "body", label: "Main Copy", required: true, maxChars: 900, multiline: true },
        { key: "ctaText", label: "CTA Label", required: true, maxChars: 50, multiline: false },
        { key: "ctaUrl", label: "CTA Link", required: true, multiline: false },
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

  assert.match(h.root.textContent, /Enter sponsor access code/);
  assert.match(h.root.textContent, /Invalid access code/);

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
  assert.match(h.root.textContent, /Enter sponsor access code/);
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
});
