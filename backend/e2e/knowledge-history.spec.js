const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
const screenshots = path.resolve(__dirname, '../../.tmp/screenshots/knowledge-history');
const docPath = 'content/testing/history.md';
const oldContent = '# Synthetic history\n\nOriginal text.\n';
const currentContent = '# Synthetic history\n\nCurrent text.\n';
const signedBytes = Buffer.alloc(4_562_991, 7);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let server;
let signedDownloadServer;
let signedDownloadUrl;
test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  signedDownloadServer = http.createServer((req, res) => {
    if (req.url !== '/version.png?signature=fixture') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="synthetic.png"' });
    res.end(signedBytes);
  });
  await new Promise((resolve) => signedDownloadServer.listen(0, '127.0.0.1', resolve));
  signedDownloadUrl = `http://127.0.0.1:${signedDownloadServer.address().port}/version.png?signature=fixture`;
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('knowledge-history') } });
});
test.afterAll(async () => {
  await stopOwnedTestServer(server);
  await new Promise((resolve) => signedDownloadServer?.close(resolve));
});

async function fixtures(page, conflict = false) {
  page.on("pageerror", (error) => console.error("BROWSER ERROR", error.message));
  await setupPageWithAuth(page);
  const state = { revision: 'r1', content: currentContent, saves: [], restores: [], authenticatedDownloads: 0 };
  await page.route('**/docs**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname !== '/docs') return route.fulfill({ json: {} });
    if (req.method() === 'PUT') {
      state.saves.push(req.postDataJSON());
      if (conflict) {
        state.revision = 'r2'; state.content = '# Synthetic history\n\nAnother editor saved this.\n';
        return route.fulfill({ status: 409, json: { error: 'A newer save exists' } });
      }
      state.content = req.postDataJSON().content; state.revision = 'r2';
      return route.fulfill({ json: { updated: 2, revision: state.revision } });
    }
    if (url.searchParams.has('path')) return route.fulfill({ json: {
      path: url.searchParams.get('path'), content: state.content, revision: state.revision, updated: 1,
      parsed: { frontmatter: { title: 'Synthetic history' }, sections: [] },
    } });
    return route.fulfill({ json: { documents: [{ path: docPath, title: 'Synthetic history', doc_type: 'reference', systems: [], tags: [] }] } });
  });
  await page.route('**/parse', (route) => route.fulfill({ json: { parsed: { frontmatter: { title: 'Synthetic history' }, sections: [] } } }));
  await page.route(/\/knowledge\/(publication|status|history|version|restore|download)(\?|$)/, async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/knowledge/publication') return route.fulfill({ json: { revision: state.revision } });
    if (url.pathname === '/knowledge/status') return route.fulfill({ json: {
      revision: state.revision, exported: { revision: 'r0', at: '2026-10-01T12:00:00Z' }, exportLag: true,
    } });
    if (url.pathname === '/knowledge/history') {
      const binary = url.searchParams.get('path').endsWith('.png');
      const deleted = url.searchParams.get('path').includes('deleted');
      return route.fulfill({ json: { versions: [
        { revision: 'r1', actor: 'Grace', time: '2026-10-02T10:00:00Z', message: 'Update fixture', operation: deleted ? 'delete' : 'edit', deleted, binary },
        { revision: 'r0', actor: 'Alexey', time: '2026-10-01T10:00:00Z', message: 'Create fixture', operation: 'create', binary },
      ], cursor: null } });
    }
    if (url.pathname === '/knowledge/download') {
      expect(url.searchParams.has('token')).toBe(false);
      expect(req.headers().authorization).toBe('Bearer e2e-bypass-token');
      state.authenticatedDownloads++;
      return route.fulfill({ json: { url: signedDownloadUrl, expiresIn: 300 } });
    }
    if (url.pathname === '/knowledge/version') {
      expect(req.headers().authorization).toBe('Bearer e2e-bypass-token');
      const binary = url.searchParams.get('path').endsWith('.png');
      if (url.searchParams.get('path').includes('deleted') && url.searchParams.get('revision') === 'r1') {
        return route.fulfill({ status: 404, json: { error: 'File deleted' } });
      }
      return route.fulfill({ contentType: 'application/octet-stream', body: binary
        ? Buffer.from([137, 80, 78, 71]) : url.searchParams.get('revision') === 'r0' ? oldContent : state.content });
    }
    if (url.pathname === '/knowledge/restore') {
      state.restores.push(req.postDataJSON()); state.content = oldContent; state.revision = 'r2';
      return route.fulfill({ json: { revision: state.revision } });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return state;
}
async function openDoc(page) {
  await page.goto(`${server.baseURL}/testing/history.md`);
  await expect(page.locator('#document-path')).toHaveText(docPath);
  await expect(page.locator('#editor')).toBeEnabled();
}
test('file history compares and restores a version with actor metadata', async ({ page }) => {
  const state = await fixtures(page); await openDoc(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('#history-versions')).toContainText('Grace');
  await expect(page.locator('#history-versions')).toContainText('Alexey');
  await page.getByRole('button', { name: 'Compare version', exact: true }).last().click();
  await expect(page.locator('#history-comparison')).toContainText('Original text.');
  await expect(page.locator('#history-comparison')).toContainText('Current text.');
  await page.screenshot({ path: path.join(screenshots, 'history-compare.png') });
  await page.getByRole('button', { name: 'Restore version', exact: true }).last().click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#history-modal')).toBeHidden();
  expect(state.restores).toEqual([{ version: 'r0', expectedRevision: 'r1' }]);
  await expect(page.locator('#editor')).toHaveValue(oldContent);
  await page.screenshot({ path: path.join(screenshots, 'history-restored.png') });
});
test('stale save preserves draft across reload with its original revision', async ({ page }) => {
  const state = await fixtures(page, true); await openDoc(page);
  await page.locator('.block-title').click();
  await page.locator('.block-title-editor').fill('My unsaved work.');
  await page.locator('.block-title-editor').press('Enter');
  await page.locator('#editor-save-button').click();
  await expect(page.locator('#editor-inline-status')).toContainText('Your unsaved draft is preserved');
  await expect(page.locator('#editor')).toHaveValue(/My unsaved work\./);
  await page.screenshot({ path: path.join(screenshots, 'draft-conflict.png') });
  await page.getByRole('button', { name: 'Reload saved file', exact: true }).click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#editor')).toHaveValue(state.content);
  expect(await page.evaluate((key) => localStorage.getItem(key), `dtc-doc-draft:${docPath}`)).toContain('My unsaved work.');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue(/My unsaved work\./);
  await page.locator('#editor-save-button').click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves.map((save) => save.expectedRevision)).toEqual(['r1', 'r1']);
});
test('binary history downloads authenticated bytes without a text comparison', async ({ page }) => {
  const state = await fixtures(page); await openDoc(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('#history-path').fill('content/images/synthetic.png');
  await page.getByRole('button', { name: 'Load history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download version', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Compare version', exact: true })).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download version', exact: true }).first().click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('synthetic.png');
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.length).toBe(4_562_991);
  expect(digest(bytes)).toBe(digest(signedBytes));
  expect(state.authenticatedDownloads).toBe(1);
  await page.screenshot({ path: path.join(screenshots, 'binary-history.png') });
});


test('deleted-file history compares and explicitly recovers an older version', async ({ page }) => {
  const state = await fixtures(page); await openDoc(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('#history-path').fill('content/testing/deleted.md');
  await page.getByRole('button', { name: 'Load history', exact: true }).click();
  await expect(page.locator('#history-versions')).toContainText('delete · deleted');
  await expect(page.getByRole('button', { name: 'Restore version', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Compare version', exact: true }).click();
  await expect(page.locator('#history-comparison')).toContainText('File is deleted in the current publication.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'deleted-history-mobile.png') });
  await page.getByRole('button', { name: 'Restore version', exact: true }).click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#history-modal')).toBeHidden();
  await expect(page.locator('#document-path')).toHaveText('content/testing/deleted.md');
  expect(state.restores).toEqual([{ version: 'r0', expectedRevision: 'r1' }]);
});
