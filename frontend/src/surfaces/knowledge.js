export function createKnowledgeSurface(context) {
  const {
    apiUrl,
    assistantJobsFromPayload,
    basename,
    buildOperationsHomeModel,
    buildOperationsReferenceLinks,
    buildProcessQualityModel,
    beginDocumentNavigation,
    bundlesFromWorkPayload,
    canLeaveCurrentDocument,
    cleanPath,
    clearSelectionButton,
    closeSidebar,
    closeWorkBellPanel,
    confirmDialog,
    customSelects,
    diffBody,
    diffModal,
    diffTitle,
    docContextReturn,
    docMenuButton,
    docPinButton,
    docTree,
    documentIdMapUnused,
    documentList,
    documentPath,
    documentRowTemplate,
    documentState,
    documentTitle,
    draftKey,
    domainFilter,
    editor,
    editorView,
    emptyNote,
    enterRenderedMode,
    escapeRegex,
    filterCount,
    filterRow,
    filterToggle,
    filtersSection,
    knowledgeState,
    getActiveTasksSection,
    getActiveWorkspaceView,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    labelizeWorkValue,
    libraryTitle,
    listDraftPaths,
    navigateCanonicalWorkspace,
    openBundlePanel,
    openQuickWorkflowForm,
    openTaskPanel,
    qualityFiltersState,
    operationsViewPath,
    operationsViewTitle,
    pinnedList,
    pinnedSection,
    quickNav,
    quickNavInput,
    quickNavResults,
    recentList,
    recentlyViewedList,
    recentlyViewedSection,
    renderedView,
    refreshChangesPanel,
    refreshGitStatus,
    refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot,
    refreshOperationsQualitySnapshot,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    renameCurrentDoc,
    deleteCurrentDoc,
    renderHonestState,
    renderOperationsReference,
    renderOperationsWorkspace,
    renderQualityFindingRow,
    renderSurfaceHeader,
    reportError,
    request,
    resetBundlePanel,
    resetTaskPanel,
    searchInput,
    setPageTitle,
    setSaveState,
    setStatus,
    setView,
    showOperationsHome,
    showWorkspaceSurface,
    surfaceDescription,
    surfaceStatusText,
    systemFilter,
    tagFilter,
    tasksFromWorkPayload,
    titleFromMarkdown,
    typeFilter,
    updateGithubLink,
    updateSaveState,
    updateViewToggleAvailability,
    workApiUrl,
    scheduleAnimationFrame,
    locationAdapter,
    historyAdapter,
    promptUser,
    storage,
    viewportWidth,
    body,
  } = context;

  const PIN_KEY = "dtc-pinned";
  const RECENTLY_VIEWED_KEY = "dtc-recently-viewed";
  const RECENTLY_VIEWED_MAX = 8;
  const LIST_LIMIT = 120;
  const _scrollPositions = new Map();
  let _quickNavIndex = 0;
  let _quickNavMatches = [];

  async function loadDocuments() {
    setStatus("Loading documents...");
    const skeleton = document.querySelector("#tree-skeleton");
    if (skeleton) skeleton.hidden = false;
  
    // Work APIs are independent of the Git-backed docs API. Start their
    // bootstrap requests before awaiting docs so Home, Inbox, assistants,
    // artifacts, and recurring work remain operational during a docs outage.
    refreshOperationsWorkSnapshot({ rerender: true });
    refreshOperationsRecurringSnapshot({ rerender: true });
    refreshOperationsArtifactSnapshot({ rerender: true });
    refreshOperationsAssistantSnapshot({ rerender: true });
    refreshOperationsQualitySnapshot({ rerender: true });
  
    try {
      const payload = await request(apiUrl("/docs"));
      knowledgeState.allDocuments = payload.documents || [];
      rebuildDocumentIdMap();
      populateFilterOptions();
      refreshDocuments();
      renderRecentDocs();
      renderRecentlyViewed();
      renderPinned();
    } catch (error) {
      setStatus(error.message);
    } finally {
      if (skeleton) skeleton.hidden = true;
    }
  }

  function readPins() {
    try {
      const raw = storage.getItem(PIN_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch {
      return new Set();
    }
  }

  function writePins(set) {
    try {
      storage.setItem(PIN_KEY, JSON.stringify([...set]));
    } catch {}
  }

  function toggleCurrentDocPin() {
    if (!documentState.currentDoc) return;
    const pins = readPins();
    if (pins.has(documentState.currentDoc.path)) pins.delete(documentState.currentDoc.path);
    else pins.add(documentState.currentDoc.path);
    writePins(pins);
    renderPinned();
    updatePinButton();
  }

  function updatePinButton() {
    if (!documentState.currentDoc) {
      docPinButton.hidden = true;
      return;
    }
    docPinButton.hidden = false;
    const pinned = readPins().has(documentState.currentDoc.path);
    docPinButton.textContent = pinned ? "Pinned" : "Pin";
    docPinButton.title = pinned ? "Unpin from sidebar" : "Pin to sidebar";
    docPinButton.setAttribute(
      "aria-label",
      pinned ? "Unpin from sidebar" : "Pin to sidebar",
    );
    docPinButton.classList.toggle("is-pinned", pinned);
  }

  function renderPinned() {
    const pins = readPins();
    if (pins.size === 0) {
      pinnedSection.hidden = true;
      pinnedList.replaceChildren();
      return;
    }
    pinnedSection.hidden = false;
    const rows = [...pins].map((path) => {
      const doc = knowledgeState.allDocuments.find((d) => d.path === path) || {
        path,
        title: basename(path),
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = path;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(path);
      const star = document.createElement("span");
      star.className = "recent-row-when";
      star.textContent = "Pinned";
      btn.append(label, star);
      btn.addEventListener("click", () => openDocument(path));
      return btn;
    });
    pinnedList.replaceChildren(...rows);
  }

  function pushRecentlyViewed(path) {
    try {
      const raw = storage.getItem(RECENTLY_VIEWED_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter((p) => p !== path);
      filtered.unshift(path);
      storage.setItem(
        RECENTLY_VIEWED_KEY,
        JSON.stringify(filtered.slice(0, RECENTLY_VIEWED_MAX)),
      );
    } catch {}
  }

  function renderRecentlyViewed() {
    let list = [];
    try {
      list = JSON.parse(storage.getItem(RECENTLY_VIEWED_KEY) || "[]");
    } catch {}
    if (list.length === 0) {
      recentlyViewedSection.hidden = true;
      return;
    }
    recentlyViewedSection.hidden = false;
    const rows = list.map((path) => {
      const doc = knowledgeState.allDocuments.find((d) => d.path === path) || {
        path,
        title: basename(path),
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = path;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(path);
      btn.append(label);
      btn.addEventListener("click", () => openDocument(path));
      return btn;
    });
    recentlyViewedList.replaceChildren(...rows);
  }

  function renderRecentDocs() {
    const sorted = knowledgeState.allDocuments
      .filter((d) => typeof d.updated === "number")
      .slice()
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 8);
    const rows = sorted.map((doc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-row";
      btn.title = `${doc.path} · ${relativeTime(doc.updated)}`;
      const label = document.createElement("span");
      label.className = "recent-row-label";
      label.textContent = doc.title || basename(doc.path);
      const when = document.createElement("span");
      when.className = "recent-row-when";
      when.textContent = relativeTime(doc.updated);
      btn.append(label, when);
      btn.addEventListener("click", () => openDocument(doc.path));
      return btn;
    });
    recentList.replaceChildren(...rows);
  }

  async function refreshDocuments() {
    const query = searchInput.value.trim();
    const localFiltered = filterDocuments(knowledgeState.allDocuments);
  
    if (knowledgeState.searchController) {
      knowledgeState.searchController.abort();
      knowledgeState.searchController = null;
    }
  
    try {
      if (query) {
        const controller = new AbortController();
        knowledgeState.searchController = controller;
  
        const url = apiUrl("/search");
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "80");
        if (domainFilter.value)
          url.searchParams.set("domain", domainFilter.value);
        if (typeFilter.value) url.searchParams.set("doc_type", typeFilter.value);
        if (systemFilter.value)
          url.searchParams.set("system", systemFilter.value);
        if (tagFilter.value) url.searchParams.set("tag", tagFilter.value);
  
        url.searchParams.set("source", "docs");
        const [docsResult, workResult] = await Promise.allSettled([
          request(url, { signal: controller.signal }),
          loadUnifiedWorkSearch(query, controller.signal),
        ]);
        if (knowledgeState.searchController !== controller) return;
        knowledgeState.searchController = null;
  
        const payload =
          docsResult.status === "fulfilled"
            ? docsResult.value
            : {
                results: [],
                sources: [
                  {
                    source: "docs",
                    status: "unavailable",
                    error:
                      docsResult.reason?.message || "Document search unavailable",
                  },
                ],
              };
        const workSearch =
          workResult.status === "fulfilled"
            ? workResult.value
            : {
                results: [],
                sources: [
                  {
                    source: "work",
                    status: "unavailable",
                    error:
                      workResult.reason?.message || "Work search unavailable",
                  },
                ],
              };
        const results = [
          ...(Array.isArray(payload.results) ? payload.results : []),
          ...workSearch.results,
        ].slice(0, 80);
        knowledgeState.activeSearchSources = [
          ...(Array.isArray(payload.sources) ? payload.sources : []),
          ...workSearch.sources,
        ];
        knowledgeState.visibleDocuments = results;
        knowledgeState.selectedFolder = "";
        renderTree(localFiltered);
        renderUnifiedSearchResults(results, knowledgeState.activeSearchSources, query);
        const unavailable = knowledgeState.activeSearchSources.filter(
          (source) => source.status === "unavailable",
        ).length;
        setStatus(
          `${results.length} search results${unavailable ? ` · ${unavailable} source issues` : ""}.`,
        );
        syncLibraryPageTitle();
        return;
      }
  
      renderTree(localFiltered);
  
      if (!knowledgeState.selectedFolder) {
        // No folder or search: show the daily operations workspace and skip
        // rendering the (potentially huge) document list.
        knowledgeState.visibleDocuments = [];
        renderOperationsWorkspace(localFiltered);
        syncLibraryPageTitle();
        return;
      }
  
      knowledgeState.visibleDocuments = localFiltered.filter((doc) =>
        cleanPath(doc.path).startsWith(`${knowledgeState.selectedFolder}/`),
      );
      renderDocuments(knowledgeState.visibleDocuments, knowledgeState.selectedFolder);
      setStatus(`${knowledgeState.visibleDocuments.length} documents shown.`);
      syncLibraryPageTitle();
    } catch (error) {
      if (error.name === "AbortError") return;
      setStatus(error.message);
    }
  }

  async function loadUnifiedWorkSearch(query, signal) {
    const definitions = [
      {
        source: "tasks",
        path: "/api/tasks?startDate=2000-01-01&endDate=2100-12-31",
        items: tasksFromWorkPayload,
        type: "task",
      },
      {
        source: "workflows",
        path: "/api/bundles",
        items: bundlesFromWorkPayload,
        type: "workflow",
      },
      {
        source: "templates",
        path: "/api/templates",
        items: (payload) =>
          Array.isArray(payload) ? payload : payload?.templates || [],
        type: "template",
      },
      {
        source: "artifacts",
        path: "/api/artifacts",
        items: (payload) =>
          Array.isArray(payload) ? payload : payload?.artifacts || [],
        type: "artifact",
      },
      {
        source: "assistant-jobs",
        path: "/api/assistant-jobs",
        items: assistantJobsFromPayload,
        type: "assistant-job",
      },
    ];
    const settled = await Promise.allSettled(
      definitions.map((definition) =>
        request(workApiUrl(definition.path), { signal }),
      ),
    );
    const wanted = query.toLowerCase();
    const results = [];
    const sources = [];
    settled.forEach((result, index) => {
      const definition = definitions[index];
      if (result.status === "rejected") {
        sources.push({
          source: definition.source,
          status: "unavailable",
          error: result.reason?.message || "Work source unavailable",
        });
        return;
      }
      const matches = definition
        .items(result.value)
        .filter((item) =>
          [
            item.id,
            item.title,
            item.name,
            item.description,
            item.status,
            item.assistantType,
            item.storageUri,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(wanted),
        );
      sources.push({
        source: definition.source,
        status: "ok",
        count: matches.length,
      });
      for (const item of matches)
        results.push(unifiedWorkSearchResult(definition.type, item));
    });
    return { results, sources };
  }

  function unifiedWorkSearchResult(type, item) {
    const id = item.id;
    const title =
      item.title || item.name || item.description || item.storageUri || id;
    const route =
      type === "task"
        ? { kind: "task", taskId: id }
        : type === "workflow"
          ? { kind: "workflow", bundleId: id }
          : type === "template"
            ? { kind: "template", templateId: id, templateType: item.type }
            : type === "assistant-job"
              ? {
                  kind: "assistant-job",
                  assistantJobId: id,
                  taskId: item.taskId,
                  bundleId: item.bundleId,
                }
              : {
                  kind: "artifact",
                  artifactId: id,
                  taskId: item.taskId,
                  bundleId: item.bundleId,
                };
    return {
      type,
      id,
      title,
      context:
        item.description ||
        item.summary ||
        item.assistantType ||
        item.storageUri ||
        "",
      source: type,
      source_label: labelizeWorkValue(type),
      route,
      fields: {
        status: item.status || "",
        due_date: item.date || "",
        workflow_title: item.bundleId || "",
      },
    };
  }

  function filterDocuments(documents) {
    return documents.filter((doc) => {
      if (domainFilter.value && doc.domain !== domainFilter.value) return false;
      if (typeFilter.value && doc.doc_type !== typeFilter.value) return false;
      if (
        systemFilter.value &&
        !(Array.isArray(doc.systems) && doc.systems.includes(systemFilter.value))
      )
        return false;
      if (
        tagFilter.value &&
        !(Array.isArray(doc.tags) && doc.tags.includes(tagFilter.value))
      )
        return false;
      return true;
    });
  }

  function onFilterChange() {
    updateFilterSummary();
    refreshDocuments();
  }

  function activeFilterCount() {
    return [domainFilter, typeFilter, systemFilter, tagFilter].filter(
      (select) => !!select.value,
    ).length;
  }

  function updateFilterSummary() {
    const count = activeFilterCount();
    filterCount.hidden = count === 0;
    filterCount.textContent = count ? String(count) : "";
    filterToggle.classList.toggle("has-filters", count > 0);
  }

  function setFiltersExpanded(expanded) {
    if (filtersSection.open !== expanded) filtersSection.open = expanded;
    filterRow.hidden = !expanded;
    filterToggle.setAttribute("aria-expanded", String(expanded));
    try {
      storage.setItem("dtc-filters-expanded", expanded ? "1" : "0");
    } catch {}
  }

  function restoreFiltersExpanded() {
    let expanded = false;
    try {
      expanded = storage.getItem("dtc-filters-expanded") === "1";
    } catch {}
    setFiltersExpanded(expanded || activeFilterCount() > 0);
  }

  function renderDocsSurface(documents) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: getOperationsWorkSnapshot(),
      recurringSnapshot: getOperationsRecurringSnapshot(),
      qualitySnapshot: getOperationsQualitySnapshot(),
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Docs";
    setPageTitle("Docs", "Docs");
    clearSelectionButton.hidden = true;
    setStatus(surfaceStatusText("processes", model));
  
    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-docs";
    wrap.append(renderSurfaceHeader("Docs", surfaceDescription("processes")));
    wrap.append(renderProcessesSurface(documents, model));
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
    const note = renderHonestState(
      "Processes support work",
      "Use internal Process Docs from Task or Card context first. Findings below focus on runnable Template/Card risk and maintainer gaps.",
    );
    section.append(note);
  
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
  
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Quality Findings";
    const meta = document.createElement("span");
    meta.textContent = quality.loaded
      ? `${quality.totalFindings} findings - ${quality.summary?.blocking || 0} blocking in template/report data`
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

  function renderUnifiedSearchSurface(documents) {
    const section = document.createElement("section");
    section.className = "ops-state-list";
    const searchState = knowledgeState.activeSearchSources.some(
      (source) => source.status === "unavailable",
    )
      ? "Search is showing partial source availability from the latest query."
      : "Use the sidebar search to find executable work and process context together.";
    section.append(renderHonestState("Operator search", searchState));
    const action = document.createElement("button");
    action.type = "button";
    action.className = "ops-quick-btn";
    action.textContent = "Focus search";
    action.addEventListener("click", () => {
      searchInput.focus();
      searchInput.select();
    });
    section.append(action);
    const refs = document.createElement("div");
    refs.className = "ops-reference-grid";
    for (const ref of buildOperationsReferenceLinks(documents).slice(0, 4))
      refs.append(renderOperationsReference(ref));
    section.append(refs);
    return section;
  }

  function renderUnifiedSearchResults(results, sources, query) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.add("is-unified-search");
    libraryTitle.textContent = "Search results";
    clearSelectionButton.hidden = false;
  
    const wrap = document.createElement("div");
    wrap.className = "unified-search-results";
    const sourceState = renderSearchSourceState(sources);
    if (sourceState) wrap.append(sourceState);
  
    const safeResults = Array.isArray(results) ? results : [];
    if (safeResults.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = query
        ? "No work or process context matches this search."
        : "Search for Cards, Tasks, Artifacts, Assistant jobs, Templates, or Process Docs.";
      wrap.append(empty);
      documentList.replaceChildren(wrap);
      return;
    }
  
    for (const group of groupSearchResults(safeResults)) {
      const section = document.createElement("section");
      section.className = "unified-search-group";
      const header = document.createElement("div");
      header.className = "unified-search-group-header";
      const title = document.createElement("h3");
      title.textContent = group.label;
      const count = document.createElement("span");
      count.textContent = String(group.items.length);
      header.append(title, count);
      section.append(header);
      for (const result of group.items)
        section.append(renderUnifiedSearchRow(result, query));
      wrap.append(section);
    }
    documentList.replaceChildren(wrap);
  }

  function renderSearchSourceState(sources) {
    const unavailable = (sources || []).filter(
      (source) => source && source.status === "unavailable",
    );
    if (unavailable.length === 0) return null;
    const section = document.createElement("section");
    section.className = "ops-runtime-state search-source-state";
    const title = document.createElement("strong");
    title.textContent = "Partial search results";
    const body = document.createElement("span");
    body.textContent =
      "Some work sources could not load. Document results and any loaded work sources remain visible.";
    section.append(title, body);
    const list = document.createElement("ul");
    for (const source of unavailable.slice(0, 5)) {
      const item = document.createElement("li");
      item.textContent = `${source.source || "source"}: ${source.error || "unavailable"}`;
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function groupSearchResults(results) {
    const labels = {
      task: "Tasks",
      workflow: "Cards",
      template: "Runtime Templates",
      doc: "Process Docs",
      artifact: "Artifacts",
      file: "Files",
      "assistant-job": "Assistant Jobs",
    };
    const order = [
      "task",
      "workflow",
      "template",
      "doc",
      "artifact",
      "file",
      "assistant-job",
    ];
    const groups = new Map();
    for (const result of results) {
      const type = result?.type || "doc";
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(result);
    }
    return [...groups.entries()]
      .sort((a, b) => {
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      })
      .map(([type, items]) => ({
        type,
        label: labels[type] || labelizeWorkValue(type),
        items,
      }));
  }

  function renderUnifiedSearchRow(result, query) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `unified-search-row result-${String(result.type || "doc").replace(/[^a-z0-9-]/gi, "-")}`;
    row.addEventListener("click", () => openUnifiedSearchResult(result));
  
    const main = document.createElement("div");
    main.className = "unified-search-main";
    const title = document.createElement("h3");
    setHighlightedText(
      title,
      result.title || result.id || result.path || "Untitled result",
      query,
    );
    const summary = document.createElement("p");
    setHighlightedText(
      summary,
      result.context || result.description || result.summary || "",
      query,
    );
    main.append(title, summary);
  
    const meta = document.createElement("div");
    meta.className = "unified-search-meta";
    const chips = [
      result.source_label || result.source || "",
      result.doc_type || result.fields?.status || result.fields?.stage || "",
      result.fields?.due_date ? `due ${result.fields.due_date}` : "",
      result.fields?.assignee ? `owner ${result.fields.assignee}` : "",
      result.fields?.workflow_title ? `card ${result.fields.workflow_title}` : "",
      result.fields?.proof || "",
      result.path || "",
    ].filter(Boolean);
    for (const chipText of chips.slice(0, 6)) {
      const chip = document.createElement("span");
      chip.textContent = chipText;
      meta.append(chip);
    }
  
    const action = document.createElement("span");
    action.className = "unified-search-action";
    action.textContent = result.action_label || "Open";
    row.append(main, meta, action);
    return row;
  }

  function openUnifiedSearchResult(result) {
    const route = result?.route || {};
    const kind = route.kind || result?.type;
    if (kind === "doc" && (route.path || result.path)) {
      openDocument(route.path || result.path);
      return;
    }
    if (kind === "task" && route.taskId) {
      openTaskPanel(route.taskId);
      return;
    }
    if ((kind === "workflow" || kind === "bundle") && route.bundleId) {
      openBundlePanel(route.bundleId);
      return;
    }
    if (kind === "template") {
      openQuickWorkflowForm({
        template: {
          templateId: route.templateId || result.id,
          type: route.templateType || result.fields?.template_type,
          title: result.title,
        },
      });
      return;
    }
    if (kind === "assistant-job") {
      navigateCanonicalWorkspace("/assistants", {
        assistantJobId: route.assistantJobId || result.id,
      });
      return;
    }
    if ((kind === "artifact" || kind === "file") && route.taskId) {
      openTaskPanel(route.taskId);
      return;
    }
    if ((kind === "artifact" || kind === "file") && route.bundleId) {
      openBundlePanel(route.bundleId);
      return;
    }
    if (kind === "artifact" || kind === "file") showWorkspaceSurface("artifacts");
  }

  function renderDocuments(documents, title) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = title;
    const hasFilter = !!(knowledgeState.selectedFolder || searchInput.value.trim());
    clearSelectionButton.hidden = !hasFilter;
  
    if (documents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = searchInput.value.trim()
        ? "No documents match your search."
        : knowledgeState.selectedFolder
          ? "No documents in this folder yet."
          : "No documents yet. Create your first page from the sidebar.";
      documentList.replaceChildren(empty);
      return;
    }
  
    const rows = documents.slice(0, LIST_LIMIT).map(renderDocumentRow);
    if (documents.length > LIST_LIMIT) {
      const more = document.createElement("div");
      more.className = "list-more";
      more.textContent = `Showing ${LIST_LIMIT} of ${documents.length}. Refine your search to see more.`;
      rows.push(more);
    }
    documentList.replaceChildren(...rows);
  }

  function renderDocumentRow(doc) {
    const row = documentRowTemplate.content.firstElementChild.cloneNode(true);
    const query = searchInput.value.trim();
    setHighlightedText(
      row.querySelector("h3"),
      doc.title || basename(doc.path),
      query,
    );
    setHighlightedText(
      row.querySelector("p"),
      doc.description || doc.summary || "No summary yet.",
      query,
    );
    row.querySelector(".doc-path").textContent = doc.path;
    row.querySelector(".doc-domain").textContent = doc.domain || "docs";
    row.querySelector(".doc-type").textContent = doc.doc_type || "doc";
  
    row.addEventListener("click", () => openDocument(doc.path));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDocument(doc.path);
      }
    });
  
    return row;
  }

  function renderTree(documents, options = {}) {
    const filter = searchInput.value.trim().toLowerCase();
    if (filter) {
      const matches = documents
        .filter((d) => {
          const hay = `${(d.title || "").toLowerCase()} ${d.path.toLowerCase()}`;
          return hay.includes(filter);
        })
        .slice(0, 50);
      const wrap = document.createElement("div");
      wrap.className = "tree-children";
      for (const doc of matches) wrap.append(renderTreeFile(doc));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-filter-empty";
        empty.textContent = "No matching pages.";
        wrap.append(empty);
      }
      docTree.replaceChildren(wrap);
      return;
    }
    docTree.replaceChildren(renderTreeChildren(buildTree(documents), ""));
    if (options.revealCurrent) scrollCurrentTreeFileIntoView();
  }

  function buildTree(documents) {
    const root = { folders: new Map(), files: [] };
  
    for (const doc of documents) {
      const parts = cleanPath(doc.path).split("/");
      let node = root;
  
      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) {
          node.folders.set(part, { folders: new Map(), files: [] });
        }
        node = node.folders.get(part);
      }
  
      node.files.push(doc);
    }
  
    return root;
  }

  function renderTreeChildren(node, path) {
    const list = document.createElement("div");
    list.className = "tree-children";
  
    for (const [folderName, child] of [...node.folders.entries()].sort()) {
      const folderPath = path ? `${path}/${folderName}` : folderName;
      list.append(renderFolder(folderName, folderPath, child));
    }
  
    for (const doc of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      list.append(renderTreeFile(doc));
    }
  
    return list;
  }

  function renderFolder(name, path, node) {
    const details = document.createElement("details");
    details.className = "tree-folder";
    const startOpen = isFolderOpen(path) || isCurrentDocFolder(path);
    details.open = startOpen;
  
    const summary = document.createElement("summary");
    summary.classList.toggle("is-selected", knowledgeState.selectedFolder === path);
  
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = name;
    summary.append(chevron, label);
  
    summary.addEventListener("click", (event) => {
      if (event.target.closest(".chevron")) {
        // Let <details> handle expand/collapse from the disclosure control.
        return;
      }
      event.preventDefault();
      knowledgeState.selectedFolder = path;
      searchInput.value = "";
      details.open = true;
      hydrate();
      setFolderUrl(path);
      setView("library");
      syncLibraryPageTitle();
      refreshDocuments();
    });
  
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "tree-folder-menu";
    menu.title = "Folder actions";
    menu.textContent = "⋯";
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openFolderMenu(menu, path);
    });
    summary.append(menu);
  
    details.append(summary);
  
    // Lazy: only build children DOM the first time the folder is opened.
    let hydrated = false;
    const childrenSlot = document.createElement("div");
    childrenSlot.className = "tree-children-slot";
    details.append(childrenSlot);
  
    const hydrate = () => {
      if (hydrated) return;
      hydrated = true;
      childrenSlot.replaceWith(renderTreeChildren(node, path));
    };
  
    if (startOpen) hydrate();
    details.addEventListener("toggle", () => {
      if (details.open) hydrate();
    });
  
    return details;
  }

  function renderTreeFile(doc) {
    const button = document.createElement("button");
    button.className = "tree-file";
    button.type = "button";
    button.dataset.path = doc.path;
    button.classList.toggle("is-current", doc.path === knowledgeState.currentTreePath);
    const label = document.createElement("span");
    label.className = "tree-file-label";
    label.textContent = doc.title || basename(doc.path);
    button.append(label);
    if (storage.getItem(draftKey(doc.path)) !== null) {
      button.classList.add("has-draft");
      const dot = document.createElement("span");
      dot.className = "tree-file-dot";
      dot.title = "Unsaved local draft";
      button.append(dot);
    }
    if (typeof doc.updated === "number") {
      button.title = `Last saved ${relativeTime(doc.updated)}`;
    }
    button.addEventListener("click", () => openDocument(doc.path));
    return button;
  }

  function rebuildDocumentIdMap() {
    knowledgeState.documentIdMap = new Map();
    for (const doc of knowledgeState.allDocuments) {
      if (doc.id) knowledgeState.documentIdMap.set(String(doc.id), doc);
      if (Array.isArray(doc.aliases)) {
        for (const alias of doc.aliases) {
          if (alias) knowledgeState.documentIdMap.set(String(alias), doc);
        }
      }
      knowledgeState.documentIdMap.set(doc.path, doc);
      knowledgeState.documentIdMap.set(cleanPath(doc.path), doc);
    }
  }

  function resolveDocReference(ref) {
    const key = String(ref || "").trim();
    if (!key) return null;
    return (
      knowledgeState.documentIdMap.get(key) || knowledgeState.documentIdMap.get(key.replace(/^\/+/, "")) || null
    );
  }

  function relativeTime(epoch) {
    const now = Date.now() / 1000;
    const diff = Math.max(0, now - epoch);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
    const d = new Date(epoch * 1000);
    return d.toLocaleDateString();
  }

  function isFolderOpen(path) {
    if (!knowledgeState.selectedFolder) return false;
    return knowledgeState.selectedFolder === path || knowledgeState.selectedFolder.startsWith(`${path}/`);
  }

  function isCurrentDocFolder(path) {
    if (!knowledgeState.currentTreePath) return false;
    return cleanPath(knowledgeState.currentTreePath).startsWith(`${path}/`);
  }

  function scrollCurrentTreeFileIntoView() {
    scheduleAnimationFrame(() => {
      const current = docTree.querySelector(".tree-file.is-current");
      if (current) current.scrollIntoView({ block: "center" });
    });
  }

  function updateCurrentTreeSelection() {
    for (const btn of docTree.querySelectorAll(".tree-file")) {
      btn.classList.toggle("is-current", btn.dataset.path === knowledgeState.currentTreePath);
    }
  }

  function captureScrollPosition() {
    if (!documentState.currentDoc) return;
    const scrollEl = editorView.dataset.mode === "rendered" ? editorView : editor;
    if (scrollEl) _scrollPositions.set(documentState.currentDoc.path, scrollEl.scrollTop || 0);
  }

  async function openDocument(path, options = {}) {
    if (!(await canLeaveCurrentDocument())) return;
    beginDocumentNavigation();
    captureScrollPosition();
    knowledgeState.docReturnContext = options.returnContext || null;
    renderDocReturnContext();
  
    documentTitle.disabled = true;
    editor.disabled = true;
    setSaveState("Loading...");
    setView("editor");
    setPageTitle(basename(path), path);
    documentPath.textContent = path;
  
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      const payload = await request(url);
  
      documentState.currentDoc = { path: payload.path, updated: payload.updated };
      knowledgeState.currentTreePath = payload.path;
      if (options.updateUrl !== false) setDocumentUrl(payload.path);
      documentState.currentParsed = payload.parsed || null;
      documentState.currentWarnings = [];
      documentState.lastSavedContent = payload.content;
      docMenuButton.hidden = false;
      updateGithubLink();
      updatePinButton();
      pushRecentlyViewed(payload.path);
      renderRecentlyViewed();
      if (options.revealInTree) {
        renderTree(filterDocuments(knowledgeState.allDocuments), { revealCurrent: true });
      } else {
        updateCurrentTreeSelection();
      }
  
      const draft = storage.getItem(draftKey(payload.path));
      documentState.hasDraft = draft !== null;
      refreshChangesPanel();
      editor.value = draft ?? payload.content;
      editor.disabled = false;
      documentTitle.disabled = false;
      documentTitle.value =
        titleFromMarkdown(editor.value) || basename(payload.path);
      documentPath.textContent = payload.path;
  
      updateSaveState();
      setPageTitle(documentTitle.value, payload.path);
      renderDocReturnContext();
      updateViewToggleAvailability();
      // Default to the block view when the doc has parseable sections, so
      // SOPs read as structured content rather than raw markdown.
      enterRenderedMode();
      const restoreTop = _scrollPositions.get(payload.path) || 0;
      const scrollEl =
        editorView.dataset.mode === "rendered" ? editorView : editor;
      if (scrollEl) {
        // Defer to next frame so layout has settled.
        scheduleAnimationFrame(() => {
          scrollEl.scrollTop = restoreTop;
        });
      }
    } catch (error) {
      setStatus(error.message);
      setSaveState("");
      documentTitle.disabled = !documentState.currentDoc;
      editor.disabled = !documentState.currentDoc;
    }
  }

  function renderDocReturnContext() {
    if (!docContextReturn) return;
    docContextReturn.replaceChildren();
    if (!knowledgeState.docReturnContext) {
      docContextReturn.hidden = true;
      return;
    }
    docContextReturn.hidden = false;
    const text = document.createElement("span");
    text.textContent =
      knowledgeState.docReturnContext.type === "workflow"
        ? `Opened from Card: ${knowledgeState.docReturnContext.title || knowledgeState.docReturnContext.id || "Card"}`
        : `Opened from task: ${knowledgeState.docReturnContext.title || knowledgeState.docReturnContext.id || "Task"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet-button";
    button.textContent =
      knowledgeState.docReturnContext.type === "workflow" ? "Back to Card" : "Back to Task";
    button.addEventListener("click", () => {
      const context = knowledgeState.docReturnContext;
      knowledgeState.docReturnContext = null;
      renderDocReturnContext();
      showOperationsHome().then(() => {
        if (context?.type === "workflow" && context.id)
          openBundlePanel(context.id);
        else if (context?.type === "task" && context.id)
          openTaskPanel(context.id);
      });
    });
    docContextReturn.append(text, button);
  }

  function localDocPathFromHref(href) {
    const value = String(href || "").trim();
    if (!value) return "";
    if (value.startsWith("content/") && value.endsWith(".md")) return value;
    if (value.startsWith("/content/") && value.endsWith(".md"))
      return value.replace(/^\/+/, "");
    try {
      const url = new URL(value, locationAdapter.origin);
      const path = decodeURIComponent(url.pathname || "").replace(/^\/+/, "");
      if (path.startsWith("content/") && path.endsWith(".md")) return path;
      if (path.endsWith(".md")) return `content/${path}`;
    } catch {}
    return "";
  }

  function docPathFromLocation() {
    const raw = decodeURIComponent(locationAdapter.pathname || "/").replace(
      /^\/+|\/+$/g,
      "",
    );
    if (!raw || raw === "login" || raw === "logout") return "";
    if (raw.startsWith("content/")) return raw;
    if (!raw.endsWith(".md")) return "";
    return `content/${raw}`;
  }

  function folderPathFromLocation() {
    const raw = decodeURIComponent(locationAdapter.pathname || "/").replace(
      /^\/+|\/+$/g,
      "",
    );
    if (!raw || raw === "login" || raw === "logout" || raw.endsWith(".md"))
      return "";
    return raw.replace(/^content\//, "");
  }

  function folderExists(path) {
    if (!path) return false;
    return knowledgeState.allDocuments.some((doc) => cleanPath(doc.path).startsWith(`${path}/`));
  }

  function setDocumentUrl(path) {
    const visible = "/" + path.replace(/^content\//, "");
    if (
      locationAdapter.pathname !== visible ||
      locationAdapter.search ||
      locationAdapter.hash
    ) {
      historyAdapter.pushState({ path }, "", visible);
    }
  }

  function setFolderUrl(path) {
    const visible = path ? `/${path}` : "/";
    if (
      locationAdapter.pathname !== visible ||
      locationAdapter.search ||
      locationAdapter.hash
    ) {
      historyAdapter.pushState({ folder: path }, "", visible);
    }
  }

  function enhanceSelect(select) {
    const root = document.createElement("div");
    root.className = "custom-select";
  
    const button = document.createElement("button");
    button.className = "custom-select-button";
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
  
    const label = document.createElement("span");
    const arrow = document.createElement("span");
    arrow.className = "custom-select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    button.append(label, arrow);
  
    const menu = document.createElement("div");
    menu.className = "custom-select-menu";
    menu.setAttribute("role", "listbox");
  
    const commit = (value) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      updateCustomSelect(root);
      closeCustomSelects();
      button.focus();
    };
  
    const renderOptions = () => {
      menu.replaceChildren(
        ...[...select.options].map((option) => {
          const item = document.createElement("button");
          item.className = "custom-select-option";
          item.type = "button";
          item.tabIndex = -1;
          item.setAttribute("role", "option");
          item.dataset.value = option.value;
          item.textContent = option.textContent;
          item.addEventListener("click", (event) => {
            event.stopPropagation();
            commit(option.value);
          });
          return item;
        }),
      );
    };
  
    renderOptions();
  
    const openMenu = () => {
      closeCustomSelects();
      root.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      const items = [...menu.querySelectorAll(".custom-select-option")];
      const selectedIdx = items.findIndex(
        (el) => el.dataset.value === select.value,
      );
      items[Math.max(0, selectedIdx)]?.focus();
    };
  
    const closeMenu = () => {
      closeCustomSelects();
      button.focus();
    };
  
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (root.classList.contains("is-open")) closeMenu();
      else openMenu();
    });
  
    button.addEventListener("keydown", (event) => {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
    });
  
    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll(".custom-select-option")];
      const idx = items.indexOf(document.activeElement);
  
      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[Math.min(items.length - 1, Math.max(0, idx) + 1)]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[Math.max(0, (idx < 0 ? items.length : idx) - 1)]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (idx >= 0) commit(items[idx].dataset.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      } else if (event.key === "Tab") {
        closeCustomSelects();
      }
    });
  
    root.append(button, menu);
    select.classList.add("native-select");
    select.after(root);
    customSelects.push({ root, select, label, button, renderOptions });
    updateCustomSelect(root);
  }

  function setSelectOptions(select, values, allLabel = "All") {
    const previous = select.value;
    const items = [
      new Option(allLabel, ""),
      ...values.map((v) => new Option(humanizeOptionLabel(v), v)),
    ];
    select.replaceChildren(...items);
    select.value = values.includes(previous) ? previous : "";
  
    const entry = customSelects.find((c) => c.select === select);
    if (entry) {
      entry.renderOptions();
      updateCustomSelect(entry.root);
    }
  }

  function humanizeOptionLabel(value) {
    return value
      .split(/[-_]/)
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join(" ");
  }

  function populateFilterOptions() {
    const domains = [
      ...new Set(knowledgeState.allDocuments.map((d) => d.domain).filter(Boolean)),
    ].sort();
    const types = [
      ...new Set(knowledgeState.allDocuments.map((d) => d.doc_type).filter(Boolean)),
    ].sort();
    const systems = [
      ...new Set(knowledgeState.allDocuments.flatMap((d) => d.systems || []).filter(Boolean)),
    ].sort();
    const tags = [
      ...new Set(knowledgeState.allDocuments.flatMap((d) => d.tags || []).filter(Boolean)),
    ].sort();
    setSelectOptions(domainFilter, domains);
    setSelectOptions(typeFilter, types);
    setSelectOptions(systemFilter, systems);
    setSelectOptions(tagFilter, tags);
    updateFilterSummary();
    restoreFiltersExpanded();
  }

  function updateCustomSelect(root) {
    const item = customSelects.find((entry) => entry.root === root);
    if (!item) return;
  
    const selected = item.select.selectedOptions[0];
    item.label.textContent = selected?.textContent || "";
    item.root.querySelectorAll(".custom-select-option").forEach((option) => {
      const isSelected = option.dataset.value === item.select.value;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-selected", String(isSelected));
    });
  }

  function closeCustomSelects() {
    customSelects.forEach(({ root, button }) => {
      root.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
  }

  function setHighlightedText(el, text, query) {
    const safe = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (!query) {
      el.textContent = text;
      return;
    }
    const tokens = query.split(/\s+/).filter(Boolean).map(escapeRegex);
    if (tokens.length === 0) {
      el.textContent = text;
      return;
    }
    const re = new RegExp(`(${tokens.join("|")})`, "gi");
    el.innerHTML = safe.replace(re, "<mark>$1</mark>");
  }

  function resultCount(items, noun) {
    if (items.length === 1) return `1 ${noun} found.`;
    return `${items.length} ${noun}s found.`;
  }

  function labelForPath(path) {
    const known = knowledgeState.allDocuments.find((d) => d.path === path);
    if (known && known.title) return known.title;
    return basename(path);
  }

  // ---------- Git commit + push ----------
  
  // ---------- Folder actions menu ----------
  
  function openFolderMenu(anchorEl, folderPath) {
    const existing = document.querySelector(".doc-menu-popover");
    if (existing) {
      existing.remove();
      return;
    }
    const popover = document.createElement("div");
    popover.className = "doc-menu-popover";
  
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "doc-menu-item";
    renameBtn.textContent = "Rename…";
    renameBtn.addEventListener("click", () => {
      popover.remove();
      renameFolder(folderPath);
    });
    popover.append(renameBtn);
  
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "doc-menu-item is-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      popover.remove();
      deleteFolder(folderPath);
    });
    popover.append(delBtn);
  
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${rect.left}px`;
    document.body.append(popover);
  
    const close = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== anchorEl) {
        popover.remove();
        document.removeEventListener("click", close, true);
      }
    };
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }

  async function renameFolder(folderPath) {
    const fullOld = `content/${folderPath}`;
    let fullNew = promptUser("New folder path:", fullOld);
    if (!fullNew) return;
    fullNew = fullNew.trim();
    if (fullNew === fullOld) return;
    if (!fullNew.startsWith("content/")) {
      setStatus("Folder path must start with content/");
      return;
    }
    try {
      const payload = await request(apiUrl("/folders/rename"), {
        method: "POST",
        body: JSON.stringify({ old_path: fullOld, new_path: fullNew }),
      });
      // Rewrite any open doc + drafts under the renamed prefix.
      const oldPrefix = `${payload.old_path}/`;
      const newPrefix = `${payload.new_path}/`;
      if (documentState.currentDoc && documentState.currentDoc.path.startsWith(oldPrefix)) {
        documentState.currentDoc.path = newPrefix + documentState.currentDoc.path.slice(oldPrefix.length);
        documentPath.textContent = documentState.currentDoc.path;
        setPageTitle(documentTitle.value, documentState.currentDoc.path);
      }
      const drafts = listDraftPaths();
      for (const p of drafts) {
        if (p.startsWith(oldPrefix)) {
          const newPath = newPrefix + p.slice(oldPrefix.length);
          storage.setItem(
            draftKey(newPath),
            storage.getItem(draftKey(p)),
          );
          storage.removeItem(draftKey(p));
        }
      }
      knowledgeState.selectedFolder = "";
      setStatus(`Renamed ${payload.old_path} → ${payload.new_path}`);
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (err) {
      reportError(`Rename failed: ${err.message}`);
    }
  }

  async function deleteFolder(folderPath) {
    const fullPath = `content/${folderPath}`;
    const fileCount = knowledgeState.allDocuments.filter((d) =>
      d.path.startsWith(fullPath + "/"),
    ).length;
    const ok = await confirmDialog(
      `Delete ${fullPath} and its ${fileCount} doc${fileCount === 1 ? "" : "s"}? You can recover it from git if needed.`,
      { okText: "Delete", danger: true },
    );
    if (!ok) return;
    try {
      const payload = await request(
        `${apiUrl("/folders")}?path=${encodeURIComponent(fullPath)}`,
        { method: "DELETE" },
      );
      const prefix = `${payload.deleted}/`;
      if (
        documentState.currentDoc &&
        (documentState.currentDoc.path === payload.deleted ||
          documentState.currentDoc.path.startsWith(prefix))
      ) {
        documentState.currentDoc = null;
        documentState.currentParsed = null;
        documentState.lastSavedContent = "";
        documentState.hasDraft = false;
        docMenuButton.hidden = true;
        documentTitle.value = "";
        documentTitle.disabled = true;
        editor.value = "";
        editor.disabled = true;
        showLibrary();
      }
      // Clean drafts under the prefix.
      for (const p of listDraftPaths()) {
        if (p === payload.deleted || p.startsWith(prefix)) {
          storage.removeItem(draftKey(p));
        }
      }
      if (knowledgeState.selectedFolder.startsWith(folderPath)) knowledgeState.selectedFolder = "";
      setStatus(
        `Deleted ${payload.deleted} (${payload.files} file${payload.files === 1 ? "" : "s"}).`,
      );
      refreshChangesPanel();
      refreshGitStatus();
      await loadDocuments();
    } catch (err) {
      reportError(`Delete failed: ${err.message}`);
    }
  }

  // ---------- Doc actions menu ----------
  
  function openDocMenu(event) {
    if (!documentState.currentDoc) return;
    const existing = document.querySelector(".doc-menu-popover");
    if (existing) {
      existing.remove();
      return;
    }
    const popover = document.createElement("div");
    popover.className = "doc-menu-popover";
  
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "doc-menu-item";
    renameBtn.textContent = "Rename…";
    renameBtn.addEventListener("click", () => {
      popover.remove();
      renameCurrentDoc();
    });
    popover.append(renameBtn);
  
    const historyBtn = document.createElement("button");
    historyBtn.type = "button";
    historyBtn.className = "doc-menu-item";
    historyBtn.textContent = "History";
    historyBtn.addEventListener("click", () => {
      popover.remove();
      showDocHistory(documentState.currentDoc.path);
    });
    popover.append(historyBtn);
  
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "doc-menu-item is-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      popover.remove();
      deleteCurrentDoc();
    });
    popover.append(delBtn);
  
    const rect = docMenuButton.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${viewportWidth() - rect.right}px`;
    document.body.append(popover);
  
    const closeOnOutside = (ev) => {
      if (!popover.contains(ev.target) && ev.target !== docMenuButton) {
        popover.remove();
        document.removeEventListener("click", closeOnOutside, true);
      }
    };
    // Defer attaching so the current click doesn't immediately close it.
    setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
  }

  async function showDocHistory(path) {
    diffTitle.textContent = `History · ${path}`;
    diffBody.replaceChildren();
    diffBody.append(emptyNote("Loading…"));
    diffModal.hidden = false;
    try {
      const url = apiUrl("/git/log");
      url.searchParams.set("path", path);
      const payload = await request(url);
      const commits = payload.commits || [];
      if (commits.length === 0) {
        diffBody.replaceChildren(emptyNote("No commits found."));
        return;
      }
      const rows = commits.map((c) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-ctx";
        row.textContent = `${c.sha}  ${c.date}  ${c.author}  ${c.subject}`;
        return row;
      });
      diffBody.replaceChildren(...rows);
    } catch (err) {
      diffBody.replaceChildren(emptyNote(`History failed: ${err.message}`));
    }
  }

  function openQuickNav() {
    quickNav.hidden = false;
    quickNavInput.value = "";
    _quickNavIndex = 0;
    updateQuickNavMatches("");
    quickNavInput.focus();
  }

  function closeQuickNav() {
    quickNav.hidden = true;
  }

  function updateQuickNavMatches(query) {
    const q = query.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/) : [];
    const scored = knowledgeState.allDocuments
      .map((doc) => {
        const hay = `${(doc.title || "").toLowerCase()} ${doc.path.toLowerCase()}`;
        if (!q) return { doc, score: 0 };
        let score = 0;
        for (const t of tokens) {
          const idx = hay.indexOf(t);
          if (idx === -1) return null;
          score -= idx; // earlier = better
          if ((doc.title || "").toLowerCase().includes(t)) score += 50;
        }
        return { doc, score };
      })
      .filter(Boolean);
    scored.sort(
      (a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path),
    );
    _quickNavMatches = scored.slice(0, 30).map((s) => s.doc);
    _quickNavIndex = 0;
    renderQuickNavResults();
  }

  function renderQuickNavResults() {
    if (_quickNavMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quick-nav-empty";
      empty.textContent = "No matches.";
      quickNavResults.replaceChildren(empty);
      return;
    }
    const rows = _quickNavMatches.map((doc, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "quick-nav-row" + (i === _quickNavIndex ? " is-active" : "");
      const title = document.createElement("span");
      title.className = "quick-nav-title";
      title.textContent = doc.title || basename(doc.path);
      const path = document.createElement("span");
      path.className = "quick-nav-path";
      path.textContent = doc.path;
      row.append(title, path);
      row.addEventListener("click", () => {
        closeQuickNav();
        openDocument(doc.path);
      });
      return row;
    });
    quickNavResults.replaceChildren(...rows);
    rows[_quickNavIndex]?.scrollIntoView({ block: "nearest" });
  }

  function handleQuickNavKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeQuickNav();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      _quickNavIndex = Math.min(
        _quickNavMatches.length - 1,
        _quickNavIndex + 1,
      );
      renderQuickNavResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      _quickNavIndex = Math.max(0, _quickNavIndex - 1);
      renderQuickNavResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = _quickNavMatches[_quickNavIndex];
      if (target) {
        closeQuickNav();
        openDocument(target.path);
      }
    }
  }

  function visibleDocUrl(path) {
    return "/" + String(path || "").replace(/^content\//, "");
  }

  function resolveMarkdownDocLink(href) {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
    if (href.startsWith("doc:")) return resolveDocReference(href.slice(4));
    const clean = href.split("#")[0].split("?")[0];
    if (!clean.endsWith(".md")) return null;
    if (clean.startsWith("/"))
      return resolveDocReference(clean.replace(/^\/+/, ""));
    if (documentState.currentDoc) {
      const docDir = documentState.currentDoc.path.split("/").slice(0, -1).join("/");
      const stack = docDir.split("/").filter(Boolean);
      for (const part of clean.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      return resolveDocReference(stack.join("/"));
    }
    return resolveDocReference(clean);
  }

  function renderGithubRawFooter(githubBaseValue, branch) {
    if (!documentState.currentDoc || !githubBaseValue) return null;
    const githubBase = githubBaseValue.replace(/\/$/, "");
    const link = document.createElement("a");
    link.className = "doc-source-footer";
    const encodedBranch = encodeURIComponent(branch).replaceAll("%2F", "/");
    link.href = `${githubBase}/blob/${encodedBranch}/${documentState.currentDoc.path}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "See on GitHub";
    return link;
  }

  async function fetchBacklinksForCurrentDoc() {
    if (!documentState.currentDoc) return;
    const host = renderedView.querySelector("#backlinks-host");
    if (!host) return;
    try {
      const url = apiUrl("/docs/backlinks");
      url.searchParams.set("path", documentState.currentDoc.path);
      const payload = await request(url);
      const links = payload.backlinks || [];
      if (links.length === 0) {
        host.hidden = true;
        return;
      }
      const head = document.createElement("h3");
      head.textContent = `Referenced by (${links.length})`;
      const list = document.createElement("ul");
      for (const link of links) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "block-backlinks-row";
        button.textContent = link.title || basename(link.path);
        button.title = link.path;
        button.addEventListener("click", () => openDocument(link.path));
        item.append(button);
        list.append(item);
      }
      host.replaceChildren(head, list);
    } catch {
      host.hidden = true;
    }
  }

  function renderRelatedDocsBlock(frontmatter) {
    const items = Array.isArray(frontmatter.related_docs)
      ? frontmatter.related_docs.filter(Boolean)
      : [];
    if (items.length === 0) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-related";
    const head = document.createElement("h3");
    head.textContent = `Related docs (${items.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const related of items) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "block-related-row";
      button.textContent = related;
      button.title = "Open related doc";
      button.addEventListener("click", () => openDocument(resolveRelatedPath(related)));
      item.append(button);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function resolveRelatedPath(value) {
    if (value.startsWith("content/") || value.startsWith("docs/")) return value;
    if (!documentState.currentDoc) return value;
    const directory = documentState.currentDoc.path
      .split("/")
      .slice(0, -1)
      .join("/");
    const stack = directory.split("/").filter(Boolean);
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return stack.join("/");
  }

  function renderWarningsBlock() {
    if (!documentState.currentWarnings.length) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-warnings";
    const head = document.createElement("h3");
    head.textContent = `Lint warnings (${documentState.currentWarnings.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const warning of documentState.currentWarnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function renderLoomBlock(frontmatter) {
    const looms = Array.isArray(frontmatter.loom)
      ? frontmatter.loom.filter(Boolean)
      : [];
    if (looms.length === 0) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-loom";
    const head = document.createElement("h3");
    head.textContent = `Loom recordings (${looms.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const url of looms) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = shortLoomLabel(url);
      item.append(link);
      const embedUrl = toLoomEmbedUrl(url);
      if (embedUrl) appendLoomEmbed(item, embedUrl);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function appendLoomEmbed(item, embedUrl) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block-loom-play";
    button.textContent = "▶︎ Play inline";
    const slot = document.createElement("div");
    slot.className = "block-loom-embed";
    slot.hidden = true;
    button.addEventListener("click", () => {
      if (slot.hidden) {
        if (!slot.firstChild) {
          const frame = document.createElement("iframe");
          frame.src = embedUrl;
          frame.allowFullscreen = true;
          frame.allow = "fullscreen";
          slot.append(frame);
        }
        slot.hidden = false;
        button.textContent = "Hide";
      } else {
        slot.hidden = true;
        button.textContent = "▶︎ Play inline";
      }
    });
    item.append(" ", button, slot);
  }

  function toLoomEmbedUrl(value) {
    try {
      const url = new URL(value);
      if (!url.hostname.endsWith("loom.com")) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "share" || !parts[1]) return null;
      return `https://www.loom.com/embed/${parts[1]}`;
    } catch {
      return null;
    }
  }

  function shortLoomLabel(value) {
    try {
      const url = new URL(value);
      const id = url.pathname.split("/").filter(Boolean).pop() || "";
      if (id.length > 8) {
        return `${url.hostname.replace("www.", "")} · ${id.slice(0, 8)}…`;
      }
      return url.hostname + url.pathname;
    } catch {
      return value;
    }
  }

  function showLibrary(options = {}) {
    setView("library");
    if (options.updateUrl !== false) setFolderUrl(knowledgeState.selectedFolder);
    syncLibraryPageTitle();
    closeWorkBellPanel();
    closeSidebar();
  }

  function syncLibraryPageTitle() {
    if (body.dataset.view !== "library") return;
    if (!knowledgeState.selectedFolder && !searchInput.value.trim()) {
      setPageTitle(
        operationsViewTitle(getActiveWorkspaceView(), getActiveTasksSection()),
        getActiveWorkspaceView() === "home"
          ? "Home"
          : operationsViewPath(getActiveWorkspaceView()),
      );
      return;
    }
    setPageTitle("", "");
  }

  function clearSelection() {
    knowledgeState.selectedFolder = "";
    searchInput.value = "";
    setFolderUrl("");
    refreshDocuments();
  }

  function clearDocumentFilters() {
    for (const select of [domainFilter, typeFilter, systemFilter, tagFilter]) {
      select.value = "";
      const entry = customSelects.find((item) => item.select === select);
      if (entry) updateCustomSelect(entry.root);
    }
    updateFilterSummary();
  }

  return {
    clearDocumentFilters,
    clearSelection,
    closeQuickNav,
    closeCustomSelects,
    docPathFromLocation,
    enhanceSelect,
    filterDocuments,
    folderExists,
    folderPathFromLocation,
    fetchBacklinksForCurrentDoc,
    getAllDocuments: () => knowledgeState.allDocuments,
    getSelectedFolder: () => knowledgeState.selectedFolder,
    humanizeOptionLabel,
    handleQuickNavKeydown,
    labelForPath,
    loadDocuments,
    localDocPathFromHref,
    onFilterChange,
    openDocument,
    openDocMenu,
    openQuickNav,
    populateFilterOptions,
    refreshDocuments,
    renderDocsSurface,
    renderGithubRawFooter,
    renderLoomBlock,
    renderProcessesSurface,
    renderRelatedDocsBlock,
    renderUnifiedSearchSurface,
    renderWarningsBlock,
    resolveDocReference,
    resolveMarkdownDocLink,
    restoreFiltersExpanded,
    setFiltersExpanded,
    setFolderUrl,
    setSelectedFolder: (path) => { knowledgeState.selectedFolder = path; },
    showLibrary,
    syncLibraryPageTitle,
    toggleCurrentDocPin,
    updateFilterSummary,
    updateQuickNavMatches,
    visibleDocUrl
  };
}
