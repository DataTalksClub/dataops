const { test, expect } = require('@playwright/test');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function screenshot(page, name) {
  await page.screenshot({ path: `../.tmp/screenshots/${name}.png`, fullPage: true });
}

test.describe('operator operations smoke assistant workflow', () => {
  test('logs in and keeps dashboard, workflow, proof, assistant, and artifact context connected', async ({ browser, page, request }) => {
    test.setTimeout(90000);

    const suffix = uid();
    const today = todayString();
    const title = 'Operations smoke workflow ' + suffix;
    let bundle;
    let task;
    let job;
    let outputArtifact;

    const bundleRes = await request.post('/api/bundles', {
      data: {
        title,
        anchorDate: today,
        stage: 'preparation',
        bundleLinks: [{ name: 'Luma', url: '' }],
        references: [{ name: 'Newsletter process', url: 'https://github.com/DataTalksClub/dataops/blob/main/content/tasks/templates/newsletter.md' }],
      },
    });
    expect(bundleRes.status()).toBe(201);
    bundle = (await bundleRes.json()).bundle;

    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Approve assistant output proof ' + suffix,
        date: today,
        assigneeId: '00000000-0000-0000-0000-000000000001',
        bundleId: bundle.id,
        proofRequirement: { type: 'artifact', label: 'Approved assistant output' },
      },
    });
    expect(taskRes.status()).toBe(201);
    task = await taskRes.json();

    const jobRes = await request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: 'Operator smoke assistant ' + suffix,
        taskId: task.id,
        bundleId: bundle.id,
        inputRefs: [{ type: 'task', id: task.id }, { type: 'bundle', id: bundle.id }],
        approvalRequired: true,
      },
    });
    expect(jobRes.status()).toBe(201);
    job = (await jobRes.json()).job;

    const dryRunRes = await request.post('/api/assistant-jobs/' + job.id + '/run-dry');
    expect(dryRunRes.status()).toBe(200);
    outputArtifact = (await dryRunRes.json()).artifact;

    const loginContext = await browser.newContext({
      baseURL: 'http://localhost:3001',
      storageState: { cookies: [], origins: [] },
    });
    const loginPage = await loginContext.newPage();

    try {
      await loginPage.goto('/#/');
      await expect(loginPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await loginPage.fill('#signin-email', 'grace@datatalks.club');
      await loginPage.fill('#signin-password', '111');
      await loginPage.click('#signin-submit');
      await expect(loginPage.getByRole('heading', { name: 'Sign in' })).not.toBeVisible({ timeout: 15000 });
      await expect(loginPage.locator('#dashboard-tasks')).toBeVisible({ timeout: 15000 });
      await expect(loginPage.locator('#assigned-to-me')).toBeVisible();
      await screenshot(loginPage, `work-engine-operations-home-login-${suffix}`);
    } finally {
      await loginContext.close();
    }

    try {
      await page.goto('/#/');
      await expect(page.locator('#dashboard-tasks')).toContainText('Approve assistant output proof ' + suffix, { timeout: 15000 });
      await expect(page.locator('#dashboard-bundles')).toContainText(title, { timeout: 15000 });
      await screenshot(page, `work-engine-operations-home-desktop-${suffix}`);

      await page.goto('/#/assistants');
      await expect(page.locator('#assistants-queue')).toContainText('Operator smoke assistant ' + suffix, { timeout: 15000 });
      await expect(page.locator('#assistants-queue')).toContainText('waiting approval');

      await page.goto('/#/bundles');
      const bundleLink = page.getByRole('link', { name: 'Open bundle ' + title });
      await expect(bundleLink).toBeVisible({ timeout: 15000 });
      await bundleLink.click();
      await expect(page.locator('.bundle-detail-header h2')).toContainText(title, { timeout: 15000 });
      await expect(page.locator('[data-testid="workflow-context"]')).toBeVisible();
      const proofCheckbox = page.locator('[data-task-row="' + task.id + '"] .task-status-checkbox');
      await expect(proofCheckbox).toBeDisabled();
      await expect(proofCheckbox).toHaveAttribute('title', 'Approve an attached artifact first');
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Operator smoke assistant ' + suffix);
      await expect(page.locator('[data-testid="workflow-artifacts"]')).toContainText('needs-review');
      await screenshot(page, `work-engine-workflow-panel-proof-blocked-${suffix}`);

      await page.locator('[data-assistant-job-row="' + job.id + '"] [data-assistant-action="approve"]').click();
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('approved', { timeout: 15000 });
      await expect(page.locator('[data-testid="workflow-artifacts"]')).toContainText('approved', { timeout: 15000 });
      await expect(page.locator('[data-task-row="' + task.id + '"] .task-status-checkbox')).toBeEnabled({ timeout: 15000 });
      await screenshot(page, `work-engine-workflow-panel-artifact-approved-${suffix}`);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/#/');
      const toggle = page.locator('#nav-menu-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const hasOverflow = await page.evaluate(function () {
        return document.body.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
      await screenshot(page, `work-engine-operations-home-mobile-${suffix}`);
    } finally {
      if (outputArtifact) {
        await request.put('/api/artifacts/' + outputArtifact.id + '/archive');
      }
      if (task) {
        await request.delete('/api/tasks/' + task.id);
      }
      if (bundle) {
        await request.put('/api/bundles/' + bundle.id + '/archive');
        await request.delete('/api/bundles/' + bundle.id);
      }
    }
  });
});
