// Card links render as a dense list: a readable link per row, the text input
// only while editing, and a mailto: address counted as present.
const { test, expect } = require('@playwright/test');

async function json(response, status = 200) {
  expect(response.status()).toBe(status);
  return response.json();
}

async function createLinkedCard(request) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { card } = await json(await request.post('/api/cards', {
    data: {
      title: `Synthetic links card ${unique}`,
      anchorDate: '2026-10-20',
      stage: 'announced',
      cardLinks: [
        { name: 'Meetup', url: '' },
        { name: 'Guest email', url: 'mailto:guest@example.com' },
        { name: 'Podcast document', url: 'https://docs.google.com/document/d/synthetic123/edit' },
      ],
    },
  }), 201);
  return card;
}

test.describe('Card links', () => {
  test('show filled links first, count mailto as present, and edit one row at a time', async ({ page, request }) => {
    const card = await createLinkedCard(request);
    await page.goto(`/cards?cardId=${card.id}`);
    const section = page.locator('#card-panel .workflow-links-section');
    await expect(section).toBeVisible();
    await expect(section.locator('.link-row__label')).toHaveText(['Guest email', 'Podcast document', 'Meetup']);
    await expect(section.locator('.workflow-links-missing')).toHaveText('1 missing');
    await expect(section.locator('input')).toHaveCount(0);

    const email = section.locator('.link-row', { hasText: 'Guest email' });
    await expect(email).not.toHaveClass(/is-missing/);
    await expect(email.locator('.link-row__link')).toHaveAttribute('href', 'mailto:guest@example.com');
    await expect(email.getByRole('button', { name: 'Copy Guest email address' })).toBeVisible();

    const doc = section.locator('.link-row', { hasText: 'Podcast document' });
    const docLink = doc.locator('.link-row__link');
    await expect(docLink).toContainText('docs.google.com/…/edit');
    await expect(docLink).toHaveAttribute('target', '_blank');
    await expect(docLink).toHaveAttribute('title', 'https://docs.google.com/document/d/synthetic123/edit');

    // Escape leaves without saving and returns focus to the row's button.
    await doc.getByRole('button', { name: 'Edit Podcast document' }).click();
    const docInput = doc.getByRole('textbox', { name: 'Podcast document link' });
    await expect(docInput).toBeFocused();
    await docInput.fill('https://example.invalid/not-saved');
    await docInput.press('Escape');
    await expect(doc.locator('input')).toHaveCount(0);
    await expect(doc.getByRole('button', { name: 'Edit Podcast document' })).toBeFocused();

    // Keyboard-only add: Add, type, Enter.
    const meetup = section.locator('.link-row', { hasText: 'Meetup' });
    await meetup.getByRole('button', { name: 'Add Meetup' }).focus();
    await page.keyboard.press('Enter');
    const input = section.getByRole('textbox', { name: 'Meetup link' });
    await expect(input).toBeFocused();
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/cards/${card.id}`);
    await input.fill('https://www.meetup.com/synthetic/events/314993406/');
    await input.press('Enter');
    expect((await saved).status()).toBe(200);
    const meetupLink = section.locator('.link-row', { hasText: 'Meetup' }).locator('.link-row__link');
    await expect(meetupLink).toContainText('meetup.com/…/314993406');
    await expect(section.locator('.workflow-links-missing')).toHaveCount(0);
    const stored = (await json(await request.get(`/api/cards/${card.id}`))).card;
    expect(stored.cardLinks.find((link) => link.name === 'Meetup').url)
      .toBe('https://www.meetup.com/synthetic/events/314993406/');
    expect(stored.cardLinks.find((link) => link.name === 'Guest email').url).toBe('mailto:guest@example.com');
  });

  test('fit a phone: no sideways scroll and 40px tap targets', async ({ page, request }) => {
    const card = await createLinkedCard(request);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/cards?cardId=${card.id}`);
    const section = page.locator('#card-panel .workflow-links-section');
    await expect(section.locator('.link-row')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    for (const control of await section.locator('a, button').all()) {
      const box = await control.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });
});
