// The document editor feels like Notion: a page you click into and type,
// with the keyboard model, "/" menu, block gutter, formatting toolbar and
// smart paste. Fixtures are synthetic and public-safe; nothing is saved
// to knowledge storage — every assertion reads the local draft (#editor).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots', 'notion-editor');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const SOP_PATH = 'content/testing/notion-sop.md';
const PLAIN_PATH = 'content/testing/notion-plain.md';

const SOP = [
  '---',
  'title: "Synthetic Notion SOP"',
  'summary: Publish a synthetic episode with every step written down',
  '  so the folded summary survives an edit.',
  'doc_type: sop',
  'schema_version: 1',
  'tags:',
  '- synthetic',
  '- notion',
  'systems: [browser]',
  '---',
  '',
  '# Synthetic Notion SOP',
  '',
  '<!-- sop-section-start: summary -->',
  '## Summary',
  '',
  '- Purpose: exercise the editor.',
  '- Outcome: a draft that round-trips.',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: prerequisites -->',
  '## Prerequisites',
  '',
  'A synthetic browser.',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: procedure -->',
  '## Procedure',
  '',
  '<!-- sop-group-start: "Prepare" -->',
  '### Prepare',
  '',
  '<!-- sop-prose-start -->',
  'Intro prose inside the Prepare group.',
  '<!-- sop-prose-end -->',
  '',
  '<!-- sop-step-start id=1 action="click" -->',
  '1.  Open the **synthetic** dashboard.',
  '<!-- sop-step-end -->',
  '',
  '<!-- sop-step-start id=2 -->',
  '2.  Upload the synthetic file.',
  '<!-- sop-step-end -->',
  '',
  '<!-- sop-step-start id=3 -->',
  '3.  Check the synthetic result.',
  '<!-- sop-step-end -->',
  '<!-- sop-group-end -->',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: validation -->',
  '## Validation',
  '',
  'The synthetic result is visible.',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: troubleshooting -->',
  '## Troubleshooting',
  '',
  'Retry the synthetic upload.',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: references -->',
  '## References',
  '',
  'None.',
  '<!-- sop-section-end -->',
  '',
].join('\n');

const PLAIN = [
  '---',
  'title: "Synthetic Notion Page"',
  'doc_type: reference',
  '---',
  '',
  '# Synthetic Notion Page',
  '',
  'First paragraph of the page.',
  '',
  '- First item',
  '- Second item',
  '',
  'Last paragraph.',
  '',
].join('\n');

let server;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot('notion-editor', {
        [SOP_PATH]: SOP,
        [PLAIN_PATH]: PLAIN,
      }),
    },
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

async function openDoc(page, docPath, title, viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/${docPath.replace(/^content\//, '')}`);
  await expect(page.locator('#rendered-view .block-title')).toHaveText(title, { timeout: 20_000 });
  // Edits stay local: a failing save would show here, and none is attempted.
  await page.route('**/docs?**', (route) => (route.request().method() === 'PUT'
    ? route.abort() : route.continue()));
}

const draft = (page) => page.locator('#editor');
const step = (page, id) => page.locator(`.block-step[data-step-id="${id}"] .block-step-body`);

async function capture(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

test('an SOP reads as one document: title, properties, sections, no stat strip', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  const view = page.locator('#rendered-view');
  const properties = view.locator('.doc-properties');
  await expect(properties.locator('dt')).toHaveText(['Type', 'Summary', 'Tags', 'Systems']);
  // The folded YAML summary is read whole, and unindented tag lists are seen.
  await expect(properties.locator('.doc-property-text')).toHaveText(
    'Publish a synthetic episode with every step written down so the folded summary survives an edit.',
  );
  await expect(properties.locator('.doc-chip-label')).toHaveText(['synthetic', 'notion', 'browser']);
  await expect(view).not.toContainText('Edit metadata');
  await expect(view).not.toContainText(/\d+ steps?/);
  // Prose stays inside its group, before the steps, as in the file.
  await expect(view.locator('.block-group').first().locator('.block-prose, .block-step').first())
    .toHaveClass(/block-prose/);
  // No save chrome until there is a draft.
  await expect(page.locator('#editor-save-button')).toBeHidden();
  for (const block of [view.locator('.block-title'), step(page, 1), view.locator('.block-group-title')]) {
    await expect(block).toHaveAttribute('contenteditable', /true|plaintext-only/);
  }
  await capture(page, 'sop-desktop');
});

test('steps: Enter splits, Backspace merges, Shift+Tab groups, Tab joins, arrows move', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  await step(page, 2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(step(page, 3)).toBeFocused();
  await page.keyboard.type('A step typed right after Enter.');
  await expect(draft(page)).toHaveValue(
    /<!-- sop-step-start id=3 -->\n3\. {2}A step typed right after Enter\.\n<!-- sop-step-end -->/,
  );
  await expect(page.locator('#editor-save-state')).toHaveText('Draft saved');
  // The untouched step after it was renumbered in place.
  await expect(draft(page)).toHaveValue(/<!-- sop-step-start id=4 -->\n4\. {2}Check the synthetic result\./);

  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(step(page, 2)).toBeFocused();
  await expect(draft(page)).toHaveValue(/2\. {2}Upload the synthetic file\. A step typed right after Enter\./);
  await page.keyboard.type('!');
  await expect(draft(page)).toHaveValue(/Upload the synthetic file\. !A step typed/);

  await step(page, 3).click();
  await page.keyboard.press('Shift+Tab');
  const newGroup = page.locator('.block-group-title').nth(1);
  await expect(newGroup).toBeFocused();
  await page.keyboard.type('Publish');
  await expect(draft(page)).toHaveValue(
    /<!-- sop-group-start: "Publish" -->\n### Publish\n\n<!-- sop-step-start id=3 -->/,
  );
  await step(page, 3).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(draft(page)).not.toHaveValue(/sop-group-start: "Publish"/);
  await expect(page.locator('.block-group')).toHaveCount(1);

  // Up from the first line of a step lands at the end of the block above.
  await step(page, 2).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await expect(step(page, 1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(step(page, 1)).not.toBeFocused();
  // Prose never left its group, and the procedure still parses the same way.
  await expect(draft(page)).toHaveValue(
    /### Prepare\n\n<!-- sop-prose-start -->\nIntro prose inside the Prepare group\.\n<!-- sop-prose-end -->/,
  );
  await capture(page, 'sop-keyboard');
});

test('rich text stays markdown: formatting reads back verbatim', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  await expect(step(page, 1).locator('strong')).toHaveText('synthetic');
  await step(page, 1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then wait.');
  await expect(draft(page)).toHaveValue(/1\. {2}Open the \*\*synthetic\*\* dashboard\. Then wait\./);
  // The step's attributes survive a text edit.
  await expect(draft(page)).toHaveValue(/<!-- sop-step-start id=1 action="click" -->/);
});

test('properties edit the frontmatter in place, keeping the file style', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  const properties = page.locator('.doc-properties');
  const tagInput = properties.locator('.doc-chip-input').first();
  await tagInput.fill('handoff');
  await tagInput.press('Enter');
  await expect(draft(page)).toHaveValue(/\ntags:\n- synthetic\n- notion\n- handoff\nsystems: \[browser\]\n/);
  const summary = properties.locator('.doc-property-text');
  await summary.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Today.');
  await page.keyboard.press('Escape');
  await expect(draft(page)).toHaveValue(
    /\nsummary: "Publish a synthetic episode with every step written down so the folded summary survives an edit\. Today\."\ndoc_type: sop\n/,
  );
});

test('a plain page: Enter in lists, markdown shortcuts, Backspace un-formats', async ({ page }) => {
  await openDoc(page, PLAIN_PATH, 'Synthetic Notion Page');
  const view = page.locator('#rendered-view');
  await view.locator('.notion-list-item-text').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Third item');
  await expect(draft(page)).toHaveValue(/- Second item\n- Third item/);
  // Enter on an empty item leaves the list.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## A heading');
  await expect(view.locator('[data-block-type="h2"] .notion-text-content')).toHaveText('A heading');
  await expect(draft(page)).toHaveValue(/- Third item\n\n## A heading\n\nLast paragraph\./);
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(draft(page)).toHaveValue(/- Third item\n\nA heading\n\nLast paragraph\./);
  // The title: Enter moves into the page.
  await view.locator('.block-title').click();
  await page.keyboard.press('Enter');
  await expect(view.locator('.notion-text-content').first()).toBeFocused();
  await capture(page, 'plain-keyboard');
});
