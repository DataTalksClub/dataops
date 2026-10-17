const { test, expect } = require('@playwright/test');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server, agreement;
test.beforeAll(async () => {
  server = await startOwnedTestServer();
  const response = await fetch(`${server.baseURL}/api/tuition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    studentName: 'Synthetic Student', title: 'Deferred installment', trigger: 'First paid employment', status: 'conditional', amount: '900', currency: 'EUR',
  }) });
  if (!response.ok) throw new Error(await response.text());
  agreement = await response.json();
});
test.afterAll(async () => stopOwnedTestServer(server));
test('individual tuition has an editable billing home and retains its real condition with no invented due date', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: server.baseURL });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/bookkeeping?view=tuition&agreement=${agreement.id}`);
  await expect(page.getByRole('heading', { name: 'Tuition agreements & installments' })).toBeVisible();
  const form = page.locator('[data-tuition-form]');
  await expect(form.locator('[name="studentName"]')).toHaveValue('Synthetic Student');
  await expect(form.locator('[name="trigger"]')).toHaveValue('First paid employment');
  await expect(form.locator('[name="dueOn"]')).toHaveValue('');
  await form.locator('[name="notes"]').fill('Synthetic billing condition retained');
  await form.getByRole('button', { name: 'Save agreement' }).click();
  await expect(form.locator('[name="notes"]')).toHaveValue('Synthetic billing condition retained');
  await expect(form.locator('[name="dueOn"]')).toHaveValue('');
  await expect.poll(async () => (await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json()).notes).toBe('Synthetic billing condition retained');
  const stored = await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json();
  expect(stored.trigger).toBe('First paid employment');
  expect(stored.dueOn).toBeNull();
  expect(errors).toEqual([]);
  await context.close();
});
