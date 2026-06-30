const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// Issue #90: the task detail panel (frontend/src/app.js) must show the workflow
// title and assignee name instead of raw UUIDs, with graceful fallback to "—".
//
// The frontend portal (frontend/src/app.js) is only served when the single-origin
// docs domain is enabled (DATAOPS_DOCS_DOMAIN=1) with FRONTEND_ROOT pointing at
// the repo's frontend/. The default work-engine test server serves a different,
// older SPA (work-engine/src/public/app.js), so this spec boots its own isolated
// server on port 3010 with the portal flags to exercise the real frontend code.

const PORT = 3010;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Auth is bypassed server-side (SKIP_AUTH=true), but the frontend portal still
// reads a localStorage session to know the current operator. Inject a Grace
// session so /api/me and operator-scoped calls behave like the main e2e harness.
const AUTH_STORAGE_STATE = {
  cookies: [],
  origins: [
    {
      origin: BASE_URL,
      localStorage: [
        { name: 'dataops_token', value: 'issue90-bypass-token' },
        { name: 'dataops_user', value: JSON.stringify({
          id: '00000000-0000-0000-0000-000000000001', name: 'Grace', email: 'grace@datatalks.club', createdAt: '2026-01-01T00:00:00.000Z',
        }) },
      ],
    },
  ],
};
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', 'frontend');
const WORK_ENGINE_ROOT = path.resolve(__dirname, '..');

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
  // Keep the run-id longer than 8 chars so stripTitleSuffix (#91), which trims
  // leaked Trello shortLink tokens of 4-8 chars, does not strip the test's own
  // uniqueness suffix off the displayed task title.
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

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
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

async function openTaskPanelFor(page, textFragment) {
  // Operations Home renders today's tasks as clickable .ops-lane-item rows.
  await page.goto(`${BASE_URL}/#/`);
  // The home view renders once with an unloaded work snapshot and re-renders
  // after the async /work/api fetch hydrates. Wait for the hydrated render via
  // the data-operations-work-loaded signal before querying lane rows, so the
  // 15s visibility check never races a still-empty Today lane.
  await expect(
    page.locator('[data-operations-work-loaded="true"]'),
  ).toBeVisible({ timeout: 20000 });
  // Match the lane item whose title (<strong>) is exactly the task description,
  // so a same-suffix workflow bundle in another lane is not also matched.
  const row = page.locator('.ops-lane-item', { has: page.locator('strong', { hasText: textFragment }) });
  await expect(row.first()).toBeVisible({ timeout: 15000 });
  await row.first().click();
  await expect(page.locator('#task-panel')).toBeVisible({ timeout: 10000 });
  return page.locator('#task-panel-body');
}

test.describe('Task detail resolves names (issue #90)', () => {
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

  test('known workflow and assignee resolve to title/name', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const bundleTitle = 'Workflow Names E2E ' + suffix;
    const desc = 'Task detail names known ' + suffix;

    const b = await api('POST', '/api/bundles', { title: bundleTitle, anchorDate: today, status: 'active' });
    const bundleId = b.json.bundle.id;
    const t = await api('POST', '/api/tasks', { description: desc, date: today, assigneeId: GRACE_ID, bundleId });
    const taskId = t.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    try {
      const body = await openTaskPanelFor(page, desc);

      // Workflow row shows the bundle title, never the raw UUID.
      await expect(body).toContainText('Workflow ' + bundleTitle);
      await expect(body).not.toContainText(bundleId);

      // Assignee row shows "Grace", never the raw user UUID.
      await expect(body).toContainText('Assignee Grace');
      await expect(body).not.toContainText(GRACE_ID);

      // Workflow name stays clickable and opens the bundle panel.
      await body.locator('button', { hasText: bundleTitle }).click();
      await expect(page.locator('#bundle-panel')).toBeVisible({ timeout: 10000 });
    } finally {
      await context.close();
      await deleteTask(taskId);
      await archiveAndDeleteBundle(bundleId);
    }
  });

  test('unknown assignee and unknown bundle fall back to "—"', async ({ browser }) => {
    const suffix = uid();
    const today = todayString();
    const desc = 'Task detail names unknown ' + suffix;
    const unknownBundleId = '00000000-0000-0000-0000-bundle-unknown';

    const t = await api('POST', '/api/tasks', { description: desc, date: today, assigneeId: UNKNOWN_ASSIGNEE_ID, bundleId: unknownBundleId });
    const taskId = t.json.id;

    const context = await browser.newContext({ baseURL: BASE_URL, storageState: AUTH_STORAGE_STATE });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Ignore pre-existing auth/resource network noise unrelated to the
    // name-resolution logic this issue owns.
    if (/status of 401|status of 404|Failed to load resource/.test(text)) return;
    errors.push(text);
  });
    try {
      const body = await openTaskPanelFor(page, desc);

      // Unknown assignee degrades to "—", never the raw id.
      await expect(body).toContainText('Assignee —');
      await expect(body).not.toContainText(UNKNOWN_ASSIGNEE_ID);

      // Unknown bundle degrades to "—", never the raw id.
      await expect(body).toContainText('Workflow —');
      await expect(body).not.toContainText(unknownBundleId);

      // No console errors thrown while rendering.
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await deleteTask(taskId);
    }
  });
});
