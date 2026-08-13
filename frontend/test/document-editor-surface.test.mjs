import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createDocumentEditor } from "../src/surfaces/document-editor/index.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = originalGetComputedStyle;
  globalThis.setTimeout = originalSetTimeout;
});

class EditorElement extends FakeElement {
  get innerHTML() {
    return super.innerHTML;
  }

  set innerHTML(value) {
    super.innerHTML = value;
    const source = String(value || "");
    for (const match of source.matchAll(
      /<a[^>]+data-doc-path="([^"]+)"[^>]*>([^<]*)<\/a>/g,
    )) {
      const link = new EditorElement("a");
      link.setAttribute("data-doc-path", match[1]);
      link.textContent = match[2];
      this.append(link);
    }
  }

  focus() {
    super.focus();
    if (globalThis.document) globalThis.document.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  contains(target) {
    return target === this || this.querySelectorAll("*").includes(target);
  }

  getBoundingClientRect() {
    return { top: 0, right: 100, bottom: 30, left: 0, width: 100 };
  }
}

class EditorDocument extends FakeDocument {
  createElement(tagName) {
    const element = new EditorElement(tagName);
    this.created.push(element);
    return element;
  }
}

function element(tagName = "div") {
  return new EditorElement(tagName);
}

function apiUrl(path) {
  return new URL(path, "http://portal.test");
}

function bodyOf(entry) {
  return JSON.parse(entry.options.body || "{}");
}

function createEditorHarness(options = {}) {
  if (options.immediateTimers) {
    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
  }
  const elementNames = [
    "changesCount",
    "changesDiscardAll",
    "changesList",
    "changesSaveAll",
    "changesSection",
    "diffBody",
    "diffModal",
    "diffTitle",
    "discardButton",
    "docMenuButton",
    "docTree",
    "documentPath",
    "documentTitle",
    "domainFilter",
    "editor",
    "editorView",
    "gitCommitButton",
    "gitCommitCancel",
    "gitCommitFiles",
    "gitCommitMessage",
    "gitCommitModal",
    "gitCommitSubmit",
    "gitPullButton",
    "gitResult",
    "gitSection",
    "gitStatusText",
    "lightbox",
    "lightboxCaption",
    "lightboxImg",
    "lintModal",
    "lintModalBody",
    "lintOpenButton",
    "lintSummary",
    "newDocPath",
    "newDocSummary",
    "newDocTitle",
    "newDocType",
    "renderedView",
    "saveButton",
    "saveState",
    "searchInput",
    "systemFilter",
    "tagFilter",
    "typeFilter",
    "viewToggleButton",
  ];
  const elements = Object.fromEntries(
    elementNames.map((name) => [name, element("div")]),
  );
  for (const name of [
    "documentTitle",
    "editor",
    "gitCommitMessage",
    "newDocPath",
    "newDocSummary",
    "newDocTitle",
    "newDocType",
    "searchInput",
  ]) {
    elements[name].value = "";
  }
  elements.newDocType.value = "sop";
  elements.editorView.dataset.mode = options.mode || "raw";
  elements.documentTitle.scrollHeight = 32;

  const body = element("body");
  body.dataset.view = "editor";
  const scaffold = element("input");
  scaffold.name = "scaffold";
  scaffold.value = options.scaffold || "full";
  scaffold.checked = true;
  const document = new EditorDocument(
    body,
    scaffold,
    ...Object.values(elements),
  );
  document.body = body;
  globalThis.document = document;
  globalThis.getComputedStyle = () => ({ display: "block", lineHeight: "32" });

  const storageValues = new Map(Object.entries(options.storage || {}));
  const storage = {
    get length() {
      return storageValues.size;
    },
    key(index) {
      return [...storageValues.keys()][index] ?? null;
    },
    getItem(key) {
      return storageValues.get(key) ?? null;
    },
    setItem(key, value) {
      storageValues.set(key, String(value));
    },
    removeItem(key) {
      storageValues.delete(key);
    },
  };

  const initialContent = options.content ?? "# Existing process\n";
  const documentState = {
    currentDoc:
      options.currentDoc === undefined
        ? { path: "content/processes/existing.md", updated: 10 }
        : options.currentDoc,
    currentParsed: options.parsed || null,
    currentWarnings: options.warnings || [],
    lastSavedContent: initialContent,
    hasDraft: Boolean(options.hasDraft),
  };
  elements.editor.value = options.editorValue ?? initialContent;
  elements.documentTitle.value = "Existing process";

  const requests = [];
  const statuses = [];
  const pageTitles = [];
  const views = [];
  const errors = [];
  const openedDocuments = [];
  const confirmations = [];
  let loadCount = 0;
  let libraryCount = 0;
  let formResetCount = 0;
  let sidebarCloses = 0;

  const newDocForm = element("form");
  newDocForm.reset = () => {
    formResetCount += 1;
  };
  const request = async (url, requestOptions = {}) => {
    const entry = { url: String(url), options: requestOptions };
    requests.push(entry);
    if (options.request) return options.request(url, requestOptions, entry);
    if (requestOptions.method === "PUT") return { updated: 20, warnings: [] };
    if (new URL(url).pathname === "/parse") {
      return { parsed: documentState.currentParsed };
    }
    return {};
  };
  const nullableBlock = () => null;
  const context = {
    beginDocumentNavigation() {},
    apiUrl,
    basename: (path) => String(path || "").split("/").at(-1) || "",
    body,
    canLeaveCurrentDocument: async () => options.allowNavigation !== false,
    cleanPath: (path) => String(path || "").replace(/^\/+|\/+$/g, ""),
    closeSidebar: () => {
      sidebarCloses += 1;
    },
    closeWorkBellPanel() {},
    confirmDialog: async (message, confirmOptions) => {
      confirmations.push({ message, options: confirmOptions });
      return options.confirm !== false;
    },
    emptyNote: undefined,
    escapeHtml: (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    fetchBacklinksForCurrentDoc() {},
    documentState,
    knowledgeState: { selectedFolder: options.selectedFolder || "" },
    labelForPath: (path) => `Label: ${path}`,
    loadDocuments: async () => {
      loadCount += 1;
    },
    newDocForm,
    openDocument: async (path) => {
      openedDocuments.push(path);
    },
    operationsViewPath: (view) => `/${view}`,
    operationsViewTitle: (view) => view,
    promptUser: options.promptUser || (() => "content/processes/renamed.md"),
    refreshDocuments() {},
    renderGithubRawFooter: nullableBlock,
    renderLoomBlock: nullableBlock,
    renderRelatedDocsBlock: nullableBlock,
    renderWarningsBlock: nullableBlock,
    reportError: (message) => errors.push(message),
    request,
    resetCardPanel() {},
    resetTaskPanel() {},
    resolveDocReference: (ref) =>
      ref === "related-process"
        ? {
            path: "content/processes/related.md",
            title: "Related process",
          }
        : null,
    resolveMarkdownDocLink: (href) =>
      href === "./related.md"
        ? {
            path: "content/processes/related.md",
            title: "Related process",
          }
        : null,
    scheduleAnimationFrame: (callback) => callback(),
    setFolderUrl() {},
    setPageTitle: (...values) => pageTitles.push(values),
    setStatus: (message) => statuses.push(message),
    setView: (view) => {
      body.dataset.view = view;
      views.push(view);
    },
    showErrorToast: (message) => errors.push(message),
    showLibrary: () => {
      libraryCount += 1;
    },
    showUndoToast() {},
    storage,
    updateCustomSelect() {},
    updateFilterSummary() {},
    visibleDocUrl: (path) => `/${String(path).replace(/^content\//, "")}`,
    ...elements,
  };
  const api = createDocumentEditor(context);

  return {
    api,
    body,
    confirmations,
    document,
    documentState,
    elements,
    errors,
    formResetCount: () => formResetCount,
    libraryCount: () => libraryCount,
    loadCount: () => loadCount,
    openedDocuments,
    pageTitles,
    requests,
    sidebarCloses: () => sidebarCloses,
    statuses,
    storageValues,
    views,
  };
}

describe("Document Editor surface boundary", () => {
  test("directly imports the production factory and exposes the stable editor facade", () => {
    assert.deepEqual(Object.keys(createEditorHarness().api).sort(), [
      "canLeaveDocumentEditor",
      "closeCommitForm",
      "closeDiff",
      "closeLightbox",
      "createDocument",
      "deleteCurrentDoc",
      "discardAllDrafts",
      "discardDraft",
      "draftKey",
      "emptyNote",
      "enterRenderedMode",
      "escapeRegex",
      "gitPull",
      "handleClipboardPaste",
      "listDraftPaths",
      "openCommitForm",
      "openLintReport",
      "refreshChangesPanel",
      "refreshGitStatus",
      "renameCurrentDoc",
      "resizeDocumentTitle",
      "saveAllDrafts",
      "saveCurrentDocument",
      "setSaveState",
      "showCreate",
      "storeDraft",
      "submitCommitForm",
      "syncTitleToMarkdown",
      "titleFromMarkdown",
      "toggleViewMode",
      "updateGithubLink",
      "updateSaveState",
      "updateViewToggleAvailability",
    ]);
  });

  test("validates and creates a normalized Process Doc with the selected scaffold", async () => {
    const harness = createEditorHarness({
      scaffold: "minimal",
      request: async (url, requestOptions) => {
        if (new URL(url).pathname === "/docs" && requestOptions.method === "POST") {
          return { path: bodyOf({ options: requestOptions }).path };
        }
        return {};
      },
    });

    await harness.api.createDocument();
    assert.equal(harness.statuses.at(-1), "Path is required.");
    assert.equal(harness.requests.length, 0);

    harness.elements.newDocPath.value = "/operations/new-process";
    harness.elements.newDocTitle.value = "New process";
    harness.elements.newDocType.value = "sop";
    harness.elements.newDocSummary.value = "Run it safely";
    await harness.api.createDocument();

    const create = harness.requests.find(
      (entry) => entry.options.method === "POST",
    );
    assert.equal(new URL(create.url).pathname, "/docs");
    assert.deepEqual(bodyOf(create), {
      path: "content/operations/new-process.md",
      title: "New process",
      doc_type: "sop",
      summary: "Run it safely",
      scaffold: "minimal",
    });
    assert.equal(harness.formResetCount(), 1);
    assert.equal(harness.loadCount(), 1);
    assert.deepEqual(harness.openedDocuments, [
      "content/operations/new-process.md",
    ]);
    assert.equal(
      harness.statuses.at(-1),
      "Created content/operations/new-process.md.",
    );
  });

  test("guards create navigation, defaults its folder path, and moves focus safely", async () => {
    const blocked = createEditorHarness({ allowNavigation: false });
    await blocked.api.showCreate();
    assert.deepEqual(blocked.views, []);
    assert.equal(blocked.elements.newDocPath.focused, false);

    const allowed = createEditorHarness({ selectedFolder: "operations" });
    await allowed.api.showCreate();
    assert.equal(
      allowed.elements.newDocPath.value,
      "content/operations/new-document.md",
    );
    assert.equal(allowed.body.dataset.view, "create");
    assert.equal(allowed.elements.newDocPath.focused, true);
    assert.equal(allowed.document.activeElement, allowed.elements.newDocPath);
    assert.equal(allowed.sidebarCloses(), 1);
    assert.deepEqual(allowed.pageTitles.at(-1), ["New page", "Create"]);
  });

  test("tracks sorted local drafts, dirty state, and restores saved content on discard", () => {
    const harness = createEditorHarness({
      content: "# Saved\n",
      editorValue: "# Local draft\n",
      hasDraft: true,
      storage: {
        "dtc-doc-draft:content/z.md": "# Z",
        "dtc-doc-draft:content/processes/existing.md": "# Local draft",
        "unrelated-setting": "keep",
      },
    });

    harness.api.updateSaveState();
    assert.equal(harness.elements.saveState.textContent, "Unsaved changes");
    assert.equal(harness.elements.saveButton.disabled, false);
    assert.equal(harness.elements.discardButton.disabled, false);
    assert.deepEqual(harness.api.listDraftPaths(), [
      "content/processes/existing.md",
      "content/z.md",
    ]);

    harness.api.refreshChangesPanel();
    assert.equal(harness.elements.changesSection.hidden, false);
    assert.equal(harness.elements.changesCount.textContent, "2");
    assert.equal(
      findAllByClass(harness.elements.changesList, "changes-row").length,
      2,
    );

    harness.api.discardDraft();
    assert.equal(harness.elements.editor.value, "# Saved\n");
    assert.equal(harness.documentState.hasDraft, false);
    assert.equal(
      harness.storageValues.has(
        "dtc-doc-draft:content/processes/existing.md",
      ),
      false,
    );
    assert.equal(harness.storageValues.get("unrelated-setting"), "keep");
  });

  test("edits the document title in frontmatter and Markdown while retaining a local draft", () => {
    const content = [
      "---",
      'title: "Old title"',
      "doc_type: sop",
      "---",
      "# Old title",
      "",
      "Body",
    ].join("\n");
    const harness = createEditorHarness({ content, editorValue: content });
    harness.elements.documentTitle.value = "  Updated   process  ";

    harness.api.syncTitleToMarkdown();
    assert.equal(harness.elements.documentTitle.value, "Updated process");
    assert.match(harness.elements.editor.value, /title: "Updated process"/);
    assert.match(harness.elements.editor.value, /^# Updated process$/m);
    assert.equal(harness.documentState.hasDraft, true);
    assert.equal(
      harness.storageValues.get(
        "dtc-doc-draft:content/processes/existing.md",
      ),
      harness.elements.editor.value,
    );
    assert.equal(harness.elements.saveState.textContent, "Unsaved changes");
    assert.deepEqual(harness.pageTitles.at(-1), [
      "Updated process",
      "content/processes/existing.md",
    ]);
  });

  test("saves successfully, clears only its draft, and reports lint warnings", async () => {
    const harness = createEditorHarness({
      mode: "rendered",
      immediateTimers: true,
      content: "# Saved\n",
      editorValue: "# Updated\n",
      hasDraft: true,
      storage: {
        "dtc-doc-draft:content/processes/existing.md": "# Updated\n",
        "dtc-doc-draft:content/other.md": "# Other\n",
      },
      request: async (url, requestOptions) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/docs" && requestOptions.method === "PUT") {
          return { updated: 42, warnings: ["summary is missing"] };
        }
        if (pathname === "/docs") return { parsed: null };
        if (pathname === "/git/status") return { ok: true, count: 0, branch: "main" };
        return {};
      },
    });

    await harness.api.saveCurrentDocument();
    const save = harness.requests.find((entry) => entry.options.method === "PUT");
    assert.deepEqual(bodyOf(save), { content: "# Updated\n" });
    assert.equal(
      new URL(save.url).searchParams.get("path"),
      "content/processes/existing.md",
    );
    assert.equal(harness.documentState.currentDoc.updated, 42);
    assert.equal(harness.documentState.lastSavedContent, "# Updated\n");
    assert.deepEqual(harness.documentState.currentWarnings, [
      "summary is missing",
    ]);
    assert.equal(harness.documentState.hasDraft, false);
    assert.equal(
      harness.storageValues.has(
        "dtc-doc-draft:content/processes/existing.md",
      ),
      false,
    );
    assert.equal(
      harness.storageValues.get("dtc-doc-draft:content/other.md"),
      "# Other\n",
    );
    assert.match(harness.statuses.at(-1), /^Saved · summary is missing/);
    assert.equal(harness.loadCount(), 1);
  });

  test("retains the local draft across validation, conflict, network, and permission save failures", async () => {
    for (const message of [
      "Validation failed: title is required",
      "Conflict: document changed remotely",
      "Network unavailable",
      "Permission denied",
    ]) {
      const path = "content/processes/existing.md";
      const draftKey = `dtc-doc-draft:${path}`;
      const harness = createEditorHarness({
        content: "# Saved\n",
        editorValue: "# Unsaved\n",
        hasDraft: true,
        storage: { [draftKey]: "# Unsaved\n" },
        request: async () => {
          throw new Error(message);
        },
      });

      await harness.api.saveCurrentDocument();
      assert.equal(harness.statuses.at(-1), message);
      assert.equal(harness.storageValues.get(draftKey), "# Unsaved\n");
      assert.equal(harness.documentState.hasDraft, true);
      assert.equal(harness.documentState.lastSavedContent, "# Saved\n");
      assert.equal(harness.elements.saveButton.disabled, false);
    }
  });

  test("renames and deletes Process Docs with explicit review and draft cleanup", async () => {
    const oldPath = "content/processes/existing.md";
    const renamedPath = "content/processes/renamed.md";
    const harness = createEditorHarness({
      hasDraft: true,
      storage: { [`dtc-doc-draft:${oldPath}`]: "# Local\n" },
      promptUser: () => renamedPath,
      request: async (url, requestOptions) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/docs/rename") return { new_path: renamedPath };
        if (pathname === "/docs" && requestOptions.method === "DELETE") {
          return {};
        }
        if (pathname === "/git/status") return { ok: true, count: 0 };
        return {};
      },
    });

    await harness.api.renameCurrentDoc();
    const rename = harness.requests.find(
      (entry) => new URL(entry.url).pathname === "/docs/rename",
    );
    assert.deepEqual(bodyOf(rename), {
      old_path: oldPath,
      new_path: renamedPath,
    });
    assert.equal(harness.documentState.currentDoc.path, renamedPath);
    assert.equal(
      harness.storageValues.get(`dtc-doc-draft:${renamedPath}`),
      "# Local\n",
    );
    assert.equal(harness.storageValues.has(`dtc-doc-draft:${oldPath}`), false);

    await harness.api.deleteCurrentDoc();
    const deletion = harness.requests.find(
      (entry) => entry.options.method === "DELETE",
    );
    assert.equal(
      new URL(deletion.url).searchParams.get("path"),
      renamedPath,
    );
    assert.match(harness.confirmations.at(-1).message, /renamed\.md/);
    assert.equal(harness.documentState.currentDoc, null);
    assert.equal(harness.elements.editor.disabled, true);
    assert.equal(harness.storageValues.has(`dtc-doc-draft:${renamedPath}`), false);
    assert.equal(harness.libraryCount(), 1);
  });

  test("reviews Git status and submits an explicit commit-and-push action", async () => {
    let statusCalls = 0;
    const harness = createEditorHarness({
      request: async (url, requestOptions) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/git/status") {
          statusCalls += 1;
          return {
            ok: true,
            branch: "main",
            count: 1,
            github: "https://github.com/DataTalksClub/dataops-knowledge",
            files: [{ status: "M", path: "content/processes/existing.md" }],
          };
        }
        if (pathname === "/git/commit" && requestOptions.method === "POST") {
          return {
            ok: true,
            committed: true,
            pushed: true,
            message: bodyOf({ options: requestOptions }).message,
          };
        }
        return {};
      },
    });

    await harness.api.refreshGitStatus();
    assert.equal(
      harness.elements.gitStatusText.textContent,
      "On main · 1 file changed",
    );
    assert.equal(harness.elements.gitCommitButton.disabled, false);
    assert.equal(harness.elements.gitSection.classList.contains("git-ok"), true);

    await harness.api.openCommitForm();
    assert.equal(harness.elements.gitCommitModal.hidden, false);
    assert.equal(
      harness.elements.gitCommitMessage.value,
      "Update existing",
    );
    assert.equal(harness.elements.gitCommitMessage.focused, true);
    assert.equal(harness.elements.gitCommitMessage.selected, true);
    assert.equal(
      findAllByClass(harness.elements.gitCommitFiles, "git-commit-file").length,
      1,
    );

    harness.elements.gitCommitMessage.value = "Update onboarding process";
    await harness.api.submitCommitForm({ preventDefault() {} });
    const commit = harness.requests.find(
      (entry) => new URL(entry.url).pathname === "/git/commit",
    );
    assert.deepEqual(bodyOf(commit), {
      message: "Update onboarding process",
      push: true,
    });
    assert.match(harness.elements.gitResult.textContent, /Committed and pushed/);
    assert.equal(harness.elements.gitCommitModal.hidden, true);
    assert.ok(statusCalls >= 3);
  });

  test("renders structured SOP frontmatter, ordered sections, and procedure steps", async () => {
    const parsed = {
      frontmatter: {
        title: "Run newsletter",
        doc_type: "sop",
        systems: ["mailing"],
        tags: ["weekly"],
      },
      sections: {
        summary: {
          raw: false,
          body_md: "## Summary\n\nPrepare the weekly issue.",
        },
        procedure: {
          raw: false,
          body_md: "## Procedure\n\n### Step 1\nSend it.",
          todos: ["Confirm links"],
          groups: [],
          flat_steps: [
            {
              id: 1,
              rendered_number: 1,
              attrs: { action: "click", systems: ["mailing"] },
              body_md: "Send the newsletter.",
              screenshots: [],
            },
          ],
          prose: [],
        },
      },
    };
    const content = "# Run newsletter\n";
    const harness = createEditorHarness({
      parsed,
      content,
      editorValue: content,
      mode: "raw",
    });

    await harness.api.enterRenderedMode();
    assert.equal(harness.elements.editorView.dataset.mode, "rendered");
    assert.ok(findByText(harness.elements.renderedView, "Run newsletter", "h1"));
    assert.ok(findByText(harness.elements.renderedView, "sop", "span"));
    assert.ok(findByText(harness.elements.renderedView, "mailing", "span"));
    assert.ok(findByText(harness.elements.renderedView, "Summary", "h2"));
    assert.ok(findByText(harness.elements.renderedView, "Procedure", "h2"));
    assert.equal(
      findAllByClass(harness.elements.renderedView, "block-step").length,
      1,
    );
    assert.ok(
      findByText(harness.elements.renderedView, "1 step", "div"),
    );
    const stepMarkdown = findAllByClass(
      harness.elements.renderedView,
      "block-step-body",
    )[0].querySelector(".md");
    assert.match(stepMarkdown.innerHTML, /Send the newsletter/);
  });

  test("renders safe internal Markdown navigation and resolves relative media", async () => {
    const markdown = [
      "# Guide",
      "",
      "[[related-process|Review guide]]",
      "[Relative process](./related.md)",
      "![Screenshot](../images/shot.png)",
      "[Unsafe](javascript:alert(1))",
      "[External](https://example.com)",
    ].join("\n");
    const harness = createEditorHarness({
      parsed: { frontmatter: { title: "Guide" }, sections: {} },
      content: markdown,
      editorValue: markdown,
    });

    await harness.api.enterRenderedMode();
    const renderedMarkdown = harness.elements.renderedView.querySelector(".md");
    assert.match(
      renderedMarkdown.innerHTML,
      /data-doc-path="content\/processes\/related\.md"/,
    );
    assert.match(
      renderedMarkdown.innerHTML,
      /src="\/content\/images\/shot\.png"/,
    );
    assert.match(renderedMarkdown.innerHTML, /<a href="#">Unsafe<\/a>/);
    assert.match(
      renderedMarkdown.innerHTML,
      /target="_blank" rel="noopener">External/,
    );

    const links = renderedMarkdown.querySelectorAll("[data-doc-path]");
    assert.equal(links.length, 2);
    await links[0].click();
    assert.deepEqual(harness.openedDocuments, [
      "content/processes/related.md",
    ]);
  });

  test("keeps dirty-leave and parse or Git failures recoverable", async () => {
    const harness = createEditorHarness({
      confirm: false,
      content: "# Saved\n",
      editorValue: "# Local\n",
      request: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/parse") throw new Error("Parser offline");
        if (pathname === "/git/status") throw new Error("Git offline");
        return {};
      },
    });

    assert.equal(await harness.api.canLeaveDocumentEditor(), false);
    assert.match(harness.confirmations[0].message, /unsaved local changes/);
    await harness.api.enterRenderedMode();
    assert.equal(harness.elements.editorView.dataset.mode, "rendered");
    assert.ok(harness.elements.renderedView.children.length > 0);

    await harness.api.refreshGitStatus();
    assert.equal(harness.elements.gitSection.classList.contains("git-unavailable"), true);
    assert.equal(harness.elements.gitStatusText.textContent, "Git offline");
    assert.equal(harness.elements.gitCommitButton.disabled, true);
  });
});
