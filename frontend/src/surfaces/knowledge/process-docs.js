export function createProcessDocsSurface(context, services) {
  const {
    basename,
    buildOperationsHomeModel,
    buildOperationsReferenceLinks,
    buildProcessQualityModel,
    documentList,
    getDocsAvailability,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    knowledgeState,
    listDraftPaths,
    qualityFiltersState,
    renderDocsAvailabilityState,
    renderHonestState,
    renderOperationsReference,
    renderQualityFindingRow,
    renderSurfaceHeader,
    setRouteTitle,
    showCreate,
  } = context;
  const { openDocument, refreshDocuments } = services;

  function renderDocsSurface(documents) {
    const visibleDocuments = Array.isArray(documents) ? documents : [];
    const model = buildOperationsHomeModel(visibleDocuments, {
      draftPaths: listDraftPaths(),
      workSnapshot: getOperationsWorkSnapshot(),
      recurringSnapshot: getOperationsRecurringSnapshot(),
      qualitySnapshot: getOperationsQualitySnapshot(),
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setRouteTitle("Docs");
    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-docs";
    const header = renderSurfaceHeader("Docs");
    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "primary-button ops-docs-create";
    createButton.textContent = "New process doc";
    createButton.addEventListener("click", () => showCreate());
    header.append(createButton);
    wrap.append(header);
    wrap.append(renderProcessesSurface(visibleDocuments, model));
    documentList.replaceChildren(wrap);
  }

  function renderProcessesSurface(documents, model) {
    const section = document.createElement("section");
    section.className = "ops-processes-surface";
    const quality =
      model?.quality ||
      buildProcessQualityModel(
        getOperationsQualitySnapshot(),
        getOperationsWorkSnapshot(),
      );

    const docsState = renderCatalogState(documents);
    if (docsState) section.append(docsState);

    const catalog = renderDocumentCatalog(documents);
    if (catalog) section.append(catalog);

    const findings = renderProcessQualityDrilldown(quality);
    if (findings) section.append(findings);

    const projectDocs = renderProjectDocs(documents);
    if (projectDocs) section.append(projectDocs);
    return section;
  }

  function renderDocumentCatalog(documents) {
    const visibleDocuments = Array.isArray(documents) ? documents : [];
    if (visibleDocuments.length === 0) return null;
    const list = document.createElement("section");
    list.className = "ops-docs-catalog";
    list.setAttribute("aria-label", "Process documents");
    for (const doc of visibleDocuments) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ops-docs-catalog-row";
      const title = document.createElement("strong");
      title.textContent = doc.title || basename(doc.path);
      const meta = document.createElement("span");
      meta.textContent = catalogMeta(doc);
      row.append(title, meta);
      row.addEventListener("click", () => openDocument(doc.path));
      list.append(row);
    }
    return list;
  }

  function catalogMeta(doc) {
    const type = humanizeDocType(doc.doc_type);
    const domain = doc.domain ? String(doc.domain) : "";
    const summary = String(doc.summary || doc.description || "").trim();
    const parts = [];
    if (type) parts.push(type);
    if (domain && domain.toLowerCase() !== type.toLowerCase()) parts.push(domain);
    if (!type && !domain && summary) parts.push(summary);
    else if (summary && parts.length === 0) parts.push(summary);
    return parts.join(" · ");
  }

  function humanizeDocType(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "sop") return "SOP";
    return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function renderProjectDocs(documents) {
    const refs = (buildOperationsReferenceLinks(documents) || []).filter(
      (ref) => ref.href && !ref.path,
    );
    if (refs.length === 0) return null;
    const wrap = document.createElement("details");
    wrap.className = "ops-project-docs";
    const summary = document.createElement("summary");
    summary.textContent = "Project docs";
    wrap.append(summary);
    const grid = document.createElement("div");
    grid.className = "ops-reference-grid";
    for (const ref of refs) grid.append(renderOperationsReference(ref));
    wrap.append(grid);
    return wrap;
  }

  function renderCatalogState(documents) {
    const snapshot = getDocsAvailability() || {};
    const visibleDocuments = Array.isArray(documents) ? documents : [];

    if (snapshot.state === "unavailable") {
      return markLiveState(
        renderDocsAvailabilityState(snapshot),
        "unavailable",
      );
    }
    if (snapshot.state === "loaded" && Number(snapshot.documentCount || 0) === 0) {
      return markLiveState(
        renderDocsAvailabilityState(snapshot, { includeEmpty: true }),
        "empty",
      );
    }
    if (snapshot.state === "loading") {
      return renderCatalogNotice(
        "Loading Process Docs",
        "Fetching the process-document catalog…",
        "loading",
        "Work, Cards, and Tasks remain independent while the catalog loads.",
      );
    }

    const activeFilters = Object.values(knowledgeState.documentFilters || {})
      .filter(Boolean).length;
    if (
      snapshot.state === "loaded" &&
      activeFilters > 0 &&
      visibleDocuments.length === 0
    ) {
      const documentLabel =
        snapshot.documentCount === 1 ? "process document" : "process documents";
      const filterLabel =
        activeFilters === 1 ? "active metadata filter" : "active metadata filters";
      return renderCatalogNotice(
        "No Process Docs match these filters",
        `The catalog contains ${snapshot.documentCount} ${documentLabel}, but none match the ${activeFilters} ${filterLabel}.`,
        "filter-empty",
        "Use Search filters and choose Clear filters to restore the full catalog.",
      );
    }
    return null;
  }

  function renderCatalogNotice(title, body, state, detail) {
    const node = renderHonestState(title, body);
    node.className = `${node.className} ops-docs-state`.trim();
    node.dataset.docsState = state;
    if (detail) {
      const note = document.createElement("small");
      note.className = "ops-docs-state-detail";
      note.textContent = detail;
      node.append(note);
    }
    return markLiveState(node, state);
  }

  function markLiveState(node, state) {
    if (!node) return node;
    node.setAttribute("role", state === "unavailable" ? "alert" : "status");
    node.setAttribute(
      "aria-live",
      state === "unavailable" ? "assertive" : "polite",
    );
    node.setAttribute("aria-atomic", "true");
    return node;
  }

  function renderProcessQualityDrilldown(quality) {
    if (!quality?.loaded || Number(quality.totalFindings || 0) === 0) return null;

    const wrap = document.createElement("details");
    wrap.className = "ops-section ops-quality-drilldown";
    wrap.setAttribute("aria-label", "Process quality findings");
    wrap.dataset.qualityState = "loaded";

    const summary = document.createElement("summary");
    summary.className = "ops-quality-summary";
    const total = document.createElement("strong");
    total.className = "ops-count";
    total.textContent = String(quality.totalFindings);
    summary.append(total, ` finding${quality.totalFindings === 1 ? "" : "s"}`);
    wrap.append(summary);

    if (!quality.activeWorkLoaded) {
      wrap.append(
        markLiveState(renderHonestState(
          "Live work unavailable",
          "Active Task/Card impact cannot be confirmed. Severity below reflects Template and Process Doc risk only.",
        ), "unavailable"),
      );
    }

    const filters = document.createElement("div");
    filters.className = "ops-quality-filters";
    filters.setAttribute("aria-label", "Filter quality findings");
    const findings = quality.maintainerFindings;
    const filterDefs = [
      [
        "severity",
        "Severity",
        ["", ...uniqueSorted(findings.map((finding) => finding.severity))],
      ],
      [
        "category",
        "Category",
        ["", ...uniqueSorted(findings.map((finding) => finding.category))],
      ],
      [
        "workflow",
        "Workflow",
        [
          "",
          ...uniqueSorted(
            findings
              .map((finding) => finding.workflowSlug || finding.templateId)
              .filter(Boolean),
          ),
        ],
      ],
      [
        "document",
        "Document",
        [
          "",
          ...uniqueSorted(
            findings
              .map(
                (finding) =>
                  finding.docPath || finding.docId || finding.instructionDocId,
              )
              .filter(Boolean),
          ),
        ],
      ],
    ];
    for (const [key, labelText, values] of filterDefs) {
      const label = document.createElement("label");
      label.className = "ops-quality-filter";
      label.textContent = labelText;
      const select = document.createElement("select");
      select.setAttribute("aria-label", labelText);
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value ? value : "All";
        select.append(option);
      }
      select.value = qualityFiltersState.value[key] || "";
      select.addEventListener("change", () => {
        qualityFiltersState.value = {
          ...qualityFiltersState.value,
          [key]: select.value,
        };
        refreshDocuments();
      });
      label.append(select);
      filters.append(label);
    }
    const disclosure = document.createElement("details");
    disclosure.className = "ops-quality-filters-disclosure";
    const compact = isCompactViewport();
    disclosure.open = !compact || qualityFiltersState.disclosureOpen === true;
    disclosure.addEventListener("toggle", () => {
      if (isCompactViewport()) {
        qualityFiltersState.disclosureOpen = disclosure.open;
      }
    });
    const activeFilterCount = Object.values(qualityFiltersState.value || {})
      .filter(Boolean).length;
    const disclosureSummary = document.createElement("summary");
    disclosureSummary.textContent = activeFilterCount
      ? `Filter findings · ${activeFilterCount} active`
      : "Filter findings";
    disclosure.append(disclosureSummary, filters);
    wrap.append(disclosure);

    const filtered = filterQualityFindings(findings, qualityFiltersState.value);
    const list = document.createElement("div");
    list.className = "ops-quality-list";
    if (filtered.length === 0) {
      list.append(
        markLiveState(renderHonestState(
          findings.length === 0
            ? "No findings"
            : "No findings match filters",
          findings.length === 0
            ? "Published process docs pass validation."
            : "Change filters to inspect other process quality findings.",
        ), "empty"),
      );
    } else {
      for (const finding of filtered.slice(0, 80))
        list.append(renderQualityFindingRow(finding));
      if (filtered.length > 80) {
        const more = document.createElement("p");
        more.className = "ops-empty";
        more.textContent = `Showing 80 of ${filtered.length} findings. Narrow the filters to inspect the rest.`;
        list.append(more);
      }
    }
    wrap.append(list);
    return wrap;
  }

  function filterQualityFindings(findings, filters) {
    return findings.filter((finding) => {
      if (filters.severity && finding.severity !== filters.severity) return false;
      if (filters.category && finding.category !== filters.category) return false;
      if (
        filters.workflow &&
        ![finding.workflowSlug, finding.templateId].includes(filters.workflow)
      )
        return false;
      if (
        filters.document &&
        ![finding.docPath, finding.docId, finding.instructionDocId].includes(
          filters.document,
        )
      )
        return false;
      return true;
    });
  }

  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean).map(String))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  function isCompactViewport() {
    return Boolean(
      document.defaultView?.matchMedia?.("(max-width: 820px)")?.matches,
    );
  }

  return { renderDocsSurface, renderProcessesSurface };
}
