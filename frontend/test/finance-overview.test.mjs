import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cashChartMarkup, formatEur, overviewMarkup, periodFromParams } from "../src/surfaces/finance/overview.js";

const e = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const totals = (fields) => ({
  moneyIn: 0, moneyOut: 0, net: 0, operatingIncome: 0, operatingExpenses: 0, outputVat: 0, inputVat: 0,
  incomeNetOfVat: 0, expensesNetOfVat: 0, netProfitExVat: 0, projectedVat: 0, vatPaid: 0, vatRefunded: 0,
  otherTaxes: 0, healthInsurance: 0, netAfterTaxes: 0, entryCount: 0, vatUnknownCount: 0, unconvertedCount: 0, ...fields,
});
const month = (m, fields, future = false) => ({ month: m, future, ...totals(fields) });

const YEAR = {
  period: { kind: "year", label: "2026", from: "2026-01-01", to: "2026-12-31", months: ["2026-09", "2026-10", "2026-11"] },
  totals: totals({ moneyIn: 3000, moneyOut: 1300, net: 1700, netProfitExVat: 2100, incomeNetOfVat: 2500, expensesNetOfVat: 400, projectedVat: 410.5, outputVat: 500, inputVat: 89.5, vatPaid: 300, otherTaxes: 400, healthInsurance: 0, netAfterTaxes: 1700, entryCount: 4, vatUnknownCount: 1 }),
  months: [month("2026-09", { moneyIn: 1000, moneyOut: 1300, net: -300, netProfitExVat: -100 }), month("2026-10", { moneyIn: 2000, net: 2000, netProfitExVat: 2200 }), month("2026-11", {}, true)],
  byCurrency: [{ currency: "USD", moneyIn: "6000.00", moneyOut: "0.00", moneyInEur: 5360.49, moneyOutEur: 0 }],
  conversions: [{ id: "r1", date: "2026-10-23", amount: "6000", currency: "USD", eur: 5360.49, rate: 1.1193, rateDate: "2026-10-23", rateSource: "ecb" }],
  entries: [{ id: "r1", counterparty: "<Payer & Co>" }],
  duplicates: [{ keptId: "a", droppedId: "b", reason: "sheet row repeats sponsor-receipt row" }],
  gaps: [{ kind: "vat-unknown", message: "Operating rows with no VAT amount; counted as zero VAT", count: 1 }],
  rules: ["Ledger rows are the only thing counted."],
  rateErrors: [],
};

describe("finance overview", () => {
  test("reads the period from the URL and defaults to the year to date", () => {
    assert.deepEqual(periodFromParams(new URLSearchParams("month=2026-10"), "2026-10-31"), { month: "2026-10" });
    assert.deepEqual(periodFromParams(new URLSearchParams("year=2025"), "2026-10-31"), { year: "2025" });
    assert.equal(periodFromParams(new URLSearchParams("month=2026-13"), "2026-10-31").ytd, "1");
  });

  test("formats EUR with a true minus sign and no negative zero", () => {
    assert.equal(formatEur(-300), "−300.00");
    assert.equal(formatEur(-0.001), "0.00");
    assert.equal(formatEur(1700, { sign: true }), "+1,700.00");
    assert.equal(formatEur(null), "–");
  });

  test("leads with net profit excluding VAT and the projected VAT position next to what was paid", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.match(markup, /Net profit excluding VAT<\/h2>\s*<p class="fin-tile__value" data-fin-profit>2,100\.00/);
    assert.match(markup, /data-fin-vat>410\.50 <span class="fin-tile__unit">EUR<\/span><\/p>\s*<p class="fin-tile__sub">owed to the Finanzamt/);
    assert.match(markup, /Actually paid in this period: <strong>300\.00<\/strong>/);
    assert.match(markup, /1 operating row has no VAT amount/);
    assert.ok(markup.indexOf("data-fin-profit") < markup.indexOf("<svg"));
  });

  test("draws both charts and a table with a total row, marking months not over yet", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.equal((markup.match(/<svg /g) || []).length, 2);
    assert.match(markup, /<th scope="row">Total<\/th>/);
    assert.match(markup, /2026-11 <small>\(not over\)<\/small>/);
    assert.match(markup, /dataops finance summary --year 2026/);
  });

  test("a single month has no chart, only its table", () => {
    const one = { ...YEAR, period: { ...YEAR.period, kind: "month", label: "2026-10" }, months: [YEAR.months[1]] };
    const markup = overviewMarkup(one, e);
    assert.doesNotMatch(markup, /<svg /);
    assert.doesNotMatch(markup, /scope="row">Total/);
    assert.match(markup, /--month 2026-10/);
  });

  test("shows original amounts, rate, rate date and source, escaping counterparties", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.match(markup, /<td>2026-10-23<\/td><td>&lt;Payer &amp; Co&gt;<\/td><td class="fin-num">6,000\.00 USD<\/td>/);
    assert.match(markup, /1\.1193<\/td>\s*<td>2026-10-23<\/td><td>ECB reference rate<\/td>/);
    assert.match(markup, /dropped as duplicates of invoice or receipt rows \(1\)/);
  });

  test("puts money out below the baseline and labels every month for hover and screen readers", () => {
    const svg = cashChartMarkup(YEAR.months, e);
    assert.equal((svg.match(/data-fin-hover=/g) || []).length, 3);
    assert.match(svg, /2026-09: in 1,000\.00, out 1,300\.00, net −300\.00 EUR/);
    assert.match(svg, /class="fin-chart__month is-future"/);
  });
});
