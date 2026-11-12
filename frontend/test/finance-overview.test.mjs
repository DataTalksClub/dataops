import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  activateFinanceMonthlyRow, bookkeepingMonthUrl, formatEur, isFinishedYear,
  monthTableMarkup, overviewMarkup, periodControlsMarkup, periodFromParams,
  shownMonths, statusLine, taxEstimateMarkup, upcomingMarkup,
} from "../src/surfaces/finance/overview.js";
import { escapeHtml as e } from "../src/core/html.js";
const totals = (fields) => ({
  moneyIn: 0, moneyOut: 0, net: 0, operatingIncome: 0, operatingExpenses: 0, outputVat: 0, inputVat: 0,
  incomeNetOfVat: 0, expensesNetOfVat: 0, netProfitExVat: 0, projectedVat: 0, vatPaid: 0, vatRefunded: 0, ownerPay: 0,
  incomeTax: 0, tradeTax: 0, otherTaxes: 0, healthInsurance: 0, taxesTotal: 0, taxRefunds: 0, netAfterTaxes: 0, entryCount: 0, unconvertedCount: 0, ...fields,
});
const month = (m, fields, future = false) => ({ month: m, future, ...totals(fields) });

const YEAR = {
  period: { kind: "year", label: "2026", from: "2026-01-01", to: "2026-12-31", months: ["2026-09", "2026-10", "2026-11"] },
  totals: totals({ moneyIn: 3000, moneyOut: 1300, net: 1700, netProfitExVat: 2100, incomeNetOfVat: 2500, expensesNetOfVat: 400, projectedVat: 410.5, outputVat: 500, inputVat: 89.5, vatPaid: 300, incomeTax: 300, tradeTax: 100, healthInsurance: 20, taxesTotal: 420, taxRefunds: 1500.5, ownerPay: 50, netAfterTaxes: 1680, netAfterOwnerPay: 1630, entryCount: 4 }),
  months: [month("2026-09", { moneyIn: 1000, moneyOut: 1300, net: -300, netProfitExVat: -100, incomeTax: 20, tradeTax: 10, healthInsurance: 15, taxesTotal: 45, ownerPay: 100, outputVat: 50, inputVat: 15, vatPaid: 45, vatRefunded: 5, projectedVat: 35 }), month("2026-10", { moneyIn: 2000, net: 2000, netProfitExVat: 2200, taxRefunds: 1500.5 }), month("2026-11", {}, true)],
  byCurrency: [
    { currency: "USD", moneyIn: "6000.00", moneyOut: "0.00", moneyInEur: 5360.49, moneyOutEur: 0 },
    { currency: "GBP", moneyIn: "25.00", moneyOut: "0.00", moneyInEur: 33.1, moneyOutEur: 0 },
  ],
  entries: [
    { id: "r1", date: "2026-10-23", amount: "6000", currency: "USD", amountEur: "5360.49", bookedRateSource: "ECB 23 Oct 2026", eur: 5360.49, rate: 1.1193, rateDate: "2026-10-23", rateSource: "ecb", counterparty: "<Payer & Co>", category: "Sponsorship", subtype: "Invoice" },
    { id: "r2", date: "2026-10-24", amount: "25", currency: "GBP", amountEur: null, eur: 33.1, rate: null, rateDate: null, rateSource: null, counterparty: "No-rate & Co" },
  ],
  taxRefunds: [{ id: "ledger-refund-1", date: "2026-10-30", month: "2026-10", eur: 1500.5, taxType: "other", counterparty: "Finanzamt <Synthetic>", description: "Erstattung" }],
  duplicates: [{ keptId: "a", droppedId: "b", reason: "sheet row repeats sponsor-receipt row" }],
  gaps: [],
  rules: ["Ledger rows are the only thing counted."],
  rateErrors: [],
};

const TODAY = "2026-10-20";
const CLOSED = {
  ...YEAR,
  period: { kind: "year", label: "2025", from: "2025-01-01", to: "2025-12-31", months: ["2025-11", "2025-12"] },
  months: [month("2025-11", { moneyIn: 10, taxesTotal: 4 }), month("2025-12", { moneyIn: 20 })],
  taxReturn: {
    closed: true, assessed: { incomeTax: 900, soli: 50, tradeTax: 200, vat: 70 }, paid: { incomeTax: 1000, soli: 60, tradeTax: 250, vat: 70 },
    refunded: 160, refundedOn: "2026-10-30", sources: ["Bescheid <synthetic>"], notes: [],
  },
  taxRefunds: [{ id: "ledger-refund-1", date: "2026-10-30", month: "2026-10", taxYear: "2025", eur: 160, taxType: "other", counterparty: "Finanzamt <Synthetic>", description: "Erstattung" }],
};
const ESTIMATE = {
  year: 2026, profitEur: 2100, incomeTax: { einkommensteuer: 310 }, soli: 12, tradeTax: { steuer: 90 }, totalEstimate: 412,
  paid: { incomeTax: 300, tradeTax: 100 }, paidTotal: 400, remaining: 12, assessment: null,
  planning: { projectedAfterTaxEur: 1688, safeToWithdrawEur: 950, ownerPayEur: 50, formula: ["f"] },
  inputs: ["input line"], formula: ["formula line"], sources: ["§ 32a EStG"], disclaimer: "rough",
};

describe("finance overview", () => {
  test("reads only an annual year from the URL and defaults to the current calendar year", () => {
    assert.deepEqual(periodFromParams(new URLSearchParams("month=2025-10"), "2026-10-31"), { year: "2026" });
    assert.deepEqual(periodFromParams(new URLSearchParams("year=2025"), "2026-10-31"), { year: "2025" });
    assert.deepEqual(periodFromParams(new URLSearchParams("year=bad&month=2026-10"), "2026-10-31"), { year: "2026" });
  });

  test("offers one button per year back to 2024, newest first, with the chosen year pressed", () => {
    const markup = periodControlsMarkup({ year: "2025" }, "2026-11-12", e);
    assert.deepEqual([...markup.matchAll(/data-fin-year="(\d{4})" aria-pressed="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`),
      ["2026:false", "2025:true", "2024:false"]);
    assert.doesNotMatch(markup, /<select|Year to date|type="month"/);
  });

  test("formats EUR with a true minus sign and no negative zero", () => {
    assert.equal(formatEur(-300), "−300.00");
    assert.equal(formatEur(-0.001), "0.00");
    assert.equal(formatEur(1700, { sign: true }), "+1,700.00");
    assert.equal(formatEur(null), "–");
  });

  test("leads with three key numbers: profit, taxes paid and owner pay as actual withdrawals", () => {
    const markup = overviewMarkup(YEAR, e, TODAY);
    assert.equal((markup.match(/class="fin-tile"/g) || []).length, 3);
    assert.match(markup, /Profit<\/h2>\s*<p class="fin-tile__value" data-fin-profit>2,100\.00/);
    assert.match(markup, /Taxes paid<\/h2>\s*<p class="fin-tile__value" data-fin-taxes-total>420\.00/);
    assert.match(markup, /Owner pay<\/h2>\s*<p class="fin-tile__value" data-fin-owner-pay>50\.00<\/p>\s*<p class="fin-tile__sub">Actual withdrawals to the owner/);
    assert.match(markup, /Money in <strong>3,000\.00<\/strong>[\s\S]*Money out <strong>1,300\.00<\/strong>[\s\S]*same totals as Bookkeeping/);
    assert.ok(markup.indexOf("data-fin-profit") < markup.indexOf("<svg"));
    assert.equal((markup.match(/<svg /g) || []).length, 1);
    assert.doesNotMatch(markup, /dataops finance summary|Projected VAT/);
  });

  test("month table has one combined Taxes column, no Tax refunds column, and splits taxes by type only under the year total", () => {
    const markup = monthTableMarkup(YEAR, e, TODAY);
    assert.deepEqual([...markup.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]),
      ["Month", "Money in", "Money out", "Profit", "Taxes", "Owner pay"]);
    assert.doesNotMatch(markup, /Tax refunds|ESt \+ Soli|GewSt|VAT/);
    const cellsOf = (row) => [...row.matchAll(/<td class="fin-num[^"]*">([^<]+)<\/td>/g)].map((m) => m[1]);
    const rows = [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    assert.deepEqual(cellsOf(rows[1]), ["1,000.00", "1,300.00", "−100.00", "45.00", "100.00"]);
    // A refund received in October is not a tax and has no column of its own.
    assert.deepEqual(cellsOf(rows[2]), ["2,000.00", "0.00", "+2,200.00", "0.00", "0.00"]);
    const total = markup.match(/<tr class="fin-table__total" data-fin-year-total>[\s\S]*?<\/tr>/)[0];
    assert.match(total, /2026 total/);
    assert.deepEqual(cellsOf(total), ["3,000.00", "1,300.00", "+2,100.00", "420.00", "50.00"]);
    assert.doesNotMatch(total, /data-fin-month-link/);
    assert.match(markup, /data-fin-tax-split><th scope="row">Taxes by type<\/th><td colspan="5">Income tax \+ Soli 300\.00 · Trade tax 100\.00 · TK 20\.00<\/td>/);
  });

  test("marks the current month in progress and never shows a future month, in the table or the chart", () => {
    assert.deepEqual(shownMonths(YEAR, TODAY).map((m) => [m.month, m.inProgress]), [["2026-09", false], ["2026-10", true]]);
    const markup = overviewMarkup(YEAR, e, TODAY);
    assert.match(markup, /<tr class="is-in-progress" data-fin-in-progress data-fin-bookkeeping-row>\s*<th scope="row"><a class="fin-table__month-link" data-fin-month-link href="\/bookkeeping\?month=2026-10">October<\/a> <span class="fin-badge">in progress<\/span>/);
    assert.doesNotMatch(markup, /2026-11|November|not over|is-future/);
    assert.equal(statusLine(YEAR, TODAY), "2026 · in progress · through October");
  });

  test("the running year shows taxes actually paid by type and a planning estimate placeholder", () => {
    const markup = overviewMarkup(YEAR, e, TODAY);
    assert.match(markup, /Taxes paid in 2026/);
    assert.match(markup, /<th scope="row">Income tax \+ Soli<\/th>\s*<td class="fin-num" data-fin-tax="income-tax">300\.00/);
    assert.match(markup, /<th scope="row">Total<\/th><td class="fin-num" data-fin-tax="total">420\.00/);
    assert.doesNotMatch(markup, /data-fin-tax="other"/);
    assert.match(markup, /data-fin-estimate>[\s\S]*Planning for 2026 <span class="fin-badge">rough estimate/);
    assert.equal(isFinishedYear(YEAR, TODAY), false);
  });
});

describe("finished years show actuals only", () => {
  test("a closed year shows assessed, paid and refunded per Bescheid and no estimate of any kind", () => {
    const markup = overviewMarkup(CLOSED, e, "2026-11-12");
    assert.equal(statusLine(CLOSED, "2026-11-12"), "2025 · closed · assessed per Bescheid");
    assert.match(markup, /Taxes assessed<\/h2>\s*<p class="fin-tile__value" data-fin-taxes-total>1,150\.00/);
    assert.match(markup, /data-fin-official-income-tax><th scope="row">Income tax \+ Soli<\/th><td class="fin-num">950\.00<\/td><td class="fin-num">1,060\.00/);
    assert.match(markup, /data-fin-official-trade-tax><th scope="row">Trade tax<\/th><td class="fin-num">200\.00<\/td><td class="fin-num">250\.00/);
    assert.match(markup, /data-fin-official-refund><th scope="row">Refunded for 2025 <span class="fin-muted">paid out 2026-10-30<\/span><\/th>\s*<td><\/td><td class="fin-num">160\.00/);
    assert.doesNotMatch(markup, /data-fin-estimate|estimate|Projected|Safe to withdraw|Expected tax|in progress/i);
    assert.equal((markup.match(/data-fin-bookkeeping-row/g) || []).length, 2);
  });

  test("a refund is listed under the tax year it settles, with the bank date it arrived on", () => {
    const markup = overviewMarkup(CLOSED, e, "2026-11-12");
    assert.match(markup, /data-fin-refunds>\s*<summary>Refunds for 2025: 160\.00 in 1 payment<\/summary>/);
    assert.match(markup, /<a href="\/bookkeeping\?month=2026-10">2026-10-30<\/a>\s*<span class="fin-muted">Finanzamt &lt;Synthetic&gt;<\/span>/);
  });

  test("a past year without a Bescheid is still finished: ledger actuals, no estimate", () => {
    const past = { ...CLOSED, taxReturn: undefined };
    assert.equal(isFinishedYear(past, "2026-11-12"), true);
    assert.equal(statusLine(past, "2026-11-12"), "2025 · finished · actual figures");
    assert.doesNotMatch(overviewMarkup(past, e, "2026-11-12"), /data-fin-estimate|estimate/i);
  });
});

describe("planning estimate for the running year", () => {
  test("shows expected tax, paid, remaining and safe to withdraw, without the inputs and formula block", () => {
    const markup = taxEstimateMarkup(ESTIMATE, e);
    assert.match(markup, /<dt>Expected tax for 2026<\/dt><dd data-fin-est-total>412\.00/);
    assert.match(markup, /<dt>Already paid<\/dt><dd data-fin-est-paid>400\.00/);
    assert.match(markup, /<dt>Still to pay<\/dt><dd data-fin-est-remaining>12\.00/);
    assert.match(markup, /<dt>Safe to withdraw now<\/dt><dd data-fin-planning-safe>950\.00/);
    assert.doesNotMatch(markup, /Inputs, formula|statutory|input line|formula line|§ 32a|rough<\/p>/);
  });

  test("renders nothing for an assessed year", () => {
    assert.equal(taxEstimateMarkup({ ...ESTIMATE, assessment: { closed: true } }, e), "");
  });
});

describe("upcoming tax debits section", () => {
  test("puts the amount due and the balance first and the schedule behind a disclosure", () => {
    const markup = upcomingMarkup({
      days: 60, dueNext30: 500, dueInWindow: 900, shortfall: false, warnings: [],
      balance: { amount: 4000, currency: "EUR", accountId: "acc", asOf: "2026-10-19", stale: false },
      debits: [{ date: "2026-11-10", amount: 500, taxType: "trade-tax", label: "GewSt Q4", source: "schedule", status: "scheduled" }],
    }, e);
    assert.match(markup, /<dd data-fin-due30>500\.00<\/dd>/);
    assert.match(markup, /<details class="fin-details" data-fin-upcoming-schedule>\s*<summary>Schedule: 1 debit<\/summary>/);
    assert.match(markup, /Trade tax/);
  });
});

describe("month rows open Bookkeeping", () => {
  test("links a month to its Bookkeeping page", () => {
    assert.equal(bookkeepingMonthUrl("2026-10"), "/bookkeeping?month=2026-10");
    assert.equal(bookkeepingMonthUrl("Total"), "");
  });

  test("a plain click on a month row follows its link; modified clicks and selections do not", () => {
    let clicks = 0;
    const link = { click: () => { clicks += 1; } };
    const row = { querySelector: () => link };
    const target = { closest: (selector) => (selector === "tr[data-fin-bookkeeping-row]" ? row : null) };
    assert.equal(activateFinanceMonthlyRow({ target, button: 0, detail: 1 }, null), true);
    assert.equal(activateFinanceMonthlyRow({ target, button: 0, detail: 1, metaKey: true }, null), false);
    assert.equal(activateFinanceMonthlyRow({ target, button: 0, detail: 1 }, { isCollapsed: false, toString: () => "x" }), false);
    assert.equal(clicks, 1);
  });

  test("the stylesheet styles the calm layout hooks", () => {
    const css = readFileSync(new URL("../src/styles/finance.css", import.meta.url), "utf8");
    for (const hook of [".fin-hero", ".fin-cashline", ".fin-badge", ".fin-details", ".fin-period__year", ".fin-table__split", ".is-in-progress"])
      assert.ok(css.includes(hook), hook);
  });
});
