const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// The board tile opens with one row: where the card comes from (its Template),
// when it is anchored, and how far along it is. The row must never push the
// tile wider than its column; the Template name gives way first.

async function createTemplate(request, name) {
  const response = await request.post('/__e2e__/template-fixtures', {
    data: {
      name,
      type: 'synthetic-tile-row',
      icon: 'book',
      sourcePath: `workflow-templates/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`,
      sourceRevision: '1111111111111111111111111111111111111111',
      taskDefinitions: [
        { refId: 'one', description: 'Announce the book', offsetDays: -2 },
        { refId: 'two', description: 'Collect questions', offsetDays: -1 },
        { refId: 'three', description: 'Thank the authors', offsetDays: 1 },
      ],
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).template;
}

async function createCard(request, templateId, title) {
  const response = await request.post('/api/cards', {
    data: { title, anchorDate: '2026-10-12', templateId, stage: 'announced' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).card;
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900, countShares: true },
  // Just above the mobile breakpoint the sidebar stays and the three
  // columns share the remaining width: the narrowest a column gets. The
  // count may drop a line there, but nothing may overflow.
  { name: 'narrow-column', width: 821, height: 900, countShares: false },
  { name: 'mobile', width: 375, height: 812, countShares: true },
];

test.describe('Cards board tile', () => {
  let shortCard;
  let longCard;

  test.beforeAll(async ({ request }) => {
    const shortTemplate = await createTemplate(request, 'Book of the Week');
    const longTemplate = await createTemplate(
      request,
      'Book of the Week with a deliberately long Template name that cannot fit',
    );
    shortCard = await createCard(request, shortTemplate.id, 'Designing AI Systems');
    longCard = await createCard(request, longTemplate.id, 'Long-named Template tile');
  });

  for (const viewport of viewports) {
    test(`puts the Template, date and task count on one row at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/cards');
      const tile = page.locator(`.workflow-board-card[data-card-id="${shortCard.id}"]`);
      await expect(tile).toBeVisible();
      await expect(tile.locator('.workflow-card-meta-top')).toHaveCount(0);

      const row = tile.locator('.workflow-card-header');
      await expect(row).toHaveCount(1);
      // Where it comes from leads, then when, then progress.
      const order = await row.evaluate((node) => [...node.querySelectorAll(':scope > *, :scope > .workflow-card-lead > *')]
        .map((child) => child.className.split(' ')[0]));
      expect(order).toEqual(['workflow-card-lead', 'workflow-card-template', 'workflow-card-anchor', 'workflow-card-count']);
      await expect(row.locator('.workflow-card-template')).toHaveText('Book of the Week');
      await expect(row.locator('.workflow-card-count')).toHaveText('0/3 tasks');

      const measure = (node) => {
        const box = (selector) => {
          const rect = node.querySelector(selector).getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, middle: (rect.top + rect.bottom) / 2, height: rect.height };
        };
        const tile = node.closest('.workflow-board-card');
        const label = node.querySelector('.workflow-card-template-label');
        return {
          badge: box('.workflow-card-template'),
          anchor: box('.workflow-card-anchor'),
          count: box('.workflow-card-count'),
          title: tile.querySelector('.workflow-card-title').getBoundingClientRect().top,
          rowOverflows: node.scrollWidth > node.clientWidth,
          tileOverflows: tile.scrollWidth > tile.clientWidth,
          contentRight: tile.getBoundingClientRect().right - parseFloat(getComputedStyle(tile).paddingRight),
          // Truncated with an ellipsis, or (too narrow to read) icon only.
          labelGivesWay: getComputedStyle(label).display === 'none' || label.scrollWidth > label.clientWidth,
        };
      };

      const short = await row.evaluate(measure);
      expect(Math.abs(short.badge.middle - short.anchor.middle)).toBeLessThan(1);
      expect(short.badge.right).toBeLessThanOrEqual(short.anchor.left);
      // The Template chip is no taller than the date pill beside it.
      expect(short.badge.height).toBeLessThanOrEqual(short.anchor.height + 0.5);
      expect(short.title).toBeGreaterThanOrEqual(Math.max(short.anchor.bottom, short.count.bottom) - 0.5);

      const longTile = page.locator(`.workflow-board-card[data-card-id="${longCard.id}"]`);
      await longTile.scrollIntoViewIfNeeded();
      const long = await longTile.locator('.workflow-card-header').evaluate(measure);
      expect(long.rowOverflows).toBe(false);
      expect(long.tileOverflows).toBe(false);
      for (const part of [long.badge, long.anchor, long.count]) {
        expect(part.right).toBeLessThanOrEqual(long.contentRight + 0.5);
      }
      expect(Math.abs(long.badge.middle - long.anchor.middle)).toBeLessThan(1);
      expect(long.labelGivesWay).toBe(true);
      if (viewport.countShares) {
        expect(Math.abs(short.count.middle - short.anchor.middle)).toBeLessThan(2);
        expect(Math.abs(long.count.middle - long.anchor.middle)).toBeLessThan(2);
        expect(long.count.left).toBeGreaterThanOrEqual(long.anchor.right);
      }
      await expect(longTile.locator('.workflow-card-anchor')).toHaveText(/\d+ \w+/);
      await expect(longTile.locator('.workflow-card-count')).toHaveText('0/3 tasks');

      const screenshotDir = process.env.CARD_TILE_SCREENSHOT_DIR;
      if (screenshotDir) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await tile.scrollIntoViewIfNeeded();
        const prefix = process.env.CARD_TILE_SCREENSHOT_PREFIX || 'after';
        await tile.screenshot({ path: path.join(screenshotDir, `${prefix}-${viewport.name}-tile.png`) });
        await longTile.screenshot({ path: path.join(screenshotDir, `${prefix}-${viewport.name}-long-tile.png`) });
        await page.screenshot({ path: path.join(screenshotDir, `${prefix}-${viewport.name}-board.png`) });
      }
    });
  }
});
