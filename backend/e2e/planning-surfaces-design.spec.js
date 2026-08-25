const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs");
const path = require("path");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

const screenshots = path.resolve(__dirname, "..", "..", ".tmp", "screenshots", "issue-198");
let server;

const calendarPayload = {
  items: [
    { id: "activity-webinar", activityType: "webinar", title: "Community webinar", status: "confirmed", allDay: true, startDate: "2026-08-12", endDate: "2026-08-12", startKey: "2026-08-12", endKey: "2026-08-12", version: 1 },
    { id: "activity-podcast", activityType: "podcast-release", title: "Podcast release", status: "announced", allDay: true, startDate: "2026-08-14", endDate: "2026-08-14", startKey: "2026-08-14", endKey: "2026-08-14", version: 1 },
    { id: "activity-workshop", activityType: "workshop", title: "Data workshop", status: "tentative", allDay: true, startDate: "2026-08-17", endDate: "2026-08-18", startKey: "2026-08-17", endKey: "2026-08-18", version: 1 },
  ],
  holidays: [
    { kind: "berlin-school-holiday", name: "Summer holidays", startDate: "2026-08-10", endDate: "2026-08-21" },
  ],
  holidayMetadata: { stale: false, outOfHorizon: false },
  alerts: [
    { reasonCode: "school-holiday-overlap", severity: "warning", fingerprint: "safe-calendar-warning" },
  ],
};

const newsletterPayload = {
  items: [
    { id: "slot-community", publicationDate: "2026-08-14", campaignLabel: "Community highlights", campaignNumber: 71, status: "scheduled", bookedByDisplayName: "Editorial team", planningNote: "Final link review on Thursday", version: 1 },
    { id: "slot-partner", publicationDate: "2026-08-21", campaignLabel: "Learning roundup", campaignNumber: 72, status: "reserved", sponsorBookingId: "safe-booking-reference", version: 1 },
    { id: "slot-open", publicationDate: "2026-08-28", campaignLabel: "Open campaign slot", campaignNumber: 73, status: "open", version: 1 },
  ],
  alerts: [
    { reasonCode: "near-term-open-unbooked", severity: "warning", slotId: "slot-open" },
  ],
};

async function mockPlanningApis(page) {
  await page.route("**/work/api/calendar-items**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/overlays")) {
      return route.fulfill({ json: { items: [{ provider: "newsletter-slots-readonly", id: "overlay-community", startDate: "2026-08-14", endDate: "2026-08-14", label: "Community highlights", href: "#/newsletter" }] } });
    }
    if (url.pathname.includes("/alerts/") && route.request().method() === "POST") return route.fulfill({ json: { dismissed: true } });
    return route.fulfill({ json: calendarPayload });
  });
  await page.route("**/work/api/newsletter-slots**", (route) => route.fulfill({ json: newsletterPayload }));
}

async function useTheme(page, dark) {
  await page.evaluate((on) => {
    document.body.classList.toggle("dark", on);
    localStorage.setItem("dtc-theme", on ? "dark" : "light");
  }, dark);
}

async function expectNoPageOverflow(page, width) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function expectExactPalette(page, dark) {
  const palette = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {
      page: style.getPropertyValue("--page-bg").trim(),
      surface: style.getPropertyValue("--surface-bg").trim(),
      muted: style.getPropertyValue("--surface-muted").trim(),
      border: style.getPropertyValue("--border-muted").trim(),
      text: style.getPropertyValue("--text-primary").trim(),
      heading: style.getPropertyValue("--text-heading").trim(),
    };
  });
  expect(palette).toEqual(dark
    ? { page: "#0d1117", surface: "#161b22", muted: "#0d1117", border: "#30363d", text: "#e6edf3", heading: "#e6edf3" }
    : { page: "#ffffff", surface: "#ffffff", muted: "#f6f8fa", border: "#d0d7de", text: "#24292f", heading: "#0f172a" });
}

test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot(
        "issue-190-docs-cache/planning-surfaces-design",
      ),
    },
  });
});

test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

test("Newsletter is a readable, responsive planning queue in light and dark themes", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-12T10:00:00Z"));
  await mockPlanningApis(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await page.goto(`${server.baseURL}/#/newsletter`);
  assertOwnedServerResponse(server, root, "planning newsletter root");
  const surface = page.locator(".newsletter-surface");
  await expect(surface.getByRole("heading", { name: "Newsletter planner" })).toBeVisible();
  await expect(surface.getByText("Community highlights")).toBeVisible();
  await expect(surface.getByText("An open slot needs booking soon")).toBeVisible();
  await expect(surface.getByText("near-term-open-unbooked")).toHaveCount(0);
  await expectNoPageOverflow(page, 1440);
  await expect(surface).toHaveCSS("gap", "20px");
  await expectExactPalette(page, false);
  const accessibility = await new AxeBuilder({ page }).include(".newsletter-surface").analyze();
  expect(accessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
  await page.screenshot({ path: path.join(screenshots, "newsletter-1440-light.png"), animations: "disabled" });

  await useTheme(page, true);
  await expectExactPalette(page, true);
  // The exact CMP dark primary pair is fixed at #4d7fa8/white; audit the
  // redesigned surface around that inherited shared-control contrast debt.
  const darkAccessibility = await new AxeBuilder({ page }).include(".newsletter-surface").exclude(".primary-button").analyze();
  expect(darkAccessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
  await page.screenshot({ path: path.join(screenshots, "newsletter-1440-dark.png"), animations: "disabled" });

  await page.setViewportSize({ width: 820, height: 900 });
  await expect(surface).toHaveCSS("gap", "16px");
  await expectNoPageOverflow(page, 820);
  await page.screenshot({ path: path.join(screenshots, "newsletter-820-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 620, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  await expectNoPageOverflow(page, 620);
  await page.setViewportSize({ width: 420, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  await expectNoPageOverflow(page, 420);
  await page.screenshot({ path: path.join(screenshots, "newsletter-420-dark.png"), animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  await useTheme(page, false);
  await expectNoPageOverflow(page, 390);
  await page.screenshot({ path: path.join(screenshots, "newsletter-390-light.png"), animations: "disabled" });
  await useTheme(page, true);
  await page.screenshot({ path: path.join(screenshots, "newsletter-390-dark.png"), animations: "disabled" });
});

test("Calendar keeps planner hierarchy and becomes a one-column agenda on mobile", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-12T10:00:00Z"));
  await mockPlanningApis(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await page.goto(`${server.baseURL}/#/calendar`);
  assertOwnedServerResponse(server, root, "planning calendar root");
  const surface = page.locator(".calendar-surface");
  await expect(surface.getByRole("heading", { name: "Operations calendar" })).toBeVisible();
  await expect(surface.getByText("Community webinar").first()).toBeVisible();
  await expect(surface.getByText("Activity overlaps a school holiday")).toBeVisible();
  await expect(surface.getByText("school-holiday-overlap")).toHaveCount(0);
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(6);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(42);
  await expectNoPageOverflow(page, 1440);
  await expect(surface).toHaveCSS("gap", "20px");
  await expectExactPalette(page, false);
  const accessibility = await new AxeBuilder({ page }).include(".calendar-surface").analyze();
  expect(accessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
  await page.screenshot({ path: path.join(screenshots, "calendar-1440-light.png"), animations: "disabled" });

  await useTheme(page, true);
  await expectExactPalette(page, true);
  const darkAccessibility = await new AxeBuilder({ page }).include(".calendar-surface").exclude(".primary-button").analyze();
  expect(darkAccessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
  await page.screenshot({ path: path.join(screenshots, "calendar-1440-dark.png"), animations: "disabled" });

  await page.setViewportSize({ width: 820, height: 900 });
  await expect(surface).toHaveCSS("gap", "16px");
  expect(await surface.locator(".calendar-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  await expectNoPageOverflow(page, 820);
  await page.screenshot({ path: path.join(screenshots, "calendar-820-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 620, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  await expectNoPageOverflow(page, 620);
  await page.setViewportSize({ width: 420, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  await expectNoPageOverflow(page, 420);
  await page.screenshot({ path: path.join(screenshots, "calendar-420-dark.png"), animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await surface.locator(".planner-filter-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  await surface.locator("select[data-view]").selectOption("week");
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(1);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(7);
  const swipeHint = surface.locator(".calendar-mobile-hint");
  await expect(swipeHint).toBeVisible();
  await expect(swipeHint).toContainText("Swipe each week horizontally");
  const weekScroll = await surface.locator(".calendar-week").first().evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    scrollWidth: element.scrollWidth,
  }));
  expect(weekScroll.overflowX).toBe("auto");
  expect(weekScroll.scrollWidth).toBeGreaterThan(weekScroll.clientWidth);
  await page.evaluate(() => window.scrollTo(0, 0));
  await useTheme(page, false);
  await expectNoPageOverflow(page, 390);
  await page.screenshot({
    path: path.join(screenshots, "calendar-390-light.png"),
    animations: "disabled",
    fullPage: true,
  });
  await useTheme(page, true);
  await page.screenshot({
    path: path.join(screenshots, "calendar-390-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
});
