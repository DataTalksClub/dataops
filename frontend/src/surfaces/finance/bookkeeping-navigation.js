// Period selectors and client exports share the bookkeeping surface's lens.
// Data and ledger mutations remain owned by bookkeeping.js.
import {
  copyToClipboard, downloadCsv, formatFullCsv, formatReportCsv,
  formatReportTsv, isReportExempt, latestActivityMonth, monthLabel,
  shiftMonth,
} from "./bookkeeping-format.js";
import { mountPeriodNav } from "../period-nav.js";

export function mountBookkeepingNavigation({
  surface, status, setLens, lensEntries, todayIsoDate,
  getEntries, getLens,
}) {
  let lens = getLens();
  let entries = getEntries();
  const thisMonth = () => String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7);
  const toolbar = surface.querySelector("[data-period-toolbar]");
  const periodNav = mountPeriodNav(toolbar, {
    dismissScope: surface,
    selected: () => {
      if (/^\d{4}-\d{2}$/.test(lens)) return { year: Number(lens.slice(0, 4)), month: Number(lens.slice(5)) - 1 };
      if (/^\d{4}$/.test(lens)) return { year: Number(lens), month: null };
      return { year: Number(latestActivityMonth(entries, thisMonth()).slice(0, 4)), month: null };
    },
    current: () => ({ year: Number(thisMonth().slice(0, 4)), month: Number(thisMonth().slice(5)) - 1 }),
    onToday: () => setLens(thisMonth()),
    onPrev: () => { if (lens !== "all") setLens(shiftMonth(lens, -1)); },
    onNext: () => { if (lens !== "all") setLens(shiftMonth(lens, 1)); },
    onMonth: (year, month) => setLens(`${year}-${String(month + 1).padStart(2, "0")}`),
    onShortcut: (action, year) => {
      if (action === "current") setLens(thisMonth());
      else if (action === "year") setLens(String(year));
      else setLens("all");
    },
  });
  // The title names the lens: a month, a whole year, or every record.
  function refresh() {
    lens = getLens();
    entries = getEntries();
    const isYear = /^\d{4}$/.test(lens);
    periodNav.setTitle(lens === "all" ? "All records" : isYear ? `${lens} (whole year)` : monthLabel(lens));
    periodNav.setStep({
      prevLabel: isYear ? "Previous year" : "Previous month",
      nextLabel: isYear ? "Next year" : "Next month",
      disabled: lens === "all",
    });
  }
  const exportReport = () => {
    const period = lens === "all" ? "all-records" : lens;
    const filename = `datatalksclub-${period}.csv`;
    const shown = lensEntries();
    const csv = formatReportCsv(shown, { excludeExempt: true });
    downloadCsv(csv, filename);
    const count = shown.filter((e) => !isReportExempt(e)).length;
    status.textContent = `Exported report CSV (${filename}) with ${count} transactions.`;
  };
  const exportFull = () => {
    const period = lens === "all" ? "all-records" : lens;
    const filename = `datatalksclub-${period}-full.csv`;
    const shown = lensEntries();
    const csv = formatFullCsv(shown);
    downloadCsv(csv, filename);
    status.textContent = `Exported full CSV (${filename}) with ${shown.length} transactions.`;
  };
  const copyReport = async () => {
    const period = monthLabel(lens);
    const shown = lensEntries();
    const tsv = formatReportTsv(shown, { excludeExempt: true });
    const count = shown.filter((e) => !isReportExempt(e)).length;
    const ok = await copyToClipboard(tsv);
    if (ok) {
      status.textContent = `✓ Copied report table for ${period} (${count} transactions) to clipboard. Paste directly into email or spreadsheet.`;
    } else {
      status.textContent =
        "Could not access clipboard. Use Export accountant CSV instead.";
    }
  };
  surface.querySelector("[data-export-report-csv]").addEventListener("click", exportReport);
  surface
    .querySelector("[data-export-full-csv]")
    ?.addEventListener("click", exportFull);
  surface
    .querySelector("[data-copy-report]")
    ?.addEventListener("click", copyReport);
  return { refresh };
}
