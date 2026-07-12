const { test, expect } = require("@playwright/test"),
  http = require("http"),
  fs = require("fs"),
  path = require("path");

let server, base;
test.beforeAll(async () => {
  const root = path.resolve(__dirname, "..", "src");
  server = http.createServer((request, response) => {
    const files = {
        "/": path.join(root, "pages/index.html"),
        "/public/app.js": path.join(root, "public/app.js"),
        "/public/api.js": path.join(root, "public/api.js"),
      },
      file = files[new URL(request.url, "http://local").pathname];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "content-type",
      file.endsWith(".js") ? "text/javascript" : "text/html",
    );
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => server.close());

test("Week selection survives a filter-triggered reload and reapplies ISO grouping", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("dataops_token", "synthetic-token");
    localStorage.setItem(
      "dataops_user",
      JSON.stringify({ id: "fallback-operator", name: "Fallback Operator" }),
    );
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me")
      return route.fulfill({ json: { user: { id: "fallback-operator" } } });
    if (url.pathname === "/api/newsletter-slots")
      return route.fulfill({
        json: {
          items: [
            {
              id: "year-end",
              publicationDate: "2026-12-31",
              campaignLabel: "Synthetic Year End",
              status: "open",
              version: 1,
            },
            {
              id: "new-year",
              publicationDate: "2027-01-01",
              campaignLabel: "Synthetic New Year",
              status: "open",
              version: 1,
            },
          ],
          alerts: [],
        },
      });
    return route.fulfill({ json: [] });
  });
  await page.goto(`${base}/#/newsletter`);
  await expect(page.getByText("Synthetic Year End")).toBeVisible();
  await page.locator("#newsletter-view").selectOption("week");
  await expect(page.locator("#newsletter-list > section > h3")).toHaveText([
    "2026 · week 53",
  ]);
  await page.locator("#newsletter-booked").selectOption("false");
  await expect(page.getByText("Newsletter schedule ready.")).toBeVisible();
  await expect(page.locator("#newsletter-view")).toHaveValue("week");
  await expect(page.locator("#newsletter-list > section > h3")).toHaveText([
    "2026 · week 53",
  ]);
});
