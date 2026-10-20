import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTemplateViewSurface } from "../src/surfaces/knowledge/template-view.js";
import { createDocumentRenderer } from "../src/surfaces/document-editor/document-renderer.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});
const body = "Hello <NAME>,\n\n  Review <REVIEW_URL> and reply to <NAME>.\n<div>safe text</div> <https://example.test> <demo@example.test> 1 < 2";
const markdown = `# Synthetic message\n\n## Template\n\n\`\`\`text\n${body}\n\`\`\`\n\n## Placeholders\n\n| Placeholder | What to put there | Example |\n| --- | --- | --- |\n| \`<NAME>\` | Recipient first name | Taylor |\n| <REVIEW_URL> | Review URL | https://example.test/review |\n\n## How to send\n\nUse [the review guide](https://example.test/guide). <OUTSIDE>\n\n## Sent example\n\nHello Taylor.\n`;
function setup(source = markdown, options = {}) {
  const root = new FakeElement();
  globalThis.document = new FakeDocument(root);
  const surface = createTemplateViewSurface(options);
  return { root, surface, render: () => surface.renderTemplateView(root, source, {
    renderMarkdown: (md) => { const node = new FakeElement("div"); node.textContent = md; return node; },
  }) };
}
test("chips preserve body bytes and explain repeated documented placeholders on focus/click", async () => {
  const h = setup();
  assert.equal(h.render(), true);
  assert.equal(h.root.querySelector(".template-view-body").textContent, body);
  const chips = h.root.querySelectorAll(".template-placeholder-chip");
  assert.deepEqual(chips.map((chip) => chip.textContent), ["<NAME>", "<REVIEW_URL>", "<NAME>"]);
  assert.equal(chips[0].getAttribute("aria-label"), "Explain <NAME>");
  await chips[0].dispatch("focus");
  const panel = h.root.querySelector(".template-placeholder-panel");
  assert.equal(panel.getAttribute("aria-live"), "polite");
  assert.match(panel.textContent, /Recipient first name.*ExampleTaylor/);
  await chips[1].dispatch("click");
  assert.match(panel.textContent, /Review URL.*https:\/\/example.test\/review/);
  assert.match(h.root.querySelector("details").textContent, /How to send[\s\S]*Sent example/);
});
test("copy ignores preview mutations and supplemental instructions, using exact extracted bytes", async () => {
  const written = [];
  const h = setup(markdown, { clipboard: { writeText: async (text) => written.push(text) } });
  h.render();
  h.root.querySelector(".template-view-body").textContent = "Tampered preview";
  await h.root.querySelector("button").dispatch("click");
  assert.deepEqual(written, [body]);
  assert.equal(h.root.querySelector('[role="status"]').textContent, "Template copied");
});
test("clipboard errors remain visible and source without a template leaves the editor available", async () => {
  const h = setup(markdown, { clipboard: { writeText: async () => { throw new Error("denied"); } } });
  h.render();
  await h.root.querySelector("button").dispatch("click");
  assert.match(h.root.querySelector('[role="status"]').textContent, /Copy failed/);
  const plain = setup("# Reference\n\nJust a normal document.");
  assert.equal(plain.render(), false);
  assert.equal(plain.root.children.length, 0);
});
test("invalid definitions show parser findings without injecting HTML", () => {
  const h = setup(markdown.replace("| `<NAME>` | Recipient first name | Taylor |\n", ""));
  h.render();
  assert.match(h.root.querySelector('[role="alert"]').textContent, /NAME/);
  assert.equal(h.root.querySelectorAll("script").length, 0);
  assert.equal(h.root.querySelector(".template-view-body").textContent, body);
});
test("document renderer uses the current template draft and clears template styles on navigation", () => {
  const h = setup();
  const state = { currentDoc: { docType: "template", path: "synthetic/templates/demo.md" } };
  const editorView = new FakeElement();
  editorView.dataset.mode = "rendered";
  const context = {
    documentState: state, renderedView: h.root, editor: { value: markdown },
    editorView, viewToggleButton: new FakeElement("button"),
  };
  const renderer = createDocumentRenderer(context, {
    stripFrontmatter: (text) => text,
    renderMarkdown: (md) => { const node = new FakeElement(); node.textContent = md; return node; },
  });
  renderer.renderParsedDocument();
  assert.ok(h.root.classList.contains("template-view"));
  assert.equal(h.root.querySelector(".template-view-body").textContent, body);
  // Navigating to another supported viewer must remove the template layout.
  state.currentDoc.docType = "code-view";
  state.currentParsedCodeView = { files: [], blocks: [] };
  renderer.renderParsedDocument();
  assert.equal(h.root.classList.contains("template-view"), false);
  assert.ok(h.root.classList.contains("code-view"));
});

test("variants have separate copy actions and never copy labels, instructions, or other alternatives", async () => {
  const source = markdown.replace("## Template\n\n", "## Template\n\n### Initial request\n\n")
    .replace("\n## Placeholders", "\n### Follow-up\n\nChoose this only after the first message.\n\n```text\nReminder for <NAME>: <REVIEW_URL>\n```\n\n## Placeholders");
  const written = [];
  const h = setup(source, { clipboard: { writeText: async (text) => written.push(text) } });
  h.render();
  const variants = h.root.querySelectorAll(".template-variant");
  assert.equal(variants.length, 2);
  assert.equal(variants[0].querySelector("h2").textContent, "Initial request");
  assert.equal(variants[1].querySelector("h2").textContent, "Follow-up");
  await variants[1].querySelector("button").dispatch("click");
  await variants[0].querySelector("button").dispatch("click");
  assert.deepEqual(written, ["Reminder for <NAME>: <REVIEW_URL>", body]);
});
