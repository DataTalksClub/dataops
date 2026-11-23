import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const { normalizeBullets, planBlock, sponsorBlockData } = await import("../src/commands/newsletterRelay.mjs");

const ISSUE = "12407b2e83f5fbda0ed906b74bb22dcee8d4a44fe0335963c809448de39ae9ce";
const DOC = "sdoc-d0a3e321eb3e7aaf";
const RELAY_KEY = "test-relay-sync";
const CTA = "https://www.astronomer.io/events/webinar/?utm_source=data-talks-club";
const IMAGE = "https://ops.dtcdev.click/api/public-images/ba5f0c0c.png";

const issue = (overrides = {}) => ({
  id: ISSUE,
  label: "Weekly #303",
  issueNumber: 303,
  slots: { primary: { documentUrl: `https://ops.dtcdev.click/sponsor-docs/${DOC}`, sponsor: "Astronomer" }, secondary: {} },
  finalRender: { relayIssueKey: RELAY_KEY },
  ...overrides,
});

const doc = (content = {}) => ({
  doc: {
    id: DOC,
    template: "newsletter-main",
    status: "submitted",
    sponsorName: "Astronomer",
    content: {
      title: "How to run AI pipelines with Snowflake and Airflow",
      graphicsUrl: IMAGE,
      intro: "Join Astronomer and Snowflake on December 3.\n\nPlus, you’ll learn how to:\n",
      bullets: "- Keep agent tasks from failing silently\n- Sign off on agent output\n- Get full observability",
      closing: "Register for the Astronomer webinar.",
      ctaText: "Register now",
      ctaUrl: CTA,
      subjectLine: "not mapped",
      ...content,
    },
  },
});

const EXPECTED = {
  kicker: "SPONSORED",
  title: "How to run AI pipelines with Snowflake and Airflow",
  image_url: IMAGE,
  image_link: CTA,
  body: "Join Astronomer and Snowflake on December 3.\n\nPlus, you’ll learn how to:",
  bullets: "Keep agent tasks from failing silently\nSign off on agent output\nGet full observability",
  closing: "Register for the Astronomer webinar.",
  cta_text: "Register now",
  cta_url: CTA,
};

const relayIssue = (blocks, campaign = null) => ({
  issue: { key: RELAY_KEY, campaign, blocks },
});

const block = (id, position, type, data = {}, extra = {}) => ({ id, position, type, data, needs_review: false, problems: [], ...extra });

function portal(relayBlocks, routes = {}, campaign = null) {
  return fakePortal({
    [`GET /api/newsletter-issues/${ISSUE}`]: () => issue(),
    [`GET /api/sponsor-docs/${DOC}`]: () => doc(),
    [`GET /api/newsletter-issues/${RELAY_KEY}`]: () => relayIssue(relayBlocks, campaign),
    [`PUT /api/newsletter-issues/${RELAY_KEY}/blocks/11`]: (call) => ({ block: { ...block(11, 1, call.body.type, call.body.data) } }),
    [`POST /api/newsletter-issues/${RELAY_KEY}/blocks`]: (call) => ({ status: 201, body: { block: block(42, call.body.position ?? 9, call.body.type, call.body.data) } }),
    ...routes,
  });
}

const relayWrites = (calls) => calls.filter((call) => call.method !== "GET" && call.route.includes(RELAY_KEY));

describe("newsletter relay-sync", () => {
  beforeEach(() => {
    process.env.RELAY_API_KEY = "relay_test_key";
    process.env.RELAY_URL = "https://relay.test";
  });
  afterEach(() => {
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_URL;
  });

  test("maps title, kicker, body, bullets, closing, image and CTA from the sponsor doc", () => {
    assert.deepEqual(sponsorBlockData(doc().doc), EXPECTED);
    assert.equal(normalizeBullets("• one\n→ two\n\n1. three\n* four"), "one\ntwo\nthree\nfour");
  });

  test("updates the existing sponsor placeholder with one per-block PUT", async () => {
    const calls = portal([
      block(10, 0, "intro", { summary: "Hi" }),
      block(11, 1, "sponsor", {}, { needs_review: true }),
      block(12, 2, "course_promo", { title: "Course" }),
    ]);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE, "--slot", "primary"], io), 0, io.errors.join("\n"));
    const writes = relayWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT");
    assert.equal(writes[0].route, `/api/newsletter-issues/${RELAY_KEY}/blocks/11`);
    assert.deepEqual(writes[0].body, { type: "sponsor", data: EXPECTED });
    assert.equal(writes[0].headers.Authorization, "Bearer relay_test_key");
    assert.ok(Buffer.byteLength(JSON.stringify(writes[0].body)) < 8000);
    assert.match(io.text(), /block: updated #11 sponsor at position 1/);
    assert.ok(!io.text().includes("relay_test_key"), "the Relay key is never printed");
  });

  test("is idempotent: a block already matching the doc is not rewritten", async () => {
    const calls = portal([block(10, 0, "intro"), block(11, 1, "sponsor", { ...EXPECTED })]);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE], io), 0, io.errors.join("\n"));
    assert.equal(relayWrites(calls).length, 0);
    assert.match(io.text(), /block: unchanged #11 sponsor/);
  });

  test("keeps the block's meta line and never adds a second sponsor block", async () => {
    const calls = portal([block(10, 0, "intro"), block(11, 1, "sponsor", { title: "Old", meta: "Dec 3" })]);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE], io), 0, io.errors.join("\n"));
    const writes = relayWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT");
    assert.deepEqual(writes[0].body.data, { ...EXPECTED, meta: "Dec 3" });
  });

  test("adds the sponsor block after the intro when the issue has none", async () => {
    const calls = portal([block(10, 0, "intro"), block(12, 1, "course_update", { title: "x" })]);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE], io), 0, io.errors.join("\n"));
    const writes = relayWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "POST");
    assert.deepEqual(writes[0].body, { type: "sponsor", data: EXPECTED, position: 1 });
    assert.match(io.text(), /block: added #42 sponsor/);
  });

  test("the secondary slot fills the sponsor_secondary block", () => {
    const plan = planBlock([block(10, 0, "intro"), block(11, 1, "sponsor"), block(13, 2, "sponsor_secondary")], "secondary");
    assert.equal(plan.existing.id, 13);
    assert.equal(plan.type, "sponsor_secondary");
    const fresh = planBlock([block(10, 0, "intro"), block(11, 1, "sponsor")], "secondary");
    assert.deepEqual(fresh, { existing: null, type: "sponsor_secondary", position: 2 });
  });

  test("two sponsor blocks need --block-id", async () => {
    const calls = portal([block(11, 1, "sponsor"), block(14, 2, "sponsor")]);
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "relay-sync", ISSUE], io), 0);
    assert.match(io.errors.join("\n"), /2 "sponsor" blocks: 11 \(position 1\), 14 \(position 2\)/);
    assert.equal(relayWrites(calls).length, 0);
  });

  test("dry run reads both sides and writes nothing", async () => {
    const calls = portal([block(10, 0, "intro"), block(11, 1, "sponsor", {}, { needs_review: true })]);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE, "--dry-run"], io), 0, io.errors.join("\n"));
    assert.equal(relayWrites(calls).length, 0);
    assert.match(io.text(), /block: would update #11 sponsor/);
  });

  test("refuses a block body over the per-request limit (CloudFront WAF ~8 KB)", async () => {
    const calls = portal([block(11, 1, "sponsor")], {
      [`GET /api/sponsor-docs/${DOC}`]: () => doc({ intro: "x".repeat(9000) }),
    });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "relay-sync", ISSUE], io), 0);
    assert.match(io.errors.join("\n"), /over the 7000-byte per-request limit/);
    assert.equal(relayWrites(calls).length, 0);
  });

  test("refuses an issue whose campaign is past draft", async () => {
    const calls = portal([block(11, 1, "sponsor")], {}, { id: 5, status: "sent" });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "relay-sync", ISSUE], io), 0);
    assert.match(io.errors.join("\n"), /has a sent campaign/);
    assert.equal(relayWrites(calls).length, 0);
  });

  test("--relay-key overrides the issue's final-render key; no key is a usage error", async () => {
    const calls = portal([block(11, 1, "sponsor", { ...EXPECTED })], {
      [`GET /api/newsletter-issues/${ISSUE}`]: () => issue({ finalRender: null }),
    });
    const bare = captureIo();
    assert.notEqual(await run(["newsletter", "relay-sync", ISSUE], bare), 0);
    assert.match(bare.errors.join("\n"), /has no Relay issue key/);
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE, "--relay-key", RELAY_KEY], io), 0, io.errors.join("\n"));
    assert.ok(calls.some((call) => call.route === `/api/newsletter-issues/${RELAY_KEY}`));
  });

  test("an issue number resolves to the weekly issue", async () => {
    const calls = portal([block(11, 1, "sponsor", { ...EXPECTED })], {
      "GET /api/newsletter-issues": () => ({ items: [{ id: ISSUE, issueNumber: 303 }, { id: "other", issueNumber: 304 }] }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", "303"], io), 0, io.errors.join("\n"));
    assert.ok(calls.some((call) => call.route === `/api/newsletter-issues/${ISSUE}`));
  });

  test("without RELAY_API_KEY the key comes from the DataOps secret", async () => {
    delete process.env.RELAY_API_KEY;
    const calls = portal([block(11, 1, "sponsor", { ...EXPECTED })], {
      "GET /api/secrets/relay-production.dtc-newsletter-api-key": () => ({ secret: { fields: { value: "relay_from_secret" } } }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "relay-sync", ISSUE], io), 0, io.errors.join("\n"));
    const relayGet = calls.find((call) => call.route === `/api/newsletter-issues/${RELAY_KEY}`);
    assert.equal(relayGet.headers.Authorization, "Bearer relay_from_secret");
    assert.match(io.text(), /key from dataops secret relay-production\.dtc-newsletter-api-key/);
    assert.ok(!io.text().includes("relay_from_secret"));
  });
});
