const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const PORT = 3014,
  BASE_URL = `http://127.0.0.1:${PORT}`;
let processHandle;
function waitForServer() {
  return new Promise((resolve, reject) => {
    const end = Date.now() + 30000;
    (function poll() {
      const req = http.get(`${BASE_URL}/api/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () =>
        Date.now() > end
          ? reject(new Error("portal server timeout"))
          : setTimeout(poll, 250),
      );
    })();
  });
}
test.describe("production portal bookkeeping", () => {
  test.beforeAll(async () => {
    processHandle = spawn("npx", ["tsx", "scripts/test-server.ts"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        IS_LOCAL: "true",
        SKIP_AUTH: "true",
        DATAOPS_DOCS_DOMAIN: "1",
        DTC_OFFLINE: "1",
        FRONTEND_ROOT: path.resolve(__dirname, "..", "..", "frontend"),
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await waitForServer();
  });
  test.afterAll(() => {
    if (processHandle)
      try {
        process.kill(-processHandle.pid, "SIGTERM");
      } catch {}
  });
  test("loads the real frontend Bookkeeping surface and operator states", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    const entries = [
      {
        id: "prod-synthetic",
        transactionDate: "2026-10-01",
        paidDate: "2026-10-02",
        counterparty: "Synthetic Portal Vendor",
        description: "Synthetic portal entry",
        amount: "15.50",
        currency: "EUR",
        category: "software",
        entryType: "expense",
        statementRef: "synthetic",
      },
    ];
    const documents = [{ id: "private-doc", documentType: "private-account-statement", originalFilename: "synthetic-private.pdf", status: "active" }];
    const links = [];
    await page.route("**/work/api/bookkeeping/**", async (route) => {
      const url = new URL(route.request().url()),
        suffix = url.pathname.split("/bookkeeping")[1];
      const method = route.request().method();
      if (suffix === "/transactions" && method === "GET")
        return route.fulfill({ json: { items: entries } });
      if (suffix === "/transactions" && method === "POST") { const item={id:"created",...route.request().postDataJSON()};entries.unshift(item);return route.fulfill({status:201,json:item}); }
      if (suffix.startsWith("/transactions/") && method === "PUT") { const id=suffix.split("/").pop(),item=entries.find(entry=>entry.id===id);Object.assign(item,route.request().postDataJSON());return route.fulfill({json:item}); }
      if (suffix.startsWith("/transactions/") && method === "DELETE") { const id=suffix.split("/").pop(),index=entries.findIndex(entry=>entry.id===id);if(index>=0)entries.splice(index,1);return route.fulfill({status:204,body:""}); }
      if (suffix === "/documents") return route.fulfill({ json: { items: documents } });
      if (suffix === "/links" && method === "GET") return route.fulfill({ json: { items: links } });
      if (suffix === "/links" && method === "POST") { links.push({id:"link-new",...route.request().postDataJSON()});return route.fulfill({status:201,json:links.at(-1)}); }
      if (suffix.startsWith("/links/") && method === "DELETE") { links.splice(0);return route.fulfill({status:204,body:""}); }
      if (suffix === "/accounts") return route.fulfill({ json: { items: [] } });
      if (suffix === "/accounts/setup") return route.fulfill({ json: { accounts: [{id:"business-1"},{id:"business-2"}] } });
      if (suffix === "/documents/upload" && method === "POST") return route.fulfill({status:201,json:{document:{id:"uploaded-doc"},uploadUrl:`${BASE_URL}/synthetic-put`}});
      if (suffix === "/documents/uploaded-doc/complete") { const document={id:"uploaded-doc",documentType:"receipt",originalFilename:"synthetic-upload.pdf",status:"active"};documents.push(document);return route.fulfill({json:{document}}); }
      if (suffix.endsWith("/download")) return route.fulfill({json:{downloadUrl:"#synthetic-document"}});
      if (suffix === "/reports/snapshot") { const payload=route.request().postDataJSON();expect(payload.privateDocumentIds).toEqual(["private-doc"]);return route.fulfill({json:{report:{id:"report-1"},warnings:{missingEvidence:1}}}); }
      if (suffix === "/reports/report-1/archive") return route.fulfill({json:{downloadUrl:"#synthetic-archive"}});
      return route.fulfill({
        status: 404,
        json: { error: "Synthetic route not configured" },
      });
    });
    await page.route(`${BASE_URL}/synthetic-put`,route=>route.fulfill({status:200,body:""}));
    await page.goto("/");
    await page.getByRole("button", { name: "Bookkeeping" }).click();
    await expect(
      page.getByRole("heading", { name: "Bookkeeping" }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Synthetic Portal Vendor" }),
    ).toBeVisible();
    await expect(page.getByText("EUR 15.50")).toBeVisible();
    await page.getByLabel("Search").fill("no match");
    await expect(page.getByText("No bookkeeping entries")).toBeVisible();
    await page.screenshot({
      path: ".tmp/bookkeeping-production-portal.png",
      fullPage: true,
    });
    await page.getByLabel("Search").fill("");
    await page.getByRole("button", { name: "Add entry" }).click();
    await page.locator(".bookkeeping-entry-dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toHaveText("Transaction date is required.");
    await expect(page.getByLabel("Transaction date")).toHaveAttribute("aria-invalid","true");
    await page.locator(".bookkeeping-entry-dialog").screenshot({path:".tmp/bookkeeping-production-validation.png"});
    const entryForm=page.locator(".bookkeeping-entry-dialog");await entryForm.getByLabel("Transaction date").fill("2026-10-03");await entryForm.getByLabel("Provider / payee").fill("Synthetic New");await entryForm.getByLabel("Description").fill("Synthetic created");await entryForm.getByLabel("Amount").fill("20");await entryForm.getByRole("button",{name:"Save"}).click();await expect(page.getByText("Synthetic New")).toBeVisible();
    const createdRow=page.getByRole("row").filter({hasText:"Synthetic New"});await createdRow.getByRole("button",{name:"Edit"}).click();await entryForm.getByLabel("Category").fill("synthetic-updated");await entryForm.screenshot({path:".tmp/bookkeeping-production-edit.png"});await entryForm.getByRole("button",{name:"Save"}).click();await expect(createdRow).toContainText("synthetic-updated");await createdRow.getByRole("button",{name:"Delete"}).click();await expect(page.getByRole("heading",{name:"Delete bookkeeping entry?"})).toBeVisible();await page.locator(".bookkeeping-delete-dialog").screenshot({path:".tmp/bookkeeping-production-delete.png"});await page.locator(".bookkeeping-delete-dialog").getByRole("button",{name:"Cancel"}).click();await createdRow.getByRole("button",{name:"Delete"}).click();await page.getByRole("button",{name:"Delete entry"}).click();await expect(page.getByText("Synthetic New")).not.toBeVisible();
    await page.getByRole("button",{name:"Set up business accounts"}).click();await expect(page.getByRole("status")).toContainText("2 business accounts ready");
    await page.getByRole("button",{name:"Upload PDF"}).click();await expect(page.getByRole("status")).toContainText("Choose a PDF first");await page.getByLabel("Link to transaction").selectOption("prod-synthetic");await page.getByLabel("PDF evidence").setInputFiles({name:"synthetic-upload.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-synthetic")});await page.getByRole("button",{name:"Upload PDF"}).click();await expect(page.getByText("synthetic-upload.pdf")).toBeVisible();await expect(page.getByRole("status")).toContainText("uploaded and verified");await page.getByRole("button",{name:/Unlink/}).click();await expect(page.getByRole("button",{name:/Unlink/})).toHaveCount(0);await page.getByText("synthetic-upload.pdf").locator("..").getByRole("button",{name:"Download"}).click();
    await page.getByLabel("synthetic-private.pdf").check();await page.getByLabel("Report month").fill("2026-10");await page.getByRole("button",{name:"Create monthly package"}).click();await expect(page.getByRole("status")).toContainText("missing-evidence");
    await page.route("**/work/api/bookkeeping/accounts/setup",route=>route.fulfill({status:500,json:{error:"Synthetic setup failure"}}));await page.getByRole("button",{name:"Set up business accounts"}).click();await expect(page.getByRole("status")).toContainText("Could not set up accounts");await page.screenshot({path:".tmp/bookkeeping-production-error.png",fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.body.classList.remove("sidebar-open"));await expect.poll(async()=>{const box=await page.locator("#sidebar").boundingBox();return box ? box.x + box.width : 0;}).toBeLessThanOrEqual(0);const dimensions=await page.locator(".bookkeeping-surface").evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth,viewport:document.documentElement.clientWidth,page:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);expect(dimensions.page).toBeLessThanOrEqual(390);await page.screenshot({path:".tmp/bookkeeping-production-mobile.png",fullPage:true});
    await context.close();
  });
});
