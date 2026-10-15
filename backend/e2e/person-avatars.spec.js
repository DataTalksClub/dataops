// Teammate avatars show the Google photo stored at SSO sign-in, through one
// shared renderer, and fall back to initials when there is no photo or it
// fails to load. The photo URLs are stubs: the browser never reaches Google.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const GRACE = '00000000-0000-0000-0000-000000000001';
const VALERIIA = '00000000-0000-0000-0000-000000000002';
const ALEXEY = '00000000-0000-0000-0000-000000000003';
const PHOTO = 'https://lh3.googleusercontent.com/a/e2e-grace-stub=s96-c';
const BROKEN = 'https://lh3.googleusercontent.com/a/e2e-broken-stub=s96-c';
const STUB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2b7a6f"/><circle cx="32" cy="26" r="12" fill="#f4d9b8"/><rect x="14" y="42" width="36" height="22" rx="11" fill="#f4d9b8"/></svg>';

let server;
const titles = {
  [GRACE]: 'Avatar stub task for Grace',
  [VALERIIA]: 'Avatar stub task for Valeriia',
  [ALEXEY]: 'Avatar stub task for Alexey',
};

test.describe.configure({ mode: 'serial' });

async function api(method, route, body) {
  const response = await fetch(`${server.baseURL}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.ok, `${method} ${route} ${response.status}`).toBeTruthy();
  return response.status === 204 ? null : response.json();
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('person-avatars') } });
  const today = new Date().toISOString().slice(0, 10);
  for (const [assigneeId, description] of Object.entries(titles)) {
    await api('POST', '/api/tasks', { description, date: today, assigneeId });
  }
});

test.afterAll(async () => stopOwnedTestServer(server));

// Users carry `picture` only once they sign in through SSO, which this server
// cannot do; give Grace a working photo and Valeriia a broken one, and serve
// the photo host locally, recording what the browser sent.
async function stubPhotos(page) {
  const photoRequests = [];
  await page.route('**/api/users', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const user of body.users) {
      if (user.id === GRACE) user.picture = PHOTO;
      if (user.id === VALERIIA) user.picture = BROKEN;
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('https://lh3.googleusercontent.com/**', async (route) => {
    photoRequests.push({ url: route.request().url(), referer: await route.request().headerValue('referer') });
    if (route.request().url().includes('broken')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: STUB_SVG });
  });
  return photoRequests;
}

function ownerCell(page, assigneeId) {
  return page.locator('.ops-queue-row', { hasText: titles[assigneeId] }).locator('.ops-queue-owner');
}

test('the queue WHO column shows the photo, or the initials when there is none or it fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const photoRequests = await stubPhotos(page);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks?assignee=all`);

  const grace = ownerCell(page, GRACE);
  await expect(grace).toBeVisible({ timeout: 20000 });
  await expect(grace).toHaveAttribute('aria-label', 'Assigned to Grace');
  const photo = grace.locator('.dk-avatar img');
  await expect(photo).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/e2e-grace-stub=s64-c');
  await expect(photo).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => photo.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(grace.locator('.dk-avatar')).toHaveAttribute('data-avatar-photo', 'shown');

  const valeriia = ownerCell(page, VALERIIA).locator('.dk-avatar');
  await expect(valeriia).toHaveAttribute('data-avatar-photo', 'failed');
  await expect(valeriia.locator('img')).toHaveCount(0);
  await expect(valeriia).toHaveText('V');

  const alexey = ownerCell(page, ALEXEY).locator('.dk-avatar');
  await expect(alexey).toHaveText('A');
  await expect(alexey.locator('img')).toHaveCount(0);

  expect(photoRequests.length).toBeGreaterThan(0);
  for (const request of photoRequests) {
    expect(request.url).toMatch(/=s64-c$/);
    expect(request.referer).toBeFalsy();
  }
  if (process.env.AVATAR_SHOT) {
    await page.locator('.ops-queue-row', { hasText: 'Avatar stub task' }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.AVATAR_SHOT}/queue.png` });
  }
});

test('the Users page and the account menu use the same avatar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubPhotos(page);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/users`);

  const graceRow = page.locator('.ops-user-row', { hasText: 'grace@datatalks.club' });
  await expect(graceRow).toBeVisible({ timeout: 20000 });
  await expect(graceRow.locator('.dk-avatar img')).toHaveAttribute('src', /=s64-c$/);
  const valeriiaRow = page.locator('.ops-user-row', { hasText: 'valeriia@datatalks.club' });
  await expect(valeriiaRow.locator('.dk-avatar')).toHaveAttribute('data-avatar-photo', 'failed');
  await expect(valeriiaRow.locator('.dk-avatar')).toHaveText('V');

  const trigger = page.locator('#settings-button [data-account-menu-avatar]');
  await expect(trigger).not.toHaveText('?');
  if (process.env.AVATAR_SHOT) await page.screenshot({ path: `${process.env.AVATAR_SHOT}/users.png` });
});
