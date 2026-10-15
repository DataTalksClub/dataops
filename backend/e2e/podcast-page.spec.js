// Podcast: the episode register as a dakit list–detail split. The list opens
// on what's in flight, a row opens /podcast/<id> in place, the detail link
// survives a reload, and Create card makes the episode's Card from the
// podcast Template and links it. A phone shows one pane with Back.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
// Set PODCAST_SCREENSHOTS=<dir> to also capture the page in both themes.
const SHOTS = process.env.PODCAST_SCREENSHOTS || '';
let server;
const episodes = {};

// The tests share one seeded register and build on each other's writes, so
// a retry reruns the group from a fresh server.
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

function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot('podcast-page'),
      E2E_SEED_PODCAST_TEMPLATE: '1',
    },
  });
  const fixtures = [
    ['next', { season: 25, episode: 4, title: 'Shipping models on a budget', guests: [{ name: 'Ada Example' }], status: 'booked', recordingDate: isoDate(5) }],
    ['edited', {
      season: 25, episode: 3, title: 'Data contracts in practice', guests: [{ name: 'Bo Placeholder' }], status: 'edited',
      recordingDate: isoDate(-12), releaseDate: isoDate(9), notes: 'Synthetic note: trim the intro.',
    }],
    ['later', { season: 25, episode: 5, title: 'Feature stores revisited', guests: [{ name: 'Cy Sample' }, { name: 'Di Mock' }], status: 'booked', recordingDate: isoDate(19) }],
    ['published', {
      season: 25, episode: 2, title: 'From notebook to service', guests: [{ name: 'Eve Fixture' }], status: 'published',
      recordingDate: isoDate(-60), releaseDate: isoDate(-30),
      publication: { spotify: { publicVerifiedAt: new Date(Date.now() - 29 * 86400000).toISOString(), episodeUrl: 'https://open.spotify.com/episode/synthetic1' } },
      links: {
        youtube: 'https://www.youtube.com/watch?v=synthetic1',
        spotify: 'https://open.spotify.com/episode/synthetic1',
        apple: 'https://podcasts.apple.com/podcast/synthetic1',
        website: 'https://datatalks.example/podcast/s25e2',
      },
    }],
    ['older', { season: 24, episode: 9, title: 'Hiring your first data engineer', guests: [{ name: 'Fay Dummy' }], status: 'published', releaseDate: isoDate(-200), publication: { spotify: { publicVerifiedAt: new Date(Date.now() - 199 * 86400000).toISOString(), episodeUrl: 'https://open.spotify.com/episode/synthetic0' } } }],
  ];
  for (const [key, body] of fixtures) episodes[key] = await api('POST', '/api/podcast-episodes', body);
});

test.afterAll(async () => stopOwnedTestServer(server));

async function shoot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: path.join(SHOTS, `podcast-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

test('podcast list opens an episode in place, deep-links it, and creates its card', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/podcast`);
  await expect(page.getByRole('heading', { level: 1, name: 'Podcast' })).toBeVisible();
  await expect(page.locator('#podcast-nav-button')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.dk-stat-strip')).toHaveCount(0);
  const rows = page.locator('.podcast-list .dk-split__item');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('S25E4');
  await expect(rows.first()).toContainText('Ada Example — Shipping models on a budget');
  await expect(rows.nth(1)).toContainText('S25E3');

  await page.getByRole('radio', { name: 'All' }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.locator('.podcast-group__label')).toHaveText(['Upcoming', 'Season 25', 'Season 24']);
  await page.getByRole('searchbox', { name: 'Search episodes by guest or title' }).fill('eve');
  await expect(rows).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search episodes by guest or title' }).fill('');
  await shoot(page, 'list');

  await page.locator(`[data-episode-id="${episodes.published.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/podcast/${episodes.published.id}$`));
  const detail = page.getByRole('region', { name: 'Selected episode' });
  await expect(detail.locator('.dk-split__title')).toHaveText('From notebook to service');
  await expect(detail.locator('.podcast-link')).toHaveText(['YouTube', 'Spotify', 'Apple Podcasts', 'Website']);
  await shoot(page, 'detail-links');

  await page.locator(`[data-episode-id="${episodes.next.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/podcast/${episodes.next.id}$`));
  await page.reload();
  await expect(detail.locator('.dk-split__title')).toHaveText('Shipping models on a budget');
  await expect(page.locator(`[data-episode-id="${episodes.next.id}"]`)).toHaveAttribute('aria-current', 'true');
  await shoot(page, 'detail');

  await detail.getByRole('button', { name: 'Create card' }).click();
  const chip = detail.locator('.podcast-card-chip');
  await expect(chip).toContainText('Shipping models on a budget');
  await expect(chip).toContainText('Preparation');
  await expect(chip).toContainText('3/3');
  await shoot(page, 'detail-card');
  const linked = await api('GET', `/api/podcast-episodes/${episodes.next.id}`);
  expect(linked.card.id).toBeTruthy();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/cards\\?cardId=${linked.card.id}$`));
  await page.goBack();
  await expect(detail.locator('.podcast-card-chip')).toBeVisible();

  await detail.getByRole('button', { name: 'Mark recorded' }).click();
  await expect(detail.locator('.podcast-status')).toHaveText('Recorded');
  expect((await api('GET', `/api/podcast-episodes/${episodes.next.id}`)).status).toBe('recorded');
});

test('an edit made elsewhere is a conflict that keeps the typed values', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/podcast/${episodes.later.id}`);
  const detail = page.getByRole('region', { name: 'Selected episode' });
  await detail.getByRole('button', { name: 'Edit' }).click();
  await detail.getByLabel('Notes').fill('Typed before the conflict');
  const current = await api('GET', `/api/podcast-episodes/${episodes.later.id}`);
  await api('PUT', `/api/podcast-episodes/${episodes.later.id}`, { version: current.version, title: 'Renamed elsewhere' });
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('.podcast-message')).toContainText('changed since you opened it');
  await expect(detail.getByLabel('Notes')).toHaveValue('Typed before the conflict');
  await detail.getByRole('button', { name: 'Reload episode' }).click();
  await expect(detail.locator('.dk-split__title')).toHaveText('Renamed elsewhere');
});

test('New episode loads before it opens and lands on the created episode', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/podcast`);
  await expect(page.locator('.podcast-list .dk-split__item').first()).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New episode' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Season')).toHaveValue('25');
  await expect(dialog.getByLabel('Episode')).toHaveValue('6');
  await dialog.getByLabel('Guests').fill('Gil Synthetic');
  await dialog.getByLabel('Title', { exact: true }).fill('Synthetic created episode');
  await dialog.getByRole('button', { name: 'Create episode' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/podcast\/[^/]+$/);
  await expect(page.getByRole('region', { name: 'Selected episode' }).locator('.dk-split__title')).toHaveText('Synthetic created episode');
});

test('a phone shows the list, then the deep-linked episode with Back', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/podcast`);
  const list = page.locator('.dk-split__list');
  const detail = page.locator('.dk-split__detail');
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shoot(page, 'mobile-list');

  await page.goto(`${server.baseURL}/podcast/${episodes.edited.id}`);
  await expect(detail).toBeVisible();
  await expect(list).toBeHidden();
  await expect(detail.locator('.dk-split__title')).toHaveText('Data contracts in practice');
  await shoot(page, 'mobile-detail');
  const back = page.getByRole('button', { name: 'Back to Episodes' });
  await expect.poll(async () => (await back.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
  await back.click();
  await expect(page).toHaveURL(/\/podcast$/);
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
});

test('schedule shows not-recorded without evidence, keeps plan apart from evidence, and gates release and status', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const gated = await api('POST', '/api/podcast-episodes', {
    season: 26, episode: 1, title: 'Synthetic gated episode', guests: [{ name: 'Gil Gate' }],
    status: 'edited', recordingDate: isoDate(-20), releaseDate: isoDate(5),
  });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/podcast`);
  await page.getByRole('link', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(/\/podcast\/schedule$/);
  const row = page.locator(`.podcast-schedule__row[data-episode-id="${gated.id}"]`);
  // A plan alone claims nothing external.
  await expect(row.locator('[data-track="spotify"]')).toHaveText('Not recorded');
  await expect(row.locator('[data-track="transcript"]')).toHaveText('Not recorded');
  await expect(row.locator('[data-track="website"]')).toHaveText('Not recorded');
  await expect(row.locator('.podcast-schedule__evidence')).toHaveCount(0);
  const verified = page.locator(`.podcast-schedule__row[data-episode-id="${episodes.older.id}"]`);
  await expect(verified.locator('[data-track="spotify"]')).toHaveText('Public on Spotify');
  await expect(verified.locator('[data-track="website"]')).toHaveText('Not recorded');
  await shoot(page, 'schedule');

  await row.locator('.podcast-schedule__episode').click();
  const detail = page.getByRole('region', { name: 'Selected episode' });
  await expect(detail.locator('.podcast-blockers')).toContainText('Scheduled audio does not count');
  await expect(detail.getByRole('button', { name: 'Mark scheduled' })).toBeDisabled();

  // Record Spotify scheduling evidence: the intended date stays untouched.
  await detail.getByRole('button', { name: 'Edit' }).click();
  await detail.getByLabel('Timezone').fill('Asia/Tokyo');
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 11) + '09:30';
  await detail.getByLabel('Spotify scheduled for').fill(future);
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[data-track="spotify"]')).toHaveText('Scheduled in Spotify');
  await expect(detail.getByRole('button', { name: 'Mark scheduled' })).toBeEnabled();
  expect((await api('GET', `/api/podcast-episodes/${gated.id}`)).releaseDate).toBe(isoDate(5));

  // Transcript review needs proof.
  await detail.getByRole('button', { name: 'Edit' }).click();
  await detail.getByLabel('Transcript reviewed').check();
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[role="alert"]')).toContainText('proof');
  await detail.getByLabel('Transcript review proof link').fill('https://example.com/synthetic-review');
  await detail.getByLabel('Website release link').fill('https://datatalks.example/podcast/synthetic-gated');
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[role="alert"]')).toContainText('Verified public Spotify');

  await detail.getByLabel('Website release link').fill('');
  await detail.getByLabel('Website already live (historical)').fill('https://datatalks.example/podcast/synthetic-gated');
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[data-track="website"]')).toHaveText('Seen live (historical)');
  await expect(detail.locator('.podcast-historical')).toContainText('does not authorise');
  await expect(detail.locator('[data-track="transcript"]')).toHaveText('Reviewed');

  await detail.getByRole('button', { name: 'Edit' }).click();
  await detail.getByLabel('I played the public Spotify episode and it works').check();
  await detail.getByLabel('Public Spotify episode link').fill('https://open.spotify.com/episode/syntheticgated');
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[data-track="spotify"]')).toHaveText('Public on Spotify');
  await expect(detail.locator('[data-track="website"]')).toHaveText('Seen live (historical)');

  await detail.getByRole('button', { name: 'Edit' }).click();
  await detail.getByLabel('Website release link').fill('https://datatalks.example/podcast/synthetic-gated');
  await detail.getByRole('button', { name: 'Save episode' }).click();
  await expect(detail.locator('[data-track="website"]')).toHaveText('Released');
  const saved = await api('GET', `/api/podcast-episodes/${gated.id}`);
  expect(saved.readiness.website).toBe('released');
  expect(saved.publication.websiteObserved.proofUrl).toContain('synthetic-gated');
});
