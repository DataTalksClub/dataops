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

  test('chases the overdue invoice first, records a payment from its deal, and forecasts the rest', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${server.port}`, timezoneId: BERLIN_TIME_ZONE });
    assertOwnedServerResponse(server, await context.request.get('/__e2e__/browser-session'), 'money session');
    const api = context.request;
    const organization = await json(await api.post('/api/sponsor-crm/organizations', { data: {
      displayName: 'Synthetic Money Sponsor', sourceKey: 'money-org',
    } }));
    const created = await json(await api.post('/api/sponsor-crm/deals', { data: {
      organizationId: organization.id, status: 'open', sourceKey: 'money-deal',
      nextAction: { type: 'follow_up', due: '2026-09-01', owner: server.userId, note: 'money' },
    } }));
    const deal = await json(await api.put(`/api/sponsor-crm/deals/${created.id}`, { data: {
      version: created.version, status: 'agreed',
      nextAction: { type: 'follow_up', due: '2026-09-01', owner: server.userId, note: 'money' },
    } }));
    // The isolated server's local DynamoDB has no transactions, so finance
    // writes cannot run there; the finance API is served from a stateful fake
    // that follows the backend's projection contract.
    const finance = {
      version: 3, invoiceRequirement: 'required', amountDue: '2500.00', currency: 'EUR', taxMode: 'included',
      issuedOn: '2026-01-05', dueOn: '2026-02-04',
    };
    let payments = [];
    const requests = [];
    const projection = () => {
      const paid = payments.reduce((sum, item) => sum + Number(item.amount), 0);
      return {
        enabled: true, classified: true, dealId: deal.id, role: 'admin', finance: { ...finance },
        invoiceState: 'issued', paymentState: paid ? 'partially-paid' : 'unpaid', timingState: 'overdue',
        outstanding: (2500 - paid).toFixed(2), paid: paid.toFixed(2), payments,
        followUp: finance.waitingOn
          ? { code: 'await-sponsor', party: 'sponsor', since: finance.waitingOn.since, reason: finance.waitingOn.reason }
          : { code: 'chase-payment', party: 'us', since: '2026-02-04', daysOverdue: 30 },
        reconciliationStatus: 'coherent', paymentLinkCount: payments.length, paymentLinkLimit: 10,
      };
    };
    await context.route('**/api/sponsor-crm/finance/ledger', (route) => {
      const row = {
        dealId: deal.id, organizationId: organization.id, organizationName: 'Synthetic Money Sponsor', dealStatus: 'agreed',
        amountDue: '2500.00', currency: 'EUR', outstanding: '2500.00', invoiceState: 'issued', paymentState: 'unpaid',
        timingState: 'overdue', dueOn: '2026-02-04', followUp: { code: 'chase-payment', party: 'us', since: '2026-02-04', daysOverdue: 30 },
      };
      return route.fulfill({ json: {
        asOf: '2026-03-06', rows: [row], chase: [row],
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
      if (suffix === '/recorded-payments') {
        payments.push({ id: 'b'.repeat(32), effectiveDate: body.receivedOn, amount: body.amount, currency: body.currency, source: 'recorded', method: body.method });
      } else if (suffix.startsWith('/recorded-payments/')) {
        payments = payments.filter((item) => item.id !== suffix.split('/').at(-1));
      } else if (suffix === '/follow-through') {
        if ('waitingOn' in body) finance.waitingOn = body.waitingOn || undefined;
        if ('evidence' in body) finance.evidence = body.evidence;
      }
      finance.version += 1;
      return route.fulfill({ json: { result: {}, projection: projection() } });
    });

    const page = await context.newPage();
    await page.goto('/sponsors/money');
    await expect(page.locator('[data-crm-view="money"]')).toBeVisible();
    const chase = page.locator('.money-chase-row').filter({ hasText: 'Synthetic Money Sponsor' });
    await expect(chase).toContainText('Chase the payment');
    await expect(chase).toContainText('€2,500.00');
    await expect(page.locator('[data-money-currency="EUR"]')).toContainText('overdue');
    await expect(page.locator('[data-money-bucket="overdue"]')).toContainText('€2,500.00');

    await chase.getByRole('button', { name: 'Open deal' }).click();
    await expect(page).toHaveURL(new RegExp(`/sponsors/deals/${deal.id}$`));
    const panel = page.locator('[data-finance-panel]');
    await expect(panel.locator('[data-finance-next-step="chase-payment"]')).toBeVisible();
    await expect(panel).toContainText('Invoice without number');
    await panel.getByRole('button', { name: 'Record payment' }).click();
    const dialog = page.locator('[data-finance-record-payment-dialog]');
    await dialog.locator('input[name="amount"]').fill('1000.00');
    await dialog.locator('select[name="method"]').selectOption('bank-report');
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText('Accountant report');
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

    await panel.locator('[data-finance-delete-payment]').click();
    await page.locator('[data-sponsor-confirm-dialog] [data-confirm-accept]').click();
    await expect(panel).not.toContainText('Accountant report');
    expect(requests.map((entry) => `${entry.method} ${entry.suffix}`)).toEqual([
      'POST /recorded-payments', 'PUT /follow-through', 'PUT /follow-through', `DELETE /recorded-payments/${'b'.repeat(32)}`,
    ]);
    expect(requests[0].body).toMatchObject({ amount: '1000.00', currency: 'EUR', method: 'bank-report' });
    expect(requests[2].body.evidence).toEqual([{ kind: 'url', ref: 'https://mail.example.invalid/thread/1', label: 'Invoice thread' }]);
    await context.close();
  });
});
