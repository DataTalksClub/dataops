import assert from "node:assert/strict";
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
