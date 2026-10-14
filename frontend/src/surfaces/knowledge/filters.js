export function createKnowledgeFilters(context, services) {
  const {
    domainFilter,
    escapeRegex,
    filterCount,
    getActiveWorkspaceRoute,
    knowledgeState,
    navigateCanonicalWorkspace,
    systemFilter,
    tagFilter,
    typeFilter,
  } = context;

  const DOCUMENT_FILTERS = [
    ["domain", domainFilter],
    ["type", typeFilter],
    ["system", systemFilter],
    ["tag", tagFilter],
  ];

  function filterDocuments(documents) {
    return documents.filter((doc) => {
      const filters = knowledgeState.documentFilters;
      if (filters.domain && doc.domain !== filters.domain) return false;
      if (filters.type && doc.doc_type !== filters.type) return false;
      if (
        filters.system &&
        !(Array.isArray(doc.systems) && doc.systems.includes(filters.system))
      )
        return false;
      if (
        filters.tag &&
        !(Array.isArray(doc.tags) && doc.tags.includes(filters.tag))
      )
        return false;
      return true;
    });
  }

  function onFilterChange() {
    for (const [name, select] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = select.value;
    }
    updateFilterSummary();
    const activePath = getActiveWorkspaceRoute()?.path;
    const historyMode = activePath === "/processes" ? "replace" : "push";
    navigateCanonicalWorkspace(
      "/processes",
      documentFilterParams(),
      { history: historyMode, preserveDocumentComposer: true },
    );
  }

  function activeFilterCount() {
    return Object.values(knowledgeState.documentFilters).filter(Boolean)
      .length;
  }

  function documentFilterParams() {
    const params = new URLSearchParams();
    for (const [name] of DOCUMENT_FILTERS) {
      const value = knowledgeState.documentFilters[name];
      if (value) params.set(name, value);
    }
    return params;
  }

  function updateFilterControls() {
    for (const [name, select] of DOCUMENT_FILTERS) {
      select.value = knowledgeState.documentFilters[name];
    }
  }

  function restoreDocumentFilters(params = new URLSearchParams()) {
    for (const [name] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = params.get(name) || "";
    }
    updateFilterControls();
    updateFilterSummary();
  }

  function clearDocumentFilters() {
    for (const [name] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = "";
    }
    updateFilterControls();
    updateFilterSummary();
    navigateCanonicalWorkspace("/processes", documentFilterParams(), {
      history: getActiveWorkspaceRoute()?.path === "/processes"
        ? "replace"
        : "push",
      preserveDocumentComposer: true,
    });
  }

  function searchFilterParams(url) {
    const filters = knowledgeState.documentFilters;
    if (filters.domain) url.searchParams.set("domain", filters.domain);
    if (filters.type) url.searchParams.set("doc_type", filters.type);
    if (filters.system) url.searchParams.set("system", filters.system);
    if (filters.tag) url.searchParams.set("tag", filters.tag);
    return url;
  }

  function updateFilterSummary() {
    const count = activeFilterCount();
    filterCount.hidden = count === 0;
    filterCount.textContent = count ? String(count) : "";
    filterCount.setAttribute("aria-label", `${count} active filters`);
  }

  function setSelectOptions(select, values, allLabel = "All") {
    const previous = knowledgeState.documentFilters[
      DOCUMENT_FILTERS.find(([, element]) => element === select)?.[0]
    ] || "";
    const items = [
      new Option(allLabel, ""),
      ...values.map((v) => new Option(humanizeOptionLabel(v), v)),
    ];
    select.replaceChildren(...items);
    select.value = values.includes(previous) ? previous : "";
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

  return {
    clearDocumentFilters,
    filterDocuments,
    humanizeOptionLabel,
    onFilterChange,
    populateFilterOptions,
    restoreDocumentFilters,
    searchFilterParams,
    setHighlightedText,
    updateFilterSummary,
  };
}
