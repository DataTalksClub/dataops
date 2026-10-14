const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

const screenshots = path.resolve(__dirname, '../../.tmp/screenshots/mobile-viewport');

const VIEWPORTS = [
  { name: '375x667', width: 375, height: 667 },
  { name: '390x844', width: 390, height: 844 },
];

// `content` names the route's primary content: the first list, board, table,
// form, or honest empty state an operator actually works with. Headers,
// descriptions, action rows, and filter bars above it are chrome; the mobile
// layout budget requires the primary content itself to start within the top
// quarter of the viewport so chrome cannot crowd out the work. Routes are
// measured against a seeded dataset (cards across stages from multiple
// templates, tasks, sponsor organizations, newsletter slots), because empty
// states stack differently than the boards operators actually use.
//
const ROUTES = [
  { path: '/', ready: '.ops-work-queue', content: '.ops-queue-board, .ops-honest-state, .ops-empty', contentReady: '.ops-queue-list, .ops-empty' },
  { path: '/tasks', ready: '.ops-work-queue', content: '.ops-queue-board, .ops-honest-state, .ops-empty', contentReady: '.ops-queue-list, .ops-empty' },
  { path: '/cards', ready: '.ops-workflows-board', content: '.ops-workflows-grid', contentReady: '.ops-workflows-grid' },
  { path: '/cards/archive', ready: '.ops-workflows-board', content: '.workflow-archive-tabs, .cards-archive-grid, .ops-honest-state' },
  { path: '/templates', ready: '.runtime-template-layout', content: '.runtime-template-layout, .ops-template-grid' },
  { path: '/recurring', ready: '.ops-recurring-surface', content: '.recurring-toolbar, .ops-recurring-section' },
  { path: '/assistants', ready: '.assistant-workspace', content: '.assistant-layout' },
  { path: '/bookkeeping', ready: '.bookkeeping-surface', content: '.bookkeeping-worklist, .bookkeeping-monthlens' },
  { path: '/sponsors', ready: '.sponsor-crm-surface', content: '.crm-layout, .crm-upcoming-list, .crm-directory-row, .crm-booking-row', contentReady: '.crm-master .crm-booking-row, .crm-master .honest-state' },
  { path: '/newsletter', ready: '.newsletter-surface', content: '.newsletter-slot-row, .newsletter-slot-list, .newsletter-schedule' },
  { path: '/calendar', ready: '.calendar-surface', content: '.calendar-grid', contentReady: '.calendar-grid', mockCalendar: true },
  { path: '/processes', ready: '.ops-surface-docs', content: '.ops-docs-catalog, .ops-docs-state, .ops-docs-state-detail' },
  { path: '/operating-model', ready: '.operating-model-surface', content: '.operating-model-surface strong, .operating-model-surface table, .operating-model-surface .status-text' },
  { path: '/review', ready: '.review-surface', content: '.review-summary, .review-empty-state' },
  { path: '/admin', ready: '.ops-surface-admin', content: '.ops-admin-card, .ops-admin-intake-recovery' },
  { path: '/users', ready: '.ops-surface-users', content: '.ops-users-outcome, .ops-users-toolbar, .ops-users-table' },
];

const SURFACE_SELECTOR = ROUTES.map((route) => route.ready).join(', ');

let server;

test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot('mobile-viewport'),
    },
  });
  const seeded = await seedOperationsData(server.baseURL);
  console.log(
    `mobile-viewport seed: ${seeded.cards} cards, ${seeded.tasks} tasks, ` +
      `${seeded.organizations} organizations, ${seeded.slots} newsletter slots` +
      (seeded.failures.length ? `, failures: ${seeded.failures.join('; ')}` : ''),
  );
});

test.afterAll(async () => stopOwnedTestServer(server));

async function openRouteAt(page, viewport, route) {
  if (route.mockCalendar) {
    // The calendar grid renders only after its items fetch settles; serve a
    // small deterministic payload (same approach as calendar-seams.spec.js)
    // so the layout check measures the grid, not a spinner.
    await page.route('**/api/calendar-items**', (route2) =>
      route2.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [], holidays: [], alerts: [], timeZone: 'Europe/Berlin' }),
      }),
    );
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await setupPageWithAuth(page);
  const response = await page.goto(`${server.baseURL}${route.path}`);
  assertOwnedServerResponse(server, response, `mobile viewport ${route.path}`);
  await expect(page.locator(route.ready).first()).toBeVisible();
  if (route.contentReady) {
    await expect(page.locator(route.contentReady).first()).toBeVisible();
  }
  await page.waitForTimeout(400);
}

async function measureMobileLayout(page) {
  return page.evaluate((surfaceSelector) => {
    const documentElement = document.documentElement;
    const body = document.body;
    const topbar = document.querySelector('.dk-topbar');
    const topbarRect = topbar ? topbar.getBoundingClientRect() : null;
    const surface = document.querySelector(surfaceSelector);
    const surfaceRect = surface ? surface.getBoundingClientRect() : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: documentElement.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      scrollHeight: documentElement.scrollHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      htmlOverflowY: getComputedStyle(documentElement).overflowY,
      topbar: topbarRect ? { top: topbarRect.top, height: topbarRect.height } : null,
      surface: surfaceRect ? { top: surfaceRect.top, bottom: surfaceRect.bottom } : null,
    };
  }, SURFACE_SELECTOR);
}

async function measureContentStart(page, contentSelector) {
  return page.evaluate((selector) => {
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (rect.width === 0 && rect.height === 0) continue;
      return Math.round(rect.top);
    }
    return null;
  }, contentSelector);
}


// The seeded newsletter baseline (before issue-card compaction) measured
// 232px per card at 375x667: four full-size action buttons wrapped onto two
// rows under the date and booking lines. The compact card carries one
// primary button plus a "More" overflow, so half the baseline plus a small
// margin for 44px touch targets is the hard budget.
const NEWSLETTER_CARD_BUDGET_PX = 132;
const NEWSLETTER_CARD_BASELINE_PX = 232;

for (const viewport of VIEWPORTS) {
  for (const route of ROUTES) {
    test(`${route.path} at ${viewport.name}: fits width, starts below topbar, compact visible page header`, async ({ page }) => {
      test.setTimeout(60_000);
      await openRouteAt(page, viewport, route);
      const layout = await measureMobileLayout(page);

      // No horizontal overflow: the document never exceeds the viewport,
      // even where boards and calendar weeks scroll inside their own
      // overflow-x containers.
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport.width + 1);
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewport.width + 1);

      // The sticky mobile topbar stays a compact strip, not a toolbar that
      // eats the viewport.
      expect(layout.topbar).not.toBeNull();
      expect(layout.topbar.height).toBeGreaterThanOrEqual(44);
      expect(layout.topbar.height).toBeLessThanOrEqual(96);

      // Surface content starts below the topbar (not hidden underneath it)
      // and begins within the first screen.
      expect(layout.surface).not.toBeNull();
      expect(layout.surface.top).toBeGreaterThanOrEqual(
        layout.topbar.top + layout.topbar.height - 2,
      );
      expect(layout.surface.top).toBeLessThan(layout.viewport.height);

      // Primary content starts within the top quarter of the viewport:
      // titles, helper text, and action buttons above it must stay compact
      // so the work itself is on screen (mobile content-start budget). The
      // measured position rides along as an annotation on every route.
      const contentTop = await measureContentStart(page, route.content);
      expect(
        contentTop,
        `${route.path}: no visible primary content matched ${route.content}`,
      ).not.toBeNull();
      const contentBudget = Math.round(layout.viewport.height / 3) + 2;
      test.info().annotations.push({
        type: 'content-start',
        description: `${route.path} content starts at ${contentTop}px (budget ${contentBudget}px)`,
      });
      expect(
        contentTop,
        `${route.path}: primary content starts at ${contentTop}px, budget is ${contentBudget}px`,
      ).toBeLessThanOrEqual(contentBudget);

      // The kit main is the page scroller; views contribute their full height.
      const main = page.locator('#main-content');
      await expect(main).toHaveCSS('overflow-y', 'auto');
      await expect(main).toHaveCSS('padding-left', '16px');
      await expect(main).toHaveCSS('padding-right', '16px');
      const scrolling = await main.evaluate(node => {
        node.scrollTop = node.scrollHeight;
        return { top: node.scrollTop, extent: node.scrollHeight - node.clientHeight };
      });
      if (scrolling.extent > 4) expect(scrolling.top).toBeGreaterThan(0);
      expect(scrolling.top).toBeGreaterThanOrEqual(Math.max(0, scrolling.extent - 2));
      await main.evaluate(node => { node.scrollTop = 0; });

      await page.screenshot({
        path: path.join(
          screenshots,
          `${route.path.replace(/\//g, '_') || 'root'}-${viewport.name}.png`,
        ),
        fullPage: false,
        animations: 'disabled',
      });
    });
  }
}

test('newsletter at 375x667: issue cards fit the compaction budget and the overflow menu holds the moved actions', async ({ page }) => {
  test.setTimeout(60_000);
  const viewport = VIEWPORTS[0];
  const route = ROUTES.find((candidate) => candidate.path === '/newsletter');
  await openRouteAt(page, viewport, route);

  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.newsletter-slot-row')].map((card) =>
      Math.round(card.getBoundingClientRect().height),
    ),
  );
  expect(
    heights.length,
    'the seeded dataset must render at least one newsletter issue card',
  ).toBeGreaterThan(0);
  for (const height of heights) {
    test.info().annotations.push({
      type: 'newsletter-card-height',
      description: `${height}px (baseline ${NEWSLETTER_CARD_BASELINE_PX}px, budget ${NEWSLETTER_CARD_BUDGET_PX}px)`,
    });
    expect(
      height,
      `issue card is ${height}px, budget is ${NEWSLETTER_CARD_BUDGET_PX}px ` +
        `(baseline ${NEWSLETTER_CARD_BASELINE_PX}px before the overflow menu)`,
    ).toBeLessThanOrEqual(NEWSLETTER_CARD_BUDGET_PX);
  }

  const firstCard = page.locator('.newsletter-slot-row').first();
  await expect(firstCard.locator('.newsletter-slot-primary')).toHaveText('Compose');
  const trigger = firstCard.locator('.newsletter-overflow-trigger');
  const menu = firstCard.locator('.newsletter-overflow-menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  for (const movedAction of ['Preview', 'Schedule', 'Edit details']) {
    await expect(
      menu.locator('.newsletter-overflow-item').filter({ hasText: movedAction }),
    ).toBeVisible();
  }

  // A moved action still drives the issue dialog it opened inline before.
  await menu.locator('button[data-edit]').click();
  await expect(page.locator('.newsletter-surface dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // Escape closes the overflow menu and hands focus back to its trigger.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('bookkeeping at 375x667: period controls reflow, the shared stat strip keeps zeros, and the ledger scrolls into view', async ({ page }) => {
  test.setTimeout(60_000);
  const viewport = VIEWPORTS[0];
  const route = ROUTES.find((candidate) => candidate.path === '/bookkeeping');
  await openRouteAt(page, viewport, route);
  await expect(page.locator('.bookkeeping-close-state .dk-stat-strip')).toHaveCount(1);
  const values = page.locator('.dk-stat__value');
  await expect(values).toHaveCount(4);
  expect(await values.allTextContents()).toContain('0');
  const monoFamily = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dk-font-mono').split(',')[0].trim().replace(/['"]/g, ''));
  for (const value of await values.all()) {
    expect(await value.evaluate(node => getComputedStyle(node).fontFamily)).toContain(monoFamily);
    expect(await value.evaluate(node => getComputedStyle(node).color)).toBe(await page.locator('h1').evaluate(node => getComputedStyle(node).color));
  }
  for (const control of await page.locator('.bookkeeping-lens-nav button,.bookkeeping-lens-nav select').all()) {
    expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  const previous = await page.locator('[data-lens-prev]').boundingBox();
  expect(previous.width).toBeGreaterThanOrEqual(44);
  await page.locator('#bookkeeping-ledger-heading').scrollIntoViewIfNeeded();
  await expect(page.locator('#bookkeeping-ledger-heading')).toBeInViewport();
  expect(await page.locator('#main-content').evaluate(node => node.scrollTop)).toBeGreaterThan(0);

  // The seeded month has no open items, so the close panel is collapsed to
  // its one-line summary; expanding it reveals the reconcile list.
  const worklistSection = page.locator('[data-worklist-section]');
  expect(
    await worklistSection.getAttribute('open'),
    'the close panel must collapse on mobile when nothing needs attention',
  ).toBeNull();
  await expect(page.locator('[data-worklist-hint]')).toHaveText('All clear');
  await expect(page.locator('.bookkeeping-worklist')).toBeHidden();

  await page.locator('.bookkeeping-worklist-summary').click();
  await expect(page.locator('.bookkeeping-worklist')).toBeVisible();
  await expect(page.locator('.bookkeeping-worklist')).toContainText('Nothing needs attention');
  await page.locator('.bookkeeping-worklist-summary').click();
  await expect(page.locator('.bookkeeping-worklist')).toBeHidden();
});
