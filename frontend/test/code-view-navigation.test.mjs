import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createDocumentRenderer } from "../src/surfaces/document-editor/document-renderer.js";
import { createCodeViewSurface } from "../src/surfaces/knowledge/code-view.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function payload(code = "echo untouched_text --flag\n") {
  const file = { kind: "file", name: "run.sh", language: "bash", anchor: "file-run", code };
  return { files: [file], blocks: [file] };
}

function setup(request = async () => ({ parsed_code_view: payload() })) {
  const renderedView = new FakeElement();
  globalThis.document = new FakeDocument(renderedView);
  const context = {
    apiUrl: (path) => new URL(path, "https://portal.test"),
    request, renderedView,
    documentState: {
      currentDoc: { path: "content/demo/sops/task.md", docType: "sop", codeView: { path: "content/demo/code-views/task.md" } },
      currentParsedCodeView: null, lastSavedContent: "",
    },
    editor: new FakeElement("textarea"),
    editorView: new FakeElement(),
    viewToggleButton: new FakeElement("button"),
  };
  context.editorView.dataset.mode = "rendered";
  const renderer = createDocumentRenderer(context, {
    resizeDocumentTitle() {},
    renderMarkdown: (text) => { const p = new FakeElement("p"); p.textContent = text; return p; },
  });
  return { ...context, renderer };
}

test("an independently opened code view switches to the actual canonical SOP", async () => {
  const h = setup();
  const opened = [];
  h.documentState.currentDoc = {
    path: "content/demo/code-views/task.md", docType: "code-view",
    sopDoc: { path: "content/demo/sops/task.md" },
  };
  // The editor context is shared with the renderer.
  const context = { ...h, openDocument: async (path) => opened.push(path) };
  const renderer = createDocumentRenderer(context, {});
  renderer.updateViewToggleAvailability();
  assert.equal(h.viewToggleButton.textContent, "SOP view");
  await renderer.toggleViewMode();
  assert.deepEqual(opened, ["content/demo/sops/task.md"]);
});

test("each entry fetches the latest code rather than reusing stale executable content", async () => {
  let version = 0;
  const h = setup(async () => ({ parsed_code_view: payload(`echo version${++version}\n`) }));
  await h.renderer.toggleViewMode();
  assert.match(h.renderedView.textContent, /version1/);
  h.editorView.dataset.mode = "rendered";
  await h.renderer.toggleViewMode();
  assert.match(h.renderedView.textContent, /version2/);
  assert.equal(version, 2);
});

test("invalid discovery stays visible instead of claiming no code view exists", async () => {
  const h = setup();
  h.documentState.currentDoc.codeView = null;
  h.documentState.currentDoc.codeViewError = "Invalid SOP reference in the recipe";
  h.renderer.updateViewToggleAvailability();
  assert.equal(h.viewToggleButton.hidden, false);
  await h.renderer.toggleViewMode();
  assert.equal(h.renderedView.textContent, "Invalid SOP reference in the recipe");
  assert.equal(h.renderedView.children[0].getAttribute("role"), "alert");
});

test("a late code request cannot overwrite a newer view", async () => {
  let resolve;
  const h = setup(() => new Promise((done) => { resolve = done; }));
  const pending = h.renderer.toggleViewMode();
  h.editorView.dataset.mode = "rendered";
  h.renderedView.textContent = "Current document";
  resolve({ parsed_code_view: payload("stale code") });
  await pending;
  assert.equal(h.renderedView.textContent, "Current document");
});

test("edited code-view drafts are parsed as code views before rendering", async () => {
  let body;
  const h = setup(async (_url, options) => {
    body = JSON.parse(options.body);
    return { parsed_code_view: payload("updated draft") };
  });
  h.documentState.currentDoc.docType = "code-view";
  h.editor.value = "changed code-view markdown";
  await h.renderer.enterRenderedMode();
  assert.equal(body.kind, "code-view");
  assert.match(h.renderedView.textContent, /updated draft/);
});

test("the renderer keeps plain text nodes as well as highlighted elements in a native fragment", () => {
  const root = new FakeElement();
  const doc = new FakeDocument(root);
  doc.createDocumentFragment = () => {
    const nodes = [];
    return {
      append: (...values) => nodes.push(...values),
      get childNodes() { return nodes; },
      get children() { return nodes.filter((node) => node.tagName !== "#TEXT"); },
    };
  };
  const code = "echo untouched_text --flag\n";
  createCodeViewSurface({}).renderCodeView(root, payload(code));
  assert.equal(root.children[1].children[1].children[0].textContent, code);
});
