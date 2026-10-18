import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createNewsletterPreviewPage } from "../src/surfaces/operations/newsletter-preview.js";
import { FakeDocument, FakeElement, findByText, nextTicks } from "./support/fake-dom.mjs";

const savedDocument = globalThis.document;
const savedEvent = globalThis.CustomEvent;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.CustomEvent = savedEvent;
});

function samplePreviewPayload(overrides = {}) {
  return {
    issueId: "issue-phoenix",
    cardId: "card-phoenix",
    label: "Stand-alone newsletter",
    kind: "standalone",
    publicationDate: "2026-10-21",
    publicationTime: "14:00",
    issueNumber: null,
    status: "planned",
    sponsors: { primary: "Phoenix AI" },
    viewerRole: "external",
    previewUrl: "https://ops.example.test/newsletter-issues/issue-phoenix/preview",
    markdown: {
      issue: "Subject: Next Query 2026\n\nPreview: Free summit\n\n# Next Query 2026\n\n[Register free](https://nextquery.phoenixdata.ai)",
      sources: "# Sources\n\n- Card 2fe23a82",
      brief: "# Brief\n\n- Stand-alone sponsor email",
      updatedAt: "2026-10-18T16:00:00.000Z",
      updatedBy: "staff-1",
      updatedByName: "Alexey Staff",
    },
    rendered: {
      frontmatter: {
        type: "standalone",
        sponsor: "PhoenixAI",
        mailchimp_campaign: "https://us19.admin.mailchimp.com/campaigns/edit?id=15816466",
      },
      subject: "Next Query 2026",
      previewText: "Free summit",
      issueHtml: "<h1>Next Query 2026</h1><p class=\"newsletter-preview-cta\"><a class=\"newsletter-preview-cta__link\" href=\"https://nextquery.phoenixdata.ai\">Register free</a></p>",
      sourcesHtml: "<h1>Sources</h1><ul><li>Card 2fe23a82</li></ul>",
      briefHtml: "<h1>Brief</h1><ul><li>Stand-alone sponsor email</li></ul>",
    },
    version: 2,
    ...overrides,
  };
}

function harness(options = {}) {
  const root = new FakeElement("section");
  root.id = "newsletter-preview-root";
  const identity = new FakeElement("span");
  identity.id = "newsletter-preview-identity";
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
    href: options.href || "https://ops.example.test/newsletter-issues/issue-phoenix/preview?code=23456789abcdefgh",
    pathname: options.pathname || "/newsletter-issues/issue-phoenix/preview",
  };

  let currentPayload = samplePreviewPayload(options.payloadOverrides);
  const validCode = options.validCode || "2345-6789-ABCD-EFGH";

  const controller = createNewsletterPreviewPage({
    documentRef: doc,
    locationRef,
    historyRef: { replaceState: (...args) => history.push(args) },
    storageRef,
    clipboardRef: { writeText: async (text) => copied.push(text) },
    request: async (url, opts = {}) => {
      calls.push([url, opts]);
      if (options.request) return options.request(url, opts);

      const headerCode = opts.headers?.["x-newsletter-preview-code"] || "";
      if (currentPayload.viewerRole !== "staff") {
        if (!headerCode) {
          const err = new Error("Access code is required");
          err.status = 401;
          err.code = "access_code_required";
          throw err;
        }
        if (headerCode !== validCode) {
          const err = new Error("Invalid access code");
          err.status = 403;
          err.code = "invalid_access_code";
          throw err;
        }
      }

      if (opts.method === "PUT") {
        const body = JSON.parse(opts.body || "{}");
        currentPayload = {
          ...currentPayload,
          markdown: {
            ...currentPayload.markdown,
            ...body,
            updatedAt: "2026-10-18T17:00:00.000Z",
            updatedByName: "Alexey Staff",
          },
        };
      }
      if (url.endsWith("/rotate-code") && opts.method === "POST") {
        currentPayload = {
          ...currentPayload,
          accessCode: "WXYZ-2345-6789-ABCD",
          shareUrl: "https://ops.example.test/newsletter-issues/issue-phoenix/preview?code=WXYZ-2345-6789-ABCD",
        };
      }
      return currentPayload;
    },
  });

  return { root, identity, live, calls, history, copied, store, controller };
}

test("newsletter preview page unlocks with ?code= query parameter, strips code from URL, and renders HTML preview tabs", async () => {
  const { root, identity, history, copied, controller } = harness();
  await controller.start();
  await nextTicks();

  assert.equal(history.length, 1);
  assert.equal(history[0][2], "/newsletter-issues/issue-phoenix/preview");
  assert.match(identity.textContent, /Preview access · Code verified/);

  const canvas = root.querySelector('[data-preview-canvas="issue"]');
  assert.ok(canvas);
  assert.match(canvas.innerHTML, /Next Query 2026/);

  const copySubj = root.querySelector('[data-preview-action="copy-subject"]');
  copySubj.dispatch("click");
  await nextTicks();
  assert.equal(copied.at(-1), "Next Query 2026");

  const copyPrev = root.querySelector('[data-preview-action="copy-preview-text"]');
  copyPrev.dispatch("click");
  await nextTicks();
  assert.equal(copied.at(-1), "Free summit");

  // Switch to brief tab, sources tab, and raw tab
  root.querySelector('[data-preview-tab="brief"]').dispatch("click");
  assert.ok(root.querySelector('[data-preview-canvas="brief"]'));

  root.querySelector('[data-preview-tab="sources"]').dispatch("click");
  assert.ok(root.querySelector('[data-preview-canvas="sources"]'));

  root.querySelector('[data-preview-tab="raw"]').dispatch("click");
  const copyRawIssue = root.querySelector('[data-preview-action="copy-raw-issue"]');
  copyRawIssue.dispatch("click");
  await nextTicks();
  assert.match(copied.at(-1), /Subject: Next Query 2026/);

  // Lock returns to gate
  const lockBtn = identity.querySelector('[data-preview-action="lock"]');
  lockBtn.dispatch("click");
  assert.ok(root.querySelector('[data-preview-view="gate"]'));
  controller.destroy();
});

test("newsletter preview page shows gate when code is missing or invalid and unlocks when entered", async () => {
  const { root, controller } = harness({
    href: "https://ops.example.test/newsletter-issues/issue-phoenix/preview?code=9999999999999999",
  });
  await controller.start();
  await nextTicks();

  assert.ok(root.querySelector('[data-preview-view="gate"]'));
  assert.match(root.querySelector("[data-preview-gate-error]").textContent, /Invalid access code/);

  const input = root.querySelector("#newsletter-preview-code-input");
  input.value = "2345-6789-ABCD-EFGH";
  input.dispatch("input");
  const form = root.querySelector("form");
  form.dispatch("submit", { preventDefault() {} });
  await nextTicks();

  assert.ok(root.querySelector('[data-preview-view="ready"]'));
});

test("staff viewer sees shareable preview link, rotates code, and edits Markdown package in portal", async () => {
  const { root, copied, calls, controller } = harness({
    href: "https://ops.example.test/newsletter-issues/issue-phoenix/preview",
    payloadOverrides: {
      viewerRole: "staff",
      accessCode: "2345-6789-ABCD-EFGH",
      shareUrl: "https://ops.example.test/newsletter-issues/issue-phoenix/preview?code=2345-6789-ABCD-EFGH",
    },
  });
  await controller.start();
  await nextTicks();

  assert.ok(root.querySelector("[data-preview-staff-bar]"));

  const copyShareBtn = root.querySelector('[data-preview-action="copy-share-url"]');
  copyShareBtn.dispatch("click");
  await nextTicks();
  assert.equal(
    copied.at(-1),
    "https://ops.example.test/newsletter-issues/issue-phoenix/preview?code=2345-6789-ABCD-EFGH",
  );

  // Open Markdown editor and save
  const toggleEditBtn = root.querySelector('[data-preview-action="toggle-edit"]');
  toggleEditBtn.dispatch("click");
  const issueField = root.querySelector('[data-markdown-field="issue"]');
  assert.ok(issueField);
  issueField.value = "# Updated Issue Copy";
  issueField.dispatch("input");

  const editorForm = root.querySelector("[data-preview-editor] form");
  editorForm.dispatch("submit", { preventDefault() {} });
  await nextTicks();

  const putCall = calls.find(([, opts]) => opts.method === "PUT");
  assert.ok(putCall);
  assert.equal(JSON.parse(putCall[1].body).issue, "# Updated Issue Copy");

  // Rotate code
  const rotateBtn = root.querySelector('[data-preview-action="rotate-code"]');
  rotateBtn.dispatch("click");
  await nextTicks();
  assert.match(
    root.querySelector("[data-preview-feedback]").textContent,
    /Rotated preview access code/,
  );
});
