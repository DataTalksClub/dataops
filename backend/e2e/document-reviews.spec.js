const { test, expect } = require('@playwright/test');

test('reviewer can discuss one document and loses access when revoked', async ({ request, browser }) => {
  const taskResponse = await request.post('/api/tasks', { data: { description: 'Synthetic document review browser check', date: '2026-10-29' } });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();
  const docResponse = await request.post('/api/documents', { data: { taskId: task.id, kind: 'transcript', title: 'Synthetic review', content: '00:01 café こんにちは\n<script>window.reviewExecuted=true</script>' } });
  expect(docResponse.status()).toBe(201);
  const { document: doc } = await docResponse.json();
  const invite = await request.post(`/api/documents/${doc.id}/reviewers`, { data: { name: 'Browser reviewer' } });
  expect(invite.status()).toBe(201);
  const { reviewPath, reviewer, token } = await invite.json();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto(reviewPath);
    await expect(page.getByRole('heading', { name: 'Synthetic review', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.reviewExecuted)).toBeUndefined();
    expect(page.url()).not.toContain('review=');
    await page.getByRole('textbox', { name: 'Quoted text (optional)', exact: true }).fill('00:01');
    await page.getByRole('textbox', { name: 'Add comment', exact: true }).fill('Please check this time.');
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect(page.getByText('Please check this time.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Checked against the recording.');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByText('Checked against the recording.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Resolved thread' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen thread', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Open thread' })).toBeVisible();
    const comments = await request.get(`/api/documents/${doc.id}/comments`);
    const { threads } = await comments.json();
    expect(threads[0].posts).toHaveLength(2);
    expect(threads[0].posts[0].author.name).toBe('Browser reviewer');
    expect((await request.get('/api/documents/nonexistent/review', { headers: { 'x-document-review-token': token } })).status()).toBe(401);
    expect((await request.delete(`/api/documents/${doc.id}/reviewers/${reviewer.id}`)).status()).toBe(200);
    await page.reload();
    await expect(page.getByText('Review link is invalid, expired or revoked', { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
