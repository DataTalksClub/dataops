import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const RATE_CARD = {
  meta: {
    title: "DataTalks.Club commercial offers",
    currency_default: "EUR",
    media_kit_url: "https://datatalks.club/mediakit/",
    floor_eur: 1000,
    rule: "Never invent rates or packages not listed here or in the live media kit.",
    as_of: "2026-10-19",
    valid_from: "2026-01-01",
    valid_until: "2026-12-31",
  },
  validity: {
    asOf: "2026-10-19",
    validFrom: "2026-01-01",
    validUntil: "2026-12-31",
  },
  offers: [
    {
      id: "newsletter-primary",
      slug: "newsletter-primary",
      name: "Newsletter primary (main) slot",
      channels: ["newsletter", "main"],
      price: { amount: 1500, currency: "EUR", range: null },
      priceEur: 1500,
      priceUsd: null,
      currency: "EUR",
      price_note: "2026 live rate card / INDEX",
      notes: "2026 live rate card / INDEX",
      validity: { asOf: "2026-10-19", validFrom: "2026-01-01", validUntil: "2026-12-31" },
      deliverables: ["Primary/main slot in weekly newsletter (typically Monday)"],
      when_to_offer: ["They ask newsletter or primary pricing"],
      when_to_deflect_elsewhere: [],
      templates: ["reply.pricing-newsletter"],
      pitch_snippets: [],
      does_not_offer: [],
      evidence_strength: "high",
      skill_tags: ["newsletter", "sponsor"],
    },
  ],
  packages: [
    {
      id: "newsletter-primary",
      slug: "newsletter-primary",
      name: "Newsletter primary (main) slot",
      channels: ["newsletter", "main"],
      price: { amount: 1500, currency: "EUR", range: null },
      priceEur: 1500,
      priceUsd: null,
      currency: "EUR",
      price_note: "2026 live rate card / INDEX",
      notes: "2026 live rate card / INDEX",
      validity: { asOf: "2026-10-19", validFrom: "2026-01-01", validUntil: "2026-12-31" },
      deliverables: ["Primary/main slot in weekly newsletter (typically Monday)"],
      when_to_offer: ["They ask newsletter or primary pricing"],
      when_to_deflect_elsewhere: [],
      templates: ["reply.pricing-newsletter"],
      pitch_snippets: [],
      does_not_offer: [],
      evidence_strength: "high",
      skill_tags: ["newsletter", "sponsor"],
    },
  ],
  non_offers: [
    {
      slug: "no-free-organic",
      name: "Free / organic editorial",
      response: "Direct no; send media kit",
      templates: ["reply.no-free-organic"],
      evidence: [],
    },
  ],
  inbound_routing: [
    {
      inbound_type: "newsletter_pricing",
      offer_slugs: ["newsletter-primary"],
    },
  ],
  version: 3,
};

describe("CLI offers", () => {
  beforeEach(() => {
    isolateConfig();
  });

  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("list and list --json read the rate card", async () => {
    const io = captureIo();
    const portal = fake({ "GET /api/offers": { status: 200, body: RATE_CARD } });
    try {
      const code = await run(["offers", "list"], io);
      assert.equal(code, 0);
      assert.match(io.text(), /DataTalks\.Club commercial offers/);
      assert.match(io.text(), /newsletter-primary/);
      assert.match(io.text(), /1500 EUR/);

      const jsonIo = captureIo();
      const jsonCode = await run(["offers", "list", "--json"], jsonIo);
      assert.equal(jsonCode, 0);
      const parsed = JSON.parse(jsonIo.text());
      assert.equal(parsed.offers.length, 1);
      assert.equal(parsed.offers[0].slug, "newsletter-primary");
      assert.equal(parsed.validity.validFrom, "2026-01-01");
    } finally {
      portal.restore();
    }
  });

  test("show <slug> and show <slug> --json read one offer package", async () => {
    const pkg = {
      ...RATE_CARD.offers[0],
      offer: RATE_CARD.offers[0],
      package: RATE_CARD.offers[0],
      rateCardValidity: RATE_CARD.validity,
      version: 3,
    };
    const io = captureIo();
    const portal = fake({ "GET /api/offers/newsletter-primary": { status: 200, body: pkg } });
    try {
      const code = await run(["offers", "show", "newsletter-primary"], io);
      assert.equal(code, 0);
      assert.match(io.text(), /Newsletter primary \(main\) slot/);
      assert.match(io.text(), /1500 EUR/);

      const jsonIo = captureIo();
      const jsonCode = await run(["offers", "show", "newsletter-primary", "--json"], jsonIo);
      assert.equal(jsonCode, 0);
      const parsed = JSON.parse(jsonIo.text());
      assert.equal(parsed.slug, "newsletter-primary");
      assert.equal(parsed.price.amount, 1500);
    } finally {
      portal.restore();
    }
  });

  test("update <slug> reads version first and updates package fields", async () => {
    const io = captureIo();
    const portal = fake({
      "GET /api/offers": { status: 200, body: RATE_CARD },
      "PUT /api/offers/newsletter-primary": (call) => ({
        status: 200,
        body: {
          ...RATE_CARD.offers[0],
          price: call.body.price,
          notes: call.body.notes,
          version: 4,
        },
      }),
    });
    try {
      const code = await run([
        "offers",
        "update",
        "newsletter-primary",
        "--price",
        "1600",
        "--price-usd",
        "1750",
        "--notes",
        "Updated rate",
        "--valid-from",
        "2026-01-01",
        "--valid-until",
        "2026-12-31",
      ], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 2);
      assert.equal(portal.calls[1].route, "/api/offers/newsletter-primary");
      assert.equal(portal.calls[1].body.expectedVersion, 3);
      assert.equal(portal.calls[1].body.price.amount, 1600);
      assert.equal(portal.calls[1].body.price.usd, 1750);
      assert.equal(portal.calls[1].body.notes, "Updated rate");
    } finally {
      portal.restore();
    }
  });

  test("import --from-file imports offers.json with validity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "offers-import-"));
    const file = path.join(dir, "offers.json");
    writeFileSync(file, JSON.stringify({
      meta: RATE_CARD.meta,
      offers: RATE_CARD.offers,
      non_offers: RATE_CARD.non_offers,
      inbound_routing: RATE_CARD.inbound_routing,
    }));
    const io = captureIo();
    const portal = fake({
      "GET /api/offers": { status: 200, body: { ...RATE_CARD, version: 0 } },
      "PUT /api/offers": () => ({ status: 200, body: { ...RATE_CARD, version: 1 } }),
    });
    try {
      const code = await run(["offers", "import", "--from-file", file], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 2);
      assert.equal(portal.calls[1].route, "/api/offers");
      assert.equal(portal.calls[1].body.expectedVersion, 0);
      assert.equal(portal.calls[1].body.offers.length, 1);
      assert.equal(portal.calls[1].body.validity.validFrom, "2026-01-01");
      assert.equal(portal.calls[1].body.validity.validUntil, "2026-12-31");
    } finally {
      portal.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent-guide documents dataops offers list/show/update/import", async () => {
    const io = captureIo();
    const code = await run(["agent-guide"], io);
    assert.equal(code, 0);
    assert.match(io.text(), /dataops offers list --json/);
    assert.match(io.text(), /dataops offers show <slug> --json/);
    assert.match(io.text(), /dataops offers update/);
  });
});
