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

test('"/" opens the block menu in place, filters as you type and inserts blocks', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  const menu = page.locator('.block-slash-menu.is-inline');
  await step(page, 3).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(menu.locator('.slash-menu-item strong')).toHaveText(
    ['Step', 'Text', 'Group', 'Screenshot', 'Video', 'TODO'],
  );
  await expect(step(page, 4)).toBeFocused();
  await page.keyboard.type('tex');
  await expect(menu.locator('.slash-menu-item strong')).toHaveText(['Text']);
  await capture(page, 'sop-slash');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('A note between steps.');
  await expect(draft(page)).toHaveValue(
    /3\. {2}Check the synthetic result\.\n<!-- sop-step-end -->\n\n<!-- sop-prose-start -->\nA note between steps\.\n<!-- sop-prose-end -->/,
  );
  await expect(draft(page)).not.toHaveValue(/\/tex/);

  // Escape closes the menu and keeps what was typed, like Notion.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/gro');
  await expect(menu).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.block-prose-body').last()).toHaveText('/gro');

  await openDoc(page, PLAIN_PATH, 'Synthetic Notion Page');
  const view = page.locator('#rendered-view');
  await view.locator('.notion-text-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/h2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Slash heading');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/div');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the line.');
  await expect(draft(page)).toHaveValue(/Last paragraph\.\n\n## Slash heading\n\n---\n\nAfter the line\.$/);
});

test('the gutter: hover shows "+" and the handle; drag shows a 1px line and moves; the handle opens the menu', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  const block = (id) => page.locator(`.block-step[data-step-id="${id}"]`);
  const gutter = (id) => block(id).locator('> .block-gutter');
  await expect(gutter(1)).toHaveCSS('opacity', '0');
  await step(page, 1).hover();
  await expect(gutter(1)).toHaveCSS('opacity', '1');
  await expect(gutter(1).locator('.block-gutter-add')).toBeVisible();
  await capture(page, 'gutter-hover');

  // Drag step 3 above step 1: a 1px neutral line marks the drop edge.
  const handle = gutter(3).locator('.block-gutter-handle');
  await step(page, 3).hover();
  const from = await handle.boundingBox();
  const to = await block(1).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + 4, { steps: 8 });
  await expect(block(1)).toHaveClass(/drop-above/);
  const line = await block(1).evaluate((node) => {
    const after = getComputedStyle(node, '::after');
    return { height: after.height, top: after.top };
  });
  expect(line).toEqual({ height: '1px', top: '0px' });
  await capture(page, 'gutter-drag');
  await page.mouse.up();
  await expect(draft(page)).toHaveValue(
    /<!-- sop-step-start id=1 -->\n1\. {2}Check the synthetic result\.[\s\S]*<!-- sop-step-start id=2 action="click" -->\n2\. {2}Open the \*\*synthetic\*\* dashboard\./,
  );
  // The prose stayed first in its group.
  await expect(draft(page)).toHaveValue(/### Prepare\n\n<!-- sop-prose-start -->/);

  await step(page, 2).hover();
  await gutter(2).locator('.block-gutter-handle').click();
  const menu = page.getByRole('menu', { name: 'Step actions' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Turn into text', 'Start a group here⇧Tab', 'Duplicate', 'Add screenshot…', 'Step properties…',
    'Move up', 'Move down', 'Delete',
  ]);
  await capture(page, 'gutter-menu');
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.locator('.block-step')).toHaveCount(4);
  await expect(draft(page)).toHaveValue(/2\. {2}Open the \*\*synthetic\*\* dashboard\.[\s\S]*3\. {2}Open the \*\*synthetic\*\* dashboard\./);
  await step(page, 3).hover();
  await gutter(3).locator('.block-gutter-handle').click();
  await page.getByRole('menu', { name: 'Step actions' }).getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.block-step')).toHaveCount(3);

  // "+" inserts a step below and opens the "/" menu in it.
  await step(page, 1).hover();
  await gutter(1).locator('.block-gutter-add').click();
  await expect(page.locator('.block-slash-menu.is-inline')).toBeVisible();
  await expect(step(page, 2)).toBeFocused();
});

test.describe('on a touch phone', () => {
  test.use({ viewport: MOBILE, hasTouch: true, isMobile: true });

  test('the gutter appears above the block being edited and a tap opens its menu', async ({ page }) => {
    await openDoc(page, SOP_PATH, 'Synthetic Notion SOP', MOBILE);
    const gutter = page.locator('.block-step[data-step-id="2"] > .block-gutter');
    await expect(gutter).toHaveCSS('opacity', '0');
    await step(page, 2).tap();
    await expect(gutter).toHaveCSS('opacity', '1');
    const box = await gutter.boundingBox();
    const blockBox = await page.locator('.block-step[data-step-id="2"]').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(blockBox.y + 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
    await capture(page, 'gutter-mobile');
    await gutter.locator('.block-gutter-handle').tap();
    await expect(page.getByRole('menu', { name: 'Step actions' })).toBeVisible();
    await capture(page, 'gutter-mobile-menu');
  });
});

test('selecting text shows a formatting toolbar; Cmd/Ctrl+B and K format too', async ({ page }) => {
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  const toolbar = page.getByRole('toolbar', { name: 'Format text' });
  await expect(toolbar).toBeHidden();
  // Select "file" in step 2 by double-clicking it.
  await step(page, 2).getByText('Upload the synthetic file.').dblclick({ position: { x: 150, y: 8 } });
  await expect(toolbar).toBeVisible();
  await capture(page, 'selection-toolbar');
  const selected = await page.evaluate(() => getSelection().toString().trim());
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  const bolded = 'Upload the synthetic file.'.replace(selected, `**${selected}**`)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(draft(page)).toHaveValue(new RegExp(`2\\. {2}${bolded}`));
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');

  // Cmd/Ctrl+K links the selection through a small inline field.
  await step(page, 3).getByText('Check the synthetic result.').dblclick({ position: { x: 10, y: 8 } });
  await page.keyboard.press('ControlOrMeta+k');
  const field = page.getByRole('dialog', { name: 'Paste a link' }).locator('input');
  await expect(field).toBeFocused();
  await field.fill('https://example.test/result');
  await field.press('Enter');
  await expect(draft(page)).toHaveValue(/3\. {2}\[Check\]\(https:\/\/example\.test\/result\) the synthetic result\./);
  // Typing **…** formats as you type and stays markdown.
  await step(page, 3).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then **save** it.');
  await expect(step(page, 3).locator('strong')).toHaveText('save');
  await expect(draft(page)).toHaveValue(/the synthetic result\. Then \*\*save\*\* it\./);
});

// A synthetic 1×1 PNG, public-safe.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function pasteInto(locator, { text = '', imageBase64 = '' } = {}) {
  await locator.evaluate((node, payload) => {
    const data = new DataTransfer();
    if (payload.text) data.setData('text/plain', payload.text);
    if (payload.imageBase64) {
      const bytes = Uint8Array.from(atob(payload.imageBase64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    }
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { text, imageBase64 });
}

test('paste: video links embed, markdown becomes blocks, a link over text links it, images upload', async ({ page }) => {
  await openDoc(page, PLAIN_PATH, 'Synthetic Notion Page');
  const view = page.locator('#rendered-view');
  const last = view.locator('.notion-text-content').last();
  await last.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await pasteInto(view.locator('.notion-text-content').last(), { text: 'https://www.youtube.com/watch?v=synthetic1' });
  await expect(view.locator('[data-block-type="embed"] iframe')).toHaveAttribute('src', 'https://www.youtube.com/embed/synthetic1');
  await expect(draft(page)).toHaveValue(/Last paragraph\.\n\nhttps:\/\/www\.youtube\.com\/watch\?v=synthetic1$/);

  // The caret is in the empty block after the embed: paste markdown there.
  await pasteInto(view.locator('.notion-text-content').last(), { text: '## Pasted heading\n\n- alpha\n- beta' });
  await expect(view.locator('[data-block-type="h2"]').last()).toHaveText(/Pasted heading/);
  await expect(draft(page)).toHaveValue(/synthetic1\n\n## Pasted heading\n\n- alpha\n- beta$/);

  // A URL pasted over selected text links the text.
  const first = view.locator('.notion-text-content').first();
  await first.getByText('First paragraph of the page.').dblclick({ position: { x: 4, y: 8 } });
  await pasteInto(first, { text: 'https://example.test/first' });
  await expect(first.locator('a')).toHaveAttribute('href', 'https://example.test/first');
  await expect(draft(page)).toHaveValue(/\[First\]\(https:\/\/example\.test\/first\) paragraph of the page\./);
  await capture(page, 'paste-plain');

  // An image pasted into a step uploads as its screenshot.
  await openDoc(page, SOP_PATH, 'Synthetic Notion SOP');
  await step(page, 2).click();
  await pasteInto(step(page, 2), { imageBase64: PIXEL_PNG });
  await expect(page.locator('.block-step[data-step-id="2"] .block-screenshot img')).toHaveCount(1, { timeout: 15_000 });
  await expect(draft(page)).toHaveValue(
    /2\. {2}Upload the synthetic file\.\n\n {4}<!-- sop-screenshot-start -->\n {4}!\[\]\(content\/images\/[^)]+\.png\)\n {4}<!-- sop-screenshot-end -->\n<!-- sop-step-end -->/,
  );
});
