const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const SOP = 'content/workshops/sops/run-workshop.md';
const targets = [
  ['system.navigation', 'content/start/navigation.md', 'Navigate operating reference'],
  ['template.podcast', 'content/tasks/podcast.md', 'Produce a podcast'],
  ['reference.webinar', 'content/reference/webinar.md', 'Live webinars'],
  ['reference.workshop', 'content/reference/workshop.md', 'Live workshops'],
];
const doc = (id, title, body, related = []) => `---\nid: ${id}\ntitle: ${title}\ndoc_type: sop\nsummary: ${'A long synthetic workshop summary. '.repeat(12)}\nrelated_docs: ${JSON.stringify(related)}\n---\n\n# ${title}\n\n${body}\n\nA long inline path: \`${'synthetic-directory/'.repeat(30)}\`\n\n\`\`\`text\n${'a long code line '.repeat(40)}\n\`\`\`\n`;
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('sop-reader', {
    [SOP]: doc('sop.workshop', 'Run a synthetic workshop', `## Summary\n\n${'Workshop summary text with enough words to wrap within the page column. '.repeat(12)}\n\n## Soft wrapping\n\nFirst source line.\nSecond source line.\nThird source line.\n\n## Prerequisites\n\n- ${'Prerequisite text '.repeat(40)}\n- https://example.test/${'long-path'.repeat(40)}\n\n[Podcast reference](/tasks/podcast.md)`, targets.map(t => t[0])),
    ...Object.fromEntries(targets.map(([id, path, title]) => [path, doc(id, title, 'Target document content.')])),
  }) } });
});
test.afterAll(async () => stopOwnedTestServer(server));
async function open(page) {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/${SOP.replace(/^content\//, '')}`);
  await expect(page.locator('.block-title')).toHaveText('Run a synthetic workshop');
}
test('loaded SOP clears loading and save chrome and fits the desktop column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await expect(page.locator('#doc-state')).toBeHidden();
  await expect(page.locator('#editor-save-state')).toBeHidden();
  await expect(page.locator('#editor-save-button')).toBeHidden();
  await expect(page.locator('#editor-discard-button')).toBeHidden();
  const metrics = await page.locator('.rendered-view').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.page).toBeLessThanOrEqual(metrics.viewport + 1);
  const column = await page.locator('.rendered-view').boundingBox();
  const summary = await page.locator('.notion-text-content').first().boundingBox();
  expect(summary.x + summary.width).toBeLessThanOrEqual(column.x + column.width + 1);
  const prose = page.locator('.notion-text-content').filter({ hasText: 'First source line.' });
  const proseBox = await prose.boundingBox();
  expect(proseBox.x).toBeCloseTo(column.x, 0);
  expect(proseBox.width).toBeCloseTo(column.width, 0);
  const lineHeight = await prose.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
  expect(proseBox.height).toBeLessThan(lineHeight * 1.5);

});
test('every Related link shows its title and navigates; ordinary markdown links follow on click', async ({ page }) => {
  for (const [, path, title] of targets) {
    await open(page);
    await page.locator('.block-related').getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveURL(`${server.baseURL}/${path.replace(/^content\//, '')}`);
    await expect(page.locator('.block-title')).toHaveText(title);
    await expect(page.locator('#doc-state')).toBeHidden();
  }
  await open(page);
  await page.getByRole('link', { name: 'Podcast reference', exact: true }).click();
  await expect(page.locator('.block-title')).toHaveText('Produce a podcast');
});

test('save actions appear only after editing and disappear after discard', async ({ page }) => {
  await open(page);
  const summary = page.locator('.doc-property-text');
  await summary.fill('Edited synthetic summary');
  await summary.blur();
  await expect(page.locator('#editor-save-button')).toBeVisible();
  await expect(page.locator('#editor-save-state')).not.toHaveText('Loading...');
  await page.locator('#editor-discard-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('#editor-save-button')).toBeHidden();
});

test('an identical stored draft does not show save controls without edits', async ({ page }) => {
  const response = await page.request.get(`${server.baseURL}/docs?path=${encodeURIComponent(SOP)}`);
  expect(response.status()).toBe(200);
  const { content } = await response.json();
  await page.addInitScript(({ path, content }) => {
    localStorage.setItem(`dtc-doc-draft:${path}`, content);
  }, { path: SOP, content });
  await open(page);
  await expect(page.locator('#doc-state')).toBeHidden();
  await expect(page.locator('#editor-save-state')).toBeHidden();
  await expect(page.locator('#editor-save-button')).toBeHidden();
  await expect(page.locator('#editor-discard-button')).toBeHidden();
});

test('a missing document shows a visible error with retry and no loading state', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/missing.md`);
  await expect(page.locator('#doc-state [data-document-state="not-found"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry loading content/missing.md' })).toBeVisible();
  await expect(page.locator('[data-document-state="loading"]')).toHaveCount(0);
  await expect(page.locator('#editor-save-button')).toBeHidden();
});
