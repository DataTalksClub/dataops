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
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
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
  await page.setViewportSize({ width: 1280, height: 1200 });
  let dismissed = false,
    failed = false,
    changed = false;
  await page.route("**/work/api/calendar-items**", (route) => {
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
              href: "#/newsletter",
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
  await page.getByRole("button", { name: "Calendar" }).click();
  await expect(page.locator(".calendar-surface [role='status']")).toHaveText(
    "Calendar ready.",
  );
  await expect(page.getByText("Synthetic Webinar").first()).toBeVisible();
  await expect(page.getByText("Synthetic Newsletter").first()).toBeVisible();
  await expect(page.getByText("Synthetic public holiday").first()).toBeVisible();
  await expect(page.getByText("Summer holidays").first()).toBeVisible();
  await expect(page.locator(".iso-week").first()).toContainText("ISO");
  const surface = page.locator(".calendar-surface");
  await surface.evaluate((element) => (element.style.width = "1000px"));
  await surface.screenshot({
    path: path.join(shots, "production-month-populated.png"),
  });
  await surface.locator("select[data-view]").selectOption("week");
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(1);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(7);
  await surface.screenshot({ path: path.join(shots, "production-week.png") });
  await surface.locator('[data-layer="school"]').uncheck();
  await expect(surface.getByText("Summer holidays")).toHaveCount(0);
  await surface.locator('[data-layer="overlay"]').uncheck();
  await expect(surface.getByText("Synthetic Newsletter")).toHaveCount(0);
  await surface.getByRole("button", { name: "Dismiss" }).click();
  await expect(surface.getByText("Activity overlaps a public holiday")).toHaveCount(0);
  await surface.locator("select[data-view]").selectOption("month");
  await surface.getByText("Synthetic Webinar").first().click();
  await surface.getByLabel("Title").fill("Changed Webinar");
  await surface.getByRole("button", { name: "Save activity" }).click();
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
  await surface.evaluate((element) => (element.style.width = ""));
  await surface.locator("[data-type]").selectOption("");
  await surface.locator("select[data-view]").selectOption("week");
  await surface.locator("[data-today]").click();
  await surface.locator('[data-layer="school"]').check();
  await surface.locator('[data-layer="overlay"]').check();
  await expect(surface.getByText("Calendar ready.")).toBeVisible();
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
  await page.route("**/work/api/calendar-items**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/overlays"))
      return route.fulfill({ json: { items: [] } });
    const isDst = /^2026-0[23]-/.test(u.searchParams.get("from") || "");
    return route.fulfill({
      json: {
        items: isDst ? [{id:"dst-edge",activityType:"webinar",title:"DST-safe timed activity",status:"confirmed",allDay:false,startsAt:"2026-03-29T01:30:00.000Z",endsAt:"2026-03-29T02:30:00.000Z",startKey:"2026-03-29",endKey:"2026-03-29",version:1}] : [
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
  await page.getByRole("button", { name: "Calendar" }).click();
  const surface = page.locator(".calendar-surface");
  await expect(surface.locator("[role='status']")).toHaveText(
    "Calendar ready.",
  );
  await surface.locator("select[data-view]").selectOption("week");
  await expect(surface.getByText("Cross-year activity").first()).toBeVisible();
  await expect(surface.locator('time[datetime="2027-01-01"]')).toBeVisible();
  await expect(surface.locator(".calendar-weeks > .calendar-week")).toHaveCount(1);
  await expect(surface.locator(".calendar-weeks > .calendar-week > section.calendar-day")).toHaveCount(7);
  await expect(surface.locator(".iso-week")).toContainText(["ISO 53"]);
  await surface.screenshot({
    path: path.join(shots, "production-year-boundary.png"),
  });
  await page.clock.setFixedTime(new Date("2026-03-29T12:00:00Z"));
  await surface.locator("[data-today]").click();
  await expect(surface.locator('time[datetime="2026-03-29"]')).toBeVisible();
  await expect(surface.getByText("DST-safe timed activity")).toBeVisible();
  await surface.screenshot({
    path: path.join(shots, "production-dst-boundary.png"),
  });
});
