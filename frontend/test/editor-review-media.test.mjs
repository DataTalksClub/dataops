import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createEditorReviewMedia } from "../src/surfaces/document-editor/review-media.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
const originalFileReader = globalThis.FileReader;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalFileReader === undefined) delete globalThis.FileReader;
  else globalThis.FileReader = originalFileReader;
});

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function note(message) {
  const value = new FakeElement("p");
  value.textContent = message;
  return value;
}

function createHarness(options = {}) {
  const diffBody = new FakeElement("div");
  const diffModal = new FakeElement("div");
  diffModal.hidden = true;
  const diffTitle = new FakeElement("h2");
  const editorView = new FakeElement("section");
  editorView.dataset.mode = options.mode || "rendered";
  const lightbox = new FakeElement("div");
  lightbox.hidden = true;
  const lightboxCaption = new FakeElement("p");
  const lightboxImg = new FakeElement("img");
  const lintModal = new FakeElement("div");
  lintModal.hidden = true;
  const lintModalBody = new FakeElement("div");
  const lintOpenButton = new FakeElement("button");
  const lintSummary = new FakeElement("span");
  const document = new FakeDocument();
  globalThis.document = document;
  const requests = [];
  const opened = [];
  const screenshots = [];
  const editorState = {
    lastFocusedProcedure: options.procedure || { id: "procedure-1" },
    lastFocusedStep: options.step || { id: "step-1" },
  };
  const media = createEditorReviewMedia(
    {
      apiUrl: (path) => new URL(path, "https://portal.test"),
      diffBody,
      diffModal,
      diffTitle,
      editorView,
      lightbox,
      lightboxCaption,
      lightboxImg,
      lintModal,
      lintModalBody,
      lintOpenButton,
      lintSummary,
      openDocument: (path) => opened.push(path),
      request: async (url) => {
        requests.push(String(url));
        if (options.requestError) throw new Error(options.requestError);
        if (String(url).includes("/lint")) return options.lintPayload || {};
        return options.docPayload || { content: "saved" };
      },
      storage: options.storage || storage({ "draft:content/process.md": "draft" }),
    },
    {
      addScreenshot: (...args) => screenshots.push(args),
      draftKey: (path) => `draft:${path}`,
      emptyNote: note,
    },
    editorState,
  );
  return {
    diffBody,
    diffModal,
    diffTitle,
    editorState,
    editorView,
    lightbox,
    lightboxCaption,
    lightboxImg,
    lintModal,
    lintModalBody,
    lintOpenButton,
    lintSummary,
    media,
    opened,
    requests,
    screenshots,
  };
}

describe("Document Editor review and media behavior", () => {
  test("renders a clean corpus lint result and always clears busy state", async () => {
    const harness = createHarness({ lintPayload: { docs: [] } });
    await harness.media.openLintReport();
    assert.equal(harness.lintModal.hidden, false);
    assert.equal(harness.lintSummary.textContent, "clean");
    assert.equal(
      harness.lintModalBody.textContent,
      "No violations across the corpus 🎉",
    );
    assert.equal(harness.lintOpenButton.classList.contains("is-busy"), false);
    assert.deepEqual(harness.requests, ["https://portal.test/lint"]);
  });

  test("renders lint violations and opens the selected internal Process Doc", async () => {
    const harness = createHarness({
      lintPayload: {
        total_violations: 2,
        docs: [
          {
            path: "content/process.md",
            violations: ["Missing owner", "Missing validation"],
          },
        ],
      },
    });
    await harness.media.openLintReport();
    assert.equal(harness.lintSummary.textContent, "1 docs · 2 violations");
    assert.equal(harness.lintModalBody.children.length, 1);
    const row = harness.lintModalBody.children[0];
    assert.equal(row.textContent.includes("Missing owner"), true);
    await row.children[0].dispatch("click");
    assert.equal(harness.lintModal.hidden, true);
    assert.deepEqual(harness.opened, ["content/process.md"]);
  });

  test("keeps lint failures visible and recoverable", async () => {
    const harness = createHarness({ requestError: "service unavailable" });
    await harness.media.openLintReport();
    assert.equal(
      harness.lintModalBody.textContent,
      "Lint failed: service unavailable",
    );
    assert.equal(harness.lintOpenButton.classList.contains("is-busy"), false);
  });

  test("shows deterministic saved-versus-draft diffs and can close them", async () => {
    const harness = createHarness({
      docPayload: { content: "first\nsaved" },
      storage: storage({ "draft:content/process.md": "first\ndraft" }),
    });
    await harness.media.showDiffForDraft("content/process.md");
    assert.equal(harness.diffTitle.textContent, "content/process.md");
    assert.equal(harness.diffModal.hidden, false);
    assert.deepEqual(
      harness.diffBody.children.map((line) => line.textContent),
      ["  first", "+ draft", "- saved"],
    );
    assert.deepEqual(
      harness.diffBody.children.map((line) => line.className),
      ["diff-line diff-ctx", "diff-line diff-add", "diff-line diff-del"],
    );
    harness.media.closeDiff();
    assert.equal(harness.diffModal.hidden, true);
  });

  test("falls back to an empty saved document when draft lookup fails", async () => {
    const harness = createHarness({ requestError: "offline" });
    await harness.media.showDiffForDraft("content/process.md");
    assert.deepEqual(
      harness.diffBody.children.map((line) => line.textContent),
      ["+ draft", "- "],
    );
  });

  test("opens and closes image lightboxes with optional captions", () => {
    const harness = createHarness();
    harness.media.openLightbox("/media/example.png", "Validation result");
    assert.equal(harness.lightboxImg.src, "/media/example.png");
    assert.equal(harness.lightboxCaption.textContent, "Validation result");
    assert.equal(harness.lightboxCaption.hidden, false);
    assert.equal(harness.lightbox.hidden, false);
    harness.media.closeLightbox();
    assert.equal(harness.lightbox.hidden, true);

    harness.media.openLightbox("/media/no-caption.png", "");
    assert.equal(harness.lightboxCaption.hidden, true);
  });

  test("accepts only image clipboard files in a focused rendered procedure", () => {
    const harness = createHarness();
    let prevented = false;
    const image = { name: "capture.jpg", type: "image/jpeg" };
    harness.media.handleClipboardPaste({
      clipboardData: {
        items: [
          { kind: "string" },
          { kind: "file", getAsFile: () => image },
        ],
      },
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.deepEqual(harness.screenshots, [
      [harness.editorState.lastFocusedStep, harness.editorState.lastFocusedProcedure, image],
    ]);

    const sourceMode = createHarness({ mode: "source" });
    sourceMode.media.handleClipboardPaste({
      clipboardData: { items: [{ kind: "file", getAsFile: () => image }] },
      preventDefault: () => assert.fail("source mode must not intercept paste"),
    });
    assert.deepEqual(sourceMode.screenshots, []);
  });

  test("encodes browser files as payload-only base64 and rejects read failures", async () => {
    class SuccessfulReader {
      readAsDataURL() {
        this.result = "data:image/png;base64,YWJj";
        this.onload();
      }
    }
    globalThis.FileReader = SuccessfulReader;
    const harness = createHarness();
    assert.equal(await harness.media.fileToBase64({}), "YWJj");

    class FailingReader {
      readAsDataURL() {
        this.error = new Error("read failed");
        this.onerror();
      }
    }
    globalThis.FileReader = FailingReader;
    await assert.rejects(harness.media.fileToBase64({}), /read failed/);
  });
});
