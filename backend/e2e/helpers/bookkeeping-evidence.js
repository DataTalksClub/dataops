const { expect } = require('@playwright/test');

// Exercise the current Files upload UI, then the canonical evidence-link API.
// Transaction details are a read-only dialog, not the retired edit side pane.
async function uploadBookkeepingEvidence(page, context, transactionId, { month, filename }) {
  await page.goto(`/bookkeeping?view=files&month=${month}`);
  await page.locator('.bookkeeping-upload-panel > summary').click();
  await page.getByLabel('Document type').selectOption('receipt');
  await page.locator('[data-pdf]').setInputFiles({
    name: filename, mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4\nsynthetic evidence ${filename}\n%%EOF`),
  });
  await page.getByRole('button', { name: 'Upload PDF', exact: true }).click();
  await expect(page.locator('[data-bookkeeping-status]')).toContainText('PDF uploaded and verified');
  const response = await context.request.get('/api/bookkeeping/documents');
  expect(response.ok()).toBe(true);
  const { items } = await response.json();
  const document = items.find((item) => item.originalFilename === filename);
  expect(document?.status).toBe('active');
  const linked = await context.request.post('/api/bookkeeping/links', { data: {
    documentId: document.id, transactionId, coverageType: 'evidence',
  } });
  expect(linked.ok()).toBe(true);
  return document;
}

module.exports = { uploadBookkeepingEvidence };
