const { test, expect } = require('@playwright/test');
const { PDFDocument } = require('pdf-lib');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer, assertOwnedServerResponse } = require('./helpers/isolated-capability-server');

let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('invoice-generation') } });
});
test.afterAll(async () => { await stopOwnedTestServer(server); });

test('save a private contractor template, reload it and download a PDF with calculated total', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.baseURL });
  try {
    const page = await context.newPage();
    assertOwnedServerResponse(server, await page.goto('/bookkeeping?view=invoices'), 'invoice generator');
    const generator = page.locator('[data-invoice-generator]');
    await expect(generator.getByRole('heading', { name: 'Create contractor invoice' })).toBeVisible();
    await expect(generator.getByText('Add an approved invoice template to begin.')).toBeVisible();
    await generator.getByLabel('Template name', { exact: true }).fill('Synthetic contractor browser template');
    await generator.getByLabel('Contractor name, address and tax ID').fill('Synthetic Contractor\nExample Street 1');
    await generator.getByLabel('Customer name, address and tax ID').fill('Synthetic Customer\nExample Street 2');
    await generator.getByLabel('Payment details', { exact: true }).fill('Synthetic bank reference');
    await generator.getByLabel('Approved tax treatment').fill('Synthetic approved tax note');
    await generator.getByRole('button', { name: 'Save invoice template' }).click();
    await expect(generator.getByRole('status')).toContainText('Invoice template saved');
    await expect(generator.locator('[data-template-preview]')).toContainText('Synthetic Contractor');
    await page.reload();
    await generator.getByRole('combobox', { name: 'Invoice template', exact: true }).selectOption({ label: 'Synthetic contractor browser template' });
    await expect(generator.locator('[data-template-preview]')).toContainText('Synthetic approved tax note');
    await generator.getByLabel('Invoice number', { exact: true }).fill('PREVIEW-browser');
    await generator.getByLabel('Invoice date').fill('2026-10-29');
    await generator.getByLabel('Services provided in').fill('October 2026');
    let rows = generator.locator('[data-invoice-item]');
    await rows.nth(0).getByLabel('Work item').fill('Synthetic newsletter');
    await rows.nth(0).getByLabel('Amount (template currency)').fill('0.10');
    await generator.getByRole('button', { name: 'Add invoice item' }).click();
    await rows.nth(1).getByLabel('Work item').fill('Synthetic social media');
    await rows.nth(1).getByLabel('Amount (template currency)').fill('0.20');
    const pending = page.waitForEvent('download');
    await generator.getByRole('button', { name: 'Generate PDF' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('invoice-PREVIEW-browser.pdf');
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    await expect(generator.getByRole('status')).toContainText('Invoice total: 0.30 EUR');
    await rows.nth(1).getByRole('button', { name: 'Remove item' }).click();
    await expect(rows).toHaveCount(1);
    await rows.nth(0).getByRole('button', { name: 'Remove item' }).click();
    await expect(rows).toHaveCount(1);
    await expect(generator.getByRole('status')).toContainText('At least one invoice item is required');
  } finally { await context.close(); }
});
