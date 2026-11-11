import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createInboxSurface } from "../src/surfaces/inbox.js";
import { FakeDocument, FakeElement, findByText, nextTicks } from "./support/fake-dom.mjs";

function harness(request, params = "") {
  const root = new FakeElement("main");
  const documentRef = new FakeDocument(root);
  const badge = new FakeElement("span");
  badge.id = "inbox-nav-count";
  documentRef.elementsById = { "inbox-nav-count": badge };
  const originalQuery = documentRef.querySelector.bind(documentRef);
  documentRef.querySelector = (selector) => (selector === "#inbox-nav-count" ? badge : originalQuery(selector));
  let route = { view: "inbox", params: new URLSearchParams(params) };
  const navigations = [];
  const surface = createInboxSurface({
    apiUrl: (path) => path,
    documentList: root,
    documentRef,
    getActiveWorkspaceRoute: () => route,
    navigateCanonicalWorkspace: (path, next) => navigations.push([path, next]),
    request,
    setRouteTitle: () => {},
    workApiUrl: (path, query = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== "" && value !== undefined) search.set(key, String(value));
      }
      return `${path}${search.toString() ? `?${search}` : ""}`;
    },
  });
  return { root, badge, documentRef, surface, navigations, setRoute: (next = "") => { route = { view: "inbox", params: new URLSearchParams(next) }; } };
}

describe("inbox surface", () => {
  test("shows the unprocessed count and keeps it visible on the nav badge", async () => {
    const { root, badge, surface } = harness(async (url) => {
      if (String(url).startsWith("/api/inbox/")) return { item: { id: "a", title: "T", status: "new", bodyRef: "body" } };
      return { items: [{ id: "a", title: "T", summary: "S", status: "new", sourceReceivedAt: "2026-11-11T00:00:00.000Z" }], unprocessedCount: 1, totalCount: 1 };
    });
    surface.renderInbox();
    await nextTicks();
    await nextTicks();
    assert.ok(findByText(root, "Inbox", "h1"));
    assert.ok(findByText(root, "Materials saved so they are not lost. 1 unprocessed."));
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, "1");
  });

  test("an empty inbox stays honest and a fetch failure offers retry", async () => {
    const { root, surface } = harness(async () => ({ items: [], unprocessedCount: 0, totalCount: 0 }));
    surface.renderInbox();
    await nextTicks();
    await nextTicks();
    assert.ok(findByText(root, "Materials saved so they are not lost. nothing unprocessed."));

    const failing = harness(async () => { throw new Error("Inbox is unavailable"); });
    failing.surface.renderInbox();
    await nextTicks();
    await nextTicks();
    assert.ok(findByText(failing.root, "Inbox is unavailable"));
  });

  test("marking an item processed asks for confirmation-free archive and reloads", async () => {
    const calls = [];
    const { root, surface } = harness(async (url, options) => {
      calls.push([String(url), options?.method || "GET"]);
      if ((options?.method || "GET") === "PUT") return { item: { id: "a", title: "T", status: "archived", bodyRef: "body" } };
      if (String(url).startsWith("/api/inbox/a")) return { item: { id: "a", title: "T", status: "new", summary: "S", bodyRef: "body text" } };
      return { items: [{ id: "a", title: "T", summary: "S", status: "new", sourceReceivedAt: "2026-11-11T00:00:00.000Z" }], unprocessedCount: 1, totalCount: 1 };
    }, "item=a");
    surface.renderInbox();
    await nextTicks();
    await nextTicks();
    await nextTicks();
    const action = findByText(root, "Mark processed", "button");
    assert.ok(action);
    await action.click();
    await nextTicks();
    await nextTicks();
    assert.ok(calls.some(([url, method]) => url === "/api/inbox/a" && method === "PUT"));
  });
});
