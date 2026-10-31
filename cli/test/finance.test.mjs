import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const totals = (fields) => ({
  moneyIn: 0, moneyOut: 0, net: 0, operatingIncome: 0, operatingExpenses: 0, outputVat: 0, inputVat: 0,
  incomeNetOfVat: 0, expensesNetOfVat: 0, netProfitExVat: 0, projectedVat: 0, vatPaid: 0, vatRefunded: 0,
  otherTaxes: 0, healthInsurance: 0, netAfterTaxes: 0, entryCount: 0, vatUnknownCount: 0, unconvertedCount: 0, ...fields,
});
const OCTOBER = {
  period: { kind: "month", label: "2026-10", from: "2026-10-01", to: "2026-10-31", months: ["2026-10"] },
  baseCurrency: "EUR",
  totals: totals({ moneyIn: 26460.49, moneyOut: 1000, net: 25460.49, netProfitExVat: 25460.49, incomeNetOfVat: 26460.49, expensesNetOfVat: 1000, netAfterTaxes: 25460.49, entryCount: 7, vatUnknownCount: 7 }),
  months: [{ month: "2026-10", future: false, ...totals({ moneyIn: 26460.49, moneyOut: 1000, net: 25460.49, netProfitExVat: 25460.49 }) }],
  byCurrency: [
    { currency: "EUR", moneyIn: "21100.00", moneyOut: "1000.00", moneyInEur: 21100, moneyOutEur: 1000 },
    { currency: "USD", moneyIn: "6000.00", moneyOut: "0.00", moneyInEur: 5360.49, moneyOutEur: 0 },
  ],
  conversions: [{ id: "r1", date: "2026-10-23", amount: "6000", currency: "USD", eur: 5360.49, rate: 1.1193, rateDate: "2026-10-23", rateSource: "ecb" }],
  entries: [],
  duplicates: [],
  gaps: [{ kind: "vat-unknown", message: "Operating rows with no VAT amount; counted as zero VAT", count: 7 }],
  rules: ["Ledger rows are the only thing counted."],
  rateErrors: [],
};

describe("dataops finance summary", () => {
  test("--month prints the headline numbers, a table, conversions and gaps", async () => {
    const calls = fakePortal({ "GET /api/finance/summary": OCTOBER });
    const io = captureIo();
    assert.equal(await run(["finance", "summary", "--month", "2026-10"], io), 0);
    assert.deepEqual(calls[0].query, { month: "2026-10" });
    const text = io.text();
    assert.match(text, /Finance summary 2026-10 \(EUR\)/);
    assert.match(text, /Net profit excluding VAT:\s+25,460\.49/);
    assert.match(text, /Projected VAT position:\s+0\.00 \(nothing owed\)\s+! 7 rows have no VAT amount/);
    assert.match(text, /2026-10\s+26,460\.49\s+1,000\.00\s+25,460\.49/);
    assert.match(text, /USD\s+6,000\.00\s+5,360\.49/);
    assert.match(text, /2026-10-23\s+6,000\.00 USD\s+5,360\.49\s+1\.1193\s+2026-10-23\s+ECB reference/);
    assert.match(text, /Data gaps\n  - Operating rows with no VAT amount; counted as zero VAT \(7\)/);
  });

  test("--json returns the portal's payload unchanged", async () => {
    fakePortal({ "GET /api/finance/summary": OCTOBER });
    const io = captureIo();
    assert.equal(await run(["finance", "summary", "--month", "2026-10", "--json"], io), 0);
    assert.deepEqual(io.json(), OCTOBER);
  });

  test("--year and --ytd query the matching period; a year gets a total row", async () => {
    const year = { ...OCTOBER, period: { ...OCTOBER.period, kind: "year", label: "2026" }, months: [{ ...OCTOBER.months[0], month: "2026-11", future: true }, OCTOBER.months[0]] };
    const calls = fakePortal({ "GET /api/finance/summary": year });
    const io = captureIo();
    await run(["finance", "summary", "--year", "2026"], io);
    await run(["finance", "summary", "--ytd"], captureIo());
    assert.deepEqual(calls.map((c) => c.query), [{ year: "2026" }, { ytd: "1" }]);
    assert.match(io.text(), /2026-11 \*/);
    assert.match(io.text(), /Total\s+26,460\.49/);
    assert.match(io.text(), /\* not over yet/);
  });

  test("needs exactly one valid period", async () => {
    fakePortal({});
    for (const argv of [[], ["--month", "2026-10", "--ytd"], ["--month", "10/2026"], ["--year", "26"]]) {
      const io = captureIo();
      assert.equal(await run(["finance", "summary", ...argv], io), 2, argv.join(" "));
    }
  });
});

const UPCOMING = {
  today: "2026-10-31", from: "2026-10-24", to: "2026-12-30", days: 60,
  debits: [
    { scheduleId: "vat-2026-q3", label: "VAT Q3/2026", taxType: "vat", dueDate: "2026-11-10", date: "2026-11-10", shifted: null, amount: 659.28, currency: "EUR", source: "USt-VA", sourceRef: "Q3/2026", approximate: false, status: "scheduled", matched: null },
    { scheduleId: "gewst", label: "Trade tax prepayment", taxType: "trade-tax", dueDate: "2026-11-15", date: "2026-11-16", shifted: "due 2026-11-15 falls on Sunday", amount: 3296, currency: "EUR", source: "Bescheid", sourceRef: null, approximate: false, status: "scheduled", matched: null },
    { scheduleId: "tk", label: "TK health insurance", taxType: "health-insurance", dueDate: "2026-11-16", date: "2026-11-16", shifted: null, amount: 1179.36, currency: "EUR", source: "recurring", sourceRef: null, approximate: true, status: "scheduled", matched: null },
  ],
  dueNext30: 5134.64, dueInWindow: 5134.64,
  balance: { accountId: "finom", amount: 5000, currency: "EUR", asOf: "2026-10-30", source: "statement", stale: false, ageDays: 1 },
  shortfall: true,
  warnings: ["Balance 5000.00 EUR is below the 5134.64 EUR due in the next 30 days"],
};

describe("dataops finance upcoming and schedule", () => {
  test("upcoming prints dates, amounts, tax types, sources, the 30-day total and the shortfall", async () => {
    const calls = fakePortal({ "GET /api/finance/upcoming": UPCOMING });
    const io = captureIo();
    assert.equal(await run(["finance", "upcoming"], io), 0);
    assert.deepEqual(calls[0].query, { days: "60" });
    const text = io.text();
    assert.match(text, /2026-11-10\s+659\.28\s+VAT\s+VAT Q3\/2026\s+USt-VA Q3\/2026\s+scheduled/);
    assert.match(text, /2026-11-16 ~\s+1,179\.36\s+Health insurance/);
    assert.match(text, /2026-11-16: Trade tax prepayment moved, due 2026-11-15 falls on Sunday/);
    assert.match(text, /Due in the next 30 days:\s+5,134\.64/);
    assert.match(text, /Balance \(finom, as of 2026-10-30\):\s+5,000\.00 EUR\s+! SHORTFALL/);
  });

  test("upcoming --days and --json pass through; bad days are refused", async () => {
    const calls = fakePortal({ "GET /api/finance/upcoming": UPCOMING });
    const io = captureIo();
    assert.equal(await run(["finance", "upcoming", "--days", "30", "--json"], io), 0);
    assert.deepEqual(calls[0].query, { days: "30" });
    assert.deepEqual(io.json(), UPCOMING);
    assert.equal(await run(["finance", "upcoming", "--days", "0"], captureIo()), 2);
  });

  test("schedule set sends the entry with the version that was read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fin-"));
    const file = path.join(dir, "gewst.json");
    writeFileSync(file, JSON.stringify({ label: "Trade tax prepayment", taxType: "trade-tax", amount: "3500.00", currency: "EUR", rule: { kind: "quarterly", months: [2, 5, 8, 11], day: 15 }, source: "Bescheid" }));
    const calls = fakePortal({ "PUT /api/finance/tax-schedule/gewst": (call) => ({ ...call.body, id: "gewst", version: 3 }) });
    const io = captureIo();
    assert.equal(await run(["finance", "schedule", "set", "gewst", "--file", file, "--expected-version", "2"], io), 0);
    assert.equal(calls[0].body.expectedVersion, 2);
    assert.equal(calls[0].body.amount, "3500.00");
    assert.match(io.text(), /Saved gewst version 3: Trade tax prepayment, 3,500\.00 EUR/);
    rmSync(dir, { recursive: true, force: true });
  });
});
