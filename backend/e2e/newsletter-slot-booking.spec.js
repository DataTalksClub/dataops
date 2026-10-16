const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// Booking a newsletter slot from the issue row: pick a sponsor from the
// Sponsors tab, change it, remove it. Every name here is synthetic.
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('newsletter-slot-booking/docs-cache') },
  });
});
test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

const addDays = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

test('books, changes and removes a slot sponsor from the issue row', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.baseURL });
  const page = await context.newPage();
  const request = context.request;
  try {
    const post = async (route, data) => {
      const response = await request.post(route, { data });
      expect(response.status(), await response.text()).toBeLessThan(300);
      return response.json();
    };
    await post('/__e2e__/template-fixtures', {
      name: 'Synthetic weekly newsletter', type: 'newsletter', triggerType: 'manual', references: [],
      taskDefinitions: [
        { refId: 'write', description: 'Write the synthetic issue', offsetDays: -3 },
        { refId: 'secondary-doc', description: 'Synthetic secondary document', offsetDays: -7, optionalGroup: 'secondary-slot' },
      ],
    });
    const first = await post('/api/sponsor-crm/organizations', { displayName: 'Synthetic Slot Alpha' });
    await post('/api/sponsor-crm/deals', { organizationId: first.id, status: 'agreed', title: 'Synthetic package' });
    await post('/api/sponsor-crm/organizations', { displayName: 'Synthetic Slot Beta' });
    const issue = await post('/api/newsletter-issues', {
      kind: 'weekly', publicationDate: addDays(12), issueNumber: 901, slots: { primary: {}, secondary: {} },
    });

    await page.goto('/newsletter');
    const row = page.locator(`article[data-issue-id="${issue.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByRole('checkbox')).toHaveCount(0);

    // Book: the open slot is a button that opens a type-to-search picker.
    await row.getByRole('button', { name: 'Book a sponsor for the secondary slot of Weekly #901' }).click();
    await row.getByRole('combobox').fill('Alpha');
    await row.getByRole('option', { name: /Synthetic Slot Alpha/ }).click();
    const sponsorButton = row.getByRole('button', { name: /Change the secondary sponsor of Weekly #901/ });
    await expect(sponsorButton).toContainText('Synthetic Slot Alpha');
    let saved = await (await request.get(`/api/newsletter-issues/${issue.id}`)).json();
    expect(saved.slots.secondary.sponsor).toBe('Synthetic Slot Alpha');
    const deliverables = async () => (await (await request.get('/api/sponsor-crm/deliverables', { params: { limit: '100' } })).json())
      .items.filter((item) => item.newsletterIssueId === issue.id);
    expect((await deliverables()).map((item) => [item.channel, Boolean(item.withdrawnAt)])).toEqual([['secondary', false]]);

    // Change: picking another sponsor replaces the booking in one step.
    await sponsorButton.click();
    await row.getByRole('combobox').fill('Beta');
    await row.getByRole('option', { name: /Synthetic Slot Beta/ }).click();
    await expect(row.getByRole('button', { name: /Change the secondary sponsor of Weekly #901/ })).toContainText('Synthetic Slot Beta');
    const changed = await deliverables();
    expect(changed.filter((item) => !item.withdrawnAt)).toHaveLength(1);
    expect(changed.filter((item) => item.withdrawnAt)).toHaveLength(1);

    // Remove: asks first, then frees the slot; the booking stays, withdrawn.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Remove Synthetic Slot Beta from the secondary slot of Weekly #901?');
      dialog.accept();
    });
    await row.getByRole('button', { name: 'Remove Synthetic Slot Beta from the secondary slot of Weekly #901' }).click();
    await expect(row.getByRole('button', { name: 'Book a sponsor for the secondary slot of Weekly #901' })).toBeVisible();
    saved = await (await request.get(`/api/newsletter-issues/${issue.id}`)).json();
    expect(saved.slots.secondary).toEqual({});
    expect((await deliverables()).every((item) => item.withdrawnAt)).toBe(true);

    // Compact on a phone: the slot controls fit without sideways scrolling.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  } finally {
    await context.close();
  }
});
