export function createKnowledgeSearch(context, services) {
  const {
    apiUrl,
    assistantJobsFromPayload,
    buildOperationsReferenceLinks,
    cardsFromWorkPayload,
    clearSelectionButton,
    cleanPath,
    documentList,
    knowledgeState,
    labelizeWorkValue,
    libraryTitle,
    navigateCanonicalWorkspace,
    openCardPanel,
    openQuickWorkflowForm,
    openTaskPanel,
    renderHonestState,
    renderOperationsReference,
    renderOperationsWorkspace,
    request,
    searchInput,
    showWorkspaceSurface,
    tasksFromWorkPayload,
    workApiUrl,
  } = context;
  const {
    filterDocuments,
    openDocument,
    renderDocuments,
    setHighlightedText,
    searchFilterParams,
    syncLibraryRouteTitle,
  } = services;
  const searchRanks = new Map();
  let searchRequestId = 0;
  let focusSearchFeedback = false;

  async function refreshDocuments() {
    const query = searchInput.value.trim();
    const requestId = ++searchRequestId;
    if (knowledgeState.searchController) {
      knowledgeState.searchController.abort();
      knowledgeState.searchController = null;
    }

    try {
      if (query) {
        const controller = new AbortController();
        knowledgeState.searchController = controller;
        renderSearchLoading(query);

        const url = docsSearchUrl(query);
        const [docsResult, workResult] = await Promise.allSettled([
          request(url, { signal: controller.signal }),
          loadUnifiedWorkSearch(query, controller.signal),
        ]);
        if (!isCurrentSearch(requestId, controller, query)) return;

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
        let unfilteredDocsResultCount = null;
        if (
          docsResult.status === "fulfilled" &&
          activeDocumentFilterCount() > 0 &&
          Array.isArray(payload?.results) &&
          payload.results.length === 0
        ) {
          const probe = await Promise.allSettled([
            request(docsSearchUrl(query, { applyFilters: false }), {
              signal: controller.signal,
            }),
          ]);
          if (!isCurrentSearch(requestId, controller, query)) return;
          if (probe[0].status === "fulfilled") {
            unfilteredDocsResultCount = Array.isArray(probe[0].value?.results)
              ? probe[0].value.results.length
              : 0;
          }
        }
        knowledgeState.searchController = null;
        const results = rankSearchResults([
          ...(Array.isArray(payload?.results) ? payload.results : []),
          ...workSearch.results,
        ], query).slice(0, 80);
        const sources = [
          ...normalizeDocsSearchSources(payload, payload?.results),
          ...(Array.isArray(payload?.sources) ? payload.sources : []),
          ...workSearch.sources,
        ];
        knowledgeState.activeSearchSources = dedupeSearchSources(sources);
        knowledgeState.visibleDocuments = results;
        knowledgeState.selectedFolder = "";
        renderUnifiedSearchResults(
          results,
          knowledgeState.activeSearchSources,
          query,
          {
            docsResultCount: Array.isArray(payload?.results)
              ? payload.results.length
              : 0,
            unfilteredDocsResultCount,
          },
        );
        syncLibraryRouteTitle();
        return;
      }

      if (requestId !== searchRequestId) return;

      if (!knowledgeState.selectedFolder) {
        // No folder or search: show the daily operations workspace and skip
        // rendering the (potentially huge) document list.
        knowledgeState.visibleDocuments = [];
        renderOperationsWorkspace(filterDocuments(knowledgeState.allDocuments));
        syncLibraryRouteTitle();
        return;
      }

      const localFiltered = filterDocuments(knowledgeState.allDocuments);

      knowledgeState.visibleDocuments = localFiltered.filter((doc) =>
        cleanPath(doc.path).startsWith(`${knowledgeState.selectedFolder}/`),
      );
      renderDocuments(knowledgeState.visibleDocuments, knowledgeState.selectedFolder);
      syncLibraryRouteTitle();
    } catch (error) {
      if (error.name === "AbortError" || requestId !== searchRequestId) return;
      knowledgeState.searchController = null;
      knowledgeState.activeSearchSources = [
        {
          source: "search",
          status: "unavailable",
          error: error.message || "Search unavailable",
        },
      ];
      knowledgeState.visibleDocuments = [];
      renderUnifiedSearchResults(
        [],
        knowledgeState.activeSearchSources,
        query,
      );
      syncLibraryRouteTitle();
    }
  }

  function isCurrentSearch(requestId, controller, query) {
    return (
      requestId === searchRequestId &&
      knowledgeState.searchController === controller &&
      searchInput.value.trim() === query
    );
  }

  function docsSearchUrl(query, { applyFilters = true } = {}) {
    const url = apiUrl("/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "80");
    if (applyFilters) searchFilterParams(url);
    url.searchParams.set("source", "docs");
    return url;
  }

  function normalizeDocsSearchSources(payload, results) {
    if (Array.isArray(payload?.sources) && payload.sources.length > 0) {
      return [];
    }
    return [
      {
        source: "docs",
        status: "ok",
        count: Array.isArray(results) ? results.length : 0,
      },
    ];
  }

  function dedupeSearchSources(sources) {
    const seen = new Set();
    return (Array.isArray(sources) ? sources : []).filter((source) => {
      const key = String(source?.source || "source");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
        path: "/api/cards",
        items: cardsFromWorkPayload,
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
          ? { kind: "workflow", cardId: id }
          : type === "template"
            ? { kind: "template", templateId: id, templateType: item.type }
            : type === "assistant-job"
              ? {
                  kind: "assistant-job",
                  assistantJobId: id,
                  taskId: item.taskId,
                  cardId: item.cardId,
                }
              : {
                  kind: "artifact",
                  artifactId: id,
                  taskId: item.taskId,
                  cardId: item.cardId,
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
        workflow_title: item.cardId || "",
      },
    };
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

  function renderSearchLoading(query) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.add("is-unified-search");
    setLibraryHeadingVisibility(true);
    libraryTitle.textContent = "Search results";
    clearSelectionButton.hidden = false;

    const wrap = document.createElement("div");
    wrap.className = "unified-search-results";
    wrap.append(
      renderSearchState(
        "Loading search results",
        `Searching Process Docs and work for “${query}”…`,
        "loading",
      ),
    );
    documentList.replaceChildren(wrap);
  }

  function renderUnifiedSearchResults(results, sources, query, metadata = {}) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.add("is-unified-search");
    setLibraryHeadingVisibility(true);
    libraryTitle.textContent = "Search results";
    clearSelectionButton.hidden = false;

    const wrap = document.createElement("div");
    wrap.className = "unified-search-results";
    const safeResults = Array.isArray(results) ? results : [];
    const state = searchStateFor(safeResults, sources, query, metadata);
    const sourceState = renderSearchSourceState(sources);
    if (sourceState) wrap.append(sourceState);

    if (state === "unavailable") {
      documentList.replaceChildren(wrap);
      focusSearchStateIfRequested(wrap);
      return;
    }
    if (state === "partial-empty") {
      wrap.append(
        renderSearchState(
          "No matches from available sources",
          "The sources that answered found no matches. Unavailable sources may still contain results.",
          "partial",
        ),
      );
    } else if (state === "filter-empty") {
      wrap.append(
        renderSearchState(
          "No Process Docs match these filters",
          "The search query ran, but the active metadata filters excluded every Process Doc match.",
          "filter-empty",
        ),
      );
    } else if (safeResults.length === 0) {
      wrap.append(
        renderSearchState(
          "No matching results",
          "No work or process context matches this search.",
          "query-empty",
        ),
      );
    } else if (state === "loaded") {
      wrap.append(
        renderSearchState(
          "Search complete",
          `${safeResults.length} matching result${safeResults.length === 1 ? "" : "s"} from all available sources.`,
          "loaded",
        ),
      );
    }

    if (safeResults.length === 0) {
      documentList.replaceChildren(wrap);
      focusSearchStateIfRequested(wrap);
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
    focusSearchStateIfRequested(wrap);
  }

  function setLibraryHeadingVisibility(visible) {
    const heading = libraryTitle.parentElement?.parentElement;
    if (!heading) return;
    heading.hidden = !visible;
    heading.classList.toggle("is-visible", visible);
  }

  function searchStateFor(results, sources, query, metadata = {}) {
    const unavailable = unavailableSearchSources(sources);
    if (unavailable.length > 0 && unavailable.length === (sources || []).length) {
      return "unavailable";
    }
    if (unavailable.length > 0) {
      return results.length === 0 ? "partial-empty" : "partial";
    }
    const docsSource = (sources || []).find(
      (source) => source?.source === "docs",
    );
    const docsResultCount = Number.isFinite(metadata.docsResultCount)
      ? metadata.docsResultCount
      : Number(docsSource?.count || 0);
    const unfilteredDocsResultCount = Number.isFinite(
      metadata.unfilteredDocsResultCount,
    )
      ? metadata.unfilteredDocsResultCount
      : null;
    if (
      query &&
      activeDocumentFilterCount() > 0 &&
      docsSource?.status === "ok" &&
      docsResultCount === 0 &&
      unfilteredDocsResultCount > 0
    ) {
      return "filter-empty";
    }
    return results.length === 0 ? "query-empty" : "loaded";
  }

  function unavailableSearchSources(sources) {
    return (Array.isArray(sources) ? sources : []).filter(
      (source) => source && isUnavailableSearchSource(source),
    );
  }

  function isUnavailableSearchSource(source) {
    return (
      source.status === "unavailable" ||
      source.status === "error" ||
      source.available === false
    );
  }

  function activeDocumentFilterCount() {
    return Object.values(knowledgeState.documentFilters || {}).filter(Boolean)
      .length;
  }

  function renderSearchState(titleText, bodyText, state) {
    const node = renderHonestState(titleText, bodyText);
    node.classList.add("ops-runtime-state", "search-feedback");
    node.dataset.searchState = state;
    node.setAttribute("role", state === "unavailable" ? "alert" : "status");
    node.setAttribute(
      "aria-live",
      state === "unavailable" ? "assertive" : "polite",
    );
    node.setAttribute("aria-atomic", "true");
    return node;
  }

  function focusSearchStateIfRequested(wrap) {
    if (!focusSearchFeedback) return;
    focusSearchFeedback = false;
    const node = wrap.querySelector(
      ".search-feedback, .search-source-state",
    );
    if (!node || typeof node.focus !== "function") return;
    node.tabIndex = -1;
    node.focus();
  }

  function renderSearchSourceState(sources) {
    const unavailable = unavailableSearchSources(sources);
    if (unavailable.length === 0) return null;
    const section = document.createElement("section");
    section.className = "ops-runtime-state search-source-state";
    section.dataset.searchState =
      unavailable.length === (sources || []).length
        ? "unavailable"
        : "partial";
    section.setAttribute(
      "aria-label",
      section.dataset.searchState === "unavailable"
        ? "Search unavailable"
        : "Partial search results",
    );
    section.setAttribute("role", "alert");
    section.setAttribute("aria-live", "assertive");
    section.setAttribute("aria-atomic", "true");
    const title = document.createElement("strong");
    title.textContent =
      section.dataset.searchState === "unavailable"
        ? "Search unavailable"
        : "Partial search results";
    const body = document.createElement("span");
    // Attribute the failure to what actually failed. Calling a docs outage a
    // work-source problem sent operators looking in the wrong system.
    const docsFailed = unavailable.some((source) => source.source === "docs");
    const workFailed = unavailable.some((source) => source.source !== "docs");
    if (section.dataset.searchState === "unavailable") {
      body.textContent =
        "No Process Docs or work search source responded. Retry to run the same query with its current filters.";
    } else if (docsFailed && workFailed) {
      body.textContent =
        "Process documents and some work sources could not load. Results from the sources that answered remain visible.";
    } else if (docsFailed) {
      body.textContent =
        "Process documents could not load. Work results remain visible, and no document results are shown for this query.";
    } else {
      body.textContent =
        "Some work sources could not load. Document results and any loaded work sources remain visible.";
    }
    section.append(title, body);
    const list = document.createElement("ul");
    for (const source of unavailable) {
      const item = document.createElement("li");
      item.textContent = `${searchSourceLabel(source.source)}: ${source.error || "unavailable"}`;
      list.append(item);
    }
    section.append(list);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "surface-summary-retry";
    retry.textContent = "Retry search";
    retry.setAttribute("aria-label", "Retry search with the current query");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.setAttribute("aria-busy", "true");
      retry.textContent = "Retrying…";
      focusSearchFeedback = true;
      try {
        await refreshDocuments();
      } finally {
        if (retry.isConnected) {
          retry.disabled = false;
          retry.removeAttribute("aria-busy");
          retry.textContent = "Retry search";
        }
      }
    });
    section.append(retry);
    return section;
  }

  function searchSourceLabel(source) {
    if (source === "docs") return "process documents";
    return source || "source";
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
        const aRank = Math.max(
          ...a[1].map((result) => searchRanks.get(result) || 0),
          0,
        );
        const bRank = Math.max(
          ...b[1].map((result) => searchRanks.get(result) || 0),
          0,
        );
        if (aRank !== bRank) return bRank - aRank;
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      })
      .map(([type, items]) => ({
        type,
        label: labels[type] || labelizeWorkValue(type),
        items: items.slice().sort(
          (a, b) =>
            (searchRanks.get(b) || 0) - (searchRanks.get(a) || 0),
        ),
      }));
  }

  function normalizeSearchValue(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function searchResultRank(result, query) {
    const wanted = normalizeSearchValue(query);
    if (!wanted || !result) return 0;
    const title = normalizeSearchValue(
      result.title || result.name || result.id || "",
    );
    const path = normalizeSearchValue(result.path || "");
    const basename = normalizeSearchValue(
      String(result.path || "").split("/").at(-1) || "",
    );
    const context = normalizeSearchValue(
      result.context || result.description || result.summary || "",
    );
    const tokens = wanted.split(" ").filter(Boolean);
    let score = 0;

    if (title === wanted) score += 10000;
    else if (title.startsWith(wanted)) score += 5000;
    else if (title.includes(wanted)) score += 3500;
    if (basename === wanted) score += 3000;
    else if (path.includes(wanted)) score += 900;
    if (tokens.length && tokens.every((token) => title.includes(token))) {
      score += 1800;
    }
    if (context.includes(wanted)) score += 500;
    if (tokens.length) {
      score += tokens.reduce(
        (total, token) => total + (title.includes(token) ? 120 : 0),
        0,
      );
    }
    return score;
  }

  function rankSearchResults(results, query) {
    return results
      .map((result, index) => ({
        result,
        index,
        score: searchResultRank(result, query),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(a.result?.title || a.result?.path || a.result?.id || "").localeCompare(
            String(b.result?.title || b.result?.path || b.result?.id || ""),
          ) ||
          a.index - b.index,
      )
      .map(({ result, score }) => {
        searchRanks.set(result, score);
        return result;
      });
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
      chip.className = "unified-search-meta-item";
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
    if ((kind === "workflow" || kind === "card") && route.cardId) {
      openCardPanel(route.cardId);
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
    if ((kind === "artifact" || kind === "file") && route.cardId) {
      openCardPanel(route.cardId);
      return;
    }
    if (kind === "artifact" || kind === "file") showWorkspaceSurface("artifacts");
  }


  return {
    refreshDocuments,
    renderUnifiedSearchSurface,
  };
}
