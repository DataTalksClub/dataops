const { test, expect } = require('@playwright/test');
const { BERLIN_TIME_ZONE } = require('./helpers/business-date');
const {
  assertOwnedServerResponse,
  startIsolatedCapabilityServer,
  stopIsolatedCapabilityServer,
} = require('./helpers/isolated-capability-server');
const path = require('path');

const server = { userId: '15900000-0000-4000-8000-000000000031', role: 'admin', documents: [] };
const tmpRoot = path.resolve(__dirname, '..', '..', '.tmp', 'sponsor-money-e2e');

async function json(response) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.describe('Sponsors Money', () => {
  test.beforeAll(async () => {
    await startIsolatedCapabilityServer(server, tmpRoot);
  });
  test.afterAll(async () => {
    await stopIsolatedCapabilityServer(server);
  });

  test('follows up on the overdue invoice first, records verified receipts and preserves reported-payment reconciliation, and forecasts the rest', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${server.port}`, timezoneId: BERLIN_TIME_ZONE });
    assertOwnedServerResponse(server, await context.request.get('/__e2e__/browser-session'), 'money session');
    const api = context.request;
    const organization = await json(await api.post('/api/sponsor-crm/organizations', { data: {
      displayName: 'Synthetic Money Sponsor', sourceKey: 'money-org',
    } }));
    const created = await json(await api.post('/api/sponsor-crm/deals', { data: {
      organizationId: organization.id, status: 'open', sourceKey: 'money-deal',
    } }));
    const deal = await json(await api.put(`/api/sponsor-crm/deals/${created.id}`, { data: {
      version: created.version, status: 'agreed',
    } }));
    // The isolated server's local DynamoDB has no transactions, so finance
    // writes cannot run there; the finance API is served from a stateful fake
    // that follows the backend's projection contract.
    const finance = {
      version: 3, invoiceRequirement: 'required', amountDue: '2500.00', currency: 'EUR', taxMode: 'included',
      issuedOn: '2026-01-05', sentOn: '2026-01-06', dueOn: '2026-02-04',
    };
    let payments = [];
    const requests = [];
    const invoice = { id: 'reviewed-money-original', label: 'Original invoice', uploadedAt: '2026-01-05' };
    const bookkeeping = new Map(), evidenceLinks = new Map();
    const projection = () => {
      const paid = payments.filter((item) => item.source === 'ledger').reduce((sum, item) => sum + Number(item.amount), 0);
      const adjusted = Number(finance.settlementAdjustment?.amount || 0), settled = paid + adjusted === 2500;
      return {
        enabled: true, classified: true, dealId: deal.id, role: 'admin', finance: { ...finance },
        invoiceState: 'issued', invoice, paymentState: settled ? 'paid' : paid ? 'partially-paid' : 'unpaid', timingState: settled ? 'settled' : 'overdue',
        outstanding: (2500 - paid - adjusted).toFixed(2), adjusted: adjusted.toFixed(2), paid: paid.toFixed(2), payments,
        followUp: payments.some((item) => item.source === 'recorded') ? { code: 'reconcile', party: 'us' }
          : settled ? { code: 'none', party: 'none' } : finance.waitingOn
          ? { code: 'await-sponsor', party: 'sponsor', since: finance.waitingOn.since, reason: finance.waitingOn.reason }
          : { code: 'payment-follow-up', party: 'us', since: '2026-02-04', daysOverdue: 30 },
        reconciliationStatus: 'coherent', paymentLinkCount: payments.length, paymentLinkLimit: 10,
      };
    };
    await context.route('**/api/sponsor-crm/finance/ledger', (route) => {
      const row = {
        dealId: deal.id, organizationId: organization.id, organizationName: 'Synthetic Money Sponsor', dealStatus: 'agreed',
        amountDue: '2500.00', currency: 'EUR', outstanding: '2500.00', invoiceState: 'issued', paymentState: 'unpaid',
        timingState: 'overdue', dueOn: '2026-02-04', followUp: { code: 'payment-follow-up', party: 'us', since: '2026-02-04', daysOverdue: 30 },
      };
      return route.fulfill({ json: {
        asOf: '2026-03-06', rows: [row], followUps: [row],
        totals: [{ currency: 'EUR', outstanding: '2500.00', overdue: '2500.00', notInvoiced: '0.00', paidThisYear: '0.00' }],
        forecast: [{ bucket: 'overdue', currency: 'EUR', amount: '2500.00', dealIds: [deal.id] }],
      } });
    });
    await context.route(`**/api/sponsor-crm/deals/${deal.id}/finance**`, async (route) => {
      const request = route.request();
      const suffix = new URL(request.url()).pathname.split('/finance')[1];
      if (request.method() === 'GET') return route.fulfill({ json: projection() });
      const body = request.postDataJSON();
      requests.push({ method: request.method(), suffix, body });
      expect(body.expectedVersion).toBe(finance.version);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      if (suffix === '/receipts') {
        const id = `verified-receipt-${bookkeeping.size + 1}`;
        const row = { id, effectiveDate: body.receivedOn, amount: body.amount, currency: body.currency,
          reference: body.reference, counterparty: body.counterparty, source: 'ledger', amountEur: body.amountEur };
        if (body.replacesPaymentId) payments = payments.filter((item) => item.id !== body.replacesPaymentId);
        payments.push(row); bookkeeping.set(id, row); evidenceLinks.set(id, invoice.id);
      } else if (suffix.startsWith('/receipts/')) {
        const id = suffix.split('/').at(-1), existing = bookkeeping.get(id);
        Object.assign(existing, { amount: body.amount, effectiveDate: body.receivedOn, reference: body.reference });
      } else if (suffix === '/settlement-adjustment') {
        if (request.method() === 'DELETE') delete finance.settlementAdjustment;
        else finance.settlementAdjustment = { ...body, id: 'explicit-owner-approved-adjustment' };
      } else if (suffix === '/payment-evidence') {
        expect(body.documentId).toBe(invoice.id);
        for (const id of body.transactionIds) { expect(bookkeeping.has(id)).toBe(true); evidenceLinks.set(id, body.documentId); }
      } else if (suffix === '/follow-through') {
        if ('waitingOn' in body) finance.waitingOn = body.waitingOn || undefined;
        if ('evidence' in body) finance.evidence = body.evidence;
      }
      finance.version += 1;
      return route.fulfill({ json: { result: {}, projection: projection() } });
    });

    const page = await context.newPage();
    await page.goto('/sponsors/money');
    await expect(page.locator('[data-crm-money]')).toBeVisible();
    const followUp = page.locator('.money-follow-up-row').filter({ hasText: 'Synthetic Money Sponsor' });
    await expect(followUp).toContainText('Follow up on the payment');
    await expect(followUp).toContainText('€2,500.00');
    await expect(page.locator('[data-money-currency="EUR"]')).toContainText('overdue');
    await expect(page.locator('[data-money-bucket="overdue"]')).toContainText('€2,500.00');

    await followUp.getByRole('button', { name: 'Open deal' }).click();
    await expect(page).toHaveURL(new RegExp(`/sponsors/deals/${deal.id}$`));
    await page.getByRole('tab', { name: 'Finance' }).click();
    const panel = page.locator('[data-finance-panel]');
    await expect(panel.locator('[data-finance-next-step="payment-follow-up"]')).toBeVisible();
    await expect(panel).toContainText('Invoice without number');
    await panel.getByRole('button', { name: 'Record verified receipt' }).click();
    const dialog = page.locator('[data-finance-record-payment-dialog]');
    await dialog.locator('input[name="amount"]').fill('1000.00');
    await dialog.locator('input[name="reference"]').fill('synthetic-bank:account:receipt-one');
    await dialog.locator('input[name="counterparty"]').fill('Synthetic Money Sponsor');
    await dialog.getByRole('button', { name: 'Record verified receipt' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText('Bookkeeping');
    expect(bookkeeping.size).toBe(1); expect(evidenceLinks.get('verified-receipt-1')).toBe(invoice.id);
    await expect(panel).toContainText('€1,500.00');

    await panel.getByRole('button', { name: 'Set waiting on' }).click();
    const waiting = page.locator('[data-finance-waiting-dialog]');
    await waiting.locator('select[name="party"]').selectOption('sponsor');
    await waiting.locator('select[name="reason"]').selectOption('approval');
    await waiting.getByRole('button', { name: 'Save' }).click();
    await expect(panel.locator('[data-finance-waiting="sponsor"]')).toContainText('Waiting on the sponsor for approval');

    await panel.getByRole('button', { name: 'Add evidence' }).click();
    const evidence = page.locator('[data-finance-evidence-dialog]');
    await evidence.locator('select[name="kind"]').selectOption('url');
    await evidence.locator('input[name="ref"]').fill('https://mail.example.invalid/thread/1');
    await evidence.locator('input[name="label"]').fill('Invoice thread');
    await evidence.getByRole('button', { name: 'Add evidence' }).click();
    await expect(panel.getByRole('link', { name: 'Invoice thread' })).toBeVisible();

    await panel.getByRole('button', { name: 'Correct receipt', exact: true }).click();
    await dialog.locator('input[name="amount"]').fill('950.00');
    await dialog.getByRole('button', { name: 'Save correction' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText('\u20ac1,550.00');
    expect(bookkeeping.get('verified-receipt-1').amount).toBe('950.00');
    expect(finance.amountDue).toBe('2500.00');
    await panel.getByRole('button', { name: 'Attach invoice to bookkeeping' }).click();
    await expect.poll(() => requests.some((entry) => entry.suffix === '/payment-evidence')).toBe(true);
    expect(evidenceLinks.size).toBe(1);

    await test.step('owner-approved noncash settlement is distinct from cash and can be reversed', async () => {
      await panel.getByRole('button', { name: 'Approve noncash settlement', exact: true }).click();
      const approval = page.locator('[data-finance-adjustment-dialog]');
      await approval.locator('[name="reason"]').fill('Synthetic owner accepted documented reduction');
      await approval.locator('[name="approvedBy"]').fill('Synthetic owner');
      await approval.locator('[name="ref"]').fill('synthetic-owner-approval-source');
      await approval.getByRole('button', { name: 'Approve noncash settlement', exact: true }).click();
      await expect(approval).toBeHidden();
      await expect(panel.locator('header h3').first()).toHaveText('Settled with adjustment');
      await expect(panel).toContainText('Cash received: \u20ac950.00');
      expect(bookkeeping.size).toBe(1); expect(finance.amountDue).toBe('2500.00');
      page.once('dialog', (dialog) => dialog.accept('Synthetic owner revoked settlement'));
      await panel.getByRole('button', { name: 'Reverse noncash settlement', exact: true }).click();
      await expect(panel.locator('header h3').first()).toHaveText('Partially Paid');
      await expect(panel).toContainText('\u20ac1,550.00');
      expect(bookkeeping.size).toBe(1);
    });

    await test.step('reported cash remains unverified until an actual receipt confirms it', async () => {
      payments.push({ id: 'c'.repeat(32), source: 'recorded', effectiveDate: '2026-03-07', amount: '1550.00',
        currency: 'EUR', method: 'sponsor-confirmation', reference: 'Sponsor says paid' });
      finance.version += 1; finance.waitingOn = undefined;
      await page.reload();
      await page.getByRole('tab', { name: 'Finance' }).click();
      await expect(panel.locator('[data-finance-next-step="reconcile"]')).toBeVisible();
      await expect(panel).toContainText('Reported, unverified: Sponsor confirmation');
      await expect(panel).toContainText('\u20ac1,550.00');
      await panel.getByRole('button', { name: 'Record verified receipt', exact: true }).click();
      await dialog.locator('select[name="replacesPaymentId"]').selectOption('c'.repeat(32));
      await dialog.locator('input[name="reference"]').fill('synthetic-bank:account:receipt-two');
      await dialog.locator('input[name="counterparty"]').fill('Synthetic Money Sponsor');
      await dialog.getByRole('button', { name: 'Record verified receipt' }).click();
      await expect(dialog).toBeHidden();
      await expect(panel).not.toContainText('Reported, unverified');
      await expect(panel.locator('header h3').first()).toHaveText('Paid');
      await expect(panel.locator('[data-finance-thank-you="required"]')).toBeVisible();
      await expect(panel.locator('[data-finance-thank-you="required"]')).toContainText('Send from orin@ — template exists, no Alexey approval');
      await expect(panel.locator('[data-finance-thank-you="required"] .template-placeholder-chip').filter({ hasText: '<WHAT_WAS_PAID>' })).toBeVisible();
      await panel.locator('[data-finance-thank-you="required"] .template-placeholder-chip').filter({ hasText: '<WHAT_WAS_PAID>' }).click();
      await expect(panel.locator('[data-finance-thank-you="required"] .template-placeholder-panel')).toContainText('<WHAT_WAS_PAID>');
      expect(bookkeeping.size).toBe(2); expect(evidenceLinks.size).toBe(2);
    });
    expect(requests.map((entry) => `${entry.method} ${entry.suffix}`)).toEqual([
      'POST /receipts', 'PUT /follow-through', 'PUT /follow-through', 'PUT /receipts/verified-receipt-1',
      'POST /payment-evidence', 'POST /settlement-adjustment', 'DELETE /settlement-adjustment', 'POST /receipts',
    ]);
    expect(requests[0].body).toMatchObject({ amount: '1000.00', currency: 'EUR', counterparty: 'Synthetic Money Sponsor', reference: 'synthetic-bank:account:receipt-one' });
    expect(requests.at(-1).body.replacesPaymentId).toBe('c'.repeat(32));
    expect(requests[2].body.evidence).toEqual([{ kind: 'url', ref: 'https://mail.example.invalid/thread/1', label: 'Invoice thread' }]);
    await context.close();
  });
});
