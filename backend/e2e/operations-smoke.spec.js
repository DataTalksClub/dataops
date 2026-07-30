const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  BERLIN_MIDNIGHT_BOUNDARY_INSTANT,
  BERLIN_TIME_ZONE,
  berlinBusinessDate,
  installBerlinBoundaryClock,
} = require('./helpers/business-date');
const BERLIN_TODAY = berlinBusinessDate(BERLIN_MIDNIGHT_BOUNDARY_INSTANT);

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

async function screenshot(page, name) {
  await page.screenshot({ path: `../.tmp/screenshots/${name}.png`, fullPage: true });
}

function auditDefaultSpaBusinessDates() {
  // Intentional UTC API specs are outside this default-SPA inventory and keep
  // their server-timestamp contracts unchanged.
  const defaultSpaSpecs = [
    'accessibility.spec.js',
    'follow-up-actions.spec.js',
    'intake-inbox.spec.js',
    'operations-smoke.spec.js',
    'task-list.spec.js',
    'template-editor.spec.js',
  ];

  for (const file of defaultSpaSpecs) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    expect(source, file + ' should import the shared business-date helper').toContain("require('./helpers/business-date')");
    expect(source, file + ' should set the browser to the business timezone').toContain('test.use({ timezoneId: BERLIN_TIME_ZONE })');
    expect(source, file + ' should install the fixed boundary before navigation').toContain('installBerlinBoundaryClock(page)');
    expect(source, file + ' should not declare an ad hoc today helper').not.toMatch(/function\s+(?:todayString|offsetDateString)\s*\(/);
    expect(source, file + ' should not derive UI today from the live runner clock').not.toMatch(/new Date\s*\(\s*\)/);
  }
}

test.describe('operator operations smoke assistant workflow', () => {
  test.use({ timezoneId: BERLIN_TIME_ZONE });
  test.beforeEach(async ({ page }) => {
    await installBerlinBoundaryClock(page);
  });

  test('logs in and keeps dashboard, workflow, proof, assistant, and artifact context connected', async ({ browser, page, request }) => {
    test.setTimeout(90000);
    auditDefaultSpaBusinessDates();

    const suffix = uid();
    const today = BERLIN_TODAY;
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
      timezoneId: BERLIN_TIME_ZONE,
    });
    const loginPage = await loginContext.newPage();
    await installBerlinBoundaryClock(loginPage);

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
