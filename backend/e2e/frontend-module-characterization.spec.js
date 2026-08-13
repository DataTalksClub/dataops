const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
let server;
let baseURL;

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() >= deadline) return reject(new Error("Characterization server timed out"));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function observeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectNoHorizontalOverflow(page, route = page.url()) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.body.querySelectorAll("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(({ left, right }) => left < 0 || right > viewportWidth)
      .sort((left, right) => right.right - left.right)
      .slice(0, 8);
    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });
  const message = `${route} horizontal overflow: ${JSON.stringify(metrics)}`;
  expect(metrics.documentScrollWidth, message).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bodyScrollWidth, message).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function createCardWithTask(request) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const cardResponse = await request.post(`${baseURL}/api/cards`, {
    data: { title: `Characterization card ${suffix}`, anchorDate: "2026-08-12", stage: "preparation" },
  });
  expect(cardResponse.ok()).toBe(true);
  const card = (await cardResponse.json()).card;
  const taskResponse = await request.post(`${baseURL}/api/tasks`, {
    data: { description: `Characterization task ${suffix}`, date: "2026-08-12", cardId: card.id },
  });
  expect(taskResponse.ok()).toBe(true);
  return { card, task: await taskResponse.json() };
}

test.describe("pre-refactor frontend module characterization", () => {
  test.beforeAll(async () => {
    const port = await freePort();
    baseURL = `http://127.0.0.1:${port}`;
    server = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/test-server.ts"], {
      cwd: path.join(ROOT, "backend"),
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        IS_LOCAL: "true",
        SKIP_AUTH: "true",
        DATAOPS_DOCS_DOMAIN: "1",
        DTC_OFFLINE: "1",
        FRONTEND_ROOT: path.join(ROOT, "frontend"),
        E2E_TEMPLATE_ACTOR_ID: "00000000-0000-0000-0000-000000000001",
        CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: "false",
        CONVERSATIONAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_ENABLED_PLUGINS: "none",
        CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(baseURL);
  });

  test.afterAll(() => {
    if (!server) return;
    try { process.kill(-server.pid, "SIGTERM"); } catch {}
  });

  test("shell, Home, and account scope retain their primary DOM and interactions", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = observeErrors(page);
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator(".operations-home-daily")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs your attention" })).toBeVisible();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.locator(".quick-form-overlay")).toBeVisible();
    await page.locator(".quick-form-overlay").getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".quick-form-overlay")).toHaveCount(0);
    await page.locator("#settings-button").click();
    await expect(page.locator("#settings-menu")).toBeVisible();
    await expect(page.locator("[data-account-actor-name]")).not.toHaveText("Identity unavailable");
    await page.locator("#settings-menu-close").click();
    await page.locator("#sidebar-collapse-button").click();
    await expect(page.locator("#sidebar-expand-button")).toBeVisible();
    await page.locator("#sidebar-expand-button").click();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("Cards, archive, card detail, and nested Task restore their canonical URLs", async ({ browser, request }) => {
    const { card, task } = await createCardWithTask(request);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = observeErrors(page);

    await page.goto(`${baseURL}/#/cards`);
    await expect(page.locator(".ops-workflows-board")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cards" })).toBeVisible();
    await expect(page.locator(".workflow-board-column")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Done" })).toHaveCount(0);

    await page.goto(`${baseURL}/#/cards/archive`);
    await expect(page).toHaveURL(/\/#\/cards\/archive$/);
    await expect(page.getByRole("button", { name: "Back to board" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/#\/cards\/archive$/);

    await page.goto(`${baseURL}/#/cards?cardId=${encodeURIComponent(card.id)}`);
    await expect(page.locator("#card-panel")).toBeVisible();
    await expect(page.locator("#card-panel-title")).toHaveText(card.title);
    await page.reload();
    await expect(page.locator("#card-panel-title")).toHaveText(card.title);

    await page.goto(`${baseURL}/#/cards?cardId=${encodeURIComponent(card.id)}&taskId=${encodeURIComponent(task.id)}`);
    await expect(page.locator("#card-panel")).toBeVisible();
    await expect(page.locator("#task-panel")).toBeVisible();
    await expect(page.locator("#task-panel-title")).toHaveText(task.description);
    await page.locator("#task-panel-close").click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${card.id}$`));
    await page.goBack();
    await expect(page.locator("#task-panel-title")).toHaveText(task.description);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("retained top-level surfaces keep canonical route, title, marker, and primary interaction", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = observeErrors(page);
    const routes = [
      ["/tasks", "Tasks - Work Queue", ".ops-work-queue"],
      ["/templates", "Tasks - Templates", ".runtime-template-admin"],
      ["/recurring", "Tasks - Templates", ".ops-recurring-section"],
      ["/inbox", "Inbox", ".ops-inbox"],
      ["/assistants", "Tasks - Assistants", ".assistant-workspace"],
      ["/artifacts", "Tasks - Artifacts", '[aria-label="Artifacts"]'],
      ["/newsletter", "Newsletter", ".newsletter-surface"],
      ["/calendar", "Calendar", ".calendar-surface"],
      ["/bookkeeping", "Bookkeeping", ".bookkeeping-surface"],
      ["/sponsors", "Sponsors", ".sponsor-crm-surface"],
      ["/mailing-exports", "Mailing exports", ".mailing-exports-surface"],
      ["/processes", "Docs", ".ops-surface-docs"],
      ["/admin", "Admin", ".ops-surface-admin"],
      ["/users", "Users", ".ops-surface-users"],
    ];
    for (const [route, title, marker] of routes) {
      await page.goto(`${baseURL}/#${route}`);
      await expect(page).toHaveURL(`${baseURL}/#${route}`);
      await expect(page.locator("#library-title")).toHaveText(title);
      await expect(page.locator(marker)).toBeVisible();
      await expectNoHorizontalOverflow(page, route);
    }
    await page.goto(`${baseURL}/#/templates`);
    await page.getByRole("button", { name: "New runtime template" }).click();
    await expect(page.locator(".runtime-template-editor")).toBeVisible();
    await page.goto(`${baseURL}/#/newsletter`);
    await page.getByRole("button", { name: "Add slot" }).click();
    await expect(page.locator(".newsletter-surface dialog")).toBeVisible();
    await page.goto(`${baseURL}/#/calendar`);
    await page.getByRole("button", { name: "Add activity" }).click();
    await expect(page.locator(".calendar-surface dialog")).toBeVisible();
    await page.goto(`${baseURL}/#/bookkeeping`);
    await page.getByRole("button", { name: "Add entry" }).click();
    await expect(page.locator(".bookkeeping-entry-dialog")).toBeVisible();
    await page.goto(`${baseURL}/#/admin`);
    await page.getByRole("button", { name: /Diagnostics/ }).click();
    await expect(page.getByRole("heading", { name: "Read-only diagnostics" })).toBeFocused();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("invalid hashes recover to Home and unknown programmatic navigation is a no-op", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = observeErrors(page);
    for (const hash of ["#/unknown", "#/cards?taskId=orphan", "#/tasks?date=2026-02-30", "#/tasks?taskId=%E0%A4%A"]) {
      await page.goto(`${baseURL}/${hash}`);
      await expect(page).toHaveURL(`${baseURL}/#/`);
      await expect(page.locator(".operations-home-daily")).toBeVisible();
    }
    const before = page.url();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("workspace:navigate", {
      detail: { view: "not-a-view" },
    })));
    await expect(page).toHaveURL(before);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("all retained routes avoid page overflow and runtime errors at mobile width", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = observeErrors(page);
    const routes = [
      "/",
      "/inbox",
      "/tasks",
      "/cards",
      "/cards/archive",
      "/templates",
      "/recurring",
      "/assistants",
      "/artifacts",
      "/newsletter",
      "/calendar",
      "/bookkeeping",
      "/sponsors",
      "/mailing-exports",
      "/processes",
      "/admin",
      "/users",
    ];
    for (const route of routes) {
      await page.goto(`${baseURL}/#${route}`);
      await expect(page.locator("body")).toBeVisible();
      await expectNoHorizontalOverflow(page, route);
      if (route === "/users") {
        const tableOverflow = await page.locator(".ops-users-table-wrap").evaluate((wrapper) => ({
          clientWidth: wrapper.clientWidth,
          scrollWidth: wrapper.scrollWidth,
        }));
        expect(tableOverflow.scrollWidth).toBeGreaterThan(tableOverflow.clientWidth);
      }
    }
    expect(errors).toEqual([]);
    await context.close();
  });
});
