// Queue Where cell: the card a task belongs to is a link to that Card, and
// pointing at it shows the Card's summary, with the podcast episode for a
// podcast Card. A phone has no hover: the info button beside the name opens
// the summary and a tap on the name opens the Card.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

let server;
let card;
let taskTitle;

test.describe.configure({ mode: 'serial' });

async function api(method, route, body) {
  const response = await fetch(`${server.baseURL}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.ok, `${method} ${route} ${response.status}`).toBeTruthy();
  return response.status === 204 ? null : response.json();
}

function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot('queue-card-hovercard'),
      E2E_SEED_PODCAST_TEMPLATE: '1',
    },
  });
  const episode = await api('POST', '/api/podcast-episodes', {
    season: 26,
    episode: 7,
    title: 'Synthetic hover card episode',
    guests: [{ name: 'Hova Example' }],
    status: 'recorded',
    recordingDate: isoDate(-3),
    releaseDate: isoDate(20),
    links: { youtube: 'https://www.youtube.com/watch?v=synthetic-hover' },
  });
  card = (await api('POST', `/api/podcast-episodes/${episode.id}/card`, { version: episode.version })).card;
  taskTitle = 'Synthetic hover card task';
  await api('POST', '/api/tasks', { description: taskTitle, date: isoDate(0), cardId: card.id });
});

test.afterAll(async () => stopOwnedTestServer(server));

function queueRow(page) {
  return page.locator('.ops-queue-row', { hasText: taskTitle });
}

test('desktop: hovering Where shows the Card summary and a click opens the Card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  const row = queueRow(page);
  await expect(row).toBeVisible({ timeout: 20000 });
  const where = row.locator('.ops-queue-origin-link');
  await expect(where).toHaveAttribute('href', `/cards?cardId=${card.id}`);
  await expect(row.locator('.ops-queue-origin-info')).toBeHidden();

  const box = await row.boundingBox();
  await where.hover();
  const summary = page.getByRole('dialog', { name: 'Card summary: Synthetic hover card episode' });
  await expect(summary).toBeVisible();
  if (process.env.HOVERCARD_SHOT) await page.screenshot({ path: `${process.env.HOVERCARD_SHOT}/desktop.png` });
  // A few short facts, the episode first: no header repeating the row, no
  // links, and no scrollbar.
  await expect(summary.locator('dt')).toHaveText(['Episode', 'Guests', 'Status', 'Recording', 'Release', 'Progress', 'Due']);
  await expect(summary).toContainText('S26E7 · Synthetic hover card episode');
  await expect(summary).toContainText('Hova Example');
  await expect(summary).toContainText('Recorded');
  await expect(summary).toContainText('tasks done');
  await expect(summary.getByRole('link')).toHaveCount(0);
  expect(await summary.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  // An overlay: the row does not move or grow under it.
  expect(await row.boundingBox()).toEqual(box);

  // The pointer can travel onto the card and it stays open; Escape closes it.
  await summary.hover();
  await page.waitForTimeout(400);
  await expect(summary).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(summary).toBeHidden();

  await where.click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?card=${card.id}$`));
  await expect(page.locator('#card-panel-title')).toHaveText('Synthetic hover card episode');
});

test('desktop: keyboard focus on Where shows the summary', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  const where = queueRow(page).locator('.ops-queue-origin-link');
  await expect(where).toBeVisible({ timeout: 20000 });
  await where.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const summary = page.getByRole('dialog', { name: /Card summary/ });
  await expect(summary).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(summary).toBeHidden();
  await expect(where).toBeFocused();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the info button opens the summary and a tap on the name opens the Card', async ({ page }) => {
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}/tasks`);
    const row = queueRow(page);
    await expect(row).toBeVisible({ timeout: 20000 });
    const info = row.locator('.ops-queue-origin-info');
    await expect(info).toBeVisible();
    await expect(info).toHaveAttribute('aria-expanded', 'false');
    await info.tap();
    const summary = page.getByRole('dialog', { name: /Card summary/ });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Hova Example');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    if (process.env.HOVERCARD_SHOT) await page.screenshot({ path: `${process.env.HOVERCARD_SHOT}/phone.png` });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    // Tapping inside the summary keeps it open and does not open the task.
    await summary.locator('.card-hovercard__fact').first().tap();
    await expect(summary).toBeVisible();
    await expect(page).toHaveURL(/\/tasks/);
    await info.tap();
    await expect(summary).toBeHidden();

    await row.locator('.ops-queue-origin-link').tap();
    await expect(page).toHaveURL(new RegExp(`/tasks\\?card=${card.id}$`));
    await expect(page.locator('#card-panel-title')).toHaveText('Synthetic hover card episode');
  });
});
