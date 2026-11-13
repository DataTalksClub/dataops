const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// t2320u: long URLs and long inline code on the newsletter issue preview must
// wrap inside the card on every tab, and the shareable (code) preview shows
// only the reader-facing issue.

const LONG_URL = `https://courses.datatalks.club/register/production-ai-agents-generative-media/${'a'.repeat(140)}?utm_source=newsletter&utm_medium=email&utm_campaign=${'b'.repeat(80)}`;
const LONG_CODE = `PYTHONPATH=/home/orin/git/dataops-knowledge/tools/${'c'.repeat(120)}/read_course_inventory.py`;
const SCREENSHOTS = process.env.NEWSLETTER_PREVIEW_SCREENSHOT_DIR || '';

let server;
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('newsletter-preview-overflow') },
  });
});

test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

async function expectNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const offenders = [];
    for (const node of document.querySelectorAll('#newsletter-preview-root *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      // Content inside a horizontally scrollable box is allowed to extend past it.
      let clipped = false;
      for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { clipped = true; break; }
      }
      if (!clipped && rect.right > viewport + 1) {
        offenders.push(`${node.tagName.toLowerCase()}.${node.className} right=${Math.round(rect.right)}`);
      }
    }
    const cards = [...document.querySelectorAll('#newsletter-preview-root > .sponsor-doc-card')];
    const cardOverflow = cards
      .filter((card) => card.scrollWidth > card.clientWidth + 1)
      .map((card) => `${card.dataset.previewSection || card.dataset.previewView || 'card'} ${card.scrollWidth}>${card.clientWidth}`);
    return { scrollWidth: doc.scrollWidth, viewport, offenders: offenders.slice(0, 5), cardOverflow };
  });
  expect(metrics.scrollWidth, `${label}: page scrollWidth ${metrics.scrollWidth} > viewport ${metrics.viewport}`).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.offenders, `${label}: elements past the right edge`).toEqual([]);
  expect(metrics.cardOverflow, `${label}: card content wider than card`).toEqual([]);
}

test('newsletter preview wraps long URLs and inline code on every tab; shareable preview shows only the issue', async ({ page, request }) => {
  test.setTimeout(90_000);

  const issueRes = await request.post(`${server.baseURL}/api/newsletter-issues`, {
    data: { kind: 'weekly', publicationDate: '2026-11-16', status: 'planned' },
  });
  expect(issueRes.ok(), await issueRes.text()).toBeTruthy();
  const issue = await issueRes.json();

  const longLine = `Authenticated course inventory ran: \`${LONG_CODE}\` read 24 courses, see ${LONG_URL} and [the register page](${LONG_URL}).`;
  const issueMd = [
    'Subject: Weekly overflow regression',
    '',
    'Preview: Long lines must wrap.',
    '',
    '# Weekly overflow regression',
    '',
    longLine,
    '',
    `- ${longLine}`,
    '',
  ].join('\n');
  const briefMd = `# Brief\n\n- ${longLine}\n`;
  const sourcesMd = `# Sources for the weekly\n\n- INTERNAL-SOURCES-MARKER ${longLine}\n`;

  const putRes = await request.put(`${server.baseURL}/api/newsletter-issues/${issue.id}/markdown`, {
    data: { issue: issueMd, brief: briefMd, sources: sourcesMd },
  });
  expect(putRes.ok(), await putRes.text()).toBeTruthy();
  const saved = await putRes.json();
  expect(saved.accessCode).toBeTruthy();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });

    // Internal (staff) page: all four tabs, each contained.
    await page.setExtraHTTPHeaders({});
    await page.goto(`${server.baseURL}/newsletter-issues/${issue.id}/preview`);
    await expect(page.locator('[data-preview-staff-bar]')).toBeVisible();
    await expect(page.locator('[data-preview-tab]')).toHaveCount(4);
    for (const tab of ['issue', 'brief', 'sources', 'raw']) {
      await page.locator(`[data-preview-tab="${tab}"]`).click();
      if (tab === 'raw') {
        await expect(page.locator('pre.sponsor-doc-export-pre')).toHaveCount(3);
      } else {
        await expect(page.locator(`[data-preview-canvas="${tab}"] code`).first()).toBeVisible();
      }
      await expectNoHorizontalOverflow(page, `staff ${tab} @${width}`);
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/staff-${tab}-${width}.png`, fullPage: true });
    }

    // Shareable link: anonymous viewer with the access code sees only the issue.
    const external = await page.context().browser().newContext({
      viewport: { width, height: 900 },
      extraHTTPHeaders: { 'x-newsletter-preview-anonymous': 'true' },
    });
    const extPage = await external.newPage();
    await extPage.goto(`${server.baseURL}/newsletter-issues/${issue.id}/preview?code=${encodeURIComponent(saved.accessCode)}`);
    await expect(extPage.locator('[data-preview-canvas="issue"]')).toBeVisible();
    await expect(extPage.locator('[data-preview-canvas="issue"] code').first()).toBeVisible();
    await expect(extPage.locator('[data-preview-staff-bar]')).toHaveCount(0);
    await expect(extPage.locator('[data-preview-tab]')).toHaveCount(0);
    await expect(extPage.locator('body')).not.toContainText('INTERNAL-SOURCES-MARKER');
    await expect(extPage.locator('body')).not.toContainText('Sources (sources.md)');
    await expect(extPage.locator('body')).not.toContainText('Raw Markdown');
    await expectNoHorizontalOverflow(extPage, `shareable @${width}`);
    if (SCREENSHOTS) await extPage.screenshot({ path: `${SCREENSHOTS}/shareable-${width}.png`, fullPage: true });
    await external.close();
  }
});
