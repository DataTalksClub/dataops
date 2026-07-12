import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";

const root = path.join(__dirname, "..");

describe("newsletter fallback UI assets", () => {
  it("exposes the planner route, API, CRUD form, filters, and month/week views", async () => {
    const [html, app, api] = await Promise.all([
      fs.readFile(path.join(root, "src/pages/index.html"), "utf8"),
      fs.readFile(path.join(root, "src/public/app.js"), "utf8"),
      fs.readFile(path.join(root, "src/public/api.js"), "utf8"),
    ]);
    assert.ok(html.includes('href="#/newsletter"'));
    assert.ok(api.includes("newsletterSlots"));
    assert.ok(api.includes("/api/newsletter-slots"));
    for (const marker of [
      "renderNewsletter",
      "newsletter-add",
      "newsletter-status",
      "newsletter-booked",
      "Save slot",
      "No newsletter slots",
      "Could not load newsletter schedule",
      "installNewsletterPeriodView",
      "newsletter-view",
      "Month",
      "Week",
      "week ",
    ])
      assert.ok(app.includes(marker), marker);
  });
});
