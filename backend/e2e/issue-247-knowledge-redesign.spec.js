const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const { setupPageWithAuth } = require("./helpers/auth");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  ".tmp",
  "screenshots",
  "issue-247",
  "after",
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const OVERVIEW_PATH = "content/00-start-here/business-system-map/system-overview.md";
const SOP_PATH = "content/00-start-here/business-system-map/weekly-newsletter.md";
const FUNCTIONS_PATH = "content/00-start-here/business-system-map/functions.md";

const OVERVIEW_DOC = [
  "---",
  "id: reference.synthetic.system-overview",
  "title: Synthetic system overview",
  "summary: Public-safe operating-model overview fixture.",
  "doc_type: reference",
  "domain: operations",
  "systems: [dataops]",
  "tags: [operating-model, overview, system-map]",
  "related_docs:",
  "  - functions.md",
  "  - weekly-newsletter.md",
  "---",
  "",
  "# Synthetic system overview",
  "",
  "This public-safe fixture stands in for a long operating-model overview.",
  "It is not a real SOP and contains no private operational content.",
  "",
  "## What this map covers",
  "",
  "The operating model answers four questions:",
  "",
  "- Which units own which outcomes?",
  "- Which functions are accountable for those outcomes?",
  "- Which systems currently exist, and which are still gaps?",
  "- What sequence turns the map into weekly decisions?",
  "",
  "## Units",
  "",
  "1. Learning — courses, workshops, and community programs.",
  "2. Media — newsletter, podcast, and public calendar.",
  "3. Partnerships — sponsors, invoices, and delivery proof.",
  "",
  "## How to read a function",
  "",
  "| Function | Outcome | Coverage |",
  "| --- | --- | --- |",
  "| Editorial | Weekly public schedule | Partial |",
  "| Finance | Books closed monthly | Gap |",
  "",
  "The table is the last block so a sticky footer cannot hide it.",
  "",
].join("\n");

const FUNCTIONS_DOC = [
  "---",
  "id: reference.synthetic.functions",
  "title: Functions",
  "summary: Accountable seats in the operating model.",
  "doc_type: reference",
  "domain: operations",
  "---",
  "",
  "# Functions",
  "",
  "Editorial publishes on time.",
  "",
].join("\n");

const SOP_DOC = [
  "---",
  "id: sop.synthetic.publish-weekly-newsletter",
  "title: Synthetic weekly newsletter SOP",
  "summary: Prepare the weekly newsletter from public-safe planning slots.",
  "doc_type: sop",
  "schema_version: 1",
  "domain: operations",
  "systems: [newsletter]",
  "tags: [weekly]",
  "related_docs:",
  "  - system-overview.md",
  "---",
  "",
  "# Synthetic weekly newsletter SOP",
  "",
  "<!-- sop-section-start: summary -->",
  "## Summary",
  "",
  "Prepare the weekly newsletter from the public-safe planning slots.",
  "<!-- sop-section-end -->",
  "",
  "<!-- sop-section-start: prerequisites -->",
  "## Prerequisites",
  "",
  "- The newsletter slot is reserved.",
  "- Links in the draft are public-safe.",
  "- The calendar overlay is current.",
  "<!-- sop-section-end -->",
  "",
  "<!-- sop-section-start: procedure -->",
  "## Procedure",
  "",
  "<!-- sop-step-start id=1 systems=\"newsletter\" -->",
  "1.  Collect the public-safe planning slots for this week.",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-step-start id=2 action=\"click\" systems=\"newsletter\" -->",
  "2.  Open the draft in the mailing tool.",
  "<!-- sop-step-end -->",
  "",
  "<!-- sop-step-start id=3 action=\"verify\" systems=\"newsletter\" -->",
  "3.  Confirm the archive copy exists after send.",
  "<!-- sop-step-end -->",
  "<!-- sop-section-end -->",
  "",
  "<!-- sop-section-start: validation -->",
  "## Validation",
  "",
  "The archive copy exists.",
  "<!-- sop-section-end -->",
  "",
  "<!-- sop-section-start: troubleshooting -->",
  "## Troubleshooting",
  "",
  "If send fails, retry once.",
  "<!-- sop-section-end -->",
  "",
  "<!-- sop-section-start: references -->",
  "## References",
  "",
  "See the system overview.",
  "<!-- sop-section-end -->",
  "",
].join("\n");

const session = {
  id: "W01",
  title: "Set the operating cadence",
  proposedDate: "2026-09-10",
  goal: "Agree the cadence",
  deliverables: "Decision log",
  decisionsNeeded: "Cadence",
  agentWork: "Prepare options",
  definitionOfDone: "Decision recorded",
  documentId: "reference.session.w01",
  state: "proposed",
  card: null,
  checklist: [
    { id: "decide", title: "Record the decision", phase: "decide", proof: "Decision note" },
  ],
};

const model = {
  revision: "revision-1",
  freshness: "current",
  overviewDocumentId: "reference.synthetic.system-overview",
  businessUnits: [{ name: "Learning", role: "Own the product" }],
  functions: [{
    name: "Editorial",
    outcome: "Publish on time",
    managerTitle: "Editorial lead",
    currentCoverage: "Partial coverage",
    documentId: "sop.synthetic.publish-weekly-newsletter",
  }],
  systems: [],
  gaps: [],
  lifecycles: [],
  assets: [],
  dependencies: [],
  roadmap: { sessions: [session] },
};

let server;

async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

async function scrollReaderToEnd(page) {
  await page.evaluate(() => {
    const view = document.querySelector(".view");
    if (view) view.scrollTop = view.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
}

async function expectAboveFooter(page, text) {
  const prose = page.getByText(text).last();
  await expect(prose).toBeVisible();
  const proseBox = await prose.boundingBox();
  const footer = page.locator(".document-editor-footer");
  const footerBox = await footer.boundingBox();
  expect(proseBox, `missing box for ${text}`).toBeTruthy();
  expect(footerBox, "missing footer box").toBeTruthy();
  expect(proseBox.y + proseBox.height).toBeLessThanOrEqual(footerBox.y + 1);
}

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot("issue-247-knowledge-redesign", {
        [OVERVIEW_PATH]: OVERVIEW_DOC,
        [SOP_PATH]: SOP_DOC,
        [FUNCTIONS_PATH]: FUNCTIONS_DOC,
      }),
    },
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

async function openWorkspace(page, hash) {
  await setupPageWithAuth(page);
  const root = await page.goto(`${server.baseURL}/${hash}`);
  assertOwnedServerResponse(server, root, hash);
}

test("captures Knowledge family after screenshots", async ({ page }) => {
  test.setTimeout(180_000);
  await page.route("**/api/operating-model", (route) => route.fulfill({ json: { model } }));

  await page.setViewportSize(DESKTOP);
  await openWorkspace(page, "#/processes");
  await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Synthetic system overview/ })).toBeVisible();
  await expect(page.getByText("Quality Findings")).toHaveCount(0);
  await screenshot(page, "process-docs-library-desktop-1440-light");

  await page.evaluate(() => document.getElementById("theme-toggle-button")?.click());
  await screenshot(page, "process-docs-library-desktop-1440-dark");
  await page.evaluate(() => document.getElementById("theme-toggle-button")?.click());

  await page.setViewportSize(MOBILE);
  await screenshot(page, "process-docs-library-mobile-390-light");

  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: /Synthetic system overview/ }).click();
  await expect(page.getByRole("heading", { name: "Synthetic system overview", exact: true })).toBeVisible();
  await expect(page.locator(".rendered-view h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "How to read a function" })).toBeVisible();
  await expect(page.getByText("Choose File")).toHaveCount(0);
  await expect(page.locator("#document-path")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Related" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Functions" })).toBeVisible();
  await scrollReaderToEnd(page);
  await expectAboveFooter(page, "The table is the last block so a sticky footer cannot hide it.");
  await screenshot(page, "process-docs-reader-overview-desktop-1440-light");
  await page.setViewportSize(MOBILE);
  await scrollReaderToEnd(page);
  await expectAboveFooter(page, "The table is the last block so a sticky footer cannot hide it.");
  await screenshot(page, "process-docs-reader-overview-mobile-390-light");

  await page.setViewportSize(DESKTOP);
  await page.goto(`${server.baseURL}/#/processes`);
  await expect(page.getByRole("button", { name: /Synthetic weekly newsletter SOP/ })).toBeVisible();
  await page.getByRole("button", { name: /Synthetic weekly newsletter SOP/ }).click();
  await expect(page.getByRole("heading", { name: "Synthetic weekly newsletter SOP" })).toBeVisible();
  await expect(page.getByText("Section Summary")).toHaveCount(0);
  await expect(page.getByText("No TODOs yet.")).toHaveCount(0);
  await expect(page.getByText("Choose File")).toHaveCount(0);
  await expect(page.getByText("+ New step")).toHaveCount(0);
  await expect(page.locator(".block-step")).toHaveCount(3);
  await expect(page.getByText("collect", { exact: true })).toHaveCount(0);
  await screenshot(page, "process-docs-reader-sop-desktop-1440-light");
  await page.setViewportSize(MOBILE);
  await scrollReaderToEnd(page);
  await expectAboveFooter(page, "See the system overview.");
  await screenshot(page, "process-docs-reader-sop-mobile-390-light");

  await page.setViewportSize(DESKTOP);
  await page.goto(`${server.baseURL}/#/operating-model`);
  await expect(page.getByRole("heading", { name: "Operating Model" })).toBeVisible();
  await expect(page.getByText("Company system")).toHaveCount(0);
  await screenshot(page, "operating-model-hub-desktop-1440-light");
  await page.setViewportSize(MOBILE);
  await screenshot(page, "operating-model-hub-mobile-390-light");

  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Open Functions" }).click();
  await expect(page.getByRole("heading", { name: "Functions" })).toBeVisible();
  await expect(page.getByText("Editorial lead · Partial coverage")).toBeVisible();
  await screenshot(page, "operating-model-functions-desktop-1440-light");
  await page.setViewportSize(MOBILE);
  await screenshot(page, "operating-model-functions-mobile-390-light");

});
