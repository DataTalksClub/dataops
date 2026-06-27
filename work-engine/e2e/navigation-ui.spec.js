const { test, expect } = require('@playwright/test');

test.describe('Navigation UI polish', () => {
  test('skip link lets keyboard users jump to main content without changing routes', async ({ page }) => {
    await page.goto('/#/tasks');

    await page.keyboard.press('Tab');
    const skipLink = page.locator('#skip-link');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('#app')).toBeFocused();
    await expect(page).toHaveURL(/\/#\/tasks/);
    await expect(page.locator('#app')).toHaveAttribute('tabindex', '-1');
  });

  test('mobile navigation starts compact, opens from the menu button, and closes after navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/');

    const toggle = page.locator('#nav-menu-toggle');
    const menu = page.locator('#nav-menu');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).not.toBeVisible();

    const closedNavHeight = await page.locator('nav').evaluate(function (nav) {
      return nav.getBoundingClientRect().height;
    });
    expect(closedNavHeight).toBeLessThanOrEqual(70);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(page.locator('#nav-menu a[href="#/templates"]')).toBeVisible();
    await expect(page.locator('#signout-btn')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).not.toBeVisible();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#nav-menu a[href="#/templates"]').click();
    await expect(page).toHaveURL(/\/#\/templates/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).not.toBeVisible();

    const hasOverflow = await page.evaluate(function () {
      return document.body.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasOverflow).toBe(false);
  });

  test('desktop navigation remains expanded without the mobile toggle', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/');

    await expect(page.locator('#nav-menu-toggle')).not.toBeVisible();
    await expect(page.locator('#nav-menu')).toBeVisible();
    await expect(page.locator('nav a[href="#/tasks"]')).toBeVisible();
    await expect(page.locator('#nav-menu a[href="#/"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('nav a[href="#/tasks"]')).not.toHaveAttribute('aria-current', 'page');

    await page.goto('/#/tasks');
    await expect(page.locator('nav a[href="#/tasks"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#nav-menu a[href="#/"]')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#signout-btn')).toBeVisible();
  });
});
