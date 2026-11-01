// Run from repository root: node frontend/e2e/document-editor-doc-type.mjs
// Real Chromium regression for the doc type selector: a custom frontmatter
// doc_type must stay data in a real DOM — no injected elements or event
// handler attributes, exact option text, verbatim value, working selection
// and change round-trip. Synthetic content only; nothing leaves the machine.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("backend/package.json"));
const { chromium } = require("playwright");
const root = path.resolve("frontend");

const payloads = [
  ['run"><img src=x onerror=alert(1)>', 'Run"><Img Src=X Onerror=Alert(1)>'],
  ["<script>alert(1)</script>", "<Script>Alert(1)</Script>"],
  ['guide" onmouseover="alert(1)', 'Guide" Onmouseover="Alert(1)'],
];
const standardTypes = [
  "sop", "checklist", "template", "reference", "playbook", "prompt",
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/fixture") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic doc type fixture</title></head><body data-workspace-view="docs"><p>LOCAL · SYNTHETIC FIXTURE</p></body></html>`);
      return;
    }
    const file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);

  const results = await page.evaluate(async (payloads) => {
    const { createDocumentEditor } = await import("/src/surfaces/document-editor/index.js");
    const { escapeHtml } = await import("/src/core/html.js");
    const out = [];
    for (const docType of payloads) {
      document.body.replaceChildren();
      const editorView = document.createElement("div");
      const renderedView = document.createElement("div");
      editorView.append(renderedView);
      const editor = document.createElement("textarea");
      const documentTitle = document.createElement("textarea");
      document.body.append(editorView, editor, documentTitle);

      const element = (tag) => document.createElement(tag);
      const storage = new Map();
      const content = [
        "---",
        'title: "Custom type doc"',
        `doc_type: ${docType}`,
        "---",
        "# Custom type doc",
        "",
        "Body",
      ].join("\n");
      const documentState = {
        currentDoc: { path: "content/synthetic/doc-type.md", updated: 1, revision: "r1" },
        currentParsed: null,
        currentWarnings: [],
        lastSavedContent: content,
        hasDraft: false,
      };
      editor.value = content;

      const api = createDocumentEditor({
        apiUrl: (path) => new URL(path, location.origin),
        basename: (pathName) => String(pathName || "").split("/").at(-1) || "",
        body: document.body,
        canLeaveCurrentDocument: async () => true,
        cleanPath: (value) => String(value || "").replace(/^\/+|\/+$/g, ""),
        closeSidebar() {},
        closeWorkBellPanel() {},
        confirmDialog: async () => true,
        escapeHtml,
        fetchBacklinksForCurrentDoc() {},
        getActiveWorkspaceRouteToken: () => 0,
        isWorkspaceRouteFresh: () => true,
        documentState,
        knowledgeState: { selectedFolder: "" },
        labelForPath: (value) => `Label: ${value}`,
        loadDocuments: async () => {},
        newDocForm: element("form"),
        openDocument: async () => {},
        operationsViewTitle: (view) => view,
        promptUser: () => null,
        refreshDocuments() {},
        renderLoomBlock: () => null,
        renderRelatedDocsBlock: () => null,
        renderWarningsBlock: () => null,
        request: async () => ({}),
        resetCardPanel() {},
        resetTaskPanel() {},
        resolveDocReference: () => null,
        resolveMarkdownDocLink: () => null,
        scheduleAnimationFrame: (callback) => callback(),
        setFolderUrl() {},
        setRouteTitle() {},
        setView() {},
        showLibrary() {},
        showUndoToast() {},
        storage: {
          getItem: (key) => (storage.has(key) ? storage.get(key) : null),
          setItem: (key, value) => storage.set(key, String(value)),
          removeItem: (key) => storage.delete(key),
        },
        updateFilterSummary() {},
        visibleDocUrl: (value) => `/${String(value).replace(/^content\//, "")}`,
        changesCount: element("span"),
        changesDiscardAll: element("button"),
        changesList: element("div"),
        changesSaveAll: element("button"),
        changesSection: element("section"),
        changesStatus: element("p"),
        diffBody: element("div"),
        diffModal: element("div"),
        diffTitle: element("h2"),
        docMenuButton: element("button"),
        documentPath: element("span"),
        domainFilter: element("select"),
        documentTitle,
        editor,
        editorDiscardButton: element("button"),
        editorInlineStatus: element("p"),
        editorSaveButton: element("button"),
        editorSaveState: element("span"),
        editorView,
        historyButton: element("button"),
        historyClose: element("button"),
        historyPath: element("span"),
        historySearchForm: element("form"),
        historyStatus: element("p"),
        historyVersions: element("div"),
        historyComparison: element("div"),
        historyModal: element("div"),
        knowledgeStatusButton: element("button"),
        knowledgeSection: element("section"),
        knowledgeStatusText: element("p"),
        lightbox: element("div"),
        lightboxCaption: element("p"),
        lightboxImg: element("img"),
        lintModal: element("div"),
        lintModalBody: element("div"),
        lintOpenButton: element("button"),
        lintSummary: element("div"),
        newDocPath: element("input"),
        newDocSummary: element("input"),
        newDocTitle: element("input"),
        newDocType: element("select"),
        renderedView,
        searchInput: element("input"),
        systemFilter: element("select"),
        tagFilter: element("select"),
        typeFilter: element("select"),
        viewToggleButton: element("button"),
      });

      await api.enterRenderedMode();
      const select = renderedView.querySelector(".doc-property-select");
      if (!select) throw new Error("type selector missing");

      // A real HTML parse must have produced option nodes only: no injected
      // elements, no event handler attributes anywhere under the selector.
      const nodes = [...select.querySelectorAll("*")];
      const options = [...select.options];
      const before = {
        optionCount: options.length,
        values: options.map((option) => option.value),
        firstText: options[0].textContent,
        sopText: options[1].textContent,
        selected: options.map((option) => option.selected),
        selectValue: select.value,
        injectedTags: [...new Set(nodes.map((node) => node.tagName))]
          .filter((tag) => tag !== "OPTION"),
        handlerAttrs: nodes.flatMap((node) =>
          node.getAttributeNames().filter((name) => /^on/i.test(name)),
        ),
        strayTags: renderedView.querySelectorAll(
          "script,img,iframe,object,embed",
        ).length,
      };

      select.value = "checklist";
      select.dispatchEvent(new Event("change"));
      await Promise.resolve();
      const afterChecklist = {
        frontmatter: (editor.value.match(/^doc_type: .*$/m) || [null])[0],
        draftStored:
          storage.get("dtc-doc-draft:content/synthetic/doc-type.md") ===
          editor.value,
      };

      select.value = docType;
      select.dispatchEvent(new Event("change"));
      await Promise.resolve();
      const afterCustom = {
        frontmatter: (editor.value.match(/^doc_type: .*$/m) || [null])[0],
      };

      out.push({ docType, before, afterChecklist, afterCustom });
    }
    return out;
  }, payloads.map(([docType]) => docType));

  const expected = Object.fromEntries(payloads);
  for (const result of results) {
    assert.equal(result.before.optionCount, standardTypes.length + 1);
    assert.deepEqual(result.before.values, [result.docType, ...standardTypes]);
    assert.equal(result.before.firstText, expected[result.docType]);
    assert.equal(result.before.sopText, "SOP");
    assert.deepEqual(
      result.before.selected,
      [true, ...standardTypes.map(() => false)],
    );
    // The real select reflects the selected custom option verbatim.
    assert.equal(result.before.selectValue, result.docType);
    assert.deepEqual(result.before.injectedTags, []);
    assert.deepEqual(result.before.handlerAttrs, []);
    assert.equal(result.before.strayTags, 0);
    assert.equal(result.afterChecklist.frontmatter, "doc_type: checklist");
    assert.equal(result.afterChecklist.draftStored, true);
    assert.equal(
      result.afterCustom.frontmatter,
      `doc_type: ${result.docType}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: doc type selector keeps ${payloads.length} malicious custom doc_type values inert in real Chromium; selection and change round-trip preserved.`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
