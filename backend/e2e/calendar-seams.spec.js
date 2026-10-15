const { test, expect } = require("@playwright/test");
const http = require("http"),
  fs = require("fs"),
  path = require("path");
const frontendManifest = require("../src/docs/frontend-assets.json");
const shots = path.resolve(
  __dirname,
  "..",
  "..",
  ".tmp",
  "screenshots",
  "issue-110",
);
const payload = {
  items: [
    {
      id: "activity-1",
      activityType: "webinar",
      title: "Synthetic Webinar",
      status: "confirmed",
      allDay: true,
      startDate: "2026-06-30",
      endDate: "2026-06-30",
      startKey: "2026-06-30",
      endKey: "2026-06-30",
      version: 1,
    },
  ],
  holidays: [
    {
      kind: "berlin-public-holiday",
      name: "Synthetic public holiday",
      startDate: "2026-06-30",
      endDate: "2026-06-30",
    },
    {
      kind: "berlin-school-holiday",
      name: "Summer holidays",
      startDate: "2026-06-30",
      endDate: "2026-08-22",
    },
  ],
  holidayMetadata: { stale: false, outOfHorizon: false },
  alerts: [
    {
      reasonCode: "public-holiday-overlap",
      severity: "warning",
      affectedIds: ["activity-1"],
      fingerprint: "public-holiday-overlap#activity-1#v1",
    },
  ],
  timeZone: "Europe/Berlin",
};
let frontendServer, frontendBase;
test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const root = path.resolve(__dirname, "..", "..", "frontend");
  const allowedAssets = new Set(frontendManifest.files);
  frontendServer = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://fixture.test").pathname);
    } catch {
      return res.writeHead(400).end();
    }
    const relative = pathname === "/" || pathname === "/calendar" ? "index.html" : pathname.slice(1);
    if (
      pathname.includes("\\") ||
      relative !== path.posix.normalize(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..") ||
      !allowedAssets.has(relative)
    ) {
      return res.writeHead(404).end();
    }
    const file = path.resolve(root, ...relative.split("/"));
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      return res.writeHead(404).end();
    }
    res.setHeader(
      "content-type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => frontendServer.listen(0, "127.0.0.1", r));
  frontendBase = `http://127.0.0.1:${frontendServer.address().port}`;
});
test.afterAll(
  () => new Promise((resolve, reject) =>
    frontendServer.close((error) => error ? reject(error) : resolve()),
  ),
);

test("production portal calendar covers month/week, layers, overlay, dismiss/reappear, empty/error and mobile", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-07-01T12:00:00Z"));
  await page.setViewportSize({ width: 1280, height: 800 });
  let dismissed = false,
    failed = false,
    changed = false;
  await page.route("**/api/calendar-items**", (route) => {
    const u = new URL(route.request().url()),
      method = route.request().method();
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: "synthetic unavailable" },
      });
    if (u.pathname.endsWith("/overlays"))
      return route.fulfill({
        json: {
          items: [
            {
              provider: "newsletter-slots-readonly",
              id: "slot-1",
              startDate: "2026-06-30",
              endDate: "2026-06-30",
              label: "Synthetic Newsletter",
              href: "/newsletter",
            },
          ],
        },
      });
    if (u.pathname.includes("/alerts/") && method === "POST") {
      dismissed = true;
      return route.fulfill({ json: { dismissed: true } });
    }
    if (method === "PUT") {
      changed = true;
      dismissed = false;
      return route.fulfill({
        json: { ...payload.items[0], version: 2, title: "Changed Webinar" },
      });
    }
    return route.fulfill({
      json: {
        ...payload,
        alerts: dismissed
          ? []
          : payload.alerts.map((a) => ({
              ...a,
              fingerprint: changed ? a.fingerprint + "#v2" : a.fingerprint,
            })),
      },
    });
  });
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.includes("/calendar-items")) return route.fallback();
    if (u.pathname === "/api/me")
      return route.fulfill({ json: { user: { id: "operator" } } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(frontendBase);
  await page.getByRole("link", { name: "Calendar" }).click();
  // The planner status line carries only warnings (stale holidays, holiday
  // horizon, unavailable newsletter overlays); empty means loaded clean.
  await expect(page.locator(".calendar-surface [role='status']")).toHaveText("");
  await expect(page.locator(".calendar-activity").filter({ hasText: "Synthetic Webinar" }).first()).toBeVisible();
  await expect(page.getByText("Synthetic Newsletter").first()).toBeVisible();
  await expect(page.getByText("Synthetic public holiday").first()).toBeVisible();
  await expect(page.getByText("Summer holidays").first()).toBeVisible();
  await expect(page.locator(".iso-week").first()).toHaveText(/^\d+$/);
  const surface = page.locator(".calendar-surface");
  await expect(surface.getByRole("heading", { name: "Calendar", exact: true, level: 1 })).toBeVisible();
  await expect(surface.locator(".calendar-controls").getByRole("button", { name: "Add activity", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "calendar-demo-1280x800.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(shots, "calendar-demo-1440x900.png") });
  await surface.screenshot({
    path: path.join(shots, "production-month-populated.png"),
  });
  await surface.locator("select[data-view]").selectOption("week");
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(1);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(5);
  await surface.screenshot({ path: path.join(shots, "production-week.png") });
  await surface.locator('[data-layer="school"]').uncheck();
  await expect(surface.getByText("Summer holidays")).toHaveCount(0);
  await surface.locator('[data-layer="overlay"]').uncheck();
  await expect(surface.getByText("Synthetic Newsletter")).toHaveCount(0);
  await expect(surface.locator(".calendar-alert-summary")).not.toHaveAttribute("open", "");
  await surface.locator(".calendar-alert-summary > summary").click();
  await surface.getByRole("button", { name: "Dismiss" }).click();
  await expect(surface.getByText("Activity overlaps a public holiday")).toHaveCount(0);
  await surface.locator("select[data-view]").selectOption("month");
  await surface.locator(".calendar-activity").filter({ hasText: "Synthetic Webinar" }).first().click();
  await surface.getByLabel("Title").fill("Changed Webinar");
  await surface.getByRole("button", { name: "Save activity" }).click();
  await expect(surface.locator(".calendar-alert-summary > summary")).toHaveText("1 planning alert");
  await surface.locator(".calendar-alert-summary > summary").click();
  await expect(surface.getByText("Activity overlaps a public holiday")).toBeVisible();
  await surface.locator("select[data-view]").selectOption("week");
  await surface.locator("[data-type]").selectOption("other");
  await expect(surface.getByText("No matching activities")).toBeVisible();
  await surface.screenshot({
    path: path.join(shots, "production-empty-filter.png"),
  });
  failed = true;
  await surface.locator("[data-next]").click();
  await expect(surface.getByText("Calendar unavailable")).toBeVisible();
  await expect(surface.getByText("Activity overlaps a public holiday")).toHaveCount(0);
  await surface.screenshot({ path: path.join(shots, "production-error.png") });
  failed = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await surface.getByRole("button", { name: "Calendar layers and view" }).click();
  await surface.evaluate((element) => (element.style.width = ""));
  await surface.locator("[data-type]").selectOption("");
  await surface.locator("select[data-view]").selectOption("week");
  await surface.locator("[data-today]").click();
  await surface.locator('[data-layer="school"]').check();
  await surface.locator('[data-layer="overlay"]').check();
  await expect(surface.locator("[role='status']")).toHaveText("");
  await surface.evaluate((element) => {
    element.querySelector(".calendar-controls").style.display = "none";
    element.querySelector('[role="status"]').style.display = "none";
    element.style.height = "844px";
    element.style.overflow = "hidden";
  });
  await surface.screenshot({ path: path.join(shots, "production-mobile.png") });
});
test("production calendar renders cross-year ISO weeks and Berlin DST boundary dates", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-12-31T12:00:00Z"));
  let savedTimed;

  await page.route("**/api/calendar-items**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/overlays"))
      return route.fulfill({ json: { items: [] } });
    if (route.request().method() === "PUT") {
      savedTimed = route.request().postDataJSON();
      return route.fulfill({ json: { ...savedTimed, id: "dst-edge", version: 2 } });
    }
    const isAutumn = /^2026-10-/.test(u.searchParams.get("from") || "");
    const isDst = /^2026-0[23]-/.test(u.searchParams.get("from") || "");
    return route.fulfill({
      json: {
        items: isAutumn ? [{ id: "autumn-edge", activityType: "webinar", title: "Autumn repeated hour",
          status: "confirmed", allDay: false, startsAt: "2026-10-25T00:30:00.000Z", endsAt: "2026-10-25T01:45:00.000Z",
          startKey: "2026-10-25", endKey: "2026-10-25", version: 1 }] : isDst ? [{id:"dst-edge",activityType:"webinar",title:"DST-safe timed activity",status:"confirmed",allDay:false,startsAt:"2026-03-29T01:30:00.000Z",endsAt:"2026-03-29T02:30:00.000Z",startKey:"2026-03-29",endKey:"2026-03-29",version:1}] : [
          {
            id: "year-edge",
            activityType: "other",
            title: "Cross-year activity",
            status: "confirmed",
            allDay: true,
            startDate: "2026-12-31",
            endDate: "2027-01-01",
            startKey: "2026-12-31",
            endKey: "2027-01-01",
            version: 1,
          },
        ],
        holidays: [],
        holidayMetadata: {},
        alerts: [],
      },
    });
  });
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname.includes("/calendar-items")
      ? route.fallback()
      : route.fulfill({ json: { items: [] } }),
  );
  await page.goto(frontendBase);
  await page.getByRole("link", { name: "Calendar" }).click();
  const surface = page.locator(".calendar-surface");
  await expect(surface.locator("[role='status']")).toHaveText("");
  await surface.locator("select[data-view]").selectOption("week");
  await expect(surface.getByText("Cross-year activity").first()).toBeVisible();
  await expect(surface.locator('time[datetime="2027-01-01"]')).toBeVisible();
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(1);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(5);
  await expect(surface.locator(".iso-week")).toContainText(["53"]);
  await surface.screenshot({
    path: path.join(shots, "production-year-boundary.png"),
  });
  await page.clock.setFixedTime(new Date("2026-03-29T12:00:00Z"));
  await surface.locator("[data-today]").click();
  // DST switches on a Sunday; weekend entries are reached through Friday's note.
  await expect(surface.locator('time[datetime="2026-03-29"]')).toHaveCount(0);
  await surface.locator('[data-day="2026-03-27"] .calendar-weekend-note').click();
  const dayDialog = surface.locator("[data-day-dialog]");
  await expect(dayDialog.getByText("DST-safe timed activity")).toBeVisible();
  await dayDialog.locator('[data-edit="dst-edge"]').click();
  await expect(surface.getByLabel("Start date")).toHaveValue("2026-03-29");
  await expect(surface.getByLabel("End date")).toHaveValue("2026-03-29");
  await expect(surface.getByLabel("Start time (Berlin)")).toHaveValue("03:30");
  await expect(surface.getByLabel("End time (Berlin)")).toHaveValue("04:30");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(shots, "calendar-demo-timed-editor-1280x800.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(shots, "calendar-demo-timed-editor-1440x900.png") });
  await surface.getByLabel("Title", { exact: true }).fill("Edited timed activity");
  await surface.getByRole("button", { name: "Save activity" }).click();
  await expect.poll(() => savedTimed?.startsAt).toBe("2026-03-29T01:30:00.000Z");
  expect(savedTimed.endsAt).toBe("2026-03-29T02:30:00.000Z");
  expect(savedTimed.allDay).toBe(false);
  expect(savedTimed).not.toHaveProperty("startDate");
  expect(savedTimed).not.toHaveProperty("startTime");
  await surface.screenshot({
    path: path.join(shots, "production-dst-boundary.png"),
  });
  await page.clock.setFixedTime(new Date("2026-10-25T12:00:00Z"));
  await surface.locator("[data-today]").click();
  await surface.locator('[data-day="2026-10-23"] .calendar-weekend-note').click();
  await dayDialog.locator(".calendar-day-timeline-row", { hasText: "Autumn repeated hour" }).locator("[data-edit]").click();
  await expect(surface.getByLabel("Start time (Berlin)")).toHaveValue("02:30");
  await expect(surface.getByLabel("End time (Berlin)")).toHaveValue("02:45");
  await surface.getByLabel("Title", { exact: true }).fill("Autumn title edit");
  await surface.getByRole("button", { name: "Save activity" }).click();
  await expect.poll(() => savedTimed?.startsAt).toBe("2026-10-25T00:30:00.000Z");
  expect(savedTimed.endsAt).toBe("2026-10-25T01:45:00.000Z");
});


test("calendar grid is ready before the external overlay response", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-01T12:00:00Z"));
  let releaseOverlay;
  const overlayReady = new Promise((resolve) => { releaseOverlay = resolve; });
  await page.route("**/api/calendar-items**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/overlays")) {
      await overlayReady;
      return route.fulfill({ json: { items: [{ id: "alexey-slot:2026-06-30:midday", provider: "alexey-calendar",
        startDate: "2026-06-30", endDate: "2026-06-30", category: "Available slot", label: "12:30 Available",
        isAvailableSlot: true }] } });
    }
    return route.fulfill({ json: payload });
  });
  await page.route("**/api/**", (route) => new URL(route.request().url()).pathname.includes("/calendar-items")
    ? route.fallback() : route.fulfill({ json: { items: [] } }));
  await page.goto(frontendBase);
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  const surface = page.locator(".calendar-surface");
  const grid = surface.locator(".calendar-grid");
  const indicator = surface.locator("[data-calendar-indicator]");
  let loadingTop;
  try {
    await expect(surface.locator(".calendar-activity").first()).toContainText("Synthetic Webinar");
    await expect(grid).toBeVisible();
    // Loading is a spinner in a reserved toolbar slot plus aria-busy, never a
    // visible line between the toolbar and the grid.
    await expect(indicator).toHaveAttribute("data-state", "loading");
    await expect(indicator.locator(".dk-spinner")).toBeVisible();
    await expect(surface.locator("[data-calendar]")).toHaveAttribute("aria-busy", "true");
    await expect(surface.getByText("Loading calendar overlays…")).toHaveCount(0);
    loadingTop = (await grid.boundingBox()).y;
  } finally {
    releaseOverlay();
  }
  await expect(surface.locator(".calendar-overlay").first()).toContainText("12:30 Available");
  await expect(indicator).toHaveAttribute("data-state", "idle");
  await expect(surface.locator("[data-calendar]")).toHaveAttribute("aria-busy", "false");
  await expect(surface.locator("[role='status']")).toHaveText("");
  expect((await grid.boundingBox()).y).toBe(loadingTop);
});

test("a disconnected calendar source is a toolbar warning that does not move the grid", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-01T12:00:00Z"));
  await page.route("**/api/calendar-items**", (route) => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith("/overlays")
      ? { items: [], sources: { "alexey-calendar": { state: "not-configured", reason: "No broker credential." } } }
      : payload }));
  await page.route("**/api/**", (route) => new URL(route.request().url()).pathname.includes("/calendar-items")
    ? route.fallback() : route.fulfill({ json: { items: [] } }));
  await page.goto(`${frontendBase}/calendar`);
  const surface = page.locator(".calendar-surface");
  const indicator = surface.locator("[data-calendar-indicator]");
  await expect(indicator).toHaveAttribute("data-state", "warning");
  await expect(indicator).toHaveAttribute("title", /not connected: No broker credential/);
  await expect(indicator.locator(".calendar-sync-warning")).toBeVisible();
  await expect(surface.locator("[role='status']")).toHaveText(/not connected/);
  // The status is a visually hidden live region for screen readers only.
  expect((await surface.locator("[role='status']").boundingBox()).height).toBeLessThanOrEqual(1);
  const grid = surface.locator(".calendar-grid");
  const warningTop = (await grid.boundingBox()).y;
  // Hiding open slots drops the warning; the grid stays where it was.
  await surface.locator('[data-layer="available"]').uncheck();
  await expect(indicator).toHaveAttribute("data-state", "idle");
  await expect(surface.locator("[role='status']")).toHaveText("");
  expect((await grid.boundingBox()).y).toBe(warningTop);
});


// The toolbar carries the period and, on its own row at phone widths, Add
// activity and the layers toggle; the grid still starts in the top 30%.
test("calendar header and toolbar keep the mobile grid within the top 30%", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-01T12:00:00Z"));
  await page.route("**/api/calendar-items**", (route) => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith("/overlays") ? { items: [] }
      : { ...payload, alerts: [], holidays: [] } }));
  await page.route("**/api/**", (route) => new URL(route.request().url()).pathname.includes("/calendar-items")
    ? route.fallback() : route.fulfill({ json: { items: [] } }));
  for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${frontendBase}/calendar`);
    const surface = page.locator(".calendar-surface");
    await expect(surface.locator("[role='status']")).toHaveText("");
    await expect(surface.getByRole("heading", { name: "Calendar", exact: true, level: 1 })).toBeVisible();
    const top = await surface.locator(".calendar-grid").evaluate((node) => node.getBoundingClientRect().top);
    expect(top).toBeLessThanOrEqual(Math.round(viewport.height * 0.3) + 2);
    await surface.locator(".calendar-controls").getByRole("button", { name: "Add activity", exact: true }).click();
    await expect(surface.locator("dialog[open]")).toBeVisible();
    await surface.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({ path: path.join(shots, `calendar-page-header-${viewport.width}x${viewport.height}.png`) });
  }
});

// Weekends are excluded from the calendar on purpose. They came back once by
// accident (e7642faf); this guards both views at desktop and phone widths.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 },
  { width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`calendar is weekdays-only with weekend entries on Friday at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-04T12:00:00Z"));
    await page.setViewportSize(viewport);
    const weekendItems = [
      { id: "saturday", title: "Cohort kickoff", date: "2026-11-07" },
      { id: "sunday", title: "Hackathon demo", date: "2026-11-08" },
    ].map(({ id, title, date }) => ({ id, title, activityType: "webinar", status: "confirmed",
      allDay: true, startDate: date, endDate: date, startKey: date, endKey: date, version: 1 }));
    await page.route("**/api/calendar-items**", (route) => route.fulfill({ json:
      new URL(route.request().url()).pathname.endsWith("/overlays") ? { items: [] } : {
        items: weekendItems, holidays: [{ kind: "berlin-public-holiday", name: "Midweek holiday",
          startDate: "2026-11-04", endDate: "2026-11-04" }], holidayMetadata: {}, alerts: [],
      } }));
    await page.route("**/api/**", (route) => new URL(route.request().url()).pathname.includes("/calendar-items")
      ? route.fallback() : route.fulfill({ json: { items: [] } }));
    await page.goto(`${frontendBase}/calendar`);
    const surface = page.locator(".calendar-surface");
    const grid = surface.locator(".calendar-grid");
    const controls = surface.locator(".calendar-display-controls");
    await expect(surface.locator("[role='status']")).toHaveText("");
    const expectWeekdaysOnly = async () => {
      await expect(surface.locator(".calendar-weekdays strong:not(.calendar-week-heading)"))
        .toHaveText(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
      await expect(surface.locator(".calendar-weekdays strong", { hasText: /Saturday|Sunday/ })).toHaveCount(0);
      for (const week of await surface.locator(".calendar-week").all()) {
        await expect(week.locator("section.calendar-day")).toHaveCount(5);
      }
      for (const date of ["2026-11-01", "2026-11-07", "2026-11-08"]) {
        await expect(surface.locator(`[data-day="${date}"]`)).toHaveCount(0);
      }
      await expect(surface.locator('[data-day="2026-11-06"] .calendar-weekend-note')).toHaveText(/\+ weekend · 2/);
    };
    await expectWeekdaysOnly();
    if (viewport.width >= 821) {
      const columns = await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(6);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    if (viewport.width < 821) {
      expect((await grid.boundingBox()).y).toBeLessThanOrEqual(Math.round(viewport.height * 0.3) + 2);
      await expect(controls).toBeHidden();
      const toggle = surface.getByRole("button", { name: "Calendar layers and view" });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    } else {
      const bounds = await controls.boundingBox();
      expect(bounds.height).toBeLessThanOrEqual(80);
      expect(bounds.y + bounds.height).toBeLessThan(viewport.height);
    }
    await expect(controls).toBeVisible();
    const bounds = await controls.boundingBox();
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((await grid.boundingBox()).y);
    await surface.locator('[data-layer="public"]').uncheck();
    await expect(surface.getByText("Midweek holiday", { exact: true })).toHaveCount(0);
    await surface.locator('[data-layer="public"]').check();
    await expect(surface.getByText("Midweek holiday", { exact: true })).toBeVisible();
    if (viewport.width < 821) {
      const settings = surface.locator("[data-calendar-settings]");
      await settings.scrollIntoViewIfNeeded();
      const settingsBox = await settings.boundingBox();
      expect(settingsBox.x).toBeGreaterThanOrEqual(0);
      expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(viewport.width);
      await surface.locator(".calendar-layers").evaluate((node) => { node.scrollLeft = 0; });
    }
    await page.screenshot({ path: path.join(shots, `calendar-weekdays-${viewport.width}x${viewport.height}.png`) });
    // The Friday note opens the weekend day, where its entries stay editable.
    const note = surface.locator('[data-day="2026-11-06"] .calendar-weekend-note');
    await note.scrollIntoViewIfNeeded();
    const noteBox = await note.boundingBox();
    expect(noteBox.x).toBeGreaterThanOrEqual(0);
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(viewport.width);
    await note.click();
    const dayDialog = surface.locator("[data-day-dialog]");
    await expect(dayDialog).toBeVisible();
    await dayDialog.locator('[data-edit="saturday"]').click();
    await expect(surface.getByLabel("Title", { exact: true })).toHaveValue("Cohort kickoff");
    await surface.getByRole("button", { name: "Cancel", exact: true }).click();
    await controls.getByLabel("Calendar view", { exact: true }).selectOption("week");
    await expect(surface.locator(".calendar-week")).toHaveCount(1);
    await expectWeekdaysOnly();
  });
}
