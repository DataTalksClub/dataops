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
  const diffBody = new FakeElement("div");
  const diffModal = new FakeElement("div");
  diffModal.hidden = true;
  const diffClose = new FakeElement("button");
  diffModal.append(diffClose);
  const diffTitle = new FakeElement("h2");
  const documentState = {
    currentDoc:
      options.currentDoc === undefined
        ? { path: "content/process.md" }
        : options.currentDoc,
  };
  const calls = [];
  const requests = [];
  const menu = createKnowledgeMenus({
    apiUrl: (path) => new URL(path, "https://portal.test"),
    deleteCurrentDoc: () => calls.push(["delete-current-doc"]),
    diffBody,
    diffClose,
    diffModal,
    diffTitle,
    docMenuButton,
    documentState,
    emptyNote: (message) => {
      const value = new FakeElement("p");
      value.textContent = message;
      return value;
    },
    openHistory: () => calls.push(["open-history"]),
    renameCurrentDoc: () => calls.push(["rename-current-doc"]),
    request: async (url) => {
      requests.push(String(url));
      if (options.requestError) throw new Error(options.requestError);
      return { commits: options.commits || [] };
    },
    viewportWidth: () => 1440,
  });
  return { body, calls, diffBody, diffClose, diffModal, diffTitle, menu, requests };
}

async function clickMenuItem(harness, label) {
  const popover = harness.body.querySelector(".doc-menu-popover");
  assert.ok(popover, `expected menu before clicking ${label}`);
  const item = popover.children.find((child) => child.textContent === label);
  assert.ok(item, `expected ${label} menu item`);
  await item.dispatch("click");
  await nextTicks(2);
}

describe("Knowledge menu behavior", () => {
  test("opens document actions and delegates rename and delete", async () => {
    const harness = createHarness();
    harness.menu.openDocMenu();
    const popover = harness.body.querySelector(".doc-menu-popover");
    assert.deepEqual(
      popover.children.map((item) => item.textContent),
      ["Rename…", "History", "Delete"],
    );
    await clickMenuItem(harness, "Rename…");
    assert.deepEqual(harness.calls, [["rename-current-doc"]]);

    harness.menu.openDocMenu();
    await clickMenuItem(harness, "Delete");
    assert.deepEqual(harness.calls, [
      ["rename-current-doc"],
      ["delete-current-doc"],
    ]);
  });

  test("opens the shared version history from the document menu", async () => {
    const harness = createHarness();
    harness.menu.openDocMenu();
    await clickMenuItem(harness, "History");
    assert.deepEqual(harness.calls, [["open-history"]]);
    assert.equal(harness.requests.length, 0);
  });

  test("does not open document actions without a selected document", () => {
    const harness = createHarness({ currentDoc: null });
    harness.menu.openDocMenu();
    assert.equal(harness.body.querySelector(".doc-menu-popover"), null);
  });
});
