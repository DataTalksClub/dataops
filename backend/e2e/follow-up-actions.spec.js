const { test, expect } = require('./fixtures');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function offsetDateString(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function screenshot(page, name) {
  await page.screenshot({ path: `../.tmp/screenshots/${name}.png`, fullPage: true });
}

// Workflow-detail rows collapse to a scannable line at rest (#102). Expand the
// row to reach the follow-up/waiting controls in the disclosure region.
async function expandRow(row) {
  const toggle = row.locator('[data-task-expand]').first();
  if (await toggle.count()) {
    if ((await toggle.getAttribute('aria-expanded')) === 'false') {
      await toggle.click();
    }
    await expect(row.locator('.task-checklist-details')).toBeVisible();
  }
}

async function cleanupTask(request, task) {
  if (!task) return;
  await request.delete('/api/tasks/' + task.id).catch(() => {});
}

async function cleanupBundle(request, bundle) {
  if (!bundle) return;
  await request.put('/api/bundles/' + bundle.id + '/archive').catch(() => {});
  await request.delete('/api/bundles/' + bundle.id).catch(() => {});
}

test.describe('Operator follow-up actions (#56)', () => {
  test('records follow-up sent, shows workflow history, and unblocks the task', async ({ page, request }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    let bundle;
    let task;

    try {
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'Follow-up workflow ' + suffix,
          anchorDate: todayString(),
          status: 'active',
        },
      });
      expect(bundleRes.status()).toBe(201);
      bundle = (await bundleRes.json()).bundle;

      const taskRes = await request.post('/api/tasks', {
        data: {
          description: 'Collect sponsor approval ' + suffix,
          date: offsetDateString(-2),
          assigneeId: GRACE_ID,
          bundleId: bundle.id,
          status: 'waiting',
          waitingFor: 'Sponsor reply',
          followUpAt: todayString(),
          followUpChannel: 'email',
          comment: 'Waiting for sponsor approval',
          validation: { dashboardStates: ['waiting', 'follow-up-due'] },
        },
      });
      expect(taskRes.status()).toBe(201);
      task = await taskRes.json();

      await page.goto('/#/');
      await page.waitForSelector('#dashboard-tasks table', { timeout: 15000 });
      const dashboardRow = page.locator('[data-task-row="' + task.id + '"]');
      const dashboardActionRow = page.locator('[data-task-actions-row="' + task.id + '"]');
      await expect(dashboardRow).toContainText('Follow-up due');
      await expect(dashboardActionRow.locator('[data-follow-up-action="follow-up-sent"]')).toBeVisible();
      await screenshot(page, 'issue-56-operations-home-follow-up-due');

      await dashboardActionRow.locator('[data-follow-up-action="follow-up-sent"]').click();
      await expect(page.locator('.error-banner')).toContainText('Add a short note');
      await screenshot(page, 'issue-56-validation-error');

      await dashboardActionRow.locator('.follow-up-channel').selectOption('email');
      await dashboardActionRow.locator('.follow-up-note').fill('Sent sponsor reminder from Gmail');
      await dashboardActionRow.locator('.follow-up-next-date').fill(offsetDateString(2));
      await Promise.all([
        page.waitForResponse((response) => (
          response.url().includes('/api/tasks/' + task.id + '/actions/follow-up-sent')
          && response.request().method() === 'POST'
          && response.status() === 200
        )),
        dashboardActionRow.locator('[data-follow-up-action="follow-up-sent"]').click(),
      ]);

      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card', { timeout: 15000 });
      await page.locator('.bundle-card', { hasText: bundle.title }).locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 15000 });
      const workflowRow = page.locator('[data-task-row="' + task.id + '"]');
      await expect(workflowRow).toContainText('Follow-up history');
      await expect(workflowRow).toContainText('Follow-up sent');
      await expect(workflowRow).toContainText('Sent sponsor reminder from Gmail');
      await screenshot(page, 'issue-56-workflow-waiting-history');

      await expandRow(workflowRow);
      await workflowRow.locator('.follow-up-note').fill('Sponsor replied with approval');
      await Promise.all([
        page.waitForResponse((response) => (
          response.url().includes('/api/tasks/' + task.id + '/actions/response-received')
          && response.request().method() === 'POST'
          && response.status() === 200
        )),
        workflowRow.locator('[data-follow-up-action="response-received"]').click(),
      ]);
      await expect(workflowRow).toContainText('Response received');
      await expandRow(workflowRow);
      await expect(workflowRow.locator('.waiting-form')).toBeVisible();
      await screenshot(page, 'issue-56-resolved-unblocked-state');

      const refreshed = await (await request.get('/api/tasks/' + task.id)).json();
      expect(refreshed.status).toBe('todo');
      expect(refreshed.waitingFor).toBeNull();
      expect(refreshed.followUpAt).toBeNull();
      expect(refreshed.taskHistory.map((event) => event.action)).toEqual(['follow-up-sent', 'response-received']);
    } finally {
      await cleanupTask(request, task);
      await cleanupBundle(request, bundle);
    }
  });
});
