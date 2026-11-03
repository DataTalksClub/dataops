import assert from "node:assert/strict";
import { test } from "node:test";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const candidate = {
  id: "pmc-0123456789abcdef0123456789abcdef",
  status: "candidate",
  provider: "ramp",
  receivedOn: "2026-10-29",
  invoiceNumber: "202610/50",
  amount: "1500.00",
  currency: "USD",
  payer: "PhoenixData",
  match: { dealId: "deal-1", organizationName: "PhoenixData", confidence: "exact", reasons: ["invoice number", "amount", "currency"] },
};

test("sponsors payment-mail lists, polls and confirms only with --apply", async () => {
  const originalFetch = globalThis.fetch;
  const calls = fakePortal({
    "GET /api/sponsor-crm/finance/payment-mail": ({ query }) => ({ items: [candidate], query }),
    "POST /api/sponsor-crm/finance/payment-mail/poll": ({ body }) => ({ state: "ok", scanned: 1, results: [{ outcome: "created", messageId: "<payment@example.test>" }], body }),
    [`GET /api/sponsor-crm/finance/payment-mail/${candidate.id}`]: candidate,
    "GET /api/sponsor-crm/deals/deal-1": { id: "deal-1", title: "Sponsor", version: 7 },
    "GET /api/sponsor-crm/deals/deal-1/finance": { finance: { version: 3 }, payments: [], paymentState: "unpaid" },
    "POST /api/sponsor-crm/deals/deal-1/finance/receipts": ({ body }) => ({ projection: { paymentState: "paid", finance: { evidence: [] }, payments: [] }, body }),
    [`POST /api/sponsor-crm/finance/payment-mail/${candidate.id}/confirmed`]: { ...candidate, status: "confirmed" },
  });
  try {
    const listed = captureIo();
    assert.equal(await run(["sponsors", "payment-mail", "list", "--status", "candidate", "--json"], listed), 0);
    assert.equal(listed.json().items[0].id, candidate.id);
    assert.deepEqual(calls[0].query, { status: "candidate" });

    const polled = captureIo();
    assert.equal(await run(["sponsors", "payment-mail", "poll", "--days", "7", "--json"], polled), 0);
    assert.deepEqual(calls.find((call) => call.route.endsWith("/poll")).body, { days: 7 });

    const dryRun = captureIo();
    assert.equal(await run(["sponsors", "payment-mail", "confirm", candidate.id, "--json"], dryRun), 0);
    assert.equal(dryRun.json().mode, "dry-run");
    assert.equal(calls.some((call) => call.route.endsWith("/receipts")), false);

    const applied = captureIo();
    assert.equal(await run(["sponsors", "payment-mail", "confirm", candidate.id, "--apply", "--json"], applied), 0);
    assert.equal(applied.json().mode, "apply");
    const receipt = calls.find((call) => call.route.endsWith("/receipts"));
    assert.equal(receipt.body.reference, "mail:ramp:202610/50");
    assert.match(receipt.headers["Idempotency-Key"], /^pmail-/);
    assert.equal(calls.some((call) => call.route.endsWith("/confirmed")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
