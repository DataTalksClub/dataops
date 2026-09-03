import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  buildReviewQueue,
  reviewReason,
  reviewSummary,
} from "../src/surfaces/review/model.js";
import { createReviewSurface } from "../src/surfaces/review/index.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

const checklist = {
  purpose: "pass",
  procedure: "pass",
  validation: "pass",
  troubleshooting: "pass",
  references: "na",
  ownership: "pass",
};

function documentRecord(id, overrides = {}) {
  return {
    id,
    title: id,
    path: `content/processes/${id}.md`,
    status: "proposed",
    criticality: "supporting",
    department: "Operations",
    business_system: "DataOps",
    owner_role: "Operations owner",
    tools: ["DataOps"],
    summary: "A reviewable process document.",
    updated_at: 100,
    ...overrides,
  };
}

function reviewRecord(document, overrides = {}) {
  return {
    id: `review-${document.id}`,
    documentId: document.id,
    documentPath: document.path,
    documentUpdatedAt: document.updated_at,
    decision: "approved",
    feedback: "",
    checklist,
    reviewerId: "operator-1",
    reviewedAt: "2026-09-03T10:00:00.000Z",
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

function apiUrl(path) {
  return new URL(path, "https://dataops.test");
}

describe("document review model", () => {
  test("derives review reasons, stale evidence, and priority from live metadata", () => {
    const current = documentRecord("current", { criticality: "core" });
    const changed = documentRecord("changed", { updated_at: 200 });
    const blocked = documentRecord("blocked", { status: "blocked" });
    const queue = buildReviewQueue(
      [
        current,
        changed,
        blocked,
        documentRecord("historical", { status: "archived" }),
      ],
      [
        reviewRecord(current),
        reviewRecord(changed, { documentUpdatedAt: 100 }),
        reviewRecord(blocked, { decision: "blocked", feedback: "Needs owner input." }),
      ],
      Date.parse("2026-09-03T12:00:00.000Z"),
    );

    assert.equal(queue.find((item) => item.id === "changed")?.needsReview, true);
    assert.equal(reviewReason(changed, queue.find((item) => item.id === "changed")?.review, Date.now()), "Document changed since the last review");
    assert.equal(queue.find((item) => item.id === "blocked")?.state, "Blocked");
    assert.equal(queue[0].id, "blocked");
    assert.equal(queue.find((item) => item.id === "historical")?.needsReview, false);
    assert.deepEqual(reviewSummary(queue), {
      total: 4,
      needsReview: 2,
      reviewed: 1,
      changesRequested: 0,
      blocked: 1,
    });
  });
});

describe("Document review surface", () => {
  test("renders the audit queue, previews the selected document, and records feedback", async () => {
    const documentList = new FakeElement("main");
    const document = new FakeDocument(documentList);
    document.body = new FakeElement("body");
    const first = documentRecord("sop.publish");
    const second = documentRecord("sop.archive", {
      title: "Archive a process",
      status: "draft",
      criticality: "core",
      updated_at: 110,
    });
    const reviews = [
      reviewRecord(first),
      reviewRecord(second, {
        decision: "changes_requested",
        feedback: "Add a validation example.",
        checklist: { ...checklist, validation: "needs_work" },
      }),
    ];
    let route = { params: new URLSearchParams() };
    const calls = [];
    const state = { reviewSnapshot: { loaded: true, reviews, errors: [] } };
    const surface = createReviewSurface({
      apiUrl,
      documentList,
      documentRef: document,
      getActiveWorkspaceRoute: () => route,
      getActiveWorkspaceView: () => "review",
      getDocsAvailability: () => ({ state: "ready" }),
      navigateCanonicalWorkspace: (path, params) => {
        calls.push(["navigate", path, params]);
        route = { params: new URLSearchParams(params) };
      },
      openDocument: (path) => calls.push(["open", path]),
      refreshDocuments: () => calls.push(["refresh-documents"]),
      renderHonestState: () => null,
      request: async (url, options = {}) => {
        calls.push([options.method || "GET", String(url)]);
        if (options.method === "POST") {
          const body = JSON.parse(options.body);
          const selected = body.documentId === second.id ? second : first;
          const saved = reviewRecord(selected, {
            id: "review-new",
            decision: body.decision,
            feedback: body.feedback,
            checklist: body.checklist,
          });
          reviews.unshift(saved);
          return { review: saved };
        }
        if (String(url).includes("/api/document-reviews/")) {
          const documentId = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
          const review = reviews.find((item) => item.documentId === documentId);
          return { review, history: review ? [review] : [] };
        }
        if (String(url).includes("/docs?path=")) {
          return { content: "# Publish the newsletter\n\nRun the documented steps." };
        }
        return { reviews };
      },
      reviewState: state,
      setRouteTitle: (title) => calls.push(["title", title]),
    });

    state.reviewSnapshot = { loaded: false, reviews: [], errors: [] };
    surface.renderReviewSurface([first, second]);
    assert.ok(findByText(documentList, "Loading review evidence"));

    state.reviewSnapshot = { loaded: true, reviews, errors: [] };
    surface.renderReviewSurface([first, second]);
    await nextTicks(3);

    assert.ok(findByText(documentList, "Document review"));
    assert.equal(findAllByClass(documentList, "review-queue-item").length, 1);
    assert.ok(findByText(documentList, "# Publish the newsletter\n\nRun the documented steps.", ".review-markdown-preview"));
    assert.ok(findByText(documentList, "Add a validation example."));

    const filter = documentList.querySelector('[name="review-filter"]');
    filter.value = "changes";
    await filter.dispatch("change");
    assert.equal(findAllByClass(documentList, "review-queue-item").length, 1);
    assert.ok(findByText(documentList, "Archive a process"));

    const feedback = documentList.querySelector('[name="feedback"]');
    feedback.value = "Clarify the owner handoff.";
    await documentList.querySelector('[data-review-decision="changes_requested"]').click();
    await nextTicks(4);

    assert.ok(calls.some(([method, url]) => method === "POST" && url.endsWith("/api/document-reviews")));
    assert.ok(findByText(documentList, "Review evidence saved. The document lifecycle remains unchanged."));
    assert.deepEqual(calls.find(([kind]) => kind === "navigate"), undefined);
  });
});
