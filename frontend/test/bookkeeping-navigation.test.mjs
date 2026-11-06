import assert from "node:assert/strict";
import { test } from "node:test";
import { mountBookkeepingNavigation } from "../src/surfaces/finance/bookkeeping-navigation.js";

for (const [selector, format] of [["[data-export-report-csv]", "csv"], ["[data-copy-report]", "tsv"]]) {
  test(`${format} rejection displays blocking rows and preserves the selected month without an artifact`, async () => {
    const handlers = new Map(), calls = [], status = { textContent: "" };
    const toolbar = { querySelector: () => null, querySelectorAll: () => [] };
    const heading = { textContent: "" };
    toolbar.querySelector = (selector) => selector === "[data-period-heading]" ? heading : null;
    const surface = {
      querySelector: (selector) => selector === "[data-period-toolbar]" ? toolbar : {
        addEventListener: (_event, handler) => handlers.set(selector, handler),
      },
      addEventListener() {},
    };
    let artifacts = 0;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      createElement: () => { artifacts++; throw new Error("Unexpected download"); },
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      clipboard: { writeText: async () => { artifacts++; } },
    } });
    try {
      const navigation = mountBookkeepingNavigation({
        surface, status, setLens: () => assert.fail("report action must preserve month"),
        getLens: () => "2037-10", getEntries: () => [], lensEntries: () => [],
        loadAccountantReport: async (period, selectedFormat) => {
          calls.push([period, selectedFormat]);
          throw Object.assign(new Error("Accountant export blocked: 1 unresolved item"), { payload: {
            reportPeriod: period,
            blockers: [{ rowId: "invoice:invented", date: "2037-10-09", counterparty: "<Invented Vendor>",
              amount: "23.00", currency: "EUR", reason: "Payment needs attribution", secret: "never display" }],
          } });
        },
      });
      navigation.refresh();
      await handlers.get(selector)();
      assert.deepEqual(calls, [["2037-10", format]]);
      assert.match(heading.textContent, /October 2037/);
      assert.match(status.textContent, /Accountant export blocked/);
      assert.match(status.textContent, /invoice:invented.*2037-10-09.*<Invented Vendor>.*23.00.*EUR.*Payment needs attribution/);
      assert.doesNotMatch(status.textContent, /never display|Exported|Copied/);
      assert.equal(artifacts, 0);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else delete globalThis.document;
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else delete globalThis.navigator;
    }
  });
}
