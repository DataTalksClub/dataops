const { test, expect } = require('@playwright/test');

async function deleteConfigsByDescription(request, description) {
  const res = await request.get('/api/recurring');
  const body = await res.json();
  for (const config of body.recurringConfigs || []) {
    if (config.description === description) {
      const deleteRes = await request.delete('/api/recurring/' + config.id);
      if (deleteRes.status() === 409 && config.enabled) {
        await request.put('/api/recurring/' + config.id, {
          data: { enabled: false },
        });
      }
    }
  }
}

async function disableAllConfigs(request) {
  const res = await request.get('/api/recurring');
  const body = await res.json();
  for (const config of body.recurringConfigs || []) {
    if (config.enabled) {
      await request.put('/api/recurring/' + config.id, {
        data: { enabled: false },
      });
    }
  }
}

test.describe('Recurring UI polish', () => {
  test('creates a recurring config with cronExpression and enabled state from the form', async ({ page, request }) => {
    const description = 'UI recurring daily ' + Date.now();
    await deleteConfigsByDescription(request, description);

    await page.goto('/#/recurring');
    await page.locator('#rec-desc').fill(description);
    await page.locator('#rec-schedule').selectOption('daily');
    await page.locator('#rec-enabled').uncheck();
    await page.locator('#rec-create-btn').click();

    await expect(page.locator('.success-banner')).toContainText('Recurring config created.');
    await expect(page.locator('#rec-create-btn')).toHaveText('Create');
    await expect(page.locator('#rec-create-btn')).toBeEnabled();
    await expect(page.locator('#recurring-table')).toContainText(description);
    await expect(page.locator('#recurring-table')).toContainText('Daily');

    const res = await request.get('/api/recurring');
    const body = await res.json();
    const created = (body.recurringConfigs || []).find((config) => config.description === description);
    expect(created).toBeTruthy();
    expect(created.cronExpression).toBe('0 9 * * *');
    expect(created.enabled).toBe(false);
    expect(created.schedule).toBeUndefined();

    await request.delete('/api/recurring/' + created.id);
  });

  test('filters recurring configs by search text', async ({ page, request }) => {
    const keep = 'UI recurring keep ' + Date.now();
    const hide = 'UI recurring hide ' + Date.now();

    const keepRes = await request.post('/api/recurring', {
      data: { description: keep, cronExpression: '0 9 * * *', enabled: false },
    });
    const hideRes = await request.post('/api/recurring', {
      data: { description: hide, cronExpression: '0 9 * * *', enabled: false },
    });
    const keepConfig = (await keepRes.json()).recurringConfig;
    const hideConfig = (await hideRes.json()).recurringConfig;

    await page.goto('/#/recurring');
    await expect(page.locator('#recurring-table')).toContainText(keep);
    await expect(page.locator('#recurring-table')).toContainText(hide);

    await page.locator('#recurring-search').fill(keep);
    await expect(page.locator('#recurring-table')).toContainText(keep);
    await expect(page.locator('#recurring-table')).not.toContainText(hide);

    await request.delete('/api/recurring/' + keepConfig.id);
    await request.delete('/api/recurring/' + hideConfig.id);
  });

  test('pauses and resumes a recurring config from the admin table', async ({ page, request }) => {
    const description = 'UI recurring pause resume ' + Date.now();
    const createRes = await request.post('/api/recurring', {
      data: { description, cronExpression: '0 9 * * *', enabled: true },
    });
    const config = (await createRes.json()).recurringConfig;

    await page.goto('/#/recurring');
    const row = page.locator('#recurring-table tr', { hasText: description });
    await expect(row).toContainText('Yes');

    await row.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.success-banner')).toContainText('Recurring config paused.');
    await expect(page.locator('#recurring-table tr', { hasText: description })).toContainText('No');

    await page.locator('#recurring-table tr', { hasText: description }).getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.success-banner')).toContainText('Recurring config resumed.');
    await expect(page.locator('#recurring-table tr', { hasText: description })).toContainText('Yes');

    await request.delete('/api/recurring/' + config.id);
  });

  test('shows pause guidance when deleting a config with generated history', async ({ page, request }) => {
    await disableAllConfigs(request);
    const description = 'UI recurring delete blocked ' + Date.now();
    const createRes = await request.post('/api/recurring', {
      data: { description, cronExpression: '0 9 * * *', enabled: true },
    });
    const config = (await createRes.json()).recurringConfig;

    await request.post('/api/recurring/generate', {
      data: {
        startDate: '2031-04-10',
        endDate: '2031-04-10',
      },
    });

    await page.goto('/#/recurring');
    const row = page.locator('#recurring-table tr', { hasText: description });
    await expect(row).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Delete' }).click();

    await expect(page.locator('.error-banner')).toContainText('Pause or disable');
    await expect(page.locator('#recurring-table tr', { hasText: description })).toBeVisible();

    await request.put('/api/recurring/' + config.id, {
      data: { enabled: false },
    });
  });

  test('does not overflow horizontally on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/recurring');
    await page.waitForSelector('#recurring-table');
    await expect(page.locator('.inline-checkbox')).toContainText('Enabled');

    const hasOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    ));
    expect(hasOverflow).toBe(false);

    const checkboxOffset = await page.locator('.inline-checkbox').evaluate((label) => {
      const input = label.querySelector('input[type="checkbox"]');
      const labelBox = label.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      return Math.round(inputBox.left - labelBox.left);
    });
    expect(checkboxOffset).toBeLessThanOrEqual(16);
  });
});
