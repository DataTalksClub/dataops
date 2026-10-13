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

const HANDBOOK_PATH = "content/00-start-here/handbook.md";
const ONBOARDING_PATH = "content/00-start-here/handbook/onboarding.md";
const CHECKLIST_PATH = "content/00-start-here/handbook/onboarding/checklist.md";
const TOOLS_PATH = "content/00-start-here/tools.md";

const HANDBOOK_DOC = [
  "---",
  "id: reference.handbook",
  "title: Company Handbook",
  "summary: Core operating handbook and company guides.",
  "doc_type: reference",
  "domain: operations",
  "---",
  "",
  "# Company Handbook",
  "",
  "Welcome to the team handbook.",
  "",
].join("\n");

const ONBOARDING_DOC = [
  "---",
  "id: reference.onboarding",
  "parent: reference.handbook",
  "title: Employee Onboarding",
  "summary: Guide for onboarding new team members.",
  "doc_type: reference",
  "domain: operations",
  "---",
  "",
  "# Employee Onboarding",
  "",
  "Steps for new team member onboarding.",
  "",
].join("\n");

const CHECKLIST_DOC = [
  "---",
  "id: reference.checklist",
  "parent: reference.onboarding",
  "title: First Day Checklist",
  "summary: First day setup checklist for new teammates.",
  "doc_type: reference",
  "domain: operations",
  "---",
  "",
  "# First Day Checklist",
  "",
  "1. Set up workstation.",
  "2. Join communication channels.",
  "",
].join("\n");

const TOOLS_DOC = [
  "---",
  "id: reference.tools",
  "title: Tools & Equipment",
  "summary: Standard developer tools and equipment.",
  "doc_type: reference",
  "domain: operations",
  "---",
  "",
  "# Tools & Equipment",
  "",
  "Approved equipment list.",
  "",
].join("\n");

let server;

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot("nested-docs", {
        [HANDBOOK_PATH]: HANDBOOK_DOC,
        [ONBOARDING_PATH]: ONBOARDING_DOC,
        [CHECKLIST_PATH]: CHECKLIST_DOC,
        [TOOLS_PATH]: TOOLS_DOC,
      }),
    },
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

async function openWorkspace(page, hash) {
  await setupPageWithAuth(page);
  const root = await page.goto(`${server.baseURL}${hash}`);
  assertOwnedServerResponse(server, root, hash);
}

test.describe("Nested Doc Pages", () => {
  test("renders document tree with expand/collapse hierarchy", async ({ page }) => {
    await openWorkspace(page, "/processes");
    await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible({ timeout: 20_000 });

    const tree = page.locator(".ops-docs-tree");
    await expect(tree).toBeVisible();

    // Root nodes should be visible
    const handbookLink = tree.locator(".ops-docs-tree-link").filter({ hasText: "Company Handbook" });
    const toolsLink = tree.locator(".ops-docs-tree-link").filter({ hasText: "Tools & Equipment" });
    await expect(handbookLink).toBeVisible();
    await expect(toolsLink).toBeVisible();

    // Child nodes should initially be collapsed (hidden)
    const onboardingNode = tree.locator('.ops-docs-tree-node[data-doc-id="reference.onboarding"]');
    await expect(onboardingNode).toBeHidden();

    // Find the toggle button on Company Handbook
    const handbookNode = tree.locator('.ops-docs-tree-node[data-doc-id="reference.handbook"]');
    const handbookToggle = handbookNode.locator(".ops-docs-tree-toggle").first();
    await expect(handbookToggle).toBeVisible();
    await expect(handbookToggle).toHaveAttribute("aria-expanded", "false");

    // Click toggle to expand
    await handbookToggle.click();
    await expect(handbookToggle).toHaveAttribute("aria-expanded", "true");
    await expect(onboardingNode).toBeVisible();

    // Grandchild checklist is still collapsed
    const checklistNode = tree.locator('.ops-docs-tree-node[data-doc-id="reference.checklist"]');
    await expect(checklistNode).toBeHidden();

    // Expand Onboarding
    const onboardingToggle = onboardingNode.locator(".ops-docs-tree-toggle").first();
    await onboardingToggle.click();
    await expect(checklistNode).toBeVisible();

    // Collapse Handbook again — all descendants should be hidden
    await handbookToggle.click();
    await expect(handbookToggle).toHaveAttribute("aria-expanded", "false");
    await expect(onboardingNode).toBeHidden();
    await expect(checklistNode).toBeHidden();
  });

  test("renders full ancestor breadcrumb trail and navigates to parent", async ({ page }) => {
    await openWorkspace(page, "/processes");
    await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible({ timeout: 20_000 });

    // Expand to find checklist and open it
    const handbookNode = page.locator('.ops-docs-tree-node[data-doc-id="reference.handbook"]');
    await handbookNode.locator(".ops-docs-tree-toggle").first().click();

    const onboardingNode = page.locator('.ops-docs-tree-node[data-doc-id="reference.onboarding"]');
    await onboardingNode.locator(".ops-docs-tree-toggle").first().click();

    const checklistLink = page.locator(
      '.ops-docs-tree-node[data-doc-id="reference.checklist"] > .ops-docs-tree-row .ops-docs-tree-link',
    );
    await checklistLink.click();

    // Check breadcrumb trail
    const breadcrumb = page.locator(".doc-hierarchy-trail");
    await expect(breadcrumb).toBeVisible();

    // Breadcrumb links should include Docs, Company Handbook, Employee Onboarding
    const trailItems = breadcrumb.locator(".doc-trail-link");
    await expect(trailItems).toHaveCount(3);
    await expect(trailItems.nth(0)).toContainText("Docs");
    await expect(trailItems.nth(1)).toContainText("Company Handbook");
    await expect(trailItems.nth(2)).toContainText("Employee Onboarding");

    // Current doc is rendered at the end of the trail
    const currentItem = breadcrumb.locator(".doc-trail-current");
    await expect(currentItem).toContainText("First Day Checklist");

    // Click Company Handbook link in trail to navigate back up
    await trailItems.nth(1).click();
    await expect(page.locator(".rendered-view h1")).toContainText("Company Handbook");

    // Company Handbook should display Sub-pages block with Employee Onboarding
    const subpagesBlock = page.locator(".doc-subpages");
    await expect(subpagesBlock).toBeVisible();
    await expect(subpagesBlock.locator(".doc-subpage-item")).toContainText("Employee Onboarding");
    await expect(subpagesBlock.locator(".doc-add-subpage-btn")).toBeVisible();
  });

  test("move page dialog prevents cycles by excluding self and descendants", async ({ page }) => {
    await openWorkspace(page, "/processes");
    await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible({ timeout: 20_000 });

    const handbookNode = page.locator('.ops-docs-tree-node[data-doc-id="reference.handbook"]');
    const moveBtn = handbookNode.locator(".ops-docs-tree-btn-move").first();
    await expect(moveBtn).toBeVisible();
    await moveBtn.click();

    // Move modal should open
    const modal = page.locator(".doc-move-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".task-panel-header")).toContainText('Move "Company Handbook"');

    // Inspect options in select dropdown
    const select = modal.locator(".doc-move-select");
    await expect(select).toBeVisible();
    const optionTexts = await select.locator("option").allTextContents();

    // Options must include Top-level / No parent and Tools & Equipment
    expect(optionTexts.some((text) => text.includes("No parent") || text.includes("Top-level"))).toBe(true);
    expect(optionTexts.some((text) => text.includes("Tools & Equipment"))).toBe(true);

    // Options must NOT include Company Handbook (self) or its descendants (Employee Onboarding, First Day Checklist)
    expect(optionTexts.some((text) => text.includes("Company Handbook"))).toBe(false);
    expect(optionTexts.some((text) => text.includes("Employee Onboarding"))).toBe(false);
    expect(optionTexts.some((text) => text.includes("First Day Checklist"))).toBe(false);

    // Cancel closes dialog cleanly
    await modal.locator("button", { name: "Cancel" }).first().click();
    await expect(modal).toBeHidden();
  });

  test("mobile viewports 375x667 and 390x844 render tree and breadcrumbs without overflow", async ({ page }) => {
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await openWorkspace(page, "/processes");
      await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible({ timeout: 20_000 });

      // Expand nodes in tree
      const handbookNode = page.locator('.ops-docs-tree-node[data-doc-id="reference.handbook"]');
      await handbookNode.locator(".ops-docs-tree-toggle").first().click();

      // Verify no horizontal overflow in body
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewport.width + 1);

      // Open a document and check breadcrumb wrapping / layout
      const onboardingLink = page.locator(
        '.ops-docs-tree-node[data-doc-id="reference.onboarding"] > .ops-docs-tree-row .ops-docs-tree-link',
      );
      await onboardingLink.click();
      await expect(page.locator(".doc-hierarchy-trail")).toBeVisible();

      const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(docScrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    }
  });
});
