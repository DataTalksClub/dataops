import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  activateFinanceMonthlyRow, bookkeepingMonthUrl, cashChartMarkup, formatEur,
  monthTableMarkup, overviewMarkup, periodControlsMarkup, periodFromParams,
  profitChartMarkup, taxesMarkup, taxEstimateMarkup, taxEstimateSectionMarkup,
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
  totals: totals({ moneyIn: 3000, moneyOut: 1300, net: 1700, netProfitExVat: 2100, incomeNetOfVat: 2500, expensesNetOfVat: 400, projectedVat: 410.5, outputVat: 500, inputVat: 89.5, vatPaid: 300, incomeTax: 300, tradeTax: 100, healthInsurance: 20, taxesTotal: 420, taxRefunds: 43633.73, ownerPay: 50, netAfterTaxes: 1680, netAfterOwnerPay: 1630, entryCount: 4 }),
  months: [month("2026-09", { moneyIn: 1000, moneyOut: 1300, net: -300, netProfitExVat: -100, incomeTax: 20, tradeTax: 10, healthInsurance: 15, taxesTotal: 45, ownerPay: 100, outputVat: 50, inputVat: 15, vatPaid: 45, vatRefunded: 5, projectedVat: 35 }), month("2026-10", { moneyIn: 2000, net: 2000, netProfitExVat: 2200, taxRefunds: 43633.73 }), month("2026-11", {}, true)],
  byCurrency: [
    { currency: "USD", moneyIn: "6000.00", moneyOut: "0.00", moneyInEur: 5360.49, moneyOutEur: 0 },
    { currency: "GBP", moneyIn: "25.00", moneyOut: "0.00", moneyInEur: 33.1, moneyOutEur: 0 },
  ],
  entries: [
    { id: "r1", date: "2026-10-23", amount: "6000", currency: "USD", amountEur: "5360.49", bookedRateSource: "ECB 23 Oct 2026", eur: 5360.49, rate: 1.1193, rateDate: "2026-10-23", rateSource: "ecb", counterparty: "<Payer & Co>", category: "Sponsorship", subtype: "Invoice" },
    { id: "r2", date: "2026-10-24", amount: "25", currency: "GBP", amountEur: null, eur: 33.1, rate: null, rateDate: null, rateSource: null, counterparty: "No-rate & Co" },
  ],
  taxRefunds: [{ id: "ledger-refund-1", date: "2026-10-30", month: "2026-10", eur: 43633.73, taxType: "other", counterparty: "Finanzamt <Synthetic>", description: "Erstattung" }],
  duplicates: [{ keptId: "a", droppedId: "b", reason: "sheet row repeats sponsor-receipt row" }],
  gaps: [],
  rules: ["Ledger rows are the only thing counted."],
  rateErrors: [],
};

describe("finance overview", () => {
  test("reads only an annual year from the URL and defaults to the current calendar year", () => {
    assert.deepEqual(periodFromParams(new URLSearchParams("month=2025-10"), "2026-10-31"), { year: "2026" });
    assert.deepEqual(periodFromParams(new URLSearchParams("year=2025"), "2026-10-31"), { year: "2025" });
    assert.deepEqual(periodFromParams(new URLSearchParams("ytd=1"), "2031-01-01"), { year: "2031" });
    assert.deepEqual(periodFromParams(new URLSearchParams("year=bad&month=2026-10"), "2026-10-31"), { year: "2026" });
  });

  test("offers a dynamic Current year action and an annual year selector only", () => {
    const current = periodControlsMarkup({ year: "2031" }, "2031-01-01", e);
    assert.match(current, /data-fin-period="current-year" aria-pressed="true">Current year/);
    assert.match(current, /<option value="2031" selected>2031<\/option>/);
    assert.doesNotMatch(current, /Year to date|data-fin-month|type="month"/);
    const historical = periodControlsMarkup({ year: "2025" }, "2031-01-01", e);
    assert.match(historical, /data-fin-period="current-year" aria-pressed="false">Current year/);
    assert.match(historical, /<option value="2025" selected>2025<\/option>/);
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
    assert.match(markup, /<dt>Taxes and TK paid<\/dt><dd data-fin-taxes-total>420\.00<\/dd>/);
    assert.match(markup, /After taxes and TK paid 420\.00: <strong>1,680\.00<\/strong>/);
    assert.doesNotMatch(markup, /no VAT amount|vat-unknown/i);
    assert.ok(markup.indexOf("data-fin-profit") < markup.indexOf("<svg"));
  });

  test("draws both charts and a table with a total row, marking months not over yet", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.equal((markup.match(/<svg /g) || []).length, 2);
    assert.match(markup, /<th scope="row">Total<\/th>/);
    assert.match(markup, /<a class="fin-table__month-link" data-fin-month-link href="\/bookkeeping\?month=2026-11">2026-11<\/a> <small>\(not over\)<\/small>/);
    assert.match(markup, /dataops finance summary --year 2026/);
    for (const header of ["ESt \\+ Soli", "GewSt", "TK", "Taxes total", "Tax refunds", "Owner pay", "Output VAT", "Input VAT", "VAT paid", "VAT refunded", "VAT position"])
      assert.match(markup, new RegExp(`<th scope="col">${header}</th>`));
    assert.match(markup, /<th scope="row"><a class="fin-table__month-link" data-fin-month-link href="\/bookkeeping\?month=2026-09">2026-09<\/a><\/th>/);
    assert.match(markup, /<th scope="row">Total<\/th>/);
    assert.doesNotMatch(markup.match(/<tr class="fin-table__total">[\s\S]*?<\/tr>/)?.[0] || "", /data-fin-bookkeeping-row|data-fin-month-link/);
  });

  test("shows ESt, GewSt and TK separately and together per month, with refunds in their own column", () => {
    const markup = monthTableMarkup(YEAR, e);
    assert.match(markup, /<th scope="col">ESt \+ Soli<\/th><th scope="col">GewSt<\/th><th scope="col">TK<\/th>\s*<th scope="col">Taxes total<\/th><th scope="col">Tax refunds<\/th><th scope="col">Owner pay<\/th>/);
    assert.doesNotMatch(markup, /<th scope="col">Taxes<\/th>|Other taxes/);
    const cellsOf = (row) => [...row.matchAll(/<td class="fin-num">([^<]+)<\/td>/g)].map((match) => match[1]);
    const rows = [...markup.matchAll(/<tr class="[^"]*"(?: data-fin-bookkeeping-row)?>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    assert.deepEqual(cellsOf(rows[0]), [
      "1,000.00", "1,300.00", "−300.00", "0.00", "0.00", "−100.00", "20.00", "10.00", "15.00", "45.00", "0.00", "100.00",
      "50.00", "15.00", "45.00", "5.00", "35.00", "0",
    ]);
    // The October refund is a refund, not a negative tax: tax columns stay at zero.
    assert.deepEqual(cellsOf(rows[1]).slice(6, 11), ["0.00", "0.00", "0.00", "0.00", "43,633.73"]);
    const withOther = monthTableMarkup({ ...YEAR, months: [month("2026-09", { otherTaxes: 12, taxesTotal: 12 })] }, e);
    assert.match(withOther, /<th scope="col">Other taxes<\/th>/);
  });

  test("shows taxes paid by type and combined, and lists tax refunds with ledger IDs outside taxes", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.match(markup, /Taxes paid in 2026/);
    assert.match(markup, /<dt>Einkommensteuer \+ Soli<\/dt><dd data-fin-tax="income-tax">300\.00/);
    assert.match(markup, /<dt>Gewerbesteuer<\/dt><dd data-fin-tax="trade-tax">100\.00/);
    assert.match(markup, /<dt>TK health insurance<\/dt><dd data-fin-tax="health-insurance">20\.00/);
    assert.match(markup, /<dt>Total taxes and TK<\/dt><dd data-fin-tax="total">420\.00/);
    assert.doesNotMatch(markup, /data-fin-tax="other"/);
    assert.match(markup, /Tax refunds received: 43,633\.73 EUR/);
    assert.match(markup, /never a negative tax in any year/);
    assert.match(markup, /<a href="\/bookkeeping\?month=2026-10">2026-10-30<\/a>/);
    assert.match(markup, /Finanzamt &lt;Synthetic&gt;/);
    assert.match(markup, /<code>ledger-refund-1<\/code>/);
    assert.doesNotMatch(overviewMarkup({ ...YEAR, taxRefunds: [] }, e), /data-fin-refunds/);
  });

  test("has no Data gaps or How these numbers are made section", () => {
    const markup = overviewMarkup({ ...YEAR, gaps: [{ kind: "unconverted", message: "Rows without a rate", count: 2 }] }, e);
    assert.doesNotMatch(markup, /Data gaps|How these numbers are made|fin-rules|fin-gaps-heading|Rows without a rate|dropped as duplicates/);
  });

  test("keeps the Finance annual report in EUR without a yearly currencies dump", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.doesNotMatch(markup, /Currencies|fin-currency__conversion|6000\.00 USD|25\.00 GBP/);
    assert.match(markup, /data-fin-profit>2,100\.00 <span class="fin-tile__unit">EUR/);
    assert.match(markup, /dataops finance summary --year 2026/);
  });

  test("opens a monthly summary row in its matching Bookkeeping month without stealing selection or controls", () => {
    assert.equal(bookkeepingMonthUrl("2026-09"), "/bookkeeping?month=2026-09");
    assert.equal(bookkeepingMonthUrl("Total"), "");
    const row = { querySelector: () => link };
    let opened = 0;
    const link = { click: () => { opened += 1; } };
    const target = (options = {}) => ({
      closest(selector) {
        if (selector === "tr[data-fin-bookkeeping-row]") return options.total ? null : row;
        if (selector.includes("[data-fin-month-link]") && options.link) return link;
        if (selector.includes("button") && options.control) return options.control;
        return null;
      },
    });
    const event = (options = {}) => ({ target: target(options), detail: 1, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    assert.equal(activateFinanceMonthlyRow(event()), true);
    assert.equal(opened, 1);
    assert.equal(activateFinanceMonthlyRow(event({ total: true })), false);
    assert.equal(activateFinanceMonthlyRow(event({ control: {} })), false);
    assert.equal(activateFinanceMonthlyRow(event(), { isCollapsed: false, toString: () => "select text" }), false);
    assert.equal(opened, 1);
    const selectedLinkEvent = event({ link: true });
    assert.equal(activateFinanceMonthlyRow(selectedLinkEvent, { isCollapsed: false, toString: () => "select month" }), false);
    assert.equal(selectedLinkEvent.defaultPrevented, true);
  });

  test("puts money out below the baseline and labels every month for hover and screen readers", () => {
    const svg = cashChartMarkup(YEAR.months, e);
    assert.equal((svg.match(/data-fin-hover=/g) || []).length, 3);
    assert.match(svg, /2026-09: in 1,000\.00, out 1,300\.00, net −300\.00 EUR/);
    assert.match(svg, /class="fin-chart__month is-future"/);
  });

  test("adds intermediate EUR grid labels for positive and negative monthly profit", () => {
    const svg = profitChartMarkup([
      month("2026-01", { netProfitExVat: 50000 }),
      month("2026-02", { netProfitExVat: 25000 }),
      month("2026-03", { netProfitExVat: -12500 }),
    ], e);
    assert.equal((svg.match(/class="fin-chart__grid/g) || []).length, 5);
    for (const tick of ["50k", "25k", "−25k", "−50k"])
      assert.match(svg, new RegExp(`>${tick}<\\/text>`));
  });

  test("styles the native Finance year popup with theme tokens and distinct native states", () => {
    const css = readFileSync(new URL("../src/styles/finance.css", import.meta.url), "utf8");
    assert.match(css, /:root\[data-theme="dark"\] \.fin-period \[data-fin-year\] \{ color-scheme: dark; \}/);
    for (const state of [":checked", ":hover", ":focus-visible", ":disabled"])
      assert.match(css, new RegExp(`\\[data-fin-year\\] option${state}`));
    assert.match(css, /var\(--dk-bg-surface\)/);
    assert.match(css, /var\(--dk-text-primary\)/);
    assert.doesNotMatch(css, /\.fin-period \[data-fin-year\][^{]*\{[^}]*appearance:\s*none/s);
  });
});

const ESTIMATE = {
  year: 2026, basis: "grundtarif-berlin", profitEur: 100000, zvEEur: 100000,
  incomeTax: { tariflich: 30865, section35Relief: 10570, einkommensteuer: 20295 },
  soli: 0, tradeTax: { messbetrag: 2642.5, steuer: 10834.25 }, totalEstimate: 31129.25,
  paid: { incomeTax: 300, tradeTax: 100 }, paidTotal: 400, remaining: 30729.25,
  planning: {
    ownerPayEur: 12000, projectedAfterTaxEur: 68870.75, safeToWithdrawEur: 4521.25,
    businessBalance: { totalEur: 5250.50, accounts: [{ accountId: "finom", wallet: "", amountEur: 5000, asOf: "2026-11-12" }, { accountId: "revolut", wallet: "", amountEur: 250.5, asOf: "2026-11-12" }] },
    formula: [
      "Projected year-end money after tax = profit earned so far (100000 EUR) − total tax estimate (31129.25 EUR) = 68870.75 EUR.",
      "Safe to withdraw now = business account balance (finom 5000.00 EUR + revolut 250.50 EUR) − estimated remaining tax for 2026 (30729.25 EUR) = 4521.25 EUR.",
      "Owner withdrawals already made in 2026 (12000.00 EUR) are not added back: that money has already left the balance.",
    ],
  },
  inputs: ["Profit earned so far in 2026 (net profit excluding VAT from the finance summary): 100000 EUR"],
  formula: ["Einkommensteuer: § 32a Abs. 1 EStG Grundtarif on zvE 100000 EUR → 30865 EUR, minus § 35 Abs. 1 EStG relief (4 × Messbetrag, max Gewerbesteuer) 10570 EUR → 20295 EUR."],
  sources: ["§ 32a Abs. 1 EStG, ab VZ 2026 (gesetze-im-internet.de/estg/__32a.html; Grundfreibetrag 12.348 €, Steuerbetrag aufgerundet)"],
  disclaimer: "Rough estimate, not a tax return: statutory tariffs applied to the profit booked so far.",
};

const ASSESSMENT_2025 = {
  year: 2025, closed: true,
  assessed: { incomeTax: 27542, soli: 721.37, tradeTax: 17174.90, vat: 13945.51 },
  paid: { incomeTax: 41252, soli: 2916, tradeTax: 13184, vat: 4581.14 },
  refunded: 15904.63, refundedOn: "2026-10-30",
  notes: ["Ausgezahlt wurden 15.904,63 € am 30.10.2026 (ESt 13.710,00 € + Soli 2.194,63 €)."],
  sources: ["Bescheid vom 29.10.2026 über Einkommensteuer und Solidaritätszuschlag für 2025, FA Pankow/Weißensee (zvE 127.811 €, §-35-Ermäßigung 16.756 €)"],
};

describe("tax estimate block", () => {
  test("fills itself when the year loads, with no Calculate tax button", () => {
    const markup = overviewMarkup(YEAR, e);
    assert.match(markup, /Tax estimate <span class="fin-muted">rough, Berlin, from the profit earned so far in 2026/);
    assert.match(markup, /data-fin-estimate-body><p class="fin-muted">Calculating…<\/p><\/div>/);
    assert.doesNotMatch(markup, /data-fin-tax-estimate|Calculate tax/);
    assert.doesNotMatch(markup, /data-fin-estimate-result/);
  });

  test("renders the after-tax planning numbers next to the estimate for an open year", () => {
    const markup = taxEstimateMarkup(ESTIMATE, e);
    assert.match(markup, /data-fin-planning-after-tax>68,870\.75/);
    assert.match(markup, /data-fin-planning-safe>4,521\.25/);
    assert.match(markup, /data-fin-planning-owner-pay>12,000\.00/);
    assert.match(markup, /Safe to withdraw now <span class="fin-muted">rough<\/span>/);
    assert.match(markup, /Safe to withdraw now = business account balance \(finom 5000\.00 EUR \+ revolut 250\.50 EUR\)/);
    assert.match(markup, /Owner withdrawals already made in 2026 \(12000\.00 EUR\) are not added back/);
  });

  test("shows an unknown balance as not-yet-available instead of a number", () => {
    const markup = taxEstimateMarkup({ ...ESTIMATE, planning: { ...ESTIMATE.planning, safeToWithdrawEur: null, businessBalance: { totalEur: null, accounts: [] } } }, e);
    assert.match(markup, /data-fin-planning-safe><span class="fin-muted">unknown until a bank statement is uploaded<\/span>/);
  });

  test("renders ESt, Soli and GewSt separately and in total, labelled as an estimate", () => {
    const markup = taxEstimateMarkup(ESTIMATE, e);
    assert.match(markup, /data-fin-est-income-tax>20,295\.00/);
    assert.match(markup, /data-fin-est-soli>0\.00/);
    assert.match(markup, /Gewerbesteuer <span class="fin-muted">Berlin Hebesatz 410 %<\/span><\/dt><dd data-fin-est-trade-tax>10,834\.25/);
    assert.match(markup, /data-fin-est-total>31,129\.25/);
    assert.match(markup, /data-fin-est-paid-line>Already paid in 2026:\s+ESt \+ Soli 300\.00, GewSt 100\.00\s+— total <strong>400\.00<\/strong>/);
    assert.match(markup, /Compared with the estimate:\s+an estimated <strong>30,729\.25<\/strong> still to pay in 2026/);
    assert.match(markup, /Refunds for earlier years never count as negative tax/);
    assert.match(markup, /Rough estimate, not a tax return/);
    assert.match(markup, /§ 32a Abs\. 1 EStG Grundtarif on zvE 100000 EUR/);
    assert.match(markup, /gesetze-im-internet\.de\/estg\/__32a\.html/);
  });

  test("shows overpayment as paid more than the estimate, never as a negative tax", () => {
    const markup = taxEstimateMarkup({ ...ESTIMATE, remaining: -650.5 }, e);
    assert.match(markup, /already <strong>650\.50<\/strong> more paid than this rough estimate/);
    assert.doesNotMatch(markup, /still to pay in 2026/);
  });

  test("cites the Bescheid as the paid source and drops the planning numbers for a closed year", () => {
    const markup = taxEstimateMarkup({ ...ESTIMATE, year: 2025, assessment: ASSESSMENT_2025 }, e);
    assert.match(markup, /data-fin-est-paid-line>Per the Bescheid, prepaid in 2025/);
    assert.doesNotMatch(markup, /data-fin-planning|Safe to withdraw now|projected year-end/i);
    assert.match(markup, /gesetze-im-internet\.de\/estg\/__32a\.html/);
  });

  test("keeps the estimate section year-scoped", () => {
    assert.match(taxEstimateSectionMarkup("2025", e), /profit earned so far in 2025/);
    assert.match(taxEstimateSectionMarkup("2025", e), /Calculating…/);
  });
});

describe("closed-year taxes from the stored Bescheid", () => {
  const CLOSED_YEAR = { ...YEAR, period: { ...YEAR.period, label: "2025" }, taxReturn: ASSESSMENT_2025 };

  test("fills the tax figures from the Bescheid instead of the ledger buckets", () => {
    const markup = overviewMarkup(CLOSED_YEAR, e);
    assert.match(markup, /Taxes in 2025\s+<span class="fin-muted" data-fin-closed-badge>closed — figures per Bescheid<\/span>/);
    assert.match(markup, /data-fin-official-income-tax>assessed 28,263\.37 · prepaid 44,168\.00/);
    assert.match(markup, /data-fin-official-trade-tax>assessed 17,174\.90 · prepaid 13,184\.00/);
    assert.match(markup, /data-fin-official-vat>assessed 13,945\.51 · paid 4,581\.14/);
    assert.match(markup, /data-fin-official-refund>15,904\.63 <span class="fin-muted">paid out 2026-10-30<\/span>/);
    assert.doesNotMatch(markup, /Taxes paid in 2025/);
  });

  test("shows offsets, notes and the Bescheid sources, and keeps TK on the ledger", () => {
    const markup = taxesMarkup({ ...CLOSED_YEAR, totals: totals({ healthInsurance: 1179.36 }) }, e);
    assert.match(markup, /<dt>TK health insurance<\/dt><dd data-fin-tax="health-insurance">1,179\.36<\/dd>/);
    assert.match(markup, /data-fin-official-sources/);
    assert.match(markup, /Ausgezahlt wurden 15\.904,63 € am 30\.10\.2026/);
    assert.match(markup, /Bescheid vom 29\.10\.2026 über Einkommensteuer und Solidaritätszuschlag für 2025/);
    const withOffsets = taxesMarkup({ ...CLOSED_YEAR, taxReturn: { ...ASSESSMENT_2025, offsets: [{ amount: 1116.9, target: "Gewerbesteuer 2025" }] } }, e);
    assert.match(withOffsets, /Not paid out but carried: <strong>1,116\.90<\/strong> to Gewerbesteuer 2025\./);
  });
});

describe("upcoming tax debits section", () => {
  const U = {
    today: "2026-10-31", days: 60, dueNext30: 5134.64, dueInWindow: 17356, shortfall: true,
    balance: { accountId: "finom", amount: 5000, currency: "EUR", asOf: "2026-10-30", stale: false },
    debits: [
      { label: "Trade tax prepayment", taxType: "trade-tax", date: "2026-11-16", shifted: "due 2026-11-15 falls on Sunday", amount: 3296, source: "Bescheid", sourceRef: null, approximate: false, status: "scheduled", matched: null },
      { label: "TK <health>", taxType: "health-insurance", date: "2026-11-16", shifted: null, amount: 1179.36, source: "recurring", sourceRef: null, approximate: true, status: "paid", matched: { kind: "statement", date: "2026-11-17" } },
    ],
    warnings: ["Balance 5000.00 EUR is below the 5134.64 EUR due in the next 30 days"],
  };
  test("shows the 30-day total, balance with as-of date, shortfall, shift reasons and paid status", async () => {
    const { upcomingMarkup } = await import("../src/surfaces/finance/overview.js");
    const markup = upcomingMarkup(U, e);
    assert.match(markup, /data-fin-due30>5,134\.64</);
    assert.match(markup, /5,000\.00 EUR\s+<span class="fin-muted">\(finom, as of 2026-10-30\)/);
    assert.match(markup, /role="alert">Shortfall/);
    assert.match(markup, /due 2026-11-15 falls on Sunday/);
    assert.match(markup, /Paid \(statement 2026-11-17\)/);
    assert.match(markup, /TK &lt;health&gt;/);
    const unknown = upcomingMarkup({ ...U, balance: null, shortfall: null }, e);
    assert.match(unknown, /<span class="fin-muted">unknown<\/span>/);
    assert.doesNotMatch(unknown, /Shortfall/);
  });
});
