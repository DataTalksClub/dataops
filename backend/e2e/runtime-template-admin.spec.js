const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SCREENSHOTS = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots', 'issue-157');
const OPERATOR_PORT = 3027;
const OPERATOR_BASE = `http://localhost:${OPERATOR_PORT}`;
const OPERATOR_ID = '00000000-0000-0000-0000-000000000157';
let operatorServer;

function shot(name) {
  return path.join(SCREENSHOTS, name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    (function poll() {
      const request = http.get(`${OPERATOR_BASE}/api/health`, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => Date.now() > deadline
        ? reject(new Error('runtime-template operator server timeout'))
        : setTimeout(poll, 200));
    })();
  });
}

async function screenshot(page, name, focus) {
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot(name), animations: 'disabled' });
}

test.describe('runtime-template structured administration', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS, { recursive: true });
    operatorServer = spawn('npx', ['tsx', 'scripts/test-server.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'false',
        DATAOPS_DOCS_DOMAIN: '1',
        WORK_ENGINE_AUTH_MODE: 'portal',
        DTC_OFFLINE: '1',
        FRONTEND_ROOT: path.resolve(__dirname, '..', '..', 'frontend'),
        AUTH_BASE_URL: 'https://auth.example.test',
        AUTH_ISSUER: 'https://issuer.example.test/pool',
        AUTH_CLIENT_ID: 'dataops-client',
        AUTH_CALLBACK_URL: `${OPERATOR_BASE}/auth/callback`,
        AUTH_LOGOUT_URL: `${OPERATOR_BASE}/`,
        E2E_BROWSER_SESSION_USER_ID: OPERATOR_ID,
        E2E_BROWSER_SESSION_USER_ROLE: 'operator',
        PORT: String(OPERATOR_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitForServer();
  });

  test.afterAll(() => {
    if (operatorServer) {
      try { process.kill(-operatorServer.pid, 'SIGTERM'); } catch {}
    }
  });

  test('shows an admin the structured editor and preserves draft across save, conflict, error, and delete refusal', async ({ page, request }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/templates');
    await expect(page.getByRole('button', { name: 'New runtime template' })).toBeVisible();
    await page.getByRole('button', { name: 'New runtime template' }).click();
    await expect(page.getByText('Advanced JSON', { exact: true })).toBeVisible();
    await expect(page.locator('.runtime-template-json')).toHaveAttribute('readonly', '');
    await expect(page.locator('[data-template-save-state]')).toHaveText('Not yet saved');
    await screenshot(page, 'desktop-admin-clean-1440x900.png', page.locator('.runtime-template-editor').first());

    await page.getByLabel('Name').fill('');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('Name is required.')).toBeVisible();
    await screenshot(page, 'desktop-admin-validation-1440x900.png', page.getByText('Name is required.'));

    const name = 'Issue 157 structured evidence';
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Tags').fill('synthetic, fidelity');
    await page.getByLabel('Source document IDs').fill('synthetic.process');
    await page.getByLabel('Description').fill('Persisted first task');
    await page.getByLabel('Instruction document ID').fill('synthetic.sop');
    await page.getByLabel('Proof type').selectOption('comment');
    await page.getByLabel('Proof label').fill('Completion note');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByLabel('Description').nth(1).fill('Persisted reordered task');
    await page.getByLabel('Reference ID', { exact: true }).nth(1).fill('reordered-task');
    await page.getByLabel('Day offset').nth(1).fill('3');
    await page.getByRole('button', { name: 'Move up task 2' }).click();
    await expect(page.getByRole('button', { name: 'Move down task 1' })).toBeFocused();
    await page.getByRole('button', { name: 'Move down task 1' }).click();
    await expect(page.getByRole('button', { name: 'Move up task 2' })).toBeFocused();
    await page.getByRole('button', { name: 'Move up task 2' }).click();
    await expect(page.getByRole('button', { name: 'Move down task 1' })).toBeFocused();
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByRole('button', { name: 'Remove task 3' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Unsaved changes');
    await screenshot(page, 'desktop-admin-dirty-1440x900.png', page.locator('[data-template-save-state]'));
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(page.locator('#confirm-message')).toContainText('unsaved changes');
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Name')).toHaveValue(name);
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('[data-tasks-section="templates"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#library-title')).toHaveText('Tasks - Templates');
    await expect(page.getByRole('button', { name: 'Queue' })).toBeFocused();

    await page.evaluate(() => { window.location.hash = '#/tasks'; });
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('[data-tasks-section="templates"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Name')).toHaveValue(name);

    let delayedCreate = true;
    await page.route('**/work/api/templates', async (route) => {
      if (delayedCreate && route.request().method() === 'POST') {
        delayedCreate = false;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      await route.continue();
    });
    const createResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/templates'));
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saving…');
    await screenshot(page, 'desktop-admin-saving-1440x900.png', page.locator('[data-template-save-state]'));
    const created = (await (await createResponse).json()).template;
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saved');
    await screenshot(page, 'desktop-admin-saved-1440x900.png', page.locator('[data-template-save-state]'));
    await page.unroute('**/work/api/templates');
    await page.reload();
    await page.locator('.runtime-template-row', { hasText: name }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('No unsaved changes');
    await expect(page.getByLabel('Reference ID', { exact: true }).nth(0)).toHaveValue('reordered-task');
    await expect(page.getByLabel('Reference ID', { exact: true }).nth(1)).toHaveValue('first-task');

    await page.getByLabel('Name').fill(`${name} local draft`);
    const winner = await request.put(`/api/templates/${created.id}`, { data: { expectedVersion: 1, name: `${name} server winner` } });
    expect(winner.status()).toBe(200);
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toContainText('Conflict');
    await expect(page.getByLabel('Name')).toHaveValue(`${name} local draft`);
    await screenshot(page, 'desktop-admin-conflict-1440x900.png', page.locator('.runtime-template-feedback'));

    await page.getByRole('button', { name: 'Reload server version' }).click();
    await page.locator('#confirm-ok').click();
    await expect(page.getByLabel('Name')).toHaveValue(`${name} server winner`);
    await page.getByLabel('Name').fill(`${name} network draft`);
    await page.route(`**/work/api/templates/${created.id}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic network failure' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Save failed');
    await expect(page.getByLabel('Name')).toHaveValue(`${name} network draft`);
    await screenshot(page, 'desktop-admin-error-1440x900.png', page.locator('.runtime-template-feedback'));

    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saved');

    await page.getByLabel('Name').fill(`${name} permission draft`);
    await page.route(`**/work/api/templates/${created.id}`, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin access required' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Permission error');
    await expect(page.getByLabel('Name')).toHaveValue(`${name} permission draft`);
    await screenshot(page, 'desktop-admin-permission-1440x900.png', page.locator('.runtime-template-feedback'));
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saved');

    const current = await (await request.get(`/api/templates/${created.id}`)).json();
    const bundle = await request.post('/api/bundles', { data: { title: 'Synthetic template reference', anchorDate: '2026-10-01', templateId: created.id } });
    expect(bundle.status()).toBe(201);
    const instantiated = await bundle.json();
    expect(instantiated.tasks.map((task) => task.templateTaskRef)).toEqual(['reordered-task', 'first-task']);
    expect(instantiated.tasks.map((task) => task.templateOffsetDays)).toEqual([3, 0]);
    expect(instantiated.tasks.map((task) => task.description)).toEqual(['Persisted reordered task', 'Persisted first task']);
    expect(instantiated.tasks[1].proofRequirement).toEqual({ type: 'comment', label: 'Completion note', required: true });
    await page.getByRole('button', { name: 'Delete template' }).click();
    await expect(page.locator('#confirm-message')).toContainText(name);
    await expect(page.locator('#confirm-message')).toContainText('Referenced templates cannot be deleted');
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#confirm-modal')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete template' })).toBeFocused();
    await page.getByRole('button', { name: 'Delete template' }).click();
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirm-modal')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete template' })).toBeFocused();
    await page.getByRole('button', { name: 'Delete template' }).click();
    await page.keyboard.press('Tab');
    await expect(page.locator('#confirm-ok')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-template-save-state]')).toHaveText('Delete blocked');
    await screenshot(page, 'desktop-admin-delete-blocked-1440x900.png', page.locator('.runtime-template-feedback'));
    expect(current.template.version).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.runtime-template-list')).toBeHidden();
    await expect(page.locator('.runtime-template-support')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back to template list' })).toBeVisible();
    await expect(page.locator('.runtime-template-actions')).toHaveCSS('position', 'sticky');
    await screenshot(page, 'mobile-admin-delete-blocked-390x844.png', page.locator('.runtime-template-feedback'));
    await page.getByRole('button', { name: 'Reload server version' }).count();
    await page.getByLabel('Name').fill(`${name} mobile dirty`);
    await screenshot(page, 'mobile-admin-dirty-390x844.png', page.locator('[data-template-save-state]'));

    let delayMobileSave = true;
    await page.route(`**/work/api/templates/${created.id}`, async (route) => {
      if (delayMobileSave && route.request().method() === 'PUT') {
        delayMobileSave = false;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      await route.continue();
    });
    await page.locator('.runtime-template-advanced').scrollIntoViewIfNeeded();
    const stickyGeometry = await page.evaluate(() => {
      const topbar = document.querySelector('.mobile-topbar');
      const actions = document.querySelector('.runtime-template-actions');
      const save = [...document.querySelectorAll('.runtime-template-actions button')]
        .find((button) => button.textContent.trim() === 'Save template');
      if (!topbar || !actions || !save) return null;
      const topbarRect = topbar.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const saveRect = save.getBoundingClientRect();
      const center = { x: saveRect.left + saveRect.width / 2, y: saveRect.top + saveRect.height / 2 };
      const hitButton = document.elementFromPoint(center.x, center.y)?.closest('button');
      return {
        topbarBottom: topbarRect.bottom,
        actionsTop: actionsRect.top,
        actionsBottom: actionsRect.bottom,
        viewportHeight: window.innerHeight,
        saveCenter: center,
        hitButtonText: hitButton?.textContent.trim() || '',
      };
    });
    expect(stickyGeometry).not.toBeNull();
    expect(stickyGeometry.actionsTop).toBeGreaterThanOrEqual(stickyGeometry.topbarBottom + 7);
    expect(stickyGeometry.actionsTop).toBeLessThan(stickyGeometry.topbarBottom + 12);
    expect(stickyGeometry.actionsBottom).toBeLessThan(stickyGeometry.viewportHeight);
    expect(stickyGeometry.hitButtonText).toBe('Save template');
    await screenshot(page, 'mobile-admin-sticky-scrolled-390x844.png');
    await page.mouse.click(stickyGeometry.saveCenter.x, stickyGeometry.saveCenter.y);
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saving…');
    await screenshot(page, 'mobile-admin-saving-390x844.png', page.locator('[data-template-save-state]'));
    await expect(page.locator('[data-template-save-state]')).toHaveText('Saved');
    await screenshot(page, 'mobile-admin-saved-390x844.png', page.locator('[data-template-save-state]'));
    await page.unroute(`**/work/api/templates/${created.id}`);

    const latest = (await (await request.get(`/api/templates/${created.id}`)).json()).template;
    await page.getByLabel('Name').fill(`${name} mobile conflict draft`);
    expect((await request.put(`/api/templates/${created.id}`, { data: { expectedVersion: latest.version, name: `${name} mobile server winner` } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toContainText('Conflict');
    await screenshot(page, 'mobile-admin-conflict-390x844.png', page.locator('.runtime-template-feedback'));
    await page.getByRole('button', { name: 'Reload server version' }).click();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('No unsaved changes');
    await screenshot(page, 'mobile-admin-clean-390x844.png', page.locator('[data-template-save-state]'));

    const mobileCleanName = await page.getByLabel('Name').inputValue();
    await page.getByLabel('Name').fill('');
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.getByText('Name is required.')).toBeVisible();
    await screenshot(page, 'mobile-admin-validation-390x844.png', page.getByText('Name is required.'));
    await page.getByLabel('Name').fill(mobileCleanName);

    await page.getByLabel('Name').fill(`${name} mobile error draft`);
    await page.route(`**/work/api/templates/${created.id}`, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Permission error');
    await expect(page.getByLabel('Name')).toHaveValue(`${name} mobile error draft`);
    await screenshot(page, 'mobile-admin-permission-390x844.png', page.locator('.runtime-template-feedback'));

    await page.route(`**/work/api/templates/${created.id}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic mobile network failure' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save template' }).click();
    await expect(page.locator('[data-template-save-state]')).toHaveText('Save failed');
    await screenshot(page, 'mobile-admin-error-390x844.png', page.locator('.runtime-template-feedback'));
  });

  test('keeps operator controls absent and denies a spoofed direct mutation in production auth mode', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: OPERATOR_BASE, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('/__e2e__/browser-session');
    await page.goto('/#/templates');
    await expect(page.getByRole('button', { name: 'New runtime template' })).toHaveCount(0);
    await expect(page.getByText('Template administration is restricted to admins.')).toBeVisible();
    const firstTemplate = page.locator('.runtime-template-row').first();
    await expect(firstTemplate).toBeVisible();
    await firstTemplate.click();
    await expect(page.getByText('Read-only definition. Admin permission is required to change it.')).toBeVisible();
    await expect(page.locator('.runtime-template-definition')).toContainText('Type');
    await expect(page.locator('.runtime-template-readonly-tasks li').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start workflow' })).toBeVisible();
    await screenshot(page, 'desktop-operator-readonly-1440x900.png', page.locator('.runtime-template-readonly'));
    await page.getByRole('button', { name: 'Start workflow' }).click();
    await expect(page.getByRole('dialog').locator('.diff-header strong')).toHaveText('Start workflow');
    await expect(page.locator('.quick-form-select')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Close' }).click();

    const denied = await context.request.post('/work/api/templates', {
      headers: { 'x-user-id': '00000000-0000-0000-0000-000000000001', 'x-user-role': 'admin' },
      data: { name: 'Spoof denied', type: 'workflow', taskDefinitions: [{ refId: 'one', description: 'Denied', offsetDays: 0 }] },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Admin access required' });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.runtime-template-list')).toBeHidden();
    await expect(page.locator('.runtime-template-support')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back to template list' })).toBeVisible();
    await screenshot(page, 'mobile-operator-readonly-390x844.png', page.getByRole('button', { name: 'Back to template list' }));
    await page.getByRole('button', { name: 'Back to template list' }).click();
    await expect(page.locator('.runtime-template-list')).toBeVisible();
    await expect(page.locator('.runtime-template-editor')).toBeHidden();
    await expect(page.locator('.runtime-template-support')).toBeVisible();
    await page.locator('.runtime-template-row').first().click();
    await expect(page.locator('.runtime-template-list')).toBeHidden();
    await expect(page.locator('.runtime-template-readonly')).toBeVisible();
    await context.close();
  });
});
