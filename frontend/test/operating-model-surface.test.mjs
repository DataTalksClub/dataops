import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createOperatingModelSurface } from "../src/surfaces/operating-model.js";
import { FakeDocument, FakeElement, findByText, nextTicks } from "./support/fake-dom.mjs";

const session = {
  id: "W01",
  title: "Define the operating cadence",
  proposedDate: "2026-09-10",
  goal: "Agree the first cadence",
  deliverables: "Decision log",
  decisionsNeeded: "Cadence",
  agentWork: "Prepare options",
  definitionOfDone: "Decision recorded",
  documentId: "reference.session.w01",
};

function model() {
  return {
    revision: "revision-1",
    freshness: "current",
    overviewDocumentId: "system.operating-model",
    businessUnits: [], functions: [], systems: [], gaps: [], lifecycles: [],
    roadmap: { sessions: [session] },
  };
}

describe("operating model surface", () => {
  test("materializes a proposed session and opens its existing Card", async () => {
    const root = new FakeElement("main");
    const documentRef = new FakeDocument(root);
    const calls = [];
    let active = false;
    const navigations = [];
    const surface = createOperatingModelSurface({
      apiUrl: (path) => path,
      documentList: root,
      documentRef,
      getActiveWorkspaceRoute: () => ({ view: "my-plan", params: new URLSearchParams() }),
      navigateCanonicalWorkspace: (...args) => navigations.push(args),
      openDocument() {},
      resolveDocReference: () => ({ path: "content/session.md" }),
      setRouteTitle() {},
      request: async (url, options = {}) => {
        calls.push({ url, options });
        if (url === "/api/operating-model") return { model: model() };
        if (url === "/api/my-plan") return {
          revision: "revision-1", freshness: "current",
          sessions: [{ ...session, state: active ? "active" : "proposed", card: active ? { id: "card-w01" } : null }],
        };
        if (url === "/api/my-plan/sessions/W01") { active = true; return { replayed: false }; }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    surface.renderMyPlan();
    await nextTicks(4);
    const add = findByText(root, "Add to my plan", "button");
    assert.ok(add);
    await add.click();
    await nextTicks(2);
    const post = calls.find((call) => call.url === "/api/my-plan/sessions/W01");
    assert.deepStrictEqual(JSON.parse(post.options.body), {
      expectedDefinitionRevision: "revision-1",
      anchorDate: "2026-09-10",
    });
    const open = findByText(root, "Open card", "button");
    assert.ok(open);
    await open.click();
    assert.deepStrictEqual(navigations.at(-1), ["/cards", { cardId: "card-w01" }]);
  });
});
