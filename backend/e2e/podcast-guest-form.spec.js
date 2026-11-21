// Podcast guest materials form: phone layout, radio slot picker, guest-only
// wording, and the /podcast-docs/ alias (old /sponsor-docs/ links keep working).
const { test, expect } = require("@playwright/test");
const { releaseFriday } = require("./helpers/release-friday");
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
        E2E_SEED_PODCAST_TEMPLATE: "1",
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
      releaseAssignmentStatus: "provisional",
      releaseDate: releaseFriday(14),
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
    // Episodes release strictly in number order: the first test's S25E9 is
    // on this same server two weeks out, so S25E8 releases the week before.
    const episode = await api("/api/podcast-episodes", {
      season: 25,
      episode: 8,
      releaseAssignmentStatus: "provisional",
      releaseDate: releaseFriday(7),
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
    expect(page.url()).toContain(`/podcast-docs/${doc.id}`);
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

  test("staff sees two tabs (Guest intake / Internal Team & Host) across desktop and phone; guest never sees internal data", async ({
    browser,
    page,
  }) => {
    test.setTimeout(60_000);
    const episode = await api("/api/podcast-episodes", {
      season: 26,
      episode: 2,
      releaseAssignmentStatus: "provisional",
      releaseDate: releaseFriday(21),
      title: "Two-tab podcast e2e",
      guests: [{ name: "Two-Tab Guest" }],
      status: "booked",
    });
    const { doc } = await api("/api/sponsor-docs", {
      cardId: episode.id,
      template: "podcast",
      content: {
        guestName: "Two-Tab Guest, Staff Engineer",
        introduction: "Guest public bio for intro.",
        topicsToCover: "Distributed systems & evals",
        topicsToAvoid: "Confidential client contracts",
        linkedinUrl: "https://example.test/linkedin",
        coldOpen: "SECRET_COLD_OPEN_HOOK",
        introScript: "SECRET_INTRO_SCRIPT",
        interviewQuestions: "SHARED_Q1_ARCHITECTURE\nSHARED_Q2_TRADEOFFS",
        closingScript: "SECRET_CLOSING_SCRIPT",
        goal: "SECRET_EPISODE_GOAL",
        audience: "SECRET_TARGET_AUDIENCE",
        keyMessages: "SECRET_KEY_MESSAGES",
        sourceLinks: "https://example.test/secret-research-source",
        keyInsights: "SECRET_CLAIM_LEDGER_INSIGHT",
        openQuestions: "SECRET_OPEN_ANGLE",
        hostNotes: "SECRET_HOST_TIMING_NOTE",
      },
    });

    // 1. Staff desktop view: sees two tabs, shared interviewQuestions on Guest tab, Host view + Edit prep & research
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${server.baseURL}/podcast-docs/${doc.id}`);
    await expect(page.locator('[data-podcast-tab="guest"]')).toBeVisible();
    await expect(page.locator('[data-podcast-tab="internal"]')).toBeVisible();
    await expect(page.locator('[data-podcast-panel="guest"]')).toBeVisible();
    await expect(page.locator("#sponsor-field-interviewQuestions")).toHaveValue(
      "SHARED_Q1_ARCHITECTURE\nSHARED_Q2_TRADEOFFS",
    );
    await expect(page.locator("#sponsor-field-coldOpen")).toHaveCount(0);

    await page.locator('[data-podcast-tab="internal"]').click();
    await expect(page.locator('[data-podcast-panel="internal"]')).toBeVisible();
    await expect(page.locator('[data-podcast-questions-view="readonly"]')).toBeVisible();
    await expect(page.locator('[data-podcast-host-block="coldOpen"]')).toContainText("SECRET_COLD_OPEN_HOOK");
    await expect(page.locator('[data-podcast-host-block="interviewQuestions"]')).toContainText("SHARED_Q1_ARCHITECTURE");
    await expect(page.locator('[data-podcast-host-block="topicsToAvoid"]')).toContainText("Confidential client contracts");
    await expect(page.locator('[data-podcast-host-block="hostNotes"]')).toContainText("SECRET_HOST_TIMING_NOTE");
    await expect(page.locator("[data-podcast-host-qna]")).toBeVisible();

    await page.locator('[data-podcast-internal-mode="edit"]').click();
    await expect(page.locator("#sponsor-field-interviewQuestions")).toHaveCount(0);
    await expect(page.locator("#sponsor-field-coldOpen")).toBeVisible();
    await expect(page.locator("#sponsor-field-sourceLinks")).toBeVisible();
    await page.locator("#sponsor-field-hostNotes").fill("SECRET_HOST_TIMING_NOTE_UPDATED");
    await page.locator('[data-sponsor-action="save-draft"]').click();
    await expect(page.locator("[data-sponsor-feedback]")).toContainText("Saved draft");

    // 2. Staff phone view (390px): zero horizontal overflow on both tabs
    await page.setViewportSize({ width: 390, height: 844 });
    const internalOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(internalOverflow.scrollWidth).toBeLessThanOrEqual(internalOverflow.clientWidth);

    await page.locator('[data-podcast-internal-mode="host"]').click();
    const hostOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(hostOverflow.scrollWidth).toBeLessThanOrEqual(hostOverflow.clientWidth);

    // 3. Anonymous guest browser context with valid ?code= (even requesting ?tab=internal&view=questions):
    //    sees interviewQuestions, never sees tabs, never sees View questions, never receives any internal content.
    const guestContext = await browser.newContext({
      extraHTTPHeaders: { "x-sponsor-doc-anonymous": "true" },
      viewport: { width: 390, height: 844 },
    });
    try {
      const guestPage = await guestContext.newPage();
      await guestPage.goto(
        `${server.baseURL}/podcast-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}&tab=internal&view=questions`,
      );
      await expect(guestPage.locator('[data-sponsor-view="editor"]')).toBeVisible();
      await expect(guestPage.locator('[data-podcast-tab]')).toHaveCount(0);
      await expect(guestPage.locator('[data-sponsor-action="toggle-questions-view"]')).toHaveCount(0);
      await expect(guestPage.locator("[data-sponsor-export]")).toHaveCount(0);
      await expect(guestPage.locator("#sponsor-field-guestName")).toHaveValue("Two-Tab Guest, Staff Engineer");
      await expect(guestPage.locator("#sponsor-field-interviewQuestions")).toHaveValue(
        "SHARED_Q1_ARCHITECTURE\nSHARED_Q2_TRADEOFFS",
      );
      const guestDomText = await guestPage.locator("body").innerText();
      for (const secretMarker of [
        "SECRET_COLD_OPEN_HOOK",
        "SECRET_INTRO_SCRIPT",
        "SECRET_CLOSING_SCRIPT",
        "SECRET_EPISODE_GOAL",
        "SECRET_CLAIM_LEDGER_INSIGHT",
        "SECRET_HOST_TIMING_NOTE",
      ]) {
        expect(guestDomText).not.toContain(secretMarker);
      }
      const guestOverflow = await guestPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(guestOverflow.scrollWidth).toBeLessThanOrEqual(guestOverflow.clientWidth);
    } finally {
      await guestContext.close();
    }

    // 4. Anonymous guest API & export negative check
    const anonDocRes = await fetch(
      `${server.baseURL}/api/sponsor-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}&tab=internal&view=questions`,
      { headers: { "x-sponsor-doc-anonymous": "true" } },
    );
    expect(anonDocRes.status).toBe(200);
    const anonDocBody = await anonDocRes.text();
    expect(anonDocBody).toContain("SHARED_Q1_ARCHITECTURE");
    expect(anonDocBody).not.toMatch(/SECRET_/);
    const anonDocJson = JSON.parse(anonDocBody).doc;
    expect(anonDocJson.viewerRole).toBe("sponsor");
    expect(anonDocJson.content.interviewQuestions).toBe("SHARED_Q1_ARCHITECTURE\nSHARED_Q2_TRADEOFFS");
    expect(anonDocJson.hostContext).toBeUndefined();
    expect(anonDocJson.emailDelivery).toBeUndefined();

    const anonExportRes = await fetch(
      `${server.baseURL}/api/sponsor-docs/${doc.id}/export?format=markdown&code=${encodeURIComponent(doc.accessCode)}`,
      { headers: { "x-sponsor-doc-anonymous": "true" } },
    );
    expect(anonExportRes.status).toBe(200);
    const anonExportText = await anonExportRes.text();
    expect(anonExportText).toContain("SHARED_Q1_ARCHITECTURE");
    expect(anonExportText).not.toMatch(/SECRET_/);
  });

  test("confirmed podcast recording time collapses into one compact line with Change toggle", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const episode = await api("/api/podcast-episodes", {
      season: 26,
      episode: 3,
      releaseAssignmentStatus: "provisional",
      releaseDate: releaseFriday(28),
      recordingDate: "2026-12-15",
      title: "Confirmed slot compact e2e",
      guests: [{ name: "Confirmed Guest" }],
      status: "booked",
    });
    const createdCard = await api(`/api/podcast-episodes/${episode.id}/card`, {});
    const cardId = createdCard.card?.id || createdCard.episode?.cardId;
    expect(cardId).toBeTruthy();
    const timeRes = await fetch(`${server.baseURL}/api/cards/${cardId}/time`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        at: "2026-12-15 18:00",
        guestEmails: ["confirmed-guest@example.test"],
      }),
    });
    const timePayload = await timeRes.json();
    expect(timePayload.card?.eventTime?.startIso, JSON.stringify(timePayload)).toBeTruthy();
    const { doc } = await api("/api/sponsor-docs", {
      cardId,
      template: "podcast",
      content: { guestName: "Confirmed Guest" },
    });

    const guestContext = await browser.newContext({
      extraHTTPHeaders: { "x-sponsor-doc-anonymous": "true" },
      viewport: { width: 1280, height: 900 },
    });
    try {
      const guestPage = await guestContext.newPage();
      await guestPage.goto(
        `${server.baseURL}/podcast-docs/${doc.id}?code=${encodeURIComponent(doc.accessCode)}`,
      );
      const summary = guestPage.locator('[data-podcast-recording-summary="confirmed"]');
      await expect(summary).toBeVisible();
      await expect(summary).toContainText("Confirmed");
      await expect(summary).toContainText("18:00");
      await expect(guestPage.locator('[data-podcast-action="change-recording-time"]')).toBeVisible();
      await expect(guestPage.locator('[data-sponsor-radios="slotChoice"]')).toHaveCount(0);
      await expect(guestPage.locator('[data-podcast-slot-picker="open"]')).toHaveCount(0);

      await guestPage.locator('[data-podcast-action="change-recording-time"]').click();
      await expect(guestPage.locator('[data-podcast-slot-picker="open"]')).toBeVisible();
      await expect(guestPage.locator('[data-sponsor-radios="slotChoice"]')).toBeVisible();

      await guestPage.setViewportSize({ width: 390, height: 844 });
      const expandedOverflow = await guestPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(expandedOverflow.scrollWidth).toBeLessThanOrEqual(expandedOverflow.clientWidth);

      await guestPage.locator('[data-podcast-action="cancel-recording-time"]').click();
      await expect(guestPage.locator('[data-podcast-slot-picker="open"]')).toHaveCount(0);
      await expect(guestPage.locator('[data-sponsor-radios="slotChoice"]')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
