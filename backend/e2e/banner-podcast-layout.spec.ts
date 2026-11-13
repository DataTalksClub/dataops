/**
 * Regression: one-speaker podcast covers rendered a huge gap between title and photo,
 * pushed the portrait to the bottom with the name pill against the edge, and carried
 * neither date/time nor the DataTalks.Club logo. This renders the composed HTML in a
 * real browser at the real canvas size and asserts layout geometry.
 */
import { test, expect } from '@playwright/test';
import { composeBanner, type BannerJob } from '../src/banners/model';
import { podcastOneSpeakerTemplate } from '../src/banners/podcastLayout';

const svg = (body: string, w = 600, h = 200) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)}`;
const assets = {
  assetFont: '',
  assetTexture: svg('<rect width="8" height="8" fill="#f4f4f4"/>', 8, 8),
  assetLogo: svg('<rect width="600" height="200" fill="#285d9d"/>'),
};
const portrait = svg('<rect width="800" height="800" fill="#a55"/>', 800, 800);
const titles = {
  short: 'Agents',
  madhu: 'From Ad-Hoc SQL to AI Agents',
  long: 'Shipping Reliable LLMs and the Rise of AI Engineering: What Changes When Agents Query Live Data Every Day',
};

function job(layout: 'square' | 'landscape', title: string): BannerJob {
  return {
    id: 'j', bundleKey: 'k', cardId: 'c', title, state: 'queued', createdBy: 'u', createdAt: '', updatedAt: '',
    input: { eventType: 'podcast', layout, speakers: [{ personId: 'p', portraitFileId: 'f' }], revision: 'r' },
    speakers: [{ personId: 'p', portraitFileId: 'f', name: 'Madhu Gurramkonda', personVersion: 1, checksum: 'sha256:x' }],
    schedule: { date: 'Tue, 24 November 2026', time: '17:00 CET' },
  };
}

for (const layout of ['square', 'landscape'] as const) {
  for (const [kind, title] of Object.entries(titles)) {
    test(`${layout} podcast cover (${kind} title) keeps every element inside the canvas`, async ({ page }) => {
      const template = podcastOneSpeakerTemplate(layout);
      await page.setViewportSize({ width: template.width, height: template.height });
      await page.setContent(composeBanner(template, job(layout, title), [portrait], assets));
      const box = (selector: string) => page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
      const { width: W, height: H } = template;
      const edge = 40;
      for (const selector of ['.name', '.portrait', '.title', '.when', '.logo', '.badge']) {
        const b = await box(selector);
        expect(b.width, `${selector} rendered`).toBeGreaterThan(20);
        expect(b.left, `${selector} left`).toBeGreaterThanOrEqual(edge);
        expect(b.top, `${selector} top`).toBeGreaterThanOrEqual(edge);
        expect(b.right, `${selector} right`).toBeLessThanOrEqual(W - edge);
        expect(b.bottom, `${selector} bottom`).toBeLessThanOrEqual(H - edge);
      }
      await expect(page.locator('.when')).toContainText('24 November 2026');
      await expect(page.locator('.when')).toContainText('17:00');
      expect(await page.locator('.logo').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(H);
      const [name, portraitBox, titleBox] = [await box('.name'), await box('.portrait'), await box('.title')];
      expect(name.height).toBeLessThan(260); // name wraps at most two lines
      if (layout === 'square') {
        // Gap between title text and photo is just the date line, never a void.
        expect(portraitBox.top - titleBox.bottom).toBeLessThan(H * 0.2);
        expect(portraitBox.width).toBeGreaterThan(H * 0.3); // photo is not squeezed
        expect(portraitBox.top).toBeLessThan(H * 0.75); // not pushed to the bottom
      } else {
        expect(titleBox.right).toBeLessThanOrEqual(portraitBox.left);
        expect(portraitBox.width).toBeGreaterThan(H * 0.5);
      }
    });
  }
}
