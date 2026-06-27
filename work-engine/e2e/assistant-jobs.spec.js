const { test, expect } = require('@playwright/test');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

test.describe('Assistant job workflow context', () => {
  test('shows assistant queue and approves output from bundle detail', async ({ page, request }) => {
    const suffix = uid();
    const bundleRes = await request.post('/api/bundles', {
      data: { title: 'Assistant Workflow ' + suffix, anchorDate: '2026-07-20' },
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

      await page.goto('/#/bundles');
      const bundleLink = page.getByRole('link', { name: 'Open bundle Assistant Workflow ' + suffix });
      await expect(bundleLink).toBeVisible({ timeout: 10000 });
      await bundleLink.click();

      await expect(page.locator('#bundle-detail')).toContainText('Assistant Workflow ' + suffix);
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Podcast prep ' + suffix);
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('Review output');

      await page.locator('[data-assistant-job-row="' + job.id + '"] [data-assistant-action="approve"]').click();
      await expect(page.locator('#bundle-assistant-jobs')).toContainText('approved');
    } finally {
      await request.delete('/api/tasks/' + task.id);
      await request.put('/api/bundles/' + bundle.id + '/archive');
      await request.delete('/api/bundles/' + bundle.id);
    }
  });
});
