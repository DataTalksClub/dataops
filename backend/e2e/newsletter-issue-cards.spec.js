const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// An issue far ahead has no Card yet: the row and the calendar say when the
// daily run creates it, and "Create card now" makes it at once.
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('newsletter-issue-cards/docs-cache') },
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

test('a far-future issue shows when its card comes and creates it on request', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.baseURL });
  const page = await context.newPage();
  const request = context.request;
  try {
    const fixture = await request.post('/__e2e__/template-fixtures', { data: {
      name: 'Synthetic weekly newsletter', type: 'newsletter', triggerType: 'manual', references: [],
      taskDefinitions: [{ refId: 'write', description: 'Write the synthetic issue', offsetDays: -3 }],
    } });
    expect(fixture.status()).toBe(201);
    const publicationDate = addDays(60);
    const created = await request.post('/api/newsletter-issues', { data: {
      kind: 'weekly', publicationDate, issueNumber: 950, slots: { primary: {}, secondary: {} },
    } });
    expect(created.status()).toBe(201);
    const issue = await created.json();
    expect(issue.cardId).toBeUndefined();
    expect(issue.cardDueDate).toBe(addDays(39));

    await page.goto('/newsletter');
    const row = page.locator(`article[data-issue-id="${issue.id}"]`);
    await expect(row.locator('[data-card-due]')).toHaveText(/Card in 3[89] days/);
    await row.getByRole('button', { name: 'Create the card for Weekly #950 now' }).click();
    await expect(row.locator('.newsletter-card-chip')).toContainText('Preparation');
    await expect(row.locator('[data-card-due]')).toHaveCount(0);
    const saved = await (await request.get(`/api/newsletter-issues/${issue.id}`)).json();
    expect(saved.cardId).toBeTruthy();

    const overlays = await (await request.get('/api/calendar-items/overlays', { params: { from: publicationDate, to: publicationDate } })).json();
    const item = overlays.items.find((overlay) => overlay.id === issue.id);
    expect(item.newsletter.cardId).toBe(saved.cardId);
    expect(item.newsletter.cardDueDate).toBeNull();
  } finally {
    await context.close();
  }
});
