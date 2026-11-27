// The selected View label must fit inside its select with clear space before
// the chevron, with the view selector and Sort both visible and no horizontal
// overflow, on the narrowest phones.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');

for (const width of [375, 390]) {
  test(`/sponsors/pipeline: View selector label clears the chevron at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await setupPageWithAuth(page);
    await page.goto('/sponsors/pipeline');
    const show = page.locator('[data-views-bar="pipeline"] [data-views-select]');
    const sort = page.locator('[data-pipeline-sort]');
    await expect(show).toBeVisible();
    await expect(sort).toBeVisible();
    const fit = await show.evaluate((select) => {
      const style = getComputedStyle(select);
      const probe = document.createElement('span');
      probe.style.cssText = `font:${style.font};letter-spacing:${style.letterSpacing};position:absolute;visibility:hidden;white-space:nowrap`;
      probe.textContent = select.selectedOptions[0].text;
      document.body.appendChild(probe);
      const label = probe.getBoundingClientRect().width;
      probe.remove();
      // The chevron sits in the select's right padding; keep the label clear
      // of the ~28px chevron zone.
      const room = select.clientWidth - parseFloat(style.paddingLeft) - Math.max(parseFloat(style.paddingRight), 28);
      return { text: select.selectedOptions[0].text, label, room, width: select.getBoundingClientRect().width };
    });
    console.log(`show ${width}px`, JSON.stringify(fit));
    expect(fit.text).toBe('Needs attention');
    expect(fit.label).toBeLessThanOrEqual(fit.room);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.crm-funnel-controls').screenshot({ path: testInfo.outputPath(`show-filter-${width}.png`) });
  });
}
