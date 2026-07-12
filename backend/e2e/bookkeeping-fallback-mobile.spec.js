const { test, expect } = require('@playwright/test');

test('production fallback bookkeeping stays within a 390px viewport', async ({ page }) => {
  const entries = Array.from({ length: 987 }, (_, index) => ({
    id: `synthetic-${index}`,
    transactionDate: '2026-07-01',
    paidDate: '2026-07-02',
    counterparty: `Synthetic vendor ${index}`,
    description: 'Synthetic bookkeeping entry with a realistically long description',
    amount: '123.45',
    currency: 'EUR',
    category: 'software subscriptions',
    entryType: 'expense',
    statementRef: 'synthetic-reference',
  }));

  await page.route('**/api/bookkeeping/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/transactions')) return route.fulfill({ json: { items: entries } });
    if (path.endsWith('/documents')) return route.fulfill({ json: { items: [{ id: 'synthetic-document', originalFilename: 'synthetic-private-account-statement-with-long-name.pdf', documentType: 'private-account-statement' }] } });
    if (path.endsWith('/links') || path.endsWith('/accounts')) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: 'Synthetic route not configured' } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/bookkeeping');
  await expect(page.locator('#bookkeeping-list tbody tr')).toHaveCount(987);
  await expect(page.getByText('synthetic-private-account-statement-with-long-name.pdf')).toBeVisible();

  const dimensions = await page.evaluate(() => {
    const ledger = document.querySelector('#bookkeeping-list .table-wrap');
    return {
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      ledgerClient: ledger.clientWidth,
      ledgerScroll: ledger.scrollWidth,
    };
  });
  expect(dimensions.viewport).toBe(390);
  expect(dimensions.page).toBeLessThanOrEqual(390);
  expect(dimensions.body).toBeLessThanOrEqual(390);
  expect(dimensions.ledgerScroll).toBeGreaterThan(dimensions.ledgerClient);
  await page.screenshot({ path: '.tmp/bookkeeping-fallback-mobile.png' });

  const evidence = page.locator('#evidence-heading').locator('..');
  await evidence.scrollIntoViewIfNeeded();
  const evidenceDimensions = await evidence.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      client: element.clientWidth,
      scroll: element.scrollWidth,
      page: document.documentElement.scrollWidth,
    };
  });
  expect(evidenceDimensions.left).toBeGreaterThanOrEqual(0);
  expect(evidenceDimensions.right).toBeLessThanOrEqual(390);
  expect(evidenceDimensions.scroll).toBeLessThanOrEqual(evidenceDimensions.client);
  expect(evidenceDimensions.page).toBeLessThanOrEqual(390);
  await expect(page.getByText('synthetic-private-account-statement-with-long-name.pdf')).toBeInViewport();
  await evidence.screenshot({ path: '.tmp/bookkeeping-fallback-mobile-evidence.png' });
});
