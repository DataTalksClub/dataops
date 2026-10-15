// Queue row layout: every row keeps its first line in the same place whether
// or not it carries a second line (a waiting or blocked note), and that
// second line is muted, one line, with the whole note on hover.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const CARD_TITLE = 'Synthetic observability for agent-built applications webinar';
const PLAIN = 'Synthetic layout task without a note';
const WAITING = '[Synthetic stage] Synthetic layout task waiting on a reply';
const WAITING_FOR = 'Synthetic copy and graphics, then a synthetic review';

let server;

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
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('queue-row-layout') },
  });
  const { card } = await api('POST', '/api/cards', { title: CARD_TITLE, anchorDate: isoDate(10), stage: 'announced' });
  await api('POST', '/api/tasks', { description: PLAIN, date: isoDate(-65), cardId: card.id });
  await api('POST', '/api/tasks', {
    description: WAITING,
    date: isoDate(1),
    cardId: card.id,
    status: 'waiting',
    waitingFor: WAITING_FOR,
    followUpAt: `${isoDate(1)}T09:00:00Z`,
    comment: 'Synthetic waiting fixture',
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

// Where each part of a row sits, relative to the row's own top edge.
async function rowGeometry(row) {
  return row.evaluate((node) => {
    // Measured from inside the border: the first row has no top border.
    const top = node.getBoundingClientRect().top + node.clientTop;
    const center = (selector) => {
      const rect = node.querySelector(selector).getBoundingClientRect();
      return Math.round(rect.top - top + rect.height / 2);
    };
    return {
      box: center('.ops-queue-box'),
      title: center('.ops-queue-title-row strong'),
      due: center('.ops-queue-due'),
      owner: center('.ops-queue-owner'),
    };
  });
}

test('desktop: a second line never moves the first, and reads muted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  const plain = page.locator('.ops-queue-row', { hasText: PLAIN });
  const waiting = page.locator('.ops-queue-row', { hasText: 'Synthetic layout task waiting on a reply' });
  await expect(plain).toBeVisible({ timeout: 20000 });
  await expect(waiting).toBeVisible();

  const withoutNote = await rowGeometry(plain);
  const withNote = await rowGeometry(waiting);
  expect(withNote).toEqual(withoutNote);
  // The tick and the other cells line up with the title line.
  for (const value of Object.values(withNote)) expect(Math.abs(value - withNote.title)).toBeLessThanOrEqual(2);

  const note = waiting.locator('.ops-queue-note');
  await expect(note).toHaveAttribute('title', new RegExp(`^Waiting for ${WAITING_FOR}`));
  const styles = await note.evaluate((node) => ({
    color: getComputedStyle(node).color,
    muted: getComputedStyle(document.body).getPropertyValue('--dk-text-muted').trim(),
    whiteSpace: getComputedStyle(node).whiteSpace,
    lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)),
  }));
  expect(styles.whiteSpace).toBe('nowrap');
  expect(styles.lines).toBe(1);
  const probe = await page.evaluate((muted) => {
    const node = document.createElement('span');
    node.style.color = muted;
    document.body.append(node);
    const color = getComputedStyle(node).color;
    node.remove();
    return color;
  }, styles.muted);
  expect(styles.color).toBe(probe);

  // Screen readers hear the note: it describes the title button.
  const main = waiting.locator('.ops-queue-main');
  const noteId = await note.getAttribute('id');
  await expect(main).toHaveAttribute('aria-describedby', noteId);
  await expect(main).toHaveAccessibleDescription(new RegExp(`Waiting for ${WAITING_FOR}`));
});

test('a queue row offers no Skip: skipping happens in the task, with a reason', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}/tasks`);
    const row = page.locator('.ops-queue-row', { hasText: PLAIN });
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.hover();
    await expect(row.getByRole('button', { name: /skip/i })).toHaveCount(0);
    await expect(page.locator('.ops-queue-head')).not.toContainText(/skip/i);
  }
});
