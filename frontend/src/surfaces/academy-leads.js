import { createPageHeader } from "./operations-overview.js";

function el(documentRef, tag, className, text = "") {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function escapeCsvCell(value) {
  const str = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function createAcademyLeadsSurface(context) {
  const {
    documentList,
    documentRef = globalThis.document,
    getActiveWorkspaceRoute,
    navigateCanonicalWorkspace,
    request,
    setRouteTitle,
    workApiUrl,
  } = context;

  let leads = [];
  let summary = {
    total: 0,
    testCount: 0,
    byTrack: { "agentic-engineering": 0, "ai-engineering": 0 },
    firstChoice: { "agentic only": 0, "AI only": 0, both: 0 },
    byUtm: [],
  };
  let loading = false;
  let error = "";
  let loadedKey = null;

  function readParam(params, name) {
    if (!params) return "";
    if (typeof params.get === "function") return params.get(name) || "";
    return params[name] || "";
  }

  function currentFilters() {
    const route = getActiveWorkspaceRoute();
    const includeTestsVal = readParam(route?.params, "includeTests");
    const includeTests = includeTestsVal === "true" || includeTestsVal === "1";
    const track = readParam(route?.params, "track");
    return { includeTests, track };
  }

  function filterKey({ includeTests, track }) {
    return `${includeTests ? "1" : "0"}:${track}`;
  }

  async function load(filters = currentFilters()) {
    if (loading) return;
    loading = true;
    error = "";
    loadedKey = filterKey(filters);
    try {
      const query = {};
      if (filters.includeTests) query.includeTests = "true";
      if (filters.track) query.track = filters.track;
      const payload = await request(workApiUrl("/api/academy-leads", query));
      leads = Array.isArray(payload?.leads) ? payload.leads : [];
      summary = payload?.summary || summary;
    } catch (caught) {
      error = caught?.message || "Academy leads are unavailable";
    } finally {
      loading = false;
      renderAcademyLeads();
    }
  }

  function downloadCsv() {
    const cols = [
      "created_at", "email", "track",
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "last_utm_source", "last_utm_medium", "last_utm_campaign", "last_utm_content", "last_utm_term",
      "referrer", "page", "is_test", "answers",
    ];
    const lines = [cols.join(",")];
    for (const row of leads) {
      lines.push(
        cols
          .map((c) => escapeCsvCell(c === "answers" ? JSON.stringify(row.answers || {}) : row[c]))
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = documentRef.createElement("a");
    a.href = url;
    a.download = "academy-leads.csv";
    documentRef.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function renderControls(root, filters) {
    const bar = el(documentRef, "div", "row-actions");

    const toggleLabel = el(documentRef, "label", "dk-checkbox-label");
    const checkbox = documentRef.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = filters.includeTests;
    checkbox.dataset.academyIncludeTests = "true";
    checkbox.addEventListener("change", () => {
      navigateCanonicalWorkspace("/academy-leads", {
        ...(checkbox.checked ? { includeTests: "true" } : {}),
        ...(filters.track ? { track: filters.track } : {}),
      });
    });
    toggleLabel.append(checkbox, documentRef.createTextNode(` Show test leads (${summary.testCount || 0})`));

    const trackSelect = documentRef.createElement("select");
    trackSelect.setAttribute("aria-label", "Filter by track");
    trackSelect.dataset.academyTrackFilter = "true";
    for (const [val, label] of [
      ["", "All tracks"],
      ["agentic-engineering", "agentic-engineering"],
      ["ai-engineering", "ai-engineering"],
    ]) {
      const opt = documentRef.createElement("option");
      opt.value = val;
      opt.textContent = label;
      opt.selected = filters.track === val;
      trackSelect.append(opt);
    }
    trackSelect.addEventListener("change", () => {
      navigateCanonicalWorkspace("/academy-leads", {
        ...(filters.includeTests ? { includeTests: "true" } : {}),
        ...(trackSelect.value ? { track: trackSelect.value } : {}),
      });
    });

    const refreshBtn = el(documentRef, "button", "dk-button dk-button--secondary dk-button--sm", "Refresh");
    refreshBtn.type = "button";
    refreshBtn.addEventListener("click", () => load(filters));

    const exportBtn = el(documentRef, "button", "dk-button dk-button--secondary dk-button--sm", "Export CSV");
    exportBtn.type = "button";
    exportBtn.disabled = leads.length === 0;
    exportBtn.addEventListener("click", downloadCsv);

    bar.append(toggleLabel, trackSelect, refreshBtn, exportBtn);
    root.append(bar);
  }

  function renderSummary(root) {
    const section = el(documentRef, "section", "dk-section");
    const trackCounts = el(documentRef, "p", "dk-muted");
    const ag = summary.byTrack?.["agentic-engineering"] || 0;
    const ai = summary.byTrack?.["ai-engineering"] || 0;
    const fc = summary.firstChoice || { "agentic only": 0, "AI only": 0, both: 0 };
    trackCounts.textContent =
      `Total: ${summary.total || 0} | agentic-engineering: ${ag} | ai-engineering: ${ai} ` +
      `(unique leads — agentic only: ${fc["agentic only"] || 0}, AI only: ${fc["AI only"] || 0}, both: ${fc.both || 0})`;
    section.append(trackCounts);

    const buckets = Array.isArray(summary.byUtm) ? summary.byUtm : [];
    if (buckets.length > 0) {
      const heading = el(documentRef, "h2", "dk-section-title", "Counts by utm_source / utm_content");
      const wrap = el(documentRef, "div", "dk-table-wrap");
      const table = el(documentRef, "table", "dk-table");
      table.innerHTML =
        "<thead><tr><th>utm_source</th><th>utm_content</th><th>agentic-engineering</th><th>ai-engineering</th><th>total</th></tr></thead>";
      const tbody = documentRef.createElement("tbody");
      for (const b of buckets) {
        const tr = documentRef.createElement("tr");
        for (const val of [b.utm_source, b.utm_content, b.agentic, b.ai, b.total]) {
          const td = documentRef.createElement("td");
          td.textContent = String(val);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      section.append(heading, wrap);
    }
    root.append(section);
  }

  function renderLeadsTable(root) {
    if (loading) {
      root.append(el(documentRef, "p", "dk-muted", "Loading academy leads…"));
      return;
    }
    if (error) {
      root.append(el(documentRef, "p", "dk-error", error));
      return;
    }
    if (leads.length === 0) {
      root.append(el(documentRef, "p", "dk-muted", "No academy leads match the current filter."));
      return;
    }

    const wrap = el(documentRef, "div", "dk-table-wrap");
    const table = el(documentRef, "table", "dk-table");
    const cols = [
      "created_at", "email", "track",
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "referrer", "page", "answers",
    ];
    const thead = documentRef.createElement("thead");
    const headRow = documentRef.createElement("tr");
    for (const col of cols) {
      const th = documentRef.createElement("th");
      th.textContent = col;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = documentRef.createElement("tbody");
    for (const row of leads) {
      const tr = documentRef.createElement("tr");
      if (row.is_test) tr.dataset.isTest = "true";
      for (const col of cols) {
        const td = documentRef.createElement("td");
        if (col === "answers") {
          const entries = Object.entries(row.answers || {});
          td.textContent = entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "";
        } else if (col === "email" && row.is_test) {
          td.textContent = `${row.email} [test]`;
        } else {
          td.textContent = row[col] || "";
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    root.append(wrap);
  }

  function renderAcademyLeads() {
    const route = getActiveWorkspaceRoute();
    if (route?.view !== "academy-leads") return;
    setRouteTitle("Academy Leads");
    const filters = currentFilters();
    const key = filterKey(filters);
    if (!loading && loadedKey !== key) {
      load(filters);
    }
    const root = el(documentRef, "div", "academy-leads-surface");
    root.append(
      createPageHeader({
        title: "Academy Leads",
        subtitle: "Shortlist signups and UTM attribution across tracks (test leads hidden by default).",
        documentRef,
      }),
    );
    renderControls(root, filters);
    renderSummary(root);
    renderLeadsTable(root);
    documentList.replaceChildren(root);
  }

  return { renderAcademyLeads, reloadAcademyLeads: load };
}
