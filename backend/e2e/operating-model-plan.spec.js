const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs");
const path = require("path");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

const screenshots = path.resolve(__dirname, "..", "..", ".tmp", "screenshots", "operating-model");
let server;

const session = {
  id: "W01", title: "Set the operating cadence", proposedDate: "2026-09-10",
  goal: "Agree the cadence", deliverables: "Decision log", decisionsNeeded: "Cadence",
  agentWork: "Prepare options", definitionOfDone: "Decision recorded",
  documentId: "reference.session.w01",
  checklist: [
    { id: "decide", title: "Record the decision", phase: "decide", proof: "Decision note" },
    { id: "build", title: "Produce the deliverable", phase: "build", proof: "Result note" },
  ],
};

const model = {
  revision: "revision-1", freshness: "current", overviewDocumentId: "system.operating-model",
  businessUnits: [{ id: "BU-1", name: "Learning", role: "Own the product" }],
  functions: [], systems: [], gaps: [], lifecycles: [], assets: [], dependencies: [],
  roadmap: { sessions: [session] },
};

test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot("operating-model-plan") },
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

test("My Plan previews and materializes a session on desktop and mobile", async ({ page }) => {
  let active = false;
  let posted = null;
  await page.route("**/api/operating-model", (route) => route.fulfill({ json: { model } }));
  await page.route("**/api/my-plan**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posted = request.postDataJSON();
      active = true;
      return route.fulfill({ status: 201, json: { replayed: false } });
    }
    return route.fulfill({ json: {
      revision: model.revision, freshness: "current",
      sessions: [{ ...session, state: active ? "active" : "proposed", card: active ? { id: "card-w01" } : null }],
    } });
  });
  await page.route("**/api/cards/card-w01**", (route) => route.fulfill({ json: {
    card: { id: "card-w01", version: 1, title: "Set the operating cadence", status: "active", stage: "preparation", taskCount: 0, openTaskCount: 0 },
    tasks: [],
  } }));

  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await page.goto(`${server.baseURL}/#/my-plan?sessionId=W01`);
  assertOwnedServerResponse(server, root, "My Plan root");
  await expect(page.getByRole("heading", { name: "My Plan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Checklist preview" })).toBeVisible();
  await expect(page.getByText("Record the decision")).toBeVisible();
  await page.getByRole("button", { name: "Add to my plan" }).click();
  await expect(page.getByRole("button", { name: "Open card" })).toBeVisible();
  expect(posted).toEqual({ expectedDefinitionRevision: "revision-1", anchorDate: "2026-09-10" });
  const accessibility = await new AxeBuilder({ page }).include(".my-plan-surface").analyze();
  expect(accessibility.violations.filter((item) => ["critical", "serious"].includes(item.impact))).toEqual([]);
  await page.screenshot({ path: path.join(screenshots, "my-plan-1440.png"), animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(screenshots, "my-plan-390.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Open card" }).click();
  await expect(page).toHaveURL(/#\/cards\?cardId=card-w01/);
});


async function selectAndObserveFailure(page, heading) {
  await page.getByText(heading, { exact: true }).evaluate((node) => {
    window.failureNode = node;
    window.failureMutations = 0;
    window.failureObserver = new MutationObserver((entries) => { window.failureMutations += entries.length; });
    window.failureObserver.observe(document.querySelector("#document-list"), { childList: true, subtree: true });
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
}

async function expectStableSelection(page, heading) {
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => ({
    selected: window.getSelection().toString(),
    connected: window.failureNode.isConnected,
    mutations: window.failureMutations,
  }))).toEqual({ selected: heading, connected: true, mutations: 0 });
  await page.evaluate(() => window.failureObserver.disconnect());
}

for (const entry of ["my-plan", "operating-model?section=roadmap"]) {
  test(`${entry} model failure retains selected text and recovers on one Retry`, async ({ page }) => {
    let attempts = 0;
    let recover = false;
    await page.route("**/api/operating-model", (route) => {
      attempts++;
      return route.fulfill(recover ? { json: { model } } : { status: 503, json: { error: "Service unavailable" } });
    });
    await page.route("**/api/my-plan", (route) => route.fulfill({ json: { sessions: [{ ...session, state: "proposed", card: null }] } }));
    await page.goto(`${server.baseURL}/#/${entry}`);
    await expect(page.getByText("Operating model unavailable", { exact: true })).toBeVisible();
    await selectAndObserveFailure(page, "Operating model unavailable");
    await expectStableSelection(page, "Operating model unavailable");
    expect(attempts).toBe(1);
    await page.screenshot({ path: path.join(screenshots, `model-error-${entry.split("?")[0]}.png`) });
    recover = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("heading", { name: session.title })).toBeVisible();
    expect(attempts).toBe(2);
  });
}

test("My Plan failure preserves selection and proposal preview, then Retry enables adding", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/operating-model", (route) => route.fulfill({ json: { model } }));
  await page.route("**/api/my-plan", (route) => {
    attempts++;
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: "Plan unavailable" } } : { json: { sessions: [{ ...session, state: "proposed", card: null }] } });
  });
  await page.goto(`${server.baseURL}/#/my-plan`);
  await expect(page.getByText("My Plan unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to my plan" })).toBeDisabled();
  await selectAndObserveFailure(page, "My Plan unavailable");
  await expectStableSelection(page, "My Plan unavailable");
  expect(attempts).toBe(1);
  await page.screenshot({ path: path.join(screenshots, "plan-error.png") });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add to my plan" })).toBeEnabled();
  expect(attempts).toBe(2);
  await page.screenshot({ path: path.join(screenshots, "plan-recovered.png") });
});

test("repeated surface renders preserve the failed DOM and selection", async ({ page }) => {
  await page.route("**/api/operating-model", (route) => route.fulfill({ json: { model } }));
  await page.route("**/api/my-plan", (route) => route.fulfill({ json: { sessions: [{ ...session, state: "proposed", card: null }] } }));
  await page.goto(`${server.baseURL}/#/my-plan`);
  await expect(page.getByRole("button", { name: "Add to my plan" })).toBeEnabled();
  await page.evaluate(async () => {
    const { createOperatingModelSurface } = await import("/src/surfaces/operating-model.js");
    window.surfaceRequests = 0;
    window.retrySurface = createOperatingModelSurface({
      apiUrl: (url) => url, documentList: document.querySelector("#document-list"), documentRef: document,
      getActiveWorkspaceRoute: () => ({ view: "my-plan", params: new URLSearchParams() }),
      navigateCanonicalWorkspace() {}, openDocument() {}, resolveDocReference() {}, setRouteTitle() {},
      request: async () => { window.surfaceRequests++; throw new Error("Unavailable"); },
    });
    window.retrySurface.renderMyPlan();
  });
  await expect(page.getByText("Operating model unavailable", { exact: true })).toBeVisible();
  await selectAndObserveFailure(page, "Operating model unavailable");
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.retrySurface.renderMyPlan(); });
  await expectStableSelection(page, "Operating model unavailable");
  expect(await page.evaluate(() => window.surfaceRequests)).toBe(1);
});
