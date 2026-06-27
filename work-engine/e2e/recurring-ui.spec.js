const { test, expect } = require('@playwright/test');

async function deleteConfigsByDescription(request, description) {
  const res = await request.get('/api/recurring');
  const body = await res.json();
  for (const config of body.recurringConfigs || []) {
    if (config.description === description) {
      await request.delete('/api/recurring/' + config.id);
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
