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

function harness(request, view = "my-plan", params = "") {
  const root = new FakeElement("main");
  let route = { view, params: new URLSearchParams(params) };
  const surface = createOperatingModelSurface({
    apiUrl: (path) => path, documentList: root, documentRef: new FakeDocument(root),
    getActiveWorkspaceRoute: () => route,
    navigateCanonicalWorkspace() {}, openDocument() {}, resolveDocReference() {}, setRouteTitle() {}, request,
  });
  return { root, surface, setRoute: (view, params = "") => { route = { view, params: new URLSearchParams(params) }; } };
}

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

for (const malformed of [false, true]) {
  test(`plan ${malformed ? "malformed" : "rejected"} failure has bounded Retry and disabled proposal actions`, async () => {
    let attempts = 0;
    const { root, surface } = harness(async (url) => {
      if (url === "/api/operating-model") return { model: model() };
      attempts++;
      if (attempts === 1) {
        if (malformed) return {};
        throw new Error("Plan service unavailable");
      }
      return { sessions: [{ ...session, state: "proposed", card: null }] };
    });
    surface.renderMyPlan(); await nextTicks(4);
    const failedRoot = root.children[0];
    surface.renderMyPlan(); await nextTicks();
    assert.equal(attempts, 1);
    assert.equal(root.children[0], failedRoot);
    assert.equal(findByText(root, "Add to my plan", "button").disabled, true);
    await findByText(root, "Retry", "button").click(); await nextTicks();
    assert.equal(attempts, 2);
    assert.equal(findByText(root, "Add to my plan", "button").disabled, false);
  });
}

test("late model completion respects navigation, and deep section Retry recovers", async () => {
  let resolve;
  let calls = 0;
  const { root, surface, setRoute } = harness(() => { calls++; return new Promise((done) => { resolve = done; }); });
  surface.renderMyPlan();
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

test("409 reloads plan explicitly and presents the existing card", async () => {
  let plans = 0;
  const { root, surface } = harness(async (url) => {
    if (url === "/api/operating-model") return { model: model() };
    if (url === "/api/my-plan") return { sessions: [{ ...session, card: ++plans > 1 ? { id: "card-w01" } : null }] };
    throw Object.assign(new Error("Definition changed"), { status: 409 });
  });
  surface.renderMyPlan(); await nextTicks(4);
  await findByText(root, "Add to my plan", "button").click(); await nextTicks();
  assert.equal(plans, 2);
  assert.ok(findByText(root, "Open card", "button"));
});


test("returning to a failed route restores its screen without another request", async () => {
  let calls = 0;
  const { root, surface, setRoute } = harness(async () => { calls++; throw new Error("Unavailable"); });
  surface.renderMyPlan(); await nextTicks();
  setRoute("documents"); root.replaceChildren(new FakeElement("article"));
  setRoute("my-plan"); surface.renderMyPlan(); await nextTicks();
  assert.ok(findByText(root, "Operating model unavailable"));
  assert.equal(calls, 1);
});


test("stale definitions and saved plan remain visible and duplicate add is suppressed", async () => {
  let posts = 0;
  let finish;
  const { root, surface } = harness(async (url) => {
    if (url === "/api/operating-model") return { model: { ...model(), freshness: "stale" } };
    if (url === "/api/my-plan") return { freshness: "stale", sessions: [{ ...session, card: null }] };
    posts++;
    await new Promise((resolve) => { finish = resolve; });
    return {};
  });
  surface.renderMyPlan(); await nextTicks(4);
  assert.ok(findByText(root, "Showing your saved plan against the last valid operating model."));
  const add = findByText(root, "Add to my plan", "button");
  const first = add.click(); const duplicate = add.click();
  assert.equal(posts, 1);
  finish(); await Promise.all([first, duplicate]); await nextTicks();
  surface.renderOperatingModel();
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

test("plan Retry suppresses duplicate clicks while its request is pending", async () => {
  let attempts = 0;
  let finish;
  const { root, surface } = harness(async (url) => {
    if (url === "/api/operating-model") return { model: model() };
    if (++attempts === 1) throw new Error("Unavailable");
    return new Promise((resolve) => { finish = () => resolve({ sessions: [] }); });
  });
  surface.renderMyPlan(); await nextTicks(4);
  const retry = findByText(root, "Retry", "button");
  await retry.click(); await retry.click();
  assert.equal(attempts, 2);
  assert.ok(findByText(root, "Loading My Plan…"));
  finish(); await nextTicks();
  assert.equal(findByText(root, "My Plan unavailable"), undefined);
});
