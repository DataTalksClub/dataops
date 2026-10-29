const { test, expect } = require('@playwright/test');

test('task document editing, exports and scoped guest review work together', async ({ page, request, browser }) => {
  const taskResponse = await request.post('/api/tasks', { data: { description: `Synthetic document workspace ${Date.now()}`, date: '2026-10-29' } });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();
  await page.goto(`/tasks?taskId=${task.id}`);
  const workspace = page.getByRole('region', { name: 'Task documents', exact: true });
  await workspace.getByRole('textbox', { name: 'New document title' }).fill('Transcript for guest review');
  await workspace.getByRole('button', { name: 'Create document', exact: true }).click();
  const content = '00:00 Welcome\n00:15 café — こんにちは\n<script>window.transcriptExecuted=true</script>\n\nA summary.';
  await workspace.getByRole('textbox', { name: 'Document content', exact: true }).fill(content);
  await workspace.getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(workspace.getByText('Saved.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.transcriptExecuted)).toBeUndefined();
  for (const format of ['TXT', 'DOCX']) {
    const download = page.waitForEvent('download');
    await workspace.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
  }
  await workspace.getByText('Guest review and comments', { exact: true }).click();
  const reviews = workspace.getByRole('region', { name: 'Document comments and reviewers' });
  await reviews.getByRole('textbox', { name: /reviewer/i }).fill('Synthetic guest');
  await reviews.getByRole('button', { name: /create.*review|invite|share/i }).click();
  const listed = await request.get(`/api/documents?taskId=${task.id}`);
  const doc = (await listed.json()).documents[0];
  const reviewPath = await reviews.getByRole('textbox', { name: 'New review link', exact: true }).inputValue();
  const reviewerResponse = await request.get(`/api/documents/${doc.id}/reviewers`);
  const reviewer = (await reviewerResponse.json()).reviewers.find(item => item.name === 'Synthetic guest');
  const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(reviewPath);
    await expect(guest.getByText(content, { exact: true })).toBeVisible();
    await guest.getByRole('textbox', { name: 'Add comment', exact: true }).fill('Please correct the opening timecode.');
    await guest.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect(guest.getByText('Please correct the opening timecode.', { exact: true })).toBeVisible();
    expect((await request.delete(`/api/documents/${doc.id}/reviewers/${reviewer.id}`)).status()).toBe(200);
    await guest.reload();
    await expect(guest.getByText(/invalid, expired or revoked/)).toBeVisible();
  } finally { await guestContext.close(); }
});
