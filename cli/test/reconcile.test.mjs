import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upload, confirm, report, alias, aliases, balances, commands } from "../src/commands/reconcile.mjs";

const withFakePortal = async (routes, run) => {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body, headers: options.headers || {} });
    for (const [match, respond] of [...routes].sort((left, right) => String(right[0]).length - String(left[0]).length)) {
      if (typeof match === "string" ? url.includes(match) : match(url)) {
        const body = typeof respond === "function" ? respond({ url: String(url), options }) : respond;
        return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}));
      }
    }
    return new Response(JSON.stringify({ error: `no fake for ${url}` }), { status: 404 });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
};

const args = { url: "https://portal.example.test", json: true };

test("upload stores the raw statement, parses it and saves rows for matching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "statement.csv");
  await writeFile(path, "Date,Description,Amount,Currency,Reference\n2026-10-05,Transfer from Sponsor One,1000.00,EUR,20261012\n");
  const parsedRows = [{ date: "2026-10-05", amount: "1000.00", currency: "EUR", counterparty: "Transfer from Sponsor One", reference: "20261012" }];
  await withFakePortal([
    ["https://private.example.test/object", ""],
    ["/documents/prepare", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.documentType, "bank-statement");
      assert.equal(body.accountId, "revolut");
      assert.equal(body.statementMonth, "2026-10");
      assert.equal(body.contentType, "text/csv");
      assert.match(body.idempotencyKey, /^statement-[0-9a-f]{64}$/);
      return { document: { id: "stmt-doc" }, uploadUrl: "https://private.example.test/object", uploadHeaders: { "content-type": "text/csv" } };
    }],
    ["/documents/stmt-doc/complete", { document: { id: "stmt-doc" } }],
    ["/reconcile/statements/parse", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.documentId, "stmt-doc");
      assert.equal(body.account, "revolut");
      return { account: "revolut", documentId: "stmt-doc", contentType: "text/csv", rowCount: 1, incomingCount: 1, incomingTotal: "1000.00", rows: parsedRows, warnings: [] };
    }],
    ["/reconcile/statements", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.period, "2026-10");
      assert.deepEqual(body.rows, parsedRows);
      return { statement: { id: "stmt-1", accountId: "revolut", period: "2026-10", rows: parsedRows } };
    }],
  ], async (calls) => {
    const result = await upload({ ...args, file: path, account: "revolut", period: "2026-10" }, {});
    assert.equal(result.documentId, "stmt-doc");
    assert.equal(result.statement.id, "stmt-1");
    const put = calls.find((call) => call.method === "PUT");
    assert.ok(put && Buffer.isBuffer(put.body) && put.body.length > 0);
    assert.equal(put.headers.Authorization, undefined);
  });
  await rm(directory, { recursive: true, force: true });
});

test("confirm links an unclaimed ledger row the way sponsors link-payment does, dry-run by default", async () => {
  const reportPayload = {
    period: "2026-10",
    matched: [{
      matchId: "abc123def4567890", statementId: "stmt-1", rowIndex: 0,
      row: { date: "2026-10-05", amount: "1000.00", currency: "EUR", counterparty: "Organization One" },
      dealId: "deal-one", dealName: "Deal One", invoiceNumber: "202610/12",
      strategy: "invoice-number", confidence: "exact", transactionId: "ledger-1",
    }],
    ambiguous: [], unmatchedIncoming: [], missingPayments: [],
  };
  await withFakePortal([
    ["/reconcile/report", reportPayload],
    ["/deals/deal-one/finance/candidates/payments", { items: [{ id: "ledger-1", effectiveDate: "2026-10-05", amount: "1000.00", currency: "EUR", identityToken: "payment-identity" }] }],
    ["/deals/deal-one", { version: 3 }],
    ["/deals/deal-one/finance", { finance: { version: 7, currency: "EUR" } }],
    ["/deals/deal-one/finance/payments", { projection: { paymentState: "paid" } }],
  ], async (calls) => {
    const dry = await confirm({ ...args, _: ["abc123def4567890"], period: "2026-10" }, {});
    assert.equal(dry.mode, "dry-run");
    assert.equal(dry.paymentMode, "link");
    assert.ok(!calls.some((call) => call.method === "POST"));

    const applied = await confirm({ ...args, _: ["abc123def4567890"], period: "2026-10", apply: true }, {});
    assert.equal(applied.mode, "apply");
    assert.equal(applied.paymentState, "paid");
    assert.equal(applied.thankYou?.status, "required");
    assert.equal(applied.thankYou?.sendPolicy, "send-with-template");
    assert.equal(applied.thankYou?.templateId, "template.finance.bookkeeping.email-to-sponsor-when-payment-has-been-received");
    assert.equal(applied.thankYou?.context?.whatWasPaid, "invoice 202610/12");
    assert.equal(applied.nextStep?.code, "thank-sponsor");
    const post = calls.filter((call) => call.method === "POST").at(-1);
    assert.ok(post.url.endsWith("/deals/deal-one/finance/payments"));
    assert.deepEqual(JSON.parse(post.body), { dealVersion: 3, expectedVersion: 7, sourceId: "ledger-1", identityToken: "payment-identity" });
    assert.match(post.headers["Idempotency-Key"], /^reconcile-abc123def4567890-link$/);
    const writes = calls.filter((call) => call.method === "POST").length;
    await confirm({ ...args, _: ["abc123def4567890"], period: "2026-10", apply: true }, {});
    assert.equal(calls.filter((call) => call.method === "POST").length, writes + 1);
    const replay = calls.filter((call) => call.method === "POST").at(-1);
    assert.equal(replay.headers["Idempotency-Key"], post.headers["Idempotency-Key"]);
  });
});

test("confirm records a receipt when the statement row has no ledger twin", async () => {
  const reportPayload = {
    period: "2026-10",
    matched: [{
      matchId: "fffafffff4567890", statementId: "stmt-2", rowIndex: 2,
      row: { date: "2026-10-06", amount: "500.00", currency: "EUR", counterparty: "Organization Two", reference: "202602/7" },
      dealId: "deal-two", dealName: "Deal Two", strategy: "alias", confidence: "strong",
    }],
    ambiguous: [], unmatchedIncoming: [], missingPayments: [],
  };
  await withFakePortal([
    ["/reconcile/report", reportPayload],
    ["/deals/deal-two", { version: 1 }],
    ["/deals/deal-two/finance", { finance: { version: 2 } }],
    ["/finance/receipts", { projection: { paymentState: "paid" } }],
  ], async (calls) => {
    const dry = await confirm({ ...args, _: ["fffafffff4567890"] }, {});
    assert.equal(dry.mode, "dry-run");
    const applied = await confirm({ ...args, _: ["fffafffff4567890"], apply: true }, {});
    assert.equal(applied.paymentMode, "receive");
    const post = calls.filter((call) => call.method === "POST").at(-1);
    assert.ok(post.url.endsWith("/deals/deal-two/finance/receipts"));
    const body = JSON.parse(post.body);
    assert.equal(body.receivedOn, "2026-10-06");
    assert.equal(body.amount, "500.00");
    assert.equal(body.currency, "EUR");
    assert.equal(body.counterparty, "Organization Two");
    assert.equal(body.reference, "statement:stmt-2:2:202602/7");
  });
});

test("the month-end report round-trips and alias registry commands hit the reconcile API", async () => {
  await withFakePortal([
    ["/reconcile/report", { period: "2026-10", statements: [], matched: [], ambiguous: [], unmatchedIncoming: [], missingPayments: [], coverage: { daysInPeriod: 31, accounts: [], accountsWithoutStatement: [] }, totals: { incomingCount: 0, matchedCount: 0, unmatchedCount: 0, ambiguousCount: 0 } }],
    ["/reconcile/aliases", { items: [{ id: "alias-1", alias: "OMANE", sponsor: "Organization Two" }] }],
  ], async () => {
    const month = await report({ ...args, period: "2026-10" }, {});
    assert.equal(month.period, "2026-10");
    const listed = await aliases(args, {});
    assert.equal(listed.items[0].alias, "OMANE");
  });
  await withFakePortal([
    ["/reconcile/aliases", (request) => request.options.method === "POST"
      ? { alias: { id: "alias-1", alias: "OMANE", sponsor: "Organization Two" } }
      : { deleted: "alias-1" }],
  ], async (calls) => {
    const added = await alias({ ...args, _: ["add", "OMANE"], sponsor: "Organization Two" }, {});
    assert.equal(added.alias.sponsor, "Organization Two");
    const removed = await alias({ ...args, _: ["remove", "alias-1"] }, {});
    assert.equal(removed.deleted, "alias-1");
    const post = calls.find((call) => call.method === "POST");
    assert.deepEqual(JSON.parse(post.body), { alias: "OMANE", sponsor: "Organization Two" });
  });
});

test("upload accepts a Finom statement, forwards --currency and stores the closing balance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "finom.csv");
  await writeFile(path, "Completed date,Counterparty name,Reference,Amount,Balance\n05.10.2026 08:00:00,Sponsor Three Ltd,202610/03,1 000.00,3 000.00\n");
  const rows = [{ date: "2026-10-05", amount: "1000.00", currency: "USD", counterparty: "Sponsor Three Ltd", reference: "202610/03" }];
  const parsedBalances = [{ currency: "USD", amount: "3000.00", asOf: "2026-10-05" }];
  await withFakePortal([
    ["/documents/prepare", { outcome: "existing", document: { id: "finom-doc" } }],
    ["/reconcile/statements/parse", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.account, "finom");
      assert.equal(body.currency, "USD");
      return { contentType: "text/csv", rowCount: 1, incomingCount: 1, incomingTotal: "1000.00", rows, balances: parsedBalances, warnings: [] };
    }],
    ["/reconcile/statements", (request) => {
      const body = JSON.parse(request.options.body);
      assert.deepEqual(body.balances, parsedBalances);
      return { statement: { id: "stmt-finom", accountId: "finom", period: "2026-10", rows, balances: parsedBalances } };
    }],
    ["/reconcile/balances", (request) => {
      assert.match(request.url, /account=finom/);
      return { items: [{ accountId: "finom", statementId: "stmt-finom", ...parsedBalances[0] }] };
    }],
  ], async () => {
    const printed = [];
    const result = await upload({ url: args.url, file: path, account: "finom", period: "2026-10", currency: "usd" }, { print: (line) => printed.push(line) });
    assert.equal(result.statement.id, "stmt-finom");
    assert.ok(printed.some((line) => line === "balance 3000.00 USD as of 2026-10-05"), printed.join("\n"));
    const listed = await balances({ ...args, account: "finom" }, {});
    assert.equal(listed.items[0].amount, "3000.00");
  });
  await assert.rejects(upload({ ...args, file: path, account: "finom", period: "2026-10", currency: "euro" }, {}), /--currency/);
  await rm(directory, { recursive: true, force: true });
});

test("upload --by-month stores a year export as one statement per month", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "year.csv");
  await writeFile(path, "synthetic\n");
  const rows = [
    { date: "2026-09-30", amount: "-5.00", currency: "EUR", counterparty: "A" },
    { date: "2026-10-01", amount: "10.00", currency: "EUR", counterparty: "B" },
    { date: "2026-10-02", amount: "-1.00", currency: "EUR", counterparty: "C" },
  ];
  const saves = [];
  await withFakePortal([
    ["/documents/prepare", { outcome: "existing", document: { id: "year-doc" } }],
    ["/reconcile/statements/parse", { contentType: "text/csv", rowCount: 3, incomingCount: 1, incomingTotal: "10.00", rows, balances: [{ currency: "EUR", amount: "4.00", asOf: "2026-10-02" }], warnings: ["skipped a pending row dated 2026-10-03"] }],
    ["/reconcile/statements", (request) => {
      const body = JSON.parse(request.options.body);
      saves.push(body);
      return { statement: { id: `stmt-${body.period}`, period: body.period, rows: body.rows } };
    }],
  ], async () => {
    const result = await upload({ ...args, file: path, account: "revolut", period: "2026-10", byMonth: true }, {});
    assert.deepEqual(saves.map((save) => [save.period, save.rows.length, save.balances?.length ?? 0, save.warnings?.length ?? 0]), [
      ["2026-09", 1, 0, 0],
      ["2026-10", 2, 1, 1],
    ]);
    assert.equal(saves[0].documentId, "year-doc");
    assert.equal(result.statements.length, 2);
  });
  await rm(directory, { recursive: true, force: true });
});

const monthPayload = {
  period: "2026-10", state: "open", blockers: 1, statements: [{ id: "s1", accountId: "finom", from: "2026-10-01", to: "2026-10-31" }],
  counters: { rows: 2, matched: 1, bankWithoutInvoice: 0, ledgerWithoutBank: 1, amountMismatch: 0, needsReview: 0, exceptions: 0 },
  rows: [
    { id: "bank-1", date: "2026-10-02", status: "matched", counterparty: "Example Cloud", amount: "-48.60", currency: "EUR", bank: { accountId: "finom", date: "2026-10-02", amount: "-48.60", currency: "EUR" }, ledger: { id: "ledger-cloud", date: "2026-10-01", amount: "-48.60", currency: "EUR" }, documents: [{ id: "doc-cloud" }], pairBasis: "exact", confidence: "exact" },
    { id: "ledger:ledger-google", date: "2026-10-14", status: "payment-proof-missing", counterparty: "Google", amount: "-1.99", currency: "EUR", ledger: { id: "ledger-google", date: "2026-10-14", amount: "-1.99", currency: "EUR" }, documents: [{ id: "doc-google" }], missing: "no bank transaction in the uploaded statements; upload a payment proof for this row" },
  ],
};

test("month prints missing sides first and the per-row proof attaches to that ledger row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "google-payment.pdf");
  await writeFile(path, "%PDF-1.4 synthetic proof");
  await withFakePortal([
    ["/reconcile/months/2026-10/proof", (request) => {
      assert.deepEqual(JSON.parse(request.options.body), { transactionId: "ledger-google", documentId: "proof-doc" });
      return { month: { period: "2026-10" } };
    }],
    ["/reconcile/months/2026-10", monthPayload],
    ["/documents/prepare", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.documentType, "other-evidence");
      assert.equal(body.accountId, undefined);
      return { outcome: "existing", document: { id: "proof-doc" } };
    }],
  ], async () => {
    const printed = [];
    await commands.month({ url: args.url, _: ["2026-10"] }, { print: (line) => printed.push(line) });
    assert.match(printed[1], /1 without payment proof/);
    const firstRow = printed.findIndex((line) => /^2026-10-/.test(line));
    assert.match(printed[firstRow], /payment-proof-missing/);
    assert.ok(printed.some((line) => /missing: no bank transaction/.test(line)));
    const result = await commands["attach-proof"]({ ...args, _: ["ledger-google", path], period: "2026-10" }, {});
    assert.equal(result.documentId, "proof-doc");
  });
  await rm(directory, { recursive: true, force: true });
});

test("close shows the blocking rows when the portal refuses", async () => {
  await withFakePortal([], async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Month 2026-10 cannot close: 1 rows lack a side", blockers: [{ id: "ledger:ledger-google", date: "2026-10-14", status: "payment-proof-missing", amount: "-1.99", currency: "EUR", counterparty: "Google", missing: "upload a payment proof" }] }), { status: 409 });
    const printed = [];
    try {
      await assert.rejects(commands.close({ url: args.url, _: ["2026-10"] }, { print: (line) => printed.push(line) }), /cannot close/);
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(printed.some((line) => /payment-proof-missing -1.99 EUR Google — upload a payment proof/.test(line)), printed.join("\n"));
  });
});
