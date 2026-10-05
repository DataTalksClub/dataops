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
  checklist: [{ id: "decide", title: "Record the decision", phase: "decide", proof: "Decision note" }],
};

function model() {
  return {
    revision: "revision-1",
    freshness: "current",
    overviewDocumentId: "system.operating-model",
    businessUnits: [], functions: [], systems: [], gaps: [], assets: [], dependencies: [], lifecycles: [],
    roadmap: { sessions: [session] },
  };
}

describe("operating model surface", () => {
  for (const failure of ["rejected", "missing", "malformed"]) {
    test(`model ${failure} stops requests and preserves error DOM until explicit Retry`, async () => {
      let calls = 0;
      let succeed = false;
      let finish;
      const { root, surface } = harness(async () => {
        calls++;
        if (succeed) return new Promise((resolve) => { finish = () => resolve({ model: model() }); });
        if (failure === "rejected") throw new Error("Service unavailable");
        return failure === "missing" ? {} : { model: {} };
      }, "operating-model");
      surface.renderOperatingModel();
      await nextTicks();
      const failedRoot = root.children[0];
      surface.renderOperatingModel(); surface.renderOperatingModel();
      await nextTicks();
      assert.equal(calls, 1);
      assert.equal(root.children[0], failedRoot);
      assert.ok(findByText(root, "Operating model unavailable"));
      succeed = true;
      const retry = findByText(root, "Retry", "button");
      await retry.click(); await retry.click();
      assert.equal(calls, 2);
      assert.ok(findByText(root, "Loading operating model…"));
      finish(); await nextTicks();
      assert.ok(findByText(root, "Business units", "h3"));
    });
  }
});

function harness(request, view = "operating-model", params = "") {
  const root = new FakeElement("main");
  let route = { view, params: new URLSearchParams(params) };
  const surface = createOperatingModelSurface({
    apiUrl: (path) => path, documentList: root, documentRef: new FakeDocument(root),
    getActiveWorkspaceRoute: () => route,
    navigateCanonicalWorkspace() {}, openDocument() {}, resolveDocReference() {}, setRouteTitle() {}, request,
  });
  return { root, surface, setRoute: (view, params = "") => { route = { view, params: new URLSearchParams(params) }; } };
}

test("late model completion respects navigation, and deep section Retry recovers", async () => {
  let resolve;
  let calls = 0;
  const { root, surface, setRoute } = harness(() => { calls++; return new Promise((done) => { resolve = done; }); });
  surface.renderOperatingModel();
  setRoute("documents");
  root.replaceChildren(new FakeElement("article"));
  const documentPage = root.children[0];
  resolve({ model: model() }); await nextTicks();
  assert.equal(root.children[0], documentPage);
  assert.equal(calls, 1);

  let attempt = 0;
  const section = harness(async () => {
    if (++attempt === 1) throw new Error("Unavailable");
    return { model: model() };
  }, "operating-model", "section=roadmap");
  section.surface.renderOperatingModel(); await nextTicks();
  assert.ok(findByText(section.root, "Operating model unavailable"));
  await findByText(section.root, "Retry", "button").click(); await nextTicks();
  assert.ok(findByText(section.root, session.title, "h3"));
});

test("returning to a failed route restores its screen without another request", async () => {
  let calls = 0;
  const { root, surface, setRoute } = harness(async () => { calls++; throw new Error("Unavailable"); });
  surface.renderOperatingModel(); await nextTicks();
  setRoute("documents"); root.replaceChildren(new FakeElement("article"));
  setRoute("operating-model"); surface.renderOperatingModel(); await nextTicks();
  assert.ok(findByText(root, "Operating model unavailable"));
  assert.equal(calls, 1);
});

test("stale definitions stay visible while definitions refresh", async () => {
  const { root, surface } = harness(async () => ({ model: { ...model(), freshness: "stale" } }));
  surface.renderOperatingModel(); await nextTicks();
  assert.ok(findByText(root, "Showing the last valid model while definitions refresh."));
});

test("hub is a named map without kicker, explainer, or chevron buttons", async () => {
  const { root, surface } = harness(async (url) => {
    if (url === "/api/operating-model") return { model: model() };
    throw new Error(`Unexpected URL ${url}`);
  }, "operating-model");
  surface.renderOperatingModel();
  await nextTicks();
  assert.ok(findByText(root, "Operating Model", "h1"));
  assert.equal(findByText(root, "Company system"), undefined);
  assert.equal(
    findByText(root, "See how business units, accountable functions, systems, gaps, and lifecycles fit together."),
    undefined,
  );
  const functions = findByText(root, "Functions", "h3");
  assert.ok(functions);
  assert.equal(functions.parentElement.tagName, "BUTTON");
  assert.equal(findByText(root, "Open Functions", "button"), undefined);
  assert.equal(root.querySelector(".operating-model-open"), null);
  assert.equal(findByText(root, "Open source document"), undefined);
});

test("section uses a title-cased family name and definition rows", async () => {
  const { root, surface } = harness(async (url) => {
    if (url === "/api/operating-model") {
      return {
        model: {
          ...model(),
          functions: [{
            name: "Editorial",
            outcome: "Publish on time",
            managerTitle: "Editorial lead",
            currentCoverage: "Partial coverage",
            documentId: "function.editorial",
          }],
        },
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  }, "operating-model", "section=functions");
  surface.renderOperatingModel();
  await nextTicks();
  assert.ok(findByText(root, "Functions", "h1"));
  assert.equal(findByText(root, "functions", "h1"), undefined);
  assert.equal(findByText(root, "1 current definitions"), undefined);
  assert.ok(findByText(root, "Editorial", "h3"));
  assert.ok(findByText(root, "Publish on time"));
  assert.ok(findByText(root, "Editorial lead · Partial coverage"));
  assert.equal(findByText(root, "Accountable seat"), undefined);
  assert.equal(findByText(root, "Open source document"), undefined);
  assert.ok(findByText(root, "Overview", "button"));
});

