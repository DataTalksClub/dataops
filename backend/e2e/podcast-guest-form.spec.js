// Podcast guest materials form: phone layout, radio slot picker, guest-only
// wording, and the /podcast-docs/ alias (old /sponsor-docs/ links keep working).
const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;

async function api(path, body) {
  const response = await fetch(`${server.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  expect(response.ok, JSON.stringify(payload)).toBeTruthy();
  return payload;
}

test.describe("podcast guest materials form", () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot("podcast-guest-form"),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test("phone guest form: radios, guest wording, no horizontal scroll, submit reachable", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const episode = await api("/api/podcast-episodes", {
      season: 25,
      episode: 9,
      title: "Guest form e2e",
      guests: [{ name: "E2E Guest" }],
      status: "booked",
    });
    const { doc } = await api("/api/sponsor-docs", {
      cardId: episode.id,
      template: "podcast",
    });
    expect(doc.docUrl).toContain("/podcast-docs/");
    expect(doc.linkType).toBe("Guest materials");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `${server.baseURL}/podcast-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}`,
    );
    await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();

    // Guest-visible copy never says sponsor/sponsorship (the staff bar is
    // staff-only; this isolated server injects a staff actor for every
    // request, so scope the check to what a guest actually sees).
    const guestRegions = page.locator(
      ".sponsor-doc-meta, .sponsor-doc-form-card, [data-sponsor-export], .dk-auth-page__identity",
    );
    expect((await guestRegions.allInnerTexts()).join('\n')).not.toMatch(/sponsor/i);
    await expect(page.locator(".sponsor-doc-meta")).toContainText("Guest: E2E Guest");

    // Slot picker is radios: confirm + free Mon/Tue slots + reply-by-email none-fit.
    const radios = page.locator('[data-sponsor-radios="slotChoice"] input[type="radio"]');
    expect(await radios.count()).toBeGreaterThanOrEqual(2);
    const labels = await page
      .locator('[data-sponsor-radios="slotChoice"] .sponsor-doc-radio__text')
      .allInnerTexts();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) expect(label).not.toMatch(/slot:/);
    expect(labels[0]).toMatch(/works for me/);
    expect(labels.at(-1)).toMatch(/reply to the invite email/);
    expect(labels.some((label) => /· (12:30–13:30|17:00–18:00) Berlin/.test(label))).toBeTruthy();

    // No custom-slot text input for guests.
    await expect(page.locator("#sponsor-field-customSlot")).toHaveCount(0);

    // Phone viewport: no horizontal scroll.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    // Submit is reachable: scrolls into view, visible, enabled.
    const submit = page.locator('[data-sponsor-action="submit-ready"]');
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
  });

  test("old /sponsor-docs/ guest link still opens, gate copy is sponsor-free", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const episode = await api("/api/podcast-episodes", {
      season: 25,
      episode: 10,
      title: "Guest form alias e2e",
      guests: [{ name: "Alias Guest" }],
      status: "booked",
    });
    const { doc } = await api("/api/sponsor-docs", {
      cardId: episode.id,
      template: "podcast",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.baseURL}/sponsor-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}`);
    await expect(page.locator('[data-sponsor-view="editor"]')).toBeVisible();
    const aliasGuestRegions = page.locator(
      ".sponsor-doc-meta, .sponsor-doc-form-card, [data-sponsor-export]",
    );
    expect((await aliasGuestRegions.allInnerTexts()).join('\n')).not.toMatch(/sponsor/i);

    // Gate (no code): neutral copy, no sponsor wording. In this isolated
    // server every request resolves a staff actor, so the gate itself is
    // covered by frontend unit tests; here the anonymous API contract stays
    // neutral for real guests.
    const anonGate = await fetch(`${server.baseURL}/api/sponsor-docs/${doc.id}`, {
      headers: { "x-sponsor-doc-anonymous": "true" },
    });
    expect(anonGate.status).toBe(401);
    const anonBody = await anonGate.json();
    expect(anonBody.code).toBe("access_code_required");
    expect(anonBody.error).not.toMatch(/sponsor/i);
  });
});
