import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upload, confirm, report, alias, aliases, balances, matches, attachDoc, note, commands } from "../src/commands/reconcile.mjs";
import { exitCodeFor, EXIT } from "../src/errors.mjs";

const withFakePortal = async (routes, run) => {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  let calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body, headers: options.headers || {} });
    for (const [match, respond] of [...routes].sort((left, right) => String(right[0]).length - String(left[0]).length)) {
      if (typeof match === "string" ? url.includes(match) : match(url)) {
        const body = typeof respond === "function" ? respond({ url: String(url), options }) : respond;
        if (body instanceof Response) return body;
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

test("statement list displays the incoming amount", async () => {
  await withFakePortal([
    ["/reconcile/statements", (request) => {
      assert.equal(new URL(request.url).searchParams.get("period"), "2026-10");
      return { items: [{ id: "stmt-finom", accountId: "finom", period: "2026-10", rowCount: 7, incomingCount: 1, incomingTotal: "43633.73" }] };
    }],
  ], async () => {
    const io = { lines: [], print(line) { this.lines.push(String(line)); } };
    await commands.statements({ ...args, json: false, period: "2026-10" }, io);
    assert.match(io.lines[0], /7 rows \(43633\.73 incoming\)/);
  });
});

test("PDF upload stores the raw statement, parses it and saves rows for matching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "statement.pdf");
  await writeFile(path, "%PDF-1.4 synthetic statement bytes");
  const parsedRows = [{ date: "2026-10-05", amount: "1000.00", currency: "EUR", counterparty: "Transfer from Sponsor One", reference: "20261012" }];
  await withFakePortal([
    ["https://private.example.test/object", ""],
    ["/documents/prepare", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.documentType, "bank-statement");
      assert.equal(body.accountId, "revolut");
      assert.equal(body.statementMonth, "2026-10");
      assert.equal(body.originalFilename, "statement.pdf");
      assert.equal(body.contentType, "application/pdf");
      assert.match(body.idempotencyKey, /^statement-[0-9a-f]{64}$/);
      return { document: { id: "stmt-doc" }, uploadUrl: "https://private.example.test/object", uploadHeaders: { "content-type": "application/pdf" } };
    }],
    ["/documents/stmt-doc/complete", { document: { id: "stmt-doc" } }],
    ["/reconcile/statements/parse", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.documentId, "stmt-doc");
      assert.equal(body.account, "revolut");
      return { account: "revolut", documentId: "stmt-doc", contentType: "application/pdf", rowCount: 1, incomingCount: 1, incomingTotal: "1000.00", rows: parsedRows, warnings: [] };
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

test("upload rejects CSV and XLSX locally with a non-zero usage exit code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-pdf-only-"));
  try {
    for (const extension of ["csv", "xlsx"]) {
      const path = join(directory, `statement.${extension}`);
      await writeFile(path, "synthetic bank export");
      await assert.rejects(
        upload({ ...args, file: path, account: "revolut", period: "2026-10" }, {}),
        (error) => {
          assert.match(error.message, /PDF files only/);
          assert.equal(exitCodeFor(error), EXIT.usage);
          return true;
        },
      );
    }
    const invalidPdf = join(directory, "not-a-pdf.pdf");
    await writeFile(invalidPdf, "Date,Amount\n2026-10-01,1.00\n");
    await assert.rejects(
      upload({ ...args, file: invalidPdf, account: "revolut", period: "2026-10" }, {}),
      (error) => {
        assert.match(error.message, /PDF files only/);
        assert.equal(exitCodeFor(error), EXIT.usage);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parse previews a stored statement read-only and requires an account", async () => {
  await withFakePortal([
    ["/reconcile/statements/parse", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.account, "revolut");
      assert.equal(body.documentId, "stmt-doc-2025-01");
      return { accountId: "revolut", documentId: "stmt-doc-2025-01", rowCount: 8, incomingCount: 2, incomingTotal: "3000.00", rows: [], warnings: ["line 42: skipped a summary line"], balances: [
        { wallet: "EUR", currency: "EUR", amount: "1971.39", asOf: "2025-01-31" },
        { wallet: "USD", currency: "USD", amount: "23.47", asOf: "2025-01-31" },
      ] };
    }],
  ], async (calls) => {
    const io = { lines: [], print(line) { this.lines.push(String(line)); } };
    const result = await commands.parse({ ...args, json: false, account: "revolut", _: ["stmt-doc-2025-01"] }, io);
    assert.equal(result.rowCount, 8);
    assert.equal(calls.length, 1);
    assert.match(io.lines[0], /8 rows, 2 incoming, incoming total 3000\.00 across revolut; nothing stored\./);
    assert.match(io.lines[1], /balance EUR 1971\.39 EUR as of 2025-01-31/);
    assert.match(io.lines[2], /balance USD 23\.47 USD as of 2025-01-31/);
    assert.match(io.lines[3], /warning: line 42/);
  });

  await assert.rejects(
    () => commands.parse({ ...args, _: ["stmt-doc-2025-01"] }, {}),
    (error) => /--account must be one of/.test(error.message) && exitCodeFor(error) === EXIT.usage,
  );
  await assert.rejects(
    () => commands.parse({ ...args, account: "revolut", _: [] }, {}),
    (error) => /Usage: dataops reconcile parse/.test(error.message) && exitCodeFor(error) === EXIT.usage,
  );
});

test("attach-doc accepts a bare ledger ID and links evidence without creating another ledger row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-ledger-doc-"));
  const path = join(directory, "receipt.pdf");
  await writeFile(path, "%PDF-1.4 synthetic receipt");
  const ledgerId = "f1e8e2d7fefdfa49b5222b60b61d6dcc6b2acdba1078a3058965665effaf6bb7";
  try {
    await withFakePortal([
      ["https://private.example.test/object", ""],
      ["/documents/prepare", { document: { id: "receipt-doc" }, uploadUrl: "https://private.example.test/object", uploadHeaders: { "content-type": "application/pdf" } }],
      ["/documents/receipt-doc/complete", { document: { id: "receipt-doc" } }],
      ["/reconcile/months/2026-10/document", (request) => {
        assert.deepEqual(JSON.parse(request.options.body), { transactionId: ledgerId, documentId: "receipt-doc" });
        return { id: "link-1", outcome: "created" };
      }],
    ], async (calls) => {
      const result = await attachDoc({ ...args, _: [ledgerId, path], period: "2026-10" }, {});
      assert.equal(result.documentId, "receipt-doc");
      assert.ok(!calls.some((call) => call.url.endsWith("/ledger") && call.method === "POST"));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile note updates the existing ledger comment", async () => {
  await withFakePortal([
    ["/api/bookkeeping/transactions/ledger%2Fid", (request) => {
      assert.equal(request.options.method, "PUT");
      assert.deepEqual(JSON.parse(request.options.body), { comment: "Refund for duplicate charge" });
      return { id: "ledger/id", comment: "Refund for duplicate charge" };
    }],
  ], async () => {
    const result = await note({ ...args, _: ["ledger/id"], note: "Refund for duplicate charge" }, {});
    assert.equal(result.comment, "Refund for duplicate charge");
  });
});

test("server PDF parser errors stop CLI upload before statement rows are saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-parse-failure-"));
  const path = join(directory, "statement.pdf");
  await writeFile(path, "%PDF-1.4 synthetic statement bytes");
  let calls = [];
  try {
    await assert.rejects(
      withFakePortal([
        ["https://private.example.test/object", ""],
        ["/documents/prepare", { document: { id: "bad-statement" }, uploadUrl: "https://private.example.test/object", uploadHeaders: { "content-type": "application/pdf" } }],
        ["/documents/bad-statement/complete", { document: { id: "bad-statement" } }],
        ["/reconcile/statements/parse", new Response(JSON.stringify({ error: "statement.pdf: line 12, source text \\\"broken row\\\": amount unreadable" }), { status: 422 })],
      ], async (recorded) => {
        calls = recorded;
        await upload({ ...args, file: path, account: "revolut", period: "2026-10" }, {});
      }),
      (error) => {
        assert.match(error.message, /line 12/);
        assert.equal(exitCodeFor(error), EXIT.invalid);
        return true;
      },
    );
    assert.ok(!calls.some((call) => call.url.includes("/api/reconcile/statements") && call.method === "POST" && !call.url.includes("/parse")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("the text reconcile report includes non-sponsor platform payouts", async () => {
  const payout = {
    id: "income-1",
    transactionDate: "2026-10-01",
    incomePeriod: "2026-10",
    addedAt: "2026-11-01",
    counterparty: "Synthetic Learning Platform",
    amount: "17.25",
    currency: "USD",
    reference: "synthetic-ref-2026-10-01",
    category: "Affiliate income",
    comment: "Synthetic affiliate payout; test statement SYN-1.",
  };
  await withFakePortal([
    ["/reconcile/report", {
      period: "2026-10",
      statements: [],
      platformPayouts: [payout],
      matched: [],
      ambiguous: [],
      unmatchedIncoming: [],
      missingPayments: [],
      coverage: { daysInPeriod: 31, accounts: [], accountsWithoutStatement: [] },
      totals: { incomingCount: 0, matchedCount: 0, unmatchedCount: 0, ambiguousCount: 0 },
    }],
  ], async () => {
    const io = { lines: [], print(line) { this.lines.push(String(line)); } };
    const result = await report({ ...args, json: false, period: "2026-10" }, io);
    assert.equal(result.platformPayouts[0].reference, "synthetic-ref-2026-10-01");
    assert.match(io.lines.join("\n"), /Platform payouts \(1\)/);
    assert.match(io.lines.join("\n"), /2026-10-01  17\.25 USD  Synthetic Learning Platform.*reference synthetic-ref-2026-10-01/);
    assert.match(io.lines.join("\n"), /added 2026-11-01/);
  });
});

test("upload accepts a Finom PDF and stores its closing balance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "finom.pdf");
  await writeFile(path, "%PDF-1.4 synthetic Finom statement");
  const rows = [{ date: "2026-10-05", amount: "1000.00", currency: "EUR", counterparty: "Sponsor Three Ltd", reference: "202610/03" }];
  const parsedBalances = [{ currency: "EUR", amount: "3000.00", asOf: "2026-10-05" }];
  await withFakePortal([
    ["/documents/prepare", { outcome: "existing", document: { id: "finom-doc" } }],
    ["/reconcile/statements/parse", (request) => {
      const body = JSON.parse(request.options.body);
      assert.equal(body.account, "finom");
      assert.equal(body.currency, undefined);
      return { contentType: "application/pdf", rowCount: 1, incomingCount: 1, incomingTotal: "1000.00", rows, balances: parsedBalances, warnings: [] };
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
    const result = await upload({ url: args.url, file: path, account: "finom", period: "2026-10" }, { print: (line) => printed.push(line) });
    assert.equal(result.statement.id, "stmt-finom");
    assert.ok(printed.some((line) => line === "balance 3000.00 EUR as of 2026-10-05"), printed.join("\n"));
    const listed = await balances({ ...args, account: "finom" }, {});
    assert.equal(listed.items[0].amount, "3000.00");
  });
  await rm(directory, { recursive: true, force: true });
});

test("upload --by-month stores all Revolut currency wallets as one statement per month", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  const path = join(directory, "year.pdf");
  await writeFile(path, "%PDF-1.4 synthetic Revolut year statement");
  const rows = [
    { date: "2026-09-30", amount: "-5.00", currency: "USD", counterparty: "A", wallet: "USD" },
    { date: "2026-10-01", amount: "10.00", currency: "EUR", counterparty: "B" },
    { date: "2026-10-02", amount: "-1.00", currency: "EUR", counterparty: "C" },
    { date: "2026-10-02", amount: "2.00", currency: "USD", counterparty: "D", wallet: "USD" },
  ];
  const saves = [];
  await withFakePortal([
    ["/documents/prepare", { outcome: "existing", document: { id: "year-doc" } }],
    ["/reconcile/statements/parse", { contentType: "application/pdf", rowCount: 4, incomingCount: 2, incomingTotal: "12.00", rows, balances: [
      { currency: "EUR", amount: "4.00", asOf: "2026-10-02", wallet: "EUR" },
      { currency: "USD", amount: "12.00", asOf: "2026-10-02", wallet: "USD" },
    ], warnings: [] }],
    ["/reconcile/statements", (request) => {
      const body = JSON.parse(request.options.body);
      saves.push(body);
      return { statement: { id: `stmt-${body.period}`, period: body.period, rows: body.rows } };
    }],
  ], async () => {
    const result = await upload({ ...args, file: path, account: "revolut", period: "2026-10", byMonth: true }, {});
    assert.deepEqual(saves.map((save) => [save.period, save.rows.length, save.balances?.length ?? 0, save.warnings?.length ?? 0]), [
      ["2026-09", 1, 0, 0],
      ["2026-10", 3, 2, 0],
    ]);
    assert.deepEqual(new Set(saves[1].rows.map((row) => row.currency)), new Set(["EUR", "USD"]));
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

test("package writes the month folder layout from the manifest and never sends anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-reconcile-test-"));
  await withFakePortal([
    ["/reconcile/months/2026-10/package", { period: "2026-10", state: "closed", draft: false, csv: "date,status\n", entries: [
      { path: "2026-10/2026-10_reconciliation_datatalksclub.csv", kind: "report" },
      { path: "2026-10/statements/2026-10_finom-main.csv", kind: "statement", documentId: "doc-stmt" },
      { path: "2026-10/expenses/2026-10-14_google_1.99EUR.pdf", kind: "invoice", documentId: "doc-google" },
      { path: "2026-10/proofs/2026-10-14_google_a1c9d26b5312.pdf", kind: "proof", documentId: "doc-proof" },
    ] }],
    ["/documents/doc-stmt/download", { downloadUrl: "https://private.example.test/stmt" }],
    ["/documents/doc-google/download", { downloadUrl: "https://private.example.test/google" }],
    ["/documents/doc-proof/download", { downloadUrl: "https://private.example.test/proof" }],
    ["https://private.example.test/", "synthetic-bytes"],
  ], async (calls) => {
    const result = await commands.package({ ...args, _: ["2026-10"], out: directory }, {});
    assert.deepEqual(result.written, [
      "2026-10/2026-10_reconciliation_datatalksclub.csv",
      "2026-10/statements/2026-10_finom-main.csv",
      "2026-10/expenses/2026-10-14_google_1.99EUR.pdf",
      "2026-10/proofs/2026-10-14_google_a1c9d26b5312.pdf",
    ]);
    assert.equal(await (await import("node:fs/promises")).readFile(join(directory, "2026-10/proofs/2026-10-14_google_a1c9d26b5312.pdf"), "utf8"), "synthetic-bytes");
    assert.ok(!calls.some((call) => call.method === "POST"), "building a package never writes");
  });
  await rm(directory, { recursive: true, force: true });
});

test("reconcile matches prints matched, unmatched bank and invoices without a bank row", async () => {
  const payload = {
    period: "2026-10",
    counts: { matched: 1, autoMatched: 1, needsReview: 0, unmatchedBank: 1, invoicesWithoutBank: 1 },
    matched: [{ bankKey: "bk1", date: "2026-10-02", amount: "-48.60", currency: "EUR", counterparty: "Example Cloud", invoice: { transactionId: "t1", date: "2026-09-30", counterparty: "Example Cloud", amount: "-48.60", currency: "EUR", documents: 1 }, basis: "exact", confidence: "exact", auto: true, status: "matched" }],
    unmatchedBank: [{ bankKey: "bk2", date: "2026-10-09", amount: "-15.00", currency: "EUR", counterparty: "Unknown Shop", status: "no-invoice" }],
    invoicesWithoutBank: [{ transactionId: "t2", date: "2026-10-12", amount: "-20.00", currency: "EUR", counterparty: "Example Hosting", documents: 1, status: "payment-proof-missing" }],
  };
  await withFakePortal([["/reconcile/months/2026-10/matches", payload]], async (calls) => {
    const lines = [];
    const result = await matches({ ...args, json: false, period: "2026-10" }, { print: (line) => lines.push(line) });
    assert.equal(result.counts.matched, 1);
    const text = lines.join("\n");
    assert.match(text, /1 matched \(1 automatically, 0 to review\), 1 bank rows unmatched, 1 invoices without a bank row/);
    assert.match(text, /\[exact\/exact, auto\]/);
    assert.match(text, /Unknown Shop/);
    assert.match(text, /Example Hosting/);
    assert.match(calls[0].url, /\/api\/reconcile\/months\/2026-10\/matches$/);
  });
  await assert.rejects(() => matches({ ...args }, {}), /matches --period YYYY-MM/);
  assert.equal(typeof commands.matches, "function");
});
