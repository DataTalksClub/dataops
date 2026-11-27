import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createSponsorDocPage } from "../src/surfaces/operations/sponsor-docs.js";
import {
  hasPodcastHostContent,
  isConfirmedPodcastRecording,
  isPodcastTwoTabDoc,
  renderPodcastInternalSubBar,
  renderPodcastTabBar,
  splitPodcastSections,
} from "../src/surfaces/operations/sponsor-doc-podcast.js";
import { FakeDocument, FakeElement, findByText, nextTicks } from "./support/fake-dom.mjs";

const savedDocument = globalThis.document;
const savedEvent = globalThis.CustomEvent;
const savedDakitTabs = globalThis.dakitTabs;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.CustomEvent = savedEvent;
  globalThis.dakitTabs = savedDakitTabs;
});

function fullPodcastDefinition() {
  return {
    key: "podcast",
    label: "Podcast — Materials from the Guest",
    intro: "Live conversation with Alexey with no slides.",
    guidelinesUrl: "https://datatalks.club/podcast-guide",
    guidelinesLabel: "How the podcast works",
    sections: [
      {
        id: "scheduling",
        tab: "guest",
        title: "1) Recording Time",
        description: "Pick or confirm a slot.",
        fields: [
          { key: "proposedSlotLabel", derived: "event-datetime", label: "Proposed time", type: "text" },
          {
            key: "slotChoice",
            label: "Recording slot",
            type: "radio",
            options: [
              { value: "confirm_proposed", label: "Confirm proposed" },
              { value: "slot:2026-12-01:midday", label: "Tue 1 Dec · 12:30 Berlin", startIso: "2026-12-01T11:30:00Z", endIso: "2026-12-01T12:30:00Z" },
              { value: "none_fit", label: "None of these work" },
            ],
          },
          { key: "guestTimezone", label: "Your time zone", type: "text" },
        ],
      },
      {
        id: "who-you-are",
        tab: "guest",
        title: "2) About You",
        fields: [
          { key: "guestName", label: "Guest Name & Role / Company", type: "text" },
          { key: "introduction", label: "Bio", type: "textarea", rows: 3 },
          { key: "photoUrl", label: "Photo", type: "text", allowVisualUpload: true },
        ],
      },
      {
        id: "topics",
        tab: "guest",
        title: "3) Topics",
        fields: [
          { key: "currentFocus", label: "Current focus", type: "textarea", rows: 3 },
          { key: "topicsToCover", label: "Topics to cover", type: "textarea", rows: 4 },
          { key: "topicsToAvoid", label: "Topics to avoid", type: "textarea", rows: 2 },
        ],
      },
      {
        id: "social-links",
        tab: "guest",
        title: "4) Links & Preparation Materials",
        fields: [
          { key: "linkedinUrl", label: "LinkedIn", type: "text" },
          { key: "twitterUrl", label: "X", type: "text" },
          { key: "githubUrl", label: "GitHub", type: "text" },
          { key: "websiteUrl", label: "Website", type: "text" },
        ],
      },
      {
        id: "interview-questions",
        tab: "guest",
        title: "7) Interview Questions",
        fields: [
          { key: "interviewQuestions", label: "Interview Questions", type: "textarea", rows: 6 },
        ],
      },
      {
        id: "run-sheet",
        tab: "internal",
        internal: true,
        title: "1) Run Sheet",
        fields: [
          { key: "coldOpen", label: "Cold Open", type: "textarea", rows: 2 },
          { key: "introScript", label: "Intro Script", type: "textarea", rows: 3 },
          { key: "closingScript", label: "Closing Script", type: "textarea", rows: 3 },
        ],
      },
      {
        id: "internal-research",
        tab: "internal",
        internal: true,
        collapsible: true,
        title: "Guest Research & Host Notes",
        fields: [
          { key: "sourceLinks", label: "Research Sources", type: "textarea", rows: 4 },
          { key: "hostNotes", label: "Host Notes & Follow-ups", type: "textarea", rows: 4 },
        ],
      },
    ],
  };
}

function createHarness(options = {}) {
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

  let currentDoc = {
    id: "sdoc-pod-1",
    cardId: "card-pod-1",
    template: "podcast",
    title: "Podcast — Web Scraping at Scale",
    sponsorName: "Julien Khaleghy",
    status: "draft",
    viewerRole: "staff",
    docUrl: "https://ops.example.test/podcast-docs/sdoc-pod-1",
    shareUrl: "https://ops.example.test/podcast-docs/sdoc-pod-1?code=BCDF-GHJK-LMNP-QRST",
    accessCode: "BCDF-GHJK-LMNP-QRST",
    emailDraft: { subject: "Podcast invite", body: "Please share your materials" },
    markdownExport: "# Podcast Export\n\n## Interview Questions\nQ1",
    eventMetadata: {
      label: "Tue, 1 Dec 2026 12:30 Europe/Berlin",
      startIso: "2026-12-01T11:30:00Z",
      endIso: "2026-12-01T12:30:00Z",
      durationMinutes: 60,
      version: 1,
    },
    templateDefinition: fullPodcastDefinition(),
    content: {},
    version: 1,
    ...options.docOverrides,
  };

  const controller = createSponsorDocPage({
    documentRef: doc,
    locationRef: {
      href: options.href || "https://ops.example.test/podcast-docs/sdoc-pod-1",
      pathname: options.pathname || "/podcast-docs/sdoc-pod-1",
    },
    historyRef: { replaceState: (...args) => history.push(args) },
    storageRef,
    clipboardRef: { writeText: async (text) => copied.push(text) },
    request: async (url, opts = {}) => {
      calls.push([url, opts]);
      if (options.request) return options.request(url, opts, currentDoc);
      if (opts.method === "PUT") {
        const body = JSON.parse(opts.body);
        currentDoc = {
          ...currentDoc,
          content: { ...currentDoc.content, ...(body.content || {}) },
          status: body.status || currentDoc.status,
          lastEditedAt: "2026-11-21T12:00:00.000Z",
          lastEditedBy: currentDoc.viewerRole === "staff" ? "staff" : "sponsor",
          version: currentDoc.version + 1,
        };
        return { doc: currentDoc };
      }
      if (url.endsWith("/rotate-code")) {
        currentDoc = {
          ...currentDoc,
          accessCode: "WXZ2-3456-789B-CDFG",
          shareUrl: "https://ops.example.test/podcast-docs/sdoc-pod-1?code=WXZ2-3456-789B-CDFG",
        };
        return { doc: currentDoc };
      }
      return { doc: currentDoc };
    },
  });

  return { root, identity, live, controller, calls, history, copied };
}

test("podcast helpers classify docs, split sections, check host content, and sync dakit tabs", () => {
  assert.equal(isPodcastTwoTabDoc({ template: "podcast" }), true);
  assert.equal(isPodcastTwoTabDoc({ template: "podcast-run-sheet" }), false);
  assert.equal(isPodcastTwoTabDoc({ template: "webinar" }), false);
  assert.equal(isPodcastTwoTabDoc(null), false);

  const { guestSections, internalSections } = splitPodcastSections([
    { id: "a", tab: "guest" },
    { id: "b" },
    { id: "c", tab: "internal" },
    { id: "d", internal: true },
  ]);
  assert.deepEqual(guestSections.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(internalSections.map((s) => s.id), ["c", "d"]);

  assert.equal(hasPodcastHostContent({}), false);
  assert.equal(hasPodcastHostContent({ interviewQuestions: "   \n  " }), false);
  assert.equal(hasPodcastHostContent({ coldOpen: "Hook!" }), true);
  assert.equal(hasPodcastHostContent({ hostNotes: "Timing cue" }), true);

  const synced = [];
  globalThis.dakitTabs = { sync: (node) => synced.push(node.getAttribute("aria-label")) };
  const doc = new FakeDocument(new FakeElement("div"));
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const bar = renderPodcastTabBar({ el, activeTab: "internal", onSelectTab: () => {} });
  assert.equal(bar.querySelector("#podcast-tab-guest").getAttribute("aria-selected"), "false");
  assert.equal(bar.querySelector("#podcast-tab-internal").getAttribute("aria-selected"), "true");
  const sub = renderPodcastInternalSubBar({ el, internalMode: "edit", onSelectMode: () => {} });
  assert.equal(sub.querySelector('[data-podcast-internal-mode="host"]').getAttribute("aria-selected"), "false");
  assert.equal(sub.querySelector('[data-podcast-internal-mode="edit"]').getAttribute("aria-selected"), "true");
  assert.deepEqual(synced, ["Podcast document tabs", "Internal view mode"]);
});

test("guest view shows interviewQuestions and blocks tab bar, internal sections, view-questions, markdown export, and ?tab=internal params", async () => {
  const h = createHarness({
    href: "https://ops.example.test/podcast-docs/sdoc-pod-1?code=bcdfghjklmnpqrst&tab=internal&view=questions",
    docOverrides: {
      viewerRole: "sponsor",
      shareUrl: undefined,
      accessCode: undefined,
      emailDraft: undefined,
      hostContext: { sponsored: true, qna: { url: "https://qna.example.test/r/1" } },
      content: {
        guestName: "Julien Khaleghy",
        topicsToCover: "Distributed crawling",
        interviewQuestions: "Q1: How does your browser fleet scale?",
        coldOpen: "Should never render for guest",
        hostNotes: "Private host note",
      },
    },
  });
  await h.controller.start();

  // ?code=, ?tab=, and ?view= are stripped from the URL for guests
  assert.equal(h.history.at(-1)[2], "/podcast-docs/sdoc-pod-1");
  assert.equal(h.root.querySelector("[data-podcast-tab-bar]"), null);
  assert.equal(h.root.querySelector('[data-podcast-panel="internal"]'), null);
  assert.equal(h.root.querySelector('[data-sponsor-action="toggle-questions-view"]'), null);
  assert.equal(h.root.querySelector("[data-sponsor-staff-bar]"), null);
  assert.equal(h.root.querySelector("[data-sponsor-export]"), null);
  assert.equal(h.root.querySelector("[data-podcast-sponsored-badge]"), null);
  assert.equal(h.root.querySelector("#sponsor-field-interviewQuestions").value, "Q1: How does your browser fleet scale?");
  assert.equal(h.root.querySelector("#sponsor-field-coldOpen"), null);
  assert.equal(h.root.querySelector("#sponsor-field-hostNotes"), null);
  assert.doesNotMatch(h.root.textContent, /Should never render for guest/);
  assert.doesNotMatch(h.root.textContent, /Private host note/);
  assert.doesNotMatch(h.root.textContent, /sponsor/i);
  assert.doesNotMatch(h.identity.textContent, /sponsor/i);

  // Guest timezone selector is mounted inside section 1 (Recording Time) and photo preview works
  const scheduling = h.root.querySelectorAll(".sponsor-doc-section")[0];
  assert.ok(scheduling.querySelector("[data-guest-timezone]"));
  assert.ok(h.root.querySelector("[data-sponsor-photo-placeholder]"));
  const radios = h.root.querySelectorAll('[data-sponsor-radios="slotChoice"] input');
  assert.equal(radios.length, 3);
  h.controller.destroy();
});

test("staff two-tab navigation smart-defaults Host/Edit modes, preserves unsaved edits, and saves internal changes", async () => {
  // 1. Empty host content -> clicking Internal smart-defaults to Edit prep & research
  const emptyH = createHarness({ docOverrides: { content: { guestName: "Ada Lovelace" } } });
  await emptyH.controller.start();

  assert.equal(emptyH.root.querySelector("#podcast-tab-guest").getAttribute("aria-selected"), "true");
  assert.ok(emptyH.root.querySelector('[data-podcast-panel="guest"]'));
  assert.match(emptyH.root.querySelector('[data-podcast-tab-notice="guest"]').textContent, /Shared with guest/);
  assert.equal(emptyH.root.querySelector("[data-sponsor-export]"), null, "markdown export hidden on Tab 1");

  // Timezone selector and guest intro live inside Tab 1, not shared headerCard
  const headerCard = emptyH.root.querySelector('[data-sponsor-view="editor"]');
  assert.equal(headerCard.querySelector("[data-guest-timezone]"), null);
  assert.equal(headerCard.querySelector(".dk-callout"), null);
  assert.ok(emptyH.root.querySelector('[data-podcast-panel="guest"] .dk-callout'));
  assert.ok(emptyH.root.querySelector('[data-podcast-panel="guest"] [data-guest-timezone]'));

  // Edit guest fields (including shared interviewQuestions) without saving, then switch to Internal tab
  const guestNameInput = emptyH.root.querySelector("#sponsor-field-guestName");
  guestNameInput.value = "Ada Lovelace (Edited)";
  await guestNameInput.dispatch("input");
  const questionsInput = emptyH.root.querySelector("#sponsor-field-interviewQuestions");
  assert.ok(questionsInput, "interviewQuestions is editable on Guest tab");
  questionsInput.value = "1. What inspired the Analytical Engine?";
  await questionsInput.dispatch("input");

  await emptyH.root.querySelector("#podcast-tab-internal").click();
  assert.equal(emptyH.root.querySelector("#podcast-tab-internal").getAttribute("aria-selected"), "true");
  // Smart-defaults to Host view now that interviewQuestions has content; switch to Edit mode
  assert.equal(
    emptyH.root.querySelector('[data-podcast-internal-mode="host"]').getAttribute("aria-selected"),
    "true",
  );
  await emptyH.root.querySelector('[data-podcast-internal-mode="edit"]').click();
  assert.equal(emptyH.history.at(-1)[2], "/podcast-docs/sdoc-pod-1?tab=internal");
  assert.match(emptyH.root.querySelector('[data-podcast-tab-notice="internal"]').textContent, /Staff only/);

  // Internal sections are expanded (no <details>) and exclude interviewQuestions
  assert.equal(emptyH.root.querySelector("#sponsor-field-interviewQuestions"), null);
  const coldOpenInput = emptyH.root.querySelector("#sponsor-field-coldOpen");
  assert.ok(coldOpenInput);
  assert.ok(emptyH.root.querySelector("#sponsor-field-hostNotes"), "internal-research expanded without details");
  coldOpenInput.value = "Hook: the first computer program.";
  await coldOpenInput.dispatch("input");

  // Switch back to Guest intake -> unsaved guest edits are still there
  await emptyH.root.querySelector("#podcast-tab-guest").click();
  assert.equal(emptyH.history.at(-1)[2], "/podcast-docs/sdoc-pod-1");
  assert.equal(emptyH.root.querySelector("#sponsor-field-guestName").value, "Ada Lovelace (Edited)");
  assert.equal(emptyH.root.querySelector("#sponsor-field-interviewQuestions").value, "1. What inspired the Analytical Engine?");

  // Switch back to Internal -> still in Edit mode and unsaved coldOpen edit is preserved
  await emptyH.root.querySelector("#podcast-tab-internal").click();
  assert.equal(emptyH.root.querySelector("#sponsor-field-coldOpen").value, "Hook: the first computer program.");

  // Save internal changes via PUT
  await findByText(emptyH.root, "Save internal changes", "button").click();
  await nextTicks();
  const putCall = emptyH.calls.find(([, opts]) => opts.method === "PUT");
  assert.ok(putCall);
  const sent = JSON.parse(putCall[1].body);
  assert.equal(sent.content.guestName, "Ada Lovelace (Edited)");
  assert.equal(sent.content.interviewQuestions, "1. What inspired the Analytical Engine?");
  assert.equal(sent.content.coldOpen, "Hook: the first computer program.");
  assert.match(emptyH.root.querySelector("[data-sponsor-feedback]").textContent, /Saved draft/);
  emptyH.controller.destroy();

  // 2. Populated host content + ?code= stripped while preserving ?tab=internal&view=questions
  const popH = createHarness({
    href: "https://ops.example.test/podcast-docs/sdoc-pod-1?code=bcdfghjklmnpqrst&tab=internal&view=questions",
    docOverrides: { content: { interviewQuestions: "Q1: Why?" } },
  });
  await popH.controller.start();
  assert.equal(popH.history[0][2], "/podcast-docs/sdoc-pod-1?tab=internal&view=questions");
  assert.ok(popH.root.querySelector('[data-podcast-questions-view="readonly"]'));
  assert.equal(
    popH.root.querySelector('[data-podcast-internal-mode="host"]').getAttribute("aria-selected"),
    "true",
  );
  popH.controller.destroy();
});

test("Host View renders Guest Snapshot, Run Sheet, Topics to Avoid warning, empty state, and Q&A states", async () => {
  const qnaResponses = [
    {
      questions: [
        { text: "How do you handle anti-bot blocks?", authorName: "Maria", score: 5, status: "visible" },
        { text: "Which proxy pool works best?", authorName: null, score: 1, status: "answered" },
      ],
    },
  ];
  const h = createHarness({
    href: "https://ops.example.test/podcast-docs/sdoc-pod-1?tab=internal&view=questions",
    docOverrides: {
      hostContext: {
        cardId: "card-pod-host",
        sponsored: true,
        qna: {
          url: "https://qna.dtcdev.click/r/web-scraping",
          presentUrl: "https://qna.dtcdev.click/admin/rooms/9/present",
        },
      },
      content: {
        guestName: "Julien Khaleghy, CTO at CrawlCo",
        introduction: "Building distributed scrapers for 10 years.",
        photoUrl: "/api/public-images/julien.png",
        linkedinUrl: "https://linkedin.com/in/julien",
        twitterUrl: "https://x.com/julien",
        githubUrl: "javascript:alert(1)",
        websiteUrl: "https://crawl.example.com",
        coldOpen: "What happens when 1B pages fail?",
        introScript: "Welcome Julien!",
        interviewQuestions: "1. Scale challenges\n2. Browser fleets",
        topicsToCover: "Headless orchestration",
        topicsToAvoid: "Proprietary client names",
        closingScript: "Thanks for joining!",
        hostNotes: "Keep Q3 short if behind schedule.",
      },
    },
    request: async (url) => {
      if (url === "/api/cards/card-pod-host/qna/questions") {
        if (qnaResponses.length === 0) throw new Error("Q&A unavailable");
        return qnaResponses.shift();
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  // Load initial doc directly via default handler by intercepting only Q&A
  const hWithDoc = createHarness({
    href: "https://ops.example.test/podcast-docs/sdoc-pod-1?tab=internal&view=questions",
    docOverrides: {
      hostContext: {
        cardId: "card-pod-host",
        sponsored: true,
        qna: {
          url: "https://qna.dtcdev.click/r/web-scraping",
          presentUrl: "https://qna.dtcdev.click/admin/rooms/9/present",
        },
      },
      content: {
        guestName: "Julien Khaleghy, CTO at CrawlCo",
        introduction: "Building distributed scrapers for 10 years.",
        photoUrl: "/api/public-images/julien.png",
        linkedinUrl: "https://linkedin.com/in/julien",
        twitterUrl: "https://x.com/julien",
        githubUrl: "javascript:alert(1)",
        websiteUrl: "https://crawl.example.com",
        coldOpen: "What happens when 1B pages fail?",
        introScript: "Welcome Julien!",
        interviewQuestions: "1. Scale challenges\n2. Browser fleets",
        topicsToCover: "Headless orchestration",
        topicsToAvoid: "Proprietary client names",
        closingScript: "Thanks for joining!",
        hostNotes: "Keep Q3 short if behind schedule.",
      },
    },
    request: async (url, _opts, currentDoc) => {
      if (url.startsWith("/api/sponsor-docs/")) return { doc: currentDoc };
      if (url === "/api/cards/card-pod-host/qna/questions") {
        if (qnaResponses.length === 0) throw new Error("Q&A server down");
        return qnaResponses.shift();
      }
      return {};
    },
  });
  h.controller.destroy();
  await hWithDoc.controller.start();

  const hostView = hWithDoc.root.querySelector('[data-podcast-questions-view="readonly"]');
  assert.ok(hostView);

  // Guest Snapshot: photo, name, time, bio, safe links only
  const photo = hostView.querySelector(".podcast-host-snapshot__photo");
  assert.ok(photo);
  assert.equal(photo.src, "/api/public-images/julien.png");
  await photo.dispatch("error");
  assert.equal(photo.hidden, true, "broken snapshot photo hides cleanly");

  assert.match(hostView.textContent, /Julien Khaleghy, CTO at CrawlCo/);
  assert.match(hostView.textContent, /Building distributed scrapers/);
  assert.match(hostView.textContent, /Berlin:/);
  const linkTexts = hostView.querySelectorAll(".podcast-host-links a").map((a) => a.textContent);
  assert.deepEqual(linkTexts, ["LinkedIn", "X", "Website"]);
  for (const a of hostView.querySelectorAll(".podcast-host-links a")) {
    assert.equal(a.target, "_blank");
    assert.equal(a.rel, "noopener noreferrer");
  }

  // Run Sheet blocks + Topics to Avoid warning styling
  assert.match(hostView.textContent, /Rough plan · ~1 hour · Intro 5m · Prepared questions 30–40m · Audience Q&A/);
  for (const text of [
    "What happens when 1B pages fail?",
    "Welcome Julien!",
    "1. Scale challenges",
    "Headless orchestration",
    "Proprietary client names",
    "Thanks for joining!",
    "Keep Q3 short if behind schedule.",
  ]) {
    assert.ok(hostView.textContent.includes(text), `missing host block text: ${text}`);
  }
  const avoidBlock = hostView.querySelector('[data-podcast-host-block="topicsToAvoid"]');
  assert.ok(avoidBlock.classList.contains("podcast-host-avoid"));

  // Live Audience Q&A one-click load + error handling
  const qnaBox = hostView.querySelector("[data-podcast-host-qna]");
  assert.match(qnaBox.textContent, /https:\/\/qna\.dtcdev\.click\/r\/web-scraping/);
  assert.match(qnaBox.textContent, /https:\/\/qna\.dtcdev\.click\/admin\/rooms\/9\/present/);
  await qnaBox.querySelector('[data-podcast-action="load-qna"]').click();
  await nextTicks();
  assert.ok(hWithDoc.calls.some(([u]) => u === "/api/cards/card-pod-host/qna/questions"));
  const qnaItems = hWithDoc.root.querySelectorAll(".podcast-host-qna__list li").map((li) => li.textContent);
  assert.deepEqual(qnaItems, [
    "How do you handle anti-bot blocks? — Maria (+5)",
    "Which proxy pool works best? — Anonymous ✓ answered",
  ]);
  assert.equal(hWithDoc.root.querySelector('[data-podcast-action="load-qna"]').textContent, "Refresh Q&A");

  // Refresh failure renders alert
  await hWithDoc.root.querySelector('[data-podcast-action="load-qna"]').click();
  await nextTicks();
  assert.match(hWithDoc.root.querySelector('[data-podcast-host-qna] [role="alert"]').textContent, /Q&A server down/);

  // Empty Host View + closed saved Q&A + "Add questions & run sheet" button
  const emptyHostH = createHarness({
    href: "https://ops.example.test/podcast-docs/sdoc-pod-1?tab=internal&view=questions",
    docOverrides: {
      hostContext: {
        qna: {
          url: "https://qna.dtcdev.click/r/closed",
          presentUrl: "https://qna.dtcdev.click/admin/rooms/closed/present",
          questionsSavedAt: "2026-12-01T13:30:00Z",
          questions: [{ text: "Saved Q1?", authorName: "Alex", score: 2, status: "visible" }],
        },
      },
      content: {},
    },
  });
  await emptyHostH.controller.start();
  assert.match(emptyHostH.root.textContent, /Audience Q&A \(closed, questions saved\)/);
  assert.doesNotMatch(emptyHostH.root.textContent, /rooms\/closed\/present/);
  assert.match(emptyHostH.root.textContent, /Saved Q1\? — Alex \(\+2\)/);
  assert.equal(emptyHostH.root.querySelector('[data-podcast-action="load-qna"]').textContent, "Show saved questions (1)");
  await emptyHostH.root.querySelector('[data-podcast-action="edit-prep"]').click();
  assert.equal(
    emptyHostH.root.querySelector('[data-podcast-internal-mode="edit"]').getAttribute("aria-selected"),
    "true",
  );
  hWithDoc.controller.destroy();
  emptyHostH.controller.destroy();
});

test("staff header shows Sponsored badge only when sponsored, clean guest wording, View questions shortcut, and collapsible export", async () => {
  // 1. Non-sponsored podcast doc: zero "sponsor" wording anywhere in staff UI
  const cleanH = createHarness({
    docOverrides: {
      hostContext: { sponsored: false },
      content: { interviewQuestions: "Q1: Tell us your story" },
    },
  });
  await cleanH.controller.start();
  assert.equal(cleanH.root.querySelector("[data-podcast-sponsored-badge]"), null);
  assert.doesNotMatch(cleanH.root.textContent, /sponsor/i, "non-sponsored podcast staff UI is sponsor-free");

  // Staff bar uses guest wording
  await findByText(cleanH.root, "Copy guest link", "button").click();
  assert.match(cleanH.root.querySelector("[data-sponsor-feedback]").textContent, /Copied shareable guest link with access code/);
  await findByText(cleanH.root, "Copy invitation email", "button").click();
  assert.match(cleanH.root.querySelector("[data-sponsor-feedback]").textContent, /Copied invitation email draft/);
  await findByText(cleanH.root, "Rotate code", "button").click();
  await nextTicks();
  assert.match(cleanH.root.querySelector("[data-sponsor-feedback]").textContent, /Previous guest links with the old code/);
  assert.match(cleanH.root.textContent, /Guests with the share link only see the Guest intake tab/);

  // Header "View questions" toggles directly to Internal Host view and back to Guest intake
  const viewQ = cleanH.root.querySelector('[data-sponsor-action="toggle-questions-view"]');
  assert.equal(viewQ.textContent, "View questions");
  await viewQ.click();
  assert.ok(cleanH.root.querySelector('[data-podcast-questions-view="readonly"]'));
  assert.equal(cleanH.history.at(-1)[2], "/podcast-docs/sdoc-pod-1?tab=internal&view=questions");
  assert.equal(cleanH.root.querySelector('[data-sponsor-action="toggle-questions-view"]').textContent, "Back to form");

  // Collapsible Markdown export on Internal tab starts collapsed and copies cleanly
  const exportDetails = cleanH.root.querySelector("details[data-sponsor-export]");
  assert.ok(exportDetails);
  assert.equal(exportDetails.open, false);
  await findByText(exportDetails, "Copy Markdown", "button").click();
  assert.match(cleanH.copied.at(-1), /# Podcast Export/);

  // Toggle back to Guest intake
  await cleanH.root.querySelector('[data-sponsor-action="toggle-questions-view"]').click();
  assert.ok(cleanH.root.querySelector('[data-podcast-panel="guest"]'));
  assert.equal(cleanH.history.at(-1)[2], "/podcast-docs/sdoc-pod-1");
  cleanH.controller.destroy();

  // 2. Sponsored podcast doc: staff header shows Sponsored badge
  const sponsoredH = createHarness({
    docOverrides: { hostContext: { sponsored: true } },
  });
  await sponsoredH.controller.start();
  const badge = sponsoredH.root.querySelector('[data-podcast-sponsored-badge="true"]');
  assert.ok(badge);
  assert.equal(badge.textContent, "Sponsored");
  assert.ok(badge.classList.contains("dk-badge"));
  sponsoredH.controller.destroy();
});

test("confirmed podcast recording collapses slot picker into one-line summary bar for both guest and staff", async () => {
  assert.equal(isConfirmedPodcastRecording({ template: "podcast", eventMetadata: { state: "confirmed" } }), true);
  assert.equal(isConfirmedPodcastRecording({ template: "podcast", eventMetadata: { state: "tentative" } }), false);
  assert.equal(isConfirmedPodcastRecording({ template: "webinar", eventMetadata: { state: "confirmed" } }), false);

  for (const viewerRole of ["sponsor", "staff"]) {
    const h = createHarness({
      href: viewerRole === "sponsor"
        ? "https://ops.example.test/podcast-docs/sdoc-pod-1?code=bcdfghjklmnpqrst"
        : "https://ops.example.test/podcast-docs/sdoc-pod-1",
      docOverrides: {
        viewerRole,
        eventMetadata: {
          state: "confirmed",
          label: "Tue, 1 Dec 2026 12:30 Europe/Berlin",
          startIso: "2026-12-01T11:30:00Z",
          endIso: "2026-12-01T12:30:00Z",
          durationMinutes: 60,
          version: 2,
        },
        content: {
          guestTimezone: "America/New_York",
          guestName: "Julien Khaleghy",
        },
      },
    });
    await h.controller.start();

    // Collapsed summary bar shown; full radio picker, timezone select, and save button hidden
    const summary = h.root.querySelector('[data-podcast-recording-summary="confirmed"]');
    assert.ok(summary, `${viewerRole}: renders confirmed summary bar`);
    assert.match(summary.querySelector(".dk-badge--success").textContent, /Confirmed/);
    assert.match(summary.querySelector(".podcast-recording-bar__time").textContent, /1 Dec 2026.*12:30–13:30.*Europe\/Berlin/);
    assert.match(summary.querySelector(".podcast-recording-bar__local").textContent, /Your time:.*America\/New_York/);
    assert.equal(h.root.querySelector('[data-sponsor-radios="slotChoice"]'), null);
    assert.equal(h.root.querySelector("[data-guest-timezone]"), null);
    assert.equal(h.root.querySelector('[data-sponsor-action="save-time-choice"]'), null);
    assert.equal(h.root.querySelector('[data-podcast-slot-picker="open"]'), null);

    // Click Change -> opens compact slot picker with timezone selector, radios, Save, and Cancel
    await h.root.querySelector('[data-podcast-action="change-recording-time"]').click();
    const picker = h.root.querySelector('[data-podcast-slot-picker="open"]');
    assert.ok(picker, `${viewerRole}: Change opens slot picker`);
    assert.ok(picker.querySelector(".sponsor-doc-timezone-row #guest-timezone-select[data-guest-timezone]"));
    assert.ok(picker.querySelector('[data-sponsor-radios="slotChoice"]'));
    assert.ok(picker.querySelector('[data-sponsor-action="save-time-choice"].sponsor-doc-time-save'));
    assert.ok(h.root.querySelector('[data-podcast-action="cancel-recording-time"]'));

    // Changing timezone inside the open picker keeps it open
    const tz = picker.querySelector("#guest-timezone-select");
    tz.value = "Asia/Tokyo";
    await tz.dispatch("change");
    assert.ok(h.root.querySelector('[data-podcast-slot-picker="open"]'), `${viewerRole}: picker stays open on timezone change`);
    assert.match(
      h.root.querySelector('[data-podcast-recording-summary="confirmed"] .podcast-recording-bar__local').textContent,
      /Asia\/Tokyo/,
    );

    // Clicking Cancel collapses back to the summary bar
    await h.root.querySelector('[data-podcast-action="cancel-recording-time"]').click();
    assert.equal(h.root.querySelector('[data-podcast-slot-picker="open"]'), null);
    assert.equal(h.root.querySelector('[data-sponsor-radios="slotChoice"]'), null);

    // Re-open, select slot, Save time choice -> submits timeChoiceIntent and collapses picker
    await h.root.querySelector('[data-podcast-action="change-recording-time"]').click();
    const radios = h.root.querySelectorAll('[data-sponsor-radios="slotChoice"] input');
    await radios[1].dispatch("change");
    await h.root.querySelector('[data-sponsor-action="save-time-choice"]').click();
    await nextTicks();

    const putCall = h.calls.find(([, opts]) => opts.method === "PUT");
    assert.ok(putCall);
    const body = JSON.parse(putCall[1].body);
    assert.deepEqual(body.timeChoiceIntent, {
      choice: "slot:2026-12-01:midday",
      proposalStartIso: "2026-12-01T11:30:00Z",
      proposalVersion: 2,
    });
    assert.equal(h.root.querySelector('[data-podcast-slot-picker="open"]'), null, "picker collapses after saving time choice");
    assert.ok(h.root.querySelector('[data-podcast-recording-summary="confirmed"]'));
    h.controller.destroy();
  }
});

test("tentative podcast recording shows compact slot picker open immediately without Change bar", async () => {
  const h = createHarness({
    docOverrides: {
      eventMetadata: {
        state: "tentative",
        label: "Tue, 1 Dec 2026 12:30 Europe/Berlin",
        startIso: "2026-12-01T11:30:00Z",
        endIso: "2026-12-01T12:30:00Z",
        durationMinutes: 60,
        version: 1,
      },
    },
  });
  await h.controller.start();

  assert.equal(h.root.querySelector('[data-podcast-recording-summary="confirmed"]'), null);
  assert.ok(h.root.querySelector(".sponsor-doc-timezone-row #guest-timezone-select[data-guest-timezone]"));
  assert.ok(h.root.querySelector('[data-sponsor-radios="slotChoice"]'));
  assert.ok(h.root.querySelector('[data-sponsor-action="save-time-choice"].sponsor-doc-time-save'));
  h.controller.destroy();
});

test("header separates clean H1, labeled status chips, schedule, and secondary Berlin timestamp", async () => {
  const h = createHarness({
    docOverrides: {
      viewerRole: "staff",
      title: "Jordan Taylor: Landing a Forward Deployed Engineer Role",
      status: "draft",
      lastEditedAt: "2026-11-25T07:52:00.000Z",
      lastEditedBy: "staff",
      lastEditedByName: "Orin Vale",
      eventMetadata: {
        state: "confirmed",
        label: "Tue, 12 Jan 2027 17:00 Europe/Berlin (confirmed)",
        startIso: "2027-01-12T16:00:00Z",
        endIso: "2027-01-12T17:00:00Z",
        durationMinutes: 60,
        version: 1,
      },
      templateDefinition: {
        key: "podcast",
        label: "Podcast — Materials from the Guest",
        sections: [
          {
            id: "who-you-are",
            title: "2) Who You Are",
            tab: "guest",
            fields: [
              { key: "guestName", label: "Name", type: "text", maxCharsHint: 120, maxChars: 120 },
              { key: "guestRole", label: "Role", type: "text", maxCharsHint: 120, maxChars: 120 },
              { key: "guestCompany", label: "Company", type: "text", maxCharsHint: 120, maxChars: 120 },
            ],
          },
          { id: "run-sheet", title: "Run Sheet", tab: "internal", internal: true, fields: [] },
        ],
      },
      content: {
        guestName: "Jordan Taylor",
        guestRole: "Forward Deployed Engineer",
        guestCompany: "Eliza",
      },
    },
  });
  await h.controller.start();

  const h1 = h.root.querySelector("h1.sponsor-doc-title");
  assert.equal(h1.textContent, "Jordan Taylor: Landing a Forward Deployed Engineer Role");
  assert.equal(h.root.querySelector('[data-sponsor-doc-status="draft"]').textContent, "Draft");
  assert.equal(h.root.querySelector('[data-sponsor-event-status="confirmed"]').textContent, "Confirmed");
  const statusRow = h.root.querySelector(".sponsor-doc-status-row");
  assert.match(statusRow.textContent, /Document/);
  assert.match(statusRow.textContent, /Event/);

  // Title and state share one line; type and last-edited join the single meta line.
  assert.ok(h.root.querySelector(".sponsor-doc-title-row .sponsor-doc-status-row"), "status chips sit on the title line");
  const secondary = h.root.querySelector(".sponsor-doc-meta");
  assert.match(secondary.textContent, /Podcast — Materials from the Guest/);
  assert.match(secondary.textContent, /Last edited 25 Nov 2026, 08:52 CET \(Europe\/Berlin\) by staff \(Orin Vale\)/);

  // Three identity fields with char-count hints and validation
  assert.equal(h.root.querySelector("#sponsor-field-guestName").value, "Jordan Taylor");
  assert.equal(h.root.querySelector("#sponsor-field-guestRole").value, "Forward Deployed Engineer");
  assert.equal(h.root.querySelector("#sponsor-field-guestCompany").value, "Eliza");
  assert.match(h.root.querySelector('[data-sponsor-field-group="guestName"] .sponsor-doc-field__count').textContent, /13 \/ 120 chars/);

  // Host view snapshot renders Name + Role · Company
  await h.root.querySelector('[data-podcast-tab="internal"]').click();
  await h.root.querySelector('[data-podcast-internal-mode="host"]').click();
  assert.equal(h.root.querySelector(".podcast-host-snapshot__name").textContent, "Jordan Taylor");
  assert.equal(h.root.querySelector(".podcast-host-snapshot__role").textContent, "Forward Deployed Engineer · Eliza");

  // Validation rejects over-limit identity fields on submit
  await h.root.querySelector('[data-podcast-tab="guest"]').click();
  const roleInput = h.root.querySelector("#sponsor-field-guestRole");
  roleInput.value = "r".repeat(121);
  await roleInput.dispatch("input");
  await h.root.querySelector('[data-sponsor-action="submit-ready"]').click();
  assert.match(h.root.querySelector('[data-sponsor-field-error="guestRole"]').textContent, /at most 120 characters/);

  h.controller.destroy();
});
