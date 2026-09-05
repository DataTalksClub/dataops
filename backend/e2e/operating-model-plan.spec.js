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

