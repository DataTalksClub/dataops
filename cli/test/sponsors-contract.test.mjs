import assert from "node:assert/strict";
import { test } from "node:test";
import { contract, update } from "../src/commands/sponsors.mjs";
import { ApiError } from "../src/api.mjs";

const TOKEN = "sanitized-test-token";

function mockFetch(handler) {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = TOKEN;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return handler({ url, ...options });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (oldToken === undefined) delete process.env.DATAOPS_TOKEN;
      else process.env.DATAOPS_TOKEN = oldToken;
    },
  };
}

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });
const printed = () => {
  const lines = [];
  return { lines, io: { print(line) { lines.push(String(line)); } } };
};

const terms = {
  company: "Acme GmbH",
  legalPayer: "Acme Holding GmbH",
  payerCountry: "DE",
  scope: "One newsletter slot",
  priceEur: 2500,
  startDate: "2026-04-15",
  endDate: "2026-07-15",
};

test("sponsors contract create posts deal terms and reports the draft status", async () => {
  const fetch = mockFetch(({ url, method }) => {
    assert.ok(url.endsWith("/api/sponsor-crm/contracts"));
    assert.equal(method, "POST");
    return ok({ id: "contract-1", status: "draft", terms, signers: [] });
  });
  try {
    const { lines, io } = printed();
    const result = await contract({ _: ["create"], dealId: "deal-1", data: JSON.stringify(terms) }, io);
    assert.equal(result.id, "contract-1");
    assert.equal(result.status, "draft");
    const body = JSON.parse(fetch.calls[0].body);
    assert.deepEqual(body, { dealId: "deal-1", terms });
    assert.ok(lines.some((line) => line.includes("contract-1") && line.includes("draft")));
  } finally {
    fetch.restore();
  }
});

test("sponsors contract send mints signing links and prints delivery", async () => {
  const fetch = mockFetch(({ url, method }) => {
    assert.ok(url.endsWith("/api/sponsor-crm/contracts/contract-1/send"));
    assert.equal(method, "POST");
    return ok({
      contract: { id: "contract-1", status: "sent" },
      emailDelivery: { state: "sent", to: "sponsor@example.test" },
      signingUrls: { sponsor: "https://sign.example.test/s?token=a", counter: "https://sign.example.test/c?token=b" },
    });
  });
  try {
    const { lines, io } = printed();
    const result = await contract({ _: ["send", "contract-1"], expiresDays: "7" }, io);
    assert.equal(result.contract.status, "sent");
    assert.deepEqual(JSON.parse(fetch.calls[0].body), { expiresDays: 7 });
    assert.ok(lines.some((line) => line.includes("sent") && line.includes("sponsor@example.test")));
    assert.ok(lines.some((line) => line.includes("https://sign.example.test/s?token=a")));
  } finally {
    fetch.restore();
  }
});

test("sponsors contract status shows the current lifecycle state", async () => {
  const fetch = mockFetch(({ url, method }) => {
    assert.ok(url.endsWith("/api/sponsor-crm/contracts/contract-1"));
    assert.equal(method, "GET");
    return ok({ id: "contract-1", status: "viewed", dealId: "deal-1", terms: { signingOrder: "sponsor-first" }, signers: [] });
  });
  try {
    const { lines, io } = printed();
    const result = await contract({ _: ["status", "contract-1"] }, io);
    assert.equal(result.status, "viewed");
    assert.ok(lines.some((line) => line.includes("viewed")));
  } finally {
    fetch.restore();
  }
});

test("sponsors contract audit and verify reach their endpoints", async () => {
  const fetch = mockFetch(({ url, method }) => ok(
    url.endsWith("/audit")
      ? { items: [{ action: "sent", role: "sponsor" }, { action: "viewed", role: "sponsor" }] }
      : { intact: true, expected: "abc", actual: "abc" },
  ));
  try {
    const audit = await contract({ _: ["audit", "contract-1"], json: true }, { print() {} });
    assert.deepEqual(audit.items.map((item) => item.action), ["sent", "viewed"]);
    const verify = await contract({ _: ["verify", "contract-1"], json: true }, { print() {} });
    assert.equal(verify.intact, true);
    assert.ok(fetch.calls[0].url.endsWith("/api/sponsor-crm/contracts/contract-1/audit"));
    assert.ok(fetch.calls[1].url.endsWith("/api/sponsor-crm/contracts/contract-1/verify"));
  } finally {
    fetch.restore();
  }
});

test("marking a deal agreed without a signed contract fails with the gate error", async () => {
  const fetch = mockFetch(() => ok(
    { error: "A signed contract is required before this deal can be marked agreed", code: "signed_contract_required" },
    422,
  ));
  try {
    await assert.rejects(
      () => update({ _: ["deals", "deal-1"], data: JSON.stringify({ status: "agreed", version: 3 }), json: true }, { print() {} }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, "signed_contract_required");
        assert.match(error.message, /signed contract is required/i);
        return true;
      },
    );
    const sent = fetch.calls[0];
    assert.ok(sent.url.endsWith("/api/sponsor-crm/deals/deal-1"));
    assert.equal(sent.method, "PUT");
  } finally {
    fetch.restore();
  }
});

test("an unknown contract action names the supported verbs", async () => {
  const fetch = mockFetch(() => ok({}));
  try {
    await assert.rejects(() => contract({ _: ["notarize", "contract-1"], json: true }, { print() {} }), /create, send, resend, status, audit or verify/);
    assert.equal(fetch.calls.length, 0);
  } finally {
    fetch.restore();
  }
});
