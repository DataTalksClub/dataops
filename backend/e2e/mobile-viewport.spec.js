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
  { path: '/templates', ready: '.ops-split-surface', content: '.runtime-template-layout, .ops-template-grid' },
  { path: '/recurring', ready: '.ops-recurring-surface', content: '.recurring-summary, .recurring-toolbar, .ops-recurring-section' },
  { path: '/assistants', ready: '.assistant-workspace', content: '.assistant-layout' },
  { path: '/bookkeeping', ready: '.bookkeeping-surface', content: '.bookkeeping-worklist, .bookkeeping-section' },
  { path: '/sponsors', ready: '.sponsor-crm-surface', content: '.crm-layout, .crm-upcoming-list, .crm-directory-row, .crm-booking-row', contentReady: '.crm-directory-row, .crm-upcoming-list, .ops-honest-state' },
  { path: '/newsletter', ready: '.newsletter-surface', content: '.newsletter-slot-row, .newsletter-slot-list, .newsletter-schedule' },
  { path: '/calendar', ready: '.calendar-surface', content: '.calendar-grid', contentReady: '.calendar-grid', mockCalendar: true },
  { path: '/processes', ready: '.ops-surface-docs', content: '.ops-docs-catalog, .ops-docs-state, .ops-docs-state-detail' },
  { path: '/operating-model', ready: '.operating-model-surface', content: '.operating-model-surface strong, .operating-model-surface table, .operating-model-surface .status-text' },
  { path: '/review', ready: '.review-surface', content: '.review-summary, .review-empty-state' },
  { path: '/admin', ready: '.ops-surface-admin', content: '.ops-admin-card, .ops-admin-intake-recovery' },
  { path: '/users', ready: '.ops-surface-users', content: '.ops-users-outcome, .ops-users-toolbar, .ops-users-table' },
  { path: '/device', ready: '.ops-surface-device', content: '.device-form' },
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
  const response = await page.goto(`${server.baseURL}/#${route.path}`);
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
    const topbar = document.querySelector('.mobile-topbar');
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

for (const viewport of VIEWPORTS) {
  for (const route of ROUTES) {
    test(`${route.path} at ${viewport.name}: fits width, starts below topbar, content within top quarter`, async ({ page }) => {
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
      const contentBudget = Math.round(layout.viewport.height * 0.25) + 2;
      test.info().annotations.push({
        type: 'content-start',
        description: `${route.path} content starts at ${contentTop}px (budget ${contentBudget}px)`,
      });
      expect(
        contentTop,
        `${route.path}: primary content starts at ${contentTop}px, budget is ${contentBudget}px`,
      ).toBeLessThanOrEqual(contentBudget);

      // The body is not scroll-locked, and a tall page actually scrolls to
      // reveal its bottom. A page that fits the viewport must not scroll.
      expect(layout.bodyOverflowY).not.toBe('hidden');
      expect(layout.htmlOverflowY).not.toBe('hidden');
      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const scrollable = scrollHeight > layout.viewport.height + 4;
      const scrolled = await page.evaluate(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        return window.scrollY;
      });
      if (scrollable) {
        expect(scrolled).toBeGreaterThan(0);
        expect(scrolled).toBeGreaterThanOrEqual(
          scrollHeight - layout.viewport.height - 2,
        );
      } else {
        expect(scrolled).toBeLessThanOrEqual(2);
      }

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
