const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
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

const ROUTES = [
  { path: '/', ready: '.ops-work-queue' },
  { path: '/tasks', ready: '.ops-work-queue' },
  { path: '/cards', ready: '.ops-workflows-board' },
  { path: '/cards/archive', ready: '.ops-workflows-board' },
  { path: '/templates', ready: '.ops-split-surface' },
  { path: '/recurring', ready: '.ops-recurring-surface' },
  { path: '/assistants', ready: '.assistant-workspace' },
  { path: '/bookkeeping', ready: '.bookkeeping-surface' },
  { path: '/sponsors', ready: '.sponsor-crm-surface' },
  { path: '/newsletter', ready: '.newsletter-surface' },
  { path: '/calendar', ready: '.calendar-surface' },
  { path: '/processes', ready: '.ops-surface-docs' },
  { path: '/operating-model', ready: '.operating-model-surface' },
  { path: '/review', ready: '.review-surface' },
  { path: '/admin', ready: '.ops-surface-admin' },
  { path: '/users', ready: '.ops-surface-users' },
  { path: '/device', ready: '.ops-surface-device' },
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
});

test.afterAll(async () => stopOwnedTestServer(server));

async function openRouteAt(page, viewport, route) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await setupPageWithAuth(page);
  const response = await page.goto(`${server.baseURL}/#${route.path}`);
  assertOwnedServerResponse(server, response, `mobile viewport ${route.path}`);
  await expect(page.locator(route.ready).first()).toBeVisible();
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

for (const viewport of VIEWPORTS) {
  for (const route of ROUTES) {
    test(`${route.path} at ${viewport.name}: fits width, starts below topbar, page scrolls`, async ({ page }) => {
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

      // The body is not scroll-locked, and a tall page actually scrolls to
      // reveal its bottom. A page that fits the viewport must not scroll.
      expect(layout.bodyOverflowY).not.toBe('hidden');
      expect(layout.htmlOverflowY).not.toBe('hidden');
      const scrollable = layout.scrollHeight > layout.viewport.height + 4;
      const scrolled = await page.evaluate(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        return window.scrollY;
      });
      if (scrollable) {
        expect(scrolled).toBeGreaterThan(0);
        expect(scrolled).toBeGreaterThanOrEqual(
          layout.scrollHeight - layout.viewport.height - 2,
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
