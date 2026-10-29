// Run from repository root: node frontend/e2e/template-view.mjs
// Integrated renderer, real Markdown and clipboard, synthetic content only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("backend/package.json"));
const { chromium } = require("playwright");
const root = path.resolve("frontend");
const screenshots = process.env.KBP_SCREENSHOTS || ".tmp/screenshots/kbp";
await mkdir(screenshots, { recursive: true });
const body = "Subject: Review for <RECIPIENT_NAME>\n\nHello <RECIPIENT_NAME>,\n\nPlease review the draft at <REVIEW_URL>.\n\nThanks,\nThe example team";
const markdown = `# Synthetic review message\n\n## Template\n\n\`\`\`text\n${body}\n\`\`\`\n\n## Placeholders\n\n| Placeholder | What to put there | Example |\n| --- | --- | --- |\n| \`<RECIPIENT_NAME>\` | The recipient's first name | Taylor |\n| \`<REVIEW_URL>\` | Link to the draft for review | https://example.test/draft |\n\n## How to send\n\nRead [the review guide](https://example.test/guide) before sending.\n\n## Sent example\n\nHello Taylor, please review the example draft.\n`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/fixture") {
      const index = await readFile(path.join(root, "index.html"), "utf8");
      const styles = index.match(/<link rel="stylesheet"[^>]*>/g).join("\n");
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local synthetic KB template fixture</title>${styles}</head><body data-workspace-view="docs"><main style="max-width: 1080px; margin: 32px auto; padding: 16px"><p>LOCAL · SYNTHETIC FIXTURE</p><h1>Synthetic review message</h1><section id="viewer"></section></main></body></html>`);
      return;
    }
    if (url.pathname === "/synthetic/templates/review.md") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(await readFile(path.join(root, "index.html")));
      return;
    }
    const file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.evaluate(async (markdown) => {
    const { createTemplateViewSurface } = await import("/src/surfaces/knowledge/template-view.js");
    const { createEditorMarkdown } = await import("/src/surfaces/document-editor/markdown.js");
    const state = { currentDoc: { docType: "template", path: "content/synthetic/templates/review.md" } };
    const text = document.createElement("textarea");
    text.value = markdown;
    const editorView = document.createElement("div");
    editorView.dataset.mode = "rendered";
    const markdownServices = createEditorMarkdown({ documentState: state, resolveMarkdownDocLink: () => null });
    const surface = createTemplateViewSurface();
    window.renderTemplateFixture = (source) => surface.renderTemplateView(document.querySelector("#viewer"), source, markdownServices);
    window.renderTemplateFixture(markdown);
  }, markdown);
  const chips = page.locator(".template-placeholder-chip");
  assert.equal(await chips.count(), 3);
  assert.equal(await page.locator(".template-view-body").textContent(), body);
  await chips.first().focus();
  assert.match(await page.getByRole("complementary", { name: "Placeholder details" }).innerText(), /recipient's first name[\s\S]*Taylor/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await chips.last().evaluate(node => node === document.activeElement), true);
  assert.match(await page.locator(".template-placeholder-panel").innerText(), /draft for review[\s\S]*https:\/\/example.test\/draft/);
  await page.screenshot({ path: path.join(screenshots, "local-template-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Copy template", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body);
  assert.equal(await page.getByRole("status").innerText(), "Template copied");
  await page.getByText("Full document and sending instructions", { exact: true }).click();
  assert.ok(await page.getByRole("link", { name: "the review guide" }).isVisible());
  assert.ok(await page.getByRole("heading", { name: "Sent example" }).isVisible());
  await page.screenshot({ path: path.join(screenshots, "local-template-instructions.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await chips.last().click();
  assert.ok(await page.locator(".template-placeholder-panel").isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(screenshots, "local-template-mobile.png"), fullPage: true });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  await page.getByRole("button", { name: "Copy template", exact: true }).click();
  assert.match(await page.getByRole("status").innerText(), /Copy failed/);
  await page.evaluate(() => delete navigator.clipboard);
  const multi = markdown.replace("## Template\n\n", "## Template\n\n### Initial request\n\n")
    .replace("\n## Placeholders", "\n### Follow-up\n\nUse after the initial message.\n\n```text\nReminder for <RECIPIENT_NAME>: <REVIEW_URL>\n```\n\n## Placeholders");
  await page.evaluate(source => window.renderTemplateFixture(source), multi);
  assert.equal(await page.locator(".template-variant").count(), 2);
  await page.getByRole("button", { name: "Copy Follow-up", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Reminder for <RECIPIENT_NAME>: <REVIEW_URL>");
  await page.getByRole("button", { name: "Copy Initial request", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body);
  await page.locator(".template-variant").last().getByRole("button", { name: "Explain <REVIEW_URL>" }).focus();
  await page.screenshot({ path: path.join(screenshots, "local-template-variants-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(screenshots, "local-template-variants-desktop.png"), fullPage: true });
  // Actual application shell and document routing, with every API response sanitized.
  const portal = await context.newPage();
  portal.on("pageerror", error => errors.push(error.message));
  await portal.addInitScript(() => {
    localStorage.setItem("dataops_token", "synthetic-fixture-token");
    localStorage.setItem("dataops_user", JSON.stringify({ id: "synthetic-user", name: "Synthetic Operator", email: "operator@example.test" }));
  });
  await portal.route("**/*", route => {
    if (!["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    const url = new URL(route.request().url());
    const document = { path: "content/synthetic/templates/review.md", title: "Synthetic review message", doc_type: "template", systems: [], tags: [] };
    if (url.pathname === "/docs") return route.fulfill({ json: url.searchParams.has("path") ? {
      ...document, content: `---\ndoc_type: template\ntitle: Synthetic review message\n---\n\n${multi}`, revision: "synthetic-r1", parsed: { frontmatter: { title: document.title, doc_type: "template" }, sections: {} },
    } : { documents: [document] } });
    if (url.pathname === "/parse") return route.fulfill({ json: { parsed: { frontmatter: { title: document.title }, sections: {} } } });
    if (url.pathname === "/api/me") return route.fulfill({ json: { user: { id: "synthetic-user", name: "Synthetic Operator", email: "operator@example.test" } } });
    return route.fulfill({ json: { items: [], cards: [], tasks: [], templates: [], people: [], users: [], findings: [], counts: {}, revision: "synthetic-r1" } });
  });
  await portal.goto(`http://127.0.0.1:${server.address().port}/synthetic/templates/review.md`);
  await portal.locator(".template-variant").first().waitFor();
  assert.equal(await portal.locator(".template-variant").count(), 2);
  assert.equal(await portal.locator("#document-path").textContent(), "content/synthetic/templates/review.md");
  assert.ok(await portal.getByRole("heading", { name: "Synthetic review message", exact: true }).isVisible());
  await portal.getByText("Full document and sending instructions", { exact: true }).click();
  assert.ok(await portal.getByRole("link", { name: "the review guide" }).isVisible());
  assert.ok(await portal.locator(".template-document [contenteditable=true]").count() > 0);
  await portal.getByText("Full document and sending instructions", { exact: true }).click();
  await portal.getByRole("button", { name: "Copy Follow-up", exact: true }).click();
  assert.equal(await portal.evaluate(() => navigator.clipboard.readText()), "Reminder for <RECIPIENT_NAME>: <REVIEW_URL>");
  await portal.locator(".template-variant").first().getByRole("button", { name: "Explain <RECIPIENT_NAME>" }).first().focus();
  await portal.locator("#editor-view").evaluate(node => { node.scrollTop = 0; });
  await portal.screenshot({ path: path.join(screenshots, "local-portal-template-desktop.png"), fullPage: true });
  await portal.setViewportSize({ width: 390, height: 844 });
  await portal.keyboard.press("Escape");
  await portal.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 0);
  assert.equal(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await portal.locator("#editor-view").evaluate(node => { node.scrollTop = 0; });
  await portal.screenshot({ path: path.join(screenshots, "local-portal-template-mobile.png"), fullPage: true });
  // Inline source edits must refresh the preview without rebuilding the active editor.
  await portal.getByText("Full document and sending instructions", { exact: true }).click();
  const sourceCode = portal.locator(".template-document .notion-text-content.code").first();
  await sourceCode.fill("```text\nUPDATED <RECIPIENT_NAME>\n```");
  await portal.waitForFunction(() => document.querySelector(".template-view-body")?.textContent === "UPDATED <RECIPIENT_NAME>");
  assert.equal(await sourceCode.evaluate(node => node === document.activeElement), true);
  await sourceCode.press("Tab");
  assert.equal(await portal.locator(".template-view-body").first().textContent(), "UPDATED <RECIPIENT_NAME>");
  await portal.getByRole("button", { name: "Copy Initial request", exact: true }).click();
  assert.equal(await portal.evaluate(() => navigator.clipboard.readText()), "UPDATED <RECIPIENT_NAME>");
  // Removing the body fence must remove its copy action rather than retaining stale content.
  const followupCode = portal.locator(".template-document .notion-text-content.code").last();
  await followupCode.fill("No fenced template body");
  await followupCode.press("Tab");
  await sourceCode.fill("No fenced template body");
  await sourceCode.press("Tab");
  assert.equal(await portal.locator(".template-view .template-variant").count(), 0);
  assert.match(await portal.locator(".template-view").innerText(), /Template preview unavailable/);
  assert.deepEqual(errors, []);
  console.log(`PASS: integrated template viewer desktop/mobile, keyboard, exact clipboard, supplemental links, copy failure. Local screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
