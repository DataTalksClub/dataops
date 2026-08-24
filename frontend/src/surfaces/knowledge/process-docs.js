export function createProcessDocsSurface(context, services) {
  const {
    buildOperationsHomeModel,
    buildOperationsReferenceLinks,
    buildProcessQualityModel,
    clearSelectionButton,
    documentList,
    getDocsAvailability,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    libraryTitle,
    listDraftPaths,
    qualityFiltersState,
    renderDocsAvailabilityState,
    renderHonestState,
    renderOperationsReference,
    renderQualityFindingRow,
    renderSurfaceHeader,
    setRouteTitle,
    setStatus,
    showCreate,
    surfaceDescription,
    surfaceStatusText,
  } = context;
  const { refreshDocuments } = services;

  function renderDocsSurface(documents) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: getOperationsWorkSnapshot(),
      recurringSnapshot: getOperationsRecurringSnapshot(),
      qualitySnapshot: getOperationsQualitySnapshot(),
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setLibraryHeadingVisibility(false);
    libraryTitle.textContent = "Docs";
    setRouteTitle("Docs");
    clearSelectionButton.hidden = true;
    setStatus(surfaceStatusText("processes", model));

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-docs";
    const header = renderSurfaceHeader("Docs", surfaceDescription("processes"));
    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "primary-button ops-docs-create";
    createButton.textContent = "New process doc";
    createButton.addEventListener("click", () => {
      if (typeof showCreate === "function") showCreate();
      else document.querySelector("#new-document-button")?.click();
    });
    header.append(createButton);
    wrap.append(header);
    wrap.append(renderProcessesSurface(documents, model));
    documentList.replaceChildren(wrap);
  }

  function setLibraryHeadingVisibility(visible) {
    const heading = libraryTitle.parentElement?.parentElement;
    if (!heading) return;
    heading.hidden = !visible;
    heading.classList.toggle("is-visible", visible);
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
    const note = renderHonestState(
      "Processes support work",
      "Use internal Process Docs from Task or Card context first. Findings below focus on runnable Template/Card risk and maintainer gaps.",
    );
    section.append(note);

    // Docs is the surface where an unreachable corpus is most easily mistaken
    // for an empty one, so the availability state sits above Quality Findings.
    const docsState = renderDocsAvailabilityState(getDocsAvailability(), {
      includeEmpty: true,
    });
    if (docsState) section.append(docsState);

    section.append(renderProcessQualityDrilldown(quality));

    const grid = document.createElement("div");
    grid.className = "ops-reference-grid";
    for (const ref of buildOperationsReferenceLinks(documents))
      grid.append(renderOperationsReference(ref));
    section.append(grid);
    return section;
  }

  function renderProcessQualityDrilldown(quality) {
    const wrap = document.createElement("section");
    wrap.className = "ops-section ops-quality-drilldown";
    wrap.setAttribute("aria-label", "Process quality drill-down");
    wrap.dataset.qualityState = quality.loaded ? "loaded" : "unavailable";

    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Quality Findings";
    const meta = document.createElement("span");
    meta.className = "ops-section-meta";
    meta.textContent = quality.loaded
      ? `${quality.totalFindings} findings · ${quality.summary?.blocking || 0} blocking in template/report data`
      : "Report unavailable";
    header.append(title, meta);
    wrap.append(header);

    if (!quality.loaded) {
      wrap.append(
        renderHonestState(
          "Process quality report unavailable",
          quality.errors[0] || "Validation could not run.",
        ),
      );
      return wrap;
    }
    if (!quality.activeWorkLoaded) {
      wrap.append(
        renderHonestState(
          "Live work unavailable",
          "Active Task/Card impact cannot be confirmed. Severity below reflects Template and Process Doc risk only.",
        ),
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
    wrap.append(filters);

    const filtered = filterQualityFindings(findings, qualityFiltersState.value);
    const list = document.createElement("div");
    list.className = "ops-quality-list";
    if (filtered.length === 0) {
      list.append(
        renderHonestState(
          "No findings match filters",
          "Change filters to inspect other process quality findings.",
        ),
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


  return { renderDocsSurface, renderProcessesSurface };
}
