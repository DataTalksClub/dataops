const { test, expect } = require('@playwright/test');
async function cardFor(request, type) {
  const template = await request.post('/__e2e__/template-fixtures', { data: {
    name: `Synthetic ${type} documents ${Date.now()}`, type,
    sourcePath: `workflow-templates/synthetic-${type}.yaml`, taskDefinitions: [],
  } });
  expect(template.status()).toBe(201);
  const response = await request.post('/api/cards', { data: {
    title: `Synthetic ${type} staff workspace`, anchorDate: '2026-10-29', templateId: (await template.json()).template.id,
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).card;
}
for (const type of ['webinar', 'workshop', 'q-and-a']) {
  test(`${type} card has an editable staff-only document workspace`, async ({ page, request }) => {
    const card = await cardFor(request, type);
    await page.goto(`/cards?cardId=${card.id}`);
    const workspace = page.getByRole('region', { name: 'Staff-only card documents', exact: true });
    await expect(workspace).toBeVisible();
    await expect(workspace.getByText('Only signed-in staff can open these documents. Guest codes do not grant access.', { exact: true })).toBeVisible();
    await workspace.getByRole('combobox', { name: 'Document kind' }).selectOption('note');
    await workspace.getByRole('textbox', { name: 'New document title' }).fill('Private host plan');
    await workspace.getByRole('button', { name: 'Create document', exact: true }).click();
    const content = 'Private café — こんにちは\n<script>window.privateDocumentExecuted=true</script>';
    await workspace.getByRole('textbox', { name: 'Document content', exact: true }).fill(content);
    await workspace.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(workspace.getByText('Saved.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.privateDocumentExecuted)).toBeUndefined();
    await page.reload();
    await workspace.getByText('Private host plan · note', { exact: true }).click();
    await expect(workspace.getByRole('textbox', { name: 'Document content', exact: true })).toHaveValue(content);
    await expect(workspace.getByText('Guest review and comments', { exact: true })).toHaveCount(0);
    for (const format of ['TXT', 'DOCX']) {
      const downloaded = page.waitForEvent('download');
      await workspace.getByRole('button', { name: `Export ${format}`, exact: true }).click();
      expect((await downloaded).suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
    }
    page.once('dialog', dialog => dialog.accept());
    await workspace.getByRole('button', { name: 'Delete document', exact: true }).click();
    await expect(workspace.getByText('No documents yet.', { exact: false })).toBeVisible();
  });
}
test('newer edits survive refresh while an earlier card document save is pending', async ({ page, request }) => {
  const card = await cardFor(request, 'webinar');
  const created = await request.post('/api/card-documents', { data: { cardId: card.id, kind: 'note', title: 'Private plan', content: 'Original' } });
  const doc = (await created.json()).document;
  await page.goto(`/cards?cardId=${card.id}`);
  const workspace = page.getByRole('region', { name: 'Staff-only card documents', exact: true });
  await workspace.getByText('Private plan · note', { exact: true }).click();
  const text = workspace.getByRole('textbox', { name: 'Document content', exact: true });
  await text.fill('Submitted text A');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  await page.route(`**/api/card-documents/${doc.id}`, async route => {
    if (route.request().method() === 'PUT') { signalStarted(); await held; }
    await route.continue();
  });
  try {
    await workspace.getByRole('button', { name: 'Save document', exact: true }).click();
    await started;
    await text.fill('Newer unsaved text B');
    await workspace.getByRole('button', { name: 'Refresh documents', exact: true }).click();
    await expect(text).toHaveValue('Newer unsaved text B');
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/card-documents/${doc.id}`) && response.request().method() === 'PUT');
    release();
    expect((await saved).status()).toBe(200);
    await page.unroute(`**/api/card-documents/${doc.id}`);
    await workspace.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(workspace.getByText('Saved.', { exact: true })).toBeVisible();
    expect((await (await request.get(`/api/card-documents/${doc.id}`)).json()).document.content).toBe('Newer unsaved text B');
  } finally { release(); }
});
