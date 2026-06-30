const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// Issue #96: the task LIST card (renderWorkQueueRow + operationItemFromTask in
// frontend/src/app.js) must show the assignee's name instead of the raw
// assigneeId UUID, reusing the same cached usersById lookup that the detail
// panel (renderTaskPanel) started using in #90. Unknown/missing assignees must
// degrade gracefully ("-") with no console error.
//
// Like task-detail-names.spec.js (#90), the real frontend portal only runs when
// DATAOPS_DOCS_DOMAIN=1 with FRONTEND_ROOT on the repo frontend/. This spec
// boots its own isolated server on port 3011 with those flags.

const PORT = 3011;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const AUTH_STORAGE_STATE = {
  cookies: [],
  origins: [
    {
      origin: BASE_URL,
      localStorage: [
        { name: 'dataops_token', value: 'issue96-bypass-token' },
        { name: 'dataops_user', value: JSON.stringify({
          id: '00000000-0000-0000-0000-000000000001', name: 'Grace', email: 'grace@datatalks.club', createdAt: '2026-01-01T00:00:00.000Z',
        }) },
      ],
    },
  ],
};
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', 'frontend');
const WORK_ENGINE_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots');

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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const UNKNOWN_ASSIGNEE_ID = '00000000-0000-0000-0000-000000000099';

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

// Land on the Tasks > Queue surface and wait for the work snapshot to hydrate.
// The queue renders each task as a .ops-queue-row card with .ops-queue-meta chips.
// The workspace view (Home/Tasks/Docs) is driven by nav button clicks, not the
// location hash, and the work-snapshot refresh seam only re-renders Home, so we
// force a fresh snapshot fetch then click into Tasks > Queue so renderTasksSurface
// reads the hydrated snapshot.
async function openQueueWithCard(page, textFragment) {
  const row = page.locator('.ops-queue-row', { has: page.locator('strong', { hasText: textFragment }) });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt === 0) await page.goto(`${BASE_URL}/#/`);
    // Force a fresh work-snapshot fetch + re-render. The snapshot fetch is the
    // source of truth for the queue rows; we then switch into Tasks/Queue so
    // renderTasksSurface reads the hydrated snapshot.
    await page.evaluate(() => window.__dataopsRefreshWork && window.__dataopsRefreshWork());
    await page.waitForTimeout(500);
    await page.locator('[data-workspace-view="tasks"]').click();
    await page.locator('.ops-subnav-tab[data-tasks-section="queue"]').click();
    try {
      await expect(row.first()).toBeVisible({ timeout: 8000 });
      break;
    } catch (err) {
      if (attempt === 5) throw err;
    }
  }
  return row.first();
}

test.describe('Task list card resolves owner name (issue #96)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.setTimeout(60000);
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

  test('list card shows resolved owner name, not UUID; unknown degrades to dash', async ({ browser }) => {
    test.setTimeout(90000);
    const suffix = uid();
    const today = todayString();
    const knownDesc = 'List card owner known ' + suffix;
    const unknownDesc = 'List card owner unknown ' + suffix;

    const knownTask = await api('POST', '/api/tasks', { description: knownDesc, date: today, status: 'todo', assigneeId: GRACE_ID });
    const unknownTask = await api('POST', '/api/tasks', { description: unknownDesc, date: today, status: 'todo', assigneeId: UNKNOWN_ASSIGNEE_ID });
    const knownId = knownTask.json.id;
    const unknownId = unknownTask.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/status of 401|status of 404|Failed to load resource/.test(text)) return;
      errors.push(text);
    });
    try {
      const knownCard = await openQueueWithCard(page, knownDesc);
      const knownMeta = knownCard.locator('.ops-queue-meta');
      await expect(knownMeta).toContainText('Owner Grace');
      await expect(knownMeta).not.toContainText(GRACE_ID);

      const unknownCard = await openQueueWithCard(page, unknownDesc);
      const unknownMeta = unknownCard.locator('.ops-queue-meta');
      await expect(unknownMeta).toContainText('Owner —');
      await expect(unknownMeta).not.toContainText(UNKNOWN_ASSIGNEE_ID);

      // No console errors from name resolution.
      expect(errors).toEqual([]);

      // Capture a screenshot of the queue showing resolved names.
      await page.locator('[data-workspace-view="tasks"]').click();
      await page.locator('.ops-subnav-tab[data-tasks-section="queue"]').click();
      await expect(page.locator('.ops-queue-row', { hasText: knownDesc })).toBeVisible({ timeout: 8000 });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'issue-96-task-list-card-names.png'),
        fullPage: true,
      });
    } finally {
      await context.close();
      await deleteTask(knownId);
      await deleteTask(unknownId);
    }
  });
});
