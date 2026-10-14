// Period selectors and client exports share the bookkeeping surface's lens.
// Data and ledger mutations remain owned by bookkeeping.js.
import {
  copyToClipboard, downloadCsv, formatFullCsv, formatReportCsv,
  formatReportTsv, isReportExempt, latestActivityMonth, monthLabel,
  shiftMonth, yearsOf,
} from "./bookkeeping-format.js";

export function mountBookkeepingNavigation({
  surface, closeState, status, setLens, lensEntries, todayIsoDate,
  getEntries, getLens,
}) {
  const yearSelect = surface.querySelector("[data-lens-year]");
  const monthSelect = surface.querySelector("[data-lens-month-select]");
  let lens = getLens();
  let entries = getEntries();
  const MONTH_NAMES = {
    "01": "January",
    "02": "February",
    "03": "March",
    "04": "April",
    "05": "May",
    "06": "June",
    "07": "July",
    "08": "August",
    "09": "September",
    "10": "October",
    "11": "November",
    "12": "December",
  };
  function refresh() {
    lens = getLens();
    entries = getEntries();
    if (!yearSelect || !monthSelect) return;
    const years = yearsOf(entries, lens);
    yearSelect.innerHTML = [
      '<option value="all">All years</option>',
      ...years.map((y) => `<option value="${y}">${y}</option>`),
    ].join("");

    monthSelect.innerHTML = [
      '<option value="all">All months (full year)</option>',
      ...Object.entries(MONTH_NAMES).sort(([a], [b]) => a.localeCompare(b)).map(
        ([m, name]) => `<option value="${m}">${name}</option>`,
      ),
    ].join("");

    syncLensSelectors();
  }
  function syncLensSelectors() {
    if (!yearSelect || !monthSelect) return;
    if (lens === "all") {
      yearSelect.value = "all";
      monthSelect.value = "all";
      monthSelect.disabled = true;
    } else if (/^\d{4}$/.test(lens)) {
      yearSelect.value = lens;
      monthSelect.value = "all";
      monthSelect.disabled = false;
    } else if (/^\d{4}-\d{2}$/.test(lens)) {
      const [y, m] = lens.split("-");
      yearSelect.value = y;
      monthSelect.value = m;
      monthSelect.disabled = false;
    }
  }
  yearSelect?.addEventListener("change", () => {
    const y = yearSelect.value;
    if (y === "all") {
      setLens("all");
      return;
    }
    const m = monthSelect.value;
    if (m === "all") {
      setLens(y);
    } else {
      setLens(`${y}-${m}`);
    }
  });
  monthSelect?.addEventListener("change", () => {
    const m = monthSelect.value;
    let y = yearSelect.value;
    if (y === "all") {
      const years = yearsOf(entries, lens);
      y = years[0] || String(new Date().getFullYear());
      yearSelect.value = y;
    }
    if (m === "all") {
      setLens(y);
    } else {
      setLens(`${y}-${m}`);
    }
  });
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
        "Could not access clipboard. Please use 'Export report CSV'.";
    }
  };
  surface.querySelector("[data-export-report-csv]").addEventListener("click", exportReport);
  closeState.addEventListener("click", (event) => {
    if (event.target.closest("[data-export-report-csv]")) exportReport();
  });
  surface
    .querySelector("[data-export-full-csv]")
    ?.addEventListener("click", exportFull);
  surface
    .querySelector("[data-copy-report]")
    ?.addEventListener("click", copyReport);
  const stepLens = (step) => {
    if (lens !== "all") setLens(shiftMonth(lens, step));
  };
  surface.querySelector("[data-lens-prev]").addEventListener("click", () => stepLens(-1));
  surface.querySelector("[data-lens-next]").addEventListener("click", () => stepLens(1));
  surface
    .querySelector("[data-lens-toggle]")
    .addEventListener("click", () => {
      setLens(
        lens === "all"
          ? latestActivityMonth(
              entries,
              String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7),
            )
          : "all",
      );
    });
  return { refresh };
}
