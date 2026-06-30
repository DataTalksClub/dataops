const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// Issue #92: clicking a task card opens a Trello-style modal overlay (centered
// panel over a dimmed backdrop) instead of the right-hand side panel. The modal
// must close via Esc / backdrop click / close button, trap focus while open,
// return focus to the triggering card on close, swap content when a different
// task is opened, and render resolved names (from #90).
//
// The frontend portal (frontend/src/app.js) is only served under the single-origin
// docs domain (DATAOPS_DOCS_DOMAIN=1) with FRONTEND_ROOT pointing at the repo's
// frontend/. The default work-engine test server serves an older SPA, so this spec
// boots its own isolated server on port 3011 with the portal flags.

const PORT = 3011;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', 'frontend');
const WORK_ENGINE_ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots');

const AUTH_STORAGE_STATE = {
  cookies: [],
  origins: [
    {
      origin: BASE_URL,
      localStorage: [
        { name: 'dataops_token', value: 'issue92-bypass-token' },
        {
          name: 'dataops_user',
          value: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Grace',
            email: 'grace@datatalks.club',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      ],
    },
  ],
};

let serverProcess = null;

function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function poll() {
      const req = http.get(`${BASE_URL}/api/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error(`server on ${port} did not start`));
        setTimeout(poll, 300);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        if (Date.now() >= deadline) return reject(new Error(`server on ${port} did not start`));
        setTimeout(poll, 300);
      });
    }
    poll();
  });
}

function uid() {
  // Letters-only token: stripTitleSuffix (issue #91) only strips a trailing
  // token that contains BOTH letters and digits, so a letters-only suffix
  // survives and keeps each task's title unique and exactly matchable.
  return Array.from({ length: 6 }, () =>
    'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 25)]
  ).join('');
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

const GRACE_ID = '00000000-0000-0000-0000-000000000001';

async function api(method, reqPath, body) {
  const res = await fetch(`${BASE_URL}${reqPath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function deleteTask(taskId) {
  if (!taskId) return;
  try { await api('DELETE', '/api/tasks/' + taskId); } catch {}
}

async function archiveAndDeleteBundle(bundleId) {
  if (!bundleId) return;
  try {
    await api('PUT', `/api/bundles/${bundleId}/archive`);
    await api('DELETE', `/api/bundles/${bundleId}`);
  } catch {}
}

async function openTaskFromHome(page, textFragment) {
  // The Operations Home lanes are populated from the async work snapshot
  // (/work/api/tasks). In slower headless environments the snapshot can take a
  // few seconds to land, so wait for the network to settle before locating the
  // card rather than racing a tight visibility check.
  await page.goto(`${BASE_URL}/#/`);
  await page.waitForLoadState('networkidle').catch(() => {});
  const row = page.locator('.ops-lane-item', { has: page.locator('strong', { hasText: textFragment }) });
  await row.first().scrollIntoViewIfNeeded({ timeout: 30000 }).catch(() => {});
  await expect(row.first()).toContainText(textFragment, { timeout: 30000 });
  await row.first().click();
  await expect(page.locator('#task-panel')).toBeVisible({ timeout: 15000 });
  return row.first();
}

test.describe('Task card opens in a Trello-style modal (issue #92)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.setTimeout(90000);
    serverProcess = spawn(
      'npx',
      ['tsx', path.join('scripts', 'test-server.ts')],
      {
        cwd: WORK_ENGINE_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          IS_LOCAL: 'true',
          SKIP_AUTH: 'true',
          DATAOPS_DOCS_DOMAIN: '1',
          DTC_OFFLINE: '1',
          FRONTEND_ROOT,
          PORT: String(PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    serverProcess.stdout.on('data', (d) => process.stdout.write(`[fe-server] ${d}`));
    serverProcess.stderr.on('data', (d) => process.stderr.write(`[fe-server] ${d}`));
    await waitForServer(PORT);
  });

  test.afterAll(async () => {
    if (serverProcess) {
      try { process.kill(-serverProcess.pid, 'SIGTERM'); } catch {}
      serverProcess = null;
    }
  });

  test('clicking a task opens a centered modal with backdrop and content', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const bundleTitle = 'Modal Workflow ' + suffix;
    const desc = 'Task modal content ' + suffix;

    const b = await api('POST', '/api/bundles', { title: bundleTitle, anchorDate: today, status: 'active' });
    const bundleId = b.json.bundle.id;
    const t = await api('POST', '/api/tasks', { description: desc, date: today, assigneeId: GRACE_ID, bundleId });
    const taskId = t.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    try {
      const trigger = await openTaskFromHome(page, desc);
      const panel = page.locator('#task-panel');

      // Centered overlay + dimmed backdrop present, with dialog semantics.
      await expect(panel).toHaveClass(/task-modal/);
      await expect(panel.locator('.task-modal-backdrop')).toBeVisible();
      await expect(panel.locator('[role="dialog"]')).toHaveAttribute('aria-modal', 'true');

      // Resolved names from #90 render inside the modal body.
      const body = page.locator('#task-panel-body');
      await expect(body).toContainText('Workflow ' + bundleTitle);
      await expect(body).toContainText('Assignee Grace');

      await expect(trigger).toBeVisible();
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'task-modal-open.png') });
    } finally {
      await context.close();
      await deleteTask(taskId);
      await archiveAndDeleteBundle(bundleId);
    }
  });

  test('modal closes via Esc, backdrop click, and close button with focus return', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const desc = 'Task modal close paths ' + suffix;

    const t = await api('POST', '/api/tasks', { description: desc, date: today });
    const taskId = t.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    try {
      // Esc
      const triggerEsc = await openTaskFromHome(page, desc);
      await expect(page.locator('#task-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#task-panel')).toBeHidden();
      await expect(triggerEsc).toBeFocused();

      // Close button
      const triggerBtn = await openTaskFromHome(page, desc);
      await expect(page.locator('#task-panel')).toBeVisible();
      await page.locator('#task-panel-close').click();
      await expect(page.locator('#task-panel')).toBeHidden();
      await expect(triggerBtn).toBeFocused();

      // Backdrop click
      const triggerBackdrop = await openTaskFromHome(page, desc);
      await expect(page.locator('#task-panel')).toBeVisible();
      await page.locator('#task-modal-backdrop').click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#task-panel')).toBeHidden();
      await expect(triggerBackdrop).toBeFocused();
    } finally {
      await context.close();
      await deleteTask(taskId);
    }
  });

  test('focus is trapped inside the modal while open', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const desc = 'Task modal focus trap ' + suffix;

    const t = await api('POST', '/api/tasks', { description: desc, date: today });
    const taskId = t.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    try {
      await openTaskFromHome(page, desc);
      const panel = page.locator('#task-panel [role="dialog"]');
      await expect(panel).toBeVisible();

      // Focus starts inside the modal (on the close button).
      await expect(page.locator('#task-panel-close')).toBeFocused();

      // Tabbing cycles within the modal and never escapes to the page behind.
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const dlg = document.querySelector('#task-panel [role="dialog"]');
          return dlg ? dlg.contains(document.activeElement) : false;
        });
        expect(inside).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#task-panel')).toBeHidden();
    } finally {
      await context.close();
      await deleteTask(taskId);
    }
  });

  test('opening a different task while the modal is open swaps content', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const descA = 'Task modal switch A ' + suffix;
    const descB = 'Task modal switch B ' + suffix;

    const tA = await api('POST', '/api/tasks', { description: descA, date: today });
    const tB = await api('POST', '/api/tasks', { description: descB, date: today });
    const idA = tA.json.id;
    const idB = tB.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    try {
      await openTaskFromHome(page, descA);
      const body = page.locator('#task-panel-body');
      await expect(body).toContainText(descA, { timeout: 15000 });

      // Switch to task B while the modal is already open. In production this is
      // triggered by a notification (the bell calls openTaskPanel while a task modal
      // is showing). The modal backdrop sits above the home lanes, so a real pointer
      // click would hit the backdrop; instead we invoke card B's own click handler,
      // which routes through openTaskPanel(B) exactly as a notification would.
      const clickedB = await page.evaluate((fragment) => {
        const cards = [...document.querySelectorAll('.ops-lane-item')];
        const target = cards.find((card) => {
          const strong = card.querySelector('strong');
          return strong && strong.textContent === fragment;
        });
        if (!target) return false;
        target.click();
        return true;
      }, descB);
      expect(clickedB).toBe(true);

      // The modal stays open and its content swaps to task B (no stale task A panel).
      await expect(page.locator('#task-panel')).toBeVisible();
      await expect(body).toContainText(descB, { timeout: 15000 });

      await page.keyboard.press('Escape');
      await expect(page.locator('#task-panel')).toBeHidden();
    } finally {
      await context.close();
      await deleteTask(idA);
      await deleteTask(idB);
    }
  });

  test('modal is usable on a narrow viewport', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const desc = 'Task modal narrow ' + suffix;

    const t = await api('POST', '/api/tasks', { description: desc, date: today });
    const taskId = t.json.id;

    const context = await browser.newContext({
      baseURL: BASE_URL,
      storageState: AUTH_STORAGE_STATE,
      viewport: { width: 390, height: 780 },
    });
    const page = await context.newPage();
    try {
      await openTaskFromHome(page, desc);
      await expect(page.locator('#task-panel')).toBeVisible();

      // Close button stays reachable (not clipped) on a narrow viewport.
      const closeBtn = page.locator('#task-panel-close');
      await expect(closeBtn).toBeVisible();
      const box = await closeBtn.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'task-modal-narrow.png') });
      await closeBtn.click();
      await expect(page.locator('#task-panel')).toBeHidden();
    } finally {
      await context.close();
      await deleteTask(taskId);
    }
  });
});
