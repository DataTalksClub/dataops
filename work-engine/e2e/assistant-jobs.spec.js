const { test, expect } = require('@playwright/test');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

test.describe('Assistant job workflow context', () => {
  test('requests podcast assistant help from workflow context', async ({ page, request }) => {
    const suffix = uid();
    const bundleRes = await request.post('/api/bundles', {
      data: {
        title: 'Podcast Request Flow ' + suffix,
        anchorDate: '2026-07-21',
        tags: ['podcast'],
      },
    });
    expect(bundleRes.status()).toBe(201);
    const bundle = (await bundleRes.json()).bundle;

    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Collect guest topic ' + suffix,
        date: '2026-07-21',
        bundleId: bundle.id,
        tags: ['podcast'],
        instructionDocId: 'sop.media.podcast.create-podcast-document',
      },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    try {
      await page.goto('/#/bundles');
      const bundleLink = page.getByRole('link', { name: 'Open bundle Podcast Request Flow ' + suffix });
      await expect(bundleLink).toBeVisible({ timeout: 10000 });
      await bundleLink.click();

      await expect(page.locator('#bundle-detail')).toContainText('Podcast Request Flow ' + suffix);
      await page.getByRole('button', { name: 'Ask DataOps Assistant for workflow' }).click();
      await expect(page.locator('#assistant-request-overlay')).toContainText('Workflow: Podcast Request Flow ' + suffix);
      await page.locator('#assistant-request-urls').fill('https://example.com/guest-' + suffix);
      await page.locator('#assistant-request-notes').fill('Guest topic and anchor date context for ' + suffix);
      await page.getByRole('button', { name: 'Queue DataOps Assistant job' }).click();

      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Podcast Request Flow ' + suffix, { timeout: 10000 });
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('queued');
    } finally {
      await request.delete('/api/tasks/' + task.id);
      await request.put('/api/bundles/' + bundle.id + '/archive');
      await request.delete('/api/bundles/' + bundle.id);
    }
  });

  test('shows assistant queue and approves output from bundle detail', async ({ page, request }) => {
    const suffix = uid();
    const bundleRes = await request.post('/api/bundles', {
      data: { title: 'Assistant Workflow ' + suffix, anchorDate: '2026-07-20', tags: ['podcast'] },
    });
    expect(bundleRes.status()).toBe(201);
    const bundle = (await bundleRes.json()).bundle;

    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Prepare podcast guest context ' + suffix,
        date: '2026-07-20',
        bundleId: bundle.id,
        proofRequirement: { type: 'artifact', label: 'Assistant draft' },
      },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    const jobRes = await request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: 'Podcast prep ' + suffix,
        taskId: task.id,
        bundleId: bundle.id,
        inputRefs: [{ type: 'task', id: task.id }],
        approvalRequired: true,
      },
    });
    expect(jobRes.status()).toBe(201);
    const job = (await jobRes.json()).job;

    const dryRunRes = await request.post('/api/assistant-jobs/' + job.id + '/run-dry');
    expect(dryRunRes.status()).toBe(200);

    try {
      await page.goto('/#/assistants');
      await page.waitForSelector('#assistants-queue');
      await expect(page.locator('#assistants-queue')).toContainText('Podcast prep ' + suffix);
      await expect(page.locator('#assistants-queue')).toContainText('waiting approval');
      await expect(page.locator('#assistants-queue')).toContainText('Needs approval');
      await page.locator('[data-assistant-job-row="' + job.id + '"] [data-assistant-action="detail"]').click();
      await expect(page.locator('[data-testid="assistant-job-detail"]')).toContainText('Output artifacts and proof');
      await expect(page.locator('[data-testid="assistant-job-detail"]')).toContainText('Run log and status history');
      await expect(page.locator('[data-testid="assistant-job-detail"]')).toContainText('Podcast dry-run output artifact attached');

      await page.goto('/#/bundles');
      const bundleLink = page.getByRole('link', { name: 'Open bundle Assistant Workflow ' + suffix });
      await expect(bundleLink).toBeVisible({ timeout: 10000 });
      await bundleLink.click();

      await expect(page.locator('#bundle-detail')).toContainText('Assistant Workflow ' + suffix);
      await expect(page.locator('[data-testid="workflow-context"]')).toContainText('Assistant approvals');
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Podcast prep ' + suffix);
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Review output');
      await expect(page.locator('[data-task-row="' + task.id + '"] .task-status-checkbox')).toBeDisabled();

      await page.locator('[data-assistant-job-row="' + job.id + '"] [data-assistant-action="approve"]').click();
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('approved');
      await expect(page.locator('[data-testid="workflow-artifacts"]')).toContainText('approved');
      await expect(page.locator('[data-task-row="' + task.id + '"] .task-status-checkbox')).toBeEnabled();
    } finally {
      await request.delete('/api/tasks/' + task.id);
      await request.put('/api/bundles/' + bundle.id + '/archive');
      await request.delete('/api/bundles/' + bundle.id);
    }
  });
});
