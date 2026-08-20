import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createKnowledgeMenus } from "../src/surfaces/knowledge/menus.js";
import {
  FakeDocument,
  FakeElement,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

class MenuDocument extends FakeDocument {
  constructor(body) {
    super(body);
    this.body = body;
    this.listeners = new Map();
  }

  createElement(tagName) {
    const value = super.createElement(tagName);
    value.contains = (candidate) =>
      candidate === value || descendants(value).includes(candidate);
    return value;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((value) => value !== listener),
    );
  }
}

function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function createHarness(options = {}) {
  const body = new FakeElement("body");
  const document = new MenuDocument(body);
  globalThis.document = document;
  const docMenuButton = new FakeElement("button");
  docMenuButton.getBoundingClientRect = () => ({
    bottom: 40,
    left: 100,
    right: 140,
  });
  const documentPath = new FakeElement("span");
  const documentTitle = new FakeElement("input");
  documentTitle.value = "Old process";
  const editor = new FakeElement("textarea");
  const diffBody = new FakeElement("div");
  const diffModal = new FakeElement("div");
  diffModal.hidden = true;
  const diffClose = new FakeElement("button");
  diffClose.dataset.diffClose = "";
  diffModal.append(diffClose);
  const diffTitle = new FakeElement("h2");
  const documentState = {
    currentDoc:
      options.currentDoc === undefined
        ? { path: "content/old/process.md" }
        : options.currentDoc,
    currentParsed: { title: "Old process" },
    hasDraft: true,
    lastSavedContent: "saved",
  };
  const knowledgeState = {
    allDocuments: [
      { path: "content/old/process.md" },
      { path: "content/old/second.md" },
      { path: "content/other.md" },
    ],
    selectedFolder: "old",
  };
  const storage = store({
    "draft:content/old/process.md": "draft-one",
    "draft:content/old/second.md": "draft-two",
    "draft:content/other.md": "keep",
  });
  const calls = [];
  const requests = [];
  const errors = [];
  const statuses = [];
  const prompts = [...(options.prompts || [])];
  const menu = createKnowledgeMenus(
    {
      apiUrl: (path) => new URL(path, "https://portal.test"),
      confirmDialog: async (...args) => {
        calls.push(["confirm", ...args]);
        return options.confirm ?? true;
      },
      deleteCurrentDoc: () => calls.push(["delete-current-doc"]),
      diffBody,
      diffClose,
      diffModal,
      diffTitle,
      docMenuButton,
      documentPath,
      documentState,
      documentTitle,
      draftKey: (path) => `draft:${path}`,
      editor,
      emptyNote: (message) => {
        const value = new FakeElement("p");
        value.textContent = message;
        return value;
      },
      knowledgeState,
      listDraftPaths: () =>
        [...storage.values.keys()]
          .filter((key) => key.startsWith("draft:"))
          .map((key) => key.slice("draft:".length)),
      promptUser: () => prompts.shift() ?? null,
      refreshChangesPanel: () => calls.push(["refresh-changes"]),
      refreshGitStatus: () => calls.push(["refresh-git"]),
      renameCurrentDoc: () => calls.push(["rename-current-doc"]),
      reportError: (message) => errors.push(message),
      request: async (url, requestOptions = {}) => {
        const entry = {
          url: String(url),
          options: requestOptions,
          body: requestOptions.body ? JSON.parse(requestOptions.body) : null,
        };
        requests.push(entry);
        if (options.requestError) throw new Error(options.requestError);
        if (entry.url.includes("/folders/rename")) {
          return {
            old_path: "content/old",
            new_path: "content/new",
          };
        }
        if (entry.url.includes("/folders?")) {
          return { deleted: "content/old", files: 2 };
        }
        if (entry.url.includes("/git/log")) {
          return { commits: options.commits || [] };
        }
        return {};
      },
      setPageTitle: (...args) => calls.push(["page-title", ...args]),
      setStatus: (message) => statuses.push(message),
      storage,
      viewportWidth: () => 1440,
    },
    {
      loadDocuments: async () => calls.push(["load-documents"]),
      showLibrary: () => calls.push(["show-library"]),
    },
  );
  const anchor = new FakeElement("button");
  anchor.getBoundingClientRect = () => ({ bottom: 20, left: 24 });
  return {
    anchor,
    body,
    calls,
    diffBody,
    diffClose,
    diffModal,
    diffTitle,
    docMenuButton,
    documentPath,
    documentState,
    documentTitle,
    editor,
    errors,
    knowledgeState,
    menu,
    requests,
    statuses,
    storage,
  };
}

async function clickMenuItem(harness, label) {
  const popover = harness.body.querySelector(".doc-menu-popover");
  assert.ok(popover, `expected menu before clicking ${label}`);
  const item = popover.children.find((child) => child.textContent === label);
  assert.ok(item, `expected ${label} menu item`);
  await item.dispatch("click");
  await nextTicks(3);
}

describe("Knowledge menu behavior", () => {
  test("renames a folder, open document, and every matching local draft", async () => {
    const harness = createHarness({ prompts: ["content/new"] });
    harness.menu.openFolderMenu(harness.anchor, "old");
    await clickMenuItem(harness, "Rename…");
    assert.deepEqual(harness.requests, [
      {
        url: "https://portal.test/folders/rename",
        options: {
          method: "POST",
          body: JSON.stringify({
            old_path: "content/old",
            new_path: "content/new",
          }),
        },
        body: { old_path: "content/old", new_path: "content/new" },
      },
    ]);
    assert.equal(harness.documentState.currentDoc.path, "content/new/process.md");
    assert.equal(harness.documentPath.textContent, "content/new/process.md");
    assert.equal(
      harness.storage.getItem("draft:content/new/process.md"),
      "draft-one",
    );
    assert.equal(
      harness.storage.getItem("draft:content/new/second.md"),
      "draft-two",
    );
    assert.equal(harness.storage.getItem("draft:content/old/process.md"), null);
    assert.equal(harness.storage.getItem("draft:content/other.md"), "keep");
    assert.equal(harness.knowledgeState.selectedFolder, "");
    assert.equal(
      harness.statuses.at(-1),
      "Renamed content/old → content/new",
    );
    assert.deepEqual(harness.calls.slice(-3), [
      ["refresh-changes"],
      ["refresh-git"],
      ["load-documents"],
    ]);
  });

  test("rejects unsafe folder rename paths without a request", async () => {
    const harness = createHarness({ prompts: ["outside/new"] });
    harness.menu.openFolderMenu(harness.anchor, "old");
    await clickMenuItem(harness, "Rename…");
    assert.deepEqual(harness.requests, []);
    assert.deepEqual(harness.statuses, [
      "Folder path must start with content/",
    ]);
  });

  test("reports rename failures while preserving document and drafts", async () => {
    const harness = createHarness({
      prompts: ["content/new"],
      requestError: "conflict",
    });
    harness.menu.openFolderMenu(harness.anchor, "old");
    await clickMenuItem(harness, "Rename…");
    assert.deepEqual(harness.errors, ["Rename failed: conflict"]);
    assert.equal(harness.documentState.currentDoc.path, "content/old/process.md");
    assert.equal(
      harness.storage.getItem("draft:content/old/process.md"),
      "draft-one",
    );
  });

  test("deletes a folder only after review and clears matching editor state", async () => {
    const harness = createHarness();
    harness.menu.openFolderMenu(harness.anchor, "old");
    await clickMenuItem(harness, "Delete");
    assert.equal(harness.calls[0][0], "confirm");
    assert.match(harness.calls[0][1], /its 2 docs/);
    assert.deepEqual(harness.calls[0][2], {
      okText: "Delete",
      danger: true,
    });
    assert.equal(
      harness.requests[0].url,
      "https://portal.test/folders?path=content%2Fold",
    );
    assert.equal(harness.requests[0].options.method, "DELETE");
    assert.equal(harness.documentState.currentDoc, null);
    assert.equal(harness.documentTitle.disabled, true);
    assert.equal(harness.editor.disabled, true);
    assert.equal(harness.storage.getItem("draft:content/old/process.md"), null);
    assert.equal(harness.storage.getItem("draft:content/other.md"), "keep");
    assert.equal(harness.knowledgeState.selectedFolder, "");
    assert.equal(
      harness.statuses.at(-1),
      "Deleted content/old (2 files).",
    );
    assert.equal(
      harness.calls.some(([name]) => name === "show-library"),
      true,
    );
  });

  test("keeps a folder intact when destructive review is cancelled", async () => {
    const harness = createHarness({ confirm: false });
    harness.menu.openFolderMenu(harness.anchor, "old");
    await clickMenuItem(harness, "Delete");
    assert.deepEqual(harness.requests, []);
    assert.equal(harness.documentState.currentDoc.path, "content/old/process.md");
  });

  test("opens document actions and delegates rename and delete", async () => {
    const harness = createHarness();
    harness.menu.openDocMenu();
    const popover = harness.body.querySelector(".doc-menu-popover");
    assert.deepEqual(
      popover.children.map((item) => item.textContent),
      ["Rename…", "History", "Delete"],
    );
    await clickMenuItem(harness, "Rename…");
    assert.equal(
      harness.calls.some(([name]) => name === "rename-current-doc"),
      true,
    );

    harness.menu.openDocMenu();
    await clickMenuItem(harness, "Delete");
    assert.equal(
      harness.calls.some(([name]) => name === "delete-current-doc"),
      true,
    );
  });

  test("loads document history and exposes empty and failed states", async () => {
    const harness = createHarness({
      commits: [
        {
          sha: "abc123",
          date: "2026-08-13",
          author: "Alexey",
          subject: "Update process",
        },
      ],
    });
    harness.menu.openDocMenu();
    await clickMenuItem(harness, "History");
    assert.equal(
      harness.diffTitle.textContent,
      "History · content/old/process.md",
    );
    assert.equal(harness.diffModal.hidden, false);
    assert.equal(harness.diffClose.focused, true);
    assert.equal(
      harness.diffBody.textContent,
      "abc123  2026-08-13  Alexey  Update process",
    );

    const empty = createHarness({ commits: [] });
    empty.menu.openDocMenu();
    await clickMenuItem(empty, "History");
    assert.equal(empty.diffBody.textContent, "No commits found.");

    const failed = createHarness({ requestError: "git unavailable" });
    failed.menu.openDocMenu();
    await clickMenuItem(failed, "History");
    assert.equal(
      failed.diffBody.textContent,
      "History failed: git unavailable",
    );
  });

  test("does not open document actions without a selected document", () => {
    const harness = createHarness({ currentDoc: null });
    harness.menu.openDocMenu();
    assert.equal(harness.body.querySelector(".doc-menu-popover"), null);
  });
});
